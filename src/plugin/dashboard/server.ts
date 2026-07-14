/**
 * Heat Shield — Dashboard server (Tasks 10.1 / 10.2 / 10.3 / 10.4).
 *
 * Fastify-backed HTTP + SSE surface that the dashboard SPA (Task 11)
 * and the HmIP-app companion screens consume. The server is wired up
 * by the boot module (Task 15) and pulls all of its application data
 * through the {@link DashboardServerDeps} bag — there is no direct
 * coupling to the orchestrator, the persistence layer, or the
 * Connect-API client. That keeps the unit tests fully offline (no
 * real listener, no real WebSocket, no real disk access) via
 * Fastify's `inject()` HTTP shim.
 *
 * ─── Endpoint surface (mirrors `design.md` §Dashboard / Endpoints) ─
 *
 *   - `GET  /`                            — static SPA (or stub).
 *   - `GET  /api/state`                   — current snapshot.
 *   - `GET  /api/stream`                  — Server-Sent-Events feed.
 *   - `GET  /api/config`                  — current `Config`.
 *   - `PUT  /api/config`                  — validated Config update.
 *                                            Schema failure returns
 *                                            `400 invalid_schema`
 *                                            (Task 10.4 contract).
 *   - `POST /api/config/probe`            — probe with override config.
 *   - `POST /api/sources/discover`        — HCU + OpenMeteo + FusionSolar.
 *   - `POST /api/wizard/step/:n`          — wizard step 1..5.
 *   - `GET  /api/history?seconds=`        — rolling history slice.
 *   - `GET  /api/trends?seconds=`         — rolling trend samples.
 *   - `GET  /api/decisions?n=`            — last N DecisionRecords.
 *   - `GET  /api/connect/log?n=`          — last N Connect-API log
 *                                           lines (Task 13.2).
 *   - `POST /api/probe/run`               — synthetic engine cycle
 *                                           against the live snapshot
 *                                           (Task 13.3). Differs from
 *                                           `POST /api/config/probe`
 *                                           which probes an OVERRIDE
 *                                           config; this one runs the
 *                                           current config through a
 *                                           dry cycle that MUST NOT
 *                                           dispatch `setShutterLevel`.
 *                                           The boot module wires this
 *                                           dependency to
 *                                           `runtime/probe.ts::runDryProbe`,
 *                                           which stubs the
 *                                           `hmipSystem.setShutterLevel`
 *                                           dispatcher with a no-op so
 *                                           the cycle produces a
 *                                           DecisionRecord without
 *                                           issuing any Connect calls.
 *   - `POST /api/control/shutter/:windowId` — manual position.
 *   - `POST /api/control/maintenance`     — toggle maintenance.
 *   - `POST /api/control/reset`           — reset config.
 *
 * ─── Steering compliance ──────────────────────────────────────────
 *
 *   - No Connect API artefacts in this layer. The dashboard never
 *     emits `STATUS_EVENT`, never builds DiscoverResponse, and never
 *     looks at `shutterDirection`. Manual shutter control flows
 *     through `setShutterManually`, which the boot module routes to
 *     the orchestrator's safety layer (which then issues a spec-
 *     compliant `setShutterLevel` if the safety layer allows it).
 *   - The `discoverSources` dependency is optional. When absent the
 *     route returns `503` rather than `200 + empty`, so the wizard
 *     can distinguish "boot not yet wired" from "no devices found".
 *
 * ─── Strict-mode notes (`exactOptionalPropertyTypes`,
 *     `noUncheckedIndexedAccess`) ──────────────────────────────────
 *
 *   - All optional fields on response bodies are conditionally
 *     assembled (never `= undefined`).
 *   - Query-string access goes through narrow `Record<string,
 *     unknown>` casts after the Zod validation step.
 *   - No `any`, no `as` casts beyond the request-body narrowing
 *     boundary (Fastify hands inbound bodies as `unknown`).
 */

import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { z, ZodError } from 'zod';

import { registerForecastRoutes } from './forecastRoutes.js';
import { getDwdWarnings } from '../sources/dwdWarnings.js';
import {
  ConfigSchema,
  LocationSchema,
  RoomSchema,
  WindowSchema,
  parseConfig,
  safeParseConfig,
} from '../../shared/schema.js';
import type {
  Config,
  DecisionRecord,
  Mode,
  Rules,
  UserIntentState,
  WindowDecisionEntry,
} from '../../shared/types.js';
import type { ConnectLogger } from '../connect/client.js';
import type { PluginReadinessStatusValue } from '../connect/envelope.js';
import type {
  PlannedAction,
  PlannedActionState,
} from '../engine/forecast/positionSelector.js';
import type { LearningSnapshot } from '../engine/learn.js';
import type { TrendSample } from '../engine/trends.js';
import type { HistoryRecord } from '../persistence/history.js';
import type { HmipDeviceMeta } from '../sources/hcu.js';
import type { IrrigationSnapshot } from '../irrigation/controller.js';
import type { RuntimeState } from '../../shared/state-schema.js';
import type { Message } from '../../shared/message-schema.js';
import type { BuildingModel } from '../../shared/building-model.js';
import { safeParseBuildingModel, validateBuildingModel } from '../../shared/building-model.js';
import { canonicalJson, contentHash } from '../../shared/building-model-canonical.js';
import { modelToGlb } from '../../shared/building-gltf.js';
import type { UnderlayKind, UnderlayMeta } from '../../shared/building-underlay.js';
import type { ProjectIndex } from '../persistence/projectStore.js';
import type { ThermalSnapshotSummary } from '../persistence/thermalStore.js';
import { maskToken } from '../notifications/telegram.js';

// ---------------------------------------------------------------------------
// Public types.
// ---------------------------------------------------------------------------

/**
 * A single resolved signal value for the dashboard overview. `state`
 * classifies freshness so the UI can show a green/amber/red dot
 * without re-deriving staleness rules.
 */
export interface SignalValue {
  value: number | null;
  ts: string | null;
  state: 'fresh' | 'soon' | 'stale' | 'unknown';
  /** Whether a source binding exists for this signal (vs. unassigned). */
  bound?: boolean;
}

/**
 * Dashboard-facing snapshot. The orchestrator is the producer; the
 * dashboard server simply forwards the JSON to the SPA. This shape
 * is intentionally flat and self-describing so the SPA can render
 * without needing to know the engine's internal types.
 */
export interface DashboardSnapshot {
  ts: string;
  mode: Mode | null;
  rooms: Array<{
    id: string;
    name?: string;
    tempC: number | null;
  }>;
  windows: Array<{
    id: string;
    /** Human label: "<Raum> – <Gerät> (…1234)". */
    name?: string;
    currentLevel01: number | null;
    manualOverrideUntil: string | null;
    lastDecisionMode: Mode | null;
  }>;
  sources: {
    fusionSolar: {
      sourceOk: boolean;
      lastSuccess: string | null;
      consecutiveFailures: number;
    };
    hcu: {
      connected: boolean;
    };
  };
  userIntent: UserIntentState;
  storm: {
    holdUntil: string | null;
  };
  pluginReadiness: PluginReadinessStatusValue;
  /** Master automation lever (config.automationEnabled). */
  automationEnabled: boolean;
  /**
   * Resolved global signal values for the 360° overview panel.
   * Optional for backward compatibility: older producers/clients
   * that omit the block still render (tiles show "–").
   */
  signals?: {
    outdoorTemp: SignalValue;
    pvPower: SignalValue;
    windSpeed: SignalValue;
    radiation: SignalValue;
    forecastMaxTemp: SignalValue;
    forecastCloudCover: SignalValue;
  };
  /** Current sun position for the overview / sun map. Optional. */
  sun?: {
    azimuthDeg: number;
    elevationDeg: number;
  };
  /**
   * PV-led feels-like summary for the 360° overview
   * (smart-shading-notifications Task 11.2). Optional/backward-compatible.
   */
  feelsLike?: {
    /** Effective heat load in [0,1] from `effectiveHeatLoad01`. */
    effectiveLoad01: number;
    /** Illustrative feels-like temperature in °C; null if no air temp. */
    feelsLikeC: number | null;
  };
  /** Multi-hour signal trends (slopes) for the overview. Optional. */
  trends?: {
    /** Outdoor temperature slope in °C/h, or null. */
    outdoorCph: number | null;
    /** PV power slope in kW/h, or null. */
    pvKwph: number | null;
  };
  /** Number of unread in-app messages (envelope badge). Optional. */
  unreadMessages?: number;
}

// ---------------------------------------------------------------------------
// Snapshot V2 — predictive-control-dashboard additive blocks (Task 11).
// All fields OPTIONAL so existing producers/clients keep validating.
// ---------------------------------------------------------------------------

export type { PlannedAction, PlannedActionState };

/**
 * A single displayed value plus its provenance and confidence
 * (predictive-control-dashboard Requirement 15.2, Property 20).
 */
export interface ValueWithQuality {
  value: number | null;
  origin: 'measured' | 'forecast' | 'estimated';
  /** Human source label, e.g. "FusionSolar", "OpenMeteo", "lokaler Sensor". */
  source: string;
  confidence01: number;
}

/** Cardinal facade key (Heat-Shield convention: N=0, E=90, S=180, W=270). */
export type FacadeKey = 'N' | 'E' | 'S' | 'W';

/**
 * Additive V2 dashboard snapshot. Extends the V1 snapshot; every new
 * block is optional so older clients and the existing test fixtures
 * keep validating (Requirements 8.1, 9.x, 12.x, 15.2, 17.x, 18.2).
 */
