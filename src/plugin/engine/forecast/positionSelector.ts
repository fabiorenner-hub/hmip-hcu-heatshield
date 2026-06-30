/**
 * Heat Shield — movement-minimizing position selector
 * (predictive-control-dashboard Requirement 3).
 *
 * Pure. Given a way to (re)simulate the room trajectory for any candidate
 * shutter level, choose the single base target that keeps the room within
 * comfort across the whole horizon with the fewest planned moves:
 *
 *   1. Hold check first (3.4): if the CURRENT position holds comfort across
 *      the horizon → no move, keep position.
 *   2. Otherwise evaluate each candidate; a candidate is admissible if it
 *      holds comfort across the whole horizon.
 *   3. Among admissible candidates pick the one with the fewest planned
 *      moves over the horizon (3.1); here a single fixed position = 1 move.
 *   4. Tie-break (3.5): closest to the current position in percent.
 *   5. Emit PlannedAction[] (state 'scheduled') with timestamp, target %,
 *      reason (3.6), honoring at most movementBudgetPerInterval per interval.
 */

import { level01ToPercent } from './shutterConvention.js';
import type { RoomTrajectory } from './thermalModel.js';

export type PlannedActionState =
  | 'recommended'
  | 'scheduled'
  | 'executing'
  | 'completed'
  | 'blocked'
  | 'manuallyOverridden';

export interface ComfortBounds {
  readonly lowerC: number;
  readonly upperC: number;
}

export interface PlannerWindowContext {
  readonly windowId: string;
  readonly roomId: string;
  readonly currentLevel01: number;
  readonly candidateLevels01: ReadonlyArray<number>;
  readonly minSecondsBetweenMoves: number;
  readonly movementBudgetPerInterval: number;
}

export interface PlannedAction {
  readonly windowId: string;
  readonly scheduledTs: string;
  readonly targetPercent: number; // 0=open .. 100=closed
  readonly reason: string;
  readonly state: PlannedActionState;
}

export interface PositionPlan {
  readonly windowId: string;
  readonly target01: number;
  readonly plannedActions: ReadonlyArray<PlannedAction>;
  readonly noMoveNeeded: boolean;
}

/** Heat load below this (per horizon point) counts as "no solar heat". */
const NO_HEAT_EPS = 0.02;
/** Minimum closure reduction (percentage points) worth a daylight-open move. */
const LIGHT_GAIN_MIN_PCT = 20;
/**
 * Minimum horizon-peak reduction (K) that makes shading worthwhile when the
 * room can no longer be kept comfortable. If fully closing the shutter lowers
 * the predicted peak by less than this, there is effectively no solar gain to
 * block (overcast / night) and closing would only darken the room — so we hold
 * the current position instead. This is a per-window, physical test: it does
 * not care which facade the sun is on, only whether shading actually helps.
 */
const SHADE_BENEFIT_MIN_C = 0.3;

/** Highest predicted indoor temperature across the trajectory. */
function peakTempC(traj: RoomTrajectory): number {
  let max = Number.NEGATIVE_INFINITY;
  for (const p of traj.points) {
    if (p.indoorTempC > max) {
      max = p.indoorTempC;
    }
  }
  return max;
}

/** True iff every trajectory point stays within [lowerC, upperC]. */
function holdsComfort(traj: RoomTrajectory, bounds: ComfortBounds): boolean {
  for (const p of traj.points) {
    if (p.indoorTempC < bounds.lowerC || p.indoorTempC > bounds.upperC) {
      return false;
    }
  }
  return true;
}

/**
 * Timestamp of the first trajectory point that leaves the comfort band —
 * i.e. when a move becomes necessary. Falls back to `now` when the first
 * point already breaches or no point timestamp parses. Returned as ISO-8601.
 */
function firstBreachTs(traj: RoomTrajectory, bounds: ComfortBounds, now: Date): string {
  for (const p of traj.points) {
    if (p.indoorTempC < bounds.lowerC || p.indoorTempC > bounds.upperC) {
      const t = Date.parse(p.ts);
      if (Number.isFinite(t) && t > now.getTime()) {
        return new Date(t).toISOString();
      }
      return now.toISOString();
    }
  }
  return now.toISOString();
}

/**
 * Select the movement-minimizing base target for one window.
 *
 * @param trajectoryForLevel - re-simulates the room trajectory assuming the
 *   shutter is held at the given level for the whole horizon.
 */
