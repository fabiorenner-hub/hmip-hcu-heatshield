/**
 * Heat Shield — ventilation logic (Task 7.4, Regelwerk §14).
 *
 * The risk model in `engine/risk.ts` and the special rules in
 * `engine/specialRules.ts` produce a shutter target assuming the
 * window is closed. Once a window or door is opened (or tilted),
 * Regelwerk §14 takes over: the engine balances airflow against heat
 * protection, with a deterministic safety lockout for doors and for
 * windows that physically cannot move while their sash is open.
 *
 * Three temperature-driven branches plus two safety branches:
 *
 *   - **§14.2 Außen kühler** (`delta >= 1.5 °C`): the user opened the
 *     window for active cooling. We **lower** the target to allow
 *     airflow even if heat protection wanted the shutter mostly
 *     closed. Targets:
 *       - no sun on window: 0.20 (top of the regelwerk's 0–20 % band)
 *       - sun on window, low PV (< 3 kW): 0.50 (top of 30–50 %)
 *       - sun on window, high PV (≥ 3 kW): 0.60 (top of 40–60 %)
 *     Folded into the running target as `target = min(target, vent)`
 *     so the user's airflow intent wins over the heat-protection floor.
 *
 *   - **§14.3 Ähnlich warm** (`delta ∈ [-0.5, 1.5) °C`): mid-range. We
 *     **raise** the target to keep heat out without sealing the
 *     opening. Targets:
 *       - no sun: 0.40 (top of 20–40 %)
 *       - sun: 0.70 (top of 50–70 %)
 *       - sun + room ≥ 24.5 °C: 0.90
 *     Folded as `target = max(target, vent)`.
 *
 *   - **§14.4 Außen wärmer** (`delta <= -0.5 °C`): close hard, leave
 *     just enough gap for the open sash. Targets:
 *       - no sun: 0.60
 *       - sun: 0.90
 *       - sun + roof window: 0.95
 *     Folded as `target = max(target, vent)`.
 *
 *   - **§14.5 Türen-Lockout**: while a door is open, the target is
 *     hard-capped at `maxPositionWhenOpenPct / 100`. The same cap
 *     applies to non-door windows when `lockoutProtection = true`.
 *     This is a **safety rule** — it never widens the target; it only
 *     prevents the shutter from descending past the configured limit
 *     while the sash is out of the frame.
 *
 *   - **§14.6 `canMoveWhenOpen = false`**: some hardware physically
 *     cannot move while the sash is open. We do not change the target
 *     here; instead we surface `blockedByOpenWindow = true` so the
 *     orchestrator's safety layer (Task 7.5) can keep the current
 *     shutter position.
 *
 * Steering hard rule (heat-shield-context.md):
 *   - Door lockout (§14.5) is **never** violated, not even by HEATWAVE
 *     special rules. The orchestrator pipeline runs special-rules →
 *     ventilation, so this module sees the special-rule output as
 *     `baseTarget01` and applies its own constraints on top.
 *
 * Module rules (mirrored from `engine/risk.ts`, `engine/specialRules.ts`):
 *   - Pure: no fs, no logging, no Connect-API artefacts, no globals.
 *   - Strict TS, ESM, `.js` import suffixes.
 *   - Inputs are accepted as a typed object; the function never
 *     mutates them. The returned `appliedRules` is a fresh array.
 *   - `target01` is always in `[0, 1]` — defensive clamp at the end.
 */

import type { ContactState, Window } from '../../shared/types.js';

// ---------------------------------------------------------------------------
// Public constants — referenced by tests and the dashboard breakdown.
// ---------------------------------------------------------------------------

/**
 * PV threshold (kW) that separates the §14.2 "low PV" and "high PV"
 * sub-bands. At or above this value the cooling target is allowed to
 * climb to 0.60 (top of the 40–60 % regelwerk band) so the room still
 * gets a meaningful shading floor while air exchange continues.
 */
export const HIGH_PV_KW = 3.0;

/**
 * Lower bound (inclusive) of the §14.2 "outside cooler" branch in °C.
 * Picked from the regelwerk to avoid flapping when indoor and outdoor
 * temperatures sit on top of each other.
 */
export const COOL_DELTA_C = 1.5;

/**
 * Upper bound (exclusive) of the §14.4 "outside warmer" branch in °C.
 * `delta <= WARM_DELTA_C` enters §14.4; `delta > WARM_DELTA_C` keeps
 * the cycle in §14.3.
 */
export const WARM_DELTA_C = -0.5;

/**
 * Threshold for the §14.3 "high room temperature" sub-rule (°C). At or
 * above this room temperature with sun on the window, the §14.3
 * target jumps to 0.90 instead of the default 0.70.
 */
export const HIGH_ROOM_TEMP_C = 24.5;

