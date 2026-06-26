/**
 * Heat Shield — per-cycle orchestrator (Task 8.1).
 *
 * The orchestrator is the cycle driver. Once per engine tick the
 * dashboard / boot module hands it a {@link CycleSnapshot} (already
 * resolved from the source bus) plus an {@link OrchestratorDeps} bag,
 * and the orchestrator:
 *
 *   1. Computes the per-cycle helpers (max priority-room temperature,
 *      sun-day key events, sun position).
 *   2. Runs the mode FSM (`engine/modes.ts::determineMode`).
 *   3. For each configured window, runs the per-window decision
 *      pipeline:
 *
 *        risk → specialRules → ventilation → safety → hysteresis
 *
 *      and, when hysteresis says `shouldMove`, dispatches a single
 *      `setShutterLevel` call through the injected
 *      {@link OrchestratorDeps.hmipSystem} adapter.
 *   4. Builds a {@link DecisionRecord} (one entry per window) and
 *      appends it to the NDJSON history store via the optional
 *      {@link OrchestratorDeps.appendHistoryRecord} sink.
 *   5. Returns the record plus the new `stormHoldUntil` value the
 *      orchestrator's caller is responsible for persisting to
 *      `RuntimeState.stormHoldUntil`.
 *
 * ─── Steering compliance ──────────────────────────────────────────
 *
 *   - The orchestrator NEVER emits `STATUS_EVENT` for native HCU
 *     shutters. It only calls
 *     {@link OrchestratorDeps.hmipSystem.setShutterLevel}, which
 *     funnels through `connect/hmipSystem.ts::HmipSystemAdapter` and
 *     therefore through the spec-compliant
 *     `HmipSystemRequest /hmip/device/control/setShutterLevel`
 *     wire path.
 *   - This module owns no Connect API plumbing of its own — the
 *     boot module (Task 9 wiring) is responsible for instantiating
 *     the WebSocket client + adapter and passing it in via
 *     `deps.hmipSystem`.
 *
 * ─── Design.md cross-references ──────────────────────────────────
 *
 *   - §Property 6 priority order (STORM > MAINTENANCE > pause > door
 *     lockout > manual override > heat protection > night cooling >
 *     comfort) is enforced by the safety layer (`engine/safety.ts`),
 *     which this module simply consults.
 *   - DecisionRecord shape lives in `shared/decision-schema.ts` —
 *     this module produces values that pass that schema.
 *   - `BlockedBy` enum surface (`hysteresis | min_seconds |
 *     manual_override | pause | storm | system_error`) is mapped from
 *     the upstream pipeline's richer reason strings inside
 *     {@link mapBlockedBy}.
 *
 * Module rules (mirrored from sibling engine modules):
 *   - Strict TS, ESM, `.js` import suffixes.
 *   - Pure with respect to the input snapshot — no fs, no Connect API
 *     plumbing, no globals. Side effects are confined to the injected
 *     `hmipSystem.setShutterLevel`, the optional `appendHistoryRecord`,
 *     and the optional `logger`.
 *   - All thrown errors from `setShutterLevel` are caught and surfaced
 *     as `blockedBy: 'system_error'` on the decision record entry —
 *     the cycle never aborts mid-window because the HCU rejected one
 *     command.
 */

import { randomUUID } from 'node:crypto';

import type { HistoryRecord } from '../persistence/history.js';
import type {
  BlockedBy,
  Config,
  ContactState,
  DecisionRecord,
  Mode,
  Priority,
  RoomTargets,
  Window,
  WindowDecisionEntry,
  WindowRuntimeState,
} from '../../shared/types.js';

import { applyHysteresis, type HysteresisBlockedBy } from './hysteresis.js';
import { determineMode, type ModeExplanation } from './modes.js';
import {
  computeRisk,
  mapRiskToShutter01,
  type RiskBreakdown,
} from './risk.js';
import { applySafety } from './safety.js';
import { applySpecialRules } from './specialRules.js';
import * as sunModule from './sun.js';
import {
  runForecastPlanner,
  type DeviationBaseline,
  type PlannerResult,
} from './forecast/planner.js';
import type { UserIntent } from './userIntent.js';
import { applyVentilation, isVentingLockout } from './ventilation.js';

// ---------------------------------------------------------------------------
// Public types.
// ---------------------------------------------------------------------------

