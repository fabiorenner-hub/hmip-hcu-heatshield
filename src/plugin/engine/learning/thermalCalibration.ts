/**
 * Heat Shield — thermal self-calibration (learning module, V1.1).
 *
 * Pure, deterministic. The Forecast_Planner models each room as a discrete RC
 * system whose time-constant is `thermalInertiaMinutes`. That configured value
 * is only a guess; the real room responds faster or slower depending on
 * glazing, mass and insulation. This module closes the loop:
 *
 *   - Each day we record the room's ACTUAL indoor peak and the PREDICTED peak
 *     the model expected that morning (max indoor temp over the day's
 *     trajectory).
 *   - Over a window of days we take the mean error `actual − predicted`:
 *       error > 0  → the room ran HOTTER than the model predicted → it reacts
 *                    FASTER than modelled → LOWER the inertia (smaller τ).
 *       error < 0  → the room stayed COOLER than predicted → it is more
 *                    sluggish → RAISE the inertia.
 *   - The correction is a bounded multiplier on the configured inertia, nudged
 *     slowly and clamped, so a single noisy day can never destabilise control.
 *
 * The result feeds back into the planner as a per-room inertia override, which
 * makes the 12 h forecasts (and therefore the move-minimising plan) more
 * accurate over time. Cooling/safety/hysteresis remain owned by the engine;
 * this only sharpens the prediction.
 *
 * Module rules: pure, no fs/logging/Connect artefacts/globals; strict TS, ESM.
 */

/** One day's prediction-accuracy record for a single room. */
export interface CalibrationObservation {
  /** Local calendar day, `YYYY-MM-DD`. */
  readonly date: string;
  readonly roomId: string;
  /** Highest indoor temperature actually observed that day (°C), or null. */
  readonly actualPeakC: number | null;
  /** Highest indoor temperature the model predicted that day (°C), or null. */
  readonly predictedPeakC: number | null;
}

export interface CalibratedRoom {
  readonly roomId: string;
  readonly sampleDays: number;
  /** Mean (actual − predicted) peak over the window, or null. */
  readonly meanErrorC: number | null;
  /** Bounded inertia multiplier applied to the configured value. */
  readonly factor: number;
  /** Calibrated thermal inertia in minutes (configured × factor, clamped). */
  readonly inertiaMinutes: number;
  readonly confidence01: number;
  readonly note: string;
}

export interface CalibrateOptions {
  /** Minimum sample days before any correction is applied. Default 4. */
  readonly minDays?: number;
  /** Most-recent days to weigh. Default 14. */
  readonly windowDays?: number;
  /** Error magnitude (K) below which the model counts as "good". Default 0.5. */
  readonly deadbandC?: number;
  /** Multiplier change per K of error. Default 0.06. */
  readonly gainPerC?: number;
  /** Lower / upper bound on the inertia multiplier. Default 0.5 / 2.0. */
  readonly minFactor?: number;
  readonly maxFactor?: number;
  /** Hard clamp on the resulting inertia (minutes). Default 30 / 600. */
  readonly minInertiaMinutes?: number;
  readonly maxInertiaMinutes?: number;
}

function mean(values: ReadonlyArray<number>): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Derive the calibrated thermal inertia for one room from its prediction-error
 * history. `baseInertiaMinutes` is the configured value to correct.
 */
export function calibrateRoomInertia(
  roomId: string,
  baseInertiaMinutes: number,
  observations: ReadonlyArray<CalibrationObservation>,
  opts: CalibrateOptions = {},
): CalibratedRoom {
  const minDays = opts.minDays ?? 4;
  const windowDays = opts.windowDays ?? 14;
  const deadbandC = opts.deadbandC ?? 0.5;
  const gainPerC = opts.gainPerC ?? 0.06;
  const minFactor = opts.minFactor ?? 0.5;
  const maxFactor = opts.maxFactor ?? 2.0;
  const minInertia = opts.minInertiaMinutes ?? 30;
  const maxInertia = opts.maxInertiaMinutes ?? 600;

  const base = clamp(
    Number.isFinite(baseInertiaMinutes) ? baseInertiaMinutes : 120,
    minInertia,
    maxInertia,
  );

  const recent = observations.slice(-windowDays);
  const errors = recent
    .filter(
      (o) =>
        o.actualPeakC !== null &&
        Number.isFinite(o.actualPeakC) &&
        o.predictedPeakC !== null &&
        Number.isFinite(o.predictedPeakC),
    )
    .map((o) => (o.actualPeakC as number) - (o.predictedPeakC as number));
  const sampleDays = errors.length;
  const meanErrorC = mean(errors);
  const confidence01 = Math.round(Math.min(1, sampleDays / 10) * 100) / 100;

  if (sampleDays < minDays || meanErrorC === null) {
    return {
      roomId,
      sampleDays,
      meanErrorC: meanErrorC !== null ? round1(meanErrorC) : null,
      factor: 1,
      inertiaMinutes: Math.round(base),
      confidence01,
      note: `Noch zu wenig Daten (${sampleDays} ${
        sampleDays === 1 ? 'Tag' : 'Tage'
      }) für eine Kalibrierung.`,
    };
  }

  if (Math.abs(meanErrorC) <= deadbandC) {
    return {
      roomId,
      sampleDays,
      meanErrorC: round1(meanErrorC),
      factor: 1,
      inertiaMinutes: Math.round(base),
      confidence01,
      note: `Modell trifft gut (Abweichung ${round1(meanErrorC)} K) – keine Korrektur.`,
    };
  }

  const factor = clamp(1 - gainPerC * meanErrorC, minFactor, maxFactor);
  const inertiaMinutes = Math.round(clamp(base * factor, minInertia, maxInertia));
  const note =
    meanErrorC > 0
      ? `Raum reagierte ${round1(meanErrorC)} K wärmer als vorhergesagt – Trägheit auf ${inertiaMinutes} min gesenkt (reagiert schneller).`
      : `Raum blieb ${round1(-meanErrorC)} K kühler als vorhergesagt – Trägheit auf ${inertiaMinutes} min erhöht (träger).`;

  return {
    roomId,
    sampleDays,
    meanErrorC: round1(meanErrorC),
    factor: Math.round(factor * 100) / 100,
    inertiaMinutes,
    confidence01,
    note,
  };
}
