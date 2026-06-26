/**
 * Heat Shield — astronomical sun module (Task 4.1).
 *
 * This module is a thin, pure wrapper around `suncalc` that adapts the
 * library's conventions to the plugin's:
 *
 *   1. Azimuth convention (regelwerk §3.5):
 *        suncalc returns azimuth in radians, with **0 = South** and
 *        positive towards West (so PI/2 = West, -PI/2 = East).
 *        Heat Shield uses **0° = North, 90° = East, 180° = South,
 *        270° = West** — the standard surveyor / weather convention.
 *      Conversion: `azimuthDeg = (suncalc.azimuth * 180/PI + 180 + 360) % 360`.
 *
 *   2. `dayBoundsLocal(date, timezone)` returns the UTC instants for
 *      00:00 and 24:00 of the **local civil day** that contains `date`
 *      in the given IANA `timezone`. Implementation uses Node's built-in
 *      `Intl.DateTimeFormat` (no external tz library) and iterates once
 *      to handle DST transitions correctly. See the inline comment on
 *      `localMidnightAsUtc` for the algorithm.
 *
 *   3. `getSunDay` defends against polar day / polar night by inspecting
 *      `getTimes` for `Invalid Date` and falling back to the altitude at
 *      `solarNoon`. Beispielstadt never trips this (52.52°N is well below
 *      the polar circle), but the engine runs the same code for any
 *      configured location.
 *
 * Module rules:
 *   - Pure: no fs, no logging, no Connect API artifacts, no globals.
 *   - Strict TS (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`).
 *   - The `suncalc` import uses the **default import** pattern. Although
 *     the original task brief suggested `import * as SunCalc from 'suncalc'`
 *     and `esModuleInterop`, that pattern fails at runtime under Node's
 *     NodeNext ESM loader because suncalc is a `module.exports = X`-style
 *     CJS module with no named exports detectable by `cjs-module-lexer`.
 *     The default-import form is the only one that works at runtime; it
 *     also passes strict TS thanks to the `@types/suncalc` declarations.
 */

import SunCalc from 'suncalc';

import type { Location, SunRules, Window } from '../../shared/types.js';

// ---------------------------------------------------------------------------
// Public types.
// ---------------------------------------------------------------------------

/**
 * Sun position at a given UTC instant for a given lat/lon.
 *
 * `azimuthDeg` follows the heat-shield convention (0° = North, 90° = East,
 * 180° = South, 270° = West) — NOT suncalc's south-zero convention.
 * `elevationDeg` is the apparent altitude in degrees above the horizon
 * (negative when the sun is below the horizon). `isUp` is `true` whenever
 * `elevationDeg > 0`.
 */
export interface SunPosition {
  readonly azimuthDeg: number;
  readonly elevationDeg: number;
  readonly isUp: boolean;
}

/**
 * Per-day astronomical key events for a location, all expressed as UTC
 * instants. Fields can be `null` near the polar circles where the sun
 * does not rise or set on the given calendar day; in that case
 * `isPolarDay` / `isPolarNight` is set so the orchestrator can pick the
 * right branch without re-running the calculation.
 */
export interface SunDayKey {
  readonly sunriseUtc: Date | null;
  readonly sunsetUtc: Date | null;
  readonly solarNoonUtc: Date | null;
  readonly isPolarDay: boolean;
  readonly isPolarNight: boolean;
}

// ---------------------------------------------------------------------------
// Sun position.
// ---------------------------------------------------------------------------

const RAD_TO_DEG = 180 / Math.PI;

/**
 * Compute the sun's azimuth and elevation at `now` for the given location.
 *
 * Output is normalised to the heat-shield azimuth convention
 * (0° = N, 90° = E, 180° = S, 270° = W) — see module-level comment.
 */
export function getSunPosition(
  now: Date,
  location: Pick<Location, 'latitude' | 'longitude'>,
): SunPosition {
  const pos = SunCalc.getPosition(now, location.latitude, location.longitude);
  // suncalc: azimuth is 0 = south, +west; convert to N=0 / E=90 / S=180 / W=270.
  const azimuthDeg = (pos.azimuth * RAD_TO_DEG + 180 + 360) % 360;
  const elevationDeg = pos.altitude * RAD_TO_DEG;
  return {
    azimuthDeg,
    elevationDeg,
    isUp: elevationDeg > 0,
  };
}

// ---------------------------------------------------------------------------
// Per-day key events.
// ---------------------------------------------------------------------------

function isInvalidDate(d: Date): boolean {
  return Number.isNaN(d.getTime());
}

