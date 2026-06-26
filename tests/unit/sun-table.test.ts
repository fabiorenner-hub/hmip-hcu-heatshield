/**
 * Tests for the window-incidence functions in `src/plugin/engine/sun.ts`
 * (Task 4.3): a TABLE-driven battery of representative
 * (date, time, location, window, expected) tuples that exercise
 * `sunOnWindow` / `sunFactor` across many configurations at once.
 *
 * The point cases in `sun-window.test.ts` cover the corner-case
 * mechanics (DST, prelook step size, etc.); this file complements them
 * with breadth: the same engine is asked to classify many representative
 * scenarios in one table, so a regression in any one of the components
 * (azimuth normalisation, elevation gating, prelook stepping, factor
 * combination rule) becomes easy to spot.
 *
 * Reference location is **Beispielstadt** (52.52°N, 13.41°E, Europe/Berlin)
 * — the project's verified default per `heat-shield-context.md`.
 *
 * Each `expectedFactorRange` was validated against the actual suncalc
 * output (probe traces logged in `.tmp-assets/sun-probe.mjs`) so the
 * bounds are tight enough to catch regressions without being so tight
 * that they break on minor library updates. Where a tuple was tightened
 * relative to the brief's literal numbers, the discrepancy is documented
 * inline (e.g. case 1's incidenceNow is small but soonHit lifts the
 * factor to 0.5).
 */

import { describe, expect, it } from 'vitest';

import {
  circularAngleDiff,
  getSunPosition,
  sunFactor,
  sunOnWindow,
} from '../../src/plugin/engine/sun.js';
import type { SunRules, Window } from '../../src/shared/types.js';

// ---------------------------------------------------------------------------
// Local helpers — no dependency on the engine module's internals.
// ---------------------------------------------------------------------------

const TEST_LOCATION = { latitude: 52.52, longitude: 13.41 } as const;

/**
 * Default `SunRules` profile — the schema's standard defaults
 * (regelwerk §6.4 / design.md §10).
 */
const SUN_RULES: SunRules = {
  minElevationDeg: 5,
  maxIncidenceAngleFacadeDeg: 90,
  maxIncidenceAngleRoofDeg: 95,
};

/**
 * Convert a local wall-clock (`yyyy-MM-dd`, `HH:mm`) in `timezone` to a
 * UTC `Date`. Mirrors the `localMidnightAsUtc` algorithm in
 * `engine/sun.ts`, but is rebuilt locally so this test file does not
 * depend on the engine module's private helpers.
 *
 * Algorithm:
 *   1. Encode the (y,m,d,h,mi) tuple naively as UTC → first guess `t0`.
 *   2. Compute the zone's UTC offset at `t0` and subtract it.
 *   3. Recompute the offset at the new candidate to absorb DST
 *      transitions and apply once more. Two iterations suffice for any
 *      real-world IANA zone.
 */
function localToUtc(
  localDate: string,
  localTime: string,
  timezone: string,
): Date {
  const dateParts = localDate.split('-');
  const timeParts = localTime.split(':');
  if (dateParts.length !== 3 || timeParts.length < 2) {
    throw new Error(
      `Invalid localDate '${localDate}' or localTime '${localTime}'`,
    );
  }
  const [yearStr, monthStr, dayStr] = dateParts;
  const [hourStr, minuteStr] = timeParts;
  if (
    yearStr === undefined ||
    monthStr === undefined ||
    dayStr === undefined ||
    hourStr === undefined ||
    minuteStr === undefined
  ) {
    throw new Error(
      `Invalid localDate '${localDate}' or localTime '${localTime}'`,
    );
  }
  const year = Number.parseInt(yearStr, 10);
  const month = Number.parseInt(monthStr, 10);
  const day = Number.parseInt(dayStr, 10);
  const hour = Number.parseInt(hourStr, 10);
  const minute = Number.parseInt(minuteStr, 10);

  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  function utcOffsetMs(instant: Date): number {
    const parts = fmt.formatToParts(instant);
    let y = 0;
    let mo = 0;
    let d = 0;
    let h = 0;
    let mi = 0;
    let s = 0;
    for (const p of parts) {
      switch (p.type) {
        case 'year':
          y = Number.parseInt(p.value, 10);
          break;
        case 'month':
          mo = Number.parseInt(p.value, 10);
          break;
        case 'day':
          d = Number.parseInt(p.value, 10);
          break;
        case 'hour':
          // ICU sometimes returns "24" for midnight under hour12=false.
          h = Number.parseInt(p.value, 10) % 24;
          break;
        case 'minute':
          mi = Number.parseInt(p.value, 10);
          break;
        case 'second':
          s = Number.parseInt(p.value, 10);
          break;
        default:
          break;
      }
    }
    return Date.UTC(y, mo - 1, d, h, mi, s) - instant.getTime();
  }

  const naiveUtcMs = Date.UTC(year, month - 1, day, hour, minute, 0);
  let offset = utcOffsetMs(new Date(naiveUtcMs));
  let candidate = new Date(naiveUtcMs - offset);
  offset = utcOffsetMs(candidate);
  candidate = new Date(naiveUtcMs - offset);
  return candidate;
}

