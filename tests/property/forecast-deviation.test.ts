/**
 * Property-based test for the deviation detector
 * (predictive-control-dashboard). Property 12.
 */

import fc from 'fast-check';
import { describe, it, expect } from 'vitest';

import { detectDeviation } from '../../src/plugin/engine/forecast/deviation.js';

describe('deviation — Property 12', () => {
  // Feature: predictive-control-dashboard, Property 12: Abweichungsdetektor feuert genau jenseits der Toleranz.
  it('exceedsTolerance iff |ΔT|>tolC or |Δload|>tolLoad; deviationC = measured − forecast', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 10, max: 35, noNaN: true }),
        fc.double({ min: 10, max: 35, noNaN: true }),
        fc.double({ min: 0, max: 5, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (measured, forecast, tolC, mLoad, fLoad, tolLoad) => {
          const r = detectDeviation({
            roomId: 'r1',
            measuredIndoorTempC: measured,
            measuredHeatLoad01: mLoad,
            forecastIndoorTempC: forecast,
            forecastHeatLoad01: fLoad,
            toleranceC: tolC,
            toleranceLoad01: tolLoad,
          });
          expect(r.deviationC).toBeCloseTo(measured - forecast, 9);
          const expected =
            Math.abs(measured - forecast) > tolC || Math.abs(mLoad - fLoad) > tolLoad;
          expect(r.exceedsTolerance).toBe(expected);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('null measurement/forecast → null deviation, does not exceed', () => {
    const r = detectDeviation({
      roomId: 'r1',
      measuredIndoorTempC: null,
      measuredHeatLoad01: null,
      forecastIndoorTempC: 24,
      forecastHeatLoad01: 0.5,
      toleranceC: 1.5,
      toleranceLoad01: 0.15,
    });
    expect(r.deviationC).toBeNull();
    expect(r.exceedsTolerance).toBe(false);
  });
});