/**
 * Inputs for one engine cycle. The boot module / dashboard probe
 * resolves the snapshot from the source bus + persisted runtime state
 * before calling {@link runCycle}; this module is otherwise pure with
 * respect to the snapshot.
 *
 *   - `now` is the wall-clock instant the cycle is being evaluated
 *     for. Tests pin a deterministic UTC timestamp.
 *   - `forecastMaxTempC` carries the design.md §Property 5 horizon-
 *     adjusted forecast (today before 14:00 local; max(rest-of-today,
 *     tomorrow) afterwards). The orchestrator is the consumer; the
 *     caller is responsible for the horizon math.
 *   - `pvDroppedRecently` is the boolean that powers
 *     `engine/hysteresis.ts::pv_cloud` smoothing. The caller computes
 *     it from the smoothed PV history (did `pvSmoothedKw` cross
 *     `roof_force_close_kw` from above to below in the last 15 min?).
 *   - `rooms` is keyed by `roomId` (Room.id from the schema). Each
 *     entry carries the live tempC reading, the room's target ladder,
 *     and its priority — everything the per-window pipeline needs
 *     for `computeRisk` / `applySpecialRules`.
 *   - `windows` is an array (preserves config order so the
 *     dashboard's per-window cards stay stable). Each entry carries
 *     the `Window` config plus the live runtime + contact state.
 *   - `stormHoldUntil` and `maintenanceMode` are the persisted
 *     runtime values relevant to the FSM. They are pulled from
 *     `RuntimeState` by the caller and re-persisted afterwards.
 */
export interface CycleSnapshot {
  /** Wall-clock instant for the cycle. */
  now: Date;
  /** Outdoor temperature reading (already resolved through `resolveSignal`). */
  outdoorTempC: number | null;
  /** Forecast daily max temp (horizon-adjusted per design §Property 5). */
  forecastMaxTempC: number | null;
  /** Smoothed PV power (kW) — already smoothed by the sources layer. */
  pvSmoothedKw: number | null;
  /** Whether PV crossed roof_force_close from above to below within last 15 min. */
  pvDroppedRecently: boolean;
  /** Wind speed in m/s. */
  windSpeedMs: number | null;
  /** Short-wave radiation in W/m². */
  radiationWm2: number | null;
  /** Per-room data keyed by `Room.id`. */
  rooms: Map<
    string,
    {
      tempC: number | null;
      targets: RoomTargets;
      priority: Priority;
    }
  >;
  /** Per-window state: window config + runtime. */
  windows: Array<{
    config: Window;
    contactState: ContactState;
    currentLevel01: number | null;
    runtimeState: WindowRuntimeState | null;
  }>;
  /** Plugin-owned switch states, sourced from `OwnDeviceManager`. */
  switches: { vacation: boolean; pauseControl: boolean };
  /**
   * Persisted high-level user intent (Task 9.1). Optional for
   * backward compatibility with callers that have not been wired up
   * yet — when omitted the orchestrator falls back to the legacy
   * `switches.pauseControl` / `switches.vacation` reading and treats
   * the pause-until / vacation-offset machinery as inactive.
   */
  userIntent?: UserIntent;
  /** Persisted storm-hold ISO-derived Date, or null when no hold is active. */
  stormHoldUntil: Date | null;
  /** Whether the dashboard has flipped the engine into maintenance. */
  maintenanceMode: boolean;
  /**
   * Optional hourly weather forecast curve (predictive-control-dashboard
   * A1/A2). When present, the Forecast_Planner samples it per trajectory
   * point so the thermal model follows the diurnal sun/temperature curve
   * instead of freezing the current values across the whole horizon.
   */
  forecastSeries?: ReadonlyArray<{
    ts: string;
    tempC: number | null;
    radiationWm2: number | null;
    cloudCover01: number | null;
  }>;
}

/**
 * Outputs of one engine cycle. The caller is responsible for:
 *
 *   - Persisting `newStormHoldUntil` to
 *     `RuntimeState.stormHoldUntil` (only when non-null and different
 *     from the existing value — the FSM signals "no change" with
 *     `null`).
 *   - Optionally surfacing `mode` to the dashboard live view.
 *   - Optionally consuming `decisionRecord` for downstream sinks
 *     beyond the NDJSON history (e.g. an in-memory ring buffer for
 *     the Diagnose tab).
 */
export interface CycleOutputs {
  /** Decision record for this cycle, already appended to history if a sink was provided. */
  decisionRecord: DecisionRecord;
  /** New `stormHoldUntil` to persist; `null` when no change. */
  newStormHoldUntil: Date | null;
  /** Mode chosen for this cycle. */
  mode: Mode;
  /** German explanation of the deciding factor for {@link mode}. */
  modeExplanation: ModeExplanation;
  /** Forecast plan for this cycle (predictive-control-dashboard); undefined if it failed. */
  plannerResult?: PlannerResult;
}