/**
 * Wraps `suncalc.getTimes`. Returns `null` for any time that suncalc
 * could not compute (returned as `Invalid Date`); in that case the
 * `isPolarDay` / `isPolarNight` flags are derived from the altitude at
 * solar noon so callers can branch on a single boolean.
 */
export function getSunDay(
  date: Date,
  location: Pick<Location, 'latitude' | 'longitude'>,
): SunDayKey {
  const t = SunCalc.getTimes(date, location.latitude, location.longitude);

  const sunriseUtc = isInvalidDate(t.sunrise) ? null : t.sunrise;
  const sunsetUtc = isInvalidDate(t.sunset) ? null : t.sunset;
  const solarNoonUtc = isInvalidDate(t.solarNoon) ? null : t.solarNoon;

  // Polar-day / polar-night detection. We only consider it polar if both
  // sunrise and sunset are missing on this calendar day. We then probe
  // the altitude at solar noon (or, if noon is also missing, at the
  // input `date` as a defensive fallback).
  let isPolarDay = false;
  let isPolarNight = false;
  if (sunriseUtc === null && sunsetUtc === null) {
    const probe = solarNoonUtc ?? date;
    const noonAltitudeDeg = getSunPosition(probe, location).elevationDeg;
    if (noonAltitudeDeg > 0) {
      isPolarDay = true;
    } else if (noonAltitudeDeg < 0) {
      isPolarNight = true;
    }
  }

  return {
    sunriseUtc,
    sunsetUtc,
    solarNoonUtc,
    isPolarDay,
    isPolarNight,
  };
}

// ---------------------------------------------------------------------------
// Local civil day boundaries.
// ---------------------------------------------------------------------------

interface LocalParts {
  readonly year: number;
  readonly month: number; // 1..12
  readonly day: number; // 1..31
  readonly hour: number; // 0..23
  readonly minute: number; // 0..59
  readonly second: number; // 0..59
}

const PARTS_FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timezone: string): Intl.DateTimeFormat {
  const cached = PARTS_FORMATTER_CACHE.get(timezone);
  if (cached !== undefined) {
    return cached;
  }
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
  PARTS_FORMATTER_CACHE.set(timezone, fmt);
  return fmt;
}

/**
 * Decompose `instant` into wall-clock parts in the given IANA timezone.
 * Throws if the timezone string is not accepted by `Intl.DateTimeFormat`.
 */
function localPartsAt(instant: Date, timezone: string): LocalParts {
  const parts = partsFormatter(timezone).formatToParts(instant);
  let year = 0;
  let month = 0;
  let day = 0;
  let hour = 0;
  let minute = 0;
  let second = 0;
  for (const p of parts) {
    switch (p.type) {
      case 'year':
        year = Number.parseInt(p.value, 10);
        break;
      case 'month':
        month = Number.parseInt(p.value, 10);
        break;
      case 'day':
        day = Number.parseInt(p.value, 10);
        break;
      case 'hour':
        // Some ICU builds emit "24" for midnight when hour12 is false.
        hour = Number.parseInt(p.value, 10) % 24;
        break;
      case 'minute':
        minute = Number.parseInt(p.value, 10);
        break;
      case 'second':
        second = Number.parseInt(p.value, 10);
        break;
      default:
        // ignore literals, dayPeriod, etc.
        break;
    }
  }
  return { year, month, day, hour, minute, second };
}

/**
 * Returns the UTC offset (in milliseconds) of `timezone` at `instant`.
 * A positive value means the local wall clock is ahead of UTC.
 *
 * The math is: take the wall-clock parts in the target timezone, encode
 * them as if they were UTC, and subtract the original instant.
 */
