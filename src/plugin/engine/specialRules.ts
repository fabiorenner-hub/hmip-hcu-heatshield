/**
 * Heat Shield — special rules (Task 7.3, Regelwerk §13).
 *
 * The risk model in `engine/risk.ts` produces a smooth target in
 * `[0, 1]`; this module applies a small set of **hard overrides**
 * defined by Regelwerk §13. Special rules run *after* the risk model
 * has produced `baseTarget01` and *before* the safety / hysteresis
 * layers (Task 7.5 / 7.6). They are intentionally not part of the
 * risk score: their job is to clamp upward to a known-safe shutter
 * position when a deterministic precondition is met (priorised room +
 * roof window + sun on window, or a heatwave + SE orientation).
 *
 * Three sections, mirrored from the regelwerk doc:
 *
 *   - **§13.1 Schlafzimmer-Dachfenster** — bedroom roof windows.
 *     Acts on the configured "bedroom" rooms only.
 *   - **§13.2 Arbeitszimmer-Dachfenster** — office roof windows.
 *     Slightly higher temperature thresholds since the typical office
 *     comfort band is wider than the sleeping comfort band.
 *   - **§13.3 Hitzewellenmodus** — global heatwave clamp for the SE
 *     band on priorised rooms (bedroom or office). SE = 105°–165°
 *     (§13.3 prose: "broadly Südost").
 *
 * Steering hard rule:
 *   - `heat_mode_active` is **`mode ∈ {ACTIVE_HEAT_PROTECTION,
 *     HEATWAVE}`** and is consumed via {@link isHeatModeActive} from
 *     `engine/modes.ts`. Do not widen.
 *
 * Module rules (mirrored from `engine/risk.ts` and `engine/modes.ts`):
 *   - Pure: no fs, no logging, no Connect-API artefacts, no globals.
 *   - Strict TS, ESM, `.js` import suffixes.
 *   - Inputs are accepted as a typed object; the function never
 *     mutates them. The returned `appliedRules` is a fresh array.
 */

import type { Mode, Priority, Window } from '../../shared/types.js';

import { isHeatModeActive } from './modes.js';

// ---------------------------------------------------------------------------
// Public constants.
// ---------------------------------------------------------------------------

/**
 * PV threshold (kW) above which the regelwerk forces priorised roof
 * windows to fully closed (§13.1.d / §13.2.d). Exposed as a module
 * constant so the dashboard "diagnostics" tab can render the same
 * value without duplicating it.
 */
export const ROOF_FORCE_CLOSE_KW = 4.0;

// ---------------------------------------------------------------------------
// SE-band thresholds.
// ---------------------------------------------------------------------------

/** Lower bound (inclusive) of the broadly-SE band per §13.3. */
const SE_AZIMUTH_LO = 105;
/** Upper bound (inclusive) of the broadly-SE band per §13.3. */
const SE_AZIMUTH_HI = 165;
/** Forecast trigger for the §13.3 cascade. */
const HEATWAVE_FORECAST_C = 30;

// ---------------------------------------------------------------------------
// Public types.
// ---------------------------------------------------------------------------

/**
 * Inputs for one special-rules evaluation, for a single window. The
 * orchestrator builds this object once per cycle from the snapshot
 * bus + per-room signals; {@link applySpecialRules} is otherwise pure.
 */
export interface SpecialRulesInputs {
  /** Window geometry needed for the §13 roof / SE checks. */
  window: Pick<Window, 'orientationDeg' | 'type'>;
  /**
   * Room name for matching against bedroom/office heuristics.
   * The orchestrator passes `Room.id` (the slug).
   */
  roomId: string;
  /** Room priority — used for the bedroom/office detection. */
  priority: Priority;
  /** Current room temperature in °C; null disables temp-based escalations. */
  roomTempC: number | null;
  /** Smoothed PV power in kW; null disables PV-based force-close. */
  pvSmoothedKw: number | null;
  /** PV peak (for the roof_force_close threshold). */
  pvPeakKwp: number;
  /** Sun is currently on the window. */
  sunOnWindowNow: boolean;
  /** Sun expected on window within prelook window. */
  sunOnWindowSoon: boolean;
  /** Forecast daily max temp; used for HEATWAVE escalation. */
  forecastMaxTempC: number | null;
  /** Current FSM mode. */
  mode: Mode;
  /** Pre-computed risk-based target. */
  baseTarget01: number;
}

