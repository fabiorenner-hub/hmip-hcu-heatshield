/**
 * Heat Shield — irrigation water balance (FAO-56, pure & testable).
 *
 * Maintains a soil-water depletion account per zone and derives the dose:
 *
 *   depletion(t) = clamp(depletion(t-1) + ETc − effectiveRain − irrigation,
 *                        0, TAW)
 *
 * where ETc = ET0 × Kc × exposureFactor. Irrigation triggers when depletion
 * reaches the readily-available water (RAW = MAD × TAW); the dose refills the
 * root zone back to field capacity (depletion → 0), capped by a per-pass
 * runoff limit via cycle-and-soak.
 *
 * Optionally, a measured soil-moisture reading blends into the modeled
 * depletion (closed loop), so sensor drift corrects the running estimate.
 */

import {
  clamp,
  cycleSoakPasses,
  defaultKc,
  depthMmToSeconds,
  exposureFactor,
  moisturePctToDepletionMm,
  readilyAvailableWaterMm,
  type Exposure,
  type PlantType,
  type SoilType,
  type Slope,
  totalAvailableWaterMm,
} from './soilModel.js';

/** Immutable profile inputs for one irrigation zone. */
export interface ZoneProfile {
  readonly plant: PlantType;
  readonly soil: SoilType;
  readonly exposure: Exposure;
  readonly slope: Slope;
  readonly rootDepthCm: number;
  readonly kc: number;
  readonly mad: number;
  /** Emitter output (mm/h) — converts depth to valve seconds. */
  readonly precipRateMmH: number;
}

export interface BalanceUpdateInput {
  /** Previous depletion estimate (mm); 0 = field capacity. */
  readonly prevDepletionMm: number;
  /** Reference ET (mm) accumulated over the step. */
  readonly et0Mm: number;
  /** Effective rainfall (mm) over the step (already net of runoff). */
  readonly rainMm: number;
  /** Irrigation actually applied (mm) over the step. */
  readonly irrigationMm: number;
  /**
   * Optional measured volumetric soil moisture (%) at end of step. When
   * present, the modeled depletion is blended toward the measurement by
   * `sensorWeight` (0..1).
   */
  readonly measuredMoisturePct?: number;
  readonly sensorWeight?: number;
}

/** Result of advancing the balance one step. */
export interface BalanceState {
  readonly depletionMm: number;
  readonly tawMm: number;
  readonly rawMm: number;
  /** Fraction of available water currently present (1 = field capacity). */
  readonly availableFraction: number;
}

/**
 * Crop ET (mm) for a step: ET0 × Kc × exposure factor. `kc` falls back to the
 * plant default when non-finite or ≤ 0.
 */
export function cropEtMm(profile: ZoneProfile, et0Mm: number): number {
  const kc = profile.kc > 0 && Number.isFinite(profile.kc) ? profile.kc : defaultKc(profile.plant);
  const et0 = Number.isFinite(et0Mm) && et0Mm > 0 ? et0Mm : 0;
  return et0 * kc * exposureFactor(profile.exposure);
}

/** Advance the depletion account one step. */
export function advanceBalance(
  profile: ZoneProfile,
  input: BalanceUpdateInput,
): BalanceState {
  const taw = totalAvailableWaterMm(profile.soil, profile.rootDepthCm);
  const raw = readilyAvailableWaterMm(profile.soil, profile.rootDepthCm, profile.mad);
  const etc = cropEtMm(profile, input.et0Mm);
  let depletion =
    input.prevDepletionMm +
    etc -
    Math.max(0, input.rainMm) -
    Math.max(0, input.irrigationMm);
  depletion = clamp(depletion, 0, taw);

  // Closed-loop blend with a measured moisture reading, if supplied.
  if (
    typeof input.measuredMoisturePct === 'number' &&
    Number.isFinite(input.measuredMoisturePct)
  ) {
    const measuredDepletion = moisturePctToDepletionMm(
      input.measuredMoisturePct,
      profile.soil,
      profile.rootDepthCm,
    );
    const w = clamp(input.sensorWeight ?? 0.4, 0, 1);
    depletion = clamp(depletion * (1 - w) + measuredDepletion * w, 0, taw);
  }

  return {
    depletionMm: depletion,
    tawMm: taw,
    rawMm: raw,
    availableFraction: taw > 0 ? clamp(1 - depletion / taw, 0, 1) : 1,
  };
}

export interface DoseResult {
  /** Whether the zone needs water now (depletion ≥ RAW). */
  readonly needed: boolean;
  /** Depth to apply to refill to field capacity (mm). */
  readonly depthMm: number;
  /** Total valve runtime (s) for the full dose. */
  readonly totalSeconds: number;
  /** Number of cycle-and-soak passes. */
  readonly passes: number;
  /** Seconds per pass (totalSeconds / passes, rounded). */
  readonly secondsPerPass: number;
}

/**
 * Compute the dose to bring `depletionMm` back to field capacity. Triggers
 * when depletion ≥ (RAW − `triggerBiasMm`); a positive bias makes the zone
 * water earlier (more headroom, e.g. in heat mode), a negative bias later
 * (leaner, e.g. eco). The depth is the full depletion; cycle-and-soak splits
 * it into runoff-safe passes.
 */
export function computeDose(
  profile: ZoneProfile,
  state: BalanceState,
  triggerBiasMm = 0,
): DoseResult {
  const trigger = Math.max(0, state.rawMm - triggerBiasMm);
  if (state.depletionMm < trigger || state.depletionMm <= 0) {
    return { needed: false, depthMm: 0, totalSeconds: 0, passes: 0, secondsPerPass: 0 };
  }
  const depthMm = state.depletionMm;
  const totalSeconds = depthMmToSeconds(depthMm, profile.precipRateMmH);
  const passes = cycleSoakPasses(depthMm, profile.soil, profile.slope);
  const secondsPerPass = passes > 0 ? Math.round(totalSeconds / passes) : 0;
  return { needed: totalSeconds > 0, depthMm, totalSeconds, passes, secondsPerPass };
}

/**
 * Effective rainfall (mm) from gross precipitation: small showers mostly
 * evaporate / run off, so we discount them. Simple FAO-style approximation:
 * losses of ~2 mm plus 10 % runoff on the remainder, floored at 0.
 */
export function effectiveRainMm(grossMm: number): number {
  if (!Number.isFinite(grossMm) || grossMm <= 0) return 0;
  const afterInterception = Math.max(0, grossMm - 2);
  return afterInterception * 0.9;
}
