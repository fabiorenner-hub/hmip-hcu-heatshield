/**
 * Heat Shield — Property-Based Tests for the sun module (Task 4.4).
 *
 * Frame:
 *   - Library: `fast-check` (devDependency; verified ESM via `lib/esm/`).
 *   - Subject: `src/plugin/engine/sun.ts` — `circularAngleDiff`,
 *     `getSunPosition`, `sunOnWindow`, `sunOnWindowSoon`, `sunFactor`.
 *   - Reference profile: Beispielstadt-ish — lat ∈ [50, 55], lon ∈ [10, 16].
 *     Wider than the project's actual lat/lon (52.52 / 13.41) on purpose
 *     so that fast-check explores the neighbourhood without leaving
 *     the IANA-valid range or wandering into the polar zone where
 *     suncalc's day-key heuristics get fuzzy.
 *
 * Properties encoded (numbering follows tasks.md / Task 4.4 brief):
 *   1. `circularAngleDiff` symmetry within 1e-9 (numRuns 100).
 *   2. `circularAngleDiff` bounds in [0, 180]      (numRuns 100).
 *   3. `circularAngleDiff` 360°-rotation invariance (numRuns 100).
 *   4. `sunOnWindowSoon === true` ⇒ ∃ tick in the same 5-min grid where
 *      `sunOnWindow(getSunPosition(t, location), window, rules) === true`
 *      (numRuns 200 to keep CI fast while still giving fast-check
 *      enough effective samples after `fc.pre` filtering).
 *   5. `sunOnWindowSoon === false` ⇒ NO tick hits the window
 *      (numRuns 100).
 *   6. `sunFactor` is always in `[0, 1]` for any random sample
 *      (numRuns 100).
 *   7. `incidenceNow === 0` AND `sunOnWindowSoon === false`
 *      ⇒ `sunFactor === 0` exactly (numRuns 100).
 *
 * Validates: Requirements 1.1, 9.3 (per tasks.md item 4 → 4.4).
 *
 * Performance budget:
 *   The whole file aims for < 3 s on a contemporary dev box; 200 runs
 *   of property 4 with up to 25 grid ticks each (the worst case is
 *   sunPrelookMinutes = 120 / step 5) costs ≈ 5 000 suncalc calls,
 *   which suncalc handles comfortably in well under a second.
 *
 * Generator notes:
 *   - Time instants are built from a `fc.integer` of "minutes since the
 *     fixed epoch 2026-06-21T00:00:00Z" within ±30 days, which avoids
 *     `noDefaultInfinity` / NaN issues that you can otherwise get by
 *     piping a raw `fc.double` through the `Date` constructor.
 *   - Lat/lon bounds keep the location well below the polar circle so
 *     that suncalc never returns `Invalid Date`.
 *   - Window orientation uses `fc.integer({ 0, 359 })` to match the
 *     schema's integer-degree contract; `sunPrelookMinutes` follows the
 *     schema's [15, 120] range exactly.
 */

import fc from 'fast-check';
import { describe, it } from 'vitest';

import {
  circularAngleDiff,
  getSunPosition,
  sunFactor,
  sunOnWindow,
  sunOnWindowSoon,
} from '../../src/plugin/engine/sun.js';
import type { Location, SunRules, Window } from '../../src/shared/types.js';

// ---------------------------------------------------------------------------
// Shared fixtures.
// ---------------------------------------------------------------------------

/**
 * Default `SunRules` profile — mirrors the schema's `prefault` defaults.
 * Kept as a literal so the tests remain self-contained (no Zod parse
 * during the hot loop).
 */
const SUN_RULES: SunRules = {
  minElevationDeg: 5,
  maxIncidenceAngleFacadeDeg: 90,
  maxIncidenceAngleRoofDeg: 95,
};

/** Anchor for the time generator: 21.06.2026 00:00 UTC. */
const EPOCH_MS = Date.UTC(2026, 5, 21, 0, 0, 0);

/** ±30 days in minutes — used as the `fc.integer` range for the time arb. */
const TIME_RANGE_MIN = 30 * 24 * 60;

