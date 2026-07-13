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
      const mostClosed = ctx.candidateLevels01.reduce((a, b) => (b > a ? b : a));
      const maxLoadOpen = openTraj.points.reduce((m, p) => (p.heatLoad01 > m ? p.heatLoad01 : m), 0);
      const gainPct = level01ToPercent(ctx.currentLevel01) - level01ToPercent(mostOpen);
      // Shading is pointless at THIS window when either there is no heat load at
      // all, OR closing it does not meaningfully lower the horizon peak (no
      // solar gain to block here — e.g. a north/off-sun facade in the
      // afternoon). In both cases a closed shutter only darkens the room, so we
      // open it for daylight as long as the fully-open trajectory still holds
      // comfort across the whole horizon.
      const shadeBenefitC = peakTempC(openTraj) - peakTempC(trajectoryForLevel(mostClosed));
      const shadingPointless = maxLoadOpen <= NO_HEAT_EPS || shadeBenefitC < SHADE_BENEFIT_MIN_C;
      if (shadingPointless && holdsComfort(openTraj, bounds) && gainPct >= LIGHT_GAIN_MIN_PCT) {
        return {
          windowId: ctx.windowId,
          target01: mostOpen,
          plannedActions: [
            {
              windowId: ctx.windowId,
              scheduledTs: firstBreachTs(currentTraj, bounds, now),
              targetPercent: Math.round(level01ToPercent(mostOpen)),
              reason: 'Öffnen für Tageslicht – Beschattung an diesem Fenster ohne Wirkung',
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
  let noHoldReason: string;
  if (admissible.length > 0) {
    chosen = admissible.reduce((best, lvl) => (lvl < best ? lvl : best));
    noHoldReason = 'Vorausschauende Position hält Komfort über den Horizont';
  } else {
    // No single position holds comfort over the whole horizon → the room is
    // hot. Shade only if it actually helps: compare the horizon PEAK of a
    // fully-open vs a fully-closed shutter. A meaningful reduction means there
    // is solar gain (direct OR diffuse) to block → close hard. If open and
    // closed are ~equal (overcast / night, or the sun is not on THIS window —
    // nothing to block), closing would only darken the room without cooling
    // it, so OPEN for daylight instead of pointlessly holding a stale closed
    // position. Windows that DO have sun close via their own evaluation.
    const mostOpen = ctx.candidateLevels01.reduce((a, b) => (b < a ? b : a));
    const mostClosed = ctx.candidateLevels01.reduce((a, b) => (b > a ? b : a));
    const benefitC = peakTempC(trajectoryForLevel(mostOpen)) - peakTempC(trajectoryForLevel(mostClosed));
    if (benefitC >= SHADE_BENEFIT_MIN_C) {
      chosen = mostClosed;
      noHoldReason = 'Stärkstes Schließen, da keine Halteposition den Komfort wahrt';
    } else {
      chosen = mostOpen;
      noHoldReason = 'Öffnen für Tageslicht – Beschattung an diesem Fenster ohne Wirkung';
    }
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
    reason: noHoldReason,
    state: 'scheduled',
  };

  return {
    windowId: ctx.windowId,
    target01: chosen,
    plannedActions: [action],
    noMoveNeeded: false,
  };
}

/* -------------------------------------------------------------------------- */
/* Phased (receding-horizon) schedule                                         */
/* -------------------------------------------------------------------------- */

/**
 * Simulate the room trajectory for `hoursAhead` starting at `startT` with the
 * given room start temperature and this window held at `level01`. Returns the
 * trajectory whose `points[0]` is `startT`. Injected so the planner can supply
 * the forecast sampler; the property tests pass a synthetic sim.
 */
export type SimFrom = (
  startT: Date,
  startTempC: number,
  level01: number,
  hoursAhead: number,
) => RoomTrajectory;

export interface PhasedPlanContext {
  readonly windowId: string;
  readonly currentLevel01: number;
  readonly candidateLevels01: ReadonlyArray<number>;
  /** Measured room temperature now, or null when unknown (→ no phased plan). */
  readonly startTempC: number | null;
  /** Full planning horizon in hours (the plan is emitted across this span). */
  readonly horizonHours: number;
  /** Segment length in hours; the plan re-decides the position each segment. */
  readonly segmentHours?: number;
  /** Look-ahead per segment decision (must cover imminent heat). */
  readonly lookaheadHours?: number;
  /**
   * Movement budget — keeps "as few moves as possible" (target 2–4/day) even
   * with a fine segment grid. A scheduled transition is only emitted when it
   * clears all three gates.
   */
  /** Minimum |Δ| in percent to bother emitting a planned move. */
  readonly minPositionDeltaPct?: number;
  /** Minimum seconds between two emitted planned moves. */
  readonly minSecondsBetweenMoves?: number;
  /** Hard cap on emitted moves across the whole horizon. */
  readonly maxMoves?: number;

  /* --- Direct-solar-aware graduated shading (engine overhaul) ------------ */
  /**
   * Per-window DIRECT-solar exposure at time `t`, in [0,1]. 1 = sun straight
   * on the window and high; ~0 = no direct beam (only diffuse). Drives the
   * per-window closure cap so an off-sun facade (e.g. NW in the afternoon) is
   * only mildly shaded instead of slammed to 95 %.
   */
  readonly exposureAt?: (t: Date) => number;
  /** True when the solar/PV load is strong at `t` (clear-sky, high radiation). */
  readonly solarStrongAt?: (t: Date) => boolean;
  /** Full close cap for this window (0.95 façade / 1.0 roof). */
  readonly heatCap01?: number;
  /** Whether this window is a roof window (skylight) — dedicated handling. */
  readonly isRoof?: boolean;
  /** Tunable shading constants (Phase 1); defaults preserve behaviour. */
  readonly tuning?: ShadingTuning;
  /** Evening-open gate threshold (Phase 3); `null`/absent disables it. */
  readonly eveningOpenExposureBelow?: number | null;
  /**
   * PV-boost close floor (0..1) at time `t`: a minimum closure imposed on a
   * window facing the PV array while the array delivers a lot of power. Absent
   * → no PV boost.
   */
  readonly pvCloseFloorAt?: (t: Date) => number;
}

/**
 * Tunable shading constants (configurability Phase 1). Every field was a
 * hard-coded module constant; defaults preserve the former behaviour.
 */
export interface ShadingTuning {
  readonly highExposure: number;
  readonly lowExposure: number;
  readonly offSunMildClose01: number;
  readonly offSunStressClose01: number;
  readonly shadeBenefitMinC: number;
  readonly lightGainMinPct: number;
}

export const DEFAULT_SHADING_TUNING: ShadingTuning = {
  // Exposure at which a window reaches FULL close (near its solar peak). High
  // so the closure ramps up gradually (30→50→75→95 %) instead of jumping.
  highExposure: 0.9,
  lowExposure: 0.15,
  offSunMildClose01: 0.3,
  offSunStressClose01: 0.7,
  shadeBenefitMinC: SHADE_BENEFIT_MIN_C,
  lightGainMinPct: LIGHT_GAIN_MIN_PCT,
};

/**
 * Derive effective shading tuning from a base + a high-level profile (Phase 4).
 * `balanced` = base unchanged; `daylight` biases toward more light (harder to
 * fully close, milder off-sun caps, only shade when clearly beneficial);
 * `protection` biases toward more shade (easier full close, stronger off-sun
 * caps, shade sooner). Explicit `tuning` overrides in the base are preserved as
 * the starting point.
 */
export function deriveShadingTuning(
  base: ShadingTuning,
  profile: 'daylight' | 'balanced' | 'protection',
): ShadingTuning {
  const c01 = (x: number): number => Math.max(0, Math.min(1, x));
  if (profile === 'daylight') {
    return {
      ...base,
      highExposure: c01(base.highExposure + 0.1),
      lowExposure: c01(base.lowExposure + 0.05),
      offSunMildClose01: c01(base.offSunMildClose01 - 0.1),
      offSunStressClose01: c01(base.offSunStressClose01 - 0.2),
      shadeBenefitMinC: base.shadeBenefitMinC + 0.2,
    };
  }
  if (profile === 'protection') {
    return {
      ...base,
      highExposure: c01(base.highExposure - 0.15),
      lowExposure: c01(base.lowExposure - 0.05),
      offSunMildClose01: c01(base.offSunMildClose01 + 0.1),
      offSunStressClose01: c01(base.offSunStressClose01 + 0.1),
      shadeBenefitMinC: Math.max(0, base.shadeBenefitMinC - 0.15),
    };
  }
  return base;
}

/**
 * Maximum closure (0..1) allowed for one window given its DIRECT-solar
 * exposure. Reserves a full 95/100 % close for windows the sun is actually on;
 * an off-sun facade is capped mild, rising to at most the stress cap only when
 * the solar load is strong — never fully closed. Roof windows may always close
 * fully (handled by the caller).
 */
export function closureCapForExposure(
  exposure: number,
  solarStrong: boolean,
  fullCap: number,
  tun: ShadingTuning = DEFAULT_SHADING_TUNING,
): number {
  // Off-sun window (only diffuse light): mild shade, up to the stress cap under
  // strong solar load — never full close.
  if (exposure <= tun.lowExposure) {
    return solarStrong ? tun.offSunStressClose01 : tun.offSunMildClose01;
  }
  // On-sun window: a GRADUATED ramp from a mild first-shade at `lowExposure` up
  // to the full close only near the window's solar PEAK (`highExposure`). This
  // gives 30 → 50 → 75 → 95 % as the sun intensifies over the day, instead of
  // slamming straight to 95 % the moment any direct sun appears.
  if (exposure >= tun.highExposure) {
    return fullCap;
  }
  const span = Math.max(1e-6, tun.highExposure - tun.lowExposure);
  const tt = (exposure - tun.lowExposure) / span;
  return Math.min(fullCap, tun.offSunMildClose01 + (fullCap - tun.offSunMildClose01) * tt);
}

/** Pick the most-open (numerically smallest) level. */
function mostOpenOf(levels: ReadonlyArray<number>): number {
  return levels.reduce((a, b) => (b < a ? b : a));
}
/** Pick the most-closed (numerically largest) level. */
function mostClosedOf(levels: ReadonlyArray<number>): number {
  return levels.reduce((a, b) => (b > a ? b : a));
}

interface SegmentDeps {
  readonly exposureAt: (t: Date) => number;
  readonly solarStrongAt: (t: Date) => boolean;
  readonly heatCap01: number;
  readonly isRoof: boolean;
  readonly tuning: ShadingTuning;
  /**
   * Evening-open gate (Phase 3): while the solar load is no longer strong but
   * DIRECT exposure is still at/above this, keep at least a mild shade instead
   * of opening fully. `null` disables the gate.
   */
  readonly eveningOpenExposureBelow: number | null;
  readonly pvCloseFloorAt: (t: Date) => number;
}

/** Snap a target level to the most-closed candidate that does not exceed the cap. */
function levelAtCap(candidates: ReadonlyArray<number>, cap: number): number {
  const allowed = candidates.filter((l) => l <= cap + 1e-9);
  return mostClosedOf(allowed.length > 0 ? allowed : [mostOpenOf(candidates)]);
}

/**
 * Decide the DIRECT-solar-aware level for a single segment starting at `startT`
 * with room temp `startTempC`. Uses the INSTANTANEOUS sun on the window at the
 * segment start (natural tracking — no anticipatory jump from a look-ahead peak):
 *
 *   1. Roof windows: closed (heat cap) while the sun is on them; open only once
 *      the sun is gone (evening) and comfort holds open.
 *   2. Facade WITH sun + heat expected: shade PROPORTIONALLY to how much direct
 *      sun is on the window — a graduated 30 → 50 → 75 → 95 % as the sun builds,
 *      never a jump straight to 95 %.
 *   3. Facade off-sun / cool room: maximise daylight; shade only mildly if it
 *      actually helps hold comfort. A sun-on-window floor stops a full open
 *      while direct sun is still on the glass.
 */
function levelForSegment(
  startT: Date,
  startTempC: number,
  candidates: ReadonlyArray<number>,
  simFrom: SimFrom,
  bounds: ComfortBounds,
  lookaheadHours: number,
  seg: SegmentDeps,
): number {
  const exposure = seg.exposureAt(startT);
  const solarStrong = seg.solarStrongAt(startT);

  // Roof windows: strongest heat entry — closed while any sun/PV, open at dusk.
  if (seg.isRoof) {
    const sunPresent = exposure > 0.05 || solarStrong;
    if (sunPresent) {
      return seg.heatCap01;
    }
    const openTraj = simFrom(startT, startTempC, mostOpenOf(candidates), lookaheadHours);
    return holdsComfort(openTraj, bounds) ? mostOpenOf(candidates) : seg.heatCap01;
  }

  const cap = closureCapForExposure(exposure, solarStrong, seg.heatCap01, seg.tuning);
  // Would the room get too warm over the look-ahead if this window stayed fully
  // open? If not (winter / cool day) there is no reason to shade — keep it open
  // for daylight even though the sun is on it.
  const openPeak = peakTempC(simFrom(startT, startTempC, mostOpenOf(candidates), lookaheadHours));
  const heatExpected = openPeak > bounds.upperC;

  let chosen: number;
  if (exposure > seg.tuning.lowExposure && heatExpected) {
    // Sun ON the window and heat expected → start from the graduated geometric
    // cap (daylight-friendly, ramps with the direct sun over the day).
    const geo = levelAtCap(candidates, cap);
    chosen = geo;
    // TREND-AWARE heat cap: if the room is STILL predicted to exceed comfort at
    // the geometric position, close FURTHER (up to the heat cap) — but ONLY as
    // far as the forecast trajectory shows it MEANINGFULLY lowers the predicted
    // peak ("close early, but only if it actually cools"). On a hot, high-
    // radiation day this lets a not-yet-square facade (e.g. SW before the sun
    // swings on) shade early; where extra closing barely moves the peak it
    // stays at the geometric cap (no pointless over-closing). Uses the same
    // `shadeBenefitMinC` gate as the off-sun branch (profile-tunable).
    const geoPeak = peakTempC(simFrom(startT, startTempC, geo, lookaheadHours));
    if (geoPeak > bounds.upperC) {
      let bestPeak = geoPeak;
      const stronger = candidates
        .filter((l) => l > geo && l <= seg.heatCap01 + 1e-9)
        .sort((a, b) => a - b);
      for (const level of stronger) {
        const peak = peakTempC(simFrom(startT, startTempC, level, lookaheadHours));
        if (bestPeak - peak >= seg.tuning.shadeBenefitMinC) {
          chosen = level;
          bestPeak = peak;
          if (peak <= bounds.upperC) break; // comfort restored → close no further
        }
      }
    }
  } else {
    // Off-sun, or the room stays comfortable even fully open → maximise
    // daylight; shade only mildly if it clearly helps.
    const pool = candidates.filter((l) => l <= cap + 1e-9);
    const usePool = pool.length > 0 ? pool : [mostOpenOf(candidates)];
    const holding = usePool.filter((l) =>
      holdsComfort(simFrom(startT, startTempC, l, lookaheadHours), bounds),
    );
    if (holding.length > 0) {
      chosen = mostOpenOf(holding);
    } else {
      const mo = mostOpenOf(usePool);
      const mc = mostClosedOf(usePool);
      const benefitC =
        peakTempC(simFrom(startT, startTempC, mo, lookaheadHours)) -
        peakTempC(simFrom(startT, startTempC, mc, lookaheadHours));
      chosen = benefitC >= seg.tuning.shadeBenefitMinC ? mc : mo;
    }
  }

  // Sun-on-window floor: never fully open while meaningful DIRECT sun is still
  // on the glass (hold a mild shade until the sun moves off).
  if (seg.eveningOpenExposureBelow !== null && exposure >= seg.eveningOpenExposureBelow) {
    const mildFloor = Math.min(seg.tuning.offSunMildClose01, cap);
    if (chosen < mildFloor) {
      chosen = mildFloor;
    }
  }

  // PV-boost floor: while the PV array (which this window faces) delivers a lot
  // of power, close this window harder — up to full — and keep it there.
  const pvFloor = Math.min(seg.pvCloseFloorAt(startT), seg.heatCap01);
  if (chosen < pvFloor) {
    chosen = pvFloor;
  }
  return chosen;
}

/**
 * Receding-horizon phased plan for one window (bug report: "show the next 24 h
 * — when does which shutter do what"). Instead of a single hold position for
 * the whole horizon, this walks the horizon in `segmentHours` steps, decides
 * the movement-minimizing position for each segment from the room state
 * predicted at that segment's start, and emits a PlannedAction at each point
 * where the position CHANGES. The result is an honest day-ahead schedule
 * ("open now → close 11:00 when the sun arrives → open 19:00 as it cools").
 *
 * Pure. Falls back to a single-position plan (`selectPosition` semantics) when
 * the room start temperature is unknown, since the forward simulation needs a
 * numeric starting point.
 */
export function planWindowSchedule(
  ctx: PhasedPlanContext,
  simFrom: SimFrom,
  bounds: ComfortBounds,
  now: Date,
): PositionPlan {
  const seg = Math.max(1, ctx.segmentHours ?? 2);
  const look = Math.max(seg, ctx.lookaheadHours ?? 4);
  const horizon = Math.max(seg, ctx.horizonHours);
  const nSeg = Math.max(1, Math.ceil(horizon / seg));

  // Without a numeric start temperature we cannot roll the state forward.
  if (ctx.startTempC === null || !Number.isFinite(ctx.startTempC)) {
    return { windowId: ctx.windowId, target01: ctx.currentLevel01, plannedActions: [], noMoveNeeded: true };
  }

  // Segment deps for the direct-solar-aware graduated shading. Defaults keep
  // the legacy behaviour (full sun everywhere → no extra cap) when the caller
  // does not supply exposure info, so existing callers/tests are unaffected.
  const segDeps: SegmentDeps = {
    exposureAt: ctx.exposureAt ?? ((): number => 1),
    solarStrongAt: ctx.solarStrongAt ?? ((): boolean => true),
    heatCap01: ctx.heatCap01 ?? mostClosedOf(ctx.candidateLevels01),
    isRoof: ctx.isRoof ?? false,
    tuning: ctx.tuning ?? DEFAULT_SHADING_TUNING,
    eveningOpenExposureBelow: ctx.eveningOpenExposureBelow ?? null,
    pvCloseFloorAt: ctx.pvCloseFloorAt ?? ((): number => 0),
  };

  // Walk the horizon on a coarse segment grid for the (cheap) DECISION, but do
  // NOT force moves onto whole clock hours — the emitted transition time is
  // refined below to the moment the model actually wants the change. The grid
  // just starts at `now` (ms noise trimmed to the minute).
  const originMs = Math.round(now.getTime() / 60_000) * 60_000;
  const schedule: Array<{ ms: number; level: number; enterTemp: number }> = [];
  let tempCarry = ctx.startTempC;
  for (let i = 0; i < nSeg; i += 1) {
    const startMs = originMs + i * seg * 3600_000;
    const startT = new Date(startMs);
    const remainingH = horizon - i * seg;
    const lookH = Math.min(look, Math.max(seg, remainingH));
    const level = levelForSegment(startT, tempCarry, ctx.candidateLevels01, simFrom, bounds, lookH, segDeps);
    schedule.push({ ms: startMs, level, enterTemp: tempCarry });
    // Advance the carried room temperature to the end of this segment under
    // the chosen level, so the next segment decides from the real predicted
    // state rather than a frozen "now".
    const advTraj = simFrom(startT, tempCarry, level, seg);
    const lastPt = advTraj.points[advTraj.points.length - 1];
    if (lastPt !== undefined && Number.isFinite(lastPt.indoorTempC)) {
      tempCarry = lastPt.indoorTempC;
    }
  }

  const REFINE_STEP_MS = 15 * 60_000; // scan resolution within a segment
  const ROUND_MS = 5 * 60_000; // clean 5-min timestamps (not the cycle minute)
  /**
   * Refine a coarse transition (detected at segment index `k`) to the EARLIEST
   * sub-time inside the preceding segment at which the model already wants the
   * new position `toPct` — i.e. "move when it makes sense, not on the hour".
   * Rolls the room temperature forward under the position held until the move
   * (`schedule[k-1].level`) and re-evaluates the segment decision at fine steps.
   * Returns the coarse start time when no earlier crossing is found.
   */
  const refineMoveMs = (k: number, fromPct: number, toPct: number): number => {
    const cur = schedule[k];
    if (cur === undefined) return now.getTime();
    if (k === 0) return cur.ms; // immediate move — already "now"
    const prev = schedule[k - 1]!;
    const closing = toPct > fromPct;
    for (let tau = prev.ms + REFINE_STEP_MS; tau < cur.ms; tau += REFINE_STEP_MS) {
      const dtH = (tau - prev.ms) / 3600_000;
      const roll = simFrom(new Date(prev.ms), prev.enterTemp, prev.level, dtH);
      const lp = roll.points[roll.points.length - 1];
      const tempAtTau = lp !== undefined && Number.isFinite(lp.indoorTempC) ? lp.indoorTempC : prev.enterTemp;
      const remainingH = horizon - (tau - originMs) / 3600_000;
      const lookTau = Math.min(look, Math.max(seg, remainingH));
      const lvl = levelForSegment(new Date(tau), tempAtTau, ctx.candidateLevels01, simFrom, bounds, lookTau, segDeps);
      const pctTau = Math.round(level01ToPercent(lvl));
      if (closing ? pctTau >= toPct : pctTau <= toPct) {
        return Math.round(tau / ROUND_MS) * ROUND_MS;
      }
    }
    return cur.ms;
  };

  const target01 = schedule[0]?.level ?? ctx.currentLevel01;
  const currentPct = Math.round(level01ToPercent(ctx.currentLevel01));

  // Movement budget: keep "as few moves as possible" (target 2–4/day). A
  // transition is only emitted when it changes the position by at least
  // `minPositionDeltaPct`, is at least `minSecondsBetweenMoves` after the last
  // emitted move, and the per-horizon `maxMoves` cap is not yet reached.
  const minDeltaPct = Math.max(0, ctx.minPositionDeltaPct ?? 0);
  const minSpacingMs = Math.max(0, ctx.minSecondsBetweenMoves ?? 0) * 1000;
  const maxMoves = Math.max(0, ctx.maxMoves ?? Number.POSITIVE_INFINITY);

  // Emit a transition whenever the scheduled position changes enough from the
  // previously-commanded one. The first segment is compared against the
  // CURRENT position so an immediate move is captured too.
  const actions: PlannedAction[] = [];
  let prevPct = currentPct;
  let lastMoveMs = Number.NEGATIVE_INFINITY; // coarse-grid time (drives the budget)
  let lastScheduledMs = Number.NEGATIVE_INFINITY; // refined display time (monotone)
  for (let k = 0; k < schedule.length; k += 1) {
    if (actions.length >= maxMoves) {
      break;
    }
    const s = schedule[k]!;
    const pct = Math.round(level01ToPercent(s.level));
    const delta = Math.abs(pct - prevPct);
    // The movement budget (spacing/count) stays on the stable coarse grid; only
    // the emitted timestamp is refined to the model's real crossing time.
    const spacingOk = s.ms - lastMoveMs >= minSpacingMs;
    if (delta >= Math.max(1, minDeltaPct) && spacingOk) {
      let scheduledMs = refineMoveMs(k, prevPct, pct);
      // Keep timestamps ordered and never before "now".
      scheduledMs = Math.max(scheduledMs, originMs, lastScheduledMs + ROUND_MS);
      actions.push({
        windowId: ctx.windowId,
        scheduledTs: new Date(scheduledMs).toISOString(),
        targetPercent: pct,
        reason:
          pct > prevPct
            ? 'Vorausschauendes Schließen gegen Sonnenlast'
            : 'Öffnen für Tageslicht – keine Sonnenlast an diesem Fenster',
        state: 'scheduled',
      });
      prevPct = pct;
      lastMoveMs = s.ms;
      lastScheduledMs = scheduledMs;
    }
  }

  const firstPct = Math.round(level01ToPercent(target01));
  return {
    windowId: ctx.windowId,
    target01,
    plannedActions: actions,
    noMoveNeeded: firstPct === currentPct,
  };
}