/**
 * Dependency bag for {@link runCycle}.
 *
 *   - `config` — full parsed config (used for location, fusionSolar,
 *     rules.profile, rules.sun, rules.storm, rules.nightCooling,
 *     rules.automation).
 *   - `hmipSystem` — structural subset of the
 *     `HmipSystemAdapter` API. The orchestrator only needs
 *     `setShutterLevel`; tests pass a `vi.fn`.
 *   - `appendHistoryRecord` — optional NDJSON sink (typically
 *     `persistence/history.ts::appendRecord`). When omitted, the
 *     decision record is still produced and returned, just not
 *     persisted.
 *   - `logger` — optional structured logger. The orchestrator logs
 *     manual-override skips and `setShutterLevel` errors at warn
 *     level. Absent by default so unit tests stay silent.
 *   - `sun` — opt-in sun-module override for testability. Defaults to
 *     the live `engine/sun.ts` module.
 *   - `channelIndexFor` — opt-in `windowId → channelIndex` resolver.
 *     Defaults to `() => 1` (the steering-confirmed channel for
 *     WINDOW_COVERING devices).
 */
export interface OrchestratorDeps {
  config: Config;
  hmipSystem: {
    setShutterLevel: (
      deviceId: string,
      channel: number,
      level01: number,
    ) => Promise<void>;
  };
  appendHistoryRecord?: (record: HistoryRecord<DecisionRecord>) => Promise<void>;
  logger?: (
    level: 'info' | 'warn' | 'error',
    msg: string,
    ctx?: Record<string, unknown>,
  ) => void;
  sun?: typeof import('./sun.js');
  channelIndexFor?: (windowId: string) => number;
  /**
   * Deviation baseline from the previous cycle (predictive-control-dashboard).
   * When provided, the Forecast_Planner runs and supplies a per-window base
   * target; absent → treated as empty and the planner still runs with no
   * baseline (no deviation trigger on the first cycle).
   */
  forecastBaseline?: DeviationBaseline;
  /**
   * Learned per-room comfort-bound bias (K) from the shading learner, forwarded
   * to the Forecast_Planner. Optional; absent → no learned adjustment.
   */
  comfortBiasByRoom?: Readonly<Record<string, number>>;
  /**
   * Calibrated per-room thermal inertia (minutes) from the self-calibration
   * loop, forwarded to the Forecast_Planner. Optional; absent → configured.
   */
  inertiaByRoom?: Readonly<Record<string, number>>;
}

// ---------------------------------------------------------------------------
// Internal helpers.
// ---------------------------------------------------------------------------

/**
 * Priority rooms — those eligible for the FSM's
 * `maxPriorityRoomTempC` aggregation. The regelwerk's HEATWAVE /
 * ACTIVE thresholds inspect "priority rooms" and the steering doc
 * §Standortprofil designates `Schlafzimmer` and `Arbeitszimmer` as
 * priority rooms; the schema maps that intent onto `very_high` and
 * `high` priorities.
 */
const PRIORITY_LEVELS: ReadonlySet<Priority> = new Set<Priority>([
  'very_high',
  'high',
]);

/**
 * Compute the max temperature among priority rooms (`very_high` or
 * `high`). Returns `null` when no priority room has a live reading —
 * the FSM treats that as "no signal" and falls through to the
 * forecast-driven branches.
 */
function maxPriorityRoomTempC(
  rooms: CycleSnapshot['rooms'],
): number | null {
  let max: number | null = null;
  for (const room of rooms.values()) {
    if (!PRIORITY_LEVELS.has(room.priority)) {
      continue;
    }
    if (room.tempC === null) {
      continue;
    }
    if (max === null || room.tempC > max) {
      max = room.tempC;
    }
  }
  return max;
}

/**
 * Map upstream `safety.appliedRules` strings to the
 * {@link BlockedBy} enum used by the decision record.
 *
 * The mapping mirrors the source-of-truth strings emitted by
 * `engine/safety.ts` and `engine/ventilation.ts`:
 *
 *   - `'maintenance: hold position'` → `'pause'` (closest match in
 *     the BlockedBy enum; the dashboard reads the underlying mode
 *     for the actual reason).
 *   - `'pause: hold position'` → `'pause'`.
 *   - `'§14.6 cannot-move-when-open: hold position'` → `'manual_override'`
 *     (engine treats a stuck-open sash as an override situation; the
 *     diagnose-tab tooltip carries the literal rule string for
 *     clarity).
 *   - `'manual override active until <ISO>'` → `'manual_override'`.
 *   - `'storm: force open'` cannot reach this mapper — STORM never
 *     suppresses the move (`suppressMove === false`). Defensive
 *     fallthrough returns `'storm'` for that case.
 */
