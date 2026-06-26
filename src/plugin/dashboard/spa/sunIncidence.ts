/**
 * Frontend mirror of the engine's `sunOnWindow` / `sunOnWindowSoon`
 * predicates (Task 4). Pure functions over the inlined SPA
 * `getSunPosition`, so the dashboard can show a per-window sun status
 * ("besonnt" / "bald" / "abgewandt") without a backend round-trip.
 *
 * The maths intentionally matches `engine/sun.ts` (same azimuth
 * convention 0°=N, same elevation gate, same incidence limits) so
 * the displayed status agrees with the engine's actual decision.
 */

import { getSunPosition } from './components/sunPolarPlot.js';

export type SunWindowStatus = 'lit' | 'soon' | 'away';

export interface SunIncidenceParams {
  now: Date;
  latitude: number;
  longitude: number;
  orientationDeg: number;
  type: 'facade' | 'roof_window';
  sunPrelookMinutes: number;
  minElevationDeg: number;
  maxIncidenceAngleFacadeDeg: number;
  maxIncidenceAngleRoofDeg: number;
}

/** Smallest absolute angular difference between two bearings, in [0, 180]. */
export function circularAngleDiff(a: number, b: number): number {
  const raw = Math.abs(((a - b) % 360) + 360) % 360;
  return raw > 180 ? 360 - raw : raw;
}

function incidenceLimit(p: SunIncidenceParams): number {
  return p.type === 'roof_window'
    ? p.maxIncidenceAngleRoofDeg
    : p.maxIncidenceAngleFacadeDeg;
}

/** Is the sun currently shining on the window? Mirrors `sunOnWindow`. */
export function isSunOnWindow(p: SunIncidenceParams, at: Date): boolean {
  const sun = getSunPosition(at, p.latitude, p.longitude);
  if (sun.elevationDeg < p.minElevationDeg) {
    return false;
  }
  return circularAngleDiff(sun.azimuthDeg, p.orientationDeg) <= incidenceLimit(p);
}

/**
 * Status for the window-sun card:
 *   - `lit`  — sun on the window right now,
 *   - `soon` — not now, but within `sunPrelookMinutes` (5-min steps),
 *   - `away` — neither.
 */
export function windowSunStatus(p: SunIncidenceParams): SunWindowStatus {
  if (isSunOnWindow(p, p.now)) {
    return 'lit';
  }
  const stepMs = 5 * 60 * 1000;
  const startMs = p.now.getTime();
  const endMs = startMs + p.sunPrelookMinutes * 60 * 1000;
  for (let t = startMs; t <= endMs + stepMs / 2; t += stepMs) {
    if (isSunOnWindow(p, new Date(t))) {
      return 'soon';
    }
  }
  return 'away';
}