export function selectPosition(
  ctx: PlannerWindowContext,
  trajectoryForLevel: (level01: number) => RoomTrajectory,
  bounds: ComfortBounds,
  now: Date,
): PositionPlan {
  // 1. Hold check (Requirement 3.4).
  const currentTraj = trajectoryForLevel(ctx.currentLevel01);
  if (holdsComfort(currentTraj, bounds)) {
    // The current position keeps comfort. Before holding, consider OPENING for
    // daylight: when there is effectively no solar heat load left across the
    // horizon (e.g. evening, PV ≈ 0) and a fully-open shutter also stays
    // comfortable, open it to let in as much light as possible. Gated by a
    // meaningful gain so we never churn for a few percent. Only ever opens.
    const mostOpen = ctx.candidateLevels01.reduce((a, b) => (b < a ? b : a));
    if (mostOpen < ctx.currentLevel01) {
      const openTraj = trajectoryForLevel(mostOpen);
      const maxLoadOpen = openTraj.points.reduce((m, p) => (p.heatLoad01 > m ? p.heatLoad01 : m), 0);
      const gainPct = level01ToPercent(ctx.currentLevel01) - level01ToPercent(mostOpen);
      if (maxLoadOpen <= NO_HEAT_EPS && holdsComfort(openTraj, bounds) && gainPct >= LIGHT_GAIN_MIN_PCT) {
        return {
          windowId: ctx.windowId,
          target01: mostOpen,
          plannedActions: [
            {
              windowId: ctx.windowId,
              scheduledTs: firstBreachTs(currentTraj, bounds, now),
              targetPercent: Math.round(level01ToPercent(mostOpen)),
              reason: 'Öffnen für Tageslicht – keine Wärmelast erwartet',
              state: 'scheduled',
            },
          ],
          noMoveNeeded: false,
        };
      }
    }
    return {
      windowId: ctx.windowId,
      target01: ctx.currentLevel01,
      plannedActions: [],
      noMoveNeeded: true,
    };
  }

  // 2. Admissible candidates (hold comfort across the whole horizon).
  const admissible = ctx.candidateLevels01.filter((lvl) =>
    holdsComfort(trajectoryForLevel(lvl), bounds),
  );

  // When does the move actually become necessary? Find the first point on
  // the CURRENT-position trajectory that leaves comfort — that timestamp is
  // when the shutter should move. If the very first point already breaches
  // (or no ts parses), the move is needed now. This makes the dashboard show
  // *future* planned moves over the horizon instead of always "Jetzt".
  const scheduledTs = firstBreachTs(currentTraj, bounds, now);

  // 3 + 4. Among admissible candidates (those that hold comfort over the whole
  // horizon), prefer the MOST OPEN one — that keeps the room cool while letting
  // in as much light as possible (user goal: "so viel Licht wie möglich").
  // Movement minimization is handled by the hold check above + the downstream
  // hysteresis / min-interval, so this only changes *where* a needed move
  // lands, never adds moves.
  let chosen: number;
  if (admissible.length > 0) {
    chosen = admissible.reduce((best, lvl) => (lvl < best ? lvl : best));
  } else {
    // No single position holds comfort over the whole horizon → the room is
    // hot. Shade only if it actually helps: compare the horizon PEAK of a
    // fully-open vs a fully-closed shutter. A meaningful reduction means there
    // is solar gain (direct OR diffuse) to block → close hard. If open and
    // closed are ~equal (overcast / night — nothing to block), closing would
    // only darken the room, so hold the current position instead of churning.
    const mostOpen = ctx.candidateLevels01.reduce((a, b) => (b < a ? b : a));
    const mostClosed = ctx.candidateLevels01.reduce((a, b) => (b > a ? b : a));
    const benefitC = peakTempC(trajectoryForLevel(mostOpen)) - peakTempC(trajectoryForLevel(mostClosed));
    chosen = benefitC >= SHADE_BENEFIT_MIN_C ? mostClosed : ctx.currentLevel01;
  }

  // No redundant move: if the chosen position equals the current one (in whole
  // percent), there is nothing to command — e.g. a shutter already at 100 %
  // must not produce a "set to 100 %" planned action.
  const chosenPct = Math.round(level01ToPercent(chosen));
  const currentPct = Math.round(level01ToPercent(ctx.currentLevel01));
  if (chosenPct === currentPct) {
    return {
      windowId: ctx.windowId,
      target01: ctx.currentLevel01,
      plannedActions: [],
      noMoveNeeded: true,
    };
  }

  const action: PlannedAction = {
    windowId: ctx.windowId,
    scheduledTs,
    targetPercent: Math.round(level01ToPercent(chosen)),
    reason:
      admissible.length > 0
        ? 'Vorausschauende Position hält Komfort über den Horizont'
        : 'Stärkstes Schließen, da keine Halteposition den Komfort wahrt',
    state: 'scheduled',
  };

  return {
    windowId: ctx.windowId,
    target01: chosen,
    plannedActions: [action],
    noMoveNeeded: false,
  };
}
