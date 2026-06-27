/**
 * Heat Shield — self-learning PV array azimuth from the power curve.
 *
 * Pure, deterministic. The shape of the daily PV-power curve encodes the
 * array's orientation: an east array peaks in the morning, south at solar
 * noon, west in the afternoon. We don't need the peak time explicitly — the
 * POWER-WEIGHTED CIRCULAR MEAN of the sun azimuth across all daytime samples
 * lands on the array azimuth, because most energy is produced while the sun
 * faces the panels.
 *
 * Accumulate `pvKw × unitVector(sunAzimuth)` each cycle; the running resultant
 * vector's angle is the learned azimuth and its normalized length is a
 * concentration/confidence. Over many days, morning/afternoon cloud asymmetry
 * averages out. The manual `orientationHint` stays the fallback until the
 * estimate is confident.
 *
 * No fs, no I/O, no logging — the caller persists {@link PvOrientationState}.
 */

export interface PvOrientationState {
  /** Σ weight·sin(azimuth). */
  readonly sumSin: number;
  /** Σ weight·cos(azimuth). */
  readonly sumCos: number;
  /** Σ weight (total PV energy proxy fed in). */
  readonly sumWeight: number;
  /** Number of samples accumulated. */
  readonly samples: number;
}

export interface PvOrientationSample {
  readonly sunAzimuthDeg: number;
  readonly sunElevationDeg: number;
  readonly sunIsUp: boolean;
  readonly pvKw: number | null;
}

export interface PvOrientationEstimate {
  /** Learned array azimuth in [0,360). */
  readonly azimuthDeg: number;
  /** Concentration of the weighted mean in [0,1] (higher = more consistent). */
  readonly confidence01: number;
  readonly samples: number;
}

export interface PvOrientationOptions {
  /** Sun must be at least this high for a sample to count (deg). */
  readonly minElevationDeg?: number;
  /** PV must be at least this high for a sample to count (kW). */
  readonly minPvKw?: number;
  /** Minimum samples before an estimate is offered. */
  readonly minSamples?: number;
  /** Minimum concentration before an estimate is offered. */
  readonly minConfidence?: number;
}

const DEFAULTS = {
  minElevationDeg: 8,
  minPvKw: 0.3,
  minSamples: 120,
  minConfidence: 0.2,
} as const;

const RAD = Math.PI / 180;

export function emptyPvOrientationState(): PvOrientationState {
  return { sumSin: 0, sumCos: 0, sumWeight: 0, samples: 0 };
}

/** Normalize a Zod-parsed unknown into a {@link PvOrientationState}. */
export function coercePvOrientationState(v: unknown): PvOrientationState {
  if (v === null || typeof v !== 'object') {
    return emptyPvOrientationState();
  }
  const o = v as Record<string, unknown>;
  const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
  return {
    sumSin: num(o['sumSin']),
    sumCos: num(o['sumCos']),
    sumWeight: num(o['sumWeight']),
    samples: Math.max(0, Math.floor(num(o['samples']))),
  };
}

/**
 * Fold one cycle's (sun, PV) sample into the accumulator. Samples below the
 * elevation/PV floors (or with the sun down / PV missing) are ignored and the
 * state is returned unchanged. Weight = PV power, so the production peak — and
 * thus the array azimuth — dominates the resultant.
 */
export function accumulatePvOrientation(
  state: PvOrientationState,
  sample: PvOrientationSample,
  options?: PvOrientationOptions,
): PvOrientationState {
  const minElevationDeg = options?.minElevationDeg ?? DEFAULTS.minElevationDeg;
  const minPvKw = options?.minPvKw ?? DEFAULTS.minPvKw;
  if (
    !sample.sunIsUp ||
    sample.sunElevationDeg < minElevationDeg ||
    sample.pvKw === null ||
    sample.pvKw < minPvKw
  ) {
    return state;
  }
  const az = sample.sunAzimuthDeg * RAD;
  // Normalize out the solar-intensity envelope: raw PV is highest near solar
  // noon regardless of which way the array faces, which would bias the
  // weighted mean toward south. Dividing by sin(elevation) isolates the
  // azimuthal (angle-of-incidence) response so the resultant points at the
  // array. Floored so low-sun samples don't explode the weight.
  const sinElev = Math.sin(sample.sunElevationDeg * RAD);
  const w = sample.pvKw / Math.max(sinElev, 0.25);
  return {
    sumSin: state.sumSin + w * Math.sin(az),
    sumCos: state.sumCos + w * Math.cos(az),
    sumWeight: state.sumWeight + w,
    samples: state.samples + 1,
  };
}

/**
 * Derive the learned azimuth + confidence, or `null` when not yet confident.
 */
export function estimatePvOrientation(
  state: PvOrientationState,
  options?: PvOrientationOptions,
): PvOrientationEstimate | null {
  const minSamples = options?.minSamples ?? DEFAULTS.minSamples;
  const minConfidence = options?.minConfidence ?? DEFAULTS.minConfidence;
  if (state.samples < minSamples || state.sumWeight <= 0) {
    return null;
  }
  const r = Math.hypot(state.sumSin, state.sumCos);
  const confidence01 = Math.min(1, r / state.sumWeight);
  if (confidence01 < minConfidence) {
    return null;
  }
  const azimuthDeg = ((Math.atan2(state.sumSin, state.sumCos) / RAD) % 360 + 360) % 360;
  return { azimuthDeg, confidence01, samples: state.samples };
}