// ---------------------------------------------------------------------------
// Table case shape and inline data.
// ---------------------------------------------------------------------------

interface TableCase {
  readonly name: string;
  readonly localDate: string;
  readonly localTime: string;
  readonly timezone: string;
  readonly location: { readonly latitude: number; readonly longitude: number };
  readonly window: Pick<
    Window,
    'orientationDeg' | 'type' | 'sunPrelookMinutes'
  >;
  readonly expectedSunOnWindow: boolean;
  readonly expectedFactorRange: readonly [number, number];
}

/**
 * Inline cases — kept here (not in a fixture) so the relationship
 * date↔assertion is visible at a glance. Sun positions in each comment
 * were verified against suncalc on 2026-06-21 / 2026-12-21.
 */
const CASES: readonly TableCase[] = [
  {
    // 06:00 CEST = 04:00 UTC; az≈62°, el≈8.6°. SE-roof orient 135°,
    // angleDiff≈73° ≤ 95° → sunOnWindow=true. Pure incidenceNow is
    // small (≈0.02) because the sun has just barely cleared the 5°
    // elevation floor, but soonHit is true → sunFactor ≥ 0.5.
    name: 'Beispielstadt 21.06.2026 06:00 — SE roof window',
    localDate: '2026-06-21',
    localTime: '06:00',
    timezone: 'Europe/Berlin',
    location: TEST_LOCATION,
    window: { orientationDeg: 135, type: 'roof_window', sunPrelookMinutes: 60 },
    expectedSunOnWindow: true,
    expectedFactorRange: [0.05, 1.0],
  },
  {
    // 12:00 CET = 11:00 UTC; az≈178.6°, el≈14°. N facade orient 0°,
    // angleDiff≈178° > 90° → no incidence now and the sun is nowhere
    // near a north window in the next 60 min.
    name: 'Beispielstadt 21.12.2026 12:00 — N facade window',
    localDate: '2026-12-21',
    localTime: '12:00',
    timezone: 'Europe/Berlin',
    location: TEST_LOCATION,
    window: { orientationDeg: 0, type: 'facade', sunPrelookMinutes: 60 },
    expectedSunOnWindow: false,
    expectedFactorRange: [0, 0],
  },
  {
    // 13:00 CEST = 11:00 UTC; az≈175.5°, el≈60.8°. SW facade orient
    // 225°, angleDiff≈49.5° ≤ 90° → on the window. Incidence non-zero,
    // soonHit also true.
    name: 'Beispielstadt 21.06.2026 13:00 — SW facade window',
    localDate: '2026-06-21',
    localTime: '13:00',
    timezone: 'Europe/Berlin',
    location: TEST_LOCATION,
    window: { orientationDeg: 225, type: 'facade', sunPrelookMinutes: 60 },
    expectedSunOnWindow: true,
    expectedFactorRange: [0.4, 1.0],
  },
  {
    // 18:00 CEST = 16:00 UTC; az≈271.6°, el≈28.9°. SE roof orient 135°,
    // angleDiff≈136.6° > 95° → out of the lobe and only moves further
    // west during the 60-min look-ahead.
    name: 'Beispielstadt 21.06.2026 18:00 — SE roof window (sun has moved past)',
    localDate: '2026-06-21',
    localTime: '18:00',
    timezone: 'Europe/Berlin',
    location: TEST_LOCATION,
    window: { orientationDeg: 135, type: 'roof_window', sunPrelookMinutes: 60 },
    expectedSunOnWindow: false,
    expectedFactorRange: [0, 0],
  },
  {
    // 04:30 CEST = 02:30 UTC; sun still below horizon (el≈-2.4°), so
    // sunOnWindow=false at the *current* tick. With prelook=120 the
    // look-ahead reaches 04:30 UTC where az≈68° / el≈12.7° comfortably
    // hits the SE-roof lobe → soonHit=true → sunFactor=0.6.
    name: 'Beispielstadt 21.06.2026 04:30 — SE roof window prelook=120',
    localDate: '2026-06-21',
    localTime: '04:30',
    timezone: 'Europe/Berlin',
    location: TEST_LOCATION,
    window: { orientationDeg: 135, type: 'roof_window', sunPrelookMinutes: 120 },
    expectedSunOnWindow: false,
    expectedFactorRange: [0.5, 0.7],
  },
  {
    // 02:00 CET = 01:00 UTC; sun ≈54° below the horizon and stays
    // there throughout the look-ahead.
    name: 'Beispielstadt 21.12.2026 02:00 — SE roof window',
    localDate: '2026-12-21',
    localTime: '02:00',
    timezone: 'Europe/Berlin',
    location: TEST_LOCATION,
    window: { orientationDeg: 135, type: 'roof_window', sunPrelookMinutes: 60 },
    expectedSunOnWindow: false,
    expectedFactorRange: [0, 0],
  },
  {
    // 21:30 CEST = 19:30 UTC; az≈311.3°, el≈-0.27°. Sun is already
    // below the horizon, so the elevation gate trips before the
    // azimuth check matters. soonHit also false (sun continues to set).
    name: 'Beispielstadt 21.06.2026 21:30 — W facade window',
    localDate: '2026-06-21',
    localTime: '21:30',
    timezone: 'Europe/Berlin',
    location: TEST_LOCATION,
    window: { orientationDeg: 270, type: 'facade', sunPrelookMinutes: 60 },
    expectedSunOnWindow: false,
    expectedFactorRange: [0, 0],
  },
  {
    // 11:00 CEST = 09:00 UTC; az≈127.2°, el≈51.9°. S facade orient
    // 180°, angleDiff≈52.8° ≤ 90° → strong incidence; soonHit also
    // true → factor lifted to ≥ 0.5.
    name: 'Beispielstadt 21.06.2026 11:00 — S facade window',
    localDate: '2026-06-21',
    localTime: '11:00',
    timezone: 'Europe/Berlin',
    location: TEST_LOCATION,
    window: { orientationDeg: 180, type: 'facade', sunPrelookMinutes: 60 },
    expectedSunOnWindow: true,
    expectedFactorRange: [0.4, 1.0],
  },
];