function mapSafetySuppressToBlockedBy(safetyRules: readonly string[]): BlockedBy {
  for (const rule of safetyRules) {
    if (rule.startsWith('manual override active until')) {
      return 'manual_override';
    }
    if (rule.startsWith('§14.6 cannot-move-when-open')) {
      return 'manual_override';
    }
    if (rule.startsWith('maintenance: hold position')) {
      return 'pause';
    }
    if (rule.startsWith('pause: hold position')) {
      return 'pause';
    }
    if (rule.startsWith('storm: force open')) {
      return 'storm';
    }
  }
  // Defensive fallthrough — safety surfaced suppress=true but no
  // recognised rule string. Treat as a `pause`-style hold so the
  // dashboard at least labels the entry consistently.
  return 'pause';
}

/**
 * Map a `HysteresisBlockedBy` reason onto the `BlockedBy` enum used
 * by the decision record. `safety_suppress` is forwarded to
 * {@link mapSafetySuppressToBlockedBy}; the other three buckets all
 * collapse to `'hysteresis'` or `'min_seconds'` per design.md.
 */
function mapHysteresisBlockedBy(
  hb: HysteresisBlockedBy,
  safetyRules: readonly string[],
): BlockedBy {
  switch (hb) {
    case 'safety_suppress':
      return mapSafetySuppressToBlockedBy(safetyRules);
    case 'min_seconds':
      return 'min_seconds';
    case 'min_position_delta':
    case 'no_change':
    case 'pv_cloud':
      return 'hysteresis';
  }
}

/**
 * Build the `factors` map for a {@link WindowDecisionEntry} from the
 * risk breakdown. The dashboard's stacked-bar visual reads these
 * keys directly, so the field naming matches `RiskBreakdown.factors`.
 */
function buildFactorsMap(risk: RiskBreakdown): Record<string, number> {
  return {
    sunFactor: risk.factors.sunFactor,
    roomTempFactor: risk.factors.roomTempFactor,
    windowTypeFactor: risk.factors.windowTypeFactor,
    forecastTempFactor: risk.factors.forecastTempFactor,
    pvFactor: risk.factors.pvFactor,
    radiationFactor: risk.factors.radiationFactor,
    outdoorTempFactor: risk.factors.outdoorTempFactor,
    priorityFactor: risk.factors.priorityFactor,
  };
}

// ---------------------------------------------------------------------------
// runCycle.
// ---------------------------------------------------------------------------

/**
 * Local clock hour (0–23) for `now` in the configured timezone. Quiet hours
 * and per-room schedules are expressed in wall-clock time, so we must read the
 * hour in the home's timezone rather than the container's. Falls back to the
 * server-local hour if the timezone string is unusable.
 */
function localHourIn(now: Date, timezone: string): number {
  try {
    const s = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      hour12: false,
    }).format(now);
    const h = Number.parseInt(s, 10);
    return Number.isFinite(h) ? h % 24 : now.getHours();
  } catch {
    return now.getHours();
  }
}

/**
 * Whether `hour` lies inside the daily interval `[start, end)`, wrapping across
 * midnight when `start > end` (e.g. 22 → 6). `start === end` means "empty".
 */
