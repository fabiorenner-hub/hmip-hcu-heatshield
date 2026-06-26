/**
 * Property-based tests for the ventilation-advice engine (Lüftung module / C1).
 */

import fc from 'fast-check';
import { describe, it, expect } from 'vitest';

import {
  ventilationAdvice,
  type VentAdviceInputs,
  type VentAdviceLevel,
} from '../../src/plugin/engine/ventilationAdvice.js';

const LEVELS: ReadonlySet<VentAdviceLevel> = new Set([
  'air_now',
  'air_possible',
  'close_window',
  'keep_closed',
  'neutral',
]);

function inputArb(): fc.Arbitrary<VentAdviceInputs> {
  return fc.record({
    sunIsUp: fc.boolean(),
    indoorTempC: fc.oneof(fc.constant(null), fc.double({ min: 10, max: 38, noNaN: true })),
    outdoorTempC: fc.oneof(fc.constant(null), fc.double({ min: -5, max: 40, noNaN: true })),
    deltaC: fc.double({ min: 0.5, max: 4, noNaN: true }),
    comfortMaxC: fc.double({ min: 22, max: 27, noNaN: true }),
    heatModeActive: fc.boolean(),
    windowOpen: fc.boolean(),
  });
}

describe('ventilationAdvice', () => {
  it('always returns a valid level with non-empty German text', () => {
    fc.assert(
      fc.property(inputArb(), (inp) => {
        const a = ventilationAdvice(inp);
        expect(LEVELS.has(a.level)).toBe(true);
        expect(a.headline.length).toBeGreaterThan(0);
        expect(a.detail.length).toBeGreaterThan(0);
      }),
      { numRuns: 300 },
    );
  });

  it('recommends closing an open window when it is not cooler outside', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 18, max: 30, noNaN: true }),
        fc.double({ min: 0, max: 8, noNaN: true }),
        (indoor, warmer) => {
          const a = ventilationAdvice({
            sunIsUp: true,
            indoorTempC: indoor,
            outdoorTempC: indoor + warmer, // outside >= inside
            deltaC: 1.5,
            comfortMaxC: 25,
            heatModeActive: true,
            windowOpen: true,
          });
          expect(a.level).toBe('close_window');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('recommends airing now when sun is down, much cooler outside, and room is hot', () => {
    const a = ventilationAdvice({
      sunIsUp: false,
      indoorTempC: 27,
      outdoorTempC: 19,
      deltaC: 1.5,
      comfortMaxC: 25,
      heatModeActive: true,
      windowOpen: false,
    });
    expect(a.level).toBe('air_now');
  });

  it('keeps closed during heat when outside is not cooler', () => {
    const a = ventilationAdvice({
      sunIsUp: true,
      indoorTempC: 26,
      outdoorTempC: 25.5,
      deltaC: 1.5,
      comfortMaxC: 25,
      heatModeActive: true,
      windowOpen: false,
    });
    expect(a.level).toBe('keep_closed');
  });

  it('is neutral when temperatures are unknown and no heat-mode window is open', () => {
    const a = ventilationAdvice({
      sunIsUp: true,
      indoorTempC: null,
      outdoorTempC: null,
      deltaC: 1.5,
      comfortMaxC: 25,
      heatModeActive: false,
      windowOpen: false,
    });
    expect(a.level).toBe('neutral');
  });
});