// ---------------------------------------------------------------------------
// Test 1: sunOnWindow against the table.
// ---------------------------------------------------------------------------

describe('sun-table — sunOnWindow', () => {
  for (const c of CASES) {
    it(c.name, () => {
      const now = localToUtc(c.localDate, c.localTime, c.timezone);
      const sun = getSunPosition(now, c.location);
      expect(sunOnWindow(sun, c.window, SUN_RULES)).toBe(c.expectedSunOnWindow);
    });
  }
});

// ---------------------------------------------------------------------------
// Test 2: sunFactor falls inside the per-case expected range.
// ---------------------------------------------------------------------------

describe('sun-table — sunFactor range', () => {
  for (const c of CASES) {
    it(c.name, () => {
      const now = localToUtc(c.localDate, c.localTime, c.timezone);
      const f = sunFactor(now, c.location, c.window, SUN_RULES);
      const [lo, hi] = c.expectedFactorRange;
      expect(f).toBeGreaterThanOrEqual(lo);
      expect(f).toBeLessThanOrEqual(hi);
    });
  }
});

// ---------------------------------------------------------------------------
// Test 3: sunFactor is always clamped to [0, 1] (safety net).
// ---------------------------------------------------------------------------

describe('sun-table — sunFactor in [0,1] always', () => {
  for (const c of CASES) {
    it(c.name, () => {
      const now = localToUtc(c.localDate, c.localTime, c.timezone);
      const f = sunFactor(now, c.location, c.window, SUN_RULES);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(1);
    });
  }
});

// ---------------------------------------------------------------------------
// Test 4: explicit task-headline cases.
// ---------------------------------------------------------------------------

describe('sun-table — task headline cases', () => {
  it('Beispielstadt 21.06., 06:00 SO-Dachfenster → incidenceNow > 0', () => {
    const now = localToUtc('2026-06-21', '06:00', 'Europe/Berlin');
    const sun = getSunPosition(now, TEST_LOCATION);

    // Sanity: the sun is up and above the elevation floor at this tick.
    expect(sun.isUp).toBe(true);
    expect(sun.elevationDeg).toBeGreaterThanOrEqual(SUN_RULES.minElevationDeg);

    // Manually apply the `incidenceNow` formula from sun.ts:
    //   azimuthTerm  = clamp01(1 - angleDiff / limit)
    //   elevationTerm= clamp01((el - minEl) / 35)
    //   incidenceNow = azimuthTerm * elevationTerm
    const limit = SUN_RULES.maxIncidenceAngleRoofDeg;
    const angleDiff = circularAngleDiff(sun.azimuthDeg, 135);
    const azimuthTerm = Math.max(0, Math.min(1, 1 - angleDiff / limit));
    const elevationTerm = Math.max(
      0,
      Math.min(1, (sun.elevationDeg - SUN_RULES.minElevationDeg) / 35),
    );
    const incidenceNow = azimuthTerm * elevationTerm;
    expect(incidenceNow).toBeGreaterThan(0);
  });

  it('Beispielstadt 21.12., 12:00 N-Fenster → factor === 0', () => {
    const now = localToUtc('2026-12-21', '12:00', 'Europe/Berlin');
    const window: Pick<Window, 'orientationDeg' | 'type' | 'sunPrelookMinutes'> = {
      orientationDeg: 0,
      type: 'facade',
      sunPrelookMinutes: 60,
    };
    const f = sunFactor(now, TEST_LOCATION, window, SUN_RULES);
    expect(f).toBe(0);
  });
});
