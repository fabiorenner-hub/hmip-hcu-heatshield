/**
 * Heat Shield — live PV cloud nowcast
 * (predictive-control-dashboard, "zweiter Hebel").
 *
 * Pure, deterministic. The OpenMeteo radiation forecast lags the real sky:
 * a cloud bank can collapse PV output minutes before the forecast curve
 * reflects it. The only LIVE solar signal we have is PV power. This module
 * turns it into a near-term cloudiness multiplier on the forecast radiation,
 * but ONLY when the sun is actually on the PV array — otherwise low PV is
 * expected geometry (e.g. a south-east array in the late-afternoon west sun)
 * and tells us nothing about clouds.
 *
 * Usage: the planner damps the near-term forecast radiation by `cloudFactor01`
 * (fading back to the raw forecast over a couple of hours) so the trajectory
 * "sees" the current sky. No fs, no I/O.
 */

import { circularAngleDiff } from '../sun.js';

export interface SunLike {
  readonly azimuthDeg: number;
  readonly elevationDeg: number;
  readonly isUp: boolean;
}

export interface CloudNowcast {
  /** Live cloudiness multiplier on radiation in [0,1]; 1 = clear/no damping. */
  readonly cloudFactor01: number;
  /**
   * Whether PV could actually estimate cloudiness this cycle (sun high enough
   * AND sufficiently aligned with the array). When `false`, callers must NOT
   * apply any correction and fall back to the raw forecast.
   */
  readonly reliable: boolean;
  /** Clear-sky expected PV fraction of nameplate at the current geometry. */
  readonly expectedFraction01: number;
}

/** Sun must be at least this high for PV to be a usable cloud probe. */
const MIN_ELEVATION_DEG = 8;
/**
 * Best realistic PV fraction of nameplate under ideal alignment + high sun.
 * Real arrays never reach 1.0 (temperature derating, inverter losses, AOI),
 * so we calibrate the geometric expectation down by this factor to avoid
 * falsely flagging clouds on a clear day.
 */
const PANEL_PEAK_EFFICIENCY = 0.7;
/**
 * Minimum expected fraction for the nowcast to be reliable. Below this the
 * sun is too low or too far off the array to read clouds from PV.
 */
const MIN_EXPECTED_FRACTION = 0.1;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Map the configured PV array orientation hint to a centre azimuth (deg). */
export function arrayAzimuthFromHint(hint: string): number {
  switch (hint) {
    case 'east':
      return 90;
    case 'southeast':
      return 135;
    case 'southwest':
      return 225;
    case 'west':
      return 270;
    case 'south':
    case 'mixed':
    default:
      return 180;
  }
}

/**
 * Expected clear-sky PV output as a fraction of nameplate [0,1] at the current
 * sun geometry relative to the array azimuth. Combines azimuth alignment
 * (within ±90° of the array normal) with the sine of the sun elevation, scaled
 * by {@link PANEL_PEAK_EFFICIENCY}.
 */
export function clearSkyPvFraction(sun: SunLike, arrayAzimuthDeg: number): number {
  if (!sun.isUp || sun.elevationDeg < MIN_ELEVATION_DEG) {
    return 0;
  }
  const align = clamp01(1 - circularAngleDiff(sun.azimuthDeg, arrayAzimuthDeg) / 90);
  const elev = Math.sin((sun.elevationDeg * Math.PI) / 180);
  return clamp01(PANEL_PEAK_EFFICIENCY * align * Math.max(0, elev));
}

/**
 * Estimate live cloudiness from PV vs. the clear-sky expectation.
 *
 * `cloudFactor01 = clamp01(actualRatio / expectedFraction)` — 1 means PV is at
 * or above the clear-sky expectation (no clouds), values toward 0 mean PV is
 * far below what the geometry predicts (heavy cloud). Unreliable (→ factor 1)
 * whenever the sun is too low/off-array to read.
 */
export function computeCloudNowcast(inputs: {
  pvSmoothedKw: number | null;
  pvPeakKwp: number;
  sun: SunLike;
  arrayAzimuthDeg: number;
}): CloudNowcast {
  const expectedFraction01 = clearSkyPvFraction(inputs.sun, inputs.arrayAzimuthDeg);
  if (
    inputs.pvSmoothedKw === null ||
    inputs.pvPeakKwp <= 0 ||
    expectedFraction01 < MIN_EXPECTED_FRACTION
  ) {
    return { cloudFactor01: 1, reliable: false, expectedFraction01 };
  }
  const actualRatio = clamp01(inputs.pvSmoothedKw / inputs.pvPeakKwp);
  const cloudFactor01 = clamp01(actualRatio / expectedFraction01);
  return { cloudFactor01, reliable: true, expectedFraction01 };
}
