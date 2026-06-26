/**
 * Heat Shield — risk model (Task 7.1).
 *
 * This module is the heart of the engine. For every configured window in
 * every cycle the orchestrator calls {@link computeRisk}; the result is a
 * normalised score in `[0, 1]` plus a per-factor breakdown that the
 * dashboard surfaces in the live view. {@link mapRiskToShutter01} then
 * folds the score into a discrete shutter target, also in `[0, 1]`
 * (Connect API convention: `1 = fully closed`, see steering doc).
 *
 * Design references:
 *   - `design.md` §Property 1 (normalised weighted factors)
 *   - `design.md` §Property 2 (sun factor — computed by `engine/sun.ts`)
 *   - `design.md` §Property 3 (PV-lobe gating)
 *   - `design.md` §Property 4 (risk → shutter mapping)
 *   - `regelwerk` §10–§12 (point definitions and shutter mapping)
 *
 * Module rules (mirrored from `engine/sun.ts`):
 *   - Pure: no fs, no logging, no Connect-API artefacts, no globals.
 *   - Strict TS, ESM, `.js` import suffixes.
 *   - The risk score is **always** in `[0, 1]` — steering hard rule. Each
 *     `compute*Factor` function clamps internally; the eight weights for
 *     each profile sum to exactly `1`, so the weighted sum cannot exceed
 *     the unit interval. A defensive `clamp01` on the total absorbs
 *     IEEE-754 drift only.
 */

import type { Priority, RoomTargets, Window } from '../../shared/types.js';

import type { SunPosition } from './sun.js';

// ---------------------------------------------------------------------------
// Internal helpers — not exported.
// ---------------------------------------------------------------------------

/**
 * Clamp `x` to the closed interval `[0, 1]`. NaN coerces to 0 so a single
 * upstream divide-by-zero cannot poison the whole risk computation.
 */
function clamp01(x: number): number {
  if (Number.isNaN(x)) {
    return 0;
  }
  if (x <= 0) {
    return 0;
  }
  if (x >= 1) {
    return 1;
  }
  return x;
}

/**
 * Linear ramp from `zeroAt` (factor = 0) to `oneAt` (factor = 1), clamped
 * to `[0, 1]` outside that interval. If `zeroAt === oneAt` we cannot
 * compute a meaningful slope and fall back to 0 — this only happens in
 * misconfigured tests; real configs satisfy `target_c < critical_c` etc.
 */
function linearFactor(value: number, zeroAt: number, oneAt: number): number {
  if (oneAt === zeroAt) {
    return 0;
  }
  return clamp01((value - zeroAt) / (oneAt - zeroAt));
}

// ---------------------------------------------------------------------------
// Public types.
// ---------------------------------------------------------------------------

/**
 * Profile selector — mirrors `Rules.profile` in the schema. Kept as a
 * literal union here so this module does not depend on the full Zod
 * surface.
 */
export type RiskProfile = 'conservative' | 'standard' | 'aggressive' | 'custom';

/**
 * Per-factor numeric breakdown. Every value is in `[0, 1]` after the
 * factor functions have done their clamping. The same shape is reused
 * for the matching weights and the per-factor weighted contributions
 * inside {@link RiskBreakdown}.
 */
export interface RiskFactors {
  sunFactor: number;
  roomTempFactor: number;
  windowTypeFactor: number;
  forecastTempFactor: number;
  /** Always `0` when the window is outside the PV lobe (design §Property 3). */
  pvFactor: number;
  radiationFactor: number;
  outdoorTempFactor: number;
  priorityFactor: number;
}

/**
 * Inputs for one engine cycle, one window. The orchestrator assembles
 * this object from the snapshot bus + per-room signals; {@link computeRisk}
 * is otherwise pure.
 */