export interface DashboardSnapshotV2 extends DashboardSnapshot {
  /** Mode with explanatory fields (Requirement 17.1). */
  modeInfo?: {
    id: string;
    label: string;
    goal: string;
    reasons: string[];
    /** One-line German headline naming the deciding factor. */
    decidedBy?: string;
  };
  /** Environment readings with data quality (Requirement 9.5, 17.1). */
  environment?: {
    radiationWm2: ValueWithQuality;
    uvIndex: ValueWithQuality;
    windMs: ValueWithQuality;
    humidity01: ValueWithQuality;
  };
  /** Facade exposure in percent per cardinal facade (Requirement 9.3). */
  facades?: { N: number; E: number; S: number; W: number };
  /** PV-Sonnenindex in [0,1] (Requirement 8.1). */
  pvSonnenindex01?: number;
  /**
   * PV self-consumption fraction in [0,1] (Eigenverbrauch), derived from
   * FusionSolar `inputPower` vs `meterActivePower`. Omitted when there is
   * no generation to divide by.
   */
  pvSelfUse01?: number;
  /**
   * Current outdoor temperature from the internet weather service (OpenMeteo),
   * in °C, shown alongside the local-sensor mean on the outdoor KPI card.
   */
  outdoorTempInternetC?: number | null;
  /**
   * Highest average indoor temperature observed today (since local midnight),
   * in °C. Surfaced as the "Peak" readout on the indoor KPI card.
   */
  indoorPeakTempC?: number | null;
  /** Rooms with next planned action + planned state (Requirement 12.2, 17.2). */
  roomsDetail?: Array<{
    id: string;
    name: string;
    /** Free-form floor/level label from config (e.g. "KG"/"EG"/"OG"/"DG"). */
    floor?: string;
    facade: FacadeKey;
    /** 0 = open … 100 = closed (Requirement 12.3). */
    shutterPercent: number;
    indoorTempC: number | null;
    trend: 'up' | 'down' | 'flat';
    nextAction: PlannedAction | null;
    status: PlannedActionState;
    /** True when at least one window/contact in the room is open or tilted. */
    windowOpen?: boolean;
    /** Window orientation (0=N,90=E,180=S,270=W) for compass ordering. */
    orientationDeg?: number;
    /** Primary window id for manual shutter control from the twin popover. */
    windowId?: string;
    /** True when the room's primary window is a roof window (Dachfenster). */
    roof?: boolean;
    /** Current normalised heat load [0,1] for the room (heatmap + popover). */
    heatLoad01?: number;
    /** Freshness of the indoor-temperature signal. */
    indoorTempState?: 'fresh' | 'stale' | 'unbound';
    /**
     * ISO timestamp until which a manual override holds this room's window
     * (in the future = override active). While active the engine will not
     * execute planned moves, so the timeline/forecast hold the current
     * position. Absent/null = no override.
     */
    manualOverrideUntil?: string | null;
    /**
     * Predicted shutter percent (0=open … 95/100=closed) over the next
     * ~12 h, hourly. Derived from the per-room thermal forecast; surfaced
     * as the scrub-driven 12 h preview in the house twin.
     */
    shutterForecast?: Array<{ ts: string; percent: number }>;
  }>;
  /** Forecast timeline cards (Requirement 11). */
  forecastTimeline?: Array<{
    ts: string;
    weatherIcon: string;
    tempC: number;
    radiationWm2: number;
    precipitationOrCloud01: number;
    pvForecastKw?: number;
  }>;
  /**
   * 15-minute precipitation outlook for the next ~2 h (Open-Meteo
   * `minutely_15`). Complements the rain radar (which only nowcasts ~30 min)
   * with a valid +2 h precipitation-intensity strip at the location.
   */
  precipNowcast?: Array<{ ts: string; precipMm: number }>;
  /**
   * Active DWD severe-weather warnings for the region. `active` (max level ≥ 3,
   * Rot/Violett) switches the dashboard into the temporary Alert-Mode
   * ("Katastrophenschutz-Zentrale") on the Beschattung + Wetter tabs.
   */
  weatherAlert?: {
    active: boolean;
    maxLevel: number;
    region: string;
    updatedTs: string;
    warnings: Array<{
      level: number;
      event: string;
      headline: string;
      description: string;
      instruction: string;
      start: string | null;
      end: string | null;
    }>;
  };
  /** Flat list of planned actions (Requirement 11.3, 17.3). */
  plannedActions?: PlannedAction[];
  /** Trajectories for the analysis charts (Requirement 13.2/13.3/13.5). */
  trajectories?: {
    indoorForecastWithShade: Array<{ ts: string; tempC: number }>;
    indoorForecastNoShade: Array<{ ts: string; tempC: number }>;
    heatLoadForecast: Array<{ ts: string; load01: number }>;
  };
  /**
   * Ventilation advice (Lüftung module). Advisory only — the plugin has no
   * sash actuator. `overall` is the most actionable advice across rooms.
   */
  ventilation?: {
    overall: { level: string; headline: string; detail: string };
    rooms: Array<{
      id: string;
      name: string;
      level: string;
      headline: string;
      detail: string;
    }>;
  };
  /**
   * Active-cooling advice (Klima module). House-level, PV-surplus-gated.
   * Advisory only.
   */
  cooling?: {
    level: string;
    headline: string;
    detail: string;
    pvSurplusKw: number | null;
  };
  /**
   * Day-to-day learning summary (catalog C5). Per-room learned shading model
   * + recommendation. `days` = number of distinct observed calendar days.
   */
  learning?: {
    days: number;
    rooms: Array<{
      id: string;
      name: string;
      sampleDays: number;
      avgIndoorPeakC: number | null;
      avgOvershootC: number | null;
      avgMovesPerDay: number;
      comfortBiasC: number;
      recommendationLevel: string;
      recommendation: string;
      /** Calibrated thermal inertia (min) when the self-calibration loop adjusted it. */
      calibratedInertiaMinutes?: number;
      /** Human note describing the calibration adjustment. */
      calibrationNote?: string;
    }>;
  };
  /** "Wirkung" — measurable benefit metrics for the impact view. */
  impact?: {
    /** Share of today's cycles with no room above its warning ceiling. */
    comfortShareToday01: number | null;
    /** Learned average automatic moves per day (house total). */
    avgMovesPerDay: number | null;
    calibratedRooms: number;
    tunedRooms: number;
    learnDays: number;
    forecastAccuracyC?: number;
    pvSelfUse01?: number;
  };
  /**
   * Gardena smart-irrigation devices bridged into the HCU by the
   * Gardena Connect plugin (`de.homematicip.plugin.gardena`). Present
   * only when at least one Gardena sensor or valve is visible in the
   * HCU system state. Sensors expose soil moisture / soil temp / lux;
   * valves are controllable on/off switches steered via
   * `setSwitchState`. Optional + backward-compatible.
   */
  gardena?: {
    sensors: Array<{
      deviceId: string;
      name: string;
      /** Soil moisture in % (HMIP `humidity` feature), or null. */
      soilMoisturePct: number | null;
      /** Soil temperature in °C (HMIP `actualTemperature`), or null. */
      soilTempC: number | null;
      /** Light intensity in lux (HMIP `illumination`), or null. */
      lux: number | null;
      /** Ambient air temperature in °C (cloud sensor), or null. */
      ambientTempC?: number | null;
      /** Sensor battery level in %, or null. */
      batteryPct?: number | null;
    }>;
    valves: Array<{
      deviceId: string;
      name: string;
      /** Channel index carrying `switchState` (HCU bridge only). */
      channelIndex: number;
      /** True = watering on, false = off, null = unknown. */
      on: boolean | null;
      /** Raw GARDENA activity (cloud only), e.g. MANUAL_WATERING. */
      activity?: string | null;
      /** Where this valve is controlled: direct cloud API or HCU bridge. */
      source?: 'cloud' | 'hcu';
    }>;
    /** True when the data comes from the direct GARDENA cloud integration. */
    cloud?: boolean;
    /** Cloud connection state for the status line. */
    connected?: boolean;
    /** Last cloud error, if any. */
    error?: string | null;
  };
  /**
   * Full ET-based irrigation state (Bewässerung): per-zone water balance,
   * forecast, learning and live valve/sensor readings. Optional/backward-
   * compatible. Shape defined by the irrigation controller.
   */
  irrigation?: IrrigationSnapshot;
}

/**
 * Per-room forecast trajectory returned by `GET /api/forecast`
 * (predictive-control-dashboard Requirement 13.2).
 */
export interface ForecastResponse {
  roomId: string;
  hours: number;
  points: Array<{ ts: string; indoorTempC: number; heatLoad01: number }>;
  uncertain: boolean;
  confidence01: number;
}

/**
 * Position plan + planned actions returned by `GET /api/plan`
 * (predictive-control-dashboard Requirement 11.3).
 */
export interface PlanResponse {
  ts: string;
  windows: Array<{ windowId: string; target01: number; noMoveNeeded: boolean }>;
  plannedActions: PlannedAction[];
}

/**
 * One event delivered through the SSE feed. The `type` discriminator
 * is free-form on purpose: the orchestrator publishes
 * `cycle.completed`, `mode.changed`, `switch.changed`, …, and the
 * SPA dispatches on the string. We keep the payload as `unknown`
 * because the dashboard server is a passthrough.
 */
export interface DashboardStreamEvent {
  type: string;
  payload: unknown;
}

/**
 * Result returned by {@link DashboardServerDeps.discoverSources}.
 * The first three arrays are the cache snapshot; the trailing
 * diagnostic fields let the SPA distinguish "the HCU has no devices
 * yet" from "we never reached the HCU on the Connect API".
 */
export interface DiscoverSourcesResult {
  devices: readonly HmipDeviceMeta[];
  climateSensors: readonly HmipDeviceMeta[];
  openMeteo: readonly HmipDeviceMeta[];
  /**
   * Connect-API socket state at the moment of the call:
   *   - `off`        — boot ran with no auth token; we never tried.
   *   - `connecting` — token present but the socket is not OPEN yet.
   *   - `connected`  — socket is OPEN; a fresh `getSystemState` was
   *                    attempted (see `attemptedRefresh`).
   */
  connectState: 'off' | 'connecting' | 'connected';
  /** Last `getSystemState` error message, or `null` on success. */
  lastError: string | null;
  /** True iff we issued a fresh `getSystemState` for this call. */
  attemptedRefresh: boolean;
  /**
   * Count of devices per `deviceType` (as emitted by the HCU). Lets
   * the SPA surface the actual breakdown without exposing per-device
   * identifiers in summary form. Devices with no `deviceType` are
   * counted under the literal key `"(unknown)"`. Sorted descending
   * by count, then alphabetically.
   */
  deviceTypeHistogram: ReadonlyArray<{ deviceType: string; count: number }>;
  /**
   * Devices that carry an `actualTemperature` feature — regardless
   * of `deviceType`. These are the realistic candidates for a
   * temperature signal source: WALL_THERMOSTAT, THERMOSTAT,
   * CLIMATE_SENSOR, even some sensor types that report temperature
   * alongside their primary purpose. Empty when no such device is
   * cached.
   */
  temperatureSources: readonly HmipDeviceMeta[];
  /**
   * Devices that carry a `shutterLevel` feature — i.e. native HMIP
   * roller-shutter / blind channels the plugin can actually steer
   * via `setShutterLevel`. Surfaced in discovery diagnostics so the
   * user can immediately tell whether any controllable shutter is
   * visible in the HMIP system state at all.
   */
  shutterSources: readonly HmipDeviceMeta[];
  /**
   * Devices that carry a `windowState` feature — window/door contacts
   * the engine can use for the ventilation logic. Surfaced so the
   * wizard can offer a per-window contact assignment.
   */
  contactSources: readonly HmipDeviceMeta[];
  /**
   * Devices that carry an `illumination` feature — candidate GLOBAL light
   * sensors. Surfaced so the UI can offer a global light-sensor binding
   * (chosen like the PV source).
   */
  illuminationSources: readonly HmipDeviceMeta[];
  /**
   * Full per-device inventory: every cached device with the list of
   * feature names it exposes. The discovery diagnostic renders this
   * so the user can identify which `PLUGIN_EXTERNAL` device is a room
   * thermostat / window contact / shutter, and which feature key
   * carries the value we need to bind.
   */
  inventory: ReadonlyArray<{
    deviceId: string;
    deviceType?: string;
    friendlyName?: string;
    features: readonly string[];
    values: Readonly<Record<string, string | number | boolean>>;
  }>;
  /**
   * Number of devices in the RAW `getSystemState` body, counted
   * before the cache's schema filtering. Compare to `inventory`
   * length: if `rawDeviceCount` is larger, the parser is silently
   * dropping device shapes the HCU actually sent.
   */
  rawDeviceCount: number;
  /**
   * Histogram of raw device `type` values straight off the wire,
   * before schema filtering. Shows the true device-type breakdown
   * the HCU sent (including types our parser may reject).
   */
  rawDeviceTypeHistogram: ReadonlyArray<{ deviceType: string; count: number }>;
  /** Build stamp of the live plugin image (env HEATSHIELD_BUILD). */
  pluginBuild: string;
}

/**
 * Dependency bag for {@link DashboardServer}. Production wires
 * everything through the boot module (Task 15); tests pass `vi.fn`
 * stubs and a tiny fixture factory.
 */
/** OTA status shape surfaced by `GET /api/ota/status` (mirrors OtaManager). */
export interface OtaStatusView {
  coreVersion: string;
  otaVersion: string;
  otaActive: boolean;
  latest: string | null;
  updateAvailable: boolean;
  requiresCore: boolean;
  mode: 'manual' | 'auto';
  /** Active update channel. */
  channel: 'stable' | 'experimental';
  /** True when the resolved release is a GitHub prerelease (experimental build). */
  experimentalBuild: boolean;
  checkIntervalHours: number;
  lastCheck: string | null;
  lastResult: string | null;
}

/** Result of `POST /api/ota/install`. */
export interface OtaInstallResultView {
  ok: boolean;
  reason?: string;
  detail?: string;
  version?: string;
}

