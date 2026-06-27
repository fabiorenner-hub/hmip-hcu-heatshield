/**
 * Unit tests for the self-learning PV array azimuth (from the power curve).
 * A synthetic clear-sky day is fed in: PV peaks when the sun faces the array,
 * so the power-weighted circular mean must land on the array azimuth.
 */

import { describe, it, expect } from 'vitest';

import {
  accumulatePvOrientation,
  estimatePvOrientation,
  emptyPvOrientationState,
  coercePvOrientationState,
  type PvOrientationSample,
} from '../../src/plugin/engine/learning/pvOrientation.js';

/**
 * Simulate one clear day. The sun sweeps 90°→270° (E→S→W) while elevation
 * arcs up to a noon peak. PV output follows the cosine of the angle between
 * the sun and the array, so the production peak sits at `arrayAz`.
 */
function simulateDay(arrayAz: number, peakKw = 8): PvOrientationSample[] {
  const out: PvOrientationSample[] = [];
  for (let i = 0; i <= 60; i += 1) {
    const frac = i / 60; // 0..1 across the daylight span
    const sunAz = 60 + frac * 240; // 60 (ENE) → 300 (WNW), symmetric around 180
    const elev = Math.sin(frac * Math.PI) * 60; // 0 → 60 → 0
    const misalign = Math.abs(sunAz - arrayAz);
    const aoi = Math.cos((misalign * Math.PI) / 180);
    const pvKw = Math.max(0, peakKw * Math.max(0, aoi) * Math.sin((elev * Math.PI) / 180));
    out.push({ sunAzimuthDeg: sunAz, sunElevationDeg: elev, sunIsUp: elev > 0, pvKw });
  }
  return out;
}

function learnDays(arrayAz: number, days: number) {
  let state = emptyPvOrientationState();
  for (let d = 0; d < days; d += 1) {
    for (const s of simulateDay(arrayAz)) {
      state = accumulatePvOrientation(state, s);
    }
  }
  return state;
}

describe('pvOrientation learner', () => {
  it('learns a south-facing array (~180°)', () => {
    const est = estimatePvOrientation(learnDays(180, 4));
    expect(est).not.toBeNull();
    expect(Math.abs(est!.azimuthDeg - 180)).toBeLessThan(8);
  });

  it('learns a south-east array (~135°)', () => {
    const est = estimatePvOrientation(learnDays(135, 4));
    expect(est).not.toBeNull();
    // The power curve only approximates azimuth (intensity envelope biases
    // toward south); ±20° is plenty to gate nowcast reliability.
    expect(Math.abs(est!.azimuthDeg - 135)).toBeLessThan(20);
  });

  it('learns a west-ish array (~250°)', () => {
    const est = estimatePvOrientation(learnDays(250, 4));
    expect(est).not.toBeNull();
    expect(Math.abs(est!.azimuthDeg - 250)).toBeLessThan(20);
  });

  it('returns null before enough samples are gathered', () => {
    let state = emptyPvOrientationState();
    for (const s of simulateDay(180).slice(0, 10)) {
      state = accumulatePvOrientation(state, s);
    }
    expect(estimatePvOrientation(state)).toBeNull();
  });

  it('ignores night and low-PV samples', () => {
    const before = emptyPvOrientationState();
    const after = accumulatePvOrientation(before, {
      sunAzimuthDeg: 180,
      sunElevationDeg: -5,
      sunIsUp: false,
      pvKw: 0,
    });
    expect(after).toBe(before);
    const after2 = accumulatePvOrientation(before, {
      sunAzimuthDeg: 180,
      sunElevationDeg: 40,
      sunIsUp: true,
      pvKw: 0.1, // below the 0.3 kW floor
    });
    expect(after2).toBe(before);
  });

  it('coerces malformed persisted state to empty', () => {
    expect(coercePvOrientationState(null)).toEqual(emptyPvOrientationState());
    expect(coercePvOrientationState({ sumSin: 'x' })).toEqual(emptyPvOrientationState());
  });
});
