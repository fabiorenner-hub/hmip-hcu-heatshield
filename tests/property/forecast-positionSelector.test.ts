/**
 * Property-based tests for the movement-minimizing position selector
 * (predictive-control-dashboard). Properties 7–11.
 *
 * Uses a synthetic `trajectoryForLevel` so the selector logic is tested in
 * isolation: a higher (more closed) level yields a cooler trajectory.
 */

import fc from 'fast-check';
import { describe, it, expect } from 'vitest';

import {
  selectPosition,
  planWindowSchedule,
  type ComfortBounds,
  type PlannerWindowContext,
} from '../../src/plugin/engine/forecast/positionSelector.js';
import type { RoomTrajectory } from '../../src/plugin/engine/forecast/thermalModel.js';

const NOW = new Date('2026-06-21T08:00:00.000Z');
const CANDIDATES = [0, 0.25, 0.5, 0.75, 0.95, 1];

/** Cooler when more closed: peak temp = base − level*span. */
function makeTrajFn(basePeakC: number, span: number) {
  return (level01: number): RoomTrajectory => {
    const peak = basePeakC - level01 * span;
    return {
      roomId: 'r1',
      points: [
        { ts: NOW.toISOString(), indoorTempC: peak - 1, heatLoad01: 0.5 },
        { ts: new Date(NOW.getTime() + 3600_000).toISOString(), indoorTempC: peak, heatLoad01: 0.6 },
      ],
      uncertain: false,
      confidence01: 0.9,
    };
  };
}

function ctxArb(): fc.Arbitrary<PlannerWindowContext> {
  return fc
    .record({ current: fc.constantFrom(...CANDIDATES) })
    .map((r) => ({
      windowId: 'w1',
      roomId: 'r1',
      currentLevel01: r.current,
      candidateLevels01: CANDIDATES,
      minSecondsBetweenMoves: 7200,
      movementBudgetPerInterval: 1,
    }));
}

const bounds: ComfortBounds = { lowerC: 17, upperC: 24.5 };