export interface DashboardServerDeps {
  config: () => Config;
  updateConfig: (c: Config) => Promise<void>;
  readState: () => Promise<RuntimeState | null>;
  readDecisions: (n: number) => Promise<HistoryRecord<DecisionRecord>[]>;
  readHistory: (seconds: number) => Promise<HistoryRecord<DecisionRecord>[]>;
  /** Rolling trend samples (temperatures, PV) within the last `seconds`. */
  readTrends: (seconds: number) => Promise<TrendSample[]>;
  getSnapshot: () => Promise<DashboardSnapshot>;
  probe: (
    overrideConfig?: Config,
  ) => Promise<{ mode: Mode; windowDecisions: WindowDecisionEntry[] }>;
  setShutterManually: (windowId: string, level01: number) => Promise<void>;
  /**
   * OTA update manager surface (optional; the boot module wires it). When
   * undefined the `/api/ota/*` routes return `503` so the SPA can tell
   * "boot not wired" from a real error.
   */
  otaStatus?: () => OtaStatusView;
  otaCheck?: () => Promise<OtaStatusView>;
  otaInstall?: () => Promise<{ status: OtaStatusView; result: OtaInstallResultView }>;
  /**
   * Optional Gardena valve control (Bewässerung). Turns a Gardena
   * valve (a plugin-external HMIP `SWITCH`) on or off via the HCU's
   * `setSwitchState`. `deviceId` is the HMIP device id from the
   * snapshot's `gardena.valves[]`; `channelIndex` is that valve's
   * switch channel. When undefined, `POST /api/control/gardena/:deviceId`
   * returns `503` so the SPA can tell "boot not yet wired" from
   * "no Gardena devices".
   */
  setGardenaValve?: (
    deviceId: string,
    on: boolean,
    channelIndex: number,
  ) => Promise<void>;
  /**
   * Optional GARDENA cloud connectivity test. Authenticates with the
   * configured Application key/secret and reports location + device counts so
   * the UI can validate credentials before enabling the integration. Returns
   * 503 when not wired.
   */
  testGardena?: () => Promise<{
    ok: boolean;
    locations: number;
    sensors: number;
    valves: number;
    error?: string;
    services?: Array<{ id: string; type: string; attrs: string[] }>;
  }>;
  /**
   * Optional irrigation manual controls (Bewässerung). Run a zone now for
   * `seconds` (default = configured), stop it, or skip it for the rest of
   * today. When undefined, the routes return 503.
   */
  runIrrigationZone?: (zoneId: string, seconds?: number) => Promise<void>;
  stopIrrigationZone?: (zoneId: string) => Promise<void>;
  skipIrrigationZone?: (zoneId: string) => Promise<void>;
  /** Calibrate a zone's modeled available water (0..100 %). 503 when unwired. */
  calibrateIrrigationZone?: (zoneId: string, availablePct: number) => Promise<void>;
  /** Day-ahead plan editing (move/resize/enable, delete, add). 503 when unwired. */
  updateIrrigationPlanEntry?: (
    entryId: string,
    patch: { startTs?: string; durationMin?: number; enabled?: boolean },
  ) => Promise<void>;
  deleteIrrigationPlanEntry?: (entryId: string) => Promise<void>;
  /** Reset the day-ahead plan to the pure AUTO strategy (re-seed). 503 when unwired. */
  resetIrrigationPlanAuto?: () => Promise<void>;
  addIrrigationPlanEntry?: (
    zoneId: string,
    startTs: string,
    durationMin: number,
  ) => Promise<void>;
  setMaintenanceMode: (on: boolean) => Promise<void>;
  /**
   * Flip the master automation lever (config.automationEnabled).
   * When false the engine holds all positions (configure-in-peace).
   * Optional for backward compat with existing test stubs.
   */
  setAutomationEnabled?: (enabled: boolean) => Promise<void>;
  resetConfig: () => Promise<void>;
  subscribe: (handler: (event: DashboardStreamEvent) => void) => () => void;
  /**
   * Optional in-app message accessors (smart-shading-notifications Task 10).
   * `getMessages` returns the chronological message list; `markMessagesRead`
   * marks the given ids (or all when omitted) read and resolves to the new
   * unread count. When undefined, `GET /api/messages` returns `503` so the
   * dashboard can distinguish "boot not yet wired" from "no messages".
   */
  getMessages?: () => Message[];
  markMessagesRead?: (ids?: readonly string[]) => Promise<number>;
  /**
   * Optional full-backup accessors (V1.5). `getBackupData` returns the raw
   * NDJSON contents of the learning + calibration stores; `restoreBackupData`
   * overwrites those stores and reloads the in-memory models. When undefined,
   * the backup endpoints fall back to config-only. The config part of a backup
   * always rides through the same masked `GET`/validated `PUT` path as
   * `/api/config`, so secrets never leak and a restore can never persist an
   * invalid config.
   */
  getBackupData?: () => Promise<{ learning: string; calibration: string }>;
  restoreBackupData?: (data: {
    learning: string;
    calibration: string;
  }) => Promise<void>;
  /**
   * Optional Telegram test-send hook (smart-shading). When wired, `POST
   * /api/notifications/test` sends a test message through the currently
   * configured Telegram bot and returns `{ ok, error? }`. Returns 503 when
   * not wired.
   */
  sendTestNotification?: () => Promise<{ ok: boolean; error?: string }>;
  /**
   * Optional discovery hook. When undefined, `POST
   * /api/sources/discover` returns `503`. The boot module wires this
   * to the live `HcuSourceCache` and may issue a fresh
   * `getSystemState` round-trip before returning so the wizard sees
   * devices added since the plugin started. Returning a promise is
   * supported for that reason.
   */
  discoverSources?: () =>
    | DiscoverSourcesResult
    | Promise<DiscoverSourcesResult>;
  /**
   * Optional Connect-API log accessor (Task 13.2). When undefined,
   * `GET /api/connect/log` returns `503` so the diagnose tab can
   * distinguish "boot not yet wired" from "log empty". The boot
   * module wires this to a `ConnectLogBuffer` instance whose
   * `entries()` method returns the most recent N captured lines.
   *
   * Each entry is the JSON shape consumed by the diagnose tab
   * directly — `{ ts, level, msg, ctx? }` with `ts` an ISO-8601 UTC
   * string. `level` is intentionally typed as `string` (not the
   * `'info'|'warn'|'error'` union) so the dependency surface stays
   * loose: the buffer guarantees one of the three values, but a
   * future log source might use `'debug'` and we do not want to
   * have to bump the type here.
   */
  getConnectLog?: () => Array<{
    ts: string;
    level: string;
    msg: string;
    ctx?: Record<string, unknown>;
  }>;
  /**
   * Optional dry-probe runner (Task 13.3). When undefined, `POST
   * /api/probe/run` returns `503`. Distinct from {@link probe},
   * which accepts an override config and is used by the
   * RulesTab/SourcesTab "Test" buttons: `runProbe` runs against the
   * CURRENT persisted config and the LIVE snapshot the orchestrator
   * is about to evaluate, with the contract that it MUST NOT
   * dispatch `setShutterLevel`. The boot module wires this to
   * `runtime/probe.ts::runDryProbe`, which stubs the
   * `hmipSystem.setShutterLevel` dispatcher with a no-op.
   */
  runProbe?: () => Promise<{
    mode: Mode;
    windowDecisions: WindowDecisionEntry[];
    ts: string;
    cycleId: string;
  }>;
  /**
   * Optional learning snapshot accessor (Task 14.2). When undefined,
   * `GET /api/learn/snapshot` returns 503 `learning_unavailable` so
   * the dashboard can distinguish "boot not yet wired" from "no
   * data yet". The boot module wires this to the orchestrator's
   * persisted history + temperature stream pipeline plus the live
   * `LearningSnapshot` aggregator in `engine/learn.ts`.
   */
  getLearningSnapshot?: () => Promise<LearningSnapshot>;
  /**
   * Optional recommendation-apply hook (Task 14.2 / steering). The
   * boot module wires this to a thin wrapper that:
   *
   *   1. Looks up the current recommendation by `id`.
   *   2. Applies the suggested patch to a *clone* of the persisted
   *      config.
   *   3. Routes the cloned config through the same
   *      `safeParseConfig` + `updateConfig` round-trip that
   *      `PUT /api/config` uses, so the on-disk file is never
   *      bypassed.
   *
   * Returns `{ ok: false }` when the recommendation no longer
   * exists (the `apply` endpoint surfaces that as 404). Steering
   * mandate: this hook is the **only** path the learning loop has
   * to write a config change — the engine itself never mutates
   * `/data/config.json`.
   */
  applyRecommendation?: (
    id: string,
  ) => Promise<{
    ok: boolean;
    appliedPatch?: { path: (string | number)[]; from: unknown; to: unknown };
  }>;
  /**
   * Optional recommendation-dismiss hook (Task 14.2). When
   * undefined the dashboard does the dismiss SPA-locally. When
   * wired, the boot module persists the dismissal so reloading the
   * SPA keeps the recommendation hidden until the metric next
   * crosses the threshold again.
   */
  dismissRecommendation?: (id: string) => Promise<{ ok: boolean }>;
  /**
   * Optional forecast-trajectory accessor (predictive-control-dashboard
   * Task 12). When undefined, `GET /api/forecast` returns `503
   * forecast_unavailable` so the SPA can tell "boot not yet wired" from
   * "no forecast". Wired in the boot module from the live `PlannerResult`.
   */
  readForecast?: (
    roomId: string | undefined,
    hours: number,
  ) => Promise<ForecastResponse[]>;
  /**
   * Optional plan accessor (predictive-control-dashboard Task 12). When
   * undefined, `GET /api/plan` returns `503 plan_unavailable`. Wired in
   * the boot module from the persisted plan / live `PlannerResult`.
   */
  readPlan?: () => Promise<PlanResponse | null>;
  /**
   * Optional house-background image hooks (dashboard polish). `getHouseImage`
   * returns the user-uploaded background (overriding the bundled default at
   * `/assets/house/house.png`) or null when none was uploaded.
   * `saveHouseImage` persists a `data:` URL under `/data/`. When undefined,
   * `POST /api/house-image` returns 503 and the default image is served.
   */
  getHouseImage?: () => { contentType: string; bytes: Buffer } | null;
  saveHouseImage?: (dataUrl: string) => Promise<void>;
  logger?: ConnectLogger;
  /**
   * Optional Building Model Studio accessors (building-model-editor spec,
   * Phase 1). `getBuildingModel` loads the persisted canonical model, seeding
   * a default from the HeatShield site when none exists yet.
   * `saveBuildingModel` performs an optimistic-concurrency save (revision
   * check) and returns the committed model or a stale conflict. When
   * undefined, `GET/PUT /api/building` return `503 building_unavailable`.
   */
  getBuildingModel?: () => Promise<BuildingModel>;
  saveBuildingModel?: (
    draft: BuildingModel,
    expectedRevision: number,
  ) => Promise<
    | { ok: true; model: BuildingModel; changed: boolean }
    | { ok: false; reason: 'stale'; expected: number; actual: number }
  >;
  /**
   * Optional Building Studio underlay accessors (BME-03/04/12). Reference
   * rasters traced over in the 2D editor. Binaries live in a separate store
   * with retention state; these deps front it. When undefined, the
   * `/api/building/underlays*` routes return `503 building_unavailable`.
   */
  listUnderlays?: () => Promise<UnderlayMeta[]>;
  addUnderlay?: (
    dataUrl: string,
    input: { storeyId: string; name?: string; kind?: UnderlayKind },
  ) => Promise<{ ok: true; meta: UnderlayMeta } | { ok: false; error: string }>;
  updateUnderlay?: (id: string, patch: Partial<UnderlayMeta>) => Promise<UnderlayMeta | null>;
  deleteUnderlay?: (id: string) => Promise<boolean>;
  getUnderlayBinary?: (id: string) => Promise<{ mediaType: string; bytes: Buffer } | null>;
  /**
   * Optional building revision history (BME-18). `listRevisions` returns the
   * snapshotted revisions (newest first); `restoreRevision` re-commits a past
   * revision as a NEW revision. 503 when unwired.
   */
  listRevisions?: () => Promise<Array<{ revision: number; contentHash: string; savedAt: string }>>;
  restoreRevision?: (
    revision: number,
  ) => Promise<
    | { ok: true; model: BuildingModel; changed: boolean }
    | { ok: false; reason: 'stale'; expected: number; actual: number }
  >;
  /**
   * Optional multi-project management (shared-building-model 2.2). All
   * `/api/building*` routes operate on the ACTIVE project; these deps manage
   * the project set. 503 when unwired.
   */
  listProjects?: () => Promise<ProjectIndex>;
  createProject?: (name: string) => Promise<ProjectIndex>;
  renameProject?: (id: string, name: string) => Promise<ProjectIndex>;
  deleteProject?: (id: string) => Promise<ProjectIndex>;
  activateProject?: (id: string) => Promise<ProjectIndex>;
  /**
   * Optional thermal calculation-snapshot persistence (thermal-load-engine).
   * `saveThermalSnapshot` stores a computed (non-normative) estimate for the
   * active project; `listThermalSnapshots` returns summaries newest-first;
   * `readThermalSnapshot` returns one full payload. 503 when unwired.
   */
  saveThermalSnapshot?: (estimate: unknown) => Promise<ThermalSnapshotSummary>;
  listThermalSnapshots?: () => Promise<ThermalSnapshotSummary[]>;
  readThermalSnapshot?: (id: string) => Promise<unknown | null>;
}

/**
 * Constructor options for {@link DashboardServer}. `host` defaults
 * to `0.0.0.0` so the dashboard is reachable from outside the
 * container without extra configuration.
 */
export interface DashboardServerOptions {
  port: number;
  host?: string;
}

// ---------------------------------------------------------------------------
// Constants and inline schemas.
// ---------------------------------------------------------------------------

const HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_DECISIONS_LIMIT = 200;
const MAX_DECISIONS_LIMIT = 1000;
const MIN_HISTORY_SECONDS = 1;
const MAX_HISTORY_SECONDS = 7 * 24 * 60 * 60;
/**
 * Default and cap for `GET /api/connect/log?n=` (Task 13.2). The
 * default mirrors the diagnose tab's per-request batch size; the
 * cap is the absolute maximum the route serves so a misbehaving
 * client cannot ask the buffer to allocate an arbitrarily large
 * array.
 */
const DEFAULT_CONNECT_LOG_LIMIT = 1000;
const MAX_CONNECT_LOG_LIMIT = 5000;

/**
 * Per-wizard-step body schemas (Task 10.3 / 10.4 brief). Each
 * schema is intentionally narrow so a malformed wizard payload
 * surfaces a clear `invalid_schema` 400 with the exact
 * `issues[].path` the SPA needs to highlight a field.
 *
 * The schemas validate the **incoming** wizard step payload only;
 * the merged-into-config result is validated by the consumer
 * (`updateConfig` / `parseConfig`).
 */
const Step1Schema = LocationSchema;

const Step2Schema = z.object({
  sources: z.object({
    fusionSolar: z.object({
      baseUrl: z.string().url(),
    }),
    openMeteoDeviceId: z.string().min(1),
  }),
  validated: z.literal(true),
});

const Step3Schema = z.object({
  rooms: z.array(RoomSchema),
});

const Step4Schema = z.object({
  windows: z.array(WindowSchema),
});

const Step5Schema = z.object({
  profile: z.enum(['conservative', 'standard', 'aggressive', 'custom']),
  overrides: z
    .object({})
    .catchall(z.unknown())
    .optional(),
});

/**
 * Body schema for `POST /api/control/shutter/:windowId`. `level01`
 * mirrors the Connect-API shutter-level domain (`0 = open`, `1 =
 * fully closed`); we deliberately reject the spec's "ignore"
 * sentinel `1.01` because manual UI control should never request it.
 */
const ShutterBodySchema = z.object({
  level01: z.number().min(0).max(1),
});

/**
 * Body schema for `POST /api/control/maintenance`.
 */
const MaintenanceBodySchema = z.object({
  on: z.boolean(),
});

