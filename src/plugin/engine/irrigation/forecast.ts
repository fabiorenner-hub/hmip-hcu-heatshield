/**
 * Heat Shield — irrigation forecast model (pure & testable).
 *
 * Projects a zone's soil-water depletion forward over a horizon using the
 * hourly ET0 + rain forecast and the learned Kc factor, then derives:
 *
 *   - the depletion / available-water trajectory (for charts),
 *   - the ETA until depletion next crosses the RAW trigger (next watering),
 *   - the predicted dose at that point.
 *
 * This is the "forecast model with learning algo": the learned `kcFactor`
 * from {@link ./learn.js} scales the crop demand, so the projection adapts to
 * each zone's observed behaviour rather than using textbook Kc alone.
 */

import { decideZone, type IrrigationMode, modeFactors } from './decision.js';
import {
  clamp,
  defaultKc,
  exposureFactor,
  readilyAvailableWaterMm,
  totalAvailableWaterMm,
} from './soilModel.js';
import { effectiveRainMm, type ZoneProfile } from './waterBalance.js';

export interface ForecastStep {
  /** ISO timestamp (UTC) of the hour. */
  readonly ts: string;
  /** Reference ET for the hour (mm). */
  readonly et0Mm: number;
  /** Gross precipitation for the hour (mm). */
  readonly precipMm: number;
}

export interface ForecastPoint {
  readonly ts: string;
  readonly depletionMm: number;
  readonly availableFraction: number;
}

export interface IrrigationForecast {
  readonly points: readonly ForecastPoint[];
  /** Hours until depletion next reaches RAW, or null if not within horizon. */
  readonly hoursUntilNext: number | null;
  /** ISO timestamp of the predicted next watering, or null. */
  readonly nextWateringTs: string | null;
  /** Predicted dose depth (mm) at the trigger point. */
  readonly nextDepthMm: number | null;
}

/**
 * Project depletion forward. `startDepletionMm` is the current estimate;
 * `kcFactor` comes from the learning loop (1 = neutral). The projection does
 * NOT assume any future irrigation — it answers "when will this zone next
 * need water if we do nothing".
 */
export function forecastZone(
  profile: ZoneProfile,
  startDepletionMm: number,
  steps: readonly ForecastStep[],
  kcFactor = 1,
): IrrigationForecast {
  const taw = totalAvailableWaterMm(profile.soil, profile.rootDepthCm);
  const raw = readilyAvailableWaterMm(profile.soil, profile.rootDepthCm, profile.mad);
  const kcBase = profile.kc > 0 && Number.isFinite(profile.kc) ? profile.kc : defaultKc(profile.plant);
  const kc = kcBase * (Number.isFinite(kcFactor) && kcFactor > 0 ? kcFactor : 1);
  const expF = exposureFactor(profile.exposure);

  let depletion = clamp(startDepletionMm, 0, taw);
  const points: ForecastPoint[] = [];
  let hoursUntilNext: number | null = null;
  let nextTs: string | null = null;
  let nextDepth: number | null = null;

  for (let i = 0; i < steps.length; i += 1) {
    const s = steps[i]!;
    const etc = Math.max(0, s.et0Mm) * kc * expF;
    const rain = effectiveRainMm(s.precipMm);
    depletion = clamp(depletion + etc - rain, 0, taw);
    points.push({
      ts: s.ts,
      depletionMm: round2(depletion),
      availableFraction: taw > 0 ? round2(clamp(1 - depletion / taw, 0, 1)) : 1,
    });
    if (hoursUntilNext === null && depletion >= raw) {
      hoursUntilNext = i + 1;
      nextTs = s.ts;
      nextDepth = round2(depletion);
    }
  }

  return { points, hoursUntilNext, nextWateringTs: nextTs, nextDepthMm: nextDepth };
}

/**
 * Daily water need (mm) for a zone under a mode, from a day's ET0 sum and
 * rainfall — a simple planning figure for the dashboard ("heute ~X mm").
 */
export function dailyNeedMm(
  profile: ZoneProfile,
  et0DayMm: number,
  rainDayMm: number,
  kcFactor: number,
  mode: IrrigationMode,
): number {
  const kcBase = profile.kc > 0 ? profile.kc : defaultKc(profile.plant);
  const etc = Math.max(0, et0DayMm) * kcBase * (kcFactor > 0 ? kcFactor : 1) * exposureFactor(profile.exposure);
  const need = etc - effectiveRainMm(rainDayMm);
  const scaled = need * modeFactors(mode).doseFactor;
  return Math.max(0, round2(scaled));
}

// Re-export so the controller can import everything irrigation-engine from one
// barrel if desired; keeps decideZone available where the forecast is used.
export { decideZone };

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