// ---------------------------------------------------------------------------
// Public types.
// ---------------------------------------------------------------------------

/**
 * Inputs for one ventilation evaluation, for a single window. The
 * orchestrator builds this object once per cycle from the snapshot
 * bus + per-window state; {@link applyVentilation} is otherwise pure.
 */
export interface VentilationInputs {
  /** Window properties needed for §14.4 / §14.5 / §14.6. */
  window: Pick<
    Window,
    'isDoor' | 'canMoveWhenOpen' | 'maxPositionWhenOpenPct' | 'lockoutProtection' | 'type'
  >;
  /** Debounced contact state — `closed` / `tilted` / `open` / `unknown`. */
  contactState: ContactState;
  /** Room temperature in °C; `null` ⇒ no temp branch fires unless outdoor is also missing — see notes. */
  roomTempC: number | null;
  /** Outdoor temperature in °C; `null` ⇒ no delta-based branch fires. */
  outdoorTempC: number | null;
  /** Sun is currently on the window. */
  sunOnWindowNow: boolean;
  /** Smoothed PV power in kW; `null` is treated as low PV (< {@link HIGH_PV_KW}). */
  pvSmoothedKw: number | null;
  /** Pre-computed target after risk + special rules, in `[0, 1]`. */
  baseTarget01: number;
}

/**
 * Result of one ventilation evaluation.
 *
 *   - `target01` is the (possibly modified) shutter target in `[0, 1]`.
 *   - `appliedRules` is the deterministic list of regelwerk
 *     references that fired during this evaluation, in the order they
 *     fired. The dashboard surfaces them in the live decision
 *     breakdown.
 *   - `blockedByOpenWindow` is `true` iff `canMoveWhenOpen === false`
 *     and the window is currently open or tilted. The orchestrator's
 *     safety layer must keep the shutter at its current position when
 *     this flag is set.
 */
export interface VentilationResult {
  /** Final target after applying §14, in `[0, 1]`. */
  target01: number;
  /** Which §14 rules fired. */
  appliedRules: string[];
  /**
   * True if the window cannot be moved while open and the contact is
   * not closed. The orchestrator must keep the current position when
   * this flag is set.
   */
  blockedByOpenWindow: boolean;
}

// ---------------------------------------------------------------------------
// Branch helpers.
// ---------------------------------------------------------------------------

/**
 * §14.2 cooling-branch target. Picks the upper bound of the regelwerk
 * band that matches the current sun + PV combination. `pvSmoothedKw =
 * null` is treated as low PV (the conservative choice when the PV
 * feed is offline).
 */
function coolingTarget(sunOnWindowNow: boolean, pvSmoothedKw: number | null): number {
  if (!sunOnWindowNow) {
    return 0.2;
  }
  const highPv = pvSmoothedKw !== null && pvSmoothedKw >= HIGH_PV_KW;
  return highPv ? 0.6 : 0.5;
}

/**
 * §14.3 similar-temperatures-branch target. The high-room-temperature
 * sub-rule only fires when the indoor temperature is available *and*
 * the sun is currently on the window — both gates from the regelwerk.
 */
function similarTarget(sunOnWindowNow: boolean, roomTempC: number | null): number {
  if (!sunOnWindowNow) {
    return 0.4;
  }
  if (roomTempC !== null && roomTempC >= HIGH_ROOM_TEMP_C) {
    return 0.9;
  }
  return 0.7;
}

/**
 * §14.4 outside-warmer-branch target. Roof glazing intercepts steeper
 * sun angles for longer durations, so the regelwerk pushes the target
 * the extra 0.05 closer to fully closed when the window is on the
 * roof.
 */
function warmerTarget(sunOnWindowNow: boolean, isRoof: boolean): number {
  if (!sunOnWindowNow) {
    return 0.6;
  }
  return isRoof ? 0.95 : 0.9;
}

/** Clamp a finite number to `[0, 1]`; NaN coerces to 0. */
function clamp01(x: number): number {
  if (Number.isNaN(x) || x <= 0) {
    return 0;
  }
  if (x >= 1) {
    return 1;
  }
  return x;
}

// ---------------------------------------------------------------------------
// Lüften-Lockout (smart-shading-notifications Task 6).
// ---------------------------------------------------------------------------

/**
 * Ventilation lockout (Requirement 7): when a window's contact reports a
 * fully **open** sash, the engine assumes the resident is airing the room
 * and must not actuate that window's shutter at all until it closes again.
 *
 * This is stronger than the §14 airflow adjustment above — it suppresses the
 * move entirely rather than nudging the target. It is **bypassed during
 * STORM** so the safety layer's forced-open action is never blocked
 * (Requirement 7.4 — the lockout must not override safety/lockout protection).
 *
 * `tilted` does NOT trigger the full lockout: a tilted window is the §14
 * airflow case, where partial shutter movement is still desirable. Only a
 * fully open sash engages the lockout.
 *
 * Pure predicate; the orchestrator consumes it in the dispatch step.
 */
