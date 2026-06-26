/**
 * Heat Shield — safety gate (Task 7.5).
 *
 * `engine/safety.ts` is the **last gate before hysteresis** in the
 * per-window decision pipeline. The orchestrator runs:
 *
 *   risk → specialRules → ventilation → **safety** → hysteresis
 *
 * and this module enforces the design.md §Property 6 priority order
 * for hard overrides:
 *
 *   1. STORM
 *   2. MAINTENANCE / pause-Switch
 *   3. Lockout for open doors            ← handled in ventilation.ts §14.5
 *   4. Manual override per window
 *   5. Window-open-Logik                  ← `blockedByOpenWindow` surface from ventilation §14.6
 *   6. Heat protection / Risk-Model       ← already applied (baseTarget01)
 *   7. Night cooling                      ← mode FSM
 *   8. Comfort defaults
 *
 * The five checks this module performs map to priorities 1, 2, 5, and
 * 4 (in that source-code order). Items 3, 6, 7, 8 are encoded by
 * earlier pipeline stages and are reflected in `baseTarget01`.
 *
 * Each non-pass branch produces a deterministic `appliedRules` entry
 * the dashboard surfaces in the live decision breakdown. Strings are
 * stable for log-grepping.
 *
 * **STORM semantics**: STORM forces shutters fully open
 * (`shutterLevel = 0`). We deliberately **do not** suppress the move —
 * the orchestrator must drive the window to safety even from a held
 * position. STORM short-circuits every later branch, including manual
 * override (storm safety beats user intent — steering hard rule).
 *
 * **Hold semantics**: MAINTENANCE, pauseControl, blockedByOpenWindow,
 * and active manualOverrideUntil all freeze the shutter at its
 * current physical level. When `currentLevel01` is `null` (engine has
 * never moved this window), there is no baseline to hold — we fall
 * back to `baseTarget01` so the orchestrator's first command still
 * has a meaningful value, but `suppressMove` stays `true` because the
 * intent is "do not move now". The orchestrator's first-cycle path
 * inspects `lastCommandedLevel01` and issues the move regardless of
 * suppression, since suppression cannot fire without a baseline.
 *
 * Module rules (mirrored from `engine/ventilation.ts`,
 * `engine/specialRules.ts`):
 *   - Pure: no fs, no logging, no Connect-API artefacts, no globals.
 *   - Strict TS, ESM, `.js` import suffixes.
 *   - Inputs are accepted as a typed object; the function never
 *     mutates them. The returned `appliedRules` is a fresh array.
 *   - `target01` is always in `[0, 1]` — the responsibility for
 *     keeping `currentLevel01` and `baseTarget01` inside that range
 *     lives with the orchestrator (HCU range is `[0..1.01]` but only
 *     `[0..1]` are physical positions).
 */

import type { Mode, Window, WindowRuntimeState } from '../../shared/types.js';

// ---------------------------------------------------------------------------
// Public types.
// ---------------------------------------------------------------------------

/**
 * Inputs for one safety evaluation, for a single window. The
 * orchestrator builds this object once per cycle from the snapshot
 * bus, the per-window runtime state, and the ventilation result.
 */
export interface SafetyInputs {
  /** Window properties needed for diagnostics; safety itself only consults `lockoutProtection` indirectly via earlier stages. */
  window: Pick<Window, 'type' | 'isDoor' | 'lockoutProtection'>;
  /** Window's runtime state with `manualOverrideUntil`. `null` for windows that have not been seen yet. */
  windowState: Pick<WindowRuntimeState, 'manualOverrideUntil'> | null;
  /** Current FSM mode (output of `engine/modes.ts::determineMode`). */
  mode: Mode;
  /** Pause-switch state (`heatshield-control-pause`). */
  pauseControl: boolean;
  /** Pre-computed target after risk + special rules + ventilation, in `[0, 1]`. */
  baseTarget01: number;
  /**
   * Current shutter position in `[0, 1]`, or `null` if the engine has
   * never moved this window. Used as the "hold position" anchor for
   * MAINTENANCE / pause / blockedByOpenWindow / manual-override
   * branches.
   */
  currentLevel01: number | null;
  /**
   * `true` iff ventilation reported `canMoveWhenOpen=false` and the
   * window is currently open or tilted (§14.6). The shutter must not
   * move while the sash is out of the frame.
   */
  blockedByOpenWindow: boolean;
  /** Wall-clock for `manualOverrideUntil` comparison. */
  now: Date;
}

