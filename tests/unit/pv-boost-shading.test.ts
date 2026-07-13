/**
 * Regression tests for the PV-boost shading floor (2.0.18).
 *
 * When the PV array delivers a lot of power, windows that FACE the array
 * (e.g. SW) should be closed HARDER — up to full — and held there, even if
 * the daylight/thermal decision alone would leave them more open. This is
 * expressed through `PhasedPlanContext.pvCloseFloorAt(t)`: a per-time floor
 * on the closure level.
 *
 * The floor must:
 *   - raise the chosen level when the array is delivering (high PV),
 *   - never exceed the window's own heat cap,
 *   - do nothing when disabled / the window does not face the array.
 */

import { describe, it, expect } from 'vitest';

import {
  planWindowSchedule,
  type ComfortBounds,
} from '../../src/plugin/engine/forecast/positionSelector.js';
import type { RoomTrajectory } from '../../src/plugin/engine/forecast/thermalModel.js';

const NOW = new Date('2026-07-11T06:00:00.000Z');
const CAND = [0, 0.25, 0.5, 0.75, 0.95, 1];
const B: ComfortBounds = { lowerC: 17, upperC: 24.5 };

// Sun on the window +6..+10 h; an open shutter overheats while sunny.
function sim(startT: Date, _s: number, level01: number, hoursAhead: number): RoomTrajectory {
  const stepMin = 30;
  const n = Math.floor((hoursAhead * 60) / stepMin) + 1;
  const points = [];
  for (let k = 0; k < n; k += 1) {
    const t = new Date(startT.getTime() + k * stepMin * 60000);
    const elapsedH = (t.getTime() - NOW.getTime()) / 3600_000;
    const sunny = elapsedH >= 6 && elapsedH < 10;
    points.push({
      ts: t.toISOString(),
      indoorTempC: 23 + (sunny ? (1 - level01) * 4 : 0),
      heatLoad01: sunny ? 1 - level01 : 0,
    });
  }
  return { roomId: 'r1', points, uncertain: false, confidence01: 0.9 };
}

describe('PV-boost shading floor', () => {
  it('closes an array-facing window harder when PV output is very high', () => {
    // Mild direct-solar exposure would only cap the closure at a partial level;
    // a strong PV floor (0.95) must lift the chosen level to at least 0.95.
    const withPv = planWindowSchedule(
      {
        windowId: 'sw',
        currentLevel01: 0,
        candidateLevels01: CAND,
        startTempC: 23,
        horizonHours: 24,
        segmentHours: 2,
        lookaheadHours: 3,
        exposureAt: () => 0.3,
        solarStrongAt: () => true,
        heatCap01: 1,
        pvCloseFloorAt: (t): number => {
          const h = (t.getTime() - NOW.getTime()) / 3600_000;
          return h >= 6 && h < 10 ? 0.95 : 0; // high PV during the sunny window
        },
      },
      sim,
      B,
      NOW,
    );
    const peak = Math.max(0, ...withPv.plannedActions.map((a) => a.targetPercent));
    expect(peak).toBeGreaterThanOrEqual(95);
  });

  it('does not raise closure when PV floor is zero (disabled / off-array)', () => {
    const noPv = planWindowSchedule(
      {
        windowId: 'sw',
        currentLevel01: 0,
        candidateLevels01: CAND,
        startTempC: 23,
        horizonHours: 24,
        segmentHours: 2,
        lookaheadHours: 3,
        exposureAt: () => 0.3,
        solarStrongAt: () => true,
        heatCap01: 1,
        pvCloseFloorAt: (): number => 0,
      },
      sim,
      B,
      NOW,
    );
    const peak = Math.max(0, ...noPv.plannedActions.map((a) => a.targetPercent));
    // Mild exposure (0.3) → graduated cap keeps it well below full closure.
    expect(peak).toBeLessThan(95);
  });

  it('never closes beyond the window heat cap even at max PV floor', () => {
    const capped = planWindowSchedule(
      {
        windowId: 'sw',
        currentLevel01: 0,
        candidateLevels01: CAND,
        startTempC: 23,
        horizonHours: 24,
        segmentHours: 2,
        lookaheadHours: 3,
        exposureAt: () => 0.3,
        solarStrongAt: () => true,
        heatCap01: 0.75, // this window may only ever close to 75 %
        pvCloseFloorAt: (): number => 1, // PV wants full closure
      },
      sim,
      B,
      NOW,
    );
    for (const a of capped.plannedActions) {
      expect(a.targetPercent).toBeLessThanOrEqual(75);
    }
  });
});
