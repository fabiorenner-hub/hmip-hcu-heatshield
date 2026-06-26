/**
 * Heat Shield — Forecast_Planner orchestration
 * (predictive-control-dashboard Requirement 2/3/4).
 *
 * Pure. Runs once per engine cycle BEFORE the per-window pipeline. For each
 * room it builds a thermal trajectory and, per window, a movement-minimizing
 * base target. It also detects deviation of the measured "now" value from the
 * previous cycle's forecast baseline.
 *
 * The CycleSnapshot is already resolved through `resolveSignal` — the planner
 * adds no new I/O.
 */

import type { Config } from '../../../shared/types.js';
import type { CycleSnapshot } from '../orchestrator.js';
import { getSunPosition, type SunPosition } from '../sun.js';
import type { Location } from '../../../shared/types.js';
import { detectDeviation, type DeviationResult } from './deviation.js';
import {
  selectPosition,
  type ComfortBounds,
  type PlannedAction,
  type PositionPlan,
} from './positionSelector.js';
import {
  forecastRoom,
  type RoomTrajectory,
  type ThermalWindowInput,
} from './thermalModel.js';

/** Previous-cycle forecast values per room, used as the deviation baseline. */
export type DeviationBaseline = Record<
  string,
  { indoorTempC: number | null; heatLoad01: number | null }
>;

export interface PlannerResult {
  readonly trajectories: ReadonlyMap<string, RoomTrajectory>;
  readonly windows: ReadonlyMap<string, PositionPlan>;
  readonly deviations: ReadonlyArray<DeviationResult>;
  readonly plannedActions: ReadonlyArray<PlannedAction>;
  /** Fresh baseline to persist for the next cycle's deviation check. */
  readonly nextBaseline: DeviationBaseline;
}

export interface PlannerDeps {
  readonly config: Config;
  readonly baseline: DeviationBaseline;
  readonly now: Date;
  /**
   * Learned per-room comfort-bound bias (K) from the shading learner. Negative
   * = shade earlier; positive = allow more daylight. Optional; absent → 0.
   */
  readonly comfortBiasByRoom?: Readonly<Record<string, number>>;
  /**
   * Calibrated per-room thermal inertia (minutes) from the self-calibration
   * loop. Overrides the configured `thermalInertiaMinutes` when present so the
   * forecast tracks the room's real thermal response. Optional; absent → use
   * the configured value.
   */
  readonly inertiaByRoom?: Readonly<Record<string, number>>;
}

/**
 * Extra upper-bound slack (K) when the forecast is uncertain. Low confidence
 * (stale/missing inputs, volatile weather) → hold shading back a little so the
 * planner does not make needless moves it cannot justify. Bounded to 1 K.
 */
export function uncertaintyMarginC(confidence01: number): number {
  const c = Number.isFinite(confidence01) ? Math.max(0, Math.min(1, confidence01)) : 0.9;
  return Math.round((1 - c) * 1.0 * 100) / 100;
}

function comfortBoundsFor(_targetC: number, warningC: number, biasC = 0): ComfortBounds {
  // Movement-minimization only guards against OVERHEATING (upper bound).
  // The cold/lower side is owned by the existing winter-insulation rule in
  // the orchestrator (Step 3b¾); the planner must not duplicate or override
  // it, so there is effectively no lower comfort constraint here.
  //
  // `biasC` is the learned day-to-day adjustment: negative tightens the upper
  // bound (shade earlier, room ran too warm), positive loosens it (allow more
  // daylight, room stayed cool). Clamped by the learner to a small range.
  return { lowerC: Number.NEGATIVE_INFINITY, upperC: warningC + biasC };
}

const DEFAULT_PLANNING = {
  horizonHours: 12,
  timeStepMinutes: 15,
  deviationToleranceC: 1.5,
  deviationToleranceLoad01: 0.15,
  plannedMinSecondsBetweenMoves: 7200,
  movementBudgetPerInterval: 1,
  candidateLevels01: [0, 0.25, 0.5, 0.75, 0.95, 1],
} as const;

/**
 * Per-window heat-stau close cap in `[0, 1]`, mirroring the live command cap in
 * the orchestrator (Step 3d½): façades stop at 0.95 (a 5 % gap so hot air can
 * escape), roof windows may fully close (1.0), and a per-window
 * `maxHeatProtectionLevel01` overrides both. The forecast plan MUST respect this
 * so "Nächste Aktionen", the twin preview and the heatmap never show a façade
 * being driven to 100 % when the engine would actually command 95 %.
 */
