/**
 * Property-based tests for the shading depth helper (Task 4.5).
 *
 * Subjects:
 *   - `src/plugin/engine/shadingDepth.ts` — `shadingDepth01`.
 *   - `src/plugin/engine/sun.ts` — `getSunPosition`, `sunOnWindow` (for the
 *     orientation-order property).
 *
 * Correctness Property 3 (design.md): no direct sun ⇒ the resulting depth is
 *   ≤ the depth with sun (the shutter opens or holds, never closes further
 *   for shading reasons).  Validates: Requirements 4.2, 4.3
 *
 * Correctness Property 6 (design.md): the depth never exceeds the heat-stau
 *   cap.  Validates: Requirements 4.6
 *
 * Correctness Property 4 (design.md): a NE/easterly window opens (loses the
 *   sun) over the day no later than a SW/westerly one.
 *   Validates: Requirements 4.4, 4.5
 */

import fc from 'fast-check';
import { describe, it, expect } from 'vitest';

import { shadingDepth01 } from '../../src/plugin/engine/shadingDepth.js';
import { getSunPosition, sunOnWindow } from '../../src/plugin/engine/sun.js';

const SUN_RULES = {
  minElevationDeg: 5,
  maxIncidenceAngleFacadeDeg: 90,
  maxIncidenceAngleRoofDeg: 95,
};

// Beispielstadt (steering Standortprofil) — fixed so the day geometry is stable.
const LOCATION = { latitude: 52.52, longitude: 13.41 };
const SOLSTICE = Date.UTC(2026, 5, 21, 0, 0, 0); // clear summer day

describe('shadingDepth01 — Property 6 (cap conformance)', () => {
  it('never exceeds the heat cap for any inputs', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<'open' | 'shaded'>('open', 'shaded'),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (state, incidence01, heatLoad01, heatCap01) => {
          const d = shadingDepth01({
            shadeState: state,
            incidence01,
            heatLoad01,
            heatCap01,
          });
          expect(d).toBeLessThanOrEqual(heatCap01 + 1e-9);
          expect(d).toBeGreaterThanOrEqual(0);
        },
      ),
    );
  });
});

describe('shadingDepth01 — Property 3 (no sun ⇒ depth ≤ with sun)', () => {
  it('depth at incidence 0 is ≤ depth at any positive incidence', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1, noNaN: true }), // heatLoad
        fc.double({ min: 0.01, max: 1, noNaN: true }), // positive incidence
        fc.double({ min: 0.1, max: 1, noNaN: true }), // cap
        (heatLoad01, incidence01, heatCap01) => {
          const noSun = shadingDepth01({
            shadeState: 'shaded',
            incidence01: 0,
            heatLoad01,
            heatCap01,
          });
          const withSun = shadingDepth01({
            shadeState: 'shaded',
            incidence01,
            heatLoad01,
            heatCap01,
          });
          expect(noSun).toBeLessThanOrEqual(withSun + 1e-9);
        },
      ),
    );
  });
});

/** Latest minute-of-day at which the window is lit; -1 if never. */
function lastLitMinute(orientationDeg: number): number {
  let last = -1;
  for (let min = 0; min <= 24 * 60; min += 10) {
    const sun = getSunPosition(new Date(SOLSTICE + min * 60_000), LOCATION);
    if (sunOnWindow(sun, { orientationDeg, type: 'facade' }, SUN_RULES)) {
      last = min;
    }
  }
  return last;
}

describe('sun geometry — Property 4 (NE opens no later than SW)', () => {
  it('an easterly window loses the sun no later than a westerly one', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 60, max: 120 }), // easterly (≈ E, around NE..ESE)
        fc.integer({ min: 240, max: 300 }), // westerly (≈ W, around WSW..WNW)
        (eastDeg, westDeg) => {
          const lastEast = lastLitMinute(eastDeg);
          const lastWest = lastLitMinute(westDeg);
          // If either never sees the sun, the ordering is vacuously fine.
          fc.pre(lastEast >= 0 && lastWest >= 0);
          expect(lastEast).toBeLessThanOrEqual(lastWest);
        },
      ),
      { numRuns: 60 },
    );
  });
});
