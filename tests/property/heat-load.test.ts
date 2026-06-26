/**
 * Property-based tests for the PV-led heat-load model (Task 2.4).
 *
 * Subject: `src/plugin/engine/heatLoad.ts` — `effectiveHeatLoad01`.
 *
 * Correctness Property 1 (design.md): with all other inputs held fixed,
 * `effectiveHeatLoad01().load01` is **monotonically non-decreasing in PV
 * power**. Also checks the global bound `load01 ∈ [0, 1]`.
 *
 * Validates: Requirements 1.1, 1.2, 2.2
 */

import fc from 'fast-check';
import { describe, it, expect } from 'vitest';

import {
  effectiveHeatLoad01,
  type HeatLoadInputs,
} from '../../src/plugin/engine/heatLoad.js';

function baseArb(): fc.Arbitrary<Omit<HeatLoadInputs, 'pvKw'>> {
  return fc.record({
    pvPeakKwp: fc.double({ min: 1, max: 20, noNaN: true }),
    outdoorTempC: fc.oneof(
      fc.constant<number | null>(null),
      fc.double({ min: -10, max: 50, noNaN: true }),
    ),
    outdoorTrendCph: fc.oneof(
      fc.constant<number | null>(null),
      fc.double({ min: -10, max: 10, noNaN: true }),
    ),
    weights: fc.record({
      pv: fc.double({ min: 0, max: 1, noNaN: true }),
      temp: fc.double({ min: 0, max: 1, noNaN: true }),
      trend: fc.double({ min: 0, max: 1, noNaN: true }),
    }),
    fallbackSolar01: fc.oneof(
      fc.constant<number | null>(null),
      fc.double({ min: 0, max: 1, noNaN: true }),
    ),
  });
}

const pvArb = fc.double({ min: 0, max: 30, noNaN: true });

describe('effectiveHeatLoad01 — Property 1 (PV monotonicity)', () => {
  it('load01 is non-decreasing in pvKw, all else equal', () => {
    fc.assert(
      fc.property(baseArb(), pvArb, pvArb, (rest, a, b) => {
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        const loLoad = effectiveHeatLoad01({ ...rest, pvKw: lo }).load01;
        const hiLoad = effectiveHeatLoad01({ ...rest, pvKw: hi }).load01;
        // allow a hair of IEEE-754 slack
        expect(hiLoad).toBeGreaterThanOrEqual(loLoad - 1e-9);
      }),
    );
  });

  it('load01 always lies within [0, 1]', () => {
    fc.assert(
      fc.property(baseArb(), pvArb, (rest, pv) => {
        const { load01 } = effectiveHeatLoad01({ ...rest, pvKw: pv });
        return load01 >= 0 && load01 <= 1;
      }),
    );
  });
});