/**
 * Body schema for `POST /api/control/automation` — the master lever.
 */
const AutomationToggleBodySchema = z.object({
  enabled: z.boolean(),
});

/**
 * Body schema for `POST /api/irrigation/zone/:zoneId/run`. `seconds` is
 * optional (defaults to the configured watering duration).
 */
const IrrigationRunBodySchema = z.object({
  seconds: z.number().int().min(30).max(86_400).optional(),
});

/**
 * Body schema for `POST /api/irrigation/zone/:zoneId/calibrate`. Sets the
 * zone's observed plant-available water (0..100 %).
 */
const IrrigationCalibrateBodySchema = z.object({
  availablePct: z.number().min(0).max(100),
});

/** Body for `POST /api/irrigation/plan/:entryId/update` — all fields optional. */
const IrrigationPlanUpdateBodySchema = z.object({
  startTs: z.string().min(1).optional(),
  durationMin: z.number().int().min(5).max(180).optional(),
  enabled: z.boolean().optional(),
});

/** Body for `POST /api/irrigation/plan` (add a manual entry). */
const IrrigationPlanAddBodySchema = z.object({
  zoneId: z.string().min(1),
  startTs: z.string().min(1),
  durationMin: z.number().int().min(5).max(180),
});


const GardenaValveBodySchema = z.object({
  on: z.boolean(),
  channelIndex: z.number().int().min(0).max(64).optional(),
});

/**
 * Body schema for `POST /api/house-image`. Accepts a data: URL for a PNG,
 * JPEG, or WebP image (the dashboard reads the uploaded file as a data URL
 * client-side and posts it as JSON — no multipart dependency needed).
 */
const HouseImageBodySchema = z.object({
  dataUrl: z
    .string()
    .regex(
      /^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/,
      'Erwarte eine data:image/(png|jpeg|webp);base64-URL.',
    ),
});

/**
 * Standard error envelope used by every 4xx/5xx response. The
 * `code` discriminator lets the SPA branch without parsing the
 * `message` string. Task 10.4 pins the `invalid_schema` code for
 * Zod failures on the config endpoint.
 */
type ApiErrorCode =
  | 'invalid_schema'
  | 'invalid_query'
  | 'invalid_param'
  | 'invalid_body'
  | 'discover_unavailable'
  | 'connect_log_unavailable'
  | 'probe_unavailable'
  | 'learning_unavailable'
  | 'forecast_unavailable'
  | 'plan_unavailable'
  | 'recommendation_not_found'
  | 'house_image_unavailable'
  | 'house_image_save_failed'
  | 'gardena_unavailable'
  | 'irrigation_unavailable'
  | 'dwd_unavailable'
  | 'building_unavailable'
  | 'building_stale'
  | 'internal_error';

interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    issues?: Array<{ path: (string | number)[]; message: string; code?: string }>;
  };
}

/**
 * Built-in stub HTML used when the bundled SPA is missing (fresh
 * clone, tests). Keeping this inline lets the server boot without a
 * pre-existing `dashboard/public/` directory.
 */
const BUILT_IN_INDEX = `<!DOCTYPE html>
<html lang="de">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Heat Shield Dashboard</title>
  </head>
  <body>
    <main>
      <h1>Heat Shield Dashboard</h1>
      <p>Dashboard coming up.</p>
    </main>
  </body>
</html>
`;

/**
 * Resolve the on-disk location of the static `public/` directory.
 * `import.meta.url` points at `server.js` in dist (or `server.ts`
 * during tests); both layouts keep `public/` as a sibling.
 */
function resolvePublicDir(): string {
  // When the bootstrap loader activated an OTA payload it exports the payload's
  // own SPA assets via HEATSHIELD_PUBLIC_DIR — serve those so the frontend
  // matches the running backend bundle. Otherwise use the image's public dir.
  const otaPublic = process.env['HEATSHIELD_PUBLIC_DIR'];
  if (otaPublic !== undefined && otaPublic.length > 0 && existsSync(otaPublic)) {
    return otaPublic;
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, 'public');
}

// ---------------------------------------------------------------------------
// Server.
// ---------------------------------------------------------------------------

/**
 * Fastify-backed dashboard server. The class owns the Fastify
 * instance lifecycle but does not own any application state — every
 * request handler defers to {@link DashboardServerDeps}.
 */
export class DashboardServer {
  private readonly deps: DashboardServerDeps;
  private readonly options: { port: number; host: string };
  private readonly app: FastifyInstance;
  private readonly streamClosers: Set<() => void> = new Set();
  private started: boolean = false;

  public constructor(deps: DashboardServerDeps, options: DashboardServerOptions) {
    this.deps = deps;
    this.options = {
      port: options.port,
      host: options.host ?? '0.0.0.0',
    };
    this.app = Fastify({
      // We surface our own structured ApiErrorBody for 4xx, so disable
      // Fastify's built-in `{statusCode, error, message}` shape on
      // schema validation. Each route handles its own validation.
      logger: false,
      bodyLimit: 1024 * 1024, // 1 MiB; configs are small but rooms[] can grow.
    });
    this.registerErrorHandlers();
    this.registerRoutes();
  }

  /**
   * Get the Fastify instance for testing. Tests invoke
   * `server.fastify.inject(...)` to drive the routes without
   * binding to a real port. Production callers should prefer
   * {@link start} / {@link stop}.
   */
  public get fastify(): FastifyInstance {
    return this.app;
  }

  /**
   * Boot the server on the configured `host:port`. Idempotent — a
   * second call resolves immediately.
   */
  public async start(): Promise<void> {
    if (this.started) {
      return;
    }
    await this.app.ready();
    await this.app.listen({ host: this.options.host, port: this.options.port });
    this.started = true;
  }

  /**
   * Stop the server. Idempotent.
   */
  public async stop(): Promise<void> {
    // Close any active SSE stream so Fastify can drain the
    // response. Without this, `app.close()` would hang waiting for
    // the long-lived response to end.
    this.closeAllStreams();
    if (!this.started) {
      // Even when not started we may have registered plugins via
      // ready(). Closing flushes those.
      await this.app.close();
      return;
    }
    await this.app.close();
    this.started = false;
  }

  /**
   * Close every active SSE stream registered via the GET
   * /api/stream handler. Used by {@link stop} and by tests that
   * drive the route through `inject()` (closing the stream is what
   * makes `inject()` resolve, since SSE responses are otherwise
   * long-lived).
   */
  public closeAllStreams(): void {
    const closers = Array.from(this.streamClosers);
    this.streamClosers.clear();
    for (const close of closers) {
      try {
        close();
      } catch {
        // Best-effort: a closer may have raced its own teardown.
      }
    }
  }

  // -------------------------------------------------------------------------
  // Internal: wiring.
  // -------------------------------------------------------------------------

  private registerErrorHandlers(): void {
    // Override the default JSON body parser so a malformed JSON body
    // surfaces as an `invalid_schema` 400 (mirrors the schema-error
    // wire shape Task 10.4 pins). Fastify's stock parser returns its
    // own `{statusCode, error, message}` shape, which would diverge
    // from the rest of our 4xx envelopes.
    this.app.addContentTypeParser(
      'application/json',
      { parseAs: 'string' },
      (_req, body, done) => {
        const text = typeof body === 'string' ? body : body.toString('utf8');
        if (text.length === 0) {
          // Empty body is allowed for endpoints that accept "no
          // override". Hand back `null` so the route can branch on
          // it explicitly.
          done(null, null);
          return;
        }
        try {
          const parsed: unknown = JSON.parse(text);
          done(null, parsed);
        } catch (err) {
          // Tag the error so our setErrorHandler below can render
          // the canonical `invalid_schema` envelope.
          const taggedErr = new Error(
            err instanceof Error ? err.message : String(err),
          ) as Error & { dashboardCode?: 'invalid_body' };
          taggedErr.dashboardCode = 'invalid_body';
          done(taggedErr, undefined);
        }
      },
    );

    this.app.setErrorHandler((rawErr: unknown, _req, reply) => {
      const err =
        rawErr instanceof Error
          ? rawErr
          : new Error(typeof rawErr === 'string' ? rawErr : 'unknown error');
      const tagged = err as Error & {
        dashboardCode?: ApiErrorCode;
        statusCode?: number;
      };
      // Custom-tagged content-type parser failure → `invalid_schema`
      // envelope so the SPA can branch consistently.
      if (tagged.dashboardCode === 'invalid_body') {
        const body: ApiErrorBody = {
          error: {
            code: 'invalid_schema',
            message: `Request body is not valid JSON: ${err.message}`,
          },
        };
        return reply.code(400).type('application/json').send(body);
      }
      // Generic fallback. Logging is opt-in via deps.logger; we
      // route the generic Fastify error path through the same
      // helper so the wire shape stays consistent.
      this.deps.logger?.('warn', 'dashboard error handler', {
        message: err.message,
        statusCode: tagged.statusCode,
      });
      const status =
        typeof tagged.statusCode === 'number' ? tagged.statusCode : 500;
      const code: ApiErrorCode =
        status >= 500 ? 'internal_error' : 'invalid_schema';
      const body: ApiErrorBody = {
        error: {
          code,
          message: err.message,
        },
      };
      return reply.code(status).type('application/json').send(body);
    });
  }

  private registerRoutes(): void {
    // House background image override route — MUST be registered before
    // @fastify/static so the user-uploaded image wins over the bundled
    // default at the same URL.
    this.registerHouseImageRoutes();
    // Static SPA. We register `@fastify/static` only when the dir
    // exists; otherwise `GET /` falls back to the built-in stub so
    // tests on a freshly cloned tree do not 404.
    const publicDir = resolvePublicDir();
    const haveStaticBundle = existsSync(publicDir);
    if (haveStaticBundle) {
      void this.app.register(fastifyStatic, {
        root: publicDir,
        prefix: '/',
        index: ['index.html'],
        // Disallow directory listing — the SPA never needs it.
        list: false,
      });
    } else {
      this.app.get('/', async (_req, reply) => {
        reply.type('text/html; charset=utf-8');
        return BUILT_IN_INDEX;
      });
    }

    // SPA history-routing fallback: a fresh load or refresh of a client
    // route (e.g. /forecast, /bewaesserung) must serve index.html so the
    // router can render it — otherwise the server 404s. Only GET HTML
    // navigations to non-/api paths fall through here; API + assets keep
    // their normal 404 JSON.
    this.app.setNotFoundHandler((req, reply) => {
      const path = (req.url.split('?')[0] ?? '');
      const accept = String(req.headers['accept'] ?? '');
      const isHtmlNav =
        req.method === 'GET' && !path.startsWith('/api/') && accept.includes('text/html');
      if (isHtmlNav) {
        reply.type('text/html; charset=utf-8');
        if (haveStaticBundle) {
          return reply.sendFile('index.html');
        }
        return reply.send(BUILT_IN_INDEX);
      }
      return reply
        .code(404)
        .send({ error: { code: 'not_found', message: `Route ${req.method}:${path} not found` } });
    });

    this.registerStateRoutes();
    this.registerStreamRoute();
    this.registerConfigRoutes();
    this.registerWizardRoute();
    this.registerHistoryRoutes();
    this.registerControlRoutes();
    this.registerSourcesRoutes();
    this.registerDiagnosticsRoutes();
    this.registerLearningRoutes();
    this.registerMessagesRoutes();
    this.registerWeatherRoutes();
    this.registerBuildingRoutes();
    this.registerOtaRoutes();
    registerForecastRoutes(this.app, this.deps);
  }

  /**
   * OTA update routes. All optional — when the boot module has not wired the
   * OTA manager (`deps.ota*` undefined) they answer `503` so the SPA can tell
   * "boot not wired" from a real failure. No secrets are ever returned/logged.
   */
  private registerOtaRoutes(): void {
    const deps = this.deps;
    const unavailable = (reply: FastifyReply): unknown => {
      reply.code(503);
      return { error: { code: 'ota_unavailable', message: 'OTA manager not wired' } };
    };

    this.app.get('/api/ota/status', async (_req, reply) => {
      if (deps.otaStatus === undefined) return unavailable(reply);
      return deps.otaStatus();
    });

    this.app.post('/api/ota/check', async (_req, reply) => {
      if (deps.otaCheck === undefined) return unavailable(reply);
      return deps.otaCheck();
    });

    this.app.post('/api/ota/install', async (_req, reply) => {
      if (deps.otaInstall === undefined) return unavailable(reply);
      const { status, result } = await deps.otaInstall();
      if (!result.ok) {
        reply.code(result.reason === 'refused-core' ? 409 : 422);
        return { error: { code: result.reason ?? 'ota_failed', message: result.detail ?? 'install failed' }, status };
      }
      reply.code(202);
      return { status, result };
    });
  }