export function isVentingLockout(
  contactState: ContactState,
  mode: string,
): boolean {
  if (mode === 'STORM') {
    return false;
  }
  return contactState === 'open';
}

// ---------------------------------------------------------------------------
// Top-level: applyVentilation.
// ---------------------------------------------------------------------------

/**
 * Apply Regelwerk §14 to a single window for one cycle.
 *
 * Pipeline:
 *
 *   1. **Closed / unknown contact**: §14 does not fire — return
 *      `baseTarget01` unchanged with empty rules and no block.
 *   2. **Temperature branch**:
 *      - both temps available → pick §14.2 / §14.3 / §14.4 by
 *        `delta = room − outdoor`.
 *      - exactly one temp available → default to §14.3 ("ähnlich
 *        warm"); the high-room-temp sub-rule still works when the
 *        room reading is the available one.
 *      - both temps missing → no temp branch fires.
 *   3. **§14.5 lockout**: cap the target at
 *      `maxPositionWhenOpenPct / 100` for doors (always) and for
 *      non-door windows with `lockoutProtection = true` (only when
 *      the cap would actually descend further).
 *   4. **§14.6 immobile-while-open**: surface
 *      `blockedByOpenWindow = true` if `canMoveWhenOpen = false`. The
 *      target is **not** rewritten here — the orchestrator is the
 *      authority that holds the current shutter position.
 *   5. **Defensive clamp** to `[0, 1]`.
 *
 * Pure: same inputs → same outputs, no side effects.
 */
export function applyVentilation(inputs: VentilationInputs): VentilationResult {
  // --- Step 1: contact gate ------------------------------------------------
  if (inputs.contactState === 'closed' || inputs.contactState === 'unknown') {
    return {
      target01: inputs.baseTarget01,
      appliedRules: [],
      blockedByOpenWindow: false,
    };
  }

  let target = inputs.baseTarget01;
  const appliedRules: string[] = [];
  const isRoof = inputs.window.type === 'roof_window';

  // --- Step 2: temperature branch -----------------------------------------
  const { roomTempC, outdoorTempC, sunOnWindowNow, pvSmoothedKw } = inputs;
  const haveBoth = roomTempC !== null && outdoorTempC !== null;
  const havePartial = roomTempC !== null || outdoorTempC !== null;

  if (haveBoth) {
    const delta = (roomTempC as number) - (outdoorTempC as number);
    if (delta >= COOL_DELTA_C) {
      // §14.2 — open up for airflow even if heat protection wanted more closed.
      const vent = coolingTarget(sunOnWindowNow, pvSmoothedKw);
      target = Math.min(target, vent);
      appliedRules.push('§14.2 outside-cooler');
    } else if (delta > WARM_DELTA_C) {
      // §14.3 — half-closed, heat protection floor wins on top.
      const vent = similarTarget(sunOnWindowNow, roomTempC);
      target = Math.max(target, vent);
      appliedRules.push('§14.3 similar-temps');
    } else {
      // §14.4 — close hard, heat protection floor wins on top.
      const vent = warmerTarget(sunOnWindowNow, isRoof);
      target = Math.max(target, vent);
      appliedRules.push('§14.4 outside-warmer');
    }
  } else if (havePartial) {
    // Partial information: default to the §14.3 "ähnlich warm" branch.
    // The high-room-temp sub-rule still fires when the room reading is
    // the one we have.
    const vent = similarTarget(sunOnWindowNow, roomTempC);
    target = Math.max(target, vent);
    appliedRules.push('§14.3 similar-temps');
  }
  // else: both temps missing → no temp branch, target stays baseTarget01.

  // --- Step 3: §14.5 door / lockout-protection cap -------------------------
  const cap = inputs.window.maxPositionWhenOpenPct / 100;
  if (inputs.window.isDoor) {
    // Always log the rule for doors; the cap only descends.
    if (target > cap) {
      target = cap;
    }
    appliedRules.push('§14.5 door-lockout');
  } else if (inputs.window.lockoutProtection && target > cap) {
    // Generic lockout — only logged when it actually caps.
    target = cap;
    appliedRules.push('§14.5 lockout-protection');
  }

  // --- Step 4: §14.6 immobile-while-open flag -----------------------------
  let blockedByOpenWindow = false;
  if (inputs.window.canMoveWhenOpen === false) {
    blockedByOpenWindow = true;
    appliedRules.push('§14.6 cannot-move-when-open');
  }

  // --- Step 5: defensive clamp --------------------------------------------
  return {
    target01: clamp01(target),
    appliedRules,
    blockedByOpenWindow,
  };
}