/**
 * Result of one special-rules evaluation.
 *
 *   - `target01` is the (possibly upgraded) shutter target in `[0, 1]`,
 *     ready to flow into the safety / hysteresis layers.
 *   - `appliedRules` is the deterministic list of regelwerk references
 *     that fired during this evaluation, in the order they fired.
 *     The dashboard surfaces them in the live decision breakdown.
 */
export interface SpecialRulesResult {
  /** Final target after applying all special rules, in `[0, 1]`. */
  target01: number;
  /** Which rules fired (for logging / dashboard breakdown). */
  appliedRules: string[];
}

// ---------------------------------------------------------------------------
// Room / orientation predicates.
// ---------------------------------------------------------------------------

/**
 * Bedroom heuristic: lower-cased room id contains either `'bedroom'`
 * (English) or `'schlaf'` (German `Schlafzimmer`). Case-insensitive
 * by construction.
 */
export function isBedroomLike(roomId: string): boolean {
  const id = roomId.toLowerCase();
  return id.includes('bedroom') || id.includes('schlaf');
}

/**
 * Office heuristic: lower-cased room id contains either `'office'`
 * (English) or `'arbeit'` (German `Arbeitszimmer`). Case-insensitive
 * by construction.
 */
export function isOfficeLike(roomId: string): boolean {
  const id = roomId.toLowerCase();
  return id.includes('office') || id.includes('arbeit');
}

/**
 * Broadly-SE orientation predicate per §13.3: the window azimuth
 * (degrees from north, clockwise) lies in the closed interval
 * `[105°, 165°]`.
 *
 * Unlike the PV-lobe predicate in `engine/risk.ts`, the SE band is
 * not normalised modulo 360 — special rules consult `Window.orientationDeg`
 * which the schema validates to `[0, 360)`.
 */
export function isSouthEastFacing(orientationDeg: number): boolean {
  return orientationDeg >= SE_AZIMUTH_LO && orientationDeg <= SE_AZIMUTH_HI;
}

// ---------------------------------------------------------------------------
// Top-level: applySpecialRules.
// ---------------------------------------------------------------------------

/**
 * Apply Regelwerk §13 special rules to `inputs.baseTarget01`.
 *
 * Rules are evaluated in the order §13.1 → §13.2 → §13.3. Within a
 * section, every triggered rule is recorded in `appliedRules`. Rules
 * marked "max" raise the target only if their floor exceeds the
 * running value; rules marked "force" set the target to 1.0 directly.
 *
 * The function is pure: same inputs → same outputs, no side effects.
 */