  private registerHouseImageRoutes(): void {
    const deps = this.deps;

    // GET — serve the uploaded house image if present, else the bundled
    // default from the public dir. This exact-path route takes precedence
    // over the @fastify/static wildcard.
    this.app.get('/assets/house/house.png', async (_req, reply) => {
      const custom = deps.getHouseImage?.();
      if (custom !== undefined && custom !== null) {
        reply.type(custom.contentType);
        reply.header('Cache-Control', 'no-store');
        return reply.send(custom.bytes);
      }
      const def = path.join(resolvePublicDir(), 'assets', 'house', 'house.png');
      if (existsSync(def)) {
        reply.type('image/png');
        return reply.send(readFileSync(def));
      }
      reply.code(404);
      return reply.send();
    });

    // POST — accept a data: URL (PNG/JPEG/WebP) and persist it. A larger
    // per-route body limit covers typical house renders (~1–3 MB base64).
    this.app.post(
      '/api/house-image',
      { bodyLimit: 12 * 1024 * 1024 },
      async (req, reply) => {
        if (deps.saveHouseImage === undefined) {
          reply.code(503);
          const body: ApiErrorBody = {
            error: {
              code: 'house_image_unavailable',
              message: 'House image upload is not wired in this build.',
            },
          };
          return body;
        }
        const parsed = HouseImageBodySchema.safeParse(req.body);
        if (!parsed.success) {
          reply.code(400);
          const body: ApiErrorBody = {
            error: {
              code: 'invalid_body',
              message: 'Erwarte { dataUrl: "data:image/...;base64,..." } (PNG/JPEG/WebP).',
            },
          };
          return body;
        }
        try {
          await deps.saveHouseImage(parsed.data.dataUrl);
          return { ok: true };
        } catch (err) {
          reply.code(500);
          const body: ApiErrorBody = {
            error: {
              code: 'house_image_save_failed',
              message: err instanceof Error ? err.message : String(err),
            },
          };
          return body;
        }
      },
    );
  }

  private registerWeatherRoutes(): void {
    const deps = this.deps;
    // GET /api/dwd-warnings → official DWD severe-weather warnings for the
    // configured region (Warncell-ID resolved from the region name). Polled
    // by the Wetter tab. Server-side because the DWD feed is JSONP + no CORS.
    this.app.get('/api/dwd-warnings', async (_req, reply) => {
      const cfg = deps.config();
      const dwd = cfg.dwd;
      if (dwd === undefined || dwd.enabled === false) {
        return { enabled: false, cellId: null, regionName: '', time: null, warnings: [] };
      }
      try {
        const result = await getDwdWarnings({
          regionName: dwd.regionName,
          ...(dwd.warncellId.length > 0 ? { warncellId: dwd.warncellId } : {}),
        });
        return { enabled: true, ...result };
      } catch (err) {
        reply.code(502);
        const body: ApiErrorBody = {
          error: {
            code: 'dwd_unavailable',
            message: err instanceof Error ? err.message : String(err),
          },
        };
        return body;
      }
    });
  }

  private registerStateRoutes(): void {
    this.app.get('/api/state', async () => {
      return this.deps.getSnapshot();
    });

    // GET /api/metrics → compact JSON health/status for monitoring (C7).
    // Derived purely from the current snapshot + process uptime; no new deps.
    this.app.get('/api/metrics', async () => {
      const snap = (await this.deps.getSnapshot()) as DashboardSnapshotV2;
      const rooms = snap.rooms ?? [];
      const indoorTemps = rooms
        .map((r) => r.tempC)
        .filter((t): t is number => t !== null && Number.isFinite(t));
      const indoorAvg =
        indoorTemps.length > 0
          ? Math.round((indoorTemps.reduce((a, b) => a + b, 0) / indoorTemps.length) * 10) / 10
          : null;
      return {
        ts: snap.ts,
        uptimeSeconds: Math.round(process.uptime()),
        mode: snap.mode,
        pluginReadiness: snap.pluginReadiness,
        automationEnabled: snap.automationEnabled,
        sources: {
          hcuConnected: snap.sources.hcu.connected,
          fusionOk: snap.sources.fusionSolar.sourceOk,
          fusionFailures: snap.sources.fusionSolar.consecutiveFailures,
        },
        rooms: rooms.length,
        windows: (snap.windows ?? []).length,
        plannedActions: (snap.plannedActions ?? []).length,
        unreadMessages: snap.unreadMessages ?? 0,
        indoorAvgC: indoorAvg,
        indoorPeakC: snap.indoorPeakTempC ?? null,
        outdoorC: snap.signals?.outdoorTemp.value ?? null,
        forecastMaxC: snap.signals?.forecastMaxTemp.value ?? null,
        pvKw: snap.signals?.pvPower.value ?? null,
        pvSonnenindex01: snap.pvSonnenindex01 ?? null,
        ventilation: snap.ventilation?.overall.level ?? null,
        cooling: snap.cooling?.level ?? null,
        stormHoldUntil: snap.storm.holdUntil,
      };
    });
  }

  private registerBuildingRoutes(): void {
    const deps = this.deps;

    // GET /api/building → load (or seed) the canonical building model.
    this.app.get('/api/building', async (_req, reply) => {
      if (deps.getBuildingModel === undefined) {
        const body: ApiErrorBody = {
          error: { code: 'building_unavailable', message: 'building model unavailable (boot not wired)' },
        };
        return reply.code(503).send(body);
      }
      try {
        return await deps.getBuildingModel();
      } catch (err) {
        return this.sendInternalError(reply, err);
      }
    });

    // PUT /api/building → optimistic-concurrency save. Body: the full model;
    // `?expectedRevision=` (or body.revision) guards against stale writes.
    this.app.put('/api/building', async (req, reply) => {
      if (deps.saveBuildingModel === undefined) {
        const body: ApiErrorBody = {
          error: { code: 'building_unavailable', message: 'building model unavailable (boot not wired)' },
        };
        return reply.code(503).send(body);
      }
      const body = req.body;
      if (body === undefined || body === null || typeof body !== 'object') {
        return this.sendInvalidSchema(reply, 'Request body must be a JSON object');
      }
      const parsed = safeParseBuildingModel(body);
      if (!parsed.success) {
        return this.sendInvalidSchema(reply, 'Building model failed schema validation', parsed.error);
      }
      const draft = parsed.data;
      const query = (req.query ?? {}) as Record<string, unknown>;
      const rawExpected = query['expectedRevision'];
      const expectedRevision =
        typeof rawExpected === 'string' && Number.isInteger(Number(rawExpected))
          ? Number(rawExpected)
          : draft.revision;
      try {
        const result = await deps.saveBuildingModel(draft, expectedRevision);
        if (!result.ok) {
          const errBody: ApiErrorBody = {
            error: {
              code: 'building_stale',
              message: `stale write: expected revision ${result.expected}, current is ${result.actual}`,
            },
          };
          return reply.code(409).send(errBody);
        }
        return { ok: true, model: result.model, changed: result.changed };
      } catch (err) {
        return this.sendInternalError(reply, err);
      }
    });

    // GET /api/building/validate → referential-integrity issues (BME-17).
    this.app.get('/api/building/validate', async (_req, reply) => {
      if (deps.getBuildingModel === undefined) {
        const body: ApiErrorBody = {
          error: { code: 'building_unavailable', message: 'building model unavailable (boot not wired)' },
        };
        return reply.code(503).send(body);
      }
      try {
        const model = await deps.getBuildingModel();
        return validateBuildingModel(model);
      } catch (err) {
        return this.sendInternalError(reply, err);
      }
    });

    // GET /api/building/export → canonical JSON + content hash (BME-20).
    this.app.get('/api/building/export', async (_req, reply) => {
      if (deps.getBuildingModel === undefined) {
        const body: ApiErrorBody = {
          error: { code: 'building_unavailable', message: 'building model unavailable (boot not wired)' },
        };
        return reply.code(503).send(body);
      }
      try {
        const model = await deps.getBuildingModel();
        return {
          kind: 'heatshield-building-model',
          schemaVersion: model.schemaVersion,
          revision: model.revision,
          contentHash: contentHash(model),
          exportedAt: new Date().toISOString(),
          canonicalJson: canonicalJson(model),
          model,
        };
      } catch (err) {
        return this.sendInternalError(reply, err);
      }
    });

    // GET /api/building/export/glb → binary glTF (GLB) of the current model.
    this.app.get('/api/building/export/glb', async (_req, reply) => {
      if (deps.getBuildingModel === undefined) {
        const body: ApiErrorBody = {
          error: { code: 'building_unavailable', message: 'building model unavailable (boot not wired)' },
        };
        return reply.code(503).send(body);
      }
      try {
        const model = await deps.getBuildingModel();
        const glb = modelToGlb(model);
        reply.type('model/gltf-binary');
        return reply.send(Buffer.from(glb.buffer, glb.byteOffset, glb.byteLength));
      } catch (err) {
        return this.sendInternalError(reply, err);
      }
    });

    // GET /api/building/history → snapshotted revisions (newest first). BME-18.
    this.app.get('/api/building/history', async (_req, reply) => {
      if (deps.listRevisions === undefined) {
        const body: ApiErrorBody = { error: { code: 'building_unavailable', message: 'building history unavailable (boot not wired)' } };
        return reply.code(503).send(body);
      }
      try {
        return { revisions: await deps.listRevisions() };
      } catch (err) {
        return this.sendInternalError(reply, err);
      }
    });

    // POST /api/building/restore/:rev → re-commit a past revision as a new one.
    this.app.post('/api/building/restore/:rev', async (req, reply) => {
      if (deps.restoreRevision === undefined) {
        const body: ApiErrorBody = { error: { code: 'building_unavailable', message: 'building history unavailable (boot not wired)' } };
        return reply.code(503).send(body);
      }
      const raw = (req.params as { rev?: string }).rev ?? '';
      const revision = Number(raw);
      if (!Number.isInteger(revision) || revision < 1) {
        return this.sendInvalidSchema(reply, 'revision must be a positive integer');
      }
      try {
        const result = await deps.restoreRevision(revision);
        if (!result.ok) {
          const errBody: ApiErrorBody = { error: { code: 'invalid_param', message: `revision ${revision} not found` } };
          return reply.code(404).send(errBody);
        }
        return { ok: true, model: result.model };
      } catch (err) {
        return this.sendInternalError(reply, err);
      }
    });

    // ---- Projects (shared-building-model 2.2) -----------------------------
    const projectsUnavailable = (reply: FastifyReply): FastifyReply => {
      const body: ApiErrorBody = {
        error: { code: 'building_unavailable', message: 'building projects unavailable (boot not wired)' },
      };
      return reply.code(503).send(body);
    };

    // GET /api/building/projects → { activeId, projects }.
    this.app.get('/api/building/projects', async (_req, reply) => {
      if (deps.listProjects === undefined) return projectsUnavailable(reply);
      try {
        return await deps.listProjects();
      } catch (err) {
        return this.sendInternalError(reply, err);
      }
    });

    // POST /api/building/projects → create + activate. Body: { name }.
    this.app.post('/api/building/projects', async (req, reply) => {
      if (deps.createProject === undefined) return projectsUnavailable(reply);
      const b = (req.body ?? {}) as Record<string, unknown>;
      const name = typeof b['name'] === 'string' ? b['name'] : '';
      try {
        return await deps.createProject(name);
      } catch (err) {
        return this.sendInternalError(reply, err);
      }
    });

    // PUT /api/building/projects/:id → rename. Body: { name }.
    this.app.put('/api/building/projects/:id', async (req, reply) => {
      if (deps.renameProject === undefined) return projectsUnavailable(reply);
      const id = (req.params as { id?: string }).id ?? '';
      const b = (req.body ?? {}) as Record<string, unknown>;
      const name = typeof b['name'] === 'string' ? b['name'] : '';
      if (name.trim().length === 0) return this.sendInvalidSchema(reply, 'name is required');
      try {
        return await deps.renameProject(id, name);
      } catch (err) {
        return this.sendInternalError(reply, err);
      }
    });

    // DELETE /api/building/projects/:id → delete (never the default/last).
    this.app.delete('/api/building/projects/:id', async (req, reply) => {
      if (deps.deleteProject === undefined) return projectsUnavailable(reply);
      const id = (req.params as { id?: string }).id ?? '';
      try {
        return await deps.deleteProject(id);
      } catch (err) {
        return this.sendInternalError(reply, err);
      }
    });

    // POST /api/building/projects/:id/activate → switch the active project.
    this.app.post('/api/building/projects/:id/activate', async (req, reply) => {
      if (deps.activateProject === undefined) return projectsUnavailable(reply);
      const id = (req.params as { id?: string }).id ?? '';
      try {
        return await deps.activateProject(id);
      } catch (err) {
        return this.sendInternalError(reply, err);
      }
    });

    // ---- Thermal snapshots (thermal-load-engine) --------------------------
    const thermalUnavailable = (reply: FastifyReply): FastifyReply => {
      const body: ApiErrorBody = {
        error: { code: 'building_unavailable', message: 'thermal snapshots unavailable (boot not wired)' },
      };
      return reply.code(503).send(body);
    };

    // GET /api/building/thermal/snapshots → summaries (newest first).
    this.app.get('/api/building/thermal/snapshots', async (_req, reply) => {
      if (deps.listThermalSnapshots === undefined) return thermalUnavailable(reply);
      try {
        return { snapshots: await deps.listThermalSnapshots() };
      } catch (err) {
        return this.sendInternalError(reply, err);
      }
    });

    // POST /api/building/thermal/snapshots → persist a computed estimate.
    this.app.post('/api/building/thermal/snapshots', { bodyLimit: 4 * 1024 * 1024 }, async (req, reply) => {
      if (deps.saveThermalSnapshot === undefined) return thermalUnavailable(reply);
      const body = req.body;
      if (body === null || typeof body !== 'object') {
        return this.sendInvalidSchema(reply, 'estimate object required');
      }
      try {
        return await deps.saveThermalSnapshot(body);
      } catch (err) {
        return this.sendInternalError(reply, err);
      }
    });

    // GET /api/building/thermal/snapshots/:id → one full estimate payload.
    this.app.get('/api/building/thermal/snapshots/:id', async (req, reply) => {
      if (deps.readThermalSnapshot === undefined) return thermalUnavailable(reply);
      const id = (req.params as { id?: string }).id ?? '';
      try {
        const est = await deps.readThermalSnapshot(id);
        if (est === null) {
          const errBody: ApiErrorBody = { error: { code: 'invalid_param', message: `unknown snapshot ${id}` } };
          return reply.code(404).send(errBody);
        }
        return { estimate: est };
      } catch (err) {
        return this.sendInternalError(reply, err);
      }
    });
    const underlayUnavailable = (reply: FastifyReply): FastifyReply => {
      const body: ApiErrorBody = {
        error: { code: 'building_unavailable', message: 'building underlays unavailable (boot not wired)' },
      };
      return reply.code(503).send(body);
    };

    this.app.get('/api/building/underlays', async (_req, reply) => {
      if (deps.listUnderlays === undefined) return underlayUnavailable(reply);
      try {
        return { underlays: await deps.listUnderlays() };
      } catch (err) {
        return this.sendInternalError(reply, err);
      }
    });

    this.app.post('/api/building/underlays', { bodyLimit: 20 * 1024 * 1024 }, async (req, reply) => {
      if (deps.addUnderlay === undefined) return underlayUnavailable(reply);
      const body = req.body;
      if (body === undefined || body === null || typeof body !== 'object') {
        return this.sendInvalidSchema(reply, 'Request body must be a JSON object');
      }
      const b = body as Record<string, unknown>;
      const dataUrl = typeof b['dataUrl'] === 'string' ? b['dataUrl'] : '';
      const storeyId = typeof b['storeyId'] === 'string' ? b['storeyId'] : '';
      if (dataUrl.length === 0 || storeyId.length === 0) {
        return this.sendInvalidSchema(reply, 'dataUrl and storeyId are required');
      }
      const input: { storeyId: string; name?: string; kind?: UnderlayKind } = { storeyId };
      if (typeof b['name'] === 'string') input.name = b['name'];
      if (typeof b['kind'] === 'string') input.kind = b['kind'] as UnderlayKind;
      try {
        const result = await deps.addUnderlay(dataUrl, input);
        if (!result.ok) {
          const errBody: ApiErrorBody = { error: { code: 'invalid_body', message: result.error } };
          return reply.code(400).send(errBody);
        }
        return { ok: true, meta: result.meta };
      } catch (err) {
        return this.sendInternalError(reply, err);
      }
    });

    this.app.put('/api/building/underlays/:id', async (req, reply) => {
      if (deps.updateUnderlay === undefined) return underlayUnavailable(reply);
      const id = (req.params as { id?: string }).id ?? '';
      const body = req.body;
      if (body === undefined || body === null || typeof body !== 'object') {
        return this.sendInvalidSchema(reply, 'Request body must be a JSON object');
      }
      try {
        const updated = await deps.updateUnderlay(id, body as Partial<UnderlayMeta>);
        if (updated === null) {
          const errBody: ApiErrorBody = { error: { code: 'invalid_param', message: `unknown underlay ${id}` } };
          return reply.code(404).send(errBody);
        }
        return { ok: true, meta: updated };
      } catch (err) {
        return this.sendInternalError(reply, err);
      }
    });

    this.app.delete('/api/building/underlays/:id', async (req, reply) => {
      if (deps.deleteUnderlay === undefined) return underlayUnavailable(reply);
      const id = (req.params as { id?: string }).id ?? '';
      try {
        const ok = await deps.deleteUnderlay(id);
        return { ok };
      } catch (err) {
        return this.sendInternalError(reply, err);
      }
    });

    this.app.get('/api/building/underlays/:id/image', async (req, reply) => {
      if (deps.getUnderlayBinary === undefined) return underlayUnavailable(reply);
      const id = (req.params as { id?: string }).id ?? '';
      try {
        const bin = await deps.getUnderlayBinary(id);
        if (bin === null) {
          const errBody: ApiErrorBody = { error: { code: 'invalid_param', message: `unknown underlay ${id}` } };
          return reply.code(404).send(errBody);
        }
        reply.type(bin.mediaType);
        return reply.send(bin.bytes);
      } catch (err) {
        return this.sendInternalError(reply, err);
      }
    });
  }