/** Default 5-min step grid identical to the implementation's default. */
const STEP_MINUTES = 5;
const STEP_MS = STEP_MINUTES * 60 * 1000;

// ---------------------------------------------------------------------------
// Generators.
// ---------------------------------------------------------------------------

/**
 * Integer-minute offsets within ±30 days mapped to a `Date`. Using an
 * integer minute offset (rather than a free-form `fc.double`) gives
 * fast-check a finite, well-behaved input space and avoids the rounding
 * traps of converting raw doubles into milliseconds.
 */
const dateArb = fc
  .integer({ min: -TIME_RANGE_MIN, max: TIME_RANGE_MIN })
  .map((minutes) => new Date(EPOCH_MS + minutes * 60_000));

/**
 * Beispielstadt-ish location — wide enough for fuzzy exploration, narrow
 * enough to stay in the same daylight regime (well below the polar
 * circle and inside the Europe/Berlin tz isochrone).
 */
const locationArb: fc.Arbitrary<Pick<Location, 'latitude' | 'longitude'>> = fc.record({
  latitude: fc.double({
    min: 50,
    max: 55,
    noNaN: true,
    noDefaultInfinity: true,
  }),
  longitude: fc.double({
    min: 10,
    max: 16,
    noNaN: true,
    noDefaultInfinity: true,
  }),
});

/**
 * Window arbitrary — matches the production `WindowSchema` constraints
 * for `orientationDeg` (integer 0–359), `type` (façade or roof window),
 * and `sunPrelookMinutes` (15–120).
 */
const windowArb: fc.Arbitrary<
  Pick<Window, 'orientationDeg' | 'type' | 'sunPrelookMinutes'>
> = fc.record({
  orientationDeg: fc.integer({ min: 0, max: 359 }),
  type: fc.constantFrom<Window['type']>('facade', 'roof_window'),
  sunPrelookMinutes: fc.integer({ min: 15, max: 120 }),
});

/** Generator for `circularAngleDiff`'s real-valued inputs. */
const angleArb = fc.double({
  min: -1e6,
  max: 1e6,
  noNaN: true,
  noDefaultInfinity: true,
});

// ---------------------------------------------------------------------------
// Local re-implementations (read-only, for predicate filtering).
//
// Property 7 needs to recompute `incidenceNow` independently of the
// engine so it can filter for the antecedent. The formula below is
// the spec from `design.md` §Property 2 and mirrors the engine's
// `sunFactor` body byte-for-byte. We deliberately avoid exporting the
// engine's private helper to keep the production surface minimal.
// ---------------------------------------------------------------------------

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return x;
}

function incidenceNowOf(
  now: Date,
  location: Pick<Location, 'latitude' | 'longitude'>,
  window: Pick<Window, 'orientationDeg' | 'type'>,
  rules: SunRules,
): number {
  const sun = getSunPosition(now, location);
  if (!sun.isUp) return 0;
  if (sun.elevationDeg < rules.minElevationDeg) return 0;
  const limit =
    window.type === 'roof_window'
      ? rules.maxIncidenceAngleRoofDeg
      : rules.maxIncidenceAngleFacadeDeg;
  const angleDiff = circularAngleDiff(sun.azimuthDeg, window.orientationDeg);
  const azimuthTerm = clamp01(1 - angleDiff / limit);
  const elevationTerm = clamp01(
    (sun.elevationDeg - rules.minElevationDeg) / 35,
  );
  return azimuthTerm * elevationTerm;
}

/**
 * Iterates the same 5-min grid that `sunOnWindowSoon` uses internally
 * and returns `true` iff at least one tick is on the window. The
 * fence-post (`endMs + STEP_MS / 2`) matches the engine to the byte so
 * properties 4/5 can compare apples to apples.
 */
