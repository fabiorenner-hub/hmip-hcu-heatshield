/**
 * Heat Shield — shade-learner solar-gain refinement (V4).
 *
 * Rooms that run far above the OUTDOOR max on hot days (high solar gain
 * through glazing) should receive a slightly stronger anticipatory shade
 * bias than a room with the same comfort overshoot but low solar gain —
 * while staying within the documented [-1.5, +1.0] K bounds.
 */

import { describe, expect, it } from 'vitest';

import {
  learnRoomModel,
  type DailyObservation,
} from '../../src/plugin/engine/learning/shadeLearner.js';

function hotDays(
  roomId: string,
  indoorPeakC: number,
  outdoorMaxC: number,
  n = 6,
): DailyObservation[] {
  return Array.from({ length: n }, (_, i) => ({
    date: `2026-07-${String(i + 1).padStart(2, '0')}`,
    roomId,
    indoorPeakC,
    outdoorMaxC,
    forecastMaxC: 30,
    pvPeakKw: 6,
    moves: 2,
  }));
}

const WARNING_C = 25;

describe('shadeLearner — solar-gain anticipatory bias', () => {
  it('gives a stronger shade bias to a high-solar-gain room at equal overshoot', () => {
    // Both rooms peak 0.6 K above the comfort ceiling on hot days.
    const lowGain = learnRoomModel('low', hotDays('low', 25.6, 23.6), WARNING_C); // gain 2 K
    const highGain = learnRoomModel('high', hotDays('high', 25.6, 17.6), WARNING_C); // gain 8 K

    expect(lowGain.recommendationLevel).toBe('shade_earlier');
    expect(highGain.recommendationLevel).toBe('shade_earlier');
    // Negative bias = shade earlier; high-gain room shades at least as early.
    expect(highGain.comfortBiasC).toBeLessThan(lowGain.comfortBiasC);
  });

  it('keeps the comfort bias within the documented bounds', () => {
    // Extreme solar gain + large overshoot must still clamp at -1.5 K.
    const extreme = learnRoomModel('x', hotDays('x', 30, 12), WARNING_C);
    expect(extreme.comfortBiasC).toBeGreaterThanOrEqual(-1.5);
    expect(extreme.comfortBiasC).toBeLessThanOrEqual(1.0);
  });
});