  private registerMessagesRoutes(): void {
    const deps = this.deps;

    // GET /api/messages → chronological list + unread count.
    this.app.get('/api/messages', async (_req, reply) => {
      if (deps.getMessages === undefined) {
        const body: ApiErrorBody = {
          error: {
            code: 'internal_error',
            message: 'messages unavailable (boot not wired)',
          },
        };
        return reply.code(503).send(body);
      }
      const messages = deps.getMessages();
      const unread = messages.reduce((n, m) => (m.read ? n : n + 1), 0);
      return { messages, unread };
    });

    // POST /api/messages/read → mark ids (or all) read; returns unread count.
    this.app.post('/api/messages/read', async (req, reply) => {
      if (deps.markMessagesRead === undefined) {
        const body: ApiErrorBody = {
          error: {
            code: 'internal_error',
            message: 'messages unavailable (boot not wired)',
          },
        };
        return reply.code(503).send(body);
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      let ids: string[] | undefined;
      if (Array.isArray(body['ids'])) {
        const raw = body['ids'] as unknown[];
        if (!raw.every((x) => typeof x === 'string')) {
          return this.sendInvalidSchema(reply, 'ids must be an array of strings');
        }
        ids = raw as string[];
      }
      try {
        const unread = await deps.markMessagesRead(ids);
        return { ok: true, unread };
      } catch (err) {
        return this.sendInternalError(reply, err);
      }
    });

    // POST /api/notifications/test → send a Telegram test message.
    this.app.post('/api/notifications/test', async (_req, reply) => {
      if (deps.sendTestNotification === undefined) {
        const body: ApiErrorBody = {
          error: {
            code: 'internal_error',
            message: 'notifications unavailable (boot not wired)',
          },
        };
        return reply.code(503).send(body);
      }
      try {
        const result = await deps.sendTestNotification();
        return result;
      } catch (err) {
        return this.sendInternalError(reply, err);
      }
    });
  }

  private registerStreamRoute(): void {
    const deps = this.deps;
    this.app.get('/api/stream', async (req, reply) => {
      // Build a Readable we push SSE chunks into. Fastify pipes it
      // to the response; closing the stream ends the request.
      const stream = new Readable({ read(): void {} });
      let closed = false;

      const close = (): void => {
        if (closed) {
          return;
        }
        closed = true;
        clearInterval(heartbeatTimer);
        try {
          unsubscribe();
        } catch {
          // Listener may already be gone if the dep raced us.
        }
        if (!stream.destroyed) {
          stream.push(null);
        }
      };

      // Track the close callback per stream so external triggers
      // (server.stop, abort) can end the response without waiting for
      // a real socket close. The list is cleaned up on close().
      this.streamClosers.add(close);
      const trackedClose = (): void => {
        this.streamClosers.delete(close);
        close();
      };

      const unsubscribe = deps.subscribe((event) => {
        if (closed) {
          return;
        }
        // Backpressure: skip the event when the underlying socket is
        // asking us to stop writing. Heartbeats also skip in this
        // case; the dashboard treats a stale stream as a reconnect
        // signal.
        if (reply.raw.writableNeedDrain) {
          return;
        }
        try {
          stream.push(`data: ${JSON.stringify(event)}\n\n`);
        } catch {
          trackedClose();
        }
      });

      // Heartbeat keeps proxies / nginx from idling out the
      // connection. The colon prefix is the SSE comment-line form,
      // so clients ignore it without firing a `message` event.
      const heartbeatTimer = setInterval(() => {
        if (closed) {
          return;
        }
        if (reply.raw.writableNeedDrain) {
          return;
        }
        try {
          stream.push(`: heartbeat\n\n`);
        } catch {
          trackedClose();
        }
      }, HEARTBEAT_INTERVAL_MS);
      // Don't keep the event loop alive on this timer alone.
      heartbeatTimer.unref?.();

      // Honour client disconnect: clear heartbeat, unsubscribe, end.
      req.raw.on('close', trackedClose);
      req.raw.on('aborted', trackedClose);

      reply.header('Content-Type', 'text/event-stream');
      reply.header('Cache-Control', 'no-cache');
      reply.header('Connection', 'keep-alive');
      reply.header('X-Accel-Buffering', 'no');
      return reply.send(stream);
    });
  }

  private registerConfigRoutes(): void {
    const deps = this.deps;

    this.app.get('/api/config', async () => {
      return maskConfigSecrets(deps.config());
    });

    this.app.put('/api/config', async (req, reply) => {
      const body = req.body;
      if (body === undefined || body === null || typeof body !== 'object') {
        return this.sendInvalidSchema(reply, 'Request body must be a JSON object');
      }
      const parsed = safeParseConfig(body);
      if (!parsed.success) {
        return this.sendInvalidSchema(
          reply,
          'Config payload failed schema validation',
          parsed.error,
        );
      }
      // The GET /api/config response masks secrets (Telegram token, GARDENA
      // secret), so a UI that round-trips the config back must not clobber
      // them with the mask. Restore the stored secrets where masked.
      const incoming = parsed.data;
      const finalConfig = preserveMaskedSecrets(incoming, deps.config());
      try {
        await deps.updateConfig(finalConfig);
      } catch (err) {
        return this.sendInternalError(reply, err);
      }
      return { ok: true };
    });

    // ---- Full backup / restore (config + learning + calibration) ----------
    this.app.get('/api/backup', async () => {
      const learningData =
        deps.getBackupData !== undefined
          ? await deps.getBackupData()
          : { learning: '', calibration: '' };
      return {
        kind: 'heatshield-backup',
        version: 1,
        exportedAt: new Date().toISOString(),
        config: maskConfigSecrets(deps.config()),
        learning: learningData.learning,
        calibration: learningData.calibration,
      };
    });

    this.app.post('/api/backup', async (req, reply) => {
      const body = req.body;
      if (body === undefined || body === null || typeof body !== 'object') {
        return this.sendInvalidSchema(reply, 'Request body must be a JSON object');
      }
      const bundle = body as {
        kind?: unknown;
        config?: unknown;
        learning?: unknown;
        calibration?: unknown;
      };
      if (bundle.kind !== 'heatshield-backup') {
        return this.sendInvalidSchema(
          reply,
          'Not a Heat Shield backup file (missing kind: "heatshield-backup")',
        );
      }
      // 1. Config — same validation + token-preservation as PUT /api/config.
      if (bundle.config !== undefined && bundle.config !== null) {
        const parsed = safeParseConfig(bundle.config);
        if (!parsed.success) {
          return this.sendInvalidSchema(
            reply,
            'Backup config failed schema validation',
            parsed.error,
          );
        }
        const incoming = parsed.data;
        const finalConfig = preserveMaskedSecrets(incoming, deps.config());
        try {
          await deps.updateConfig(finalConfig);
        } catch (err) {
          return this.sendInternalError(reply, err);
        }
      }
      // 2. Learning + calibration NDJSON, if the hook is wired.
      if (deps.restoreBackupData !== undefined) {
        const learning = typeof bundle.learning === 'string' ? bundle.learning : '';
        const calibration =
          typeof bundle.calibration === 'string' ? bundle.calibration : '';
        try {
          await deps.restoreBackupData({ learning, calibration });
        } catch (err) {
          return this.sendInternalError(reply, err);
        }
      }
      return { ok: true };
    });

    this.app.post('/api/config/probe', async (req, reply) => {
      const body = req.body;
      if (body === undefined || body === null) {
        // No override: probe with current config.
        try {
          const result = await deps.probe();
          return result;
        } catch (err) {
          return this.sendInternalError(reply, err);
        }
      }
      if (typeof body !== 'object') {
        return this.sendInvalidSchema(reply, 'Request body must be a JSON object');
      }
      const parsed = safeParseConfig(body);
      if (!parsed.success) {
        return this.sendInvalidSchema(
          reply,
          'Probe override config failed schema validation',
          parsed.error,
        );
      }
      try {
        const result = await deps.probe(parsed.data);
        return result;
      } catch (err) {
        return this.sendInternalError(reply, err);
      }
    });
  }

  private registerWizardRoute(): void {
    const deps = this.deps;

    this.app.post('/api/wizard/step/:n', async (req, reply) => {
      const params = req.params as { n?: string };
      const rawN = params.n ?? '';
      const stepNumber = Number.parseInt(rawN, 10);
      if (
        !Number.isInteger(stepNumber) ||
        stepNumber < 1 ||
        stepNumber > 5 ||
        rawN !== String(stepNumber)
      ) {
        const errBody: ApiErrorBody = {
          error: {
            code: 'invalid_param',
            message: `Wizard step must be an integer in [1, 5]; got ${rawN}`,
          },
        };
        return reply.code(400).send(errBody);
      }

      const body = req.body;
      if (body === undefined || body === null || typeof body !== 'object') {
        return this.sendInvalidSchema(reply, 'Wizard body must be a JSON object');
      }

      const merged = this.cloneConfig(deps.config());
      try {
        applyWizardStep(stepNumber, body, merged);
      } catch (err) {
        if (err instanceof ZodError) {
          return this.sendInvalidSchema(
            reply,
            `Wizard step ${stepNumber} failed schema validation`,
            err,
          );
        }
        return this.sendInternalError(reply, err);
      }

      // The merged result must still satisfy the full Config schema.
      // Surface that as `invalid_schema` so the SPA can render the
      // exact field path the user broke.
      const validated = safeParseConfig(merged);
      if (!validated.success) {
        return this.sendInvalidSchema(
          reply,
          `Wizard step ${stepNumber} produced an invalid Config`,
          validated.error,
        );
      }

      try {
        await deps.updateConfig(validated.data);
      } catch (err) {
        return this.sendInternalError(reply, err);
      }

      const readiness = computePluginReadiness(validated.data);
      return { ok: true, status: readiness };
    });
  }

  private registerHistoryRoutes(): void {
    const deps = this.deps;

    this.app.get('/api/history', async (req, reply) => {
      const query = (req.query ?? {}) as Record<string, unknown>;
      const rawSeconds = query['seconds'];
      const seconds = parseIntInRange(
        rawSeconds,
        MIN_HISTORY_SECONDS,
        MAX_HISTORY_SECONDS,
      );
      if (seconds === null) {
        const errBody: ApiErrorBody = {
          error: {
            code: 'invalid_query',
            message: `seconds must be an integer in [${MIN_HISTORY_SECONDS}, ${MAX_HISTORY_SECONDS}]`,
          },
        };
        return reply.code(400).send(errBody);
      }
      try {
        const records = await deps.readHistory(seconds);
        return { records };
      } catch (err) {
        return this.sendInternalError(reply, err);
      }
    });

    this.app.get('/api/trends', async (req, reply) => {
      const query = (req.query ?? {}) as Record<string, unknown>;
      const rawSeconds = query['seconds'];
      const seconds = parseIntInRange(
        rawSeconds,
        MIN_HISTORY_SECONDS,
        MAX_HISTORY_SECONDS,
      );
      if (seconds === null) {
        const errBody: ApiErrorBody = {
          error: {
            code: 'invalid_query',
            message: `seconds must be an integer in [${MIN_HISTORY_SECONDS}, ${MAX_HISTORY_SECONDS}]`,
          },
        };
        return reply.code(400).send(errBody);
      }
      try {
        const samples = await deps.readTrends(seconds);
        return { samples };
      } catch (err) {
        return this.sendInternalError(reply, err);
      }
    });

    this.app.get('/api/decisions', async (req, reply) => {
      const query = (req.query ?? {}) as Record<string, unknown>;
      const rawN = query['n'];
      const n =
        rawN === undefined
          ? DEFAULT_DECISIONS_LIMIT
          : parseIntInRange(rawN, 1, MAX_DECISIONS_LIMIT);
      if (n === null) {
        const errBody: ApiErrorBody = {
          error: {
            code: 'invalid_query',
            message: `n must be an integer in [1, ${MAX_DECISIONS_LIMIT}]`,
          },
        };
        return reply.code(400).send(errBody);
      }
      try {
        const records = await deps.readDecisions(n);
        return { records };
      } catch (err) {
        return this.sendInternalError(reply, err);
      }
    });
  }

  private registerControlRoutes(): void {
    const deps = this.deps;

    this.app.post('/api/control/shutter/:windowId', async (req, reply) => {
      const params = req.params as { windowId?: string };
      const windowId = params.windowId ?? '';
      if (windowId.length === 0) {
        const errBody: ApiErrorBody = {
          error: {
            code: 'invalid_param',
            message: 'windowId path parameter is required',
          },
        };
        return reply.code(400).send(errBody);
      }
      const parsed = ShutterBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return this.sendInvalidSchema(
          reply,
          'Shutter control body failed schema validation',
          parsed.error,
        );
      }
      try {
        await deps.setShutterManually(windowId, parsed.data.level01);
      } catch (err) {
        return this.sendInternalError(reply, err);
      }
      return { ok: true };
    });

    this.app.post('/api/control/maintenance', async (req, reply) => {
      const parsed = MaintenanceBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return this.sendInvalidSchema(
          reply,
          'Maintenance control body failed schema validation',
          parsed.error,
        );
      }
      try {
        await deps.setMaintenanceMode(parsed.data.on);
      } catch (err) {
        return this.sendInternalError(reply, err);
      }
      return { ok: true };
    });