export function heatCapForWindow(win: {
  type?: string | undefined;
  maxHeatProtectionLevel01?: number | undefined;
}): number {
  return win.maxHeatProtectionLevel01 ?? (win.type === 'roof_window' ? 1 : 0.95);
}

/**
 * Clamp the candidate shutter levels to the per-window heat-stau cap and
 * de-duplicate. Only the closing direction is limited; open levels are left
 * untouched. e.g. cap 0.95 turns `[0,0.25,0.5,0.75,0.95,1]` into
 * `[0,0.25,0.5,0.75,0.95]`.
 */
export function capCandidateLevels(
  levels: ReadonlyArray<number>,
  cap01: number,
): number[] {
  const out: number[] = [];
  for (const l of levels) {
    const capped = Math.min(l, cap01);
    if (!out.some((x) => Math.abs(x - capped) < 1e-9)) {
      out.push(capped);
    }
  }
  return out;
}

/** Build the per-room/-window forecast plan for this cycle. */
export function runForecastPlanner(
  snapshot: CycleSnapshot,
  deps: PlannerDeps,
): PlannerResult {
  const { config, baseline, now } = deps;
  const planning = config.rules.planning ?? DEFAULT_PLANNING;
  const trajectories = new Map<string, RoomTrajectory>();
  const windowsPlan = new Map<string, PositionPlan>();
  const deviations: DeviationResult[] = [];
  const plannedActions: PlannedAction[] = [];
  const nextBaseline: DeviationBaseline = {};

  // B1: memoize sun positions per timestamp. The Forecast_Planner re-simulates
  // the trajectory once per candidate level per window; the sun position
  // depends only on the timestamp, so caching it collapses thousands of
  // redundant trig evaluations per cycle into one per distinct timestamp.
  const sunCache = new Map<number, SunPosition>();
  const memoSun = (t: Date, loc: Pick<Location, 'latitude' | 'longitude'>): SunPosition => {
    const key = t.getTime();
    const hit = sunCache.get(key);
    if (hit !== undefined) {
      return hit;
    }
    const pos = getSunPosition(t, loc);
    sunCache.set(key, pos);
    return pos;
  };

  // A1/A2: per-timestamp weather sampler from the OpenMeteo hourly series.
  // Picks the nearest sample to `t`; returns nulls when no series is present
  // (the thermal model then falls back to the scalar `now` values).
  const series = snapshot.forecastSeries ?? [];
  const seriesMs = series.map((p) => Date.parse(p.ts));
  const sampleForecast = (
    t: Date,
  ): { outdoorTempC?: number | null; radiationWm2?: number | null; cloudCover01?: number | null } => {
    if (series.length === 0) {
      return {};
    }
    const tMs = t.getTime();
    let bestIdx = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < seriesMs.length; i += 1) {
      const ms = seriesMs[i]!;
      if (Number.isNaN(ms)) {
        continue;
      }
      const diff = Math.abs(ms - tMs);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestIdx = i;
      }
    }
    const p = series[bestIdx]!;
    return {
      outdoorTempC: p.tempC,
      radiationWm2: p.radiationWm2,
      cloudCover01: p.cloudCover01,
    };
  };

  // Group windows by room.
  const windowsByRoom = new Map<string, CycleSnapshot['windows']>();
  for (const w of snapshot.windows) {
    const list = windowsByRoom.get(w.config.roomId) ?? [];
    list.push(w);
    windowsByRoom.set(w.config.roomId, list);
  }

  for (const [roomId, roomData] of snapshot.rooms) {
    const roomCfg = config.rooms.find((r) => r.id === roomId);
    const roomWindows = windowsByRoom.get(roomId) ?? [];
    const inertia =
      deps.inertiaByRoom?.[roomId] ?? roomCfg?.thermalInertiaMinutes ?? 120;

    const baseWindows = (overrideWindowId?: string, overrideLevel?: number): ThermalWindowInput[] =>
      roomWindows.map((w) => ({
        orientationDeg: w.config.orientationDeg,
        areaM2: w.config.areaM2 ?? 1.5,
        type: w.config.type,
        currentLevel01:
          overrideWindowId !== undefined && w.config.id === overrideWindowId
            ? (overrideLevel ?? 0)
            : (w.currentLevel01 ?? 0),
      }));

    const staleInputs = new Set<string>();
    if (snapshot.outdoorTempC === null) staleInputs.add('outdoorTemp');
    if (snapshot.radiationWm2 === null) staleInputs.add('radiation');

    const baseTraj = forecastRoom({
      now,
      horizonHours: planning.horizonHours,
      timeStepMinutes: planning.timeStepMinutes,
      location: config.location,
      room: {
        id: roomId,
        thermalInertiaMinutes: inertia,
        indoorTempC: roomData.tempC,
        targets: roomData.targets,
      },
      windows: baseWindows(),
      outdoorTempC: snapshot.outdoorTempC,
      forecastMaxTempC: snapshot.forecastMaxTempC,
      cloudCover01: null,
      radiationWm2: snapshot.radiationWm2,
      pvPowerKw: snapshot.pvSmoothedKw,
      pvPeakKwp: config.fusionSolar.pvPeakKwp,
      staleInputs,
      sunFn: memoSun,
      sampleForecast,
    });

    if (baseTraj !== null) {
      trajectories.set(roomId, baseTraj);
    }

    // Deviation vs previous baseline for this room (now vs forecast-now).
    const base = baseline[roomId];
    const dev = detectDeviation({
      roomId,
      measuredIndoorTempC: roomData.tempC,
      measuredHeatLoad01: null,
      forecastIndoorTempC: base?.indoorTempC ?? null,
      forecastHeatLoad01: base?.heatLoad01 ?? null,
      toleranceC: planning.deviationToleranceC,
      toleranceLoad01: planning.deviationToleranceLoad01,
    });
    deviations.push(dev);

    // Fresh baseline = the trajectory's "now" point (first sample).
    const firstPoint = baseTraj?.points[0];
    nextBaseline[roomId] = {
      indoorTempC: firstPoint?.indoorTempC ?? null,
      heatLoad01: firstPoint?.heatLoad01 ?? null,
    };

    const bounds = comfortBoundsFor(
      roomData.targets.target_c,
      roomData.targets.warning_c,
      (deps.comfortBiasByRoom?.[roomId] ?? 0) +
        uncertaintyMarginC(baseTraj?.confidence01 ?? 0.9),
    );

    for (const w of roomWindows) {
      // No trajectory → no plan; orchestrator falls back to the risk path.
      if (baseTraj === null) {
        continue;
      }
      const trajectoryForLevel = (level01: number): RoomTrajectory => {
        const t = forecastRoom({
          now,
          horizonHours: planning.horizonHours,
          timeStepMinutes: planning.timeStepMinutes,
          location: config.location,
          room: {
            id: roomId,
            thermalInertiaMinutes: inertia,
            indoorTempC: roomData.tempC,
            targets: roomData.targets,
          },
          windows: baseWindows(w.config.id, level01),
          outdoorTempC: snapshot.outdoorTempC,
          forecastMaxTempC: snapshot.forecastMaxTempC,
          cloudCover01: null,
          radiationWm2: snapshot.radiationWm2,
          pvPowerKw: snapshot.pvSmoothedKw,
          pvPeakKwp: config.fusionSolar.pvPeakKwp,
          staleInputs,
          sunFn: memoSun,
          sampleForecast,
        });
        return t ?? baseTraj;
      };

      const plan = selectPosition(
        {
          windowId: w.config.id,
          roomId,
          currentLevel01: w.currentLevel01 ?? 0,
          candidateLevels01: capCandidateLevels(
            planning.candidateLevels01,
            heatCapForWindow(w.config),
          ),
          minSecondsBetweenMoves: planning.plannedMinSecondsBetweenMoves,
          movementBudgetPerInterval: planning.movementBudgetPerInterval,
        },
        trajectoryForLevel,
        bounds,
        now,
      );
      windowsPlan.set(w.config.id, plan);
      for (const a of plan.plannedActions) {
        plannedActions.push(a);
      }
    }
  }

  plannedActions.sort((a, b) => a.scheduledTs.localeCompare(b.scheduledTs));

  return {
    trajectories,
    windows: windowsPlan,
    deviations,
    plannedActions,
    nextBaseline,
  };
}
