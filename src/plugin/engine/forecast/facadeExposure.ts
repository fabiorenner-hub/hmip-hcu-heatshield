/**
 * Heat Shield — facade exposure, PV-Sonnenindex, and house-asset selection
 * (predictive-control-dashboard Requirements 8.1, 9.3, 12.1).
 *
 * Pure, deterministic functions shared by the dashboard (and backend).
 * No fs, no network: the house-asset manifest is passed in as data.
 */

import { circularAngleDiff, type SunPosition } from '../sun.js';

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Direct-beam availability in [0, 1] from cloud cover: how much DIRECT sun can
 * reach a facade. A shutter only blocks the direct beam — under a fully
 * overcast sky the beam is essentially gone (OpenMeteo direct radiation ~0
 * while diffuse stays high), so shading gives no cooling benefit and only
 * costs daylight. Clear sky (cloud≈0) → 1; full overcast (cloud≈1) → 0.
 * The `^0.7` curve keeps meaningful beam on partly-cloudy days (broken sun)
 * while driving overcast/rainy skies to ~0. Pure, monotone non-increasing.
 */
export function directBeamAvailability01(cloudCover01: number | null | undefined): number {
  const cloud = cloudCover01 === null || cloudCover01 === undefined ? 0 : clamp01(cloudCover01);
  return Math.pow(clamp01(1 - cloud), 0.7);
}

/**
 * Solar exposure of a facade in [0, 1]. 0 when the sun is below the
 * horizon. Driven by how squarely the sun hits the facade
 * (circularAngleDiff) and its elevation, damped by cloud cover and
 * supported by the PV-Sonnenindex (a measure of actually usable sun).
 * Monotone non-increasing in cloud cover.
 */
export function facadeExposure01(
  sun: SunPosition,
  facadeOrientationDeg: number,
  cloudCover01: number,
  pvSunIndex01: number,
): number {
  if (!sun.isUp || sun.elevationDeg <= 0) {
    return 0;
  }
  const angle = circularAngleDiff(sun.azimuthDeg, facadeOrientationDeg);
  // Facades see the sun within ±90°.
  const azimuthTerm = clamp01(1 - angle / 90);
  const elevationTerm = clamp01(sun.elevationDeg / 60);
  const cloud = clamp01(cloudCover01);
  const sunIdx = clamp01(pvSunIndex01);
  const cloudFactor = 1 - 0.7 * cloud;
  const sunSupport = 0.4 + 0.6 * sunIdx;
  return clamp01(azimuthTerm * elevationTerm * cloudFactor * sunSupport);
}

/**
 * Expected clear-sky PV power in kW as a function of sun elevation and the
 * array orientation hint, scaled by installed peak. A simple air-mass-style
 * elevation curve; 0 below the horizon.
 */
export function clearSkyPvKw(
  sun: SunPosition,
  pvPeakKwp: number,
  orientationHint: string,
): number {
  if (!sun.isUp || sun.elevationDeg <= 0) {
    return 0;
  }
  // Elevation curve: sin(elevation) is the first-order irradiance term.
  const elevationFactor = clamp01(Math.sin((sun.elevationDeg * Math.PI) / 180));
  // Orientation alignment: how well the lobe centre matches the sun azimuth.
  const lobeCentreDeg = orientationToAzimuthDeg(orientationHint);
  const align = clamp01(1 - circularAngleDiff(sun.azimuthDeg, lobeCentreDeg) / 120);
  const alignFactor = 0.6 + 0.4 * align;
  return Math.max(0, pvPeakKwp * elevationFactor * alignFactor);
}

function orientationToAzimuthDeg(hint: string): number {
  switch (hint) {
    case 'south':
      return 180;
    case 'southeast':
      return 135;
    case 'southwest':
      return 225;
    case 'east':
      return 90;
    case 'west':
      return 270;
    default:
      return 180; // mixed / unknown → due south
  }
}

/**
 * Normalized PV-Sonnenindex in [0, 1]: current PV power over clear-sky
 * expectation. Monotone non-decreasing in current PV, non-increasing in the
 * clear-sky expectation; 0 when current PV is 0.
 */
export function pvSonnenindex01(currentPvKw: number, clearSky: number): number {
  if (currentPvKw <= 0) {
    return 0;
  }
  const denom = Math.max(clearSky, 0.05);
  return clamp01(currentPvKw / denom);
}