    this.app.post('/api/control/automation', async (req, reply) => {
      const parsed = AutomationToggleBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return this.sendInvalidSchema(
          reply,
          'Automation control body failed schema validation',
          parsed.error,
        );
      }
      const setter = deps.setAutomationEnabled;
      if (setter === undefined) {
        return this.sendInternalError(
          reply,
          new Error('setAutomationEnabled not wired'),
        );
      }
      try {
        await setter(parsed.data.enabled);
      } catch (err) {
        return this.sendInternalError(reply, err);
      }
      return { ok: true, enabled: parsed.data.enabled };
    });

    this.app.post('/api/control/gardena/:deviceId', async (req, reply) => {
      const params = req.params as { deviceId?: string };
      const deviceId = params.deviceId ?? '';
      if (deviceId.length === 0) {
        const errBody: ApiErrorBody = {
          error: {
            code: 'invalid_param',
            message: 'deviceId path parameter is required',
          },
        };
        return reply.code(400).send(errBody);
      }
      const parsed = GardenaValveBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return this.sendInvalidSchema(
          reply,
          'Gardena valve control body failed schema validation',
          parsed.error,
        );
      }
      const setter = deps.setGardenaValve;
      if (setter === undefined) {
        const errBody: ApiErrorBody = {
          error: {
            code: 'gardena_unavailable',
            message:
              'Gardena valve control is not available; HCU adapter not wired',
          },
        };
        return reply.code(503).send(errBody);
      }
      try {
        await setter(deviceId, parsed.data.on, parsed.data.channelIndex ?? 1);
      } catch (err) {
        return this.sendInternalError(reply, err);
      }
      return { ok: true, on: parsed.data.on };
    });

    this.app.post('/api/gardena/test', async (_req, reply) => {
      const tester = deps.testGardena;
      if (tester === undefined) {
        const errBody: ApiErrorBody = {
          error: {
            code: 'gardena_unavailable',
            message: 'GARDENA test is not available; adapter not wired',
          },
        };
        return reply.code(503).send(errBody);
      }
      try {
        return await tester();
      } catch (err) {
        return this.sendInternalError(reply, err);
      }
    });

    this.app.post('/api/irrigation/zone/:zoneId/run', async (req, reply) => {
      const runner = deps.runIrrigationZone;
      if (runner === undefined) {
        return reply.code(503).send({
          error: { code: 'irrigation_unavailable', message: 'Irrigation not wired' },
        } satisfies ApiErrorBody);
      }
      const zoneId = (req.params as { zoneId?: string }).zoneId ?? '';
      const parsed = IrrigationRunBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return this.sendInvalidSchema(reply, 'Irrigation run body invalid', parsed.error);
      }
      try {
        await runner(zoneId, parsed.data.seconds);
      } catch (err) {
        return this.sendInternalError(reply, err);
      }
      return { ok: true };
    });

    this.app.post('/api/irrigation/zone/:zoneId/stop', async (req, reply) => {
      const stopper = deps.stopIrrigationZone;
      if (stopper === undefined) {
        return reply.code(503).send({
          error: { code: 'irrigation_unavailable', message: 'Irrigation not wired' },
        } satisfies ApiErrorBody);
      }
      const zoneId = (req.params as { zoneId?: string }).zoneId ?? '';
      try {
        await stopper(zoneId);
      } catch (err) {
        return this.sendInternalError(reply, err);
      }
      return { ok: true };
    });

    this.app.post('/api/irrigation/zone/:zoneId/skip', async (req, reply) => {
      const skipper = deps.skipIrrigationZone;
      if (skipper === undefined) {
        return reply.code(503).send({
          error: { code: 'irrigation_unavailable', message: 'Irrigation not wired' },
        } satisfies ApiErrorBody);
      }
      const zoneId = (req.params as { zoneId?: string }).zoneId ?? '';
      try {
        await skipper(zoneId);
      } catch (err) {
        return this.sendInternalError(reply, err);
      }
      return { ok: true };
    });

    this.app.post('/api/irrigation/zone/:zoneId/calibrate', async (req, reply) => {
      const calibrator = deps.calibrateIrrigationZone;
      if (calibrator === undefined) {
        return reply.code(503).send({
          error: { code: 'irrigation_unavailable', message: 'Irrigation not wired' },
        } satisfies ApiErrorBody);
      }
      const zoneId = (req.params as { zoneId?: string }).zoneId ?? '';
      const parsed = IrrigationCalibrateBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return this.sendInvalidSchema(reply, 'Irrigation calibrate body invalid', parsed.error);
      }
      try {
        await calibrator(zoneId, parsed.data.availablePct);
      } catch (err) {
        return this.sendInternalError(reply, err);
      }
      return { ok: true };
    });

    this.app.post('/api/irrigation/plan', async (req, reply) => {
      const adder = deps.addIrrigationPlanEntry;
      if (adder === undefined) {
        return reply.code(503).send({
          error: { code: 'irrigation_unavailable', message: 'Irrigation not wired' },
        } satisfies ApiErrorBody);
      }
      const parsed = IrrigationPlanAddBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return this.sendInvalidSchema(reply, 'Irrigation plan add body invalid', parsed.error);
      }
      try {
        await adder(parsed.data.zoneId, parsed.data.startTs, parsed.data.durationMin);
      } catch (err) {
        return this.sendInternalError(reply, err);
      }
      return { ok: true };
    });

    this.app.post('/api/irrigation/plan/auto', async (_req, reply) => {
      const resetter = deps.resetIrrigationPlanAuto;
      if (resetter === undefined) {
        return reply.code(503).send({
          error: { code: 'irrigation_unavailable', message: 'Irrigation not wired' },
        } satisfies ApiErrorBody);
      }
      try {
        await resetter();
      } catch (err) {
        return this.sendInternalError(reply, err);
      }
      return { ok: true };
    });

    this.app.post('/api/irrigation/plan/:entryId/update', async (req, reply) => {
      const updater = deps.updateIrrigationPlanEntry;
      if (updater === undefined) {
        return reply.code(503).send({
          error: { code: 'irrigation_unavailable', message: 'Irrigation not wired' },
        } satisfies ApiErrorBody);
      }
      const entryId = (req.params as { entryId?: string }).entryId ?? '';
      const parsed = IrrigationPlanUpdateBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return this.sendInvalidSchema(reply, 'Irrigation plan update body invalid', parsed.error);
      }
      try {
        const patch: { startTs?: string; durationMin?: number; enabled?: boolean } = {};
        if (parsed.data.startTs !== undefined) patch.startTs = parsed.data.startTs;
        if (parsed.data.durationMin !== undefined) patch.durationMin = parsed.data.durationMin;
        if (parsed.data.enabled !== undefined) patch.enabled = parsed.data.enabled;
        await updater(entryId, patch);
      } catch (err) {
        return this.sendInternalError(reply, err);
      }
      return { ok: true };
    });

    this.app.post('/api/irrigation/plan/:entryId/delete', async (req, reply) => {
      const deleter = deps.deleteIrrigationPlanEntry;
      if (deleter === undefined) {
        return reply.code(503).send({
          error: { code: 'irrigation_unavailable', message: 'Irrigation not wired' },
        } satisfies ApiErrorBody);
      }
      const entryId = (req.params as { entryId?: string }).entryId ?? '';
      try {
        await deleter(entryId);
      } catch (err) {
        return this.sendInternalError(reply, err);
      }
      return { ok: true };
    });

    this.app.post('/api/control/reset', async (_req, reply) => {
      try {
        await deps.resetConfig();
      } catch (err) {
        return this.sendInternalError(reply, err);
      }
      return { ok: true };
    });
  }

  private registerSourcesRoutes(): void {
    const deps = this.deps;

    this.app.post('/api/sources/discover', async (_req, reply) => {
      const discover = deps.discoverSources;
      if (discover === undefined) {
        const errBody: ApiErrorBody = {
          error: {
            code: 'discover_unavailable',
            message: 'Source discovery is not yet available; HCU adapter not wired',
          },
        };
        return reply.code(503).send(errBody);
      }
      try {
        const result = await discover();
        return {
          devices: result.devices,
          climateSensors: result.climateSensors,
          openMeteo: result.openMeteo,
          connectState: result.connectState,
          lastError: result.lastError,
          attemptedRefresh: result.attemptedRefresh,
          deviceTypeHistogram: result.deviceTypeHistogram,
          temperatureSources: result.temperatureSources,
          shutterSources: result.shutterSources,
          contactSources: result.contactSources,
          illuminationSources: result.illuminationSources,
          inventory: result.inventory,
          rawDeviceCount: result.rawDeviceCount,
          rawDeviceTypeHistogram: result.rawDeviceTypeHistogram,
          pluginBuild: result.pluginBuild,
        };
      } catch (err) {
        return this.sendInternalError(reply, err);
      }
    });
  }

  /**
   * Diagnose-tab routes (Task 13).
   *
   *   - `GET  /api/connect/log?n=` — Connect-API log buffer slice.
   *     Returns `503 connect_log_unavailable` when the boot module
   *     has not wired {@link DashboardServerDeps.getConnectLog}.
   *   - `POST /api/probe/run`      — synthetic engine cycle without
   *     `setShutterLevel` dispatch (steering: probe path is
   *     write-free). Returns `503 probe_unavailable` when the boot
   *     module has not wired {@link DashboardServerDeps.runProbe}.
   *
   * The probe contract guarantees that the `runProbe` callback runs
   * `runtime/probe.ts::runDryProbe`, which stubs
   * `hmipSystem.setShutterLevel` with a no-op. This server layer is
   * unaware of the implementation; it only forwards the call.
   */
  private registerDiagnosticsRoutes(): void {
    const deps = this.deps;

    this.app.get('/api/connect/log', async (req, reply) => {
      const getLog = deps.getConnectLog;
      if (getLog === undefined) {
        const errBody: ApiErrorBody = {
          error: {
            code: 'connect_log_unavailable',
            message:
              'Connect log buffer is not yet available; boot module not wired',
          },
        };
        return reply.code(503).send(errBody);
      }
      const query = (req.query ?? {}) as Record<string, unknown>;
      const rawN = query['n'];
      const n =
        rawN === undefined
          ? DEFAULT_CONNECT_LOG_LIMIT
          : parseIntInRange(rawN, 1, MAX_CONNECT_LOG_LIMIT);
      if (n === null) {
        const errBody: ApiErrorBody = {
          error: {
            code: 'invalid_query',
            message: `n must be an integer in [1, ${MAX_CONNECT_LOG_LIMIT}]`,
          },
        };
        return reply.code(400).send(errBody);
      }
      try {
        const all = getLog();
        // Take the LAST `n` entries (oldest first within the slice)
        // — the buffer's `entries()` already returns oldest-first,
        // so the slice is `[max(0, len - n), len)`.
        const start = Math.max(0, all.length - n);
        const entries = all.slice(start);
        return { entries };
      } catch (err) {
        return this.sendInternalError(reply, err);
      }
    });

    this.app.post('/api/probe/run', async (_req, reply) => {
      const runProbe = deps.runProbe;
      if (runProbe === undefined) {
        const errBody: ApiErrorBody = {
          error: {
            code: 'probe_unavailable',
            message:
              'Probe runner is not yet available; boot module not wired',
          },
        };
        return reply.code(503).send(errBody);
      }
      try {
        const result = await runProbe();
        return result;
      } catch (err) {
        return this.sendInternalError(reply, err);
      }
    });
  }

  /**
   * Learning-loop routes (Task 14.2).
   *
   *   - `GET  /api/learn/snapshot` — returns the latest
   *     {@link LearningSnapshot}. Returns 503
   *     `learning_unavailable` when the boot module has not wired
   *     {@link DashboardServerDeps.getLearningSnapshot}.
   *   - `POST /api/learn/recommendations/:id/apply` — applies one
   *     recommendation. Returns 503 `learning_unavailable` when
   *     {@link DashboardServerDeps.applyRecommendation} is not
   *     wired, 404 `recommendation_not_found` when the dep returns
   *     `{ ok: false }`.
   *   - `POST /api/learn/recommendations/:id/dismiss` — dismisses
   *     one recommendation. Returns 503 by default; the SPA falls
   *     back to a local dismiss in v1.
   *
   * Steering: this layer only forwards calls. It never reads or
   * writes `/data/config.json` directly. The actual config update
   * for `apply` is performed inside the dep, which routes through
   * the existing `updateConfig` round-trip (and therefore through
   * `safeParseConfig`).
   */
  private registerLearningRoutes(): void {
    const deps = this.deps;

    this.app.get('/api/learn/snapshot', async (_req, reply) => {
      const getSnapshot = deps.getLearningSnapshot;
      if (getSnapshot === undefined) {
        const errBody: ApiErrorBody = {
          error: {
            code: 'learning_unavailable',
            message:
              'Learning snapshot is not yet available; boot module not wired',
          },
        };
        return reply.code(503).send(errBody);
      }
      try {
        const snap = await getSnapshot();
        return snap;
      } catch (err) {
        return this.sendInternalError(reply, err);
      }
    });

    this.app.post(
      '/api/learn/recommendations/:id/apply',
      async (req, reply) => {
        const apply = deps.applyRecommendation;
        if (apply === undefined) {
          const errBody: ApiErrorBody = {
            error: {
              code: 'learning_unavailable',
              message:
                'Recommendation apply is not yet available; boot module not wired',
            },
          };
          return reply.code(503).send(errBody);
        }
        const params = req.params as { id?: string };
        const id = params.id ?? '';
        if (id.length === 0) {
          const errBody: ApiErrorBody = {
            error: {
              code: 'invalid_param',
              message: 'id path parameter is required',
            },
          };
          return reply.code(400).send(errBody);
        }
        try {
          const result = await apply(id);
          if (!result.ok) {
            const errBody: ApiErrorBody = {
              error: {
                code: 'recommendation_not_found',
                message: `Recommendation ${id} not found`,
              },
            };
            return reply.code(404).send(errBody);
          }
          return result;
        } catch (err) {
          return this.sendInternalError(reply, err);
        }
      },
    );

    this.app.post(
      '/api/learn/recommendations/:id/dismiss',
      async (req, reply) => {
        const dismiss = deps.dismissRecommendation;
        if (dismiss === undefined) {
          const errBody: ApiErrorBody = {
            error: {
              code: 'learning_unavailable',
              message:
                'Recommendation dismiss is not yet available; SPA falls back to local dismiss',
            },
          };
          return reply.code(503).send(errBody);
        }
        const params = req.params as { id?: string };
        const id = params.id ?? '';
        if (id.length === 0) {
          const errBody: ApiErrorBody = {
            error: {
              code: 'invalid_param',
              message: 'id path parameter is required',
            },
          };
          return reply.code(400).send(errBody);
        }
        try {
          const result = await dismiss(id);
          if (!result.ok) {
            const errBody: ApiErrorBody = {
              error: {
                code: 'recommendation_not_found',
                message: `Recommendation ${id} not found`,
              },
            };
            return reply.code(404).send(errBody);
          }
          return result;
        } catch (err) {
          return this.sendInternalError(reply, err);
        }
      },
    );
  }

  // -------------------------------------------------------------------------
  // Internal: response helpers.
  // -------------------------------------------------------------------------

  private sendInvalidSchema(
    reply: FastifyReply,
    message: string,
    err?: ZodError,
  ): unknown {
    const issues = err
      ? err.issues.map((i) => {
          const out: { path: (string | number)[]; message: string; code?: string } = {
            path: [...i.path] as (string | number)[],
            message: i.message,
          };
          if (typeof i.code === 'string') {
            out.code = i.code;
          }
          return out;
        })
      : undefined;
    const body: ApiErrorBody = {
      error: {
        code: 'invalid_schema',
        message,
        ...(issues !== undefined ? { issues } : {}),
      },
    };
    return reply.code(400).type('application/json').send(body);
  }

  private sendInternalError(
    reply: FastifyReply,
    err: unknown,
  ): unknown {
    const message = err instanceof Error ? err.message : String(err);
    this.deps.logger?.('warn', 'dashboard internal error', { message });
    const body: ApiErrorBody = {
      error: {
        code: 'internal_error',
        message,
      },
    };
    return reply.code(500).send(body);
  }

  private cloneConfig(c: Config): Config {
    // structuredClone is fine here — Config is JSON-shaped.
    return structuredClone(c);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers (file-private).
// ---------------------------------------------------------------------------

/**
 * Parse `raw` as an integer in `[min, max]`. Returns `null` for any
 * malformed input so the route can emit a consistent error envelope.
 */
function parseIntInRange(
  raw: unknown,
  min: number,
  max: number,
): number | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    return null;
  }
  const asString = typeof raw === 'number' ? String(raw) : raw;
  const n = Number.parseInt(asString, 10);
  if (!Number.isInteger(n)) {
    return null;
  }
  if (asString !== String(n)) {
    // Reject inputs like "12abc" that parseInt would accept.
    return null;
  }
  if (n < min || n > max) {
    return null;
  }
  return n;
}

