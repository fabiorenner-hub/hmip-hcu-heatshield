/**
 * Heat Shield — day-to-day shading learner (catalog C5 / learning module).
 *
 * Pure, deterministic: same inputs → same output (property-testable). Given a
 * room's recent daily observations it derives a small, bounded "learned model"
 * that the planner uses to improve shading over days:
 *
 *   - It measures how the room's indoor peak compared to its comfort ceiling
 *     on hot days (`avgOvershootC`).
 *   - From that it derives a **bounded comfort bias** (`comfortBiasC`) that the
 *     Forecast_Planner adds to the room's upper comfort bound:
 *       - room overheats on hot days  → negative bias → shade earlier/harder.
 *       - room stays well below comfort on hot days → positive bias → allow
 *         more light (shade later), serving "so viel Licht wie möglich".
 *   - It tracks `avgMovesPerDay` so the UI can show whether the goal of few
 *     movements is met.
 *
 * The bias is intentionally small and clamped so a noisy day can never swing
 * the control hard; it only nudges the threshold a fraction of a Kelvin per
 * accumulated evidence. Cooling stays the priority: the negative (shade more)
 * side is allowed to move further than the positive (more light) side.
 *
 * Module rules: pure, no fs/logging/Connect artefacts/globals; strict TS, ESM.
 */

/** One day's aggregated observation for a single room. */
export interface DailyObservation {
  /** Local calendar day, `YYYY-MM-DD`. */
  readonly date: string;
  readonly roomId: string;
  /** Highest indoor temperature observed that day (°C), or null. */
  readonly indoorPeakC: number | null;
  /** Highest outdoor temperature observed that day (°C), or null. */
  readonly outdoorMaxC: number | null;
  /** Forecast daily-max temperature seen that day (°C), or null. */
  readonly forecastMaxC: number | null;
  /** Peak PV power observed that day (kW), or null. */
  readonly pvPeakKw: number | null;
  /** Number of automatic shutter moves dispatched in the room that day. */
  readonly moves: number;
}

export type LearnRecommendationLevel =
  | 'shade_earlier'
  | 'allow_more_light'
  | 'balanced'
  | 'insufficient_data';

export interface LearnedRoomModel {
  readonly roomId: string;
  readonly sampleDays: number;
  readonly avgIndoorPeakC: number | null;
  readonly avgOutdoorMaxC: number | null;
  /** Mean (indoorPeak − warning_c) over hot days; >0 = room ran too warm. */
  readonly avgOvershootC: number | null;
  readonly avgMovesPerDay: number;
  /** Bounded comfort-bound bias for the planner, in [−1.5, +1.0] K. */
  readonly comfortBiasC: number;
  readonly confidence01: number;
  readonly recommendationLevel: LearnRecommendationLevel;
  readonly recommendation: string;
}

export interface LearnOptions {
  /** Forecast max (°C) at/above which a day counts as "hot". Default 25. */
  readonly hotForecastC?: number;
  /** Minimum sample days before any bias is applied. Default 3. */
  readonly minDays?: number;
  /** Number of most-recent days to weigh. Default 21. */
  readonly windowDays?: number;
  /** Max negative bias (shade earlier), K. Default 1.5. */
  readonly maxShadeBiasC?: number;
  /** Max positive bias (more light), K. Default 1.0. */
  readonly maxLightBiasC?: number;
}

