/**
 * Heat Shield — PV-led feels-like heat-load model
 * (smart-shading-notifications Tasks 2.1 / 2.2 / 2.3).
 *
 * This module turns the raw solar/temperature signals into one normalized
 * "effective heat load" in `[0, 1]` that the shading FSM (Task 3) and the
 * orchestrator use to decide *whether* and *how far* to close a shutter.
 *
 * ## The leading indicator is PV power, not air temperature
 *
 * Requirement 1: the PV inverter's current power is the most direct, fastest
 * signal for "a lot of solar energy is hitting the building right now". Air
 * temperature lags by hours and is confounded by wind/shade. So PV carries
 * the highest (or co-leading) weight, and the air temperature *scales* its
 * effect: the same 4 kW of sun feels hotter at 28 °C than at 18 °C
 * (Requirement 1.2 / 2.2 — "20 °C in full sun beats 20 °C under clouds").
 *
 * The combination is a normalized weighted sum plus a bounded PV×temperature
 * interaction term:
 *
 *   base   = wPv·pv01 + wTemp·temp01 + wTrend·trend01     (weights sum to 1)
 *   raw    = base + gain·pv01·temp01
 *   load01 = clamp01(raw / (1 + gain))
 *
 * Because `pv01` is non-decreasing in `pvKw` and every coefficient is
 * non-negative, `load01` is **monotonically non-decreasing in PV power**
 * (Correctness Property 1 / Task 2.4). This deliberately stays a normalized
 * weighting — it never reverts to the additive model the steering doc forbids.
 *
 * ## Fallback without PV (Requirement 1.3 / 5.4)
 *
 * When PV power is unavailable, `pv01` is replaced by an optional solar proxy
 * (`fallbackSolar01`, fed by the sun-position / radiation signals at the
 * orchestrator level). The weight that would have gone to PV is then carried
 * by that proxy so shading does not simply switch off. The result is flagged
 * `degraded` so the dashboard can show the reduced confidence.
 *
 * ## Module rules (mirrored from the other engine modules)
 *
 *   - Pure: no fs, no logging, no Connect-API artefacts, no globals.
 *   - Strict TS, ESM, `.js` import suffixes.
 *   - Output is always in `[0, 1]`; `feelsLikeC` is illustrative and
 *     normalized, **not** a meteorological apparent-temperature formula.
 */

/** Tunable weights for the three heat-load drivers. Need not sum to 1. */
export interface HeatLoadWeights {
  pv: number;
  temp: number;
  trend: number;
}

/** Inputs for one heat-load evaluation. */
export interface HeatLoadInputs {
  /** Current PV power in kW; `null` ⇒ use `fallbackSolar01`. */
  pvKw: number | null;
  /** Installed peak PV power in kWp (denominator for `pv01`). */
  pvPeakKwp: number;
  /** Outdoor temperature in °C; `null` ⇒ temperature driver contributes 0. */
  outdoorTempC: number | null;
  /** Outdoor temperature slope in °C/h (from `TrendStore`); `null` ⇒ 0. */
  outdoorTrendCph: number | null;
  /** Driver weights. */
  weights: HeatLoadWeights;
  /**
   * Optional solar proxy in `[0, 1]` (sun-position / radiation) used in place
   * of PV when `pvKw` is `null`. When omitted and PV is missing, the PV
   * driver simply drops out and the remaining weights are renormalized.
   */
  fallbackSolar01?: number | null;
  /** Tuning knobs; all optional with documented defaults. */
  tuning?: Partial<HeatLoadTuning>;
}

/** Tuning knobs with documented defaults. */
export interface HeatLoadTuning {
  /** Air temperature (°C) at which the temperature driver is 0. */
  tempZeroC: number;
  /** Air temperature (°C) at which the temperature driver saturates to 1. */
  tempOneC: number;
  /** Upward temperature slope (°C/h) at which the trend driver saturates. */
  trendFullScaleCph: number;
  /** Strength of the PV×temperature amplification (≥ 0). */
  interactionGain: number;
  /** Max °C added to `feelsLikeC` at full solar drive (illustrative). */
  feelsLikeMaxOffsetC: number;
}