describe('positionSelector — Properties 7–11', () => {
  // Feature: predictive-control-dashboard, Property 9: keine Bewegung wenn aktuelle Position komfortabel.
  it('Property 9: holds current position with no move when already comfortable', () => {
    fc.assert(
      fc.property(ctxArb(), (ctx) => {
        // base peak low enough that even fully open stays in comfort.
        const fn = makeTrajFn(23, 4);
        const plan = selectPosition(ctx, fn, bounds, NOW);
        expect(plan.noMoveNeeded).toBe(true);
        expect(plan.target01).toBe(ctx.currentLevel01);
        expect(plan.plannedActions).toHaveLength(0);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: predictive-control-dashboard, Property 7: komforterhaltende, bewegungsminimale Wahl.
  it('Property 7: chosen target holds comfort and is admissible when one exists', () => {
    fc.assert(
      fc.property(ctxArb(), (ctx) => {
        // Open overheats (peak 28), closing cools; some candidate holds.
        const fn = makeTrajFn(28, 12);
        const plan = selectPosition(ctx, fn, bounds, NOW);
        const peak = fn(plan.target01).points[1]!.indoorTempC;
        if (!plan.noMoveNeeded) {
          // chosen target keeps the room within comfort if any admissible did
          const anyAdmissible = CANDIDATES.some((l) => fn(l).points[1]!.indoorTempC <= bounds.upperC);
          if (anyAdmissible) {
            expect(peak).toBeLessThanOrEqual(bounds.upperC + 1e-9);
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  // Feature: predictive-control-dashboard, Property 11: wohlgeformte geplante Aktionen.
  it('Property 11: emitted actions are well-formed (scheduled, valid ts, percent ∈ [0,100], reason)', () => {
    fc.assert(
      fc.property(ctxArb(), (ctx) => {
        const fn = makeTrajFn(30, 10);
        const plan = selectPosition(ctx, fn, bounds, NOW);
        for (const a of plan.plannedActions) {
          expect(a.state).toBe('scheduled');
          expect(Number.isNaN(Date.parse(a.scheduledTs))).toBe(false);
          expect(a.targetPercent).toBeGreaterThanOrEqual(0);
          expect(a.targetPercent).toBeLessThanOrEqual(100);
          expect(a.reason.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 100 },
    );
  });

  // Feature: predictive-control-dashboard, Property 8: höchstens eine planmäßige Bewegung je Intervall.
  it('Property 8: at most one planned move in normal operation', () => {
    fc.assert(
      fc.property(ctxArb(), (ctx) => {
        const fn = makeTrajFn(30, 10);
        const plan = selectPosition(ctx, fn, bounds, NOW);
        expect(plan.plannedActions.length).toBeLessThanOrEqual(1);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: predictive-control-dashboard — no redundant move when already at target.
  it('emits no action when the chosen position equals the current one (already closed)', () => {
    // base peak 40, span 10 → even fully closed (level 1) peaks at 30 > 24.5:
    // no admissible holds comfort → chosen = max candidate = 1.0 = current.
    const fn = makeTrajFn(40, 10);
    const ctx: PlannerWindowContext = {
      windowId: 'w1',
      roomId: 'r1',
      currentLevel01: 1, // already fully closed
      candidateLevels01: CANDIDATES,
      minSecondsBetweenMoves: 7200,
      movementBudgetPerInterval: 1,
    };
    const plan = selectPosition(ctx, fn, bounds, NOW);
    expect(plan.plannedActions).toHaveLength(0);
    expect(plan.noMoveNeeded).toBe(true);
    expect(plan.target01).toBe(1);
  });

  // Feature: catalog — prefer the most-open admissible position (max light).
  it('picks the most-open admissible position when a move is needed', () => {
    // base peak 26, span 12: open(0)=26>24.5 not admissible; closing cools.
    // level 0.25→23, 0.5→20, … all ≤ 24.5 are admissible; expect the most
    // open admissible (lowest level), here 0.25.
    const fn = makeTrajFn(26, 12);
    const ctx: PlannerWindowContext = {
      windowId: 'w1',
      roomId: 'r1',
      currentLevel01: 1, // closed now → a move is needed to gain light
      candidateLevels01: CANDIDATES,
      minSecondsBetweenMoves: 7200,
      movementBudgetPerInterval: 1,
    };
    const plan = selectPosition(ctx, fn, bounds, NOW);
    expect(plan.noMoveNeeded).toBe(false);
    // peak at chosen must hold comfort and be the most open that does so.
    const peak = fn(plan.target01).points[1]!.indoorTempC;
    expect(peak).toBeLessThanOrEqual(bounds.upperC + 1e-9);
    expect(plan.target01).toBe(0.25);
  });

  it('Property 10: among equal-move admissible candidates, picks closest to current', () => {
    // All candidates admissible (peak always <= upper): expect closest-to-current.
    fc.assert(
      fc.property(fc.constantFrom(...CANDIDATES), (current) => {
        // Every candidate is admissible (all peaks <= upper), but shading DOES
        // help here (a genuine >=0.3 K benefit from closing), so the daylight-
        // open rule does not fire and the comfortable current position is held.
        const fn = (level01: number): RoomTrajectory => {
          const peak = 24.4 - level01 * 0.5; // open 24.4 → closed 23.9: 0.5 K benefit
          return {
            roomId: 'r1',
            points: [
              { ts: NOW.toISOString(), indoorTempC: peak - 0.4, heatLoad01: 0.5 },
              { ts: new Date(NOW.getTime() + 3600_000).toISOString(), indoorTempC: peak, heatLoad01: 0.5 },
            ],
            uncertain: false,
            confidence01: 0.9,
          };
        };
        const ctx: PlannerWindowContext = {
          windowId: 'w1', roomId: 'r1', currentLevel01: current,
          candidateLevels01: CANDIDATES, minSecondsBetweenMoves: 7200, movementBudgetPerInterval: 1,
        };
        const plan = selectPosition(ctx, fn, bounds, NOW);
        // current already comfortable → no move, target == current.
        expect(plan.target01).toBe(current);
      }),
      { numRuns: 50 },
    );
  });

  // Shade-benefit gate: when the room cannot be held comfortable AND shading
  // THIS window does not lower the horizon peak (no solar gain to block here —
  // e.g. an off-sun facade in the afternoon), keeping it closed only darkens
  // the room without cooling it. The planner must OPEN it for daylight instead
  // of holding a stale closed position. (Regression: Küche/Gaderobe stuck at
  // 95 % with no sun on the window.)
  it('opens for daylight when the room is warm but shading gives no benefit', () => {
    // Hot room (peak 30 > bound) but open and closed reach the SAME peak →
    // nothing to block at this window. Must open to the most-open level.
    const fn = (_level01: number): RoomTrajectory => ({
      roomId: 'r1',
      points: [
        { ts: NOW.toISOString(), indoorTempC: 29, heatLoad01: 0 },
        { ts: new Date(NOW.getTime() + 3600_000).toISOString(), indoorTempC: 30, heatLoad01: 0 },
      ],
      uncertain: false,
      confidence01: 0.9,
    });
    const ctx: PlannerWindowContext = {
      windowId: 'w1', roomId: 'r1', currentLevel01: 0.95,
      candidateLevels01: CANDIDATES, minSecondsBetweenMoves: 7200, movementBudgetPerInterval: 1,
    };
    const plan = selectPosition(ctx, fn, bounds, NOW);
    expect(plan.target01).toBe(0);
    expect(plan.noMoveNeeded).toBe(false);
    expect(plan.plannedActions[0]?.reason).toContain('Öffnen für Tageslicht');
  });

  // Hold-branch twin of the above: the room is currently COMFORTABLE at a
  // closed position, but the window has no solar gain to block (shading
  // pointless) and opening keeps comfort → open for daylight rather than hold
  // the stale closed shutter. (Regression: Gaderobe comfortable yet at 95 %.)
  it('opens a comfortable but pointlessly-closed shutter for daylight', () => {
    // Flat, comfortable trajectory regardless of level (no gain to block).
    const fn = (_level01: number): RoomTrajectory => ({
      roomId: 'r1',
      points: [
        { ts: NOW.toISOString(), indoorTempC: 23.5, heatLoad01: 0.1 },
        { ts: new Date(NOW.getTime() + 3600_000).toISOString(), indoorTempC: 23.7, heatLoad01: 0.1 },
      ],
      uncertain: false,
      confidence01: 0.9,
    });
    const ctx: PlannerWindowContext = {
      windowId: 'w1', roomId: 'r1', currentLevel01: 0.95,
      candidateLevels01: CANDIDATES, minSecondsBetweenMoves: 7200, movementBudgetPerInterval: 1,
    };
    const plan = selectPosition(ctx, fn, bounds, NOW);
    expect(plan.target01).toBe(0);
    expect(plan.noMoveNeeded).toBe(false);
    expect(plan.plannedActions[0]?.reason).toContain('Öffnen für Tageslicht');
  });

  it('closes hard when the room is hot AND shading meaningfully lowers the peak', () => {
    // Closing lowers the peak (gain to block, e.g. diffuse on an off-sun
    // facade) → close, regardless of which facade the sun is on.
    const fn = (level01: number): RoomTrajectory => {
      const peak = 30 - level01 * 2; // open peak 30, closed peak 28 → benefit 2 K
      return {
        roomId: 'r1',
        points: [
          { ts: NOW.toISOString(), indoorTempC: peak - 1, heatLoad01: 0.6 },
          { ts: new Date(NOW.getTime() + 3600_000).toISOString(), indoorTempC: peak, heatLoad01: 0.6 },
        ],
        uncertain: false,
        confidence01: 0.9,
      };
    };
    const ctx: PlannerWindowContext = {
      windowId: 'w1', roomId: 'r1', currentLevel01: 0,
      candidateLevels01: CANDIDATES, minSecondsBetweenMoves: 7200, movementBudgetPerInterval: 1,
    };
    const plan = selectPosition(ctx, fn, bounds, NOW);
    expect(plan.target01).toBe(1);
    expect(plan.plannedActions[0]?.reason).toContain('Stärkstes Schließen');
  });
});


describe('planWindowSchedule — phased day-ahead plan', () => {
  const NOW2 = new Date('2026-07-11T06:00:00.000Z');
  const CAND = [0, 0.25, 0.5, 0.75, 0.95, 1];
  const B: ComfortBounds = { lowerC: 17, upperC: 24.5 };

  // Synthetic sim: the sun is on the window only between +6 h and +10 h from
  // NOW2. While sunny an OPEN shutter overheats the room (23 → 27 °C); a
  // sufficiently closed shutter blocks it. Outside that window there is no
  // solar load, so the room stays comfortable fully open.
  function simFrom(startT: Date, _startTemp: number, level01: number, hoursAhead: number): RoomTrajectory {
    const stepMin = 30;
    const n = Math.floor((hoursAhead * 60) / stepMin) + 1;
    const points = [];
    for (let k = 0; k < n; k += 1) {
      const t = new Date(startT.getTime() + k * stepMin * 60000);
      const elapsedH = (t.getTime() - NOW2.getTime()) / 3600_000;
      const sunny = elapsedH >= 6 && elapsedH < 10;
      const openFactor = 1 - level01;
      points.push({
        ts: t.toISOString(),
        indoorTempC: 23 + (sunny ? openFactor * 4 : 0),
        heatLoad01: sunny ? openFactor : 0,
      });
    }
    return { roomId: 'r1', points, uncertain: false, confidence01: 0.9 };
  }

  it('emits a future close when the sun arrives and a future open when it leaves', () => {
    const plan = planWindowSchedule(
      { windowId: 'w1', currentLevel01: 0, candidateLevels01: CAND, startTempC: 23, horizonHours: 24, segmentHours: 2, lookaheadHours: 3 },
      simFrom, B, NOW2,
    );
    // Not moving right now (comfortable + open), but future moves are planned.
    expect(plan.target01).toBe(0);
    expect(plan.noMoveNeeded).toBe(true);
    expect(plan.plannedActions.length).toBe(2);
    // First a close (percent rises), later an open (percent falls back).
    expect(plan.plannedActions[0]!.targetPercent).toBeGreaterThan(0);
    expect(plan.plannedActions[0]!.reason).toContain('Schließen');
    expect(plan.plannedActions[1]!.targetPercent).toBeLessThan(plan.plannedActions[0]!.targetPercent);
    expect(plan.plannedActions[1]!.reason).toContain('Öffnen');
    // All actions well-formed and in the future.
    for (const a of plan.plannedActions) {
      expect(Number.isNaN(Date.parse(a.scheduledTs))).toBe(false);
      expect(Date.parse(a.scheduledTs)).toBeGreaterThan(NOW2.getTime());
      expect(a.targetPercent).toBeGreaterThanOrEqual(0);
      expect(a.targetPercent).toBeLessThanOrEqual(100);
      expect(a.state).toBe('scheduled');
    }
  });

  it('falls back to holding the current position when the room temperature is unknown', () => {
    const plan = planWindowSchedule(
      { windowId: 'w1', currentLevel01: 0.95, candidateLevels01: CAND, startTempC: null, horizonHours: 24 },
      simFrom, B, NOW2,
    );
    expect(plan.target01).toBe(0.95);
    expect(plan.noMoveNeeded).toBe(true);
    expect(plan.plannedActions).toHaveLength(0);
  });

  it('plans to open a pointlessly-closed shutter with no solar load ahead', () => {
    // No sunny window in this sim → room stays comfortable fully open.
    const flat = (startT: Date, _s: number, _l: number, hoursAhead: number): RoomTrajectory => {
      const stepMin = 30; const n = Math.floor((hoursAhead * 60) / stepMin) + 1; const points = [];
      for (let k = 0; k < n; k += 1) points.push({ ts: new Date(startT.getTime() + k * stepMin * 60000).toISOString(), indoorTempC: 23, heatLoad01: 0 });
      return { roomId: 'r1', points, uncertain: false, confidence01: 0.9 };
    };
    const plan = planWindowSchedule(
      { windowId: 'w1', currentLevel01: 0.95, candidateLevels01: CAND, startTempC: 23, horizonHours: 12, segmentHours: 2, lookaheadHours: 3 },
      flat, B, NOW2,
    );
    expect(plan.target01).toBe(0);
    expect(plan.noMoveNeeded).toBe(false);
    expect(plan.plannedActions[0]!.targetPercent).toBe(0);
    expect(plan.plannedActions[0]!.reason).toContain('Öffnen');
  });
});


describe('planWindowSchedule — cool-day gate (outdoor max below comfort)', () => {
  const NOWC = new Date('2026-07-14T06:00:00.000Z');
  const CAND = [0, 0.25, 0.5, 0.75, 0.95, 1];
  const B: ComfortBounds = { lowerC: 17, upperC: 24.5 };
  // Residual-warmth sim: the room sits at 26 °C regardless of shutter level —
  // shading does NOT lower the peak (overcast/cool day, no direct beam to
  // block). Only outdoor air (ventilation) could cool it.
  function flatWarmSim(startT: Date, _t: number, _level01: number, hoursAhead: number): RoomTrajectory {
    const stepMin = 30;
    const n = Math.floor((hoursAhead * 60) / stepMin) + 1;
    const points = [];
    for (let k = 0; k < n; k += 1) {
      points.push({
        ts: new Date(startT.getTime() + k * stepMin * 60000).toISOString(),
        indoorTempC: 26,
        heatLoad01: 0,
      });
    }
    return { roomId: 'r1', points, uncertain: false, confidence01: 0.9 };
  }
  const baseCtx = {
    windowId: 'w1',
    currentLevel01: 0,
    candidateLevels01: CAND,
    startTempC: 26,
    horizonHours: 4,
    segmentHours: 2,
    lookaheadHours: 3,
    heatCap01: 0.95,
    exposureAt: (): number => 0.5, // sun geometrically on the window
  };

  it('keeps the window OPEN when the day stays below comfort and shading would not cool', () => {
    const plan = planWindowSchedule({ ...baseCtx, outdoorBelowComfort: true }, flatWarmSim, B, NOWC);
    expect(plan.target01).toBe(0);
  });

  it('still shades (control) when the outdoor max is NOT below comfort', () => {
    const plan = planWindowSchedule({ ...baseCtx, outdoorBelowComfort: false }, flatWarmSim, B, NOWC);
    expect(plan.target01).toBeGreaterThan(0);
  });
});

describe('planWindowSchedule — proactive shading from target (opt-in)', () => {
  const NOWP = new Date('2026-07-11T06:00:00.000Z');
  const CAND = [0, 0.25, 0.5, 0.75, 0.95, 1];
  // Warning bound at 26 °C; the proactive threshold (= target) is 23 °C.
  const B: ComfortBounds = { lowerC: 17, upperC: 26 };
  // Sun on the window all horizon. An OPEN shutter peaks at 25 °C — ABOVE the
  // 23 °C target but BELOW the 26 °C warning bound. Closing lowers the peak.
  function sunSim(startT: Date, _t: number, level01: number, hoursAhead: number): RoomTrajectory {
    const stepMin = 30;
    const n = Math.floor((hoursAhead * 60) / stepMin) + 1;
    const points = [];
    for (let k = 0; k < n; k += 1) {
      const t = new Date(startT.getTime() + k * stepMin * 60000);
      points.push({
        ts: t.toISOString(),
        indoorTempC: 23 + (1 - level01) * 2, // open 25 → closed 23
        heatLoad01: 1 - level01,
      });
    }
    return { roomId: 'r1', points, uncertain: false, confidence01: 0.9 };
  }
  const baseCtx = {
    windowId: 'w1',
    currentLevel01: 0,
    candidateLevels01: CAND,
    startTempC: 23,
    horizonHours: 4,
    segmentHours: 2,
    lookaheadHours: 3,
    heatCap01: 0.95,
    exposureAt: (): number => 0.5, // direct sun geometrically on the window
    solarStrongAt: (): boolean => true,
  };

  it('leaves the window OPEN by default (peak below the warning bound)', () => {
    const plan = planWindowSchedule({ ...baseCtx }, sunSim, B, NOWP);
    expect(plan.target01).toBe(0);
  });

  it('shades earlier when proactive-from-target is on and sun is on the window', () => {
    const plan = planWindowSchedule(
      { ...baseCtx, proactiveThresholdC: 23 },
      sunSim,
      B,
      NOWP,
    );
    expect(plan.target01).toBeGreaterThan(0);
  });

  it('does NOT proactively shade an off-sun window even when enabled', () => {
    // Same warm-ish forecast but no direct sun on the glass → the exposure gate
    // must keep the window open (proactive shading is sun-gated).
    const plan = planWindowSchedule(
      { ...baseCtx, proactiveThresholdC: 23, exposureAt: (): number => 0, solarStrongAt: (): boolean => false },
      sunSim,
      B,
      NOWP,
    );
    expect(plan.target01).toBe(0);
  });
});

describe('planWindowSchedule — movement budget (2–4 moves/day)', () => {
  const NOW3 = new Date('2026-07-11T06:00:00.000Z');
  const CAND = [0, 0.25, 0.5, 0.75, 0.95, 1];
  const B: ComfortBounds = { lowerC: 17, upperC: 24.5 };
  // Sun on the window +6..+10 h (same shape as the phased-plan test): an open
  // shutter overheats while sunny, a closed one holds.
  function sim(startT: Date, _s: number, level01: number, hoursAhead: number): RoomTrajectory {
    const stepMin = 30; const n = Math.floor((hoursAhead * 60) / stepMin) + 1; const points = [];
    for (let k = 0; k < n; k += 1) {
      const t = new Date(startT.getTime() + k * stepMin * 60000);
      const elapsedH = (t.getTime() - NOW3.getTime()) / 3600_000;
      const sunny = elapsedH >= 6 && elapsedH < 10;
      points.push({ ts: t.toISOString(), indoorTempC: 23 + (sunny ? (1 - level01) * 4 : 0), heatLoad01: sunny ? 1 - level01 : 0 });
    }
    return { roomId: 'r1', points, uncertain: false, confidence01: 0.9 };
  }

  it('caps the number of emitted moves at maxMoves', () => {
    const plan = planWindowSchedule(
      { windowId: 'w1', currentLevel01: 0, candidateLevels01: CAND, startTempC: 23, horizonHours: 24, segmentHours: 2, lookaheadHours: 3, maxMoves: 1 },
      sim, B, NOW3,
    );
    expect(plan.plannedActions.length).toBe(1); // the close survives, the later open is dropped by the cap
    expect(plan.plannedActions[0]!.targetPercent).toBeGreaterThan(0);
  });

  it('drops moves smaller than minPositionDeltaPct', () => {
    // Moderate direct-solar exposure caps the closure at a small partial level
    // (~25 %); an 80 % minimum delta drops those small moves entirely.
    const plan = planWindowSchedule(
      {
        windowId: 'w1', currentLevel01: 0, candidateLevels01: CAND, startTempC: 23,
        horizonHours: 24, segmentHours: 2, lookaheadHours: 3, minPositionDeltaPct: 80,
        exposureAt: () => 0.3, solarStrongAt: () => true, heatCap01: 1,
      },
      sim, B, NOW3,
    );
    expect(plan.plannedActions).toHaveLength(0);
  });
});
