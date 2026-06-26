/**
 * Property-based tests for the day-to-day shading learner (learning module).
 */

import fc from 'fast-check';
import { describe, it, expect } from 'vitest';

import {
  learnRoomModel,
  type DailyObservation,
} from '../../src/plugin/engine/learning/shadeLearner.js';

const WARNING_C = 25;

function obsArb(): fc.Arbitrary<DailyObservation> {
  return fc.record({
    date: fc
      .integer({ min: Date.UTC(2026, 5, 1), max: Date.UTC(2026, 7, 31) })
      .map((ms) => new Date(ms).toISOString().slice(0, 10)),
    roomId: fc.constant('r1'),
    indoorPeakC: fc.oneof(fc.constant(null), fc.double({ min: 18, max: 38, noNaN: true })),
    outdoorMaxC: fc.oneof(fc.constant(null), fc.double({ min: 10, max: 40, noNaN: true })),
    forecastMaxC: fc.oneof(fc.constant(null), fc.double({ min: 10, max: 40, noNaN: true })),
    pvPeakKw: fc.oneof(fc.constant(null), fc.double({ min: 0, max: 9, noNaN: true })),
    moves: fc.integer({ min: 0, max: 10 }),
  });
}

function mkObs(p: Partial<DailyObservation> & { date: string }): DailyObservation {
  return {
    roomId: 'r1',
    indoorPeakC: null,
    outdoorMaxC: null,
    forecastMaxC: null,
    pvPeakKw: null,
    moves: 0,
    ...p,
  };
}

describe('shadeLearner', () => {
  it('comfort bias is always within [-1.5, +1.0] and output is well-formed', () => {
    fc.assert(
      fc.property(fc.array(obsArb(), { maxLength: 40 }), (obs) => {
        const m = learnRoomModel('r1', obs, WARNING_C);
        expect(m.comfortBiasC).toBeGreaterThanOrEqual(-1.5);
        expect(m.comfortBiasC).toBeLessThanOrEqual(1.0);
        expect(m.confidence01).toBeGreaterThanOrEqual(0);
        expect(m.confidence01).toBeLessThanOrEqual(1);
        expect(m.recommendation.length).toBeGreaterThan(0);
        expect(m.sampleDays).toBe(obs.slice(-21).length);
      }),
      { numRuns: 300 },
    );
  });

  it('reports insufficient_data with zero bias below the minimum day count', () => {
    const obs = [
      mkObs({ date: '2026-07-01', indoorPeakC: 30, forecastMaxC: 32 }),
      mkObs({ date: '2026-07-02', indoorPeakC: 30, forecastMaxC: 32 }),
    ];
    const m = learnRoomModel('r1', obs, WARNING_C);
    expect(m.recommendationLevel).toBe('insufficient_data');
    expect(m.comfortBiasC).toBe(0);
  });

  it('recommends shading earlier (negative bias) when the room runs hot on hot days', () => {
    const obs = [1, 2, 3, 4, 5].map((d) =>
      mkObs({
        date: `2026-07-0${d}`,
        indoorPeakC: 27.5, // 2.5 K over warning
        forecastMaxC: 31,
        outdoorMaxC: 30,
      }),
    );
    const m = learnRoomModel('r1', obs, WARNING_C);
    expect(m.recommendationLevel).toBe('shade_earlier');
    expect(m.comfortBiasC).toBeLessThan(0);
  });

  it('allows more light (positive bias) when the room stays well below comfort on hot days', () => {
    const obs = [1, 2, 3, 4, 5].map((d) =>
      mkObs({
        date: `2026-07-0${d}`,
        indoorPeakC: 22, // 3 K under warning
        forecastMaxC: 31,
        outdoorMaxC: 33,
      }),
    );
    const m = learnRoomModel('r1', obs, WARNING_C);
    expect(m.recommendationLevel).toBe('allow_more_light');
    expect(m.comfortBiasC).toBeGreaterThan(0);
  });

  it('is deterministic for identical input', () => {
    const obs = [1, 2, 3].map((d) =>
      mkObs({ date: `2026-07-0${d}`, indoorPeakC: 26, forecastMaxC: 30 }),
    );
    expect(learnRoomModel('r1', obs, WARNING_C)).toEqual(learnRoomModel('r1', obs, WARNING_C));
  });
});