function anyTickHitsWindow(
  now: Date,
  location: Pick<Location, 'latitude' | 'longitude'>,
  window: Pick<Window, 'orientationDeg' | 'type' | 'sunPrelookMinutes'>,
  rules: SunRules,
): boolean {
  const startMs = now.getTime();
  const endMs = startMs + window.sunPrelookMinutes * 60 * 1000;
  for (let t = startMs; t <= endMs + STEP_MS / 2; t += STEP_MS) {
    const sun = getSunPosition(new Date(t), location);
    if (sunOnWindow(sun, window, rules)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Properties 1–3: circularAngleDiff algebra.
// ---------------------------------------------------------------------------

describe('circularAngleDiff — algebraic properties', () => {
  it('is symmetric within 1e-9 for any reals (Property 1)', () => {
    fc.assert(
      fc.property(angleArb, angleArb, (a, b) => {
        const ab = circularAngleDiff(a, b);
        const ba = circularAngleDiff(b, a);
        return Math.abs(ab - ba) < 1e-9;
      }),
      { numRuns: 100 },
    );
  });

  it('always returns a value in [0, 180] (Property 2)', () => {
    fc.assert(
      fc.property(angleArb, angleArb, (a, b) => {
        const d = circularAngleDiff(a, b);
        return d >= 0 && d <= 180;
      }),
      { numRuns: 100 },
    );
  });

  it('is invariant under 360°-rotation of either input (Property 3)', () => {
    // `k` is the integer number of full turns to add to `a`. The
    // result must agree with the un-rotated reference within 1e-9.
    const turnArb = fc.integer({ min: -1000, max: 1000 });
    fc.assert(
      fc.property(angleArb, angleArb, turnArb, (a, b, k) => {
        const ref = circularAngleDiff(a, b);
        const shifted = circularAngleDiff(a + 360 * k, b);
        return Math.abs(ref - shifted) < 1e-9;
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 4: sunOnWindowSoon ⇒ at least one tick has sunOnWindow.
// ---------------------------------------------------------------------------

describe('sunOnWindowSoon ↔ grid iteration (Property 4)', () => {
  it('true ⇒ some tick in the prelook grid has sunOnWindow=true', () => {
    fc.assert(
      fc.property(dateArb, locationArb, windowArb, (now, location, window) => {
        const soon = sunOnWindowSoon(now, location, window, SUN_RULES);
        // Discard cases that lack the antecedent — `fc.pre` keeps the
        // counterexample shrinker honest while still giving fast-check
        // a valid sample.
        fc.pre(soon === true);
        return anyTickHitsWindow(now, location, window, SUN_RULES);
      }),
      // Bumped above the file-wide 100 default so fast-check has
      // enough effective samples after `fc.pre` filters out the
      // night-time / out-of-lobe inputs that don't carry the
      // implication's antecedent. 200 stays well under the file's
      // 3-second budget.
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 5: negation — sunOnWindowSoon=false ⇒ no tick hits.
// ---------------------------------------------------------------------------

describe('sunOnWindowSoon negation (Property 5)', () => {
  it('false ⇒ no tick in the prelook grid has sunOnWindow=true', () => {
    fc.assert(
      fc.property(dateArb, locationArb, windowArb, (now, location, window) => {
        const soon = sunOnWindowSoon(now, location, window, SUN_RULES);
        fc.pre(soon === false);
        return anyTickHitsWindow(now, location, window, SUN_RULES) === false;
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 6: sunFactor is always in [0, 1].
// ---------------------------------------------------------------------------

describe('sunFactor bounds (Property 6)', () => {
  it('is always in [0, 1] for any random input', () => {
    fc.assert(
      fc.property(dateArb, locationArb, windowArb, (now, location, window) => {
        const f = sunFactor(now, location, window, SUN_RULES);
        return f >= 0 && f <= 1;
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 7: sunFactor === 0 iff both legs are missing.
// ---------------------------------------------------------------------------

describe('sunFactor zero-condition (Property 7)', () => {
  it('incidenceNow=0 ∧ sunOnWindowSoon=false ⇒ sunFactor=0 exactly', () => {
    fc.assert(
      fc.property(dateArb, locationArb, windowArb, (now, location, window) => {
        const inc = incidenceNowOf(now, location, window, SUN_RULES);
        const soon = sunOnWindowSoon(now, location, window, SUN_RULES);
        fc.pre(inc === 0 && soon === false);
        return sunFactor(now, location, window, SUN_RULES) === 0;
      }),
      { numRuns: 100 },
    );
  });
});
