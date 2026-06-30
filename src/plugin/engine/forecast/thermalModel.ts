/**
 * Heat Shield — per-room thermal forecast model
 * (predictive-control-dashboard Requirement 2).
 *
 * Pure, deterministic: same inputs → same outputs (property-testable).
 * Produces a trajectory of expected indoor temperature and normalized
 * heat load over the planning horizon, sampled at a fixed time-step.
 *
 * Heat-load model per sample point t:
 *   1. sun = getSunPosition(t, location)              — local, no network.
 *   2. per window: geometric incidence from circularAngleDiff(azimuth,
 *      orientation) and elevation, scaled by glazing area; damped by the
 *      closed fraction of the shutter (currentLevel01 → 1 blocks sun).
 *   3. solar driver = radiation × (1 − k·cloudCover) supported by the PV
 *      plausibility ratio (pv/peak).
 *   4. weighted sum over windows, normalized and CLAMPED to [0, 1].
 *
 * Temperature model (discrete RC / Newton):
 *   T[k+1] = T[k] + (Δt/τ)·((T_out[k] − T[k]) + gain·heatLoad01[k])
 * with τ = thermalInertiaMinutes. Monotone non-decreasing in heatLoad01.
 *
 * No fs, no Connect artifacts, no logging. Injected sun module for tests.
 */

import type { Location, RoomTargets, Window } from '../../../shared/types.js';
import { getSunPosition, circularAngleDiff, type SunPosition } from '../sun.js';

/** Cloud damping coefficient: full overcast removes this fraction of sun. */
const CLOUD_DAMPING_K = 0.75;
/** Heat-load → temperature gain (°C of forcing at full load). */
const TEMP_GAIN_C = 8;
/** Minimum sun elevation (deg) for any solar contribution. */
const MIN_ELEVATION_DEG = 3;
/**
 * Roof windows admit markedly more solar heat than façade windows (glass
 * overhead, near-normal incidence at midday) — the single biggest heat entry
 * point. Boost their effective solar coupling so the planner shades them
 * earlier/harder.
 */
const ROOF_SOLAR_BOOST = 1.3;
/**
 * Diffuse-radiation share that reaches a window regardless of orientation
 * while the sun is up. The direct-beam term is a cosine projection that is
 * ~0 for a facade the sun is not currently on (e.g. an east window in the
 * afternoon) — but on a clear hot day that window still gains heat from
 * diffuse sky radiation. Without this, the planner saw "0 load" for off-sun
 * facades and wrongly opened them in a heatwave.
 */
const DIFFUSE_FRACTION = 0.22;

export interface ThermalWindowInput {
  readonly orientationDeg: number;
  readonly areaM2: number;
  readonly type: Window['type'];
  /** Current shutter position 0=open … 1=closed. */
  readonly currentLevel01: number;
}

export interface ThermalForecastInputs {
  readonly now: Date;
  readonly horizonHours: number; // 1..48
  readonly timeStepMinutes: number; // 5..60
  readonly location: Pick<Location, 'latitude' | 'longitude'>;
  readonly room: {
    readonly id: string;
    readonly thermalInertiaMinutes: number;
    readonly indoorTempC: number | null;
    readonly targets: RoomTargets;
  };
  readonly windows: ReadonlyArray<ThermalWindowInput>;
  readonly outdoorTempC: number | null;
  readonly forecastMaxTempC: number | null;
  readonly cloudCover01: number | null;
  readonly radiationWm2: number | null;
  readonly pvPowerKw: number | null;
  readonly pvPeakKwp: number;
  /** Names of stale/missing required inputs (uncertainty flag). */
  readonly staleInputs: ReadonlySet<string>;
  /** Injectable sun fn for tests; defaults to the real one. */
  readonly sunFn?: (now: Date, loc: Pick<Location, 'latitude' | 'longitude'>) => SunPosition;
  /**
   * Optional per-timestamp weather sampler (predictive-control-dashboard A1/A2).
   * When provided, the model uses the forecast curve (outdoor temp, radiation,
   * cloud cover) at each trajectory point instead of the constant `now` values,
   * so the trajectory correctly "sees" tomorrow's diurnal sun/temperature.
   * Any field returned `null`/`undefined` falls back to the scalar input.
   */
  readonly sampleForecast?: (
    t: Date,
  ) => {
    outdoorTempC?: number | null;
    radiationWm2?: number | null;
    cloudCover01?: number | null;
  };
}

export interface TrajectoryPoint {
  readonly ts: string;
  readonly indoorTempC: number;
  readonly heatLoad01: number;
}

