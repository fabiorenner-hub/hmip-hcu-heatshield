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
        // Open overheats so noMoveNeeded only when current already cool;
        // force a move scenario: base peak high but every candidate cools below upper.
        const fn = (_level01: number): RoomTrajectory => ({
          roomId: 'r1',
          points: [
            { ts: NOW.toISOString(), indoorTempC: 24, heatLoad01: 0.5 },
            { ts: new Date(NOW.getTime() + 3600_000).toISOString(), indoorTempC: 24.4, heatLoad01: 0.5 },
          ],
          uncertain: false,
          confidence01: 0.9,
        });
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

  // Solar-benefit gate: when the room cannot be held comfortable AND there is
  // no near-term solar load to block, the planner must NOT force the strongest
  // close (closing a shutter cannot cool a non-solar heat load) — it opens for
  // daylight instead. Mirrors the real "40 °C outside but cloudy now" case.
  it('does not force-close when the room is hot but there is no near-term solar load', () => {
    // Hot room (peak 30, above the 24.5 upper bound at every level) but zero
    // heat load → no sun to block. Open-vs-closed makes no thermal difference.
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
    // Most-open candidate (0), not the strongest close (0.95).
    expect(plan.target01).toBe(0);
    expect(plan.plannedActions[0]?.reason).toContain('keine Sonnenlast');
  });

  it('still closes hard when the room is hot AND near-term solar load is present', () => {
    // Hot room with real solar load → closing remains correct.
    const fn = (level01: number): RoomTrajectory => {
      const peak = 30 - level01 * 2; // still above bound even fully closed
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
