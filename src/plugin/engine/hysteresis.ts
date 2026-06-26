/**
 * Heat Shield — hysteresis gate (Task 7.6, Regelwerk §15).
 *
 * `engine/hysteresis.ts` is the **last gate before the orchestrator
 * dispatches `setShutterLevel`**. The per-window decision pipeline runs:
 *
 *   risk → specialRules → ventilation → safety → **hysteresis**
 *
 * and this module decides whether the move that the upstream stages
 * computed should actually be sent on the wire. It exists to keep the
 * shutter from chattering in response to ordinary sensor noise:
 *
 *   - §15.1 **min seconds between moves** — once we have moved a
 *     shutter, the next move is suppressed until at least
 *     `minSecondsBetweenMoves` wall-clock seconds have elapsed. The
 *     default in `AutomationRulesSchema` is 900 (15 min, see
 *     Requirement 8.1).
 *   - §15.2 **min position delta** — small targets (< `minPositionDeltaPct`
 *     percentage points away from the current physical level) are dropped
 *     entirely. The default is 15 pp (see Requirement 8.2). The
 *     comparison is **inclusive at the boundary**: `deltaPct >=
 *     minPositionDeltaPct` always moves, even when both are exactly 15.
 *   - §15.5 **PV / cloud smoothing** — if PV power dropped below the
 *     `roof_force_close_kw` threshold within the last 10–15 min, we
 *     intentionally hold the closed position for one or two cycles so
 *     a passing cloud does not whip the shutter back open and shut.
 *     This rule only fires for **opening** moves (target lower than
 *     current); closing moves (target higher than current) are never
 *     suppressed by cloud logic — when we want to close more, we
 *     close more, regardless of PV history.
 *
 * The orchestrator is the authority that computes `pvDroppedRecently`
 * — it sees the smoothed PV history and tracks whether the value
 * crossed `roof_force_close_kw` from above to below within the last
 * 15 minutes. This module only consumes the boolean.
 *
 * **Safety pass-through.** When `applySafety` produced
 * `suppressMove = true`, the orchestrator copies that into
 * `suppressFromSafety` here. This module then returns
 * `{ shouldMove: false, blockedBy: 'safety_suppress', ... }` so the
 * dashboard can show a single deterministic reason ("safety") rather
 * than the upstream branch string. The safety priority order in
 * `engine/safety.ts` is preserved — hysteresis never overrides safety.
 *
 * **First move.** When the engine has never moved this window
 * (`currentLevel01 === null`), there is no baseline to compare
 * against. We always allow the first move so the orchestrator's first
 * cycle can establish a known position. `lastMovedAt` should also be
 * `null` in that scenario, but defensively `currentLevel01 === null`
 * is checked first.
 *
 * Module rules (mirrored from `engine/safety.ts`,
 * `engine/ventilation.ts`):
 *   - Pure: no fs, no logging, no Connect-API artefacts, no globals.
 *   - Strict TS, ESM, `.js` import suffixes.
 *   - Inputs are accepted as a typed object; the function never
 *     mutates them. Returned objects are fresh.
 */

import type { AutomationRules } from '../../shared/types.js';

// ---------------------------------------------------------------------------
// Public types.
// ---------------------------------------------------------------------------

/**
 * Inputs for one hysteresis evaluation, for a single window. The
 * orchestrator builds this object once per cycle from the upstream
 * pipeline output, the per-window runtime state, and the smoothed PV
 * history.
 */
export interface HysteresisInputs {
  /** Final target after risk + special + ventilation + safety. In `[0, 1]`. */
  finalTarget01: number;
  /** Current shutter position in `[0, 1]`, or `null` if the engine has never moved this window. */
  currentLevel01: number | null;
  /** Wall-clock timestamp of the last engine-issued move. `null` if never moved. */
  lastMovedAt: Date | null;
  /** Wall-clock for the `minSecondsBetweenMoves` comparison. */
  now: Date;
  /** Automation thresholds; both fields come from `AutomationRulesSchema`. */
  rules: Pick<AutomationRules, 'minSecondsBetweenMoves' | 'minPositionDeltaPct'> & {
    /**
     * Optional directional factor (V1.8): closing moves scale their delta +
     * debounce thresholds by this value so protection reacts faster than
     * re-opening. Absent ⇒ 1.0 (symmetric — preserves legacy behaviour).
     */
    closeEagerness?: number;
  };
  /** `true` iff `applySafety` returned `suppressMove = true`. Pass-through gate. */
  suppressFromSafety: boolean;
  /**
   * `true` iff PV power crossed the `roof_force_close_kw` threshold from
   * above to below within the last 15 minutes. Computed by the
   * orchestrator from the smoothed PV history. Only relevant for
   * opening moves; closing moves are never blocked on this flag.
   */
  pvDroppedRecently: boolean;
}

/**
 * Reason a move was suppressed. The dashboard surfaces this verbatim
 * in the per-window decision card and the diagnostics export.
 *
 *   - `safety_suppress`     — upstream `applySafety` already said hold.
 *   - `no_change`           — `|target − current| < minPositionDeltaPct`.
 *   - `min_seconds`         — last move was too recent.
 *   - `pv_cloud`            — opening move suppressed by §15.5 smoothing.
 */
