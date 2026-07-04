/**
 * G6 validation harness (thermal-load-engine, non-normative).
 *
 * Compares a computed hourly result against a reference case using the publicly
 * documented VDI 6020/6007 validation criteria. This is the MECHANISM for G6 —
 * it does NOT by itself grant G6: a reference case only counts once its full
 * official inputs/outputs are captured (from the licensed Datenträger), the
 * engine uses the licensed VDI 6007 R/C parameterisation (G3 `vdi_dynamic_core`,
 * currently NOT approved), and a qualified person approves it.
 *
 * Pure; no I/O, no zod; no fabricated normative values.
 */

/** Publicly documented VDI 6020/6007 validation limits (application to a given
 * regression must be confirmed by the validation owner — kept non-normative). */
export const VDI6020_TOLERANCES = {
  /** |mean temperature deviation| ≤ [K]. */
  meanTempK: 1.0,
  /** |mean load deviation| ≤ [W]. */
  meanLoadW: 50,
  /** std of temperature deviation ≤ [K]. */
  stdTempK: 1.5,
  /** std of load deviation ≤ [W]. */
  stdLoadW: 60,
} as const;

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((s, v) => s + v, 0) / xs.length;
}

/** Sample standard deviation (n-1); 0 for <2 points. */
function stdDev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const varSum = xs.reduce((s, v) => s + (v - m) * (v - m), 0);
  return Math.sqrt(varSum / (xs.length - 1));
}

export interface SeriesDeviation {
  meanDiff: number;
  absMeanDiff: number;
  stdDiff: number;
}

/** Element-wise deviation (actual − expected) statistics over equal-length series. */
export function compareSeries(actual: number[], expected: number[]): SeriesDeviation {
  const n = Math.min(actual.length, expected.length);
  const diff: number[] = [];
  for (let i = 0; i < n; i += 1) diff.push((actual[i] as number) - (expected[i] as number));
  const m = mean(diff);
  return { meanDiff: m, absMeanDiff: Math.abs(m), stdDiff: stdDev(diff) };
}

export interface Vdi6020Result {
  temperature: SeriesDeviation;
  load: SeriesDeviation;
  withinTolerance: boolean;
  breaches: string[];
}

/** Evaluate temperature + load series against the VDI 6020 limits. */
export function evaluateAgainstVdi6020(
  tempActual: number[],
  tempExpected: number[],
  loadActual: number[],
  loadExpected: number[],
): Vdi6020Result {
  const temperature = compareSeries(tempActual, tempExpected);
  const load = compareSeries(loadActual, loadExpected);
  const breaches: string[] = [];
  if (temperature.absMeanDiff > VDI6020_TOLERANCES.meanTempK) breaches.push('meanTempK');
  if (temperature.stdDiff > VDI6020_TOLERANCES.stdTempK) breaches.push('stdTempK');
  if (load.absMeanDiff > VDI6020_TOLERANCES.meanLoadW) breaches.push('meanLoadW');
  if (load.stdDiff > VDI6020_TOLERANCES.stdLoadW) breaches.push('stdLoadW');
  return { temperature, load, withinTolerance: breaches.length === 0, breaches };
}

/**
 * Public summary of the VDI 6007 test example (room S, load/temperature case)
 * as reported by the operator's internet research — a G6 CANDIDATE, status
 * `in_review`. The full hourly boundary/weather columns still require the
 * licensed Datenträger before this can pass/approve.
 */
export const VDI6007_TESTCASE_S = {
  id: 'g6_cooling_load_vdi_2078_6007',
  status: 'in_review' as const,
  setpointC: 27,
  activeHours: [6, 18] as const,
  internalLoadW: 1000,
  expected: {
    maxLoadW: 764,
    minLoadW: -638,
    maxOperativeC: 26.6,
  },
  source: 'Public VDI 6007 test example (research report); pending Datenträger verification',
} as const;
