/**
 * Unit tests for the live PV cloud nowcast (predictive-control-dashboard,
 * "zweiter Hebel"). Verifies that PV is only used as a cloud probe when the
 * sun is on the array, and that the cloud factor tracks PV vs. clear-sky.
 */

import { describe, it, expect } from 'vitest';

import {
  computeCloudNowcast,
  computeLuxCloudNowcast,
  clearSkyPvFraction,
  clearSkyIlluminanceLux,
  arrayAzimuthFromHint,
  type SunLike,
} from '../../src/plugin/engine/forecast/nowcast.js';

const PEAK = 8.8;
const SE = arrayAzimuthFromHint('southeast'); // 135°

/** Sun on the SE array, high in the sky. */
const sunOnArray: SunLike = { azimuthDeg: 135, elevationDeg: 55, isUp: true };
/** Sun in the west, low — off a SE array. */
const sunOffArray: SunLike = { azimuthDeg: 276, elevationDeg: 25, isUp: true };
const sunDown: SunLike = { azimuthDeg: 0, elevationDeg: -5, isUp: false };

describe('arrayAzimuthFromHint', () => {
  it('maps hints to centre azimuths', () => {
    expect(arrayAzimuthFromHint('east')).toBe(90);
    expect(arrayAzimuthFromHint('southeast')).toBe(135);
    expect(arrayAzimuthFromHint('south')).toBe(180);
    expect(arrayAzimuthFromHint('southwest')).toBe(225);
    expect(arrayAzimuthFromHint('west')).toBe(270);
    expect(arrayAzimuthFromHint('mixed')).toBe(180);
  });
});

describe('clearSkyPvFraction', () => {
  it('is zero when the sun is down', () => {
    expect(clearSkyPvFraction(sunDown, SE)).toBe(0);
  });
  it('is high when the sun is on the array and high', () => {
    expect(clearSkyPvFraction(sunOnArray, SE)).toBeGreaterThan(0.4);
  });
  it('is low when the sun is far off the array', () => {
    expect(clearSkyPvFraction(sunOffArray, SE)).toBeLessThan(0.15);
  });
});

describe('computeCloudNowcast', () => {
  it('is unreliable (no correction) when the sun is off the array', () => {
    const nc = computeCloudNowcast({
      pvSmoothedKw: 0.4,
      pvPeakKwp: PEAK,
      sun: sunOffArray,
      arrayAzimuthDeg: SE,
    });
    expect(nc.reliable).toBe(false);
    expect(nc.cloudFactor01).toBe(1);
  });

  it('is unreliable when PV is missing', () => {
    const nc = computeCloudNowcast({
      pvSmoothedKw: null,
      pvPeakKwp: PEAK,
      sun: sunOnArray,
      arrayAzimuthDeg: SE,
    });
    expect(nc.reliable).toBe(false);
    expect(nc.cloudFactor01).toBe(1);
  });

  it('reports no clouds when PV matches the clear-sky expectation', () => {
    // Sun on array, high → expected ~0.7*1*sin(55°)=~0.57 of nameplate.
    // PV at ~0.6 of nameplate → factor clamps to 1.
    const nc = computeCloudNowcast({
      pvSmoothedKw: PEAK * 0.6,
      pvPeakKwp: PEAK,
      sun: sunOnArray,
      arrayAzimuthDeg: SE,
    });
    expect(nc.reliable).toBe(true);
    expect(nc.cloudFactor01).toBeGreaterThan(0.9);
  });

  it('damps strongly when PV has collapsed under a clear-sky sun', () => {
    // Sun on array (clear-sky expects ~0.57) but PV is only 0.45 kW → clouds.
    const nc = computeCloudNowcast({
      pvSmoothedKw: 0.45,
      pvPeakKwp: PEAK,
      sun: sunOnArray,
      arrayAzimuthDeg: SE,
    });
    expect(nc.reliable).toBe(true);
    expect(nc.cloudFactor01).toBeLessThan(0.2);
  });
});

describe('clearSkyIlluminanceLux', () => {
  it('is zero when the sun is down', () => {
    expect(clearSkyIlluminanceLux(sunDown)).toBe(0);
  });
  it('rises with sun elevation (independent of azimuth)', () => {
    const low = clearSkyIlluminanceLux({ azimuthDeg: 200, elevationDeg: 15, isUp: true });
    const high = clearSkyIlluminanceLux({ azimuthDeg: 90, elevationDeg: 60, isUp: true });
    expect(high).toBeGreaterThan(low);
    expect(high).toBeGreaterThan(80_000);
  });
});

describe('computeLuxCloudNowcast (global light sensor)', () => {
  const sunHigh: SunLike = { azimuthDeg: 180, elevationDeg: 55, isUp: true };

  it('is unreliable when no lux is available', () => {
    const nc = computeLuxCloudNowcast({ illuminanceLux: null, sun: sunHigh });
    expect(nc.reliable).toBe(false);
    expect(nc.cloudFactor01).toBe(1);
  });

  it('is unreliable when the sun is too low to read', () => {
    const nc = computeLuxCloudNowcast({ illuminanceLux: 20_000, sun: sunDown });
    expect(nc.reliable).toBe(false);
    expect(nc.cloudFactor01).toBe(1);
  });

  it('reports clear sky when measured lux ~ clear-sky expectation', () => {
    const expected = clearSkyIlluminanceLux(sunHigh);
    const nc = computeLuxCloudNowcast({ illuminanceLux: expected, sun: sunHigh });
    expect(nc.reliable).toBe(true);
    expect(nc.cloudFactor01).toBeGreaterThan(0.9);
  });

  it('damps strongly when measured lux collapses under a clear-sky sun', () => {
    const expected = clearSkyIlluminanceLux(sunHigh);
    const nc = computeLuxCloudNowcast({ illuminanceLux: expected * 0.1, sun: sunHigh });
    expect(nc.reliable).toBe(true);
    expect(nc.cloudFactor01).toBeLessThan(0.2);
  });

  it('does NOT depend on the PV array orientation (works with any azimuth)', () => {
    const west: SunLike = { azimuthDeg: 276, elevationDeg: 40, isUp: true };
    const nc = computeLuxCloudNowcast({ illuminanceLux: clearSkyIlluminanceLux(west), sun: west });
    expect(nc.reliable).toBe(true);
  });
});
