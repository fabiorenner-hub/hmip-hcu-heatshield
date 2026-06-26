/**
 * Property-based tests for the cooling-advice engine (Klima module / C2).
 */

import fc from 'fast-check';
import { describe, it, expect } from 'vitest';

import {
  coolingAdvice,
  type CoolAdviceInputs,
  type CoolAdviceLevel,
} from '../../src/plugin/engine/coolingAdvice.js';

const LEVELS: ReadonlySet<CoolAdviceLevel> = new Set([
  'cool_now',
  'cool_grid',
  'precool',
  'no_cooling',
  'neutral',
]);

function inputArb(): fc.Arbitrary<CoolAdviceInputs> {
  return fc.record({
    indoorTempC: fc.oneof(fc.constant(null), fc.double({ min: 15, max: 38, noNaN: true })),
    comfortMaxC: fc.double({ min: 23, max: 27, noNaN: true }),
    preCoolC: fc.double({ min: 21, max: 25, noNaN: true }),
    pvSurplusKw: fc.oneof(fc.constant(null), fc.double({ min: 0, max: 8, noNaN: true })),
    pvSurplusThresholdKw: fc.double({ min: 0.1, max: 2, noNaN: true }),
    heatModeActive: fc.boolean(),
  });
}

describe('coolingAdvice', () => {
  it('always returns a valid level with non-empty German text', () => {
    fc.assert(
      fc.property(inputArb(), (inp) => {
        const a = coolingAdvice(inp);
        expect(LEVELS.has(a.level)).toBe(true);
        expect(a.headline.length).toBeGreaterThan(0);
        expect(a.detail.length).toBeGreaterThan(0);
      }),
      { numRuns: 300 },
    );
  });

  it('recommends solar cooling when hot indoors and PV surplus is available', () => {
    const a = coolingAdvice({
      indoorTempC: 27,
      comfortMaxC: 25,
      preCoolC: 23,
      pvSurplusKw: 2.5,
      pvSurplusThresholdKw: 0.5,
      heatModeActive: true,
    });
    expect(a.level).toBe('cool_now');
  });

  it('flags grid cooling when hot indoors but no PV surplus', () => {
    const a = coolingAdvice({
      indoorTempC: 27,
      comfortMaxC: 25,
      preCoolC: 23,
      pvSurplusKw: 0.1,
      pvSurplusThresholdKw: 0.5,
      heatModeActive: true,
    });
    expect(a.level).toBe('cool_grid');
  });

  it('recommends pre-cooling in the pre-cool band with strong surplus and heat ahead', () => {
    const a = coolingAdvice({
      indoorTempC: 24,
      comfortMaxC: 25,
      preCoolC: 23,
      pvSurplusKw: 3,
      pvSurplusThresholdKw: 0.5,
      heatModeActive: true,
    });
    expect(a.level).toBe('precool');
  });

  it('says no cooling needed when comfortable', () => {
    const a = coolingAdvice({
      indoorTempC: 21,
      comfortMaxC: 25,
      preCoolC: 23,
      pvSurplusKw: 3,
      pvSurplusThresholdKw: 0.5,
      heatModeActive: true,
    });
    expect(a.level).toBe('no_cooling');
  });

  it('is neutral when indoor temperature is unknown', () => {
    const a = coolingAdvice({
      indoorTempC: null,
      comfortMaxC: 25,
      preCoolC: 23,
      pvSurplusKw: 3,
      pvSurplusThresholdKw: 0.5,
      heatModeActive: true,
    });
    expect(a.level).toBe('neutral');
  });
});
