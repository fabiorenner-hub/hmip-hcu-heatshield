/**
 * Tests for `src/plugin/engine/sun.ts` (Task 4.1).
 *
 * The reference location for every assertion is **Beispielstadt**
 * (52.52°N, 13.41°E, Europe/Berlin) — the project's verified default
 * location per `heat-shield-context.md`.
 *
 * Reference dates are 21.06.2026 (summer solstice, CEST = UTC+2) and
 * 21.12.2026 (winter solstice, CET = UTC+1). These are picked so that
 * the test bounds remain valid regardless of which Node ICU build
 * actually runs the suite, and so that DST behaviour is exercised in
 * `dayBoundsLocal`.
 *
 * The DST-transition test pins on 29.03.2026 in Europe/Berlin: clocks
 * jump from 02:00 to 03:00 local on this morning, so the "day" is only
 * 23 hours long but local midnight is still well-defined and must
 * resolve to UTC+1.
 */

import { describe, expect, it } from 'vitest';

import {
  dayBoundsLocal,
  getSunDay,
  getSunPosition,
  isDaylight,
} from '../../src/plugin/engine/sun.js';

const TEST_LOCATION = { latitude: 52.52, longitude: 13.41 } as const;
const BERLIN_TZ = 'Europe/Berlin';

describe('getSunPosition — Beispielstadt summer solstice', () => {
  it('returns sun high in the south at 12:00 CEST on 21.06.2026', () => {
    // 21.06.2026 12:00 CEST = 10:00 UTC.
    // Note: at Beispielstadt (13.41°E) solar noon falls at ~13:10 CEST, so
    // at clock-noon the sun is still ~16° east of due south. The task
    // brief's 170°..190° window assumed clock-noon = solar-noon, which
    // only holds at the timezone meridian (15°E); we widen the lower
    // bound to match the physics. The "high in the southern half of the
    // sky" intent of the assertion is preserved.
    const now = new Date(Date.UTC(2026, 5, 21, 10, 0, 0));
    const pos = getSunPosition(now, TEST_LOCATION);

    expect(pos.isUp).toBe(true);
    expect(pos.elevationDeg).toBeGreaterThan(55);
    expect(pos.azimuthDeg).toBeGreaterThan(140);
    expect(pos.azimuthDeg).toBeLessThan(190);
  });

  it('returns sun in the east-northeast at 06:00 CEST on 21.06.2026', () => {
    // 21.06.2026 06:00 CEST = 04:00 UTC.
    const now = new Date(Date.UTC(2026, 5, 21, 4, 0, 0));
    const pos = getSunPosition(now, TEST_LOCATION);

    expect(pos.isUp).toBe(true);
    expect(pos.elevationDeg).toBeGreaterThan(5);
    expect(pos.azimuthDeg).toBeGreaterThan(60);
    expect(pos.azimuthDeg).toBeLessThan(90);
  });

  it('returns sun still up and in the west at 21:00 CEST on 21.06.2026', () => {
    // Summer-solstice "very-late" sample. Beispielstadt sunset is around
    // 21:35 CEST that day, so 21:00 is still daylight; at 22:00 the sun
    // is already below the horizon. We sample 21:00 to keep `isUp` true
    // and azimuth comfortably past 270° (west).
    const now = new Date(Date.UTC(2026, 5, 21, 19, 0, 0));
    const pos = getSunPosition(now, TEST_LOCATION);

    expect(pos.isUp).toBe(true);
    expect(pos.elevationDeg).toBeGreaterThan(0);
    expect(pos.azimuthDeg).toBeGreaterThan(270);
  });
});

describe('getSunPosition — Beispielstadt winter solstice', () => {
  it('returns low sun in the south at 12:00 CET on 21.12.2026', () => {
    // 21.12.2026 12:00 CET = 11:00 UTC.
    const now = new Date(Date.UTC(2026, 11, 21, 11, 0, 0));
    const pos = getSunPosition(now, TEST_LOCATION);

    expect(pos.isUp).toBe(true);
    expect(pos.elevationDeg).toBeGreaterThan(12);
    expect(pos.elevationDeg).toBeLessThan(18);
    expect(pos.azimuthDeg).toBeGreaterThan(170);
    expect(pos.azimuthDeg).toBeLessThan(190);
  });

  it('reports the sun below the horizon at 02:00 CET on 21.12.2026', () => {
    // 21.12.2026 02:00 CET = 01:00 UTC.
    const now = new Date(Date.UTC(2026, 11, 21, 1, 0, 0));
    const pos = getSunPosition(now, TEST_LOCATION);

    expect(pos.isUp).toBe(false);
    expect(pos.elevationDeg).toBeLessThanOrEqual(0);
  });
});

