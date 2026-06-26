/**
 * Property-based tests for the SPA sun-incidence mirror (Task 4.3).
 *
 * Subject: `src/plugin/dashboard/spa/sunIncidence.ts` —
 * `windowSunStatus`, `isSunOnWindow`. These mirror the engine's
 * `sunOnWindow` / `sunOnWindowSoon` so the dashboard status agrees
 * with the engine's decision.
 *
 * Property 1 (design.md): `windowSunStatus === 'soon'` ⇒ there exists a
 * tick in the look-ahead window where `isSunOnWindow` is true.
 *
 * Validates: Requirements 2.3
 */

import fc from 'fast-check';
import { describe, it, expect } from 'vitest';

import {
  isSunOnWindow,
  windowSunStatus,
  type SunIncidenceParams,
} from '../../src/plugin/dashboard/spa/sunIncidence.js';

const EPOCH = Date.UTC(2026, 5, 21, 0, 0, 0); // 2026-06-21, around solstice

function paramsArb(): fc.Arbitrary<SunIncidenceParams> {
  return fc.record({
    now: fc
      .integer({ min: 0, max: 60 * 24 * 30 })
      .map((min) => new Date(EPOCH + min * 60_000)),
    latitude: fc.double({ min: 50, max: 55, noNaN: true }),
    longitude: fc.double({ min: 10, max: 16, noNaN: true }),
    orientationDeg: fc.integer({ min: 0, max: 359 }),
    type: fc.constantFrom<SunIncidenceParams['type']>('facade', 'roof_window'),
    sunPrelookMinutes: fc.integer({ min: 15, max: 120 }),
    minElevationDeg: fc.integer({ min: 0, max: 10 }),
    maxIncidenceAngleFacadeDeg: fc.integer({ min: 60, max: 90 }),
    maxIncidenceAngleRoofDeg: fc.integer({ min: 60, max: 95 }),
  });
}

describe('windowSunStatus — Property 1 (soon ⇒ ∃ lit tick)', () => {
  it('a "soon" status implies some look-ahead tick is lit', () => {
    fc.assert(
      fc.property(paramsArb(), (p) => {
        if (windowSunStatus(p) !== 'soon') {
          return; // only the soon branch is constrained here
        }
        const stepMs = 5 * 60 * 1000;
        const startMs = p.now.getTime();
        const endMs = startMs + p.sunPrelookMinutes * 60 * 1000;
        let found = false;
        for (let t = startMs; t <= endMs + stepMs / 2; t += stepMs) {
          if (isSunOnWindow(p, new Date(t))) {
            found = true;
            break;
          }
        }
        expect(found).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('a "lit" status means the sun is on the window right now', () => {
    fc.assert(
      fc.property(paramsArb(), (p) => {
        if (windowSunStatus(p) === 'lit') {
          expect(isSunOnWindow(p, p.now)).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });
});
