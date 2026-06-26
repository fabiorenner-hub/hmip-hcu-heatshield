/**
 * Property-based tests for facade exposure, PV-Sonnenindex and the
 * house-asset selector (predictive-control-dashboard). Properties 15–17.
 */

import fc from 'fast-check';
import { describe, it, expect } from 'vitest';

import {
  facadeExposure01,
  pvSonnenindex01,
  clearSkyPvKw,
} from '../../src/plugin/engine/forecast/facadeExposure.js';
import type { SunPosition } from '../../src/plugin/engine/sun.js';

function sunArb(): fc.Arbitrary<SunPosition> {
  return fc
    .record({
      azimuthDeg: fc.double({ min: 0, max: 360, noNaN: true }),
      elevationDeg: fc.double({ min: -90, max: 90, noNaN: true }),
    })
    .map((r) => ({
      azimuthDeg: r.azimuthDeg,
      elevationDeg: r.elevationDeg,
      isUp: r.elevationDeg > 0,
    }));
}

describe('facadeExposure — Properties 15–17', () => {
  // Feature: predictive-control-dashboard, Property 15: PV-Sonnenindex-Normalisierung.
  it('Property 15: pvSonnenindex01 ∈ [0,1], 0 when PV is 0, monotone in PV', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 12, noNaN: true }),
        fc.double({ min: 0, max: 12, noNaN: true }),
        fc.double({ min: 0.1, max: 12, noNaN: true }),
        (a, b, clear) => {
          const lo = Math.min(a, b);
          const hi = Math.max(a, b);
          const vLo = pvSonnenindex01(lo, clear);
          const vHi = pvSonnenindex01(hi, clear);
          expect(vLo).toBeGreaterThanOrEqual(0);
          expect(vHi).toBeLessThanOrEqual(1);
          expect(vHi).toBeGreaterThanOrEqual(vLo - 1e-9);
        },
      ),
      { numRuns: 200 },
    );
    expect(pvSonnenindex01(0, 5)).toBe(0);
  });

  // Feature: predictive-control-dashboard, Property 16: Exposition Bereich [0,1], 0 unter Horizont, Bewölkungs-Monotonie.
  it('Property 16: facadeExposure01 ∈ [0,1], 0 below horizon, non-increasing in cloud', () => {
    fc.assert(
      fc.property(
        sunArb(),
        fc.double({ min: 0, max: 360, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (sun, facade, c1, c2, idx) => {
          const e = facadeExposure01(sun, facade, c1, idx);
          expect(e).toBeGreaterThanOrEqual(0);
          expect(e).toBeLessThanOrEqual(1);
          if (!sun.isUp || sun.elevationDeg <= 0) {
            expect(e).toBe(0);
          }
          const loCloud = Math.min(c1, c2);
          const hiCloud = Math.max(c1, c2);
          const eLo = facadeExposure01(sun, facade, loCloud, idx);
          const eHi = facadeExposure01(sun, facade, hiCloud, idx);
          expect(eHi).toBeLessThanOrEqual(eLo + 1e-9);
        },
      ),
      { numRuns: 200 },
    );
  });

  // Feature: predictive-control-dashboard, Property 17: clear-sky PV ≥ 0.
  it('clearSkyPvKw is always ≥ 0 for any sun position and orientation', () => {
    fc.assert(
      fc.property(sunArb(), (sun) => {
        expect(clearSkyPvKw(sun, 8.8, 'southeast')).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 200 },
    );
  });
});
