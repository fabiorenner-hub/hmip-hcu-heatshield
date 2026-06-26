/**
 * Tests for the window-incidence functions in `src/plugin/engine/sun.ts`
 * (Task 4.2): `circularAngleDiff`, `sunOnWindow`, `sunOnWindowSoon`,
 * `sunFactor`.
 *
 * Reference location is **Beispielstadt** (52.52°N, 13.41°E, Europe/Berlin)
 * — the project's verified default per `heat-shield-context.md`.
 * Reference dates are 21.06.2026 (CEST = UTC+2) and 21.12.2026
 * (CET = UTC+1). The local-time annotations in each test are sanity
 * pointers; the actual `Date` literals are constructed in UTC so the
 * suite is robust against the runner's TZ.
 *
 * The `sunOnWindowSoon` cases use `sunPrelookMinutes` values picked
 * from the actual sun trajectory at Beispielstadt (verified against
 * suncalc) so that each case unambiguously distinguishes "the sun is
 * about to hit" from "the sun has already moved past". Where the brief
 * in tasks.md suggested numeric values that did not survive the
 * physics check, we widened the prelook (still within the schema's
 * 15–120 min bound) and document the change inline. Cf. the comment
 * in `sun-position.test.ts` about Beispielstadt's solar noon at ~13:10
 * CEST for the same kind of correction.
 */

import { describe, expect, it } from 'vitest';

import {
  circularAngleDiff,
  getSunPosition,
  sunFactor,
  sunOnWindow,
  sunOnWindowSoon,
} from '../../src/plugin/engine/sun.js';
import type { SunRules, Window } from '../../src/shared/types.js';

const TEST_LOCATION = { latitude: 52.52, longitude: 13.41 } as const;

/**
 * Default `SunRules` from the schema's `prefault` defaults — kept here
 * as a literal so the test does not have to call into Zod just to
 * obtain the canonical numbers.
 */
const SUN_RULES: SunRules = {
  minElevationDeg: 5,
  maxIncidenceAngleFacadeDeg: 90,
  maxIncidenceAngleRoofDeg: 95,
};

const SE_ROOF: Pick<Window, 'orientationDeg' | 'type' | 'sunPrelookMinutes'> = {
  orientationDeg: 135,
  type: 'roof_window',
  sunPrelookMinutes: 60,
};

const SE_FACADE: Pick<Window, 'orientationDeg' | 'type' | 'sunPrelookMinutes'> = {
  orientationDeg: 135,
  type: 'facade',
  sunPrelookMinutes: 60,
};

const NORTH_FACADE: Pick<Window, 'orientationDeg' | 'type' | 'sunPrelookMinutes'> = {
  orientationDeg: 0,
  type: 'facade',
  sunPrelookMinutes: 60,
};

// ---------------------------------------------------------------------------
// circularAngleDiff
// ---------------------------------------------------------------------------

describe('circularAngleDiff', () => {
  it('handles wrap-around through North in both directions', () => {
    expect(circularAngleDiff(350, 10)).toBe(20);
    expect(circularAngleDiff(10, 350)).toBe(20);
  });

  it('returns the smallest unsigned arc', () => {
    expect(circularAngleDiff(170, 10)).toBe(160);
    expect(circularAngleDiff(0, 0)).toBe(0);
    expect(circularAngleDiff(180, 0)).toBe(180);
  });

  it('normalises negative inputs', () => {
    expect(circularAngleDiff(-10, 350)).toBe(0);
  });

  it('normalises inputs ≥ 360', () => {
    expect(circularAngleDiff(720 + 10, 10)).toBe(0);
    expect(circularAngleDiff(360 + 350, 10)).toBe(20);
  });

  it('is symmetric and bounded by [0, 180]', () => {
    for (let i = 0; i < 50; i++) {
      const a = Math.random() * 1000 - 500;
      const b = Math.random() * 1000 - 500;
      const d1 = circularAngleDiff(a, b);
      const d2 = circularAngleDiff(b, a);
      // IEEE-754 modulo can swap rounding direction depending on input
      // sign, so we compare with a small tolerance instead of strict
      // equality. The function is mathematically symmetric.
      expect(d1).toBeCloseTo(d2, 9);
      expect(d1).toBeGreaterThanOrEqual(0);
      expect(d1).toBeLessThanOrEqual(180);
    }
  });
});