/**
 * Result of one safety evaluation.
 *
 *   - `target01` is the final shutter target after all safety rules,
 *     in `[0, 1]`. STORM forces `0.0` (fully open); hold branches
 *     return `currentLevel01` (or `baseTarget01` as fallback when
 *     there is no baseline).
 *   - `suppressMove` is `true` when the orchestrator must not call
 *     `setShutterLevel` for this window. STORM keeps it `false`
 *     because STORM is an *active* move to safety, not a hold.
 *   - `appliedRules` is the deterministic list of safety-layer rule
 *     references that fired. Empty when no safety branch applies.
 */
export interface SafetyResult {
  /** Final target after applying all safety rules, in `[0, 1]`. */
  target01: number;
  /** Whether the orchestrator should suppress the move entirely. */
  suppressMove: boolean;
  /** Which safety-layer rules fired. */
  appliedRules: string[];
}

// ---------------------------------------------------------------------------
// Top-level: applySafety.
// ---------------------------------------------------------------------------

/**
 * Apply the design.md §Property 6 priority order to one window.
 *
 * Branch precedence (top-to-bottom, first match wins):
 *
 *   1. **STORM** — forces target to `0.0`, `suppressMove = false`.
 *      Returns immediately. STORM beats every later branch including
 *      manual override.
 *   2. **MAINTENANCE** — hold position, `suppressMove = true`.
 *   3. **pauseControl** — hold position, `suppressMove = true`.
 *   4. **blockedByOpenWindow** (§14.6) — hold position,
 *      `suppressMove = true`.
 *   5. **active manualOverrideUntil** — hold position,
 *      `suppressMove = true`. The rule string carries the ISO
 *      timestamp so the diagnostics tab shows when automation will
 *      resume.
 *   6. **fallthrough** — pass `baseTarget01` through unchanged with
 *      empty rules.
 *
 * Pure: same inputs → same outputs, no side effects.
 */
export function applySafety(inputs: SafetyInputs): SafetyResult {
  // 1. STORM — highest priority. Overrides everything else.
  if (inputs.mode === 'STORM') {
    return {
      target01: 0.0,
      suppressMove: false,
      appliedRules: ['storm: force open'],
    };
  }

  // The "hold" anchor for branches 2–5. When the engine has not yet
  // moved this window, fall back to baseTarget so the orchestrator's
  // first command has a sane value; suppressMove still stays `true`
  // because the intent here is "do not move".
  const holdTarget = inputs.currentLevel01 ?? inputs.baseTarget01;

  // 2. MAINTENANCE — dashboard override, hold position.
  if (inputs.mode === 'MAINTENANCE') {
    return {
      target01: holdTarget,
      suppressMove: true,
      appliedRules: ['maintenance: hold position'],
    };
  }

  // 3. pauseControl (`heatshield-control-pause` switch on).
  if (inputs.pauseControl) {
    return {
      target01: holdTarget,
      suppressMove: true,
      appliedRules: ['pause: hold position'],
    };
  }

  // 4. §14.6 — window cannot move while open.
  if (inputs.blockedByOpenWindow) {
    return {
      target01: holdTarget,
      suppressMove: true,
      appliedRules: ['§14.6 cannot-move-when-open: hold position'],
    };
  }

  // 5. Manual override — user has touched this window's shutter
  //    recently. `manualOverrideUntil` is stored as an ISO-8601 UTC
  //    string; we parse, compare, and re-emit the canonical form so
  //    the dashboard renders a stable timestamp.
  if (inputs.windowState !== null && inputs.windowState.manualOverrideUntil !== null) {
    const until = new Date(inputs.windowState.manualOverrideUntil);
    if (until.getTime() > inputs.now.getTime()) {
      return {
        target01: holdTarget,
        suppressMove: true,
        appliedRules: [`manual override active until ${until.toISOString()}`],
      };
    }
  }

  // 6. Fallthrough — no safety branch applies. Pass baseTarget through.
  return {
    target01: inputs.baseTarget01,
    suppressMove: false,
    appliedRules: [],
  };
}