export interface RiskInputs {
  /** Per-window geometry needed by `windowTypeFactor` and the PV lobe. */
  window: Pick<Window, 'orientationDeg' | 'type'>;
  /** Window's effective priority — derived from `window.roomId → room.priority`. */
  windowPriority: Priority;
  /** Sun position — kept for breakdown / future per-window factors. */
  sun: SunPosition;
  /** Pre-computed sun factor in `[0, 1]` from `engine/sun.ts::sunFactor`. */
  sunFactor01: number;
  /** Room temperature in °C; `null` ⇒ factor = 0 (defer to other factors). */
  roomTempC: number | null;
  /** Room comfort/critical temperature targets. */
  roomTargets: RoomTargets;
  /** Outdoor temperature in °C; `null` ⇒ factor = 0. */
  outdoorTempC: number | null;
  /** Forecast daily max temperature in °C; `null` ⇒ factor = 0. */
  forecastMaxTempC: number | null;
  /** Smoothed PV power in kW (FusionSolar `inputPower`); `null` ⇒ factor = 0. */
  pvSmoothedKw: number | null;
  /** Installed peak PV power in kWp; comes from `fusionSolar.pvPeakKwp`. */
  pvPeakKwp: number;
  /** Short-wave radiation (OpenMeteo) in W/m²; `null` ⇒ factor = 0. */
  radiationWm2: number | null;
  /** Profile selector — controls weight overrides. */
  profile: RiskProfile;
  /**
   * Optional PV array azimuth (deg). When set, the PV factor is softly
   * weighted around this direction instead of the hard 90°–200° lobe (V1.8).
   */
  pvLobeCenterDeg?: number;
}

/**
 * Full breakdown returned by {@link computeRisk}. Includes the raw
 * factors, the weights that were applied for the active profile, the
 * per-factor weighted contributions (`factor_i * weight_i`), and the
 * total `riskTotal` in `[0, 1]`.
 *
 * The weighted-by-factor breakdown is intentionally exposed so the
 * dashboard can render a stacked bar chart of contributions without
 * having to multiply factors and weights itself.
 */
export interface RiskBreakdown {
  factors: RiskFactors;
  weights: Readonly<RiskFactors>;
  weighted: Readonly<RiskFactors>;
  /** Sum of the eight weighted contributions, clamped to `[0, 1]`. */
  riskTotal: number;
}

// ---------------------------------------------------------------------------
// Per-factor functions.
// ---------------------------------------------------------------------------

/**
 * Linear interpolation from `targets.target_c` (factor = 0) to
 * `targets.critical_c` (factor = 1), clamped to `[0, 1]`.
 *
 * `null` returns 0 — a missing room temperature reading means the
 * engine defers to the other factors rather than guessing a value.
 */
export function computeRoomTempFactor(
  roomTempC: number | null,
  targets: RoomTargets,
): number {
  if (roomTempC === null) {
    return 0;
  }
  return linearFactor(roomTempC, targets.target_c, targets.critical_c);
}

/**
 * Window-type factor: `roof_window = 1`, `facade = 0`. Roof glazing
 * intercepts steeper sun angles for longer durations and historically
 * heats up much faster than vertical façade glass — the per-window
 * weight contribution gives the engine a constant push for skylights.
 */
export function computeWindowTypeFactor(window: Pick<Window, 'type'>): number {
  return window.type === 'roof_window' ? 1 : 0;
}

/**
 * Forecast-temperature factor: linear ramp 24 °C (0) → 32 °C (1),
 * clamped. `null` returns 0.
 *
 * `forecastMaxC` is the engine's "today's expected daily max" signal
 * (definition of horizon lives in design.md §Property 5: today's max
 * before 14:00 local, otherwise max(rest-of-today, tomorrow)). This
 * factor is a forward-looking nudge — by the time the indoor sensor
 * registers a problem the heat is already inside.
 */
export function computeForecastTempFactor(forecastMaxC: number | null): number {
  if (forecastMaxC === null) {
    return 0;
  }
  return linearFactor(forecastMaxC, 24, 32);
}

/**
 * Returns true iff the window's orientation lies inside the PV lobe
 * (azimuth 90° = E to 200° = SSW, inclusive).
 *
 * The orientation is normalised to `[0, 360)` first, so callers may
 * pass values outside that range (e.g. 360, -45). Note that 360 maps
 * to 0 and is therefore *outside* the lobe — only 90..200 inclusive
 * counts.
 */
export function isOrientationInPvLobe(orientationDeg: number): boolean {
  const normalised = ((orientationDeg % 360) + 360) % 360;
  return normalised >= 90 && normalised <= 200;
}

/**
 * Smallest absolute angular difference between two azimuths, in degrees [0,180].
 */
function circularAngleDiff(a: number, b: number): number {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return d > 180 ? 360 - d : d;
}

