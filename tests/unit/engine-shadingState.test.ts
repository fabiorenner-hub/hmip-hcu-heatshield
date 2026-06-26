/**
 * Tests for the per-window shading FSM
 * (`src/plugin/engine/shadingState.ts`, Task 3.1).
 *
 * Coverage:
 *   - open → shaded only when load ≥ activate AND direct sun.
 *   - open stays open below activate or without sun.
 *   - shaded → open immediately when the sun moves off the window.
 *   - shaded holds for releaseHoldMinutes once load ≤ release, then opens.
 *   - the hold timer resets when load climbs back above release.
 *   - separate activate/release thresholds form a hysteresis band.
 */

import { describe, expect, it } from 'vitest';

import {
  initialShadeRuntime,
  nextShadeState,
  type WindowShadeRuntime,
} from '../../src/plugin/engine/shadingState.js';

const ACTIVATE = 0.45;
const RELEASE = 0.3;
const HOLD = 60;

function at(min: number): Date {
  return new Date(Date.UTC(2026, 5, 22, 8, 0, 0) + min * 60_000);
}

function step(
  prev: WindowShadeRuntime,
  min: number,
  load01: number,
  hasDirectSun: boolean,
): WindowShadeRuntime {
  return nextShadeState({
    prev,
    now: at(min),
    load01,
    hasDirectSun,
    activateThreshold: ACTIVATE,
    releaseThreshold: RELEASE,
    releaseHoldMinutes: HOLD,
  });
}

describe('shadingState — activation', () => {
  it('opens stay open below the activate threshold', () => {
    const r = step(initialShadeRuntime(), 0, 0.4, true);
    expect(r.state).toBe('open');
  });

  it('opens stay open without direct sun even at high load', () => {
    const r = step(initialShadeRuntime(), 0, 0.9, false);
    expect(r.state).toBe('open');
  });

  it('activates immediately when load ≥ activate and the sun is on the window', () => {
    const r = step(initialShadeRuntime(), 0, 0.5, true);
    expect(r.state).toBe('shaded');
    expect(r.shadedSince).toBe(at(0).toISOString());
    expect(r.belowReleaseSince).toBeNull();
  });
});

describe('shadingState — release (asymmetric hysteresis)', () => {
  it('releases immediately when the sun moves off the window', () => {
    const shaded = step(initialShadeRuntime(), 0, 0.6, true);
    const r = step(shaded, 5, 0.6, false);
    expect(r.state).toBe('open');
  });

  it('holds shaded while load is below release but the hold time has not elapsed', () => {
    const shaded = step(initialShadeRuntime(), 0, 0.6, true);
    const dropped = step(shaded, 10, 0.2, true); // load below release at t=10
    expect(dropped.state).toBe('shaded');
    expect(dropped.belowReleaseSince).toBe(at(10).toISOString());

    const stillHeld = step(dropped, 10 + HOLD - 1, 0.2, true);
    expect(stillHeld.state).toBe('shaded');
  });

  it('releases once the load has stayed below release for the hold time', () => {
    const shaded = step(initialShadeRuntime(), 0, 0.6, true);
    const dropped = step(shaded, 10, 0.2, true);
    const released = step(dropped, 10 + HOLD, 0.2, true);
    expect(released.state).toBe('open');
    expect(released.shadedSince).toBeNull();
    expect(released.belowReleaseSince).toBeNull();
  });

  it('resets the hold timer when load climbs back above release', () => {
    const shaded = step(initialShadeRuntime(), 0, 0.6, true);
    const dropped = step(shaded, 10, 0.2, true);
    expect(dropped.belowReleaseSince).toBe(at(10).toISOString());

    const reheated = step(dropped, 30, 0.6, true);
    expect(reheated.state).toBe('shaded');
    expect(reheated.belowReleaseSince).toBeNull();

    // Drop again at t=40 → the hold restarts from 40, not from 10.
    const droppedAgain = step(reheated, 40, 0.2, true);
    expect(droppedAgain.belowReleaseSince).toBe(at(40).toISOString());
    const notYet = step(droppedAgain, 40 + HOLD - 1, 0.2, true);
    expect(notYet.state).toBe('shaded');
  });

  it('stays shaded in the hysteresis band (load between release and activate)', () => {
    const shaded = step(initialShadeRuntime(), 0, 0.6, true);
    // load 0.35 is below activate but above release → no hold timer, stays shaded.
    const band = step(shaded, 20, 0.35, true);
    expect(band.state).toBe('shaded');
    expect(band.belowReleaseSince).toBeNull();
  });
});

describe('shadingState — initial', () => {
  it('initialShadeRuntime is a fresh open state', () => {
    expect(initialShadeRuntime()).toEqual({
      state: 'open',
      shadedSince: null,
      belowReleaseSince: null,
    });
  });
});
