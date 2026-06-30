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
import { computeCloudNowcast, arrayAzimuthFromHint } from './nowcast.js';
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
  /**
   * Per-room counterfactual trajectory with EVERY window fully shaded to its
   * heat-stau cap (best-case shading). Used by the "Temperatur mit Beschattung"
   * chart so it shows the genuine effect of shading rather than the current
   * (already-shaded) state. Same keys as `trajectories`.
   */
  readonly shadedTrajectories: ReadonlyMap<string, RoomTrajectory>;
  /**
   * Per-room counterfactual trajectory with EVERY window fully OPEN (level 0,
   * full solar gain) — the "ohne Beschattung" worst case. Same keys as
   * `trajectories`.
   */
  readonly openTrajectories: ReadonlyMap<string, RoomTrajectory>;
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
  /**
   * Self-learned PV array azimuth (deg) from the power curve. When present it
   * overrides the configured `orientationHint` for the live PV cloud nowcast,
   * so the nowcast self-calibrates to the real array. Optional; absent → hint.
   */
  readonly pvArrayAzimuthDeg?: number;
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

/**
 * Default per-floor shading lead (K) derived from a free-form floor label.
 * Upper floors heat up faster, so they shade earlier (larger lead → tighter
 * upper comfort bound). Matched case-insensitively against common German
 * level labels; unknown labels get 0 (neutral, like the ground floor).
 *
 *   DG / Dach / Spitzboden …  → 1.0 K   (attic, hottest)
 *   OG / 1.OG / 2.OG / Ober … → 0.6 K   (upper floors)
 *   EG / Erd / Parterre …     → 0.0 K   (ground, neutral)
 *   KG / UG / Keller / Souter → 0.0 K   (cellar; cool already, no lead)
 */
export function defaultFloorLeadC(label: string | undefined): number {
  if (label === undefined) return 0;
  const s = label.trim().toLowerCase();
  if (s.length === 0) return 0;
  if (/(^|[^a-z])(dg|dach|spitzboden|attika)/u.test(s)) return 1.0;
  if (/(^|[^a-z])(og|ober|dachge)/u.test(s) || /\d\s*\.?\s*og/u.test(s)) return 0.6;
  return 0;
}

/**
 * Resolve the shading lead (K) for a room's floor: an explicit per-floor value
 * from config wins; otherwise the default classifier. Returns 0 when the
 * feature is disabled. The lead TIGHTENS the upper comfort bound (shade
 * earlier on higher floors).
 */
export function floorLeadFor(
  floorLabel: string | undefined,
  floorShading: Config['rules']['floorShading'] | undefined,
): number {
  if (floorShading === undefined || floorShading.enabled === false) return 0;
  if (floorLabel !== undefined) {
    const explicit = floorShading.leadByFloor?.[floorLabel];
    if (typeof explicit === 'number' && Number.isFinite(explicit)) {
      return Math.max(0, Math.min(4, explicit));
    }
  }
  return defaultFloorLeadC(floorLabel);
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
  const shadedTrajectories = new Map<string, RoomTrajectory>();
  const openTrajectories = new Map<string, RoomTrajectory>();
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

  // "Zweiter Hebel": live PV cloud nowcast. When the sun is on the PV array we
  // can read current cloudiness from PV vs. the clear-sky expectation and damp
  // the NEAR-TERM forecast radiation accordingly, fading back to the raw
  // forecast over `NOWCAST_WINDOW_MS`. Unreliable (→ no correction) when the
  // sun is too low or off the array (e.g. SE array in the late-afternoon west
  // sun), where low PV is expected geometry, not clouds.
  const NOWCAST_WINDOW_MS = 3 * 3600_000;
  const nowcast = computeCloudNowcast({
    pvSmoothedKw: snapshot.pvSmoothedKw,
    pvPeakKwp: config.fusionSolar.pvPeakKwp,
    sun: memoSun(now, config.location),
    arrayAzimuthDeg: deps.pvArrayAzimuthDeg ?? arrayAzimuthFromHint(config.fusionSolar.orientationHint),
  });
  const nowMs = now.getTime();

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
    // Apply the live PV nowcast to the near-term radiation only.
    let radiationWm2 = p.radiationWm2;
    if (nowcast.reliable && radiationWm2 !== null) {
      const dtMs = tMs - nowMs;
      if (dtMs >= 0 && dtMs <= NOWCAST_WINDOW_MS) {
        const progress = dtMs / NOWCAST_WINDOW_MS; // 0 now → 1 at window end
        const factor = nowcast.cloudFactor01 + (1 - nowcast.cloudFactor01) * progress;
        radiationWm2 = radiationWm2 * factor;
      }
    }
    return {
      outdoorTempC: p.tempC,
      radiationWm2,
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

    // Counterfactual window sets for the "mit/ohne Beschattung" charts:
    //  - openWindows:   every shutter fully OPEN (level 0) → full solar gain.
    //  - shadedWindows: every shutter closed to its heat-stau cap (best case).
    const openWindows = (): ThermalWindowInput[] =>
      roomWindows.map((w) => ({
        orientationDeg: w.config.orientationDeg,
        areaM2: w.config.areaM2 ?? 1.5,
        type: w.config.type,
        currentLevel01: 0,
      }));
    const shadedWindows = (): ThermalWindowInput[] =>
      roomWindows.map((w) => ({
        orientationDeg: w.config.orientationDeg,
        areaM2: w.config.areaM2 ?? 1.5,
        type: w.config.type,
        currentLevel01: heatCapForWindow(w.config),
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

      // Counterfactual open/shaded trajectories share every input with the
      // base trajectory except the per-window shutter levels. Reusing the
      // memoized sun cache + forecast sampler keeps this cheap.
      const counterfactual = (windows: ThermalWindowInput[]): RoomTrajectory | null =>
        forecastRoom({
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
          windows,
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
      const openTraj = counterfactual(openWindows());
      const shadedTraj = counterfactual(shadedWindows());
      if (openTraj !== null) {
        openTrajectories.set(roomId, openTraj);
      }
      if (shadedTraj !== null) {
        shadedTrajectories.set(roomId, shadedTraj);
      }
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
      (deps.comfortBiasByRoom?.[roomId] ?? 0) -
        floorLeadFor(roomCfg?.floor, config.rules.floorShading) +
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
    shadedTrajectories,
    openTrajectories,
    windows: windowsPlan,
    deviations,
    plannedActions,
    nextBaseline,
  };
}