export interface RoomTrajectory {
  readonly roomId: string;
  readonly points: ReadonlyArray<TrajectoryPoint>;
  readonly uncertain: boolean;
  readonly confidence01: number;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Required inputs the model needs; if ALL are missing, no trajectory (2.7). */
function allRequiredMissing(inputs: ThermalForecastInputs): boolean {
  return (
    inputs.outdoorTempC === null &&
    inputs.radiationWm2 === null &&
    inputs.pvPowerKw === null &&
    inputs.forecastMaxTempC === null &&
    inputs.room.indoorTempC === null
  );
}

/** Per-point weather environment used by the heat-load model. */
interface HeatLoadEnv {
  readonly cloudCover01: number | null;
  readonly radiationWm2: number | null;
  readonly pvPowerKw: number | null;
  readonly pvPeakKwp: number;
  readonly windows: ReadonlyArray<ThermalWindowInput>;
}

/** Normalized solar heat load [0,1] for one sample point. */
function heatLoadAt(sun: SunPosition, env: HeatLoadEnv): number {
  if (!sun.isUp || sun.elevationDeg < MIN_ELEVATION_DEG) {
    return 0;
  }
  const cloud = env.cloudCover01 === null ? 0 : clamp01(env.cloudCover01);
  const radiationDriver =
    env.radiationWm2 === null
      ? // Fall back to PV ratio when no radiation signal.
        env.pvPowerKw === null || env.pvPeakKwp <= 0
        ? 0.5
        : clamp01(env.pvPowerKw / env.pvPeakKwp)
      : clamp01(env.radiationWm2 / 1000);
  const pvSupport =
    env.pvPowerKw === null || env.pvPeakKwp <= 0
      ? 1
      : 0.5 + 0.5 * clamp01(env.pvPowerKw / env.pvPeakKwp);
  const solar = radiationDriver * (1 - CLOUD_DAMPING_K * cloud) * pvSupport;

  const elevationTerm = clamp01((sun.elevationDeg - MIN_ELEVATION_DEG) / 35);
  let weighted = 0;
  let areaSum = 0;
  for (const w of env.windows) {
    const angle = circularAngleDiff(sun.azimuthDeg, w.orientationDeg);
    const roofBoost = w.type === 'roof_window' ? ROOF_SOLAR_BOOST : 1;
    const direct = clamp01(1 - angle / 90) * elevationTerm;
    // Direct beam (facade-dependent) + diffuse sky (all facades). Both scale
    // with sun elevation and get the roof boost (overhead glazing sees more).
    const gain = clamp01((direct + DIFFUSE_FRACTION * elevationTerm) * roofBoost);
    const openFactor = 1 - clamp01(w.currentLevel01); // closed shutter blocks
    weighted += w.areaM2 * gain * openFactor;
    areaSum += w.areaM2;
  }
  if (areaSum <= 0) {
    return 0;
  }
  // Normalize by total glazing area so the result is an intensity in [0,1].
  return clamp01(solar * (weighted / areaSum));
}

/**
 * Compute the per-room forecast trajectory. Returns `null` only when ALL
 * required inputs are missing (Requirement 2.7).
 */
export function forecastRoom(
  inputs: ThermalForecastInputs,
): RoomTrajectory | null {
  if (allRequiredMissing(inputs)) {
    return null;
  }
  const sunFn = inputs.sunFn ?? getSunPosition;
  const stepMin = Math.min(60, Math.max(5, Math.round(inputs.timeStepMinutes)));
  const horizonH = Math.min(48, Math.max(1, Math.round(inputs.horizonHours)));
  const stepMs = stepMin * 60_000;
  const count = Math.floor((horizonH * 60) / stepMin) + 1;

  const tau = Math.max(1, inputs.room.thermalInertiaMinutes);
  const dtOverTau = stepMin / tau;
  // Starting indoor temperature: measured, else outdoor, else forecast max.
  let temp =
    inputs.room.indoorTempC ??
    inputs.outdoorTempC ??
    inputs.forecastMaxTempC ??
    20;
  const outBase =
    inputs.outdoorTempC ?? inputs.forecastMaxTempC ?? temp;

  const points: TrajectoryPoint[] = [];
  const startMs = inputs.now.getTime();
  for (let k = 0; k < count; k += 1) {
    const t = new Date(startMs + k * stepMs);
    const sun = sunFn(t, inputs.location);
    // Per-point weather from the forecast curve when a sampler is provided,
    // else the constant `now` values (A1/A2: trajectory now follows the
    // diurnal sun/temperature instead of freezing the current values).
    const sample = inputs.sampleForecast?.(t);
    const radiationWm2 =
      sample?.radiationWm2 !== undefined && sample.radiationWm2 !== null
        ? sample.radiationWm2
        : inputs.radiationWm2;
    const cloudCover01 =
      sample?.cloudCover01 !== undefined && sample.cloudCover01 !== null
        ? sample.cloudCover01
        : inputs.cloudCover01;
    const outAtT =
      sample?.outdoorTempC !== undefined && sample.outdoorTempC !== null
        ? sample.outdoorTempC
        : outBase;
    const load = heatLoadAt(sun, {
      cloudCover01,
      radiationWm2,
      pvPowerKw: inputs.pvPowerKw,
      pvPeakKwp: inputs.pvPeakKwp,
      windows: inputs.windows,
    });
    points.push({
      ts: t.toISOString(),
      indoorTempC: Math.round(temp * 100) / 100,
      heatLoad01: load,
    });
    // Advance temperature towards outdoor + solar forcing.
    temp = temp + dtOverTau * (outAtT - temp + TEMP_GAIN_C * load);
  }

  const uncertain = inputs.staleInputs.size > 0;
  const confidence01 = uncertain ? Math.min(0.5, 0.5) : 0.9;
  return { roomId: inputs.room.id, points, uncertain, confidence01 };
}