/**
 * Apply a wizard step's validated body onto `target` in place.
 * Throws a `ZodError` when the body fails the per-step schema.
 *
 * Step 2's `openMeteoDeviceId` is validated but not yet propagated
 * onto `globalSignals` here: the wizard collects it; the boot module
 * decides which signal binding to populate (outdoor temp, humidity,
 * wind, …). For now we simply persist `fusionSolar.baseUrl` so the
 * step round-trips through `updateConfig` without breaking the
 * top-level Config schema.
 */
function applyWizardStep(
  step: number,
  body: object,
  target: Config,
): void {
  switch (step) {
    case 1: {
      const parsed = Step1Schema.parse(body);
      target.location = parsed;
      return;
    }
    case 2: {
      const parsed = Step2Schema.parse(body);
      target.fusionSolar = {
        ...target.fusionSolar,
        baseUrl: parsed.sources.fusionSolar.baseUrl,
      };
      return;
    }
    case 3: {
      const parsed = Step3Schema.parse(body);
      target.rooms = parsed.rooms;
      return;
    }
    case 4: {
      const parsed = Step4Schema.parse(body);
      target.windows = parsed.windows;
      return;
    }
    case 5: {
      const parsed = Step5Schema.parse(body);
      const nextRules: Rules = {
        ...target.rules,
        profile: parsed.profile,
      };
      target.rules = nextRules;
      return;
    }
    default:
      throw new Error(`Unhandled wizard step: ${step}`);
  }
}

/**
 * Conservative readiness heuristic. A fully wizarded config has at
 * least one room and one window; otherwise the dashboard tells the
 * HCU we still need configuration. ERROR is reserved for the boot
 * module — the wizard never reaches that branch on its own.
 */
function computePluginReadiness(config: Config): PluginReadinessStatusValue {
  if (config.rooms.length === 0 || config.windows.length === 0) {
    return 'CONFIG_REQUIRED';
  }
  return 'READY';
}

/**
 * Return a copy of the config with the Telegram bot token masked, for the
 * `GET /api/config` response (Requirement 8.5 — never expose the raw token in
 * the UI or logs). Only the `notifications.telegram.botToken` field is
 * transformed; everything else is preserved by reference where safe.
 */
function maskConfigSecrets(config: Config): Config {
  const notifications = config.notifications as Config['notifications'] | undefined;
  let out: Config = config;
  if (notifications !== undefined) {
    out = {
      ...out,
      notifications: {
        ...notifications,
        telegram: {
          ...notifications.telegram,
          botToken: maskToken(notifications.telegram.botToken),
        },
      },
    };
  }
  // Mask the GARDENA application secret the same way as the Telegram token.
  const gardena = out.gardena as Config['gardena'] | undefined;
  if (gardena !== undefined && gardena.clientSecret.length > 0) {
    out = {
      ...out,
      gardena: { ...gardena, clientSecret: maskToken(gardena.clientSecret) },
    };
  }
  return out;
}

/**
 * Restore real secrets on an incoming config when the client round-tripped
 * the masked placeholders from `GET /api/config`. Covers the Telegram bot
 * token and the GARDENA application secret. Keeps the rest of `incoming`
 * untouched so a genuine new secret still overwrites the stored one.
 */
function preserveMaskedSecrets(incoming: Config, current: Config): Config {
  let out = incoming;
  if (incoming.notifications.telegram.botToken.includes('••••')) {
    out = {
      ...out,
      notifications: {
        ...out.notifications,
        telegram: {
          ...out.notifications.telegram,
          botToken: current.notifications.telegram.botToken,
        },
      },
    };
  }
  const inc = out.gardena as Config['gardena'] | undefined;
  const cur = current.gardena as Config['gardena'] | undefined;
  if (inc !== undefined && cur !== undefined && inc.clientSecret.includes('••••')) {
    out = {
      ...out,
      gardena: { ...inc, clientSecret: cur.clientSecret },
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Re-exports: tests pull the schema constants for direct comparisons.
// ---------------------------------------------------------------------------

export {
  ConfigSchema as DashboardConfigSchema,
  Step1Schema as DashboardWizardStep1Schema,
  Step2Schema as DashboardWizardStep2Schema,
  Step3Schema as DashboardWizardStep3Schema,
  Step4Schema as DashboardWizardStep4Schema,
  Step5Schema as DashboardWizardStep5Schema,
  ShutterBodySchema as DashboardShutterBodySchema,
  MaintenanceBodySchema as DashboardMaintenanceBodySchema,
};

/**
 * Re-exported for tests that want to assert the exact wire shape of
 * an error body without re-importing every individual code value.
 */
export type DashboardApiErrorBody = ApiErrorBody;

// `parseConfig` is unused inside the server itself but is the
// canonical entry point the orchestrator calls when probing — keep
// the import live so the bundler does not tree-shake it away in
// boot, and so tests can co-import without a second import line.
export { parseConfig as dashboardParseConfig };
