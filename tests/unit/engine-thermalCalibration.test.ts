/**
 * Heat Shield — thermal self-calibration (V1.1).
 *
 * The calibrator nudges a room's thermal inertia from the accumulated
 * prediction error (actual − predicted indoor peak): hotter-than-predicted
 * lowers inertia, cooler-than-predicted raises it. Bounded + monotone.
 */

import { describe, expect, it } from 'vitest';

import {
  calibrateRoomInertia,
  type CalibrationObservation,
} from '../../src/plugin/engine/learning/thermalCalibration.js';

function days(
  roomId: string,
  actualPeakC: number,
  predictedPeakC: number,
  n = 6,
): CalibrationObservation[] {
  return Array.from({ length: n }, (_, i) => ({
    date: `2026-07-${String(i + 1).padStart(2, '0')}`,
    roomId,
    actualPeakC,
    predictedPeakC,
  }));
}

const BASE = 120;

describe('thermalCalibration — inertia auto-tune', () => {
  it('lowers inertia when the room runs hotter than predicted', () => {
    const r = calibrateRoomInertia('r', BASE, days('r', 30, 25)); // +5 K
    expect(r.meanErrorC).toBe(5);
    expect(r.factor).toBeLessThan(1);
    expect(r.inertiaMinutes).toBeLessThan(BASE);
  });

  it('raises inertia when the room stays cooler than predicted', () => {
    const r = calibrateRoomInertia('r', BASE, days('r', 25, 30)); // -5 K
    expect(r.factor).toBeGreaterThan(1);
    expect(r.inertiaMinutes).toBeGreaterThan(BASE);
  });

  it('leaves inertia unchanged inside the dead-band', () => {
    const r = calibrateRoomInertia('r', BASE, days('r', 25.3, 25)); // +0.3 K
    expect(r.factor).toBe(1);
    expect(r.inertiaMinutes).toBe(BASE);
  });

  it('does not calibrate without enough sample days', () => {
    const r = calibrateRoomInertia('r', BASE, days('r', 30, 25, 2));
    expect(r.factor).toBe(1);
    expect(r.inertiaMinutes).toBe(BASE);
  });

  it('is monotone: larger over-prediction error → lower inertia, and stays clamped', () => {
    const small = calibrateRoomInertia('r', BASE, days('r', 26, 25)); // +1
    const large = calibrateRoomInertia('r', BASE, days('r', 31, 25)); // +6
    expect(large.inertiaMinutes).toBeLessThanOrEqual(small.inertiaMinutes);
    for (const r of [small, large]) {
      expect(r.factor).toBeGreaterThanOrEqual(0.5);
      expect(r.factor).toBeLessThanOrEqual(2.0);
      expect(r.inertiaMinutes).toBeGreaterThanOrEqual(30);
      expect(r.inertiaMinutes).toBeLessThanOrEqual(600);
    }
  });
});