function utcOffsetMs(instant: Date, timezone: string): number {
  const p = localPartsAt(instant, timezone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - instant.getTime();
}

/**
 * UTC instant corresponding to local 00:00:00 on (`year`,`month`,`day`)
 * in `timezone`. Iterates twice on the offset so DST transitions behave
 * correctly.
 *
 * Algorithm:
 *   1. Naively encode (y,m,d,0,0,0) as UTC → first guess `t0`.
 *   2. Compute the timezone's offset at `t0`.
 *   3. Subtract that offset → second guess `t1`. This is correct unless
 *      we crossed a DST boundary between `t0` and `t1`.
 *   4. Recompute the offset at `t1` and apply once more. After two
 *      iterations we've converged for any real-world IANA zone.
 */
function localMidnightAsUtc(
  year: number,
  month: number,
  day: number,
  timezone: string,
): Date {
  const naiveUtcMs = Date.UTC(year, month - 1, day, 0, 0, 0);
  // First correction.
  let offset = utcOffsetMs(new Date(naiveUtcMs), timezone);
  let candidate = new Date(naiveUtcMs - offset);
  // Second correction (handles DST spring-forward / fall-back boundaries).
  offset = utcOffsetMs(candidate, timezone);
  candidate = new Date(naiveUtcMs - offset);
  return candidate;
}

/**
 * Computes the start (00:00 local) and end (24:00 local = next-day
 * 00:00 local) of the civil day in `timezone` that contains `date`,
 * each expressed as a UTC instant.
 *
 * DST transitions are handled by `localMidnightAsUtc`. The bounds are
 * "fence-posts": `endUtc - startUtc` may be 23, 24 or 25 hours depending
 * on whether the day crosses a DST transition.
 */
export function dayBoundsLocal(
  date: Date,
  timezone: string,
): { startUtc: Date; endUtc: Date } {
  const local = localPartsAt(date, timezone);
  const startUtc = localMidnightAsUtc(local.year, local.month, local.day, timezone);
  // To get the next day's local midnight we add one day in UTC to the
  // calendar tuple (Date.UTC handles month/year roll-over automatically).
  const nextTuple = new Date(Date.UTC(local.year, local.month - 1, local.day + 1));
  const endUtc = localMidnightAsUtc(
    nextTuple.getUTCFullYear(),
    nextTuple.getUTCMonth() + 1,
    nextTuple.getUTCDate(),
    timezone,
  );
  return { startUtc, endUtc };
}

// ---------------------------------------------------------------------------
// Convenience.
// ---------------------------------------------------------------------------

/**
 * Convenience helper that returns `true` iff the sun is currently above
 * the horizon for the given location. The `timezone` argument is
 * accepted for symmetry with the rest of the engine surface, but is not
 * actually consulted: `isUp` is purely a function of UTC instant +
 * lat/lon.
 */
export function isDaylight(
  now: Date,
  location: Pick<Location, 'latitude' | 'longitude'>,
  _timezone: string,
): boolean {
  return getSunPosition(now, location).isUp;
}

// ---------------------------------------------------------------------------
// Window incidence — angle math, instantaneous hit, and short look-ahead.
// ---------------------------------------------------------------------------

/**
 * File-local helper. Mirrors the textbook `min(max(x, 0), 1)` idiom but is
 * spelled out so callers do not have to import a third-party clamp.
 */
function clamp01(x: number): number {
  if (Number.isNaN(x)) {
    return 0;
  }
  if (x <= 0) {
    return 0;
  }
  if (x >= 1) {
    return 1;
  }
  return x;
}

/**
 * Normalise an angle in degrees into the half-open range `[0, 360)`. Works
 * for negative inputs and for inputs ≥ 360. JavaScript's `%` operator can
 * return negative values for negative inputs, so the `(x % 360 + 360) % 360`
 * idiom is required.
 */
function normaliseDeg(x: number): number {
  return ((x % 360) + 360) % 360;
}

/**
 * Smallest angular distance in degrees between two compass bearings.
 *
 * The result lies in `[0, 180]`. Inputs may be negative or ≥ 360; both
 * are normalised first so callers do not have to pre-process. The core
 * is the well-known `((Δ + 540) mod 360) − 180` trick which produces a
 * signed difference in `[-180, 180)`; we take the absolute value to get
 * the smallest unsigned arc.
 *
 * Examples (regelwerk §6.5):
 *   circularAngleDiff(350, 10)  === 20
 *   circularAngleDiff(170, 10)  === 160
 *   circularAngleDiff(180, 0)   === 180
 *   circularAngleDiff(-10, 350) === 0
 */
export function circularAngleDiff(a: number, b: number): number {
  const an = normaliseDeg(a);
  const bn = normaliseDeg(b);
  return Math.abs(((an - bn + 540) % 360) - 180);
}

/**
 * Pick the per-window azimuth tolerance from `sunRules`. Roof windows
 * see the sun across a slightly wider arc because the glass is tilted
 * upwards (regelwerk §6.4 / design.md §10).
 */
function incidenceLimit(
  windowType: Window['type'],
  sunRules: Pick<SunRules, 'maxIncidenceAngleFacadeDeg' | 'maxIncidenceAngleRoofDeg'>,
): number {
  return windowType === 'roof_window'
    ? sunRules.maxIncidenceAngleRoofDeg
    : sunRules.maxIncidenceAngleFacadeDeg;
}

/**
 * Boolean predicate: is the sun currently shining on the window?
 *
 * Returns `false` when the sun is below the configured minimum elevation
 * or below the horizon outright. Otherwise compares the azimuth-to-window
 * deviation against the type-specific incidence limit (façade vs roof).
 *
 * Pure: depends only on the supplied `SunPosition`. Time-stepping for
 * look-ahead is handled by `sunOnWindowSoon`.
 */
export function sunOnWindow(
  sun: SunPosition,
  window: Pick<Window, 'orientationDeg' | 'type'>,
  sunRules: Pick<
    SunRules,
    'minElevationDeg' | 'maxIncidenceAngleFacadeDeg' | 'maxIncidenceAngleRoofDeg'
  >,
): boolean {
  if (!sun.isUp) {
    return false;
  }
  if (sun.elevationDeg < sunRules.minElevationDeg) {
    return false;
  }
  const limit = incidenceLimit(window.type, sunRules);
  const angleDiff = circularAngleDiff(sun.azimuthDeg, window.orientationDeg);
  return angleDiff <= limit;
}

/**
 * Look-ahead predicate: will the sun hit the window at any tick in
 * `[now, now + sunPrelookMinutes]`?
 *
 * The interval is sampled inclusive-inclusive in `stepMinutes` steps
 * (default 5). Each tick computes a fresh `SunPosition` and reuses the
 * `sunOnWindow` predicate. The first hit short-circuits the loop.
 *
 * Implementation notes:
 *   - The fence-post layout matters: for prelook = 60 and step = 5 we
 *     check 13 ticks (0, 5, 10, …, 60). The last tick is `now + prelook`
 *     itself so a hit that occurs exactly at the horizon is not missed.
 *   - We add a tiny `+ stepMs / 2` slack to the loop guard to absorb
 *     IEEE-754 drift; the loop is otherwise driven by integer ms.
 */
export function sunOnWindowSoon(
  now: Date,
  location: Pick<Location, 'latitude' | 'longitude'>,
  window: Pick<Window, 'orientationDeg' | 'type' | 'sunPrelookMinutes'>,
  sunRules: Pick<
    SunRules,
    'minElevationDeg' | 'maxIncidenceAngleFacadeDeg' | 'maxIncidenceAngleRoofDeg'
  >,
  opts?: { stepMinutes?: number },
): boolean {
  const stepMinutes = opts?.stepMinutes ?? 5;
  const stepMs = stepMinutes * 60 * 1000;
  const startMs = now.getTime();
  const endMs = startMs + window.sunPrelookMinutes * 60 * 1000;
  for (let t = startMs; t <= endMs + stepMs / 2; t += stepMs) {
    const sun = getSunPosition(new Date(t), location);
    if (sunOnWindow(sun, window, sunRules)) {
      return true;
    }
  }
  return false;
}

/**
 * Continuous sun-incidence factor in `[0, 1]` per design.md §Property 2.
 *
 * Combines two ingredients:
 *   - `incidenceNow`: how squarely the sun hits the window right now,
 *     scaled by elevation. The 35° elevation span between
 *     `minElevationDeg` and `minElevationDeg + 35°` covers the relevant
 *     range for a Central-European summer day; sun above that
 *     contributes the full elevation factor.
 *   - `soonHit`: did the look-ahead find any tick that satisfies
 *     `sunOnWindow`?
 *
 * Combining rule (verbatim from design.md):
 *   - if `incidenceNow > 0`: `max(incidenceNow, soonHit ? 0.5 : 0)`
 *   - else if `soonHit`: 0.6
 *   - else: 0
 *
 * The constants are chosen so that an imminent sun hit yields a
 * stronger pre-shading signal (0.6) than a borderline current hit
 * (0.5), matching the Heat-Shield "act before it heats up" principle.
 */
export function sunFactor(
  now: Date,
  location: Pick<Location, 'latitude' | 'longitude'>,
  window: Pick<Window, 'orientationDeg' | 'type' | 'sunPrelookMinutes'>,
  sunRules: SunRules,
): number {
  const sun = getSunPosition(now, location);

  let incidenceNow = 0;
  if (sun.isUp && sun.elevationDeg >= sunRules.minElevationDeg) {
    const limit = incidenceLimit(window.type, sunRules);
    const angleDiff = circularAngleDiff(sun.azimuthDeg, window.orientationDeg);
    const azimuthTerm = clamp01(1 - angleDiff / limit);
    const elevationTerm = clamp01((sun.elevationDeg - sunRules.minElevationDeg) / 35);
    incidenceNow = azimuthTerm * elevationTerm;
  }

  const soonHit = sunOnWindowSoon(now, location, window, sunRules);

  if (incidenceNow > 0) {
    return Math.max(incidenceNow, soonHit ? 0.5 : 0);
  }
  if (soonHit) {
    return 0.6;
  }
  return 0;
}