/**
 * PV factor — gated through {@link isOrientationInPvLobe} by default, or
 * softly weighted around a configured array azimuth when `lobeCenterDeg` is
 * supplied (V1.8).
 *
 * For a window with valid PV data, the power term is the smoothed inverter
 * input power normalised to the headroom above 1 kW:
 * `clamp01((kw − 1) / (peak − 1))`. That term is then gated:
 *   - **Legacy (no `lobeCenterDeg`)**: hard lobe — full power inside azimuth
 *     90°..200°, otherwise 0. Preserves the documented §Property 3 behaviour.
 *   - **Configured (`lobeCenterDeg` given)**: soft cosine-style alignment
 *     `clamp01(1 − Δ/120°)` around the real array azimuth, so a SW array
 *     weights SW windows highest and fades smoothly to 0 by ±120°.
 *
 * `null` PV, `peak ≤ 1 kWp`, or an out-of-lobe window all yield 0.
 */
export function computePvFactor(
  window: Pick<Window, 'orientationDeg'>,
  pvSmoothedKw: number | null,
  pvPeakKwp: number,
  lobeCenterDeg?: number,
): number {
  if (pvSmoothedKw === null) {
    return 0;
  }
  if (pvPeakKwp <= 1) {
    return 0;
  }
  const powerNorm = clamp01((pvSmoothedKw - 1.0) / (pvPeakKwp - 1.0));
  if (lobeCenterDeg === undefined) {
    if (!isOrientationInPvLobe(window.orientationDeg)) {
      return 0;
    }
    return powerNorm;
  }
  const align = clamp01(1 - circularAngleDiff(window.orientationDeg, lobeCenterDeg) / 120);
  return powerNorm * align;
}

/**
 * Short-wave radiation factor: linear 100 W/m² (0) → 800 W/m² (1),
 * clamped. `null` returns 0.
 *
 * In `aggressive` profile the weight on this factor is bumped from
 * 0.05 → 0.10 so that windows outside the PV lobe (W, NW) still get a
 * useful daylight-intensity signal — see design.md §Property 3 prose.
 */
export function computeRadiationFactor(radiationWm2: number | null): number {
  if (radiationWm2 === null) {
    return 0;
  }
  return linearFactor(radiationWm2, 100, 800);
}

/**
 * Outdoor-temperature factor: linear 22 °C (0) → 32 °C (1), clamped.
 * `null` returns 0.
 */
export function computeOutdoorTempFactor(outdoorTempC: number | null): number {
  if (outdoorTempC === null) {
    return 0;
  }
  return linearFactor(outdoorTempC, 22, 32);
}

/**
 * Priority factor — discrete mapping from the room's priority enum to
 * `[0, 1]`:
 *
 * | priority   | factor |
 * | ---------- | ------ |
 * | very_high  | 1.00   |
 * | high       | 0.66   |
 * | medium     | 0.33   |
 * | low        | 0.00   |
 *
 * The `0.66 / 0.33` values are intentionally exact decimal twins of
 * the `2/3` and `1/3` ladder positions — the dashboard renders them
 * verbatim so we use the rounded constants rather than fractions.
 */
export function computePriorityFactor(priority: Priority): number {
  switch (priority) {
    case 'very_high':
      return 1.0;
    case 'high':
      return 0.66;
    case 'medium':
      return 0.33;
    case 'low':
      return 0.0;
  }
}

// ---------------------------------------------------------------------------
// Profile weights.
// ---------------------------------------------------------------------------

/**
 * Standard weights — the default risk balance. Each entry sums with the
 * other seven to exactly 1.0 (verified by unit test using
 * `toBeCloseTo(1, 9)`).
 */
const STANDARD_WEIGHTS: Readonly<RiskFactors> = Object.freeze({
  sunFactor: 0.3,
  roomTempFactor: 0.25,
  windowTypeFactor: 0.1,
  forecastTempFactor: 0.1,
  pvFactor: 0.1,
  radiationFactor: 0.05,
  outdoorTempFactor: 0.05,
  priorityFactor: 0.05,
});

/**
 * Conservative weights — slightly less aggressive on sun (0.25 instead
 * of 0.30), with the saved 0.05 reallocated to `priorityFactor` so
 * priority rooms still get an unambiguous boost. Suits households where
 * the residents prefer manual override over premature shutter moves.
 */