/** Result of a heat-load evaluation. */
export interface HeatLoadResult {
  /** Effective heat load in `[0, 1]` — the value the engine consumes. */
  load01: number;
  /** Illustrative feels-like temperature in °C; `null` if no air temp. */
  feelsLikeC: number | null;
  /** Normalized PV (or fallback) driver in `[0, 1]`; `null` if unavailable. */
  solar01: number | null;
  /** Normalized temperature driver in `[0, 1]`; `null` if no air temp. */
  temp01: number | null;
  /** Normalized upward-trend driver in `[0, 1]`; `null` if no trend. */
  trend01: number | null;
  /** True when PV was missing (fallback used or driver dropped). */
  degraded: boolean;
}

export const DEFAULT_HEAT_LOAD_TUNING: HeatLoadTuning = {
  tempZeroC: 18,
  tempOneC: 32,
  trendFullScaleCph: 3,
  interactionGain: 0.4,
  feelsLikeMaxOffsetC: 6,
};

/** Default driver weights — PV leading (Requirement 1.1). */
export const DEFAULT_HEAT_LOAD_WEIGHTS: HeatLoadWeights = {
  pv: 0.5,
  temp: 0.3,
  trend: 0.2,
};

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

function isFiniteNumber(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function linearFactor(value: number, zeroAt: number, oneAt: number): number {
  if (oneAt === zeroAt) {
    return 0;
  }
  return clamp01((value - zeroAt) / (oneAt - zeroAt));
}

/** Non-negative, finite weight or 0. */
function safeWeight(w: number): number {
  return isFiniteNumber(w) && w > 0 ? w : 0;
}

/**
 * Compute the normalized effective heat load and the illustrative feels-like
 * temperature. See the module header for the model and its monotonicity
 * guarantee.
 */
export function effectiveHeatLoad01(inputs: HeatLoadInputs): HeatLoadResult {
  const tuning: HeatLoadTuning = {
    ...DEFAULT_HEAT_LOAD_TUNING,
    ...(inputs.tuning ?? {}),
  };

  // --- Solar driver (PV leading, fallback otherwise) ---
  let solar01: number | null = null;
  let degraded = false;
  if (isFiniteNumber(inputs.pvKw) && isFiniteNumber(inputs.pvPeakKwp) && inputs.pvPeakKwp > 0) {
    solar01 = clamp01(inputs.pvKw / inputs.pvPeakKwp);
  } else {
    degraded = true;
    if (isFiniteNumber(inputs.fallbackSolar01)) {
      solar01 = clamp01(inputs.fallbackSolar01);
    }
  }

  // --- Temperature driver ---
  const temp01 = isFiniteNumber(inputs.outdoorTempC)
    ? linearFactor(inputs.outdoorTempC, tuning.tempZeroC, tuning.tempOneC)
    : null;

  // --- Upward-trend driver (only positive slopes add load) ---
  const trend01 = isFiniteNumber(inputs.outdoorTrendCph)
    ? clamp01(inputs.outdoorTrendCph / tuning.trendFullScaleCph)
    : null;

  // --- Weighted, renormalized base over the *available* drivers ---
  const wPv = safeWeight(inputs.weights.pv);
  const wTemp = safeWeight(inputs.weights.temp);
  const wTrend = safeWeight(inputs.weights.trend);

  let weightedSum = 0;
  let weightTotal = 0;
  if (solar01 !== null) {
    weightedSum += wPv * solar01;
    weightTotal += wPv;
  }
  if (temp01 !== null) {
    weightedSum += wTemp * temp01;
    weightTotal += wTemp;
  }
  if (trend01 !== null) {
    weightedSum += wTrend * trend01;
    weightTotal += wTrend;
  }

  const base = weightTotal > 0 ? weightedSum / weightTotal : 0;

  // --- Bounded PV×temperature interaction (keeps PV monotonicity) ---
  const gain = isFiniteNumber(tuning.interactionGain) && tuning.interactionGain > 0
    ? tuning.interactionGain
    : 0;
  const interaction =
    solar01 !== null && temp01 !== null ? gain * solar01 * temp01 : 0;
  const load01 = clamp01((base + interaction) / (1 + gain));

  // --- Illustrative feels-like temperature (normalized, not meteorological) ---
  const feelsLikeC =
    inputs.outdoorTempC !== null && isFiniteNumber(inputs.outdoorTempC)
      ? inputs.outdoorTempC + tuning.feelsLikeMaxOffsetC * (solar01 ?? 0)
      : null;

  return { load01, feelsLikeC, solar01, temp01, trend01, degraded };
}