export type HysteresisBlockedBy = 'min_seconds' | 'min_position_delta' | 'pv_cloud' | 'safety_suppress' | 'no_change';

/**
 * Result of one hysteresis evaluation.
 *
 *   - `shouldMove` is the orchestrator's go/no-go for `setShutterLevel`.
 *   - `blockedBy` is present iff `shouldMove === false`. When
 *     `shouldMove === true`, the field is omitted entirely (this lines
 *     up with `exactOptionalPropertyTypes` in `tsconfig.json`).
 *   - `target01` is the effective target. When holding, it is the
 *     position the dashboard should show as the engine's intent —
 *     usually the upstream `finalTarget01`, but for `pv_cloud` it is
 *     `currentLevel01` so the dashboard reflects "we are deliberately
 *     keeping the shutter where it is".
 */
export interface HysteresisResult {
  /** Whether the orchestrator should dispatch the `setShutterLevel` call. */
  shouldMove: boolean;
  /** Reason the move was suppressed, when `shouldMove === false`. */
  blockedBy?: HysteresisBlockedBy;
  /** Effective target in `[0, 1]`. */
  target01: number;
}

// ---------------------------------------------------------------------------
// Top-level: applyHysteresis.
// ---------------------------------------------------------------------------

/**
 * Decide whether the engine should dispatch a shutter move for one
 * window in the current cycle.
 *
 * Branch precedence (top-to-bottom, first match wins):
 *
 *   1. **`suppressFromSafety`** — pass through with
 *      `blockedBy: 'safety_suppress'`. The reported `target01` is
 *      `finalTarget01` so the dashboard still shows what the engine
 *      *would* have driven to absent the safety hold.
 *   2. **First move** (`currentLevel01 === null`) — allow the move
 *      unconditionally. There is no baseline to compare against, and
 *      we want the first cycle to establish a known position.
 *   3. **§15.2 min position delta** — drop moves smaller than
 *      `minPositionDeltaPct` percentage points. The comparison is
 *      `deltaPct < threshold`, so the boundary is **inclusive**:
 *      a delta of exactly 15 pp moves when the threshold is 15.
 *   4. **§15.1 min seconds between moves** — suppress when
 *      `(now − lastMovedAt) < minSecondsBetweenMoves * 1000`. The
 *      `lastMovedAt === null` branch falls through (no last-move means
 *      no debounce window).
 *   5. **§15.5 PV / cloud smoothing** — opening moves
 *      (`finalTarget01 < currentLevel01`) are suppressed when
 *      `pvDroppedRecently` is `true`. The reported `target01` is
 *      `currentLevel01` (the held position). Closing moves
 *      (`finalTarget01 > currentLevel01`) are never blocked here.
 *   6. **Fallthrough** — dispatch the move, returning `finalTarget01`.
 *
 * Pure: same inputs → same outputs, no side effects.
 */
export function applyHysteresis(inputs: HysteresisInputs): HysteresisResult {
  // 1. Safety pass-through. Highest precedence.
  if (inputs.suppressFromSafety) {
    return {
      shouldMove: false,
      blockedBy: 'safety_suppress',
      target01: inputs.finalTarget01,
    };
  }

  // 2. First move — no baseline, always allow.
  if (inputs.currentLevel01 === null) {
    return {
      shouldMove: true,
      target01: inputs.finalTarget01,
    };
  }

  // 3. §15.2 min position delta. Inclusive at the boundary:
  //    deltaPct === minPositionDeltaPct ⇒ moves. V1.8: closing moves (target
  //    more closed than current) scale the threshold by `closeEagerness` so
  //    the plugin protects sooner and re-opens more reluctantly.
  const closing = inputs.finalTarget01 > inputs.currentLevel01;
  const eagerness =
    closing && inputs.rules.closeEagerness !== undefined ? inputs.rules.closeEagerness : 1;
  const deltaPct = Math.abs(inputs.finalTarget01 - inputs.currentLevel01) * 100;
  const effDeltaThreshold = inputs.rules.minPositionDeltaPct * eagerness;
  if (deltaPct < effDeltaThreshold) {
    return {
      shouldMove: false,
      blockedBy: 'no_change',
      target01: inputs.finalTarget01,
    };
  }

  // 4. §15.1 min seconds between moves. lastMovedAt === null falls
  //    through — we can only debounce against an actual prior move.
  if (inputs.lastMovedAt !== null) {
    const elapsedMs = inputs.now.getTime() - inputs.lastMovedAt.getTime();
    const debounceMs = inputs.rules.minSecondsBetweenMoves * 1000 * eagerness;
    if (elapsedMs < debounceMs) {
      return {
        shouldMove: false,
        blockedBy: 'min_seconds',
        target01: inputs.finalTarget01,
      };
    }
  }

  // 5. §15.5 PV / cloud smoothing. Only opening moves (target lower
  //    than current — less closed) are eligible. Closing moves always
  //    proceed: when the engine wants to close more, transient cloud
  //    history must not block that.
  if (inputs.pvDroppedRecently && inputs.finalTarget01 < inputs.currentLevel01) {
    return {
      shouldMove: false,
      blockedBy: 'pv_cloud',
      target01: inputs.currentLevel01,
    };
  }

  // 6. Fallthrough — dispatch the move.
  return {
    shouldMove: true,
    target01: inputs.finalTarget01,
  };
}