export function applySpecialRules(inputs: SpecialRulesInputs): SpecialRulesResult {
  let target = inputs.baseTarget01;
  const appliedRules: string[] = [];

  const isRoof = inputs.window.type === 'roof_window';
  const heatActive = isHeatModeActive(inputs.mode);

  // -------------------------------------------------------------------------
  // §13.1 Schlafzimmer-Dachfenster.
  // -------------------------------------------------------------------------
  if (isBedroomLike(inputs.roomId) && isRoof) {
    // §13.1.a Pre-look: heat mode + sun expected soon.
    if (inputs.sunOnWindowSoon && heatActive) {
      if (target < 0.8) {
        target = 0.8;
      }
      appliedRules.push('§13.1.a bedroom-roof-prelook');
    }
    // §13.1.b Warm room + sun on window.
    if (
      inputs.roomTempC !== null &&
      inputs.roomTempC >= 23.0 &&
      inputs.sunOnWindowNow
    ) {
      if (target < 0.9) {
        target = 0.9;
      }
      appliedRules.push('§13.1.b bedroom-roof-warm-sun');
    }
    // §13.1.c Warning room temp + sun on window — force close.
    if (
      inputs.roomTempC !== null &&
      inputs.roomTempC >= 23.5 &&
      inputs.sunOnWindowNow
    ) {
      target = 1.0;
      appliedRules.push('§13.1.c bedroom-roof-warning-sun');
    }
    // §13.1.d Strong PV + sun on window — force close.
    if (
      inputs.pvSmoothedKw !== null &&
      inputs.pvSmoothedKw > ROOF_FORCE_CLOSE_KW &&
      inputs.sunOnWindowNow
    ) {
      target = 1.0;
      appliedRules.push('§13.1.d bedroom-roof-pv-force');
    }
  }

  // -------------------------------------------------------------------------
  // §13.2 Arbeitszimmer-Dachfenster (mirror of §13.1 with office
  // thresholds: warm at 23.5 °C, warning at 24.0 °C).
  // -------------------------------------------------------------------------
  if (isOfficeLike(inputs.roomId) && isRoof) {
    // §13.2.a Pre-look.
    if (inputs.sunOnWindowSoon && heatActive) {
      if (target < 0.8) {
        target = 0.8;
      }
      appliedRules.push('§13.2.a office-roof-prelook');
    }
    // §13.2.b Warm room + sun on window.
    if (
      inputs.roomTempC !== null &&
      inputs.roomTempC >= 23.5 &&
      inputs.sunOnWindowNow
    ) {
      if (target < 0.9) {
        target = 0.9;
      }
      appliedRules.push('§13.2.b office-roof-warm-sun');
    }
    // §13.2.c Warning room temp + sun on window — force close.
    if (
      inputs.roomTempC !== null &&
      inputs.roomTempC >= 24.0 &&
      inputs.sunOnWindowNow
    ) {
      target = 1.0;
      appliedRules.push('§13.2.c office-roof-warning-sun');
    }
    // §13.2.d Strong PV + sun on window — force close.
    if (
      inputs.pvSmoothedKw !== null &&
      inputs.pvSmoothedKw > ROOF_FORCE_CLOSE_KW &&
      inputs.sunOnWindowNow
    ) {
      target = 1.0;
      appliedRules.push('§13.2.d office-roof-pv-force');
    }
  }

  // -------------------------------------------------------------------------
  // §13.3 Hitzewellenmodus — SE band on priorised rooms.
  //
  // Activates when EITHER the daily forecast is at heatwave level
  // (>= 30 °C) OR the FSM has already escalated to HEATWAVE. The two
  // can be redundant on the daytime path, but they decouple cleanly
  // when the forecast feed is missing (mode reflects room data) or
  // when the user has just installed the plugin (mode still NORMAL
  // but tomorrow's forecast already indicates heatwave).
  // -------------------------------------------------------------------------
  const heatwaveActive =
    (inputs.forecastMaxTempC !== null && inputs.forecastMaxTempC >= HEATWAVE_FORECAST_C) ||
    inputs.mode === 'HEATWAVE';

  if (heatwaveActive && isSouthEastFacing(inputs.window.orientationDeg)) {
    const isPriorityRoom = isBedroomLike(inputs.roomId) || isOfficeLike(inputs.roomId);
    if (isPriorityRoom) {
      if (isRoof) {
        if (target < 1.0) {
          target = 1.0;
        }
        appliedRules.push('§13.3.a heatwave-se-roof');
      } else {
        if (target < 0.9) {
          target = 0.9;
        }
        appliedRules.push('§13.3.b heatwave-se-facade');
      }
    }
  }

  return { target01: target, appliedRules };
}