const CONSERVATIVE_WEIGHTS: Readonly<RiskFactors> = Object.freeze({
  sunFactor: 0.25,
  roomTempFactor: 0.25,
  windowTypeFactor: 0.1,
  forecastTempFactor: 0.1,
  pvFactor: 0.1,
  radiationFactor: 0.05,
  outdoorTempFactor: 0.05,
  priorityFactor: 0.1,
});

/**
 * Aggressive weights — keeps the sun heavyweight (0.30) but trims
 * `roomTempFactor` (0.20) in favour of a heavier `radiationFactor`
 * (0.10). The bump on radiation is the design.md §Property 3 prose
 * compensation for windows outside the PV lobe.
 */
const AGGRESSIVE_WEIGHTS: Readonly<RiskFactors> = Object.freeze({
  sunFactor: 0.3,
  roomTempFactor: 0.2,
  windowTypeFactor: 0.1,
  forecastTempFactor: 0.1,
  pvFactor: 0.1,
  radiationFactor: 0.1,
  outdoorTempFactor: 0.05,
  priorityFactor: 0.05,
});

/**
 * Returns the immutable weight set for the requested profile.
 *
 * `custom` is currently aliased to `standard`. Task 12.3 will replace
 * this stub with a parsed-config lookup that lets the dashboard expose
 * arbitrary user weights; until then, picking `custom` in the UI
 * behaves like `standard` so the engine never crashes on a partially
 * implemented profile.
 */
export function profileWeights(profile: RiskProfile): Readonly<RiskFactors> {
  switch (profile) {
    case 'conservative':
      return CONSERVATIVE_WEIGHTS;
    case 'aggressive':
      return AGGRESSIVE_WEIGHTS;
    case 'standard':
    case 'custom':
      return STANDARD_WEIGHTS;
  }
}

// ---------------------------------------------------------------------------
// Top-level: computeRisk + mapRiskToShutter01.
// ---------------------------------------------------------------------------

/**
 * Compute the per-window risk score for a single engine cycle.
 *
 * Steps:
 *   1. Resolve every factor via its dedicated `compute*Factor` helper.
 *      Each helper clamps to `[0, 1]` so the weighted sum cannot
 *      escape the unit interval even with hostile inputs.
 *   2. Look up the profile's weights (each set sums to 1).
 *   3. Multiply factor × weight pointwise (`weighted`).
 *   4. Sum `weighted`, clamp once to soak up IEEE-754 drift, return
 *      the full breakdown.
 *
 * The function is pure: same inputs → same outputs, no side effects.
 */
