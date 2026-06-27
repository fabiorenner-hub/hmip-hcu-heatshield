/**
 * Heat Shield plugin entry point (de.fr.renner.plugin.heatshield).
 *
 * Wires the persistence layer, source adapters, engine, dashboard
 * server, and (when the runtime environment provides them) the
 * Connect-API client into a single live process. Designed so a
 * smoke test that boots `node dist/plugin/index.js` with
 * `HEATSHIELD_NO_CONNECT=1` reaches a healthy `/api/state` even
 * without a real HCU on the other side of the WebSocket.
 *
 * Steering compliance:
 *   - native HMIP rollers are only ever moved through the
 *     orchestrator + `HmipSystemAdapter.setShutterLevel`,
 *   - STATUS_EVENT is only ever produced by `OwnDeviceManager`
 *     (steering: only plugin-OWNED switches),
 *   - configuration writes flow through `dashboard âžœ updateConfig`
 *     which calls `parseConfig` and `writeConfig` — the engine
 *     never writes `/data/config.json` directly.
 */

import { EventEmitter } from 'node:events';
import { promises as fs, existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

import { parseConfig, safeParseConfig } from '../shared/schema.js';
import type {
  Config,
  ContactState,
  DecisionRecord,
  Mode,
  Priority,
  RuntimeState,
  SignalBinding,
  WindowRuntimeState,
} from '../shared/types.js';

import {
  ConfigUpdateResponseStatus,
  ConnectClient,
  HmipSystemAdapter,
  OwnDeviceManager,
  PluginMessageType,
  PluginReadinessStatus,
  PropertyDataType,
  buildConfigTemplateResponse,
  buildConfigUpdateResponse,
  buildDiscoverResponse,
  buildPluginStateResponse,
  type ConfigGroupTemplate,
  type ConfigPropertyTemplate,
  type ConnectEnvelope,
  type PluginReadinessStatusValue,
} from './connect/index.js';
import { ConnectLogBuffer } from './connect/logBuffer.js';
import {
  DashboardServer,
  type DashboardServerDeps,
  type DashboardSnapshotV2,
  type DashboardStreamEvent,
  type FacadeKey,
  type ForecastResponse,
  type PlanResponse,
  type SignalValue,
  type ValueWithQuality,
} from './dashboard/server.js';
import {
  aggregateDailyMetrics,
  deriveRecommendations,
  type LearningSnapshot,
  type RoomTempSample,
} from './engine/learn.js';
import { runCycle, type CycleSnapshot, type CycleOutputs } from './engine/orchestrator.js';
import { type ModeExplanation } from './engine/modes.js';
import { ventilationAdvice, type VentAdvice } from './engine/ventilationAdvice.js';
import { coolingAdvice } from './engine/coolingAdvice.js';
import {
  learnRoomModel,
  type DailyObservation,
  type LearnedRoomModel,
} from './engine/learning/shadeLearner.js';
import {
  calibrateRoomInertia,
  type CalibrationObservation,
  type CalibratedRoom,
} from './engine/learning/thermalCalibration.js';
import { getSunPosition, sunOnWindow, sunOnWindowSoon } from './engine/sun.js';
import {
  facadeExposure01,
  clearSkyPvKw,
  pvSonnenindex01,
} from './engine/forecast/facadeExposure.js';
import { level01ToPercent } from './engine/forecast/shutterConvention.js';
import {
  facadeKeyFor,
  makeValueWithQuality,
} from './dashboard/snapshotFields.js';
import type { PlannerResult, DeviationBaseline } from './engine/forecast/planner.js';
import type { PlannedAction } from './engine/forecast/positionSelector.js';
import {
  writePlan,
  writeBaseline,
  appendTrajectorySnapshot,
} from './persistence/forecastStore.js';
import { TrendStore } from './engine/trends.js';
import {
  effectiveHeatLoad01,
  type HeatLoadResult,
} from './engine/heatLoad.js';
import {
  initialShadeRuntime,
  nextShadeState,
  type WindowShadeRuntime,
} from './engine/shadingState.js';
import { readOrSeed, writeConfig } from './persistence/config.js';
import { appendRecord, readLastN, readRecords } from './persistence/history.js';
import { MessageStore } from './persistence/messages.js';
import {
  appendSamples,
  compact as compactTrends,
  readSamples as readTrendSamples,
} from './persistence/trends.js';
import {
  appendObservations as appendLearningObservations,
  readObservations as readLearningObservations,
  compact as compactLearning,
} from './persistence/learningStore.js';
import {
  appendCalibrationObservations,
  readCalibrationObservations,
  compactCalibration,
} from './persistence/calibrationStore.js';
import {
  accumulatePvOrientation,
  estimatePvOrientation,
  emptyPvOrientationState,
  type PvOrientationState,
} from './engine/learning/pvOrientation.js';
import {
  readPvOrientation,
  writePvOrientation,
} from './persistence/pvOrientationStore.js';
import {
  emptyRuntimeState,
  readState,
  writeState,
} from './persistence/state.js';
import { MorningBriefScheduler } from './notifications/morningBrief.js';
import {
  NotificationService,
  type ShadingEvent,
} from './notifications/service.js';
import { sendTelegram } from './notifications/telegram.js';
import { TelegramBot } from './notifications/telegramBot.js';
import {
  buildTelegramCommands,
  type TelegramCommandContext,
} from './notifications/telegramCommands.js';
import { runDryProbe } from './runtime/probe.js';
import { UserInputBridge } from './runtime/userInputBridge.js';
import { FusionSolarAdapter } from './sources/fusionSolar.js';
import { HcuSourceCache } from './sources/hcu.js';
import type { HmipDeviceMeta } from './sources/hcu.js';
import { resolveSignal, type SourceContext } from './sources/index.js';
import { OpenMeteoAdapter } from './sources/openMeteo.js';
import { GardenaCloudAdapter } from './sources/gardena.js';
import { IrrigationController } from './irrigation/controller.js';

const PLUGIN_ID = 'de.fr.renner.plugin.heatshield';

/**
 * Map a WMO weather code to a weather emoji for the forecast timeline.
 * Night uses a moon glyph when the sky is clear/partly clear.
 */
function weatherIconFor(
  code: number | null,
  isUp: boolean,
  cloud01: number | null,
): string {
  if (code !== null) {
    if (code >= 95) return '⛈️';
    if (code >= 80) return '🌦️';
    if (code >= 71) return '🌨️';
    if (code >= 51) return '🌧️';
    if (code === 45 || code === 48) return '🌫️';
    if (code === 0) return isUp ? '☀️' : '🌙';
    if (code <= 2) return isUp ? '🌤️' : '🌙';
    if (code === 3) return '☁️';
  }
  const c = cloud01 ?? 0;
  if (!isUp) return '🌙';
  return c > 0.6 ? '☁️' : c > 0.3 ? '⛅' : '☀️';
}

/** German label for a WMO weather code that we treat as severe. */
function weatherCodeLabel(code: number): string {
  if (code >= 95) return 'Gewitter';
  if (code === 82) return 'heftige Regenschauer';
  if (code === 65) return 'starken Regen';
  if (code === 75 || code === 86) return 'starken Schneefall';
  return 'Unwetter';
}

/** WMO codes Heat Shield treats as severe weather (beyond the wind threshold). */
function isSevereWeatherCode(code: number): boolean {
  return code >= 95 || code === 82 || code === 65 || code === 75 || code === 86;
}

/** German FSM mode labels for Telegram replies. */
const MODE_LABELS_DE: Record<string, string> = {
  NORMAL: 'Normal',
  SUMMER_WATCH: 'Sommer-Beobachtung',
  ACTIVE_HEAT_PROTECTION: 'Aktiver Hitzeschutz',
  HEATWAVE: 'Hitzewelle',
  NIGHT_COOLING: 'Nachtkühlung',
  STORM: 'Sturm',
  VACATION: 'Urlaub',
  MAINTENANCE: 'Wartung',
};

/** English FSM mode labels for Telegram replies (notification language EN). */
const MODE_LABELS_EN: Record<string, string> = {
  NORMAL: 'Normal',
  SUMMER_WATCH: 'Summer watch',
  ACTIVE_HEAT_PROTECTION: 'Active heat protection',
  HEATWAVE: 'Heatwave',
  NIGHT_COOLING: 'Night cooling',
  STORM: 'Storm',
  VACATION: 'Vacation',
  MAINTENANCE: 'Maintenance',
};

interface BootEnv {
  readonly dataDir: string;
  readonly port: number | null;
  readonly noConnect: boolean;
  readonly connectUrl: string;
  readonly authToken: string | null;
  readonly tokenPath: string;
  /** Optional override for the FusionSolar base URL (HEATSHIELD_FUSION_URL). */
  readonly fusionUrl: string | null;
}

/**
 * Resolve the FusionSolar base URL the in-container plugin can actually reach.
 *
 *   1. An explicit `HEATSHIELD_FUSION_URL` env override always wins.
 *   2. Otherwise, if the configured host is the HCU's mDNS name
 *      (`hcu1-XXXX.local`), rewrite it to `host.containers.internal` — the
 *      container→host bridge — because containers do not resolve `.local`
 *      mDNS names, while the FusionSolar plugin is reachable on the host at
 *      the same port. (The Connect-API socket uses the same bridge host.)
 *   3. Any other host (a real IP, a custom name) is used verbatim.
 */
function resolveFusionBaseUrl(configUrl: string, envOverride: string | null): string {
  if (envOverride !== null && envOverride.length > 0) {
    return envOverride;
  }
  try {
    const u = new URL(configUrl);
    if (/^hcu1-.*\.local$/iu.test(u.hostname)) {
      u.hostname = 'host.containers.internal';
      return u.toString().replace(/\/$/u, '');
    }
  } catch {
    // Malformed URL — fall through to the configured value.
  }
  return configUrl;
}

function readEnv(): BootEnv {
  const dataDir = process.env['HEATSHIELD_DATA_DIR'] ?? '/data';
  const portRaw = process.env['HEATSHIELD_DASHBOARD_PORT'];
  const port =
    portRaw === undefined ? null : Number.parseInt(portRaw, 10) || null;
  const noConnect = process.env['HEATSHIELD_NO_CONNECT'] === '1';
  const connectUrl =
    process.env['HEATSHIELD_CONNECT_URL'] ??
    'wss://host.containers.internal:9001';
  // Token resolution order (Connect API Â§4.2 / Â§5):
  //   1. HEATSHIELD_AUTH_TOKEN env var (remote dev, smoke tests).
  //   2. HEATSHIELD_TOKEN_PATH (override for non-standard mounts).
  //   3. /TOKEN — the path the HCU mounts the auto-generated token at
  //      when an installed plugin starts.
  const tokenPath = process.env['HEATSHIELD_TOKEN_PATH'] ?? '/TOKEN';
  const authToken = process.env['HEATSHIELD_AUTH_TOKEN'] ?? null;
  const fusionUrl = process.env['HEATSHIELD_FUSION_URL'] ?? null;
  return { dataDir, port, noConnect, connectUrl, authToken, tokenPath, fusionUrl };
}

/**
 * Read the auth token from /TOKEN (or the override path). Returns
 * `null` if the file does not exist or is empty so the caller can
 * fall back to `HEATSHIELD_AUTH_TOKEN` for remote-dev / smoke runs.
 */
async function readAuthTokenFile(tokenPath: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(tokenPath, 'utf8');
    const trimmed = raw.trim();
    return trimmed.length === 0 ? null : trimmed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Count devices in a raw `getSystemState` body WITHOUT any schema
 * validation — the diagnostic counterpart to the cache's parsed
 * device list. Walks the same wrapper shapes `extractDevices` does
 * (`{devices}`, `{body:{devices}}`, `{body:{body:{devices}}}`) and
 * tallies each device's raw top-level `type` (or `(no type field)`).
 * Returns zeros for a malformed / null body. Used to prove whether
 * the HCU actually sent native devices that our parser then dropped.
 */
function summariseRawSystemState(rawBody: unknown): {
  rawDeviceCount: number;
  rawDeviceTypeHistogram: ReadonlyArray<{ deviceType: string; count: number }>;
} {
  const empty = { rawDeviceCount: 0, rawDeviceTypeHistogram: [] };
  if (rawBody === null || typeof rawBody !== 'object') return empty;
  // Walk to the devices map through the known wrapper shapes.
  let cursor: unknown = rawBody;
  for (let depth = 0; depth < 4; depth += 1) {
    if (cursor === null || typeof cursor !== 'object') return empty;
    const obj = cursor as Record<string, unknown>;
    const devices = obj['devices'];
    if (
      devices !== null &&
      typeof devices === 'object' &&
      !Array.isArray(devices)
    ) {
      const counts = new Map<string, number>();
      for (const dev of Object.values(devices as Record<string, unknown>)) {
        let key = '(no type field)';
        if (dev !== null && typeof dev === 'object') {
          const t = (dev as Record<string, unknown>)['type'];
          if (typeof t === 'string' && t.length > 0) key = t;
        }
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const rawDeviceTypeHistogram = Array.from(counts.entries())
        .map(([deviceType, count]) => ({ deviceType, count }))
        .sort((a, b) =>
          a.count !== b.count
            ? b.count - a.count
            : a.deviceType.localeCompare(b.deviceType),
        );
      const rawDeviceCount = Object.keys(
        devices as Record<string, unknown>,
      ).length;
      return { rawDeviceCount, rawDeviceTypeHistogram };
    }
    // Descend into `.body` and retry.
    cursor = obj['body'];
  }
  return empty;
}

/**
 * Map an HMIP `windowState` feature value (CLOSED / OPEN / TILTED) to
 * the engine's {@link ContactState}. Unknown / missing values become
 * `'unknown'` so the ventilation layer treats the window as
 * indeterminate rather than guessing it is closed.
 */
function mapWindowState(raw: unknown): ContactState {
  if (typeof raw !== 'string') return 'unknown';
  switch (raw.toUpperCase()) {
    case 'CLOSED':
      return 'closed';
    case 'OPEN':
      return 'open';
    case 'TILTED':
      return 'tilted';
    default:
      return 'unknown';
  }
}

/** Beispielstadt default seed (steering: `heat-shield-context.md`). */
function seedDefaultConfig(): Config {
  return parseConfig({
    schemaVersion: 1,
    location: { latitude: 52.52, longitude: 13.41, timezone: 'Europe/Berlin' },
    globalSignals: {
      outdoorTemp: { primary: { kind: 'static', value: 18.5 } },
      // PV generation = FusionSolar `inputPower` (PV DC string input). This is
      // the leading solar-heat indicator; bound by default so a fresh install
      // already reads the panels' generation without manual wiring.
      pvPower: { primary: { kind: 'fusion', field: 'inputPower' } },
    },
  });
}

interface RuntimeView {
  state: RuntimeState;
  lastMode: Mode | null;
  lastModeExplanation: ModeExplanation | null;
  lastDecision: DecisionRecord | null;
}

class HeatShieldBoot {
  private readonly env: BootEnv;
  private config: Config;
  private readonly runtime: RuntimeView;
  private readonly events = new EventEmitter();
  private readonly logBuffer = new ConnectLogBuffer();
  private readonly cache = new HcuSourceCache();
  private readonly fusionSolar: FusionSolarAdapter;
  private openMeteo: OpenMeteoAdapter;
  private openMeteoStarted = false;
  private gardena: GardenaCloudAdapter | null = null;
  private gardenaStarted = false;
  private readonly irrigation: IrrigationController;
  private readonly ownDevices: OwnDeviceManager;
  private readonly bridge: UserInputBridge;
  private readonly dashboard: DashboardServer;
  private readonly connect: ConnectClient | null;
  private readonly hmipSystem: HmipSystemAdapter | null;
  private readonly trendStore: TrendStore;
  private readonly messageStore: MessageStore;
  private notifications: NotificationService;
  private morningBrief: MorningBriefScheduler;
  private dailySummary: MorningBriefScheduler;
  private readonly telegramBot: TelegramBot;
  /** Per-window contact state from the previous cycle (for open/close transitions). */
  private readonly lastContactByWindow = new Map<string, ContactState>();
  /** Windows currently flagged by the health watchdog (not reaching target). */
  private readonly healthAlerted = new Set<string>();
  /** Alert dedup: keys already sent on the current local day. */
  private alertsDay = '';
  private readonly alertsSentToday = new Set<string>();
  /** Whether a storm alert was already sent for the ongoing storm episode. */
  private stormAlerted = false;

  // --- learning module (day-to-day shading improvement) ----------------
  /** Local day key the in-memory accumulator is collecting for. */
  private learnAccumDay = '';
  /** Per-room running aggregates for the current day. */
  private readonly learnAccum = new Map<
    string,
    { indoorPeakC: number | null; outdoorMaxC: number | null; forecastMaxC: number | null; pvPeakKw: number | null; moves: number }
  >();
  /** Persisted daily observations (rolling window). */
  private learnHistory: DailyObservation[] = [];
  /** Learned model per room, recomputed on each day rollover. */
  private learnedModels = new Map<string, LearnedRoomModel>();
  // --- thermal self-calibration (per-room inertia auto-tune) -----------
  /** Per-room running peaks (actual vs predicted) for the current day. */
  private readonly calibAccum = new Map<
    string,
    { actualPeakC: number | null; predictedPeakC: number | null }
  >();
  /** Persisted daily calibration observations (rolling window). */
  private calibHistory: CalibrationObservation[] = [];
  /** Calibrated inertia model per room, recomputed on each day rollover. */
  private calibratedModels = new Map<string, CalibratedRoom>();

  // --- PV array azimuth self-learning (from the power curve) -----------
  /** Running power-weighted accumulator persisted under /data. */
  private pvOrientState: PvOrientationState = emptyPvOrientationState();
  /** Learned array azimuth (deg) once confident; null → use orientationHint. */
  private pvArrayAzimuthDeg: number | null = null;
  // --- impact / "Wirkung" tracker (in-memory, per local day) -----------
  private impactDay = '';
  private impactCyclesToday = 0;
  /** Cycles today where no room exceeded its comfort warning ceiling. */
  private impactComfortableToday = 0;
  private cycleTimer: ReturnType<typeof setInterval> | null = null;
  private initialCycleTimer: ReturnType<typeof setTimeout> | null = null;
  private cycleRunning = false;
  /** B2: per-cycle snapshot cache so polls/SSE don't recompute the heavy snapshot. */
  private cachedSnapshot: DashboardSnapshotV2 | null = null;
  private cachedSnapshotAt = 0;
  private trendCyclesSinceCompact = 0;
  private lastForecastPushMs = 0;
  private lastLearningApplyMs = 0;
  private stopping = false;
  /** Most recent forecast plan from the engine cycle (Task 11/12). */
  private lastPlannerResult: PlannerResult | undefined = undefined;
  /** Deviation baseline carried between cycles (predictive-control-dashboard). */
  private forecastBaseline: DeviationBaseline = {};
  private cachedHcuHost: string = 'host.containers.internal';

  public constructor(env: BootEnv, config: Config, state: RuntimeState) {
    this.env = env;
    this.config = config;
    this.runtime = { state, lastMode: state.currentMode, lastModeExplanation: null, lastDecision: null };
    this.fusionSolar = new FusionSolarAdapter({
      baseUrl: resolveFusionBaseUrl(config.fusionSolar.baseUrl, env.fusionUrl),
    });
    this.openMeteo = new OpenMeteoAdapter({
      latitude: config.location.latitude,
      longitude: config.location.longitude,
      timezone: config.location.timezone,
      baseUrl: config.openMeteo.baseUrl,
      pollIntervalMs: config.openMeteo.pollIntervalMinutes * 60_000,
    });
    this.ownDevices = new OwnDeviceManager({
      pluginId: PLUGIN_ID,
      logger: this.logBuffer.asLogger,
    });
    this.ownDevices.loadCache(state.ownSwitches);
    this.irrigation = new IrrigationController({
      config: () => this.config,
      gardena: () => this.gardena,
      openMeteo: () => this.openMeteo,
      pvSurplusKw: () => this.pvSurplusKw(),
      statePath: this.irrigationPath(),
      logger: this.logBuffer.asLogger,
      emit: (event) => this.events.emit('event', event as DashboardStreamEvent),
    });
    this.bridge = new UserInputBridge({
      ownDevices: this.ownDevices,
      readState: () => readState({ statePath: this.statePath() }),
      writeState: (s) => writeState(s, { statePath: this.statePath() }),
      emptyState: emptyRuntimeState,
      manualOverrideMinutes: config.rules.manualOverrideMinutes,
      location: config.location,
      logger: this.logBuffer.asLogger,
      onReevaluate: () => this.runCycleNow(),
    });
    if (env.noConnect || env.authToken === null) {
      this.connect = null;
      this.hmipSystem = null;
    } else {
      this.connect = new ConnectClient({
        url: env.connectUrl,
        pluginId: PLUGIN_ID,
        authToken: env.authToken,
        logger: this.logBuffer.asLogger,
      });
      this.hmipSystem = new HmipSystemAdapter({
        client: this.connect,
        pluginId: PLUGIN_ID,
        cache: this.cache,
        logger: this.logBuffer.asLogger,
      });
    }
    this.trendStore = new TrendStore(config.rules.heatLoad.trendWindowHours);
    this.messageStore = new MessageStore({
      messagesPath: path.join(env.dataDir, 'messages.ndjson'),
    });
    this.notifications = new NotificationService({
      store: this.messageStore,
      telegram: config.notifications.telegram,
      events: config.notifications.events,
      language: config.notifications.language,
      logger: this.logBuffer.asLogger,
    });
    this.morningBrief = new MorningBriefScheduler({
      localTime: config.notifications.morningBriefLocalTime,
      timezone: config.location.timezone,
      markerPath: path.join(env.dataDir, 'morning-brief.json'),
    });
    this.dailySummary = new MorningBriefScheduler({
      localTime: config.notifications.dailySummaryLocalTime,
      timezone: config.location.timezone,
      markerPath: path.join(env.dataDir, 'daily-summary.json'),
    });
    this.lastForecastPushMs = Date.now();
    this.telegramBot = new TelegramBot({
      getTelegram: () => this.config.notifications.telegram,
      commands: buildTelegramCommands(this.buildTelegramCommandContext()),
      menu: [
        [
          { text: '📊 Status', command: '/status' },
          { text: '🌤 Wetter', command: '/wetter' },
        ],
        [{ text: '🌡 Räume', command: '/raeume' }],
        [
          { text: '⏸ Pause', command: '/pause' },
          { text: '▶ Weiter', command: '/weiter' },
        ],
        [
          { text: '✈ Urlaub an', command: '/urlaub an' },
          { text: 'Urlaub aus', command: '/urlaub aus' },
        ],
      ],
      loadOffset: () => this.loadTelegramOffset(),
      saveOffset: (o) => this.saveTelegramOffset(o),
      logger: this.logBuffer.asLogger,
    });
    this.dashboard = new DashboardServer(this.buildDashboardDeps(), {
      port: env.port ?? config.dashboard.port,
    });
  }

  public async start(): Promise<void> {
    await this.resolveHcuHost();
    // Rehydrate the notification + trend stores from disk before the
    // first cycle so the badge count, message history and trend window
    // survive a restart.
    try {
      await this.messageStore.load();
    } catch (err) {
      this.logBuffer.append('warn', 'messageStore.load failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      const samples = await readTrendSamples({ trendsPath: this.trendsPath() });
      this.trendStore.load(samples, new Date());
    } catch (err) {
      this.logBuffer.append('warn', 'trendStore.load failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      this.learnHistory = await readLearningObservations({
        learningPath: this.learningPath(),
      });
      this.recomputeLearnedModels();
    } catch (err) {
      this.logBuffer.append('warn', 'learningStore.load failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      this.calibHistory = await readCalibrationObservations({
        calibrationPath: this.calibrationPath(),
      });
      this.recomputeCalibration();
    } catch (err) {
      this.logBuffer.append('warn', 'calibrationStore.load failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      this.pvOrientState = await readPvOrientation({ dataDir: this.env.dataDir });
      this.recomputePvOrientation();
    } catch (err) {
      this.logBuffer.append('warn', 'pvOrientationStore.load failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      await this.morningBrief.load();
    } catch {
      /* best-effort: missing marker just means "not sent today yet" */
    }
    try {
      await this.dailySummary.load();
    } catch {
      /* best-effort: missing marker just means "not sent today yet" */
    }
    // Two-way Telegram bot (long-polling). Starts idle and only polls once
    // the user enables commands in the config; safe to start unconditionally.
    void this.telegramBot.start();
    if (!this.env.noConnect) {
      try {
        this.fusionSolar.start();
        this.logBuffer.append('info', 'fusionSolar polling started', {
          baseUrl: resolveFusionBaseUrl(this.config.fusionSolar.baseUrl, this.env.fusionUrl),
        });
      } catch (err) {
        this.logBuffer.append('warn', 'fusionSolar.start failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      // Always run OpenMeteo for the dashboard forecast (even when it is not
      // bound as a signal source).
      this.syncOpenMeteo();
    }
    // GARDENA cloud (Bewässerung) — independent of the HCU/Connect socket.
    this.syncGardena();
    void this.irrigation.init().catch((err: unknown) => {
      this.logBuffer.append('warn', 'irrigation init failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    if (this.connect !== null && this.hmipSystem !== null) {
      this.connect.on('message', (env) => this.routeIncoming(env));
      this.connect.on('open', () => this.announceReady());
      this.ownDevices.on('statusEvent', (env) => this.safeSend(env));
      this.ownDevices.on('controlResponse', (env) => this.safeSend(env));
      this.hmipSystem.start();
      this.connect.start();
    }
    await this.dashboard.start();
    const intervalMs = this.config.rules.automation.controlIntervalSeconds * 1000;
    this.cycleTimer = setInterval(() => this.runCycleNow(), intervalMs);
    this.cycleTimer.unref?.();
    // Kick an initial cycle shortly after boot so the dashboard's planner data
    // (12 h forecast, per-room heat load, planned actions, shutter preview)
    // populates within seconds instead of only after a full
    // controlIntervalSeconds (up to 300 s) — otherwise the house twin shows
    // no heat-map / 12 h preview / next actions right after a (re)start.
    // runCycleInner refreshes getSystemState first, so the cache is warm even
    // on a cold boot; the reentrancy + stopping guards keep this safe.
    this.initialCycleTimer = setTimeout(() => this.runCycleNow(), 8_000);
    this.initialCycleTimer.unref?.();
  }

  public async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.cycleTimer !== null) {
      clearInterval(this.cycleTimer);
      this.cycleTimer = null;
    }
    if (this.initialCycleTimer !== null) {
      clearTimeout(this.initialCycleTimer);
      this.initialCycleTimer = null;
    }
    this.bridge.stop();
    this.telegramBot.stop();
    await this.fusionSolar.stop();
    await this.openMeteo.stop();
    this.gardena?.stop();
    // Compact the trend file to the retained window on shutdown.
    try {
      await compactTrends(this.trendStore.export(), {
        trendsPath: this.trendsPath(),
      });
    } catch {
      /* best-effort */
    }
    this.hmipSystem?.stop();
    if (this.connect !== null) {
      try {
        await this.connect.stop();
      } catch {
        /* best-effort */
      }
    }
    await this.dashboard.stop();
  }

  // --- routing ----------------------------------------------------------
  private routeIncoming(envelope: ConnectEnvelope): void {
    if (envelope.type === PluginMessageType.DISCOVER_REQUEST) {
      const reply = buildDiscoverResponse({
        pluginId: PLUGIN_ID,
        replyTo: envelope,
        switchStates: this.ownDevices.getCache(),
        health: { fusionSolar: this.fusionSolar.getStatus().sourceOk, hcu: true },
      });
      this.safeSend(reply);
    } else if (envelope.type === PluginMessageType.PLUGIN_STATE_REQUEST) {
      this.safeSend(
        buildPluginStateResponse({
          pluginId: PLUGIN_ID,
          status: this.computeReadiness(),
          replyTo: envelope,
        }),
      );
    } else if (envelope.type === PluginMessageType.CONFIG_TEMPLATE_REQUEST) {
      this.safeSend(
        buildConfigTemplateResponse({
          replyTo: envelope,
          properties: this.buildConfigTemplateProperties(),
          groups: this.buildConfigTemplateGroups(),
        }),
      );
    } else if (envelope.type === PluginMessageType.CONFIG_UPDATE_REQUEST) {
      this.handleConfigUpdate(envelope);
    } else if (envelope.type === PluginMessageType.CONTROL_REQUEST) {
      this.ownDevices.handleControlRequest(envelope);
    }
  }

  // --- config UI (spec Â§3.4) -------------------------------------------
  /**
   * Best-effort resolution of the HCU's hostname so the WEBLINK
   * property can show a clickable link to our own dashboard. Order:
   *
   *   1. `HEATSHIELD_DASHBOARD_URL` (full override, e.g. for tests).
   *   2. `HEATSHIELD_HCU_HOST` env var (just the hostname).
   *   3. Read `/SGTIN` (mounted by the HCU, Â§4.2) and derive
   *      `hcu1-XXXX.local` from the last four digits.
   *   4. Fall back to `host.containers.internal` (works inside the
   *      container; useful when the user reads it via the smartphone
   *      app's link forwarding).
   */
  private dashboardUrl(): string {
    const override = process.env['HEATSHIELD_DASHBOARD_URL'];
    if (override !== undefined && override.length > 0) return override;
    const port = this.env.port ?? this.config.dashboard.port;
    const host = process.env['HEATSHIELD_HCU_HOST'] ?? this.cachedHcuHost;
    return `http://${host}:${port}/`;
  }

  /**
   * Read /SGTIN once at startup. The file contains the HCU's SGTIN;
   * its last four characters form the `hcu1-XXXX.local` hostname
   * the HMIP iOS app and HCUweb resolve via mDNS.
   */
  private async resolveHcuHost(): Promise<void> {
    const override = process.env['HEATSHIELD_HCU_HOST'];
    if (override !== undefined && override.length > 0) {
      this.cachedHcuHost = override;
      return;
    }
    try {
      const sgtinPath = process.env['HEATSHIELD_SGTIN_PATH'] ?? '/SGTIN';
      const raw = await fs.readFile(sgtinPath, 'utf8');
      const sgtin = raw.trim();
      if (sgtin.length >= 4) {
        const last4 = sgtin.slice(-4).toLowerCase();
        this.cachedHcuHost = `hcu1-${last4}.local`;
      }
    } catch {
      // /SGTIN not mounted (smoke run / remote dev) — keep default.
    }
  }

  private buildConfigTemplateGroups(): Record<string, ConfigGroupTemplate> {
    return {
      dashboard: {
        friendlyName: 'Dashboard',
        description:
          'Heat Shield bringt eine eigene Konfigurations- und Visualisierungs-UI mit. Über den Link unten öffnet sie sich im Browser.',
        order: 1,
      },
      status: {
        friendlyName: 'Status',
        description:
          'Read-only-Übersicht des aktuellen Plugin-Zustands. Alle Einstellungen werden im Heat-Shield-Dashboard verwaltet.',
        order: 2,
      },
      location: {
        friendlyName: 'Standort',
        description:
          'Geografische Lage für Sonnenstandsberechnung. Detail-Konfiguration im Dashboard.',
        order: 3,
      },
    };
  }

  private buildConfigTemplateProperties(): Record<
    string,
    ConfigPropertyTemplate
  > {
    const readiness = this.computeReadiness();
    const stormHold =
      this.runtime.state.stormHoldUntil === null
        ? '–'
        : new Date(this.runtime.state.stormHoldUntil).toLocaleString('de-DE');
    return {
      dashboardLink: {
        dataType: PropertyDataType.WEBLINK,
        friendlyName: 'Heat-Shield-Dashboard öffnen',
        currentValue: this.dashboardUrl(),
        defaultValue:
          'Konfiguration, Wizard, Live-Visualisierung und Diagnose des Plugins.',
        groupId: 'dashboard',
        order: 1,
      },
      currentMode: {
        dataType: PropertyDataType.READONLY,
        friendlyName: 'Modus',
        currentValue: this.runtime.lastMode ?? 'NORMAL',
        groupId: 'status',
        order: 1,
      },
      pluginReadiness: {
        dataType: PropertyDataType.READONLY,
        friendlyName: 'Plugin-Status',
        currentValue: readiness,
        groupId: 'status',
        order: 2,
      },
      windowsConfigured: {
        dataType: PropertyDataType.READONLY,
        friendlyName: 'Konfigurierte Fenster',
        currentValue: String(this.config.windows.length),
        groupId: 'status',
        order: 3,
      },
      roomsConfigured: {
        dataType: PropertyDataType.READONLY,
        friendlyName: 'Konfigurierte Räume',
        currentValue: String(this.config.rooms.length),
        groupId: 'status',
        order: 4,
      },
      stormHoldUntil: {
        dataType: PropertyDataType.READONLY,
        friendlyName: 'Sturmschutz-Halt bis',
        currentValue: stormHold,
        groupId: 'status',
        order: 5,
      },
      latitude: {
        dataType: PropertyDataType.NUMBER,
        friendlyName: 'Breitengrad',
        currentValue: this.config.location.latitude,
        minimum: -90,
        maximum: 90,
        required: true,
        groupId: 'location',
        order: 1,
      },
      longitude: {
        dataType: PropertyDataType.NUMBER,
        friendlyName: 'Längengrad',
        currentValue: this.config.location.longitude,
        minimum: -180,
        maximum: 180,
        required: true,
        groupId: 'location',
        order: 2,
      },
      timezone: {
        dataType: PropertyDataType.STRING,
        friendlyName: 'Zeitzone (IANA)',
        currentValue: this.config.location.timezone,
        required: true,
        pattern: '^[A-Za-z_]+/[A-Za-z_+\\-0-9]+$',
        groupId: 'location',
        order: 3,
      },
    };
  }

  private async handleConfigUpdate(envelope: ConnectEnvelope): Promise<void> {
    // Spec Â§6.4.2 ConfigUpdateRequest body shape:
    //   { configurationProperties: { [propertyId]: <new value> } }
    const body = envelope.body as
      | { configurationProperties?: Record<string, unknown> }
      | undefined;
    const changes = body?.configurationProperties ?? {};
    const next: Config = structuredClone(this.config) as Config;
    const errors: string[] = [];
    if ('latitude' in changes) {
      const v = Number(changes['latitude']);
      if (Number.isFinite(v) && v >= -90 && v <= 90) {
        next.location = { ...next.location, latitude: v };
      } else {
        errors.push('latitude');
      }
    }
    if ('longitude' in changes) {
      const v = Number(changes['longitude']);
      if (Number.isFinite(v) && v >= -180 && v <= 180) {
        next.location = { ...next.location, longitude: v };
      } else {
        errors.push('longitude');
      }
    }
    if ('timezone' in changes) {
      const v = String(changes['timezone'] ?? '');
      if (v.length > 0) {
        next.location = { ...next.location, timezone: v };
      } else {
        errors.push('timezone');
      }
    }
    if (errors.length > 0) {
      this.safeSend(
        buildConfigUpdateResponse({
          replyTo: envelope,
          status: ConfigUpdateResponseStatus.FAILED,
          message: `Ungültige Werte: ${errors.join(', ')}`,
        }),
      );
      return;
    }
    const validated = safeParseConfig(next);
    if (!validated.success) {
      this.safeSend(
        buildConfigUpdateResponse({
          replyTo: envelope,
          status: ConfigUpdateResponseStatus.FAILED,
          message: 'Konfiguration ist nicht schemakonform.',
        }),
      );
      return;
    }
    try {
      await writeConfig(validated.data, { configPath: this.configPath() });
      this.config = validated.data;
      this.safeSend(
        buildConfigUpdateResponse({
          replyTo: envelope,
          status: ConfigUpdateResponseStatus.APPLIED,
          message:
            'Standort aktualisiert. Detaillierte Einstellungen findest du im Heat-Shield-Dashboard.',
        }),
      );
      // Readiness may have flipped; broadcast the new state so the
      // HCU's plugin card updates without waiting for the next poll.
      this.safeSend(
        buildPluginStateResponse({
          pluginId: PLUGIN_ID,
          status: this.computeReadiness(),
        }),
      );
    } catch (err) {
      this.safeSend(
        buildConfigUpdateResponse({
          replyTo: envelope,
          status: ConfigUpdateResponseStatus.FAILED,
          message:
            err instanceof Error
              ? `Speichern fehlgeschlagen: ${err.message}`
              : 'Speichern fehlgeschlagen.',
        }),
      );
    }
  }

  private announceReady(): void {
    this.safeSend(
      buildPluginStateResponse({
        pluginId: PLUGIN_ID,
        status: this.computeReadiness(),
      }),
    );
    void this.hmipSystem?.getSystemState().catch((err: unknown) => {
      this.logBuffer.append('warn', 'getSystemState failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  /**
   * Re-poll `getSystemState` to refresh the HCU source cache. Errors
   * are logged and swallowed so a stalled/failed round-trip never
   * aborts the control cycle — the engine then runs on the existing
   * (possibly slightly older) cache rather than not at all.
   */
  private async refreshSystemState(): Promise<void> {
    if (this.hmipSystem === null) return;
    try {
      await this.hmipSystem.getSystemState();
    } catch (err) {
      this.logBuffer.append('warn', 'cycle getSystemState refresh failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private safeSend(envelope: ConnectEnvelope): void {
    try {
      this.connect?.send(envelope);
    } catch (err) {
      this.logBuffer.append('warn', 'connect.send failed', {
        type: envelope.type,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // --- cycle ------------------------------------------------------------
  private runCycleNow(): void {
    void this.runCycleAsync().catch((err: unknown) => {
      this.logBuffer.append('error', 'cycle failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  private async runCycleAsync(): Promise<void> {
    if (this.stopping) return;
    // B3: reentrancy guard. The cycle timer is a fixed-interval `setInterval`;
    // if a cycle runs long (e.g. several sequential `setShutterLevel` awaits),
    // a second tick must not start a concurrent cycle and double-dispatch.
    if (this.cycleRunning) {
      this.logBuffer.append('info', 'cycle still running; skipping overlap', {});
      return;
    }
    this.cycleRunning = true;
    try {
      await this.runCycleInner();
    } finally {
      this.cycleRunning = false;
    }
  }

  private async runCycleInner(): Promise<void> {
    const now = new Date();
    // Keep the HCU source cache warm. getSystemState is only fetched
    // once at boot; afterwards the cache relies on HMIP_SYSTEM_EVENT
    // pushes. Slow-reporting sensors (wall thermostats report
    // actualTemperature infrequently) would otherwise exceed the
    // binding's staleAfterSec window (default 600 s) between pushes and
    // flip to `tempC: null`. Re-polling each cycle (period 180–300 s,
    // comfortably under 600 s) re-stamps every feature's observedAt and
    // keeps indoor temps (and every other native signal) resolving.
    // The request is bounded by HmipSystemAdapter's 5 s ceiling; on
    // failure we proceed with the existing cache rather than blocking.
    await this.refreshSystemState();
    // Run the irrigation controller (Bewässerung) — best-effort, never blocks
    // the shutter cycle. Manages the per-zone water balance + valve dispatch.
    await this.irrigation.runCycle().catch((err: unknown) => {
      this.logBuffer.append('warn', 'irrigation cycle failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    // Feed the rolling trend store BEFORE building the snapshot so the
    // slope used this cycle reflects the freshest sample (Task 5.3 / 6.1).
    await this.recordTrends(now);
    const snapshot = this.buildCycleSnapshot(now);
    // Self-learn the PV array azimuth from the power curve: fold this cycle's
    // (sun, PV) sample into the running accumulator. Best-effort persistence.
    await this.accumulatePvOrientationSample(now, snapshot.pvSmoothedKw);
    const out = await runCycle(snapshot, {
      config: this.config,
      forecastBaseline: this.forecastBaseline,
      comfortBiasByRoom: this.learnedBiasByRoom(),
      inertiaByRoom: this.calibratedInertiaByRoom(),
      ...(this.pvArrayAzimuthDeg !== null
        ? { pvArrayAzimuthDeg: this.pvArrayAzimuthDeg }
        : {}),
      hmipSystem: this.hmipSystem ?? {
        setShutterLevel: async (): Promise<void> => undefined,
      },
      appendHistoryRecord: (rec) =>
        appendRecord(rec, { historyPath: this.historyPath() }),
      logger: this.logBuffer.asLogger,
    });
    this.runtime.lastDecision = out.decisionRecord;
    this.runtime.lastMode = out.mode;
    this.runtime.lastModeExplanation = out.modeExplanation;
    this.runtime.state.currentMode = out.mode;
    this.runtime.state.lastCycleAt = out.decisionRecord.ts;
    if (out.newStormHoldUntil !== null) {
      this.runtime.state.stormHoldUntil = out.newStormHoldUntil.toISOString();
    }
    // Capture + persist the forecast plan for the dashboard (Task 11/12).
    await this.captureForecastPlan(now, out.plannerResult);
    // Shading-FSM transitions + ventilation contact changes → notifications
    // (Task 12.2). Runs after the decision so the persisted shade state and
    // the emitted messages reflect this cycle's inputs.
    await this.processShadingNotifications(now, snapshot);
    await this.maybeMorningBrief(now);
    await this.maybeForecastUpdate(now);
    await this.maybeDailySummary(now);
    await this.maybeAutoApplyLearning(now);
    await this.maybeHealthWatchdog(now, snapshot);
    await this.maybeAlerts(now, snapshot);
    await this.recordLearning(now, snapshot, out);
    try {
      await writeState(this.runtime.state, { statePath: this.statePath() });
    } catch (err) {
      this.logBuffer.append('warn', 'writeState failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    this.events.emit('event', {
      type: 'cycle.completed',
      payload: out.decisionRecord,
    } satisfies DashboardStreamEvent);
    // B2: invalidate the snapshot cache so the next poll/SSE rebuild reflects
    // this cycle's fresh decision/plan.
    this.cachedSnapshot = null;
  }

  /**
   * Store the latest forecast plan in-memory (for `/api/forecast` +
   * `/api/plan`), advance the deviation baseline, and persist a plan +
   * baseline + trajectory snapshot under `/data/` (best-effort: a
   * persistence failure never aborts the cycle). Emits SSE
   * `forecast.updated` / `plan.updated` so the SPA refreshes without
   * polling (predictive-control-dashboard Task 11/12).
   */
  private async captureForecastPlan(
    now: Date,
    plannerResult: PlannerResult | undefined,
  ): Promise<void> {
    if (plannerResult === undefined) {
      return;
    }
    this.lastPlannerResult = plannerResult;
    this.forecastBaseline = plannerResult.nextBaseline;

    const plan: PlanResponse = {
      ts: now.toISOString(),
      windows: Array.from(plannerResult.windows.values()).map((p) => ({
        windowId: p.windowId,
        target01: p.target01,
        noMoveNeeded: p.noMoveNeeded,
      })),
      plannedActions: [...plannerResult.plannedActions],
    };
    try {
      await writePlan(
        { ts: plan.ts, windows: plan.windows, plannedActions: plan.plannedActions },
        { dataDir: this.env.dataDir },
      );
      await writeBaseline(plannerResult.nextBaseline, { dataDir: this.env.dataDir });
      await appendTrajectorySnapshot(
        {
          ts: plan.ts,
          trajectories: Array.from(plannerResult.trajectories.entries()).map(
            ([roomId, traj]) => ({ roomId, points: traj.points }),
          ),
        },
        { dataDir: this.env.dataDir },
      );
    } catch (err) {
      this.logBuffer.append('warn', 'forecast persistence failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    this.events.emit('event', {
      type: 'forecast.updated',
      payload: { ts: plan.ts },
    } satisfies DashboardStreamEvent);
    this.events.emit('event', {
      type: 'plan.updated',
      payload: { ts: plan.ts },
    } satisfies DashboardStreamEvent);
  }

  /**
   * Resolve the trend signals for this cycle and push them into the rolling
   * {@link TrendStore}, then mirror them to `/data/trends.ndjson`. The store
   * is compacted to its window every 20 cycles to keep the file bounded.
   */
  private async recordTrends(now: Date): Promise<void> {
    const ctx: SourceContext = {
      hcu: this.cache,
      fusion: this.fusionSolar,
      openMeteo: this.openMeteo,
      now,
    };
    const num = (b: SignalBinding | undefined): number | null => {
      const r = resolveSignal(b, ctx);
      return r.ok ? r.value : null;
    };
    const gs = this.config.globalSignals;
    const samples: Array<{ key: string; value: number | null }> = [
      { key: 'outdoor', value: num(gs.outdoorTemp) },
      { key: 'outdoorFront', value: num(gs.frontOutdoorTemp) },
      { key: 'outdoorBack', value: num(gs.backOutdoorTemp) },
      { key: 'pv', value: this.resolvePvKw(now) },
    ];
    for (const room of this.config.rooms) {
      samples.push({
        key: `room:${room.id}`,
        value: num(room.signals.indoorTemp),
      });
    }
    this.trendStore.record(now, samples);

    const toAppend = samples
      .filter((s) => s.value !== null && Number.isFinite(s.value))
      .map((s) => ({
        ts: now.toISOString(),
        key: s.key,
        value: s.value as number,
      }));
    try {
      await appendSamples(toAppend, { trendsPath: this.trendsPath() });
      this.trendCyclesSinceCompact += 1;
      if (this.trendCyclesSinceCompact >= 20) {
        this.trendCyclesSinceCompact = 0;
        await compactTrends(this.trendStore.export(), {
          trendsPath: this.trendsPath(),
        });
      }
    } catch (err) {
      this.logBuffer.append('warn', 'trend persistence failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** PV power in kW from the explicit binding (W→kW) or the FusionSolar poll. */
  private resolvePvKw(now: Date): number | null {
    const ctx: SourceContext = { hcu: this.cache, fusion: this.fusionSolar, openMeteo: this.openMeteo, now };
    const r = resolveSignal(this.config.globalSignals.pvPower, ctx);
    if (r.ok) {
      return r.value / 1000;
    }
    // Fallback: FusionSolar `inputPower` — the PV DC string input, i.e. the
    // power the panels are generating from sunlight. This is the true solar
    // irradiance proxy. (NOT `activePower`, which is the inverter AC output
    // and is skewed by house load and battery charge/discharge.)
    const pv = this.fusionSolar.getValue('inputPower');
    return pv ? pv.value / 1000 : null;
  }

  /**
   * Warmest available outdoor temperature across the API sensor and the
   * optional front (NE) / back (SW) local sensors (Requirement 5.1). Returns
   * `null` only when none are available.
   */
  private effectiveOutdoorC(now: Date): number | null {
    const ctx: SourceContext = { hcu: this.cache, fusion: this.fusionSolar, openMeteo: this.openMeteo, now };
    const gs = this.config.globalSignals;
    const candidates: number[] = [];
    for (const b of [gs.outdoorTemp, gs.frontOutdoorTemp, gs.backOutdoorTemp]) {
      const r = resolveSignal(b, ctx);
      if (r.ok) {
        candidates.push(r.value);
      }
    }
    if (candidates.length === 0) {
      return null;
    }
    return Math.max(...candidates);
  }

  /**
   * Mean outdoor temperature across the front (NO) and back (SW) sensors,
   * falling back to the generic outdoor binding, then the OpenMeteo internet
   * value. Used as the engine/dashboard outdoor reading (user request: "der
   * Mittelwert aus vorne und hinten").
   */
  private outdoorMeanC(now: Date): number | null {
    const ctx: SourceContext = { hcu: this.cache, fusion: this.fusionSolar, openMeteo: this.openMeteo, now };
    const gs = this.config.globalSignals;
    const vals: number[] = [];
    for (const b of [gs.frontOutdoorTemp, gs.backOutdoorTemp]) {
      const r = resolveSignal(b, ctx);
      if (r.ok) {
        vals.push(r.value);
      }
    }
    if (vals.length > 0) {
      return vals.reduce((a, b) => a + b, 0) / vals.length;
    }
    const single = resolveSignal(gs.outdoorTemp, ctx);
    if (single.ok) {
      return single.value;
    }
    const om = this.openMeteo.getValue('temperature');
    return om !== null && Number.isFinite(om.value) ? om.value : null;
  }

  /** Current OpenMeteo internet outdoor temperature, or null. */
  private outdoorInternetC(): number | null {
    const om = this.openMeteo.getValue('temperature');
    return om !== null && Number.isFinite(om.value) ? om.value : null;
  }

  /**
   * Forecast daily-max temperature for **today** from the OpenMeteo daily
   * summary. This is the value the mode FSM (SUMMER_WATCH / ACTIVE / HEATWAVE)
   * and the dashboard "Forecast" readout use — today's peak, not tomorrow's.
   * Returns null when no daily data is available yet (callers fall back to the
   * configured binding).
   */
  private forecastDailyMaxC(now: Date): number | null {
    const daily = this.openMeteo.getDailySummary();
    if (daily.length === 0) {
      return null;
    }
    const todayKey = now.toISOString().slice(0, 10);
    const today =
      daily.find((d) => d.date === todayKey) ??
      daily.find((d) => d.date >= todayKey) ??
      daily[0];
    return today !== undefined && today.tempMaxC !== null && Number.isFinite(today.tempMaxC)
      ? today.tempMaxC
      : null;
  }

  /** Compute the PV-led effective heat load for the current cycle. */
  private computeHeatLoad(now: Date): HeatLoadResult {
    const hl = this.config.rules.heatLoad;
    return effectiveHeatLoad01({
      pvKw: this.resolvePvKw(now),
      pvPeakKwp: this.config.fusionSolar.pvPeakKwp,
      outdoorTempC: this.effectiveOutdoorC(now),
      outdoorTrendCph: this.trendStore.slopePerHour('outdoor'),
      weights: {
        pv: hl.pvWeight,
        temp: hl.tempWeight,
        trend: hl.trendWeight,
      },
    });
  }

  /**
   * Advance the per-window shading FSM, persist the new shade runtime, detect
   * contact open/close transitions, and route the resulting transitions to
   * the notification service. Emits a `message.created` SSE event per created
   * message so the dashboard bell updates immediately.
   */
  private async processShadingNotifications(
    now: Date,
    snapshot: CycleSnapshot,
  ): Promise<void> {
    const hl = this.config.rules.heatLoad;
    const heatLoad = this.computeHeatLoad(now);
    const sunPos = getSunPosition(now, this.config.location);
    const events: ShadingEvent[] = [];

    for (const win of snapshot.windows) {
      const cfg = win.config;
      const rs = this.runtime.state.windows.find((r) => r.windowId === cfg.id);
      const prev: WindowShadeRuntime = rs?.shade ?? initialShadeRuntime();

      const hasDirectSun =
        sunOnWindow(sunPos, cfg, this.config.rules.sun) ||
        sunOnWindowSoon(now, this.config.location, cfg, this.config.rules.sun);
      const next = nextShadeState({
        prev,
        now,
        load01: heatLoad.load01,
        hasDirectSun,
        activateThreshold: hl.activateThreshold,
        releaseThreshold: hl.releaseThreshold,
        releaseHoldMinutes: hl.releaseHoldMinutes,
      });
      if (rs !== undefined) {
        rs.shade = next;
      }
      const label = this.windowLabel(cfg.id);
      if (prev.state !== next.state) {
        events.push({
          kind: next.state === 'shaded' ? 'shade.activated' : 'shade.released',
          windowId: cfg.id,
          ...(label !== undefined ? { label } : {}),
        });
      }

      const lastContact = this.lastContactByWindow.get(cfg.id);
      if (lastContact !== win.contactState) {
        if (win.contactState === 'open') {
          events.push({
            kind: 'window.opened',
            windowId: cfg.id,
            ...(label !== undefined ? { label } : {}),
          });
        } else if (
          win.contactState === 'closed' &&
          (lastContact === 'open' || lastContact === 'tilted')
        ) {
          events.push({
            kind: 'window.closed',
            windowId: cfg.id,
            ...(label !== undefined ? { label } : {}),
          });
        }
        this.lastContactByWindow.set(cfg.id, win.contactState);
      }
    }

    if (events.length === 0) {
      return;
    }
    try {
      const created = await this.notifications.process(events);
      for (const msg of created) {
        this.events.emit('event', {
          type: 'message.created',
          payload: { id: msg.id },
        } satisfies DashboardStreamEvent);
      }
    } catch (err) {
      this.logBuffer.append('warn', 'notification processing failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Human label for a window: "<Raum> – <Gerät> (…1234)". */
  private windowLabel(windowId: string): string | undefined {
    const win = this.config.windows.find((w) => w.id === windowId);
    if (win === undefined) {
      return undefined;
    }
    const room = this.config.rooms.find((r) => r.id === win.roomId);
    const tail = `…${win.shutterDeviceId.slice(-4)}`;
    const device = this.cache.getDevice(win.shutterDeviceId);
    const deviceName =
      device?.friendlyName !== undefined && device.friendlyName.length > 0
        ? device.friendlyName
        : 'Rollladen';
    const roomName = room?.name ?? 'Ohne Raum';
    return `${roomName} – ${deviceName} (${tail})`;
  }

  /** Send the daily morning weather brief once per local day (Task 9). */
  private async maybeMorningBrief(now: Date): Promise<void> {
    try {
      await this.morningBrief.maybeSend(this.notifications, () => {
        const body = this.buildForecastText(now);
        return body === null ? null : { title: this.nt('Wetter heute', 'Weather today'), body };
      });
    } catch (err) {
      this.logBuffer.append('warn', 'morning brief failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Periodic forecast/status push (Telegram + in-app) every
   * `notifications.forecastUpdates.everyHours`, when enabled. Quietly skips
   * outside the interval. Kept in-memory (resets on restart, which is fine —
   * the first push lands one interval after boot).
   */
  private async maybeForecastUpdate(now: Date): Promise<void> {
    const fc = this.config.notifications.forecastUpdates;
    if (!fc.enabled) {
      return;
    }
    const elapsedMs = now.getTime() - this.lastForecastPushMs;
    if (elapsedMs < fc.everyHours * 3_600_000) {
      return;
    }
    const body = this.buildForecastText(now);
    if (body === null) {
      return;
    }
    this.lastForecastPushMs = now.getTime();
    try {
      const msg = await this.notifications.emit(
        'weather',
        this.nt('Wetter-Update', 'Weather update'),
        body,
        'weather',
      );
      this.events.emit('event', {
        type: 'message.created',
        payload: { id: msg.id },
      } satisfies DashboardStreamEvent);
    } catch (err) {
      this.logBuffer.append('warn', 'forecast update failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Daily summary (evening recap) — sent once per local day at
   * `notifications.dailySummaryLocalTime` when `dailySummaryEnabled`.
   * Reuses the {@link MorningBriefScheduler} for timing + idempotency.
   */
  private async maybeDailySummary(now: Date): Promise<void> {
    if (!this.config.notifications.dailySummaryEnabled) {
      return;
    }
    try {
      const sent = await this.dailySummary.maybeSend(this.notifications, () => {
        const body = this.buildDailySummaryText(now);
        return body === null ? null : { title: this.nt('Tagesrückblick', 'Daily summary'), body };
      });
      if (sent) {
        this.events.emit('event', {
          type: 'message.created',
          payload: { id: 'daily-summary' },
        } satisfies DashboardStreamEvent);
      }
    } catch (err) {
      this.logBuffer.append('warn', 'daily summary failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Notification-language helper: pick the German or English variant based on
   * `config.notifications.language` (default German). Used for all server-side
   * notification/Telegram text so the installation-wide setting takes effect.
   */
  private nt(de: string, en: string): string {
    return this.config.notifications.language === 'en' ? en : de;
  }

  /** Localized FSM mode label for notification text. */
  private modeLabelNt(mode: string): string {
    return this.config.notifications.language === 'en'
      ? (MODE_LABELS_EN[mode] ?? mode)
      : (MODE_LABELS_DE[mode] ?? mode);
  }

  /** Build the evening daily-summary body, or null when no data is available. */
  private buildDailySummaryText(now: Date): string | null {
    const mode = this.runtime.lastMode ?? 'NORMAL';
    const hl = this.computeHeatLoad(now);
    const dec = this.runtime.lastDecision;
    const shaded =
      dec?.windowDecisions.filter((d) => d.finalTarget >= 0.5).length ?? 0;
    const total = this.config.windows.length;
    const parts: string[] = [
      this.nt(`Modus: ${this.modeLabelNt(mode)}.`, `Mode: ${this.modeLabelNt(mode)}.`),
      this.nt(
        `Gefühlte Wärme: ${Math.round(hl.load01 * 100)} %` +
          (hl.feelsLikeC !== null ? ` (≈ ${Math.round(hl.feelsLikeC)} °C).` : '.'),
        `Perceived heat: ${Math.round(hl.load01 * 100)} %` +
          (hl.feelsLikeC !== null ? ` (≈ ${Math.round(hl.feelsLikeC)} °C).` : '.'),
      ),
    ];
    if (total > 0) {
      parts.push(
        this.nt(
          `${shaded}/${total} Fenster aktuell verschattet.`,
          `${shaded}/${total} windows currently shaded.`,
        ),
      );
    }
    const outdoor = this.effectiveOutdoorC(now);
    if (outdoor !== null) {
      parts.push(this.nt(`Aktuell ${Math.round(outdoor)} °C draußen.`, `Currently ${Math.round(outdoor)} °C outside.`));
    }
    // Automatic moves accumulated today (per-room learning accumulator).
    let movesToday = 0;
    for (const acc of this.learnAccum.values()) {
      movesToday += acc.moves;
    }
    parts.push(
      this.nt(
        `${movesToday} automatische Rollladenfahrt(en) heute.`,
        `${movesToday} automatic shutter move(s) today.`,
      ),
    );
    // Indoor peak today.
    const peak = this.runtime.state.indoorPeak;
    if (peak !== null && Number.isFinite(peak.peakC)) {
      parts.push(
        this.nt(
          `Innen-Tagespeak ${Math.round(peak.peakC * 10) / 10} °C.`,
          `Indoor daily peak ${Math.round(peak.peakC * 10) / 10} °C.`,
        ),
      );
    }
    // Self-learning + calibration adjustments currently in effect.
    const tuned = Array.from(this.learnedModels.values()).filter(
      (m) => m.comfortBiasC !== 0,
    ).length;
    const calibrated = Array.from(this.calibratedModels.values()).filter(
      (m) => m.factor !== 1,
    ).length;
    if (tuned > 0 || calibrated > 0) {
      parts.push(
        this.nt(
          `Gelernt: ${tuned} Komfort- und ${calibrated} Trägheits-Anpassung(en) aktiv.`,
          `Learned: ${tuned} comfort and ${calibrated} inertia adjustment(s) active.`,
        ),
      );
    }
    return parts.join(' ');
  }

  /**
   * Auto-apply learning recommendations when `learning.autoApply` is on.
   * Throttled to ~once every 6 h so a continuously-running plugin does not
   * thrash the config. Only recommendations that carry a `suggestedConfigPatch`
   * are applied; informational notes are skipped.
   */
  private async maybeAutoApplyLearning(now: Date): Promise<void> {
    if (!this.config.learning.autoApply) {
      return;
    }
    const SIX_HOURS_MS = 6 * 3_600_000;
    if (now.getTime() - this.lastLearningApplyMs < SIX_HOURS_MS) {
      return;
    }
    this.lastLearningApplyMs = now.getTime();
    try {
      const snap = await this.buildLearningSnapshot();
      const actionable = snap.recommendations.filter(
        (r) => r.suggestedConfigPatch !== undefined,
      );
      let applied = 0;
      for (const rec of actionable) {
        const res = await this.applyRecommendation(rec.id);
        if (res.ok) {
          applied += 1;
        }
      }
      if (applied > 0) {
        this.rebuildNotifications();
        const msg = await this.notifications.emit(
          'weather',
          this.nt('Lernen: Einstellungen angepasst', 'Learning: settings adjusted'),
          this.nt(
            `${applied} Empfehlung(en) automatisch übernommen.`,
            `${applied} recommendation(s) applied automatically.`,
          ),
          'weather',
        );
        this.events.emit('event', {
          type: 'message.created',
          payload: { id: msg.id },
        } satisfies DashboardStreamEvent);
      }
    } catch (err) {
      this.logBuffer.append('warn', 'learning auto-apply failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Health watchdog: when a window was commanded to a level more than 5 min
   * ago but the cached shutter level still differs from the commanded target
   * by more than 15 %, emit a one-shot notification (the motor may be stuck,
   * the device offline, or mechanically blocked). The alert clears once the
   * window reaches its target again.
   */
  private async maybeHealthWatchdog(
    now: Date,
    snapshot: CycleSnapshot,
  ): Promise<void> {
    const FIVE_MIN_MS = 5 * 60_000;
    const TOLERANCE = 0.15;
    const offending: string[] = [];
    for (const win of snapshot.windows) {
      const cfg = win.config;
      const rs = this.runtime.state.windows.find((r) => r.windowId === cfg.id);
      const commanded = rs?.lastCommandedLevel01 ?? null;
      const commandedAt = rs?.lastCommandedAt ?? null;
      if (commanded === null || commandedAt === null) {
        continue;
      }
      if (now.getTime() - new Date(commandedAt).getTime() < FIVE_MIN_MS) {
        continue;
      }
      const lvl = this.cache.getFeature(cfg.shutterDeviceId, 'shutterLevel');
      const cur =
        lvl !== undefined && typeof lvl.value === 'number' ? lvl.value : null;
      if (cur === null) {
        continue;
      }
      const off = Math.abs(cur - commanded) > TOLERANCE;
      if (off && !this.healthAlerted.has(cfg.id)) {
        this.healthAlerted.add(cfg.id);
        const label = this.windowLabel(cfg.id) ?? cfg.id;
        offending.push(
          this.nt(
            `${label} (Soll ${Math.round(commanded * 100)} %, aktuell ${Math.round(cur * 100)} %)`,
            `${label} (target ${Math.round(commanded * 100)} %, current ${Math.round(cur * 100)} %)`,
          ),
        );
      } else if (!off && this.healthAlerted.has(cfg.id)) {
        this.healthAlerted.delete(cfg.id);
      }
    }
    // One grouped alert for all newly-stuck shutters this cycle.
    if (offending.length === 0) {
      return;
    }
    const body =
      offending.length === 1
        ? this.nt(
            `${offending[0]} reagiert nicht. Bitte prüfen (Motor blockiert oder Gerät offline?).`,
            `${offending[0]} is not responding. Please check (motor blocked or device offline?).`,
          )
        : this.nt(
            `${offending.length} Rollläden reagieren nicht: ${offending.join('; ')}. ` +
              'Bitte prüfen (Motor blockiert oder Gerät offline?).',
            `${offending.length} shutters are not responding: ${offending.join('; ')}. ` +
              'Please check (motor blocked or device offline?).',
          );
    try {
      const msg = await this.notifications.emit(
        'close',
        this.nt('Rollladen reagiert nicht', 'Shutter not responding'),
        body,
        'close',
      );
      this.events.emit('event', {
        type: 'message.created',
        payload: { id: msg.id },
      } satisfies DashboardStreamEvent);
    } catch (err) {
      this.logBuffer.append('warn', 'health watchdog notify failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Push Telegram/in-app alerts for safety-relevant conditions: storm,
   * extreme indoor or outdoor heat, and a high UV index. Deduplicated per
   * local day (storm once per episode) so the cycle does not spam. All gated
   * by the `weather` notification toggle.
   */
  private async maybeAlerts(now: Date, snapshot: CycleSnapshot): Promise<void> {
    const dayKey = now.toLocaleDateString('de-DE', { timeZone: this.config.location.timezone });
    if (dayKey !== this.alertsDay) {
      this.alertsDay = dayKey;
      this.alertsSentToday.clear();
    }
    const emit = async (title: string, body: string): Promise<void> => {
      try {
        const msg = await this.notifications.emit('weather', title, body, 'weather');
        this.events.emit('event', {
          type: 'message.created',
          payload: { id: msg.id },
        } satisfies DashboardStreamEvent);
      } catch (err) {
        this.logBuffer.append('warn', 'alert notify failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };
    const once = async (key: string, title: string, body: string): Promise<void> => {
      if (this.alertsSentToday.has(key)) {
        return;
      }
      this.alertsSentToday.add(key);
      await emit(title, body);
    };

    // Storm — once per episode (reset when the mode leaves STORM).
    if (this.runtime.lastMode === 'STORM') {
      if (!this.stormAlerted) {
        this.stormAlerted = true;
        await emit(
          this.nt('🌩 Sturmwarnung', '🌩 Storm warning'),
          this.nt(
            'Sturmschutz aktiv – außenliegende Rollläden werden zum Schutz aufgefahren.',
            'Storm protection active – exterior shutters are being raised for protection.',
          ),
        );
      }
    } else {
      this.stormAlerted = false;
    }

    // Indoor extreme — warmest room at/above its critical ceiling.
    let warmestC: number | null = null;
    let warmestCritC = 27;
    let warmestId = '';
    for (const [id, r] of snapshot.rooms) {
      if (r.tempC !== null && (warmestC === null || r.tempC > warmestC)) {
        warmestC = r.tempC;
        warmestCritC = r.targets.critical_c;
        warmestId = id;
      }
    }
    if (warmestC !== null && warmestC >= warmestCritC) {
      const name = this.config.rooms.find((r) => r.id === warmestId)?.name ?? warmestId;
      await once(
        'indoor-extreme',
        this.nt('🔥 Innenraum sehr heiß', '🔥 Indoor very hot'),
        this.nt(
          `${name} bei ${Math.round(warmestC * 10) / 10} °C (kritisch ab ${warmestCritC} °C). Beschattung läuft auf Maximum.`,
          `${name} at ${Math.round(warmestC * 10) / 10} °C (critical from ${warmestCritC} °C). Shading is at maximum.`,
        ),
      );
    }

    // Outdoor extreme.
    const outdoor = this.outdoorMeanC(now);
    if (outdoor !== null && outdoor >= 35) {
      await once(
        'outdoor-extreme',
        this.nt('🌡 Extreme Außenhitze', '🌡 Extreme outdoor heat'),
        this.nt(
          `Außen ${Math.round(outdoor * 10) / 10} °C. Fenster und Rollläden tagsüber geschlossen halten.`,
          `Outdoor ${Math.round(outdoor * 10) / 10} °C. Keep windows and shutters closed during the day.`,
        ),
      );
    }

    // High UV index.
    const uv = this.currentOpenMeteoEnv(now).uvIndex;
    if (uv !== null && uv >= 8) {
      await once(
        'uv-high',
        this.nt('☀️ Hoher UV-Index', '☀️ High UV index'),
        this.nt(
          `UV-Index ${Math.round(uv * 10) / 10}. Direkte Sonne meiden; die Beschattung schützt Räume und Möbel.`,
          `UV index ${Math.round(uv * 10) / 10}. Avoid direct sun; shading protects rooms and furniture.`,
        ),
      );
    }

    // Severe weather (thunderstorm / heavy precip / snow) expected within ~6 h.
    const series = this.openMeteo.getForecastSeries();
    if (series.length > 0) {
      const fromMs = now.getTime();
      const toMs = fromMs + 6 * 3_600_000;
      let worst: number | null = null;
      for (const p of series) {
        const t = Date.parse(p.ts);
        if (Number.isNaN(t) || t < fromMs || t > toMs) continue;
        const code = p.weatherCode;
        if (typeof code === 'number' && isSevereWeatherCode(code)) {
          worst = worst === null ? code : Math.max(worst, code);
        }
      }
      if (worst !== null) {
        await once(
          'severe-weather',
          this.nt('⛈ Unwetter erwartet', '⛈ Severe weather expected'),
          this.nt(
            `Der Wetterdienst meldet ${weatherCodeLabel(worst)} in den nächsten Stunden. Bei Sturm fahren die Rollläden automatisch zum Schutz auf.`,
            `The weather service reports ${weatherCodeLabel(worst)} in the next few hours. In a storm the shutters automatically raise for protection.`,
          ),
        );
      }
    }
  }

  /** Build the forecast/brief body text, or null when no data is available. */
  private buildForecastText(now: Date): string | null {
    const ctx: SourceContext = { hcu: this.cache, fusion: this.fusionSolar, openMeteo: this.openMeteo, now };
    const fc = resolveSignal(this.config.globalSignals.forecastMaxTemp, ctx);
    const outdoor = this.effectiveOutdoorC(now);
    if (!fc.ok && outdoor === null) {
      return null;
    }
    const parts: string[] = [];
    if (fc.ok) {
      parts.push(this.nt(`Heute bis ${Math.round(fc.value)} °C erwartet.`, `Up to ${Math.round(fc.value)} °C expected today.`));
    }
    if (outdoor !== null) {
      parts.push(this.nt(`Aktuell ${Math.round(outdoor)} °C draußen.`, `Currently ${Math.round(outdoor)} °C outside.`));
    }
    const pvKw = this.resolvePvKw(now);
    if (pvKw !== null) {
      parts.push(this.nt(`PV-Leistung ${pvKw.toFixed(1)} kW.`, `PV power ${pvKw.toFixed(1)} kW.`));
    }
    parts.push(this.nt('Tipp: morgens lüften, solange es kühl ist.', 'Tip: air in the morning while it is still cool.'));
    return parts.join(' ');
  }

  // --- Telegram bot command context ------------------------------------
  private buildTelegramCommandContext(): TelegramCommandContext {
    const pct = (v: number | null): string =>
      v === null ? '–' : `${Math.round(v * 100)}%`;
    return {
      statusText: (): string => {
        const now = new Date();
        const mode = this.runtime.lastMode ?? 'NORMAL';
        const hl = this.computeHeatLoad(now);
        const lines: string[] = [
          this.nt(`🛡 Modus: ${this.modeLabelNt(mode)}`, `🛡 Mode: ${this.modeLabelNt(mode)}`),
          this.nt(
            `Gefühlte Wärme: ${Math.round(hl.load01 * 100)} %` +
              (hl.feelsLikeC !== null ? ` (≈ ${Math.round(hl.feelsLikeC)} °C)` : ''),
            `Perceived heat: ${Math.round(hl.load01 * 100)} %` +
              (hl.feelsLikeC !== null ? ` (≈ ${Math.round(hl.feelsLikeC)} °C)` : ''),
          ),
        ];
        const dec = this.runtime.lastDecision;
        for (const w of this.config.windows) {
          const lvl = this.cache.getFeature(w.shutterDeviceId, 'shutterLevel');
          const cur = lvl !== undefined && typeof lvl.value === 'number' ? lvl.value : null;
          const target =
            dec?.windowDecisions.find((d) => d.windowId === w.id)?.finalTarget ?? null;
          lines.push(
            this.nt(
              `• ${this.windowLabel(w.id) ?? w.id}: aktuell ${pct(cur)} → Ziel ${pct(target)}`,
              `• ${this.windowLabel(w.id) ?? w.id}: current ${pct(cur)} → target ${pct(target)}`,
            ),
          );
        }
        if (this.config.windows.length === 0) {
          lines.push(this.nt('(keine Fenster konfiguriert)', '(no windows configured)'));
        }
        return lines.join('\n');
      },
      forecastText: (): string =>
        this.buildForecastText(new Date()) ??
        this.nt('Keine Wetterdaten verfügbar.', 'No weather data available.'),
      roomsText: (): string => {
        const now = new Date();
        const ctx: SourceContext = { hcu: this.cache, fusion: this.fusionSolar, openMeteo: this.openMeteo, now };
        if (this.config.rooms.length === 0) {
          return this.nt('Keine Räume konfiguriert.', 'No rooms configured.');
        }
        const lines = [this.nt('🌡 Räume:', '🌡 Rooms:')];
        for (const r of this.config.rooms) {
          const res = resolveSignal(r.signals.indoorTemp, ctx);
          lines.push(
            `• ${r.name}: ${res.ok ? `${res.value.toFixed(1)} °C` : this.nt('– (kein Sensor)', '– (no sensor)')}`,
          );
        }
        return lines.join('\n');
      },
      pause: (minutes): string => {
        const now = new Date();
        const until =
          minutes === null
            ? this.nextLocalMidnight(now)
            : new Date(now.getTime() + minutes * 60_000);
        this.runtime.state.userIntent = {
          ...this.runtime.state.userIntent,
          paused: true,
          pauseUntil: until.toISOString(),
        };
        this.persistAndReevaluate();
        return minutes === null
          ? this.nt('Automatik pausiert bis Mitternacht. ⏸', 'Automation paused until midnight. ⏸')
          : this.nt(`Automatik für ${minutes} min pausiert. ⏸`, `Automation paused for ${minutes} min. ⏸`);
      },
      resume: (): string => {
        this.runtime.state.userIntent = {
          ...this.runtime.state.userIntent,
          paused: false,
          pauseUntil: null,
        };
        this.persistAndReevaluate();
        return this.nt('Automatik wieder aktiv. ▶', 'Automation active again. ▶');
      },
      setVacation: (on): string => {
        this.runtime.state.userIntent = {
          ...this.runtime.state.userIntent,
          vacation: on,
        };
        this.persistAndReevaluate();
        return on
          ? this.nt('Urlaubsmodus an. ✈', 'Vacation mode on. ✈')
          : this.nt('Urlaubsmodus aus.', 'Vacation mode off.');
      },
      setAutomation: (on): string => {
        void this.applyConfigChange((c) => {
          c.automationEnabled = on;
        });
        return on
          ? this.nt('Master-Automatik an. ✅', 'Master automation on. ✅')
          : this.nt(
              'Master-Automatik aus (Positionen werden gehalten).',
              'Master automation off (positions are held).',
            );
      },
      setParam: (key, value): string => this.applySetParam(key, value),
    };
  }

  /** Next local midnight as a Date (for pause-until). */
  private nextLocalMidnight(now: Date): Date {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: this.config.location.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
    const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '00';
    const todayLocal = new Date(`${get('year')}-${get('month')}-${get('day')}T00:00:00`);
    return new Date(todayLocal.getTime() + 24 * 3_600_000);
  }

  /** Persist runtime state and trigger a re-evaluation cycle. */
  private persistAndReevaluate(): void {
    void writeState(this.runtime.state, { statePath: this.statePath() }).catch(
      () => undefined,
    );
    this.runCycleNow();
  }

  /** Apply a mutation to the config, validate, persist, and rebuild notifs. */
  private applyConfigChange(mutate: (c: Config) => void): boolean {
    const next = structuredClone(this.config) as Config;
    mutate(next);
    const validated = safeParseConfig(next);
    if (!validated.success) {
      return false;
    }
    this.config = validated.data;
    void writeConfig(validated.data, { configPath: this.configPath() }).catch(
      () => undefined,
    );
    this.rebuildNotifications();
    return true;
  }

  /** Map a /set key+value onto a config change. Returns a localized reply. */
  private applySetParam(key: string, value: string): string {
    const keys =
      'morgenzeit HH:MM · aktivierung 0–1 · deaktivierung 0–1 · haltezeit <min> · ' +
      'pvgewicht 0–1 · pvmax <kWp> · forecast an|aus · forecaststunden 1–24';
    if (key === 'hilfe' || key === 'help' || key === '') {
      return this.nt(`Verfügbare Einstellungen:\n${keys}`, `Available settings:\n${keys}`);
    }
    const num = Number.parseFloat(value.replace(',', '.'));
    const lower = value.trim().toLowerCase();
    const onoff = ['an', 'on', 'ein', '1', 'true', 'ja'].includes(lower)
      ? true
      : ['aus', 'off', '0', 'false', 'nein'].includes(lower)
        ? false
        : null;
    let ok = false;
    let label = '';
    switch (key) {
      case 'morgenzeit':
        if (!/^([01]\d|2[0-3]):[0-5]\d$/u.test(value.trim())) {
          return this.nt(
            'Bitte Uhrzeit als HH:MM angeben, z. B. /set morgenzeit 07:30.',
            'Please provide the time as HH:MM, e.g. /set morgenzeit 07:30.',
          );
        }
        ok = this.applyConfigChange((c) => {
          c.notifications.morningBriefLocalTime = value.trim();
        });
        label = this.nt(
          `Morgen-Briefing-Zeit = ${value.trim()}`,
          `Morning brief time = ${value.trim()}`,
        );
        break;
      case 'aktivierung':
        if (!Number.isFinite(num) || num < 0 || num > 1)
          return this.nt('Wert 0–1 angeben.', 'Provide a value 0–1.');
        ok = this.applyConfigChange((c) => {
          c.rules.heatLoad.activateThreshold = num;
        });
        label = this.nt(`Aktivierungsschwelle = ${num}`, `Activation threshold = ${num}`);
        break;
      case 'deaktivierung':
        if (!Number.isFinite(num) || num < 0 || num > 1)
          return this.nt('Wert 0–1 angeben.', 'Provide a value 0–1.');
        ok = this.applyConfigChange((c) => {
          c.rules.heatLoad.releaseThreshold = num;
        });
        label = this.nt(`Deaktivierungsschwelle = ${num}`, `Release threshold = ${num}`);
        break;
      case 'haltezeit':
        if (!Number.isFinite(num) || num < 0)
          return this.nt('Minuten ≥ 0 angeben.', 'Provide minutes ≥ 0.');
        ok = this.applyConfigChange((c) => {
          c.rules.heatLoad.releaseHoldMinutes = Math.round(num);
        });
        label = this.nt(
          `Mindesthaltezeit = ${Math.round(num)} min`,
          `Minimum hold time = ${Math.round(num)} min`,
        );
        break;
      case 'pvgewicht':
        if (!Number.isFinite(num) || num < 0)
          return this.nt('Wert ≥ 0 angeben.', 'Provide a value ≥ 0.');
        ok = this.applyConfigChange((c) => {
          c.rules.heatLoad.pvWeight = num;
        });
        label = this.nt(`PV-Gewicht = ${num}`, `PV weight = ${num}`);
        break;
      case 'pvmax':
        if (!Number.isFinite(num) || num <= 0)
          return this.nt('Wert > 0 (kWp) angeben.', 'Provide a value > 0 (kWp).');
        ok = this.applyConfigChange((c) => {
          c.fusionSolar.pvPeakKwp = num;
        });
        label = this.nt(
          `PV-Spitzenleistung (volle Sonne) = ${num} kWp`,
          `PV peak power (full sun) = ${num} kWp`,
        );
        break;
      case 'forecast':
        if (onoff === null) return this.nt('Bitte „an" oder „aus" angeben.', 'Please provide "an" or "aus".');
        ok = this.applyConfigChange((c) => {
          c.notifications.forecastUpdates.enabled = onoff;
        });
        label = this.nt(
          `Forecast-Updates = ${onoff ? 'an' : 'aus'}`,
          `Forecast updates = ${onoff ? 'on' : 'off'}`,
        );
        break;
      case 'forecaststunden':
        if (!Number.isFinite(num) || num < 1 || num > 24)
          return this.nt('Wert 1–24 angeben.', 'Provide a value 1–24.');
        ok = this.applyConfigChange((c) => {
          c.notifications.forecastUpdates.everyHours = Math.round(num);
        });
        label = this.nt(
          `Forecast-Intervall = ${Math.round(num)} h`,
          `Forecast interval = ${Math.round(num)} h`,
        );
        break;
      default:
        return this.nt(
          `Unbekannte Einstellung „${key}".\nVerfügbar:\n${keys}`,
          `Unknown setting "${key}".\nAvailable:\n${keys}`,
        );
    }
    return ok
      ? `✅ ${label}`
      : this.nt(
          'Konnte die Einstellung nicht speichern (ungültiger Wert).',
          'Could not save the setting (invalid value).',
        );
  }

  private telegramOffsetPath(): string {
    return path.join(this.env.dataDir, 'telegram-offset.json');
  }

  /** Candidate filenames for a user-uploaded house background under /data. */
  private houseImageCandidates(): Array<{ file: string; contentType: string }> {
    return [
      { file: 'house-custom.png', contentType: 'image/png' },
      { file: 'house-custom.jpg', contentType: 'image/jpeg' },
      { file: 'house-custom.webp', contentType: 'image/webp' },
    ].map((c) => ({ file: path.join(this.env.dataDir, c.file), contentType: c.contentType }));
  }

  /** Read the uploaded house background, or null when none was uploaded. */
  private readHouseImage(): { contentType: string; bytes: Buffer } | null {
    for (const c of this.houseImageCandidates()) {
      if (existsSync(c.file)) {
        try {
          return { contentType: c.contentType, bytes: readFileSync(c.file) };
        } catch {
          return null;
        }
      }
    }
    return null;
  }

  /** Persist an uploaded house background from a `data:` URL under /data. */
  private async saveHouseImage(dataUrl: string): Promise<void> {
    const match = /^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/s.exec(dataUrl);
    if (match === null) {
      throw new Error('Unsupported data URL (expect PNG/JPEG/WebP base64).');
    }
    const ext = match[1] === 'jpeg' ? 'jpg' : (match[1] as string);
    const bytes = Buffer.from(match[2] as string, 'base64');
    // Drop any previous upload (in any format) so only one custom image wins.
    for (const c of this.houseImageCandidates()) {
      try {
        await fs.rm(c.file, { force: true });
      } catch {
        // best-effort cleanup
      }
    }
    await fs.writeFile(path.join(this.env.dataDir, `house-custom.${ext}`), bytes);
    this.logBuffer.append('info', 'house background image updated', { bytes: bytes.length });
  }

  private async loadTelegramOffset(): Promise<number> {
    try {
      const raw = await fs.readFile(this.telegramOffsetPath(), 'utf8');
      const parsed = JSON.parse(raw) as { offset?: number };
      return typeof parsed.offset === 'number' ? parsed.offset : 0;
    } catch {
      return 0;
    }
  }

  private async saveTelegramOffset(offset: number): Promise<void> {
    try {
      await fs.writeFile(
        this.telegramOffsetPath(),
        `${JSON.stringify({ offset })}\n`,
        'utf8',
      );
    } catch {
      /* best-effort */
    }
  }

  /** Rebuild the notification service + morning brief after a config change. */
  private rebuildNotifications(): void {
    this.notifications = new NotificationService({
      store: this.messageStore,
      telegram: this.config.notifications.telegram,
      events: this.config.notifications.events,
      language: this.config.notifications.language,
      logger: this.logBuffer.asLogger,
    });
    this.morningBrief = new MorningBriefScheduler({
      localTime: this.config.notifications.morningBriefLocalTime,
      timezone: this.config.location.timezone,
      markerPath: path.join(this.env.dataDir, 'morning-brief.json'),
    });
    void this.morningBrief.load();
    this.dailySummary = new MorningBriefScheduler({
      localTime: this.config.notifications.dailySummaryLocalTime,
      timezone: this.config.location.timezone,
      markerPath: path.join(this.env.dataDir, 'daily-summary.json'),
    });
    void this.dailySummary.load();
  }

  /**
   * Start/stop/recreate the direct OpenMeteo HTTP adapter to match the
   * current config. Called at boot and after every config change so the
   * user can enable/disable or retune the poll cadence without a restart.
   */
  private syncOpenMeteo(): void {
    const om = this.config.openMeteo;
    if (this.env.noConnect) {
      return;
    }
    // The dashboard forecast timeline + temperature chart always need the
    // OpenMeteo hourly series, so the adapter runs regardless of the
    // `enabled` flag (which only governs using it as a bound signal source).
    // Recreate so location / interval / baseUrl changes take effect.
    if (this.openMeteoStarted) {
      void this.openMeteo.stop();
    }
    this.openMeteo = new OpenMeteoAdapter({
      latitude: this.config.location.latitude,
      longitude: this.config.location.longitude,
      timezone: this.config.location.timezone,
      baseUrl: om.baseUrl,
      pollIntervalMs: Math.max(15, om.pollIntervalMinutes) * 60_000,
    });
    try {
      this.openMeteo.start();
      this.openMeteoStarted = true;
      this.logBuffer.append('info', 'openMeteo polling started', {
        url: this.openMeteo.buildUrl(),
        everyMin: Math.max(15, om.pollIntervalMinutes),
      });
    } catch (err) {
      this.openMeteoStarted = false;
      this.logBuffer.append('warn', 'openMeteo.start failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * (Re)build the GARDENA cloud adapter from the current config. Called on
   * boot and after a config change so toggling the integration on/off or
   * editing the API key takes effect without a restart. When disabled or
   * without credentials, tears down any running adapter.
   */
  private syncGardena(): void {
    if (this.env.noConnect) {
      return;
    }
    if (this.gardenaStarted && this.gardena !== null) {
      this.gardena.stop();
      this.gardena = null;
      this.gardenaStarted = false;
    }
    const g = this.config.gardena;
    if (g === undefined || !g.enabled || g.clientId === '' || g.clientSecret === '') {
      this.logBuffer.append('info', 'gardena disabled or unconfigured');
      return;
    }
    this.gardena = new GardenaCloudAdapter({
      config: g,
      logger: this.logBuffer.asLogger,
    });
    try {
      this.gardena.start();
      this.gardenaStarted = true;
      this.logBuffer.append('info', 'gardena cloud adapter started');
    } catch (err) {
      this.gardenaStarted = false;
      this.logBuffer.append('warn', 'gardena.start failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private buildCycleSnapshot(now: Date): CycleSnapshot {
    type RoomEntry = {
      tempC: number | null;
      targets: Config['rooms'][number]['targets'];
      priority: Priority;
    };

    // Resolve every configured SignalBinding against the live source
    // bus (HCU cache + FusionSolar). This is the bridge that makes the
    // wizard/sources mapping actually drive the engine — before 0.1.3
    // these were all hardcoded to null.
    const ctx: SourceContext = {
      hcu: this.cache,
      fusion: this.fusionSolar,
      openMeteo: this.openMeteo,
      now,
    };
    const num = (b: SignalBinding | undefined): number | null => {
      const r = resolveSignal(b, ctx);
      return r.ok ? r.value : null;
    };

    const gs = this.config.globalSignals;
    const outdoorTempC = this.outdoorMeanC(now) ?? num(gs.outdoorTemp);
    const forecastMaxTempC = this.forecastDailyMaxC(now) ?? num(gs.forecastMaxTemp);
    const windSpeedMs = num(gs.windSpeed);
    // Radiation: prefer an explicit binding; else the OpenMeteo current poll.
    const omRad = this.openMeteo.getValue('radiation');
    const radiationWm2 =
      num(gs.radiation) ??
      (omRad !== null && Number.isFinite(omRad.value) ? omRad.value : null);

    // A1/A2: hourly weather curve for the Forecast_Planner so the thermal
    // model follows the diurnal sun/temperature instead of freezing the
    // current values across the whole horizon.
    const forecastSeries = this.openMeteo.getForecastSeries().map((p) => ({
      ts: p.ts,
      tempC: p.tempC,
      radiationWm2: p.radiationWm2,
      cloudCover01: p.cloudCover01,
    }));

    // PV: prefer an explicit pvPower binding (value in W → kW); else
    // fall back to the FusionSolar adapter's `inputPower` (PV DC input =
    // solar generation), shared with resolvePvKw().
    const pvSmoothedKw = this.resolvePvKw(now);

    const rooms = new Map<string, RoomEntry>();
    for (const room of this.config.rooms) {
      rooms.set(room.id, {
        tempC: num(room.signals.indoorTemp),
        targets: room.targets,
        priority: room.priority,
      });
    }

    const windows = this.config.windows.map((w) => {
      const rs = this.runtime.state.windows.find((r) => r.windowId === w.id);
      const runtimeState: WindowRuntimeState | null = rs ?? null;
      // Current shutter level straight from the device's cached
      // `shutterLevel` feature (0..1, 1 = closed). null when the
      // device has not reported yet.
      const lvl = this.cache.getFeature(w.shutterDeviceId, 'shutterLevel');
      const currentLevel01 =
        lvl !== undefined && typeof lvl.value === 'number' ? lvl.value : null;
      // Window contact: map the assigned contact device's
      // `windowState` (CLOSED/OPEN/TILTED) onto our ContactState.
      const contactState: ContactState =
        w.contactDeviceId !== undefined
          ? mapWindowState(
              this.cache.getFeature(w.contactDeviceId, 'windowState')?.value,
            )
          : 'unknown';
      return { config: w, contactState, currentLevel01, runtimeState };
    });

    return {
      now,
      outdoorTempC,
      forecastMaxTempC,
      pvSmoothedKw,
      pvDroppedRecently: false,
      windSpeedMs,
      radiationWm2,
      rooms,
      windows,
      forecastSeries,
      switches: {
        vacation: this.runtime.state.userIntent.vacation,
        pauseControl: this.runtime.state.userIntent.paused,
      },
      stormHoldUntil:
        this.runtime.state.stormHoldUntil !== null
          ? new Date(this.runtime.state.stormHoldUntil)
          : null,
      // Master lever: when automation is OFF the engine still evaluates
      // everything but holds all positions (MAINTENANCE semantics), so
      // the user can configure in peace. Default config has it false.
      maintenanceMode: !this.config.automationEnabled,
    };
  }

  // --- dashboard wiring -------------------------------------------------
  private buildDashboardDeps(): DashboardServerDeps {
    return {
      config: () => this.config,
      updateConfig: async (next) => {
        const validated = parseConfig(next);
        await writeConfig(validated, { configPath: this.configPath() });
        this.config = validated;
        this.rebuildNotifications();
        this.syncOpenMeteo();
        this.syncGardena();
      },
      readState: () => readState({ statePath: this.statePath() }),
      readDecisions: (n) =>
        readLastN<DecisionRecord>(n, { historyPath: this.historyPath() }),
      readHistory: async (seconds) => {
        const cutoff = Date.now() - seconds * 1000;
        const out: Awaited<ReturnType<DashboardServerDeps['readHistory']>> = [];
        for await (const rec of readRecords<DecisionRecord>({
          historyPath: this.historyPath(),
        })) {
          if (Date.parse(rec.ts) >= cutoff) out.push(rec);
        }
        return out;
      },
      readTrends: async (seconds) => {
        const cutoff = Date.now() - seconds * 1000;
        const all = await readTrendSamples({ trendsPath: this.trendsPath() });
        return all.filter((s) => Date.parse(s.ts) >= cutoff);
      },
      getSnapshot: async () => this.getCachedSnapshot(),
      readForecast: async (roomId, hours) => this.buildForecastResponse(roomId, hours),
      readPlan: async () => this.buildPlanResponse(),
      probe: async (override) => {
        const cfg = override ?? this.config;
        const snap = this.buildCycleSnapshot(new Date());
        const out = await runDryProbe(snap, { config: cfg });
        return { mode: out.mode, windowDecisions: out.decisionRecord.windowDecisions };
      },
      runProbe: async () => {
        const snap = this.buildCycleSnapshot(new Date());
        const out = await runDryProbe(snap, { config: this.config });
        return {
          mode: out.mode,
          windowDecisions: out.decisionRecord.windowDecisions,
          ts: out.decisionRecord.ts,
          cycleId: out.decisionRecord.cycleId,
        };
      },
      setShutterManually: async (windowId, level01) => {
        const w = this.config.windows.find((c) => c.id === windowId);
        if (w === undefined) throw new Error(`unknown windowId: ${windowId}`);
        await this.hmipSystem?.setShutterLevel(w.shutterDeviceId, 1, level01);
      },
      setGardenaValve: async (deviceId, on, channelIndex) => {
        // Prefer the direct cloud adapter when the target is one of its
        // valve services; otherwise fall back to an HCU-bridged SWITCH.
        if (this.gardena !== null && this.gardena.hasValve(deviceId)) {
          await this.gardena.setValve(deviceId, on);
          return;
        }
        await this.hmipSystem?.setSwitchState(deviceId, on, channelIndex);
      },
      testGardena: async () => {
        const gcfg = this.config.gardena;
        if (gcfg === undefined) {
          return { ok: false, locations: 0, sensors: 0, valves: 0, error: 'Gardena nicht konfiguriert' };
        }
        if (this.gardena === null) {
          // Build a throwaway adapter from the live config so the user can
          // test the key before enabling the integration.
          const probe = new GardenaCloudAdapter({
            config: gcfg,
            logger: this.logBuffer.asLogger,
          });
          return probe.testConnection();
        }
        return this.gardena.testConnection();
      },
      runIrrigationZone: (zoneId, seconds) => this.irrigation.runZone(zoneId, seconds),
      stopIrrigationZone: (zoneId) => this.irrigation.stopZone(zoneId),
      skipIrrigationZone: (zoneId) => this.irrigation.skipZoneToday(zoneId),
      calibrateIrrigationZone: (zoneId, availablePct) =>
        this.irrigation.calibrateZone(zoneId, availablePct),
      updateIrrigationPlanEntry: (entryId, patch) =>
        this.irrigation.updatePlanEntry(entryId, patch),
      deleteIrrigationPlanEntry: (entryId) => this.irrigation.deletePlanEntry(entryId),
      addIrrigationPlanEntry: (zoneId, startTs, durationMin) =>
        this.irrigation.addPlanEntry(zoneId, startTs, durationMin),
      setMaintenanceMode: async () => {
        // Maintenance toggle is engine-internal; v1 only flips a flag
        // that the next cycle picks up. The orchestrator's mode FSM
        // honours `maintenanceMode` directly.
      },
      setAutomationEnabled: async (enabled) => {
        // Master lever: persist config.automationEnabled. The next
        // cycle reads it via buildCycleSnapshot → maintenanceMode.
        const next = { ...this.config, automationEnabled: enabled };
        const validated = parseConfig(next);
        await writeConfig(validated, { configPath: this.configPath() });
        this.config = validated;
        this.events.emit('event', {
          type: 'automation.changed',
          payload: { enabled },
        } satisfies DashboardStreamEvent);
      },
      resetConfig: async () => {
        const seeded = seedDefaultConfig();
        await writeConfig(seeded, { configPath: this.configPath() });
        this.config = seeded;
        this.rebuildNotifications();
        this.syncOpenMeteo();
        this.syncGardena();
      },
      subscribe: (handler) => {
        this.events.on('event', handler);
        return () => this.events.off('event', handler);
      },
      getConnectLog: () => this.logBuffer.entries(),
      getMessages: () => this.messageStore.list(),
      markMessagesRead: (ids) => this.messageStore.markRead(ids),
      getBackupData: async () => {
        const learning = await fs.readFile(this.learningPath(), 'utf8').catch(() => '');
        const calibration = await fs
          .readFile(this.calibrationPath(), 'utf8')
          .catch(() => '');
        return { learning, calibration };
      },
      restoreBackupData: async ({ learning, calibration }) => {
        await fs.writeFile(this.learningPath(), learning, 'utf8');
        await fs.writeFile(this.calibrationPath(), calibration, 'utf8');
        // Reload the in-memory models from the freshly written stores (the
        // readers skip malformed lines, so a partial backup degrades safely).
        this.learnHistory = await readLearningObservations({
          learningPath: this.learningPath(),
        });
        this.recomputeLearnedModels();
        this.calibHistory = await readCalibrationObservations({
          calibrationPath: this.calibrationPath(),
        });
        this.recomputeCalibration();
        this.logBuffer.append('info', 'backup restored', {
          learningBytes: learning.length,
          calibrationBytes: calibration.length,
        });
      },
      sendTestNotification: async () => {
        return sendTelegram(
          this.config.notifications.telegram,
          this.nt(
            'Heat Shield: Test-Nachricht ✅ Deine Telegram-Anbindung funktioniert.',
            'Heat Shield: test message ✅ Your Telegram connection works.',
          ),
        );
      },
      getLearningSnapshot: () => this.buildLearningSnapshot(),
      applyRecommendation: (id) => this.applyRecommendation(id),
      discoverSources: () => this.discoverSources(),
      getHouseImage: () => this.readHouseImage(),
      saveHouseImage: (dataUrl) => this.saveHouseImage(dataUrl),
      logger: this.logBuffer.asLogger,
    };
  }

  /**
   * Backing implementation for `POST /api/sources/discover`. Issues
   * a fresh `getSystemState` round-trip so the wizard sees devices
   * that were added after plugin start. The cache is still the
   * source of truth — `getSystemState` updates it in place and we
   * read straight from `listDevices()` afterwards. If the
   * round-trip fails (no connection, timeout, non-200 response) we
   * fall through to whatever the cache already holds and let the
   * SPA show an empty list rather than surfacing a 500.
   *
   * The returned shape also carries diagnostic fields the SPA can
   * surface so the user can tell the difference between "discovery
   * succeeded but the HCU has no devices that match" and "discovery
   * never reached the HCU at all":
   *
   *   - `connectState`     — `'off' | 'connecting' | 'connected'`
   *   - `lastError`        — last `getSystemState` error message
   *                          (string) or `null` on success
   *   - `attemptedRefresh` — whether we actually fired the request
   */
  private async discoverSources(): Promise<{
    devices: ReturnType<HcuSourceCache['listDevices']>;
    climateSensors: ReturnType<HcuSourceCache['findClimateSensors']>;
    openMeteo: ReturnType<HcuSourceCache['findOpenMeteoSensors']>;
    connectState: 'off' | 'connecting' | 'connected';
    lastError: string | null;
    attemptedRefresh: boolean;
    deviceTypeHistogram: ReadonlyArray<{ deviceType: string; count: number }>;
    temperatureSources: ReturnType<HcuSourceCache['findDevicesWithFeature']>;
    shutterSources: ReturnType<HcuSourceCache['findDevicesWithFeature']>;
    contactSources: ReturnType<HcuSourceCache['findDevicesWithFeature']>;
    inventory: ReturnType<HcuSourceCache['listInventory']>;
    rawDeviceCount: number;
    rawDeviceTypeHistogram: ReadonlyArray<{ deviceType: string; count: number }>;
    pluginBuild: string;
  }> {
    let lastError: string | null = null;
    let attemptedRefresh = false;
    const connectState: 'off' | 'connecting' | 'connected' =
      this.connect === null
        ? 'off'
        : this.connect.isConnected()
          ? 'connected'
          : 'connecting';
    if (this.hmipSystem !== null && this.connect?.isConnected() === true) {
      attemptedRefresh = true;
      try {
        await this.hmipSystem.getSystemState();
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        this.logBuffer.append('warn', 'discoverSources: getSystemState failed', {
          error: lastError,
        });
      }
    } else if (this.hmipSystem !== null) {
      lastError =
        'Connect API socket is not open yet; discovery returned the cached snapshot instead of a fresh getSystemState.';
      this.logBuffer.append('warn', 'discoverSources: socket not open', {
        connectState,
      });
    }
    const devices = this.cache.listDevices();
    // Build deviceType histogram. Devices with no deviceType land in
    // the `(unknown)` bucket so the user notices missing classifier
    // data instead of silently dropping the device.
    const histogramMap = new Map<string, number>();
    for (const d of devices) {
      const key = d.deviceType ?? '(unknown)';
      histogramMap.set(key, (histogramMap.get(key) ?? 0) + 1);
    }
    const deviceTypeHistogram = Array.from(histogramMap.entries())
      .map(([deviceType, count]) => ({ deviceType, count }))
      .sort((a, b) =>
        a.count !== b.count
          ? b.count - a.count
          : a.deviceType.localeCompare(b.deviceType),
      );
    const temperatureSources = this.cache.findDevicesWithFeature(
      'actualTemperature',
    );
    const shutterSources = this.cache.findDevicesWithFeature('shutterLevel');
    const contactSources = this.cache.findDevicesWithFeature('windowState');
    const inventory = this.cache.listInventory();
    // Raw histogram off the last getSystemState body, BEFORE the
    // cache's schema filtering. If rawDeviceCount > devices.length,
    // the parser is dropping device shapes the HCU actually sent.
    const rawBody = this.hmipSystem?.getLastRawSystemStateBody() ?? null;
    const { rawDeviceCount, rawDeviceTypeHistogram } =
      summariseRawSystemState(rawBody);
    return {
      devices,
      climateSensors: this.cache.findClimateSensors(),
      openMeteo: this.cache.findOpenMeteoSensors(),
      connectState,
      lastError,
      attemptedRefresh,
      deviceTypeHistogram,
      temperatureSources,
      shutterSources,
      contactSources,
      inventory,
      rawDeviceCount,
      rawDeviceTypeHistogram,
      pluginBuild: process.env['HEATSHIELD_BUILD'] ?? 'dev',
    };
  }

  /**
   * Return the per-cycle cached dashboard snapshot, rebuilding it only when it
   * is missing or older than 2 s (B2). Polls (`/api/state`) and SSE-driven
   * refetches no longer recompute the heavy snapshot on every request.
   */
  private getCachedSnapshot(): DashboardSnapshotV2 {
    const nowMs = Date.now();
    if (this.cachedSnapshot !== null && nowMs - this.cachedSnapshotAt < 2000) {
      return this.cachedSnapshot;
    }
    const snap = this.buildSnapshot();
    this.cachedSnapshot = snap;
    this.cachedSnapshotAt = nowMs;
    return snap;
  }

  /**
   * Latest weather environment readings (radiation, UV, humidity) from the
   * OpenMeteo adapter's most recent poll. UV is taken from the hourly series
   * sample closest to `now` (the `current` block has no UV field); radiation
   * and humidity come from the `current` block. Returns nulls when the
   * adapter has not yet succeeded.
   */
  private currentOpenMeteoEnv(now: Date): {
    radiationWm2: number | null;
    uvIndex: number | null;
    humidity01: number | null;
  } {
    const radiation = this.openMeteo.getValue('radiation');
    const humidity = this.openMeteo.getValue('humidity');
    // relative_humidity_2m is a percentage (0..100) → normalise to [0,1].
    const humidity01 =
      humidity !== null && Number.isFinite(humidity.value)
        ? Math.max(0, Math.min(1, humidity.value / 100))
        : null;
    // UV: nearest hourly sample to `now`.
    let uvIndex: number | null = null;
    const series = this.openMeteo.getForecastSeries();
    if (series.length > 0) {
      const t = now.getTime();
      let best: { dist: number; uv: number | null } | null = null;
      for (const p of series) {
        const pt = Date.parse(p.ts);
        if (Number.isNaN(pt)) {
          continue;
        }
        const dist = Math.abs(pt - t);
        if (best === null || dist < best.dist) {
          best = { dist, uv: p.uvIndex };
        }
      }
      uvIndex = best?.uv ?? null;
    }
    return {
      radiationWm2:
        radiation !== null && Number.isFinite(radiation.value) ? radiation.value : null,
      uvIndex,
      humidity01,
    };
  }

  private buildSnapshot(): DashboardSnapshotV2 {
    const now = new Date();
    const ctx: SourceContext = { hcu: this.cache, fusion: this.fusionSolar, openMeteo: this.openMeteo, now };

    // Resolve a binding into a dashboard SignalValue with a freshness
    // classification. resolveSignal only returns ok within the
    // binding's staleAfterSec window, so an ok value is at most that
    // old; we split it into fresh (<= 50% of the window) vs soon.
    const sv = (
      b: SignalBinding | undefined,
      scale = 1,
    ): SignalValue => {
      const r = resolveSignal(b, ctx);
      const bound = b !== undefined;
      if (r.ok) {
        const ageSec = (now.getTime() - r.observedAt.getTime()) / 1000;
        const half = (b?.staleAfterSec ?? 600) * 0.5;
        return {
          value: r.value * scale,
          ts: r.observedAt.toISOString(),
          state: ageSec <= half && !r.usedFallback ? 'fresh' : 'soon',
          bound,
        };
      }
      return {
        value: null,
        ts: null,
        state: r.reason === 'stale' ? 'stale' : 'unknown',
        bound,
      };
    };

    const gs = this.config.globalSignals;
    // PV: prefer an explicit binding (W → kW); else FusionSolar `inputPower`
    // (PV DC input = solar generation, the true irradiance proxy).
    let pvSignal = sv(gs.pvPower, 1 / 1000);
    if (pvSignal.value === null) {
      const pv = this.fusionSolar.getValue('inputPower');
      if (pv) {
        pvSignal = {
          value: pv.value / 1000,
          ts: pv.observedAt.toISOString(),
          state: 'fresh',
          bound: true,
        };
      } else {
        // PV is effectively "bound" via FusionSolar even without an explicit
        // binding — so the tile shows "waiting for data", not "assign source".
        pvSignal = { ...pvSignal, bound: true };
      }
    }

    const sunPos = getSunPosition(now, this.config.location);
    const heatLoad = this.computeHeatLoad(now);

    // --- Predictive-control-dashboard V2 blocks (Task 11) ---------------
    const pvKw = this.resolvePvKw(now);
    const clearSky = clearSkyPvKw(
      sunPos,
      this.config.fusionSolar.pvPeakKwp,
      this.config.fusionSolar.orientationHint,
    );
    const pvIdx = pvSonnenindex01(pvKw ?? 0, clearSky);
    // Eigenverbrauch (self-consumption): share of PV generation consumed in
    // the house rather than exported. Derived from FusionSolar `inputPower`
    // (PV DC generation, W) and `meterActivePower` (grid power, W; negative
    // = export). Only defined when the panels are actually generating, so
    // the dashboard can hide the line cleanly when it is not derivable.
    let pvSelfUse01: number | undefined;
    const pvInputW = this.fusionSolar.getValue('inputPower');
    const meterW = this.fusionSolar.getValue('meterActivePower');
    if (pvInputW !== null && pvInputW.value > 0 && meterW !== null) {
      const exportedW = Math.max(0, -meterW.value);
      pvSelfUse01 = Math.max(0, Math.min(1, (pvInputW.value - exportedW) / pvInputW.value));
    }
    const cloudRaw = resolveSignal(gs.forecastCloudCover, ctx);
    const cloud01 = cloudRaw.ok
      ? cloudRaw.value > 1
        ? Math.min(1, cloudRaw.value / 100)
        : Math.max(0, cloudRaw.value)
      : 0;
    const facadeExp = (facadeDeg: number): number =>
      Math.round(facadeExposure01(sunPos, facadeDeg, cloud01, pvIdx) * 100);
    const facades = {
      N: facadeExp(0),
      E: facadeExp(90),
      S: facadeExp(180),
      W: facadeExp(270),
    };

    const radiationRes = resolveSignal(gs.radiation, ctx);
    const windRes = resolveSignal(gs.windSpeed, ctx);
    // UV / humidity have no dedicated bindings; pull them (and radiation as a
    // fallback) directly from the OpenMeteo adapter's latest poll.
    const omEnv = this.currentOpenMeteoEnv(now);
    const radiationValue = radiationRes.ok ? radiationRes.value : omEnv.radiationWm2;
    const vq = (
      res: { ok: true; value: number } | { ok: false },
      origin: ValueWithQuality['origin'],
      source: string,
      scale = 1,
    ): ValueWithQuality =>
      res.ok
        ? makeValueWithQuality(res.value * scale, origin, source, 0.9)
        : makeValueWithQuality(null, origin, source, 0);
    const omVq = (
      value: number | null,
      origin: ValueWithQuality['origin'],
    ): ValueWithQuality =>
      value === null
        ? makeValueWithQuality(null, origin, 'OpenMeteo', 0)
        : makeValueWithQuality(value, origin, 'OpenMeteo', 0.9);
    const environment = {
      radiationWm2: omVq(radiationValue, 'forecast'),
      uvIndex: omVq(omEnv.uvIndex, 'forecast'),
      windMs: vq(windRes, 'forecast', 'OpenMeteo'),
      humidity01: omVq(omEnv.humidity01, 'measured'),
    };

    const plannerResult = this.lastPlannerResult;
    const plannedActions: PlannedAction[] = plannerResult
      ? [...plannerResult.plannedActions]
      : [];
    const roomsDetail = this.buildRoomsDetail(ctx, plannerResult);
    const trajectories = this.buildTrajectories(plannerResult);
    const modeInfo = this.buildModeInfo(this.runtime.lastMode);
    const forecastTimeline = this.buildForecastTimeline(now);

    const roomTemps = this.config.rooms
      .map((r) => {
        const res = resolveSignal(r.signals.indoorTemp, ctx);
        return res.ok ? res.value : null;
      })
      .filter((t): t is number => t !== null && Number.isFinite(t));
    const indoorAvgNow =
      roomTemps.length > 0
        ? roomTemps.reduce((a, b) => a + b, 0) / roomTemps.length
        : null;
    const indoorPeakTempC = this.updateIndoorPeak(now, indoorAvgNow);

    return {
      ts: now.toISOString(),
      mode: this.runtime.lastMode,
      indoorPeakTempC,
      rooms: this.config.rooms.map((r) => ({
        id: r.id,
        name: r.name,
        tempC: (() => {
          const res = resolveSignal(r.signals.indoorTemp, ctx);
          return res.ok ? res.value : null;
        })(),
      })),
      windows: this.config.windows.map((w) => {
        const rs = this.runtime.state.windows.find((s) => s.windowId === w.id);
        const lvl = this.cache.getFeature(w.shutterDeviceId, 'shutterLevel');
        const currentLevel01 =
          lvl !== undefined && typeof lvl.value === 'number' ? lvl.value : null;
        const label = this.windowLabel(w.id);
        return {
          id: w.id,
          ...(label !== undefined ? { name: label } : {}),
          currentLevel01,
          manualOverrideUntil: rs?.manualOverrideUntil ?? null,
          lastDecisionMode: rs?.lastDecisionMode ?? null,
        };
      }),
      sources: {
        fusionSolar: {
          sourceOk: this.fusionSolar.getStatus().sourceOk,
          lastSuccess:
            this.fusionSolar.getStatus().lastSuccess?.toISOString() ?? null,
          consecutiveFailures: this.fusionSolar.getStatus().consecutiveFailures,
        },
        hcu: { connected: this.connect?.isConnected() ?? false },
      },
      userIntent: this.runtime.state.userIntent,
      storm: { holdUntil: this.runtime.state.stormHoldUntil },
      pluginReadiness: this.computeReadiness(),
      automationEnabled: this.config.automationEnabled,
      signals: {
        outdoorTemp: ((): SignalValue => {
          const mean = this.outdoorMeanC(now);
          const base = sv(gs.outdoorTemp);
          return mean !== null ? { ...base, value: Math.round(mean * 10) / 10 } : base;
        })(),
        pvPower: pvSignal,
        windSpeed: sv(gs.windSpeed),
        radiation: sv(gs.radiation),
        forecastMaxTemp: ((): SignalValue => {
          const dailyMax = this.forecastDailyMaxC(now);
          const base = sv(gs.forecastMaxTemp);
          return dailyMax !== null
            ? { ...base, value: Math.round(dailyMax * 10) / 10, state: 'fresh' }
            : base;
        })(),
        forecastCloudCover: sv(gs.forecastCloudCover),
      },
      outdoorTempInternetC: this.outdoorInternetC(),
      sun: {
        azimuthDeg: sunPos.azimuthDeg,
        elevationDeg: sunPos.elevationDeg,
      },
      feelsLike: {
        effectiveLoad01: heatLoad.load01,
        feelsLikeC: heatLoad.feelsLikeC,
      },
      trends: {
        outdoorCph: this.trendStore.slopePerHour('outdoor'),
        pvKwph: this.trendStore.slopePerHour('pv'),
      },
      unreadMessages: this.messageStore.unreadCount(),
      modeInfo,
      environment,
      facades,
      pvSonnenindex01: pvIdx,
      ...(pvSelfUse01 !== undefined ? { pvSelfUse01 } : {}),
      roomsDetail,
      forecastTimeline,
      plannedActions,
      ventilation: this.buildVentilation(now, sunPos.isUp, roomsDetail),
      cooling: this.buildCooling(
        now,
        this.runtime.lastMode === 'ACTIVE_HEAT_PROTECTION' ||
          this.runtime.lastMode === 'HEATWAVE',
      ),
      learning: this.buildLearning(),
      impact: this.buildImpact(pvSelfUse01),
      trajectories,
      irrigation: this.irrigation.buildSnapshot(),
      ...((): { gardena?: NonNullable<DashboardSnapshotV2['gardena']> } => {
        const gardena = this.buildGardena();
        return gardena !== null ? { gardena } : {};
      })(),
    };
  }

  /**
   * Build the Bewässerung snapshot's `gardena` block. Prefers the direct
   * GARDENA cloud integration when it is enabled; otherwise falls back to
   * detecting Gardena devices bridged into the HCU by the separate Gardena
   * Connect plugin. Returns `null` when neither source has any device.
   */
  private buildGardena(): NonNullable<DashboardSnapshotV2['gardena']> | null {
    // 1. Direct cloud integration (preferred when configured).
    if (this.gardena !== null && this.config.gardena?.enabled === true) {
      const status = this.gardena.getStatus();
      const sensors = this.gardena.listSensors().map((s) => ({
        deviceId: s.deviceId,
        name: s.name,
        soilMoisturePct: s.soilHumidityPct,
        soilTempC: s.soilTempC,
        lux: s.lightLux,
        ambientTempC: s.ambientTempC,
        batteryPct: s.batteryPct,
      }));
      const valves = this.gardena.listValves().map((v) => ({
        deviceId: v.serviceId,
        name: v.name,
        channelIndex: 1,
        on: v.on,
        activity: v.activity,
        source: 'cloud' as const,
      }));
      if (sensors.length > 0 || valves.length > 0 || status.lastError !== null) {
        return {
          sensors,
          valves,
          cloud: true,
          connected: status.connected,
          error: status.lastError,
        };
      }
    }

    // 2. HCU-bridged fallback (separate Gardena Connect plugin on the HCU).
    const num = (deviceId: string, feature: string): number | null => {
      const fv = this.cache.getFeature(deviceId, feature);
      return fv !== undefined && typeof fv.value === 'number'
        ? fv.value
        : null;
    };
    const isGardena = (d: HmipDeviceMeta): boolean => {
      if (d.deviceId.toLowerCase().includes('gardena')) return true;
      const name = d.friendlyName?.toLowerCase() ?? '';
      return name.includes('gardena');
    };
    const sensors: NonNullable<DashboardSnapshotV2['gardena']>['sensors'] = [];
    const valves: NonNullable<DashboardSnapshotV2['gardena']>['valves'] = [];
    for (const d of this.cache.listDevices()) {
      if (!isGardena(d)) continue;
      const features = this.cache.listFeatures(d.deviceId);
      const name = d.friendlyName ?? d.deviceId;
      if (features.includes('switchState')) {
        const fv = this.cache.getFeature(d.deviceId, 'switchState');
        const on =
          fv !== undefined
            ? typeof fv.value === 'boolean'
              ? fv.value
              : fv.value === 'true'
                ? true
                : fv.value === 'false'
                  ? false
                  : null
            : null;
        valves.push({
          deviceId: d.deviceId,
          name,
          channelIndex: fv?.channelIndex ?? 1,
          on,
          source: 'hcu',
        });
      } else if (
        features.includes('humidity') ||
        features.includes('actualTemperature') ||
        features.includes('illumination')
      ) {
        sensors.push({
          deviceId: d.deviceId,
          name,
          soilMoisturePct: num(d.deviceId, 'humidity'),
          soilTempC: num(d.deviceId, 'actualTemperature'),
          lux: num(d.deviceId, 'illumination'),
        });
      }
    }
    if (sensors.length === 0 && valves.length === 0) return null;
    return { sensors, valves };
  }

  /** Per-room detail block with shutter %, trend and next planned action. */
  /**
   * Build the per-room ventilation advice block (Lüftung module). Advisory
   * only. Uses the room's measured indoor temp, the outdoor mean, the sun
   * state and the active heat mode. `overall` is the most actionable advice.
   */
  private buildVentilation(
    now: Date,
    sunIsUp: boolean,
    roomsDetail: NonNullable<DashboardSnapshotV2['roomsDetail']>,
  ): NonNullable<DashboardSnapshotV2['ventilation']> {
    const outdoor = this.outdoorMeanC(now);
    const deltaC = this.config.rules.comfort.nightCoolingDeltaC;
    const heatModeActive =
      this.runtime.lastMode === 'ACTIVE_HEAT_PROTECTION' ||
      this.runtime.lastMode === 'HEATWAVE';
    const rooms = roomsDetail.map((r) => {
      const cfg = this.config.rooms.find((c) => c.id === r.id);
      const comfortMaxC = cfg?.targets.warning_c ?? 25;
      const advice: VentAdvice = ventilationAdvice({
        sunIsUp,
        indoorTempC: r.indoorTempC,
        outdoorTempC: outdoor,
        deltaC,
        comfortMaxC,
        heatModeActive,
        windowOpen: r.windowOpen === true,
      });
      return { id: r.id, name: r.name, ...advice };
    });
    // Overall = highest-priority advice across rooms.
    const priority: Record<VentAdvice['level'], number> = {
      air_now: 4,
      close_window: 4,
      air_possible: 2,
      keep_closed: 1,
      neutral: 0,
    };
    let overall: VentAdvice = {
      level: 'neutral',
      headline: 'Keine Empfehlung',
      detail: 'Aktuell kein Lüftungsvorteil.',
    };
    for (const r of rooms) {
      if (priority[r.level] > priority[overall.level]) {
        overall = { level: r.level, headline: r.headline, detail: r.detail };
      }
    }
    return { overall, rooms };
  }

  /**
   * House-level active-cooling advice (Klima module), PV-surplus-gated. Uses
   * the warmest room's temperature + its comfort ceiling, the estimated PV
   * surplus (FusionSolar export, else generation as a proxy), and the heat mode.
   */
  private buildCooling(
    now: Date,
    heatModeActive: boolean,
  ): NonNullable<DashboardSnapshotV2['cooling']> {
    const ctx: SourceContext = { hcu: this.cache, fusion: this.fusionSolar, openMeteo: this.openMeteo, now };
    // Warmest room + its comfort ceiling.
    let warmestC: number | null = null;
    let comfortMaxC = 25;
    for (const r of this.config.rooms) {
      const res = resolveSignal(r.signals.indoorTemp, ctx);
      if (res.ok && (warmestC === null || res.value > warmestC)) {
        warmestC = res.value;
        comfortMaxC = r.targets.warning_c;
      }
    }
    // PV surplus: exported power (negative meter) preferred, else generation.
    let pvSurplusKw: number | null = null;
    const meterW = this.fusionSolar.getValue('meterActivePower');
    if (meterW !== null && Number.isFinite(meterW.value)) {
      pvSurplusKw = Math.max(0, -meterW.value) / 1000;
    } else {
      pvSurplusKw = this.resolvePvKw(now);
    }
    // Forecast daily max for forecast-driven pre-cooling (V1.8).
    let forecastMaxC: number | null = null;
    const fcRes = resolveSignal(this.config.globalSignals.forecastMaxTemp, ctx);
    if (fcRes.ok && Number.isFinite(fcRes.value)) {
      forecastMaxC = fcRes.value;
    }
    const advice = coolingAdvice({
      indoorTempC: warmestC,
      comfortMaxC,
      preCoolC: this.config.rules.comfort.preShadeTempC,
      pvSurplusKw,
      pvSurplusThresholdKw: 0.5,
      heatModeActive,
      forecastMaxC,
      forecastHotC: this.config.rules.thresholds.activeForecastC,
    });
    return {
      level: advice.level,
      headline: advice.headline,
      detail: advice.detail,
      pvSurplusKw: advice.pvSurplusKw,
    };
  }

  private buildRoomsDetail(
    ctx: SourceContext,
    plannerResult: PlannerResult | undefined,
  ): NonNullable<DashboardSnapshotV2['roomsDetail']> {
    return this.config.rooms.map((r) => {
      const win = this.config.windows.find((w) => w.roomId === r.id);
      const facade: FacadeKey =
        win !== undefined ? facadeKeyFor(win.orientationDeg) : 'S';
      let shutterPercent = 0;
      if (win !== undefined) {
        const lvl = this.cache.getFeature(win.shutterDeviceId, 'shutterLevel');
        if (lvl !== undefined && typeof lvl.value === 'number') {
          shutterPercent = Math.round(level01ToPercent(lvl.value));
        }
      }
      // Window open: any window in this room whose contact reads OPEN/TILTED.
      const windowOpen = this.config.windows.some((w) => {
        if (w.roomId !== r.id || w.contactDeviceId === undefined) {
          return false;
        }
        const state = mapWindowState(
          this.cache.getFeature(w.contactDeviceId, 'windowState')?.value,
        );
        return state === 'open' || state === 'tilted';
      });
      const tempRes = resolveSignal(r.signals.indoorTemp, ctx);
      const indoorTempC = tempRes.ok ? tempRes.value : null;
      const indoorTempState: 'fresh' | 'stale' | 'unbound' = tempRes.ok
        ? 'fresh'
        : tempRes.reason === 'unbound'
          ? 'unbound'
          : 'stale';
      const slope = this.trendStore.slopePerHour(`room:${r.id}`);
      const trend: 'up' | 'down' | 'flat' =
        slope === null || Math.abs(slope) < 0.1 ? 'flat' : slope > 0 ? 'up' : 'down';
      const plan =
        win !== undefined ? plannerResult?.windows.get(win.id) : undefined;
      const rawNextAction: PlannedAction | null = plan?.plannedActions[0] ?? null;
      // Active manual override: the safety layer holds this window until the
      // override expires, so the engine will NOT execute any planned move
      // before then. Reflect that here so the 12 h timeline/forecast show the
      // held position instead of a phantom move (e.g. a night-time open the
      // user has overridden). The planned move is deferred to the override's
      // expiry; if that is beyond the 12 h horizon the room simply stays put.
      const overrideUntilMs = (() => {
        if (win === undefined) return 0;
        const rs = this.runtime.state.windows.find((s) => s.windowId === win.id);
        const iso = rs?.manualOverrideUntil ?? null;
        const ms = iso !== null ? Date.parse(iso) : NaN;
        return Number.isFinite(ms) ? ms : 0;
      })();
      const nowMs = Date.now();
      const overrideActive = overrideUntilMs > nowMs;
      const nextAction: PlannedAction | null =
        overrideActive && rawNextAction !== null
          ? {
              ...rawNextAction,
              state: 'manuallyOverridden',
              scheduledTs: new Date(
                Math.max(Date.parse(rawNextAction.scheduledTs) || 0, overrideUntilMs),
              ).toISOString(),
            }
          : rawNextAction;
      const status: PlannedAction['state'] = overrideActive
        ? 'manuallyOverridden'
        : nextAction?.state ?? 'completed';
      // Roof-window flag for the 95 %/100 % convention.
      const roof = win?.type === 'roof_window';
      const traj = plannerResult?.trajectories.get(r.id);
      const heatLoad01 =
        traj?.points[0]?.heatLoad01 !== undefined
          ? Math.max(0, Math.min(1, traj.points[0].heatLoad01))
          : undefined;
      const cutoffMs = Date.now() + 12 * 3_600_000;
      // 12 h shutter preview coupled directly to the planner's scheduled
      // targets: a step function that holds the current level until each
      // planned action's time, then jumps to that action's target — i.e. the
      // position the engine will actually command (matches the "Rollladen-
      // Steuerung" heatmap). Flat at the current level when no move is planned.
      const plannedActionsSorted = (plan?.plannedActions ?? [])
        .slice()
        .sort((a, b) => Date.parse(a.scheduledTs) - Date.parse(b.scheduledTs));
      const capPct = roof ? 100 : 95;
      const plannedPercentAt = (tMs: number): number => {
        // While an override is active the engine holds the position.
        if (overrideActive && tMs < overrideUntilMs) {
          return shutterPercent;
        }
        let pct = shutterPercent;
        for (const a of plannedActionsSorted) {
          if (Date.parse(a.scheduledTs) <= tMs) {
            pct = Math.max(0, Math.min(capPct, Math.round(a.targetPercent)));
          } else {
            break;
          }
        }
        return pct;
      };
      const shutterForecast = traj
        ? traj.points
            .filter((p) => Date.parse(p.ts) <= cutoffMs)
            .map((p) => ({ ts: p.ts, percent: plannedPercentAt(Date.parse(p.ts)) }))
        : undefined;
      return {
        id: r.id,
        name: r.name,
        ...(r.floor !== undefined ? { floor: r.floor } : {}),
        facade,
        ...(win !== undefined ? { orientationDeg: win.orientationDeg } : {}),
        ...(win !== undefined ? { windowId: win.id } : {}),
        shutterPercent,
        indoorTempC,
        indoorTempState,
        trend,
        nextAction,
        status,
        windowOpen,
        roof,
        ...(overrideActive
          ? { manualOverrideUntil: new Date(overrideUntilMs).toISOString() }
          : {}),
        ...(heatLoad01 !== undefined ? { heatLoad01 } : {}),
        ...(shutterForecast !== undefined && shutterForecast.length > 0
          ? { shutterForecast }
          : {}),
      };
    });
  }

  /**
   * Track the highest average indoor temperature seen today (since local
   * midnight). In-memory only — resets on restart, which is acceptable for a
   * "Peak heute" readout. Returns the current day's peak (or the live value).
   */
  private updateIndoorPeak(now: Date, indoorAvgNow: number | null): number | null {
    const dayKey = now.toLocaleDateString('de-DE', { timeZone: this.config.location.timezone });
    const current = this.runtime.state.indoorPeak;
    if (current === null || current.day !== dayKey) {
      this.runtime.state.indoorPeak =
        indoorAvgNow !== null ? { day: dayKey, peakC: indoorAvgNow } : null;
    } else if (indoorAvgNow !== null && indoorAvgNow > current.peakC) {
      this.runtime.state.indoorPeak = { day: dayKey, peakC: indoorAvgNow };
    }
    const peak = this.runtime.state.indoorPeak;
    return peak !== null && Number.isFinite(peak.peakC)
      ? Math.round(peak.peakC * 10) / 10
      : null;
  }

  /** Forecast trajectories for the analysis charts (mit/ohne Beschattung). */
  private buildTrajectories(
    plannerResult: PlannerResult | undefined,
  ): NonNullable<DashboardSnapshotV2['trajectories']> {
    const empty = {
      indoorForecastWithShade: [] as Array<{ ts: string; tempC: number }>,
      indoorForecastNoShade: [] as Array<{ ts: string; tempC: number }>,
      heatLoadForecast: [] as Array<{ ts: string; load01: number }>,
    };
    if (plannerResult === undefined) {
      return empty;
    }
    // Headline = the first room with a trajectory (same room across all three
    // series so the chart compares like-for-like).
    const first = plannerResult.trajectories.entries().next();
    if (first.done === true) {
      return empty;
    }
    const [roomId, baseTraj] = first.value;
    // "Mit Beschattung" = best-case fully-shaded counterfactual; "ohne
    // Beschattung" = fully-open counterfactual. Both are real RC simulations
    // (planner.ts), so the spread genuinely reflects the value of shading.
    // Fall back to the base trajectory if a counterfactual is unavailable.
    const shaded = plannerResult.shadedTrajectories.get(roomId) ?? baseTraj;
    const open = plannerResult.openTrajectories.get(roomId) ?? baseTraj;
    return {
      indoorForecastWithShade: shaded.points.map((p) => ({
        ts: p.ts,
        tempC: p.indoorTempC,
      })),
      indoorForecastNoShade: open.points.map((p) => ({
        ts: p.ts,
        tempC: p.indoorTempC,
      })),
      heatLoadForecast: baseTraj.points.map((p) => ({
        ts: p.ts,
        load01: p.heatLoad01,
      })),
    };
  }

  /** Mode info with German label, goal and reasoning chips (Requirement 17.1). */
  private buildModeInfo(mode: Mode | null): NonNullable<DashboardSnapshotV2['modeInfo']> {
    const id = mode ?? 'NORMAL';
    const label = MODE_LABELS_DE[id] ?? id;
    const goals: Record<string, string> = {
      NORMAL: 'Komfort halten, Energie sparen',
      SUMMER_WATCH: 'Aufkommende Hitze früh erkennen',
      ACTIVE_HEAT_PROTECTION: 'Räume aktiv verschatten',
      HEATWAVE: 'Maximaler Hitzeschutz',
      NIGHT_COOLING: 'Kühle Nachtluft nutzen',
      STORM: 'Rollläden zum Schutz auffahren',
      VACATION: 'Schutz bei Abwesenheit',
      MAINTENANCE: 'Wartung – Automatik pausiert',
    };
    const goal = goals[id] ?? 'Komfort halten';

    // Prefer the FSM's structured explanation from the last cycle — it names
    // the exact deciding factor (value vs. threshold). Fall back to generic
    // chips before the first cycle has run.
    const explanation = this.runtime.lastModeExplanation;
    const reasons: string[] = [];
    let decidedBy: string | undefined;
    if (explanation !== null && mode !== null) {
      decidedBy = explanation.decidedBy;
      reasons.push(...explanation.factors);
    } else {
      const heatLoad = this.computeHeatLoad(new Date());
      reasons.push(`Gefühlte Wärme ${Math.round(heatLoad.load01 * 100)} %`);
    }
    // Supplementary context that applies regardless of the FSM branch.
    if (this.runtime.state.stormHoldUntil !== null && id !== 'STORM') {
      reasons.push('Sturm-Haltezeit aktiv');
    }
    if (!this.config.automationEnabled) {
      reasons.push('Master-Automatik aus (nur Anzeige)');
    }
    if (this.runtime.state.userIntent.vacation && id !== 'VACATION') {
      reasons.push('Urlaubsmodus');
    }
    return {
      id,
      label,
      goal,
      reasons,
      ...(decidedBy !== undefined ? { decidedBy } : {}),
    };
  }

  /**
   * Forecast timeline cards: the live "now" card plus full even clock hours
   * (00, 02, 04 …) out to +24 h (Requirement 11). Each card also carries an
   * estimated PV yield derived from the radiation forecast so the dashboard
   * can plot an expected-PV line next to the measured history.
   */
  private buildForecastTimeline(
    now: Date,
  ): NonNullable<DashboardSnapshotV2['forecastTimeline']> {
    const series = this.openMeteo.getForecastSeries();
    const out: NonNullable<DashboardSnapshotV2['forecastTimeline']> = [];
    const pvPeak = this.config.fusionSolar.pvPeakKwp;

    // Nearest hourly sample to a target instant.
    const nearest = (t: Date): (typeof series)[number] | null => {
      if (series.length === 0) return null;
      let best = series[0]!;
      let bestDiff = Math.abs(Date.parse(best.ts) - t.getTime());
      for (const p of series) {
        const d = Math.abs(Date.parse(p.ts) - t.getTime());
        if (d < bestDiff) {
          best = p;
          bestDiff = d;
        }
      }
      return best;
    };

    // Target instants: the live "now", then every even clock hour up to +24 h.
    const targets: Date[] = [new Date(now)];
    const first = new Date(now);
    first.setMinutes(0, 0, 0);
    first.setHours(first.getHours() + 1);
    if (first.getHours() % 2 !== 0) {
      first.setHours(first.getHours() + 1);
    }
    const horizonMs = now.getTime() + 24 * 3_600_000;
    for (let t = first.getTime(); t <= horizonMs; t += 2 * 3_600_000) {
      targets.push(new Date(t));
    }

    for (const t of targets) {
      const p = nearest(t);
      const sun = getSunPosition(t, this.config.location);
      const cloud01 = p?.cloudCover01 ?? null;
      const radiationWm2 = p?.radiationWm2 !== null && p?.radiationWm2 !== undefined
        ? Math.round(p.radiationWm2)
        : 0;
      const tempC = p?.tempC !== null && p?.tempC !== undefined ? Math.round(p.tempC) : 0;
      const isDay = sun.isUp || radiationWm2 > 0;
      // Expected PV yield ≈ installed peak × normalised radiation × derate.
      // Radiation already accounts for cloud cover, so no extra cloud term.
      const pvForecastKw =
        pvPeak > 0 && radiationWm2 > 0
          ? Math.round(Math.min(pvPeak, pvPeak * (radiationWm2 / 1000) * 0.9) * 100) / 100
          : 0;
      out.push({
        ts: t.toISOString(),
        weatherIcon: weatherIconFor(p?.weatherCode ?? null, isDay, cloud01),
        tempC,
        radiationWm2,
        // Prefer real precipitation probability; fall back to cloud cover.
        precipitationOrCloud01: p?.precipProb01 ?? cloud01 ?? 0,
        pvForecastKw,
      });
    }
    return out;
  }

  /** Forecast trajectories per room from the live plan (`/api/forecast`). */
  private buildForecastResponse(
    roomId: string | undefined,
    hours: number,
  ): ForecastResponse[] {
    const plannerResult = this.lastPlannerResult;
    if (plannerResult === undefined) {
      return [];
    }
    const out: ForecastResponse[] = [];
    for (const [rid, traj] of plannerResult.trajectories) {
      if (roomId !== undefined && rid !== roomId) {
        continue;
      }
      const cutoffMs = Date.now() + hours * 3_600_000;
      out.push({
        roomId: rid,
        hours,
        points: traj.points
          .filter((p) => Date.parse(p.ts) <= cutoffMs)
          .map((p) => ({
            ts: p.ts,
            indoorTempC: p.indoorTempC,
            heatLoad01: p.heatLoad01,
          })),
        uncertain: traj.uncertain,
        confidence01: traj.confidence01,
      });
    }
    return out;
  }

  /** Current position plan + planned actions from the live plan (`/api/plan`). */
  private buildPlanResponse(): PlanResponse | null {
    const plannerResult = this.lastPlannerResult;
    if (plannerResult === undefined) {
      return null;
    }
    return {
      ts: new Date().toISOString(),
      windows: Array.from(plannerResult.windows.values()).map((p) => ({
        windowId: p.windowId,
        target01: p.target01,
        noMoveNeeded: p.noMoveNeeded,
      })),
      plannedActions: [...plannerResult.plannedActions],
    };
  }

  private async buildLearningSnapshot(): Promise<LearningSnapshot> {
    const records: Awaited<ReturnType<DashboardServerDeps['readHistory']>> = [];
    for await (const rec of readRecords<DecisionRecord>({
      historyPath: this.historyPath(),
    })) {
      records.push(rec);
    }
    const windowsByRoom: Record<string, string[]> = {};
    for (const w of this.config.windows) {
      const arr = windowsByRoom[w.roomId];
      if (arr === undefined) windowsByRoom[w.roomId] = [w.id];
      else arr.push(w.id);
    }
    const samples: RoomTempSample[] = [];
    const metrics = aggregateDailyMetrics(records, samples, {
      timezone: this.config.location.timezone,
      windowsByRoom,
    });
    const recommendations = deriveRecommendations(metrics, this.config, {
      now: new Date(),
      minDays: 5,
    });
    return { metrics, recommendations, computedAt: new Date().toISOString() };
  }

  private async applyRecommendation(
    id: string,
  ): Promise<{
    ok: boolean;
    appliedPatch?: { path: (string | number)[]; from: unknown; to: unknown };
  }> {
    const snap = await this.buildLearningSnapshot();
    const rec = snap.recommendations.find((r) => r.id === id);
    if (rec === undefined || rec.suggestedConfigPatch === undefined) {
      return { ok: false };
    }
    const patch = rec.suggestedConfigPatch;
    const clone = structuredClone(this.config) as Config;
    let cursor: unknown = clone;
    for (let i = 0; i < patch.path.length - 1; i += 1) {
      const key = patch.path[i] as string | number;
      cursor = (cursor as Record<string | number, unknown>)[key];
      if (cursor === null || cursor === undefined) return { ok: false };
    }
    const last = patch.path[patch.path.length - 1] as string | number;
    (cursor as Record<string | number, unknown>)[last] = patch.to;
    const validated = safeParseConfig(clone);
    if (!validated.success) return { ok: false };
    await writeConfig(validated.data, { configPath: this.configPath() });
    this.config = validated.data;
    return { ok: true, appliedPatch: patch };
  }

  // --- helpers ----------------------------------------------------------
  private configPath(): string {
    return path.join(this.env.dataDir, 'config.json');
  }
  private statePath(): string {
    return path.join(this.env.dataDir, 'state.json');
  }
  private historyPath(): string {
    return path.join(this.env.dataDir, 'history.ndjson');
  }
  private trendsPath(): string {
    return path.join(this.env.dataDir, 'trends.ndjson');
  }

  private learningPath(): string {
    return path.join(this.env.dataDir, 'learning.ndjson');
  }

  private calibrationPath(): string {
    return path.join(this.env.dataDir, 'calibration.ndjson');
  }

  private irrigationPath(): string {
    return path.join(this.env.dataDir, 'irrigation.json');
  }

  /**
   * Current PV surplus (kW) = grid export = max(0, −meterActivePower). Used by
   * the irrigation PV-preferred scheduler. Null when FusionSolar has no value.
   */
  private pvSurplusKw(): number | null {
    const meterW = this.fusionSolar.getValue('meterActivePower');
    if (meterW === null || !Number.isFinite(meterW.value)) return null;
    return Math.max(0, -meterW.value) / 1000;
  }

  // --- learning module helpers -----------------------------------------

  /** Recompute the per-room learned model from the persisted history. */
  private recomputeLearnedModels(): void {
    const byRoom = new Map<string, DailyObservation[]>();
    for (const o of this.learnHistory) {
      const list = byRoom.get(o.roomId) ?? [];
      list.push(o);
      byRoom.set(o.roomId, list);
    }
    this.learnedModels = new Map();
    for (const room of this.config.rooms) {
      const obs = byRoom.get(room.id) ?? [];
      this.learnedModels.set(
        room.id,
        learnRoomModel(room.id, obs, room.targets.warning_c),
      );
    }
  }

  /** Learned comfort-bias map for the planner (roomId → K). */
  private learnedBiasByRoom(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [id, model] of this.learnedModels) {
      if (model.comfortBiasC !== 0) {
        out[id] = model.comfortBiasC;
      }
    }
    return out;
  }

  /**
   * Fold this cycle's (sun, PV) sample into the PV-orientation accumulator,
   * recompute the learned azimuth, and persist. Best-effort: a persistence
   * failure is logged but never blocks the cycle.
   */
  private async accumulatePvOrientationSample(
    now: Date,
    pvSmoothedKw: number | null,
  ): Promise<void> {
    const sun = getSunPosition(now, this.config.location);
    const next = accumulatePvOrientation(this.pvOrientState, {
      sunAzimuthDeg: sun.azimuthDeg,
      sunElevationDeg: sun.elevationDeg,
      sunIsUp: sun.isUp,
      pvKw: pvSmoothedKw,
    });
    if (next === this.pvOrientState) {
      return; // sample ignored (night / low PV) — nothing to persist.
    }
    this.pvOrientState = next;
    this.recomputePvOrientation();
    try {
      await writePvOrientation(this.pvOrientState, { dataDir: this.env.dataDir });
    } catch (err) {
      this.logBuffer.append('warn', 'pvOrientationStore.write failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Recompute the learned PV array azimuth from the running accumulator. */
  private recomputePvOrientation(): void {
    const est = estimatePvOrientation(this.pvOrientState);
    this.pvArrayAzimuthDeg = est?.azimuthDeg ?? null;
  }

  /** Recompute the per-room calibrated inertia from the persisted history. */
  private recomputeCalibration(): void {
    const byRoom = new Map<string, CalibrationObservation[]>();
    for (const o of this.calibHistory) {
      const list = byRoom.get(o.roomId) ?? [];
      list.push(o);
      byRoom.set(o.roomId, list);
    }
    this.calibratedModels = new Map();
    for (const room of this.config.rooms) {
      const obs = byRoom.get(room.id) ?? [];
      const base = room.thermalInertiaMinutes ?? 120;
      this.calibratedModels.set(
        room.id,
        calibrateRoomInertia(room.id, base, obs),
      );
    }
  }

  /** Calibrated inertia map for the planner (roomId → minutes); only entries that differ from the configured value. */
  private calibratedInertiaByRoom(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [id, m] of this.calibratedModels) {
      if (m.factor !== 1) {
        out[id] = m.inertiaMinutes;
      }
    }
    return out;
  }

  /** Persist the accumulated calibration observations for `dayKey` and re-calibrate. */
  private async flushCalibrationDay(dayKey: string): Promise<void> {
    const batch: CalibrationObservation[] = [];
    for (const room of this.config.rooms) {
      const acc = this.calibAccum.get(room.id);
      if (acc === undefined) {
        continue;
      }
      batch.push({
        date: dayKey,
        roomId: room.id,
        actualPeakC: acc.actualPeakC,
        predictedPeakC: acc.predictedPeakC,
      });
    }
    if (batch.length === 0) {
      return;
    }
    try {
      await appendCalibrationObservations(batch, {
        calibrationPath: this.calibrationPath(),
      });
      this.calibHistory.push(...batch);
      await compactCalibration(this.calibHistory, {
        calibrationPath: this.calibrationPath(),
        keepDays: 60,
      });
      this.calibHistory = await readCalibrationObservations({
        calibrationPath: this.calibrationPath(),
      });
      this.recomputeCalibration();
      this.logBuffer.append('info', 'calibration day flushed', {
        day: dayKey,
        rooms: batch.length,
      });
    } catch (err) {
      this.logBuffer.append('warn', 'calibration flush failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Local calendar-day key (YYYY-MM-DD in the configured timezone). */
  private localDayKey(now: Date): string {
    // en-CA yields YYYY-MM-DD; pin the timezone so the rollover is local.
    return now.toLocaleDateString('en-CA', { timeZone: this.config.location.timezone });
  }

  /**
   * Accumulate this cycle's readings into the current day's per-room learning
   * aggregate; on a local-day rollover, flush the previous day's observations
   * to the store and recompute the learned models.
   */
  private async recordLearning(now: Date, snapshot: CycleSnapshot, out: CycleOutputs): Promise<void> {
    const dayKey = this.localDayKey(now);
    if (this.learnAccumDay === '') {
      this.learnAccumDay = dayKey;
    } else if (dayKey !== this.learnAccumDay) {
      await this.flushLearningDay(this.learnAccumDay);
      await this.flushCalibrationDay(this.learnAccumDay);
      this.learnAccum.clear();
      this.calibAccum.clear();
      this.learnAccumDay = dayKey;
    }

    const outdoor = this.outdoorMeanC(now);
    const forecastMax = this.forecastDailyMaxC(now);
    const pvKw = this.resolvePvKw(now);
    // Moves dispatched this cycle, per room.
    const movesByRoom = new Map<string, number>();
    for (const wd of out.decisionRecord.windowDecisions) {
      if (!wd.moved) {
        continue;
      }
      const win = this.config.windows.find((w) => w.id === wd.windowId);
      if (win === undefined) {
        continue;
      }
      movesByRoom.set(win.roomId, (movesByRoom.get(win.roomId) ?? 0) + 1);
    }

    const max = (a: number | null, b: number | null): number | null => {
      if (a === null) return b;
      if (b === null) return a;
      return Math.max(a, b);
    };

    for (const room of this.config.rooms) {
      const cur = this.learnAccum.get(room.id) ?? {
        indoorPeakC: null,
        outdoorMaxC: null,
        forecastMaxC: null,
        pvPeakKw: null,
        moves: 0,
      };
      const roomData = snapshot.rooms.get(room.id);
      const indoor = roomData?.tempC ?? null;
      this.learnAccum.set(room.id, {
        indoorPeakC: max(cur.indoorPeakC, indoor),
        outdoorMaxC: max(cur.outdoorMaxC, outdoor),
        forecastMaxC: max(cur.forecastMaxC, forecastMax),
        pvPeakKw: max(cur.pvPeakKw, pvKw),
        moves: cur.moves + (movesByRoom.get(room.id) ?? 0),
      });

      // Self-calibration: accumulate actual vs. model-predicted indoor peak.
      const traj = out.plannerResult?.trajectories.get(room.id);
      let predictedPeak: number | null = null;
      if (traj !== undefined) {
        for (const p of traj.points) {
          predictedPeak = max(predictedPeak, p.indoorTempC);
        }
      }
      const cal = this.calibAccum.get(room.id) ?? {
        actualPeakC: null,
        predictedPeakC: null,
      };
      this.calibAccum.set(room.id, {
        actualPeakC: max(cal.actualPeakC, indoor),
        predictedPeakC: max(cal.predictedPeakC, predictedPeak),
      });
    }

    // Impact tracker: a cycle counts as "comfortable" when no room exceeds its
    // warning ceiling. Reset on day rollover (in-memory, "heute").
    if (this.impactDay !== dayKey) {
      this.impactDay = dayKey;
      this.impactCyclesToday = 0;
      this.impactComfortableToday = 0;
    }
    this.impactCyclesToday += 1;
    let anyOver = false;
    for (const room of this.config.rooms) {
      const rd = snapshot.rooms.get(room.id);
      if (rd?.tempC != null && rd.tempC > room.targets.warning_c) {
        anyOver = true;
        break;
      }
    }
    if (!anyOver) {
      this.impactComfortableToday += 1;
    }
  }

  /** Persist the accumulated observations for `dayKey` and re-learn. */
  private async flushLearningDay(dayKey: string): Promise<void> {
    const batch: DailyObservation[] = [];
    for (const room of this.config.rooms) {
      const acc = this.learnAccum.get(room.id);
      if (acc === undefined) {
        continue;
      }
      batch.push({
        date: dayKey,
        roomId: room.id,
        indoorPeakC: acc.indoorPeakC,
        outdoorMaxC: acc.outdoorMaxC,
        forecastMaxC: acc.forecastMaxC,
        pvPeakKw: acc.pvPeakKw,
        moves: acc.moves,
      });
    }
    if (batch.length === 0) {
      return;
    }
    try {
      await appendLearningObservations(batch, { learningPath: this.learningPath() });
      this.learnHistory.push(...batch);
      // Keep memory + file bounded to the retention window.
      await compactLearning(this.learnHistory, { learningPath: this.learningPath(), keepDays: 60 });
      this.learnHistory = await readLearningObservations({ learningPath: this.learningPath() });
      this.recomputeLearnedModels();
      this.logBuffer.append('info', 'learning day flushed', {
        day: dayKey,
        rooms: batch.length,
      });
    } catch (err) {
      this.logBuffer.append('warn', 'learning flush failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Build the "Wirkung" (impact) block — measurable benefit of the plugin. */
  private buildImpact(pvSelfUse01: number | undefined): NonNullable<DashboardSnapshotV2['impact']> {
    const comfortShareToday01 =
      this.impactCyclesToday > 0
        ? Math.round((this.impactComfortableToday / this.impactCyclesToday) * 100) / 100
        : null;
    let movesSum = 0;
    let anyMoves = false;
    for (const m of this.learnedModels.values()) {
      if (Number.isFinite(m.avgMovesPerDay)) {
        movesSum += m.avgMovesPerDay;
        anyMoves = true;
      }
    }
    const avgMovesPerDay = anyMoves ? Math.round(movesSum * 10) / 10 : null;
    const calibratedRooms = Array.from(this.calibratedModels.values()).filter(
      (m) => m.factor !== 1,
    ).length;
    const tunedRooms = Array.from(this.learnedModels.values()).filter(
      (m) => m.comfortBiasC !== 0,
    ).length;
    const learnDays = new Set(this.learnHistory.map((o) => o.date)).size;
    // Forecast accuracy (V1.8, closed-loop validation): mean absolute error
    // between the predicted and the actually observed indoor peak.
    const accErrors = this.calibHistory
      .filter(
        (o) =>
          o.actualPeakC !== null &&
          Number.isFinite(o.actualPeakC) &&
          o.predictedPeakC !== null &&
          Number.isFinite(o.predictedPeakC),
      )
      .map((o) => Math.abs((o.actualPeakC as number) - (o.predictedPeakC as number)));
    const forecastAccuracyC =
      accErrors.length > 0
        ? Math.round((accErrors.reduce((a, b) => a + b, 0) / accErrors.length) * 10) / 10
        : null;
    return {
      comfortShareToday01,
      avgMovesPerDay,
      calibratedRooms,
      tunedRooms,
      learnDays,
      ...(forecastAccuracyC !== null ? { forecastAccuracyC } : {}),
      ...(pvSelfUse01 !== undefined ? { pvSelfUse01 } : {}),
    };
  }

  /** Build the dashboard learning block from the current learned models. */
  private buildLearning(): NonNullable<DashboardSnapshotV2['learning']> {
    const days = new Set(this.learnHistory.map((o) => o.date)).size;
    const rooms = this.config.rooms.map((room) => {
      const m =
        this.learnedModels.get(room.id) ??
        learnRoomModel(room.id, [], room.targets.warning_c);
      const cal = this.calibratedModels.get(room.id);
      return {
        id: room.id,
        name: room.name,
        sampleDays: m.sampleDays,
        avgIndoorPeakC: m.avgIndoorPeakC,
        avgOvershootC: m.avgOvershootC,
        avgMovesPerDay: m.avgMovesPerDay,
        comfortBiasC: m.comfortBiasC,
        recommendationLevel: m.recommendationLevel,
        recommendation: m.recommendation,
        ...(cal !== undefined && cal.factor !== 1
          ? {
              calibratedInertiaMinutes: cal.inertiaMinutes,
              calibrationNote: cal.note,
            }
          : {}),
      };
    });
    return { days, rooms };
  }
  private computeReadiness(): PluginReadinessStatusValue {
    if (this.config.rooms.length === 0 || this.config.windows.length === 0) {
      return PluginReadinessStatus.CONFIG_REQUIRED;
    }
    return PluginReadinessStatus.READY;
  }
}

export async function main(): Promise<HeatShieldBoot> {
  const baseEnv = readEnv();
  await fs.mkdir(baseEnv.dataDir, { recursive: true });
  // If no env-var token is set, look for `/TOKEN` (installed mode).
  // This must run before `HeatShieldBoot` is constructed because the
  // `connect` field is only created when an auth token is present.
  let authToken = baseEnv.authToken;
  if (authToken === null && !baseEnv.noConnect) {
    authToken = await readAuthTokenFile(baseEnv.tokenPath);
  }
  const env: BootEnv = { ...baseEnv, authToken };
  const configPath = path.join(env.dataDir, 'config.json');
  const statePath = path.join(env.dataDir, 'state.json');
  const config = await readOrSeed(seedDefaultConfig, { configPath });
  const state = (await readState({ statePath })) ?? emptyRuntimeState();
  const boot = new HeatShieldBoot(env, config, state);
  await boot.start();
  const shutdown = (signal: NodeJS.Signals): void => {
    void boot.stop().finally(() => process.exit(0));
    void signal;
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  // Log line is intentionally human-readable and shows the source of
  // the auth token so the HCUweb log panel reveals at a glance
  // whether the plugin is talking to the Connect API.
  const tokenSource =
    env.noConnect
      ? 'off (HEATSHIELD_NO_CONNECT=1)'
      : env.authToken === null
        ? `MISSING (looked at env HEATSHIELD_AUTH_TOKEN and ${env.tokenPath})`
        : process.env['HEATSHIELD_AUTH_TOKEN']
          ? 'env HEATSHIELD_AUTH_TOKEN'
          : env.tokenPath;
  // eslint-disable-next-line no-console
  console.log(
    `heat shield boot complete: dashboard on ${env.port ?? config.dashboard.port}, connect-url=${env.connectUrl}, token-source=${tokenSource}`,
  );
  return boot;
}

export { HeatShieldBoot, seedDefaultConfig };

// Run when invoked as the main module (production entry point).
// Compare via Node's `pathToFileURL` so Windows drive letters and
// double-slashes in `import.meta.url` line up.
import { pathToFileURL } from 'node:url';

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void main().catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error('heat shield boot failed', err);
    process.exit(1);
  });
}