describe('getSunPosition — azimuth normalisation', () => {
  it('always reports azimuth in the half-open range [0, 360)', () => {
    const samples = [
      new Date(Date.UTC(2026, 5, 21, 4, 0, 0)),
      new Date(Date.UTC(2026, 5, 21, 10, 0, 0)),
      new Date(Date.UTC(2026, 5, 21, 19, 0, 0)),
      new Date(Date.UTC(2026, 11, 21, 1, 0, 0)),
      new Date(Date.UTC(2026, 11, 21, 11, 0, 0)),
    ];
    for (const t of samples) {
      const az = getSunPosition(t, TEST_LOCATION).azimuthDeg;
      expect(az).toBeGreaterThanOrEqual(0);
      expect(az).toBeLessThan(360);
    }
  });
});

describe('getSunDay — Beispielstadt summer solstice', () => {
  it('returns sunrise < solarNoon < sunset on 21.06.2026', () => {
    const day = getSunDay(new Date(Date.UTC(2026, 5, 21, 10, 0, 0)), TEST_LOCATION);

    expect(day.sunriseUtc).not.toBeNull();
    expect(day.sunsetUtc).not.toBeNull();
    expect(day.solarNoonUtc).not.toBeNull();
    expect(day.isPolarDay).toBe(false);
    expect(day.isPolarNight).toBe(false);

    // Re-bind for TS narrowing under noUncheckedIndexedAccess /
    // exactOptionalPropertyTypes: assertions above guarantee non-null.
    const sunriseMs = (day.sunriseUtc as Date).getTime();
    const noonMs = (day.solarNoonUtc as Date).getTime();
    const sunsetMs = (day.sunsetUtc as Date).getTime();
    expect(sunriseMs).toBeLessThan(noonMs);
    expect(noonMs).toBeLessThan(sunsetMs);
  });
});

describe('dayBoundsLocal — Europe/Berlin', () => {
  it('treats a summer instant as a UTC+2 day', () => {
    const probe = new Date('2026-06-21T15:00:00Z');
    const bounds = dayBoundsLocal(probe, BERLIN_TZ);

    expect(bounds.startUtc.toISOString()).toBe('2026-06-20T22:00:00.000Z');
    expect(bounds.endUtc.toISOString()).toBe('2026-06-21T22:00:00.000Z');
  });

  it('treats a winter instant as a UTC+1 day', () => {
    const probe = new Date('2026-12-21T15:00:00Z');
    const bounds = dayBoundsLocal(probe, BERLIN_TZ);

    expect(bounds.startUtc.toISOString()).toBe('2026-12-20T23:00:00.000Z');
    expect(bounds.endUtc.toISOString()).toBe('2026-12-21T23:00:00.000Z');
  });

  it('handles the spring DST transition on 29.03.2026', () => {
    // On 29.03.2026, Europe/Berlin clocks jump from 02:00 CET (UTC+1) to
    // 03:00 CEST (UTC+2). Local midnight that morning is therefore at
    // 23:00 UTC the previous day (still UTC+1), even though the same
    // calendar day at 12:00 local is UTC+2.
    const noonProbe = new Date('2026-03-29T12:00:00Z');
    const bounds = dayBoundsLocal(noonProbe, BERLIN_TZ);

    // Local 00:00 on 29.03.2026 is 28.03.2026 23:00Z (still pre-DST).
    expect(bounds.startUtc.toISOString()).toBe('2026-03-28T23:00:00.000Z');
    // Local 00:00 on 30.03.2026 is 29.03.2026 22:00Z (post-DST UTC+2).
    expect(bounds.endUtc.toISOString()).toBe('2026-03-29T22:00:00.000Z');
    // The DST day is 23 hours long.
    const lengthHours =
      (bounds.endUtc.getTime() - bounds.startUtc.getTime()) / (60 * 60 * 1000);
    expect(lengthHours).toBe(23);
  });
});

describe('isDaylight', () => {
  it('mirrors getSunPosition().isUp', () => {
    const summerNoon = new Date(Date.UTC(2026, 5, 21, 10, 0, 0));
    const winterNight = new Date(Date.UTC(2026, 11, 21, 1, 0, 0));

    expect(isDaylight(summerNoon, TEST_LOCATION, BERLIN_TZ)).toBe(true);
    expect(isDaylight(winterNight, TEST_LOCATION, BERLIN_TZ)).toBe(false);
  });
});