// ---------------------------------------------------------------------------
// sunOnWindow
// ---------------------------------------------------------------------------

describe('sunOnWindow', () => {
  it('returns true for SE roof window at 06:00 CEST on 21.06.2026', () => {
    // 06:00 CEST = 04:00 UTC; Beispielstadt sun is at az≈62°, el≈8.6°.
    // angleDiff(62, 135) = 73 ≤ 95 (roof limit) → in the sun.
    const now = new Date(Date.UTC(2026, 5, 21, 4, 0, 0));
    const sun = getSunPosition(now, TEST_LOCATION);
    expect(sunOnWindow(sun, SE_ROOF, SUN_RULES)).toBe(true);
  });

  it('returns false for SE roof window at 21:00 CEST on 21.06.2026', () => {
    // 21:00 CEST = 19:00 UTC; sun has swung deep west (az≈290°).
    // angleDiff(290, 135) = 155 > 95 → out of the lobe.
    const now = new Date(Date.UTC(2026, 5, 21, 19, 0, 0));
    const sun = getSunPosition(now, TEST_LOCATION);
    expect(sunOnWindow(sun, SE_ROOF, SUN_RULES)).toBe(false);
  });

  it('returns false for a north-facing façade at noon in summer', () => {
    // 12:00 CEST = 10:00 UTC; sun is in the southern half (az≈170–180°),
    // angleDiff to N (0°) is ≈170–180° > 90° (façade limit).
    const now = new Date(Date.UTC(2026, 5, 21, 10, 0, 0));
    const sun = getSunPosition(now, TEST_LOCATION);
    expect(sunOnWindow(sun, NORTH_FACADE, SUN_RULES)).toBe(false);
  });

  it('returns false when the sun is below the configured min elevation', () => {
    // 21.12.2026 02:00 CET = 01:00 UTC; sun is far below the horizon.
    const now = new Date(Date.UTC(2026, 11, 21, 1, 0, 0));
    const sun = getSunPosition(now, TEST_LOCATION);
    expect(sunOnWindow(sun, SE_ROOF, SUN_RULES)).toBe(false);
  });

  it('returns false when the sun is up but below minElevationDeg', () => {
    // 21.06.2026 03:30 UTC: sun has just risen, el≈4.7° < 5° threshold.
    const now = new Date(Date.UTC(2026, 5, 21, 3, 30, 0));
    const sun = getSunPosition(now, TEST_LOCATION);
    // Sanity check on the suncalc output: low but above horizon.
    expect(sun.isUp).toBe(true);
    expect(sun.elevationDeg).toBeLessThan(SUN_RULES.minElevationDeg);
    expect(sunOnWindow(sun, SE_ROOF, SUN_RULES)).toBe(false);
  });

  it('respects the wider roof tolerance vs façade', () => {
    // Construct a synthetic SunPosition that lies between the façade and
    // roof limits: angleDiff = 92.5° (>90, ≤95).
    const sun = {
      azimuthDeg: 92.5,
      elevationDeg: 30,
      isUp: true,
    };
    const window = { orientationDeg: 0 } as const;
    expect(sunOnWindow(sun, { ...window, type: 'facade' }, SUN_RULES)).toBe(false);
    expect(sunOnWindow(sun, { ...window, type: 'roof_window' }, SUN_RULES)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// sunOnWindowSoon
// ---------------------------------------------------------------------------

describe('sunOnWindowSoon', () => {
  it('detects the sun crossing into an SE roof window from before sunrise', () => {
    // Brief asked for 04:30 CEST start with prelook=60. The physics at
    // Beispielstadt make that interval finish at el≈4.7° (still below the
    // 5° threshold), so we use prelook=120 to reach a tick where the
    // sun has comfortably cleared the threshold and the SE-roof lobe
    // is hit. The schema permits prelook up to 120 min.
    const now = new Date(Date.UTC(2026, 5, 21, 2, 30, 0));
    const window = { ...SE_ROOF, sunPrelookMinutes: 120 };
    expect(sunOnWindowSoon(now, TEST_LOCATION, window, SUN_RULES)).toBe(true);
  });

  it('returns false for SE façade in the late afternoon', () => {
    // Brief asked for 13:00 CEST. At Beispielstadt solar noon is ~13:10
    // CEST, so 13:00 still has the sun on the SE façade (angleDiff
    // ≈40°). We pick 16:00 CEST (14:00 UTC) where angleDiff already
    // exceeds the 90° façade limit and only grows further during the
    // 60-min look-ahead. This preserves the brief's intent ("sun has
    // moved past SE").
    const now = new Date(Date.UTC(2026, 5, 21, 14, 0, 0));
    expect(sunOnWindowSoon(now, TEST_LOCATION, SE_FACADE, SUN_RULES)).toBe(false);
  });

  it('returns false during deep winter night', () => {
    // 21.12.2026 02:00 CET = 01:00 UTC. Sun is ≈54° below the horizon
    // and stays there throughout the 60-min window.
    const now = new Date(Date.UTC(2026, 11, 21, 1, 0, 0));
    expect(sunOnWindowSoon(now, TEST_LOCATION, SE_ROOF, SUN_RULES)).toBe(false);
    expect(sunOnWindowSoon(now, TEST_LOCATION, SE_FACADE, SUN_RULES)).toBe(false);
  });

  it('respects the stepMinutes override', () => {
    // 21.06.2026 02:30 UTC; the sun first clears 5° around 03:50 UTC.
    // With prelook=120 we should hit it whether we step every 5 min
    // (default) or every 30 min.
    const now = new Date(Date.UTC(2026, 5, 21, 2, 30, 0));
    const window = { ...SE_ROOF, sunPrelookMinutes: 120 };
    expect(sunOnWindowSoon(now, TEST_LOCATION, window, SUN_RULES)).toBe(true);
    expect(
      sunOnWindowSoon(now, TEST_LOCATION, window, SUN_RULES, { stepMinutes: 30 }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// sunFactor
// ---------------------------------------------------------------------------

describe('sunFactor', () => {
  it('returns 0 when sun is below the elevation threshold and not coming back', () => {
    // Deep winter night, sun way below horizon for hours.
    const now = new Date(Date.UTC(2026, 11, 21, 1, 0, 0));
    expect(sunFactor(now, TEST_LOCATION, SE_ROOF, SUN_RULES)).toBe(0);
  });

  it('returns 0.6 when incidenceNow is 0 but a soon-hit is detected', () => {
    // 05:00 CEST = 03:00 UTC. Sun is up (el≈1°) but below the 5°
    // threshold, so incidenceNow = 0. By 04:00 UTC el≈8.6°, az≈62°,
    // which sits inside the SE-roof lobe — soonHit = true.
    const now = new Date(Date.UTC(2026, 5, 21, 3, 0, 0));
    const sun = getSunPosition(now, TEST_LOCATION);
    expect(sun.elevationDeg).toBeLessThan(SUN_RULES.minElevationDeg);
    expect(sunFactor(now, TEST_LOCATION, SE_ROOF, SUN_RULES)).toBe(0.6);
  });

  it('returns > 0.5 when sun is squarely on the window with high elevation', () => {
    // 11:00 CEST = 09:00 UTC, az≈127°, el≈52°. SE roof, orient 135 →
    // angleDiff ≈ 8°, very high incidenceNow.
    const now = new Date(Date.UTC(2026, 5, 21, 9, 0, 0));
    const f = sunFactor(now, TEST_LOCATION, SE_ROOF, SUN_RULES);
    expect(f).toBeGreaterThan(0.5);
    expect(f).toBeLessThanOrEqual(1);
  });

  it('always returns a value in [0, 1] for random samples (property smoke)', () => {
    // Smoke-style property test (Task 4.2). The full fast-check version
    // is delivered by Task 4.4; here we just sample the input space to
    // catch obvious clamp regressions.
    const start = Date.UTC(2026, 0, 1, 0, 0, 0);
    const span = 365 * 24 * 60 * 60 * 1000;
    for (let i = 0; i < 100; i++) {
      const now = new Date(start + Math.random() * span);
      const orientationDeg = Math.floor(Math.random() * 360);
      const type: Window['type'] =
        Math.random() < 0.5 ? 'facade' : 'roof_window';
      const window = { orientationDeg, type, sunPrelookMinutes: 60 } as const;
      const f = sunFactor(now, TEST_LOCATION, window, SUN_RULES);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(1);
    }
  });
});
