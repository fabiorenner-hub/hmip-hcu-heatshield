/**
 * Heat Shield — sun-arc scrubbing / simulation helpers
 * (predictive-control-dashboard Task 16, Requirement 10, Property 18).
 *
 * The simulation mode is PURELY client-side: dragging the sun arc only
 * recomputes the sun position, facade exposure, shadow geometry and the
 * already-loaded planned positions for the scrubbed instant. It NEVER
 * issues a control request to the engine.
 *
 * This module is intentionally free of any network access. The
 * {@link runScrubSession} helper takes an injected `control` sink only so
 * the property test can assert it is never invoked during scrubbing.
 */

import { getSunPosition } from '../sunPolarPlot.js';
import type { FacadeKey, PlannedAction } from '../../types.js';

export interface ScrubInputs {
  latitude: number;
  longitude: number;
  /** Cloud cover in [0,1]. */
  cloud01: number;
  /** PV-Sonnenindex in [0,1]. */
  pvSonnenindex01: number;
  /** The already-loaded plan (read-only) to surface scheduled positions. */
  plannedActions: PlannedAction[];
}

export interface ScrubFrame {
  ts: string;
  sun: { azimuthDeg: number; elevationDeg: number };
  facades: Record<FacadeKey, number>;
  /** Planned positions that apply at or before the scrubbed instant. */
  activePlanned: PlannedAction[];
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Smallest absolute angular difference between two bearings, in [0,180]. */
function circularAngleDiff(a: number, b: number): number {
  const raw = (Math.abs(((a - b) % 360) + 360) % 360);
  return raw > 180 ? 360 - raw : raw;
}

/**
 * Facade exposure in percent (0..100) for a facade orientation. Mirrors the
 * engine's `facadeExposure01` so the simulated overlay agrees with the
 * backend snapshot.
 */
export function facadeExposurePercent(
  sun: { azimuthDeg: number; elevationDeg: number },
  facadeOrientationDeg: number,
  cloud01: number,
  pvSunIndex01: number,
): number {
  if (sun.elevationDeg <= 0) {
    return 0;
  }
  const angle = circularAngleDiff(sun.azimuthDeg, facadeOrientationDeg);
  const azimuthTerm = clamp01(1 - angle / 90);
  const elevationTerm = clamp01(sun.elevationDeg / 60);
  const cloudFactor = 1 - 0.7 * clamp01(cloud01);
  const sunSupport = 0.4 + 0.6 * clamp01(pvSunIndex01);
  return Math.round(
    clamp01(azimuthTerm * elevationTerm * cloudFactor * sunSupport) * 100,
  );
}

const FACADE_DEG: Record<FacadeKey, number> = { N: 0, E: 90, S: 180, W: 270 };

/**
 * Compute a single read-only simulation frame for the scrubbed instant.
 * Pure: no network, no control side effects.
 */
export function computeScrubFrame(tSim: Date, inputs: ScrubInputs): ScrubFrame {
  const sun = getSunPosition(tSim, inputs.latitude, inputs.longitude);
  const facades: Record<FacadeKey, number> = {
    N: facadeExposurePercent(sun, FACADE_DEG.N, inputs.cloud01, inputs.pvSonnenindex01),
    E: facadeExposurePercent(sun, FACADE_DEG.E, inputs.cloud01, inputs.pvSonnenindex01),
    S: facadeExposurePercent(sun, FACADE_DEG.S, inputs.cloud01, inputs.pvSonnenindex01),
    W: facadeExposurePercent(sun, FACADE_DEG.W, inputs.cloud01, inputs.pvSonnenindex01),
  };
  const tMs = tSim.getTime();
  const activePlanned = inputs.plannedActions.filter(
    (a) => Date.parse(a.scheduledTs) <= tMs,
  );
  return {
    ts: tSim.toISOString(),
    sun: { azimuthDeg: sun.azimuthDeg, elevationDeg: sun.elevationDeg },
    facades,
    activePlanned,
  };
}

/** True iff a URL points at a control/setShutter endpoint. */
export function isControlEndpoint(url: string): boolean {
  return /\/api\/control\//.test(url) || /setShutter/i.test(url);
}

export interface ScrubSessionDeps {
  inputs: ScrubInputs;
  /**
   * Control sink — present ONLY so tests can assert it is never invoked.
   * The scrub session never calls it (Requirement 10.4 / Property 18).
   */
  control?: (url: string) => void;
}

/**
 * Process a sequence of scrub instants, returning a read-only frame for
 * each. By contract this NEVER calls `deps.control` — scrubbing is a pure,
 * client-side recomputation (Property 18).
 */
export function runScrubSession(
  times: ReadonlyArray<Date>,
  deps: ScrubSessionDeps,
): ScrubFrame[] {
  const frames: ScrubFrame[] = [];
  for (const t of times) {
    frames.push(computeScrubFrame(t, deps.inputs));
  }
  return frames;
}