function hourInWrappingInterval(hour: number, start: number, end: number): boolean {
  if (start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/**
 * Per-room quiet schedule: blocked before `before` or at/after `after`
 * (local clock hours). Either bound is optional. STORM ignores this.
 */
function roomHourBlocked(
  hour: number,
  before: number | undefined,
  after: number | undefined,
): boolean {
  if (before !== undefined && hour < before) return true;
  if (after !== undefined && hour >= after) return true;
  return false;
}

/** Map the configured PV array orientation hint to a centre azimuth (deg). */
function pvLobeCenterFor(hint: string): number {
  switch (hint) {
    case 'east':
      return 90;
    case 'southeast':
      return 135;
    case 'southwest':
      return 225;
    case 'west':
      return 270;
    case 'south':
    case 'mixed':
    default:
      return 180;
  }
}

/**
 * Run one engine cycle for the supplied snapshot and return the
 * resulting {@link CycleOutputs}. See module header for the high-level
 * flow.
 *
 * The function awaits each `setShutterLevel` call sequentially so the
 * HCU is never asked to process two control requests for the same
 * cycle in parallel; this mirrors the eq3 example plugins' single-flight
 * approach and keeps the request-id bookkeeping in
 * `connect/hmipSystem.ts` simple.
 */
export async function runCycle(
  snapshot: CycleSnapshot,
  deps: OrchestratorDeps,
): Promise<CycleOutputs> {
  const sun = deps.sun ?? sunModule;
  const channelFor = deps.channelIndexFor ?? ((): number => 1);
  const log = deps.logger;

  // -------------------------------------------------------------------------
  // 1. Per-cycle helpers — priority-room temp aggregation, sun-day key
  //    events, sun position.
  // -------------------------------------------------------------------------
  const maxRoomC = maxPriorityRoomTempC(snapshot.rooms);
  const sunDay = sun.getSunDay(snapshot.now, deps.config.location);
  const sunPos = sun.getSunPosition(snapshot.now, deps.config.location);

  // -------------------------------------------------------------------------
  // 1a. User intent → effective switch state (Task 9.1).
  //
  //     `userIntent.paused` lasts until `pauseUntil` (next local
  //     midnight at the time of toggle); after that the pause expires
  //     automatically. We OR the persisted intent with the live
  //     `switches.pauseControl` value so a stale intent and a fresh
  //     toggle stay in lockstep — the orchestrator's own-device
  //     callback is the single producer of both signals.
  //
  //     `vacationActive` triggers two effects: (a) the mode FSM picks
  //     `VACATION`, (b) every room's target/warning/strong_shade are
  //     shifted down by `rules.comfort.vacationOffsetC`. `critical_c`
  //     is NOT shifted (steering: hard ceiling).
  // -------------------------------------------------------------------------
  const userIntent = snapshot.userIntent;
  const pauseFromIntent =
    userIntent !== undefined &&
    userIntent.paused &&
    (userIntent.pauseUntil === null ||
      userIntent.pauseUntil.getTime() > snapshot.now.getTime());
  // Night inactivity (config toggle): while the sun is below the horizon and
  // the user enabled it, the plugin makes NO automatic shutter movements.
  // Folded into the pause path so STORM safety force-open still overrides it.
  const nightInactive =
    deps.config.rules.automation.pauseBetweenSunsetAndSunrise === true && !sunPos.isUp;
  // Quiet hours (V1.5): a daily clock-time interval during which the plugin
  // makes no automatic moves. STORM force-open still overrides (folded into
  // the same pause path as night-inactivity).
  const localHour = localHourIn(snapshot.now, deps.config.location.timezone);
  const quiet = deps.config.rules.automation.quietHours;
  const quietActive =
    quiet?.enabled === true &&
    hourInWrappingInterval(localHour, quiet.startHour, quiet.endHour);
  const effectivePauseControl =
    snapshot.switches.pauseControl || pauseFromIntent || nightInactive || quietActive;
  const vacationActive =
    snapshot.switches.vacation || (userIntent?.vacation ?? false);
  const vacationOffsetC = vacationActive
    ? deps.config.rules.comfort.vacationOffsetC
    : 0;

  // -------------------------------------------------------------------------
  // 2. Mode FSM.
  // -------------------------------------------------------------------------
  const modeDecision = determineMode({
    now: snapshot.now,
    outdoorTempC: snapshot.outdoorTempC,
    forecastMaxTempC: snapshot.forecastMaxTempC,
    pvSmoothedKw: snapshot.pvSmoothedKw,
    windSpeedMs: snapshot.windSpeedMs,
    maxPriorityRoomTempC: maxRoomC,
    sunriseUtc: sunDay.sunriseUtc,
    sunIsUp: sunPos.isUp,
    switches: {
      vacation: vacationActive,
      pauseControl: effectivePauseControl,
    },
    maintenanceMode: snapshot.maintenanceMode,
    stormHoldUntil: snapshot.stormHoldUntil,
    rules: { storm: deps.config.rules.storm, nightCooling: deps.config.rules.nightCooling },
    ...(deps.config.rules.thresholds !== undefined
      ? { thresholds: deps.config.rules.thresholds }
      : {}),
  });

  // -------------------------------------------------------------------------
  // 3. Per-window pipeline.
  // -------------------------------------------------------------------------
  // 3.0 Forecast_Planner (predictive-control-dashboard): runs once before the
  //     window loop and proposes a per-window base target. Pure + defensive —
  //     any failure falls back to the risk path for the whole cycle.
  let plannerResult: PlannerResult | undefined;
  try {
    plannerResult = runForecastPlanner(snapshot, {
      config: deps.config,
      baseline: deps.forecastBaseline ?? {},
      now: snapshot.now,
      ...(deps.comfortBiasByRoom !== undefined
        ? { comfortBiasByRoom: deps.comfortBiasByRoom }
        : {}),
      ...(deps.inertiaByRoom !== undefined
        ? { inertiaByRoom: deps.inertiaByRoom }
        : {}),
    });
  } catch (err) {
    plannerResult = undefined;
    if (log !== undefined) {
      log('warn', 'forecast planner failed; using risk fallback', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const cycleId = randomUUID();
  const windowDecisions: WindowDecisionEntry[] = [];

  // Per-room config lookup for quiet schedules (V1.5).
  const roomCfgById = new Map(deps.config.rooms.map((r) => [r.id, r]));

  for (const window of snapshot.windows) {
    const winCfg = window.config;
    const room = snapshot.rooms.get(winCfg.roomId);

    // Early-warn for manual overrides (visibility only; safety layer is
    // the authority that actually suppresses the move).
    const overrideUntilStr = window.runtimeState?.manualOverrideUntil ?? null;
    if (overrideUntilStr !== null) {
      const overrideUntil = new Date(overrideUntilStr);
      if (
        overrideUntil.getTime() > snapshot.now.getTime() &&
        modeDecision.mode !== 'STORM' &&
        log !== undefined
      ) {
        log('info', 'window manual override active', {
          windowId: winCfg.id,
          until: overrideUntil.toISOString(),
        });
      }
    }

    // Sun signals for this window.
    const sunFactor01 = sun.sunFactor(
      snapshot.now,
      deps.config.location,
      winCfg,
      deps.config.rules.sun,
    );
    const sunOnWindowNow = sun.sunOnWindow(sunPos, winCfg, deps.config.rules.sun);
    const sunOnWindowSoon = sun.sunOnWindowSoon(
      snapshot.now,
      deps.config.location,
      winCfg,
      deps.config.rules.sun,
    );

    // Inputs the per-window pipeline needs from the room. When the room
    // is missing (config drift) we fall back to a no-priority, no-temp
    // skeleton so the cycle still produces a decision row instead of
    // crashing. While VACATION is active, every room's target_c,
    // warning_c, and strong_shade_c are shifted down by
    // `vacationOffsetC` — `critical_c` stays as the hard ceiling.
    const roomTempC = room?.tempC ?? null;
    const baseRoomTargets = room?.targets ?? {
      target_c: 23,
      warning_c: 24.5,
      strong_shade_c: 25,
      critical_c: 26,
    };
    const roomTargets =
      vacationOffsetC > 0
        ? {
            target_c: baseRoomTargets.target_c - vacationOffsetC,
            warning_c: baseRoomTargets.warning_c - vacationOffsetC,
            strong_shade_c: baseRoomTargets.strong_shade_c - vacationOffsetC,
            critical_c: baseRoomTargets.critical_c,
          }
        : baseRoomTargets;
    const roomPriority: Priority = room?.priority ?? 'low';

    // --- Step 3a: risk → baseTarget ---------------------------------------
    const risk = computeRisk({
      window: { orientationDeg: winCfg.orientationDeg, type: winCfg.type },
      windowPriority: roomPriority,
      sun: sunPos,
      sunFactor01,
      roomTempC,
      roomTargets,
      outdoorTempC: snapshot.outdoorTempC,
      forecastMaxTempC: snapshot.forecastMaxTempC,
      pvSmoothedKw: snapshot.pvSmoothedKw,
      pvPeakKwp: deps.config.fusionSolar.pvPeakKwp,
      radiationWm2: snapshot.radiationWm2,
      profile: deps.config.rules.profile,
      pvLobeCenterDeg: pvLobeCenterFor(deps.config.fusionSolar.orientationHint),
    });
    const rawTarget = mapRiskToShutter01(risk.riskTotal);

    // Forecast_Planner base target (predictive-control-dashboard): when a
    // valid trajectory produced a plan for this window, use the planned
    // position as the base target fed into the downstream pipeline; else
    // fall back to the risk-derived target so the engine works without a
    // forecast. Safety + hysteresis + STORM remain the final authority.
    const windowPlan = plannerResult?.windows.get(winCfg.id);
    const baseTarget01 = windowPlan !== undefined ? windowPlan.target01 : rawTarget;

    // --- Step 3b: special rules §13 ---------------------------------------
    const special = applySpecialRules({
      window: { orientationDeg: winCfg.orientationDeg, type: winCfg.type },
      roomId: winCfg.roomId,
      priority: roomPriority,
      roomTempC,
      pvSmoothedKw: snapshot.pvSmoothedKw,
      pvPeakKwp: deps.config.fusionSolar.pvPeakKwp,
      sunOnWindowNow,
      sunOnWindowSoon,
      forecastMaxTempC: snapshot.forecastMaxTempC,
      mode: modeDecision.mode,
      baseTarget01,
    });

    // --- Step 3b½: roof windows close hard under direct sun --------------
    // Roof glazing overhead heats a room far faster than a façade; when the
    // sun is on a roof window during heat protection the user wants it
    // essentially shut. Push the target up to the window's heat cap (1.0 by
    // default for roof windows). Only raises, never lowers, and only while
    // heat_mode_active (ACTIVE_HEAT_PROTECTION / HEATWAVE).
    const heatModeActive =
      modeDecision.mode === 'ACTIVE_HEAT_PROTECTION' ||
      modeDecision.mode === 'HEATWAVE';
    let specialTarget = special.target01;
    if (winCfg.type === 'roof_window' && sunOnWindowNow && heatModeActive) {
      const roofClose = winCfg.maxHeatProtectionLevel01 ?? 1;
      specialTarget = Math.max(specialTarget, roofClose);
    }

    // --- Step 3b¾: winter insulation -------------------------------------
    // On cold nights, close shutters to cut heat loss (mirror of night
    // cooling). Only when dark, outdoor below the threshold, and not in
    // STORM or NIGHT_COOLING. Only raises the target.
    const insulation = deps.config.rules.insulation;
    if (
      insulation?.enabled === true &&
      !sunPos.isUp &&
      snapshot.outdoorTempC !== null &&
      snapshot.outdoorTempC <= insulation.maxOutdoorTempC &&
      modeDecision.mode !== 'STORM' &&
      modeDecision.mode !== 'NIGHT_COOLING'
    ) {
      specialTarget = Math.max(specialTarget, insulation.level01);
    }

    // --- Step 3c: ventilation §14 ----------------------------------------
    const ventilation = applyVentilation({
      window: {
        isDoor: winCfg.isDoor,
        canMoveWhenOpen: winCfg.canMoveWhenOpen,
        maxPositionWhenOpenPct: winCfg.maxPositionWhenOpenPct,
        lockoutProtection: winCfg.lockoutProtection,
        type: winCfg.type,
      },
      contactState: window.contactState,
      roomTempC,
      outdoorTempC: snapshot.outdoorTempC,
      sunOnWindowNow,
      pvSmoothedKw: snapshot.pvSmoothedKw,
      baseTarget01: specialTarget,
    });

    // --- Step 3d: safety priority order ----------------------------------
    const safety = applySafety({
      window: {
        type: winCfg.type,
        isDoor: winCfg.isDoor,
        lockoutProtection: winCfg.lockoutProtection,
      },
      windowState: window.runtimeState
        ? { manualOverrideUntil: window.runtimeState.manualOverrideUntil }
        : null,
      mode: modeDecision.mode,
      pauseControl: effectivePauseControl,
      baseTarget01: ventilation.target01,
      currentLevel01: window.currentLevel01,
      blockedByOpenWindow: ventilation.blockedByOpenWindow,
      now: snapshot.now,
    });

    // --- Step 3d½: heat-protection close cap ----------------------------
    // The heat-shield must not fully close a façade window during the
    // day: a fully-closed shutter traps a layer of hot air against the
    // glass. We leave a small gap (default 5%) so heat can escape.
    // Roof windows are exempt (glass overhead, no trapped-air wall) and
    // default to full close. At night (NIGHT_COOLING) the cap is lifted
    // so the shutter may reach 100%. The cap only ever reduces how far
    // we CLOSE — it never forces a window further open. Per-window
    // `maxHeatProtectionLevel01` overrides the type-based default.
    const heatCap =
      winCfg.maxHeatProtectionLevel01 ??
      (winCfg.type === 'roof_window' ? 1 : 0.95);
    const cappedTarget01 =
      modeDecision.mode !== 'NIGHT_COOLING' && safety.target01 > heatCap
        ? heatCap
        : safety.target01;

    // --- Step 3e: hysteresis §15 ----------------------------------------
    const hysteresis = applyHysteresis({
      finalTarget01: cappedTarget01,
      currentLevel01: window.currentLevel01,
      lastMovedAt: window.runtimeState?.lastCommandedAt
        ? new Date(window.runtimeState.lastCommandedAt)
        : null,
      now: snapshot.now,
      rules: {
        minSecondsBetweenMoves: deps.config.rules.automation.minSecondsBetweenMoves,
        minPositionDeltaPct: deps.config.rules.automation.minPositionDeltaPct,
        ...(deps.config.rules.automation.closeEagerness !== undefined
          ? { closeEagerness: deps.config.rules.automation.closeEagerness }
          : {}),
      },
      suppressFromSafety: safety.suppressMove,
      pvDroppedRecently: snapshot.pvDroppedRecently,
    });

    // --- Step 3f: dispatch (or record block reason) ----------------------
    let moved = false;
    let blockedBy: BlockedBy | undefined;

    if (winCfg.automationBlocked) {
      // Per-window automation block: never move, but keep the full
      // decision row so the UI still shows risk/target for context.
      moved = false;
      blockedBy = 'blocked';
      if (log !== undefined) {
        log('info', 'window automation blocked by config', {
          windowId: winCfg.id,
        });
      }
    } else if (isVentingLockout(window.contactState, modeDecision.mode)) {
      // Lüften-Lockout (Requirement 7): the sash is open, so the
      // resident is airing the room. Suppress all movement for this
      // window until it closes. STORM is exempt (handled inside
      // isVentingLockout) so the safety layer's forced-open is never
      // blocked.
      moved = false;
      blockedBy = 'venting';
      if (log !== undefined) {
        log('info', 'window ventilation lockout (contact open)', {
          windowId: winCfg.id,
        });
      }
    } else if (
      modeDecision.mode !== 'STORM' &&
      roomHourBlocked(
        localHour,
        roomCfgById.get(winCfg.roomId)?.noMoveBeforeHour,
        roomCfgById.get(winCfg.roomId)?.noMoveAfterHour,
      )
    ) {
      // Per-room quiet schedule: hold the position during the room's
      // configured no-move hours. STORM is exempt (guarded above) so the
      // safety force-open is never blocked.
      moved = false;
      blockedBy = 'pause';
      if (log !== undefined) {
        log('info', 'window held by room quiet schedule', {
          windowId: winCfg.id,
          roomId: winCfg.roomId,
          localHour,
        });
      }
    } else if (hysteresis.shouldMove) {
      try {
        await deps.hmipSystem.setShutterLevel(
          winCfg.shutterDeviceId,
          channelFor(winCfg.id),
          hysteresis.target01,
        );
        moved = true;
      } catch (err) {
        moved = false;
        blockedBy = 'system_error';
        if (log !== undefined) {
          log('warn', 'setShutterLevel failed', {
            windowId: winCfg.id,
            deviceId: winCfg.shutterDeviceId,
            target: hysteresis.target01,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } else if (hysteresis.blockedBy !== undefined) {
      blockedBy = mapHysteresisBlockedBy(hysteresis.blockedBy, safety.appliedRules);
    }

    // --- Step 3g: assemble decision entry --------------------------------
    const roomDeviation = plannerResult?.deviations.find(
      (d) => d.roomId === winCfg.roomId,
    );
    const roomTraj = plannerResult?.trajectories.get(winCfg.roomId);
    const plannerEntry =
      windowPlan !== undefined || roomDeviation?.exceedsTolerance === true
        ? {
            planner: {
              ...(roomDeviation !== undefined && roomDeviation.exceedsTolerance
                ? {
                    deviation: {
                      roomId: roomDeviation.roomId,
                      deviationC: roomDeviation.deviationC,
                      deviationLoad01: roomDeviation.deviationLoad01,
                      triggeringValue: roomDeviation.triggeringValue,
                    },
                  }
                : {}),
              ...(windowPlan !== undefined
                ? { plannedTarget01: windowPlan.target01 }
                : {}),
              ...(roomTraj !== undefined
                ? { confidence01: roomTraj.confidence01 }
                : {}),
            },
          }
        : {};
    const entry: WindowDecisionEntry = {
      windowId: winCfg.id,
      factors: buildFactorsMap(risk),
      risk: risk.riskTotal,
      rawTarget,
      afterSpecialRules: special.target01,
      afterSafety: safety.target01,
      finalTarget: hysteresis.target01,
      moved,
      ...(blockedBy !== undefined ? { blockedBy } : {}),
      ...plannerEntry,
    };
    windowDecisions.push(entry);
  }

  // -------------------------------------------------------------------------
  // 4. DecisionRecord + history append.
  // -------------------------------------------------------------------------
  const tsIso = snapshot.now.toISOString();
  const decisionRecord: DecisionRecord = {
    cycleId,
    ts: tsIso,
    mode: modeDecision.mode,
    windowDecisions,
  };

  if (deps.appendHistoryRecord !== undefined) {
    try {
      await deps.appendHistoryRecord({
        ts: tsIso,
        cycleId,
        payload: decisionRecord,
      });
    } catch (err) {
      if (log !== undefined) {
        log('warn', 'history append failed', {
          cycleId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return {
    decisionRecord,
    newStormHoldUntil: modeDecision.newStormHoldUntil,
    mode: modeDecision.mode,
    modeExplanation: modeDecision.explanation,
    ...(plannerResult !== undefined ? { plannerResult } : {}),
  };
}
