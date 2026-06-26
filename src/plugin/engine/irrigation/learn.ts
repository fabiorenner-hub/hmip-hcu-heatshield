/**
 * Heat Shield — irrigation learning algorithm (pure & testable).
 *
 * Closes the loop between the modeled water balance and reality using the
 * Gardena soil-moisture sensor. Two learned quantities per zone:
 *
 *   1. `kcFactor` — a correction on the crop coefficient. If the soil dries
 *      faster than ETc×Kc predicts (measured depletion rises more than
 *      modeled), Kc was too low → nudge the factor up; and vice-versa. An
 *      EWMA keeps it stable against daily noise.
 *
 *   2. `precipRateFactor` — a correction on the emitter output. After a
 *      watering of known duration, the measured moisture rise implies an
 *      actual applied depth; comparing to the configured precip rate yields a
 *      multiplicative correction. Also EWMA-smoothed.
 *
 * Plus a heuristic `emitterFault` flag: a watering ran but the soil moisture
 * did not rise meaningfully (and it was not already saturated) → likely a
 * clogged/disconnected emitter.
 *
 * All inputs are plain observations; no I/O. The orchestrator persists the
 * observation log and feeds a rolling window in here each day.
 */

import { clamp, moisturePctToDepletionMm, type SoilType } from './soilModel.js';

/** One day's closed-loop observation for a zone. */
export interface IrrigationObservation {
  /** Local date key YYYY-MM-DD. */
  readonly date: string;
  /** Reference ET sum over the day (mm). */
  readonly et0Mm: number;
  /** Effective rainfall over the day (mm). */
  readonly rainMm: number;
  /** Irrigation depth actually applied over the day (mm, from runtime). */
  readonly irrigationMm: number;
  /** Valve runtime over the day (s) — for precip-rate calibration. */
  readonly irrigationSeconds: number;
  /** Measured volumetric moisture (%) at start of day. */
  readonly moistureStartPct: number | null;
  /** Measured volumetric moisture (%) at end of day. */
  readonly moistureEndPct: number | null;
}

export interface LearnedZoneModel {
  readonly kcFactor: number;
  readonly precipRateFactor: number;
  readonly sampleDays: number;
  readonly emitterFault: boolean;
  /** Mean observed dry-down (mm/day) excluding watering days. */
  readonly avgDryDownMmPerDay: number | null;
  readonly note: string;
}

export const NEUTRAL_MODEL: LearnedZoneModel = {
  kcFactor: 1,
  precipRateFactor: 1,
  sampleDays: 0,
  emitterFault: false,
  avgDryDownMmPerDay: null,
  note: 'Noch keine Lerndaten.',
};

const EWMA_ALPHA = 0.3;
const KC_FACTOR_MIN = 0.5;
const KC_FACTOR_MAX = 1.8;
const PRECIP_FACTOR_MIN = 0.4;
const PRECIP_FACTOR_MAX = 2.5;

function ewma(prev: number, sample: number, alpha = EWMA_ALPHA): number {
  return prev * (1 - alpha) + sample * alpha;
}

/**
 * Recompute a zone's learned model from a rolling window of observations.
 * `soil`/`rootDepthCm` are needed to convert moisture % to mm. Returns
 * {@link NEUTRAL_MODEL} when there are no usable observations.
 */
export function learnZoneModel(
  observations: readonly IrrigationObservation[],
  soil: SoilType,
  rootDepthCm: number,
): LearnedZoneModel {
  if (observations.length === 0) return NEUTRAL_MODEL;

  let kcFactor = 1;
  let precipFactor = 1;
  let used = 0;
  let faultDays = 0;
  let wateringDays = 0;
  const dryDowns: number[] = [];

  const toDepletion = (pct: number | null): number | null =>
    pct === null ? null : moisturePctToDepletionMm(pct, soil, rootDepthCm);

  for (const o of observations) {
    const dStart = toDepletion(o.moistureStartPct);
    const dEnd = toDepletion(o.moistureEndPct);
    if (dStart === null || dEnd === null) continue;
    used += 1;

    // Measured depletion change over the day.
    const measuredDelta = dEnd - dStart; // + = drier
    // Modeled depletion change WITHOUT irrigation = ETc - rain. We do not know
    // ETc here (that's what we calibrate), so use ET0 as the driver and solve
    // for the Kc factor that explains the *no-irrigation* portion.
    const modeledDryingNoKc = o.et0Mm - o.rainMm; // mm at Kc=1
    const irrig = Math.max(0, o.irrigationMm);

    // On non-watering days, calibrate Kc: measuredDelta ≈ kc*ET0 - rain.
    if (irrig < 0.5) {
      if (modeledDryingNoKc > 0.5) {
        const impliedKc = (measuredDelta + o.rainMm) / Math.max(0.5, o.et0Mm);
        const sample = clamp(impliedKc, KC_FACTOR_MIN, KC_FACTOR_MAX);
        kcFactor = ewma(kcFactor, sample);
      }
      if (measuredDelta > 0) dryDowns.push(measuredDelta);
    } else {
      // Watering day: calibrate precip-rate. Expected moisture rise (mm) from
      // applied depth, after subtracting the day's drying.
      wateringDays += 1;
      const measuredRise = -measuredDelta + Math.max(0, modeledDryingNoKc * kcFactor);
      if (irrig > 1 && measuredRise > 0.3) {
        const impliedFactor = measuredRise / irrig;
        const sample = clamp(impliedFactor, PRECIP_FACTOR_MIN, PRECIP_FACTOR_MAX);
        precipFactor = ewma(precipFactor, sample);
      } else if (irrig > 3 && measuredRise <= 0.3) {
        // Significant water applied but no moisture response → suspect fault.
        faultDays += 1;
      }
    }
  }

  if (used === 0) return NEUTRAL_MODEL;

  const emitterFault = wateringDays >= 2 && faultDays >= Math.ceil(wateringDays / 2);
  const avgDryDown =
    dryDowns.length > 0
      ? Math.round((dryDowns.reduce((a, b) => a + b, 0) / dryDowns.length) * 100) / 100
      : null;

  const note = emitterFault
    ? 'Warnung: Wassergabe ohne Feuchteanstieg – Emitter prüfen.'
    : `Kalibriert über ${used} Tag(e).`;

  return {
    kcFactor: round2(kcFactor),
    precipRateFactor: round2(precipFactor),
    sampleDays: used,
    emitterFault,
    avgDryDownMmPerDay: avgDryDown,
    note,
  };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