function mean(values: ReadonlyArray<number>): number | null {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Derive the learned model for one room from its (already room-filtered)
 * daily observations. `warningC` is the room's upper comfort threshold.
 */
export function learnRoomModel(
  roomId: string,
  observations: ReadonlyArray<DailyObservation>,
  warningC: number,
  opts: LearnOptions = {},
): LearnedRoomModel {
  const hotForecastC = opts.hotForecastC ?? 25;
  const minDays = opts.minDays ?? 3;
  const windowDays = opts.windowDays ?? 21;
  const maxShade = opts.maxShadeBiasC ?? 1.5;
  const maxLight = opts.maxLightBiasC ?? 1.0;

  const recent = observations.slice(-windowDays);
  const sampleDays = recent.length;

  const indoorPeaks = recent
    .map((o) => o.indoorPeakC)
    .filter((v): v is number => v !== null && Number.isFinite(v));
  const outdoorMaxes = recent
    .map((o) => o.outdoorMaxC)
    .filter((v): v is number => v !== null && Number.isFinite(v));
  const moves = recent.map((o) => o.moves).filter((v) => Number.isFinite(v));

  const hotDayOvershoots = recent
    .filter(
      (o) =>
        o.forecastMaxC !== null &&
        o.forecastMaxC >= hotForecastC &&
        o.indoorPeakC !== null &&
        Number.isFinite(o.indoorPeakC),
    )
    .map((o) => (o.indoorPeakC as number) - warningC);

  // Solar-gain index: how far the indoor peak runs ABOVE the outdoor max on
  // hot days. A high value means the room gains a lot of heat through its
  // glazing (poor passive resilience) and benefits from anticipatory shading.
  const hotDaySolarGains = recent
    .filter(
      (o) =>
        o.forecastMaxC !== null &&
        o.forecastMaxC >= hotForecastC &&
        o.indoorPeakC !== null &&
        Number.isFinite(o.indoorPeakC) &&
        o.outdoorMaxC !== null &&
        Number.isFinite(o.outdoorMaxC),
    )
    .map((o) => (o.indoorPeakC as number) - (o.outdoorMaxC as number));
  const solarGainIndex = mean(hotDaySolarGains);

  const avgIndoorPeakC = mean(indoorPeaks);
  const avgOutdoorMaxC = mean(outdoorMaxes);
  const avgOvershootC = mean(hotDayOvershoots);
  const avgMovesPerDay = mean(moves) ?? 0;
  const confidence01 = Math.max(0, Math.min(1, sampleDays / 14));

  let comfortBiasC = 0;
  let recommendationLevel: LearnRecommendationLevel = 'balanced';
  let recommendation = 'Beschattung ausgewogen – keine Anpassung nötig.';

  if (sampleDays < minDays || avgOvershootC === null) {
    recommendationLevel = 'insufficient_data';
    recommendation = `Noch zu wenig Daten (${sampleDays} ${
      sampleDays === 1 ? 'Tag' : 'Tage'
    }) für eine Lern-Anpassung.`;
  } else if (avgOvershootC > 0.5) {
    // Anticipatory boost: rooms that gain a lot of heat through glazing
    // (solarGainIndex high, i.e. indoor peak >> outdoor) get up to +0.3 K
    // extra shade-earlier bias, bounded by maxShade. Cooling stays priority.
    const solarBoost =
      solarGainIndex !== null && solarGainIndex > 4
        ? Math.min(0.3, (solarGainIndex - 4) * 0.1)
        : 0;
    comfortBiasC = -Math.min(maxShade, avgOvershootC + solarBoost);
    recommendationLevel = 'shade_earlier';
    recommendation = `Raum lief an heißen Tagen im Schnitt ${round1(
      avgOvershootC,
    )} K über der Komfortgrenze${
      solarBoost > 0 ? ' (hoher solarer Eintrag)' : ''
    } – Beschattung wird ${round1(-comfortBiasC)} K früher ausgelöst.`;
  } else if (avgOvershootC < -2) {
    comfortBiasC = Math.min(maxLight, -avgOvershootC - 2);
    recommendationLevel = 'allow_more_light';
    recommendation = `Raum blieb an heißen Tagen ${round1(
      -avgOvershootC,
    )} K unter der Komfortgrenze – ${round1(
      comfortBiasC,
    )} K mehr Spielraum für Tageslicht.`;
  }

  return {
    roomId,
    sampleDays,
    avgIndoorPeakC: avgIndoorPeakC !== null ? round1(avgIndoorPeakC) : null,
    avgOutdoorMaxC: avgOutdoorMaxC !== null ? round1(avgOutdoorMaxC) : null,
    avgOvershootC: avgOvershootC !== null ? round1(avgOvershootC) : null,
    avgMovesPerDay: round1(avgMovesPerDay),
    comfortBiasC: round1(comfortBiasC),
    confidence01: Math.round(confidence01 * 100) / 100,
    recommendationLevel,
    recommendation,
  };
}