export function computeRisk(inputs: RiskInputs): RiskBreakdown {
  const factors: RiskFactors = {
    sunFactor: clamp01(inputs.sunFactor01),
    roomTempFactor: computeRoomTempFactor(inputs.roomTempC, inputs.roomTargets),
    windowTypeFactor: computeWindowTypeFactor(inputs.window),
    forecastTempFactor: computeForecastTempFactor(inputs.forecastMaxTempC),
    pvFactor: computePvFactor(
      inputs.window,
      inputs.pvSmoothedKw,
      inputs.pvPeakKwp,
      inputs.pvLobeCenterDeg,
    ),
    radiationFactor: computeRadiationFactor(inputs.radiationWm2),
    outdoorTempFactor: computeOutdoorTempFactor(inputs.outdoorTempC),
    priorityFactor: computePriorityFactor(inputs.windowPriority),
  };

  const baseWeights = profileWeights(inputs.profile);

  // V1.8 — conservative on missing data: redistribute the weight of factors
  // whose underlying input is absent across the factors that DO have data, so
  // a missing sensor no longer silently dilutes the score toward "don't shade".
  // Factors that are always available (sun, window type, priority) stay; the
  // five sensor-fed factors drop out when their input is null.
  const present: RiskFactors = {
    sunFactor: 1,
    roomTempFactor: inputs.roomTempC !== null ? 1 : 0,
    windowTypeFactor: 1,
    forecastTempFactor: inputs.forecastMaxTempC !== null ? 1 : 0,
    pvFactor: inputs.pvSmoothedKw !== null ? 1 : 0,
    radiationFactor: inputs.radiationWm2 !== null ? 1 : 0,
    outdoorTempFactor: inputs.outdoorTempC !== null ? 1 : 0,
    priorityFactor: 1,
  };
  const presentWeightSum =
    baseWeights.sunFactor * present.sunFactor +
    baseWeights.roomTempFactor * present.roomTempFactor +
    baseWeights.windowTypeFactor * present.windowTypeFactor +
    baseWeights.forecastTempFactor * present.forecastTempFactor +
    baseWeights.pvFactor * present.pvFactor +
    baseWeights.radiationFactor * present.radiationFactor +
    baseWeights.outdoorTempFactor * present.outdoorTempFactor +
    baseWeights.priorityFactor * present.priorityFactor;

  // Renormalise present weights to sum to 1. `presentWeightSum` is always > 0
  // because sun/windowType/priority are always present with positive weight.
  const norm = presentWeightSum > 0 ? presentWeightSum : 1;
  const weights: RiskFactors = {
    sunFactor: (baseWeights.sunFactor * present.sunFactor) / norm,
    roomTempFactor: (baseWeights.roomTempFactor * present.roomTempFactor) / norm,
    windowTypeFactor: (baseWeights.windowTypeFactor * present.windowTypeFactor) / norm,
    forecastTempFactor: (baseWeights.forecastTempFactor * present.forecastTempFactor) / norm,
    pvFactor: (baseWeights.pvFactor * present.pvFactor) / norm,
    radiationFactor: (baseWeights.radiationFactor * present.radiationFactor) / norm,
    outdoorTempFactor: (baseWeights.outdoorTempFactor * present.outdoorTempFactor) / norm,
    priorityFactor: (baseWeights.priorityFactor * present.priorityFactor) / norm,
  };

  const weighted: RiskFactors = {
    sunFactor: factors.sunFactor * weights.sunFactor,
    roomTempFactor: factors.roomTempFactor * weights.roomTempFactor,
    windowTypeFactor: factors.windowTypeFactor * weights.windowTypeFactor,
    forecastTempFactor: factors.forecastTempFactor * weights.forecastTempFactor,
    pvFactor: factors.pvFactor * weights.pvFactor,
    radiationFactor: factors.radiationFactor * weights.radiationFactor,
    outdoorTempFactor: factors.outdoorTempFactor * weights.outdoorTempFactor,
    priorityFactor: factors.priorityFactor * weights.priorityFactor,
  };

  const riskTotal = clamp01(
    weighted.sunFactor +
      weighted.roomTempFactor +
      weighted.windowTypeFactor +
      weighted.forecastTempFactor +
      weighted.pvFactor +
      weighted.radiationFactor +
      weighted.outdoorTempFactor +
      weighted.priorityFactor,
  );

  return {
    factors,
    weights,
    weighted: Object.freeze(weighted),
    riskTotal,
  };
}

/**
 * Map a risk score in `[0, 1]` to a shutter target in `[0, 1]` (V1.8 finer
 * 8-step ladder). Connect API convention: `1 = fully closed`.
 *
 * | risk window       | target |
 * | ----------------- | ------ |
 * | `[0,    0.12)`    | 0.00   |
 * | `[0.12, 0.22)`    | 0.15   |
 * | `[0.22, 0.34)`    | 0.30   |
 * | `[0.34, 0.46)`    | 0.45   |
 * | `[0.46, 0.58)`    | 0.60   |
 * | `[0.58, 0.70)`    | 0.75   |
 * | `[0.70, 0.85)`    | 0.90   |
 * | `[0.85, 1.00]`    | 1.00   |
 *
 * Steps are ~0.15 apart so the anti-flap hysteresis (`minPositionDeltaPct`,
 * default 15 %) still suppresses micro-moves, while the finer granularity
 * lets the predictive path land closer to the ideal position. The downstream
 * heat-protection cap then limits façades to 0.95.
 */
export function mapRiskToShutter01(risk: number): number {
  if (risk < 0.12) {
    return 0.0;
  }
  if (risk < 0.22) {
    return 0.15;
  }
  if (risk < 0.34) {
    return 0.3;
  }
  if (risk < 0.46) {
    return 0.45;
  }
  if (risk < 0.58) {
    return 0.6;
  }
  if (risk < 0.7) {
    return 0.75;
  }
  if (risk < 0.85) {
    return 0.9;
  }
  return 1.0;
}
