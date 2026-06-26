/**
 * Property-based tests for the shutter percent convention
 * (predictive-control-dashboard).
 */

import fc from 'fast-check';
import { describe, it, expect } from 'vitest';

import {
  percentToLevel01,
  level01ToPercent,
  persistRoundTripPercent,
} from '../../src/plugin/engine/forecast/shutterConvention.js';

describe('shutterConvention — Property 1', () => {
  // Feature: predictive-control-dashboard, Property 1: Prozent↔shutterLevel↔Persistenz-Round-Trip (0%=offen, 100%=geschlossen).
  it('round-trips percent ↔ level01 and through persistence (0=open,100=closed)', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 100, noNaN: true }), (p) => {
        const lvl = percentToLevel01(p);
        expect(lvl).toBeCloseTo(p / 100, 9);
        expect(level01ToPercent(lvl)).toBeCloseTo(p, 6);
        expect(persistRoundTripPercent(p)).toBeCloseTo(p, 9);
      }),
      { numRuns: 200 },
    );
    // Anchors: 0% open → level 0, 100% closed → level 1.
    expect(percentToLevel01(0)).toBe(0);
    expect(percentToLevel01(100)).toBe(1);
  });
});
