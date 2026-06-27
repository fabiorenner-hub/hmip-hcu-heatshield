/**
 * SPA-side mirrors of the dashboard wire types (Tasks 11.1–11.5).
 *
 * The server-side `DashboardSnapshot` lives in
 * `src/plugin/dashboard/server.ts` and embeds engine types
 * (`Mode`, `UserIntentState`, …). The SPA bundle is built with
 * `tsconfig.spa.json` (DOM lib only, no Node types) and is shipped
 * inside the container next to the server. Re-exporting the
 * server-side types directly would drag the engine, the persistence
 * layer, and Fastify into the bundle, so we duplicate the shapes
 * here as plain interfaces. The duplication is small (≈30 LOC) and
 * intentional — these are wire types, not behaviour.
 */

export type Mode =
  | 'NORMAL'
  | 'SUMMER_WATCH'
  | 'ACTIVE_HEAT_PROTECTION'
  | 'HEATWAVE'
  | 'NIGHT_COOLING'
  | 'STORM'
  | 'VACATION'
  | 'MAINTENANCE';

export type PluginReadinessStatusValue = 'CONFIG_REQUIRED' | 'ERROR' | 'READY';

export interface UserIntentState {
  paused: boolean;
  pauseUntil: string | null;
  vacation: boolean;
}

export interface DashboardSnapshotRoom {
  id: string;
  name?: string;
  tempC: number | null;
}

export interface DashboardSnapshotWindow {
  id: string;
  /** Human label: "<Raum> – <Gerät> (…1234)". */
  name?: string;
  currentLevel01: number | null;
  manualOverrideUntil: string | null;
  lastDecisionMode: Mode | null;
}

/**
 * One resolved signal value for the 360° overview. `state`
 * classifies freshness (green/amber/red dot in the UI).
 */
export interface SignalValue {
  value: number | null;
  ts: string | null;
  state: 'fresh' | 'soon' | 'stale' | 'unknown';
  /** Whether a source binding exists for this signal (vs. unassigned). */
  bound?: boolean;
}

export interface DashboardSnapshot {
  ts: string;
  mode: Mode | null;
  rooms: DashboardSnapshotRoom[];
  windows: DashboardSnapshotWindow[];
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
  automationEnabled?: boolean;
  /** Resolved global signal values for the 360° overview. Optional. */
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
  /** PV-led feels-like summary for the 360° overview. Optional. */
  feelsLike?: {
    effectiveLoad01: number;
    feelsLikeC: number | null;
  };
  /** Multi-hour signal trends (slopes). Optional. */
  trends?: {
    outdoorCph: number | null;
    pvKwph: number | null;
  };
  /** Number of unread in-app messages (envelope badge). Optional. */
  unreadMessages?: number;
  // --- predictive-control-dashboard V2 blocks (all optional) ----------
  modeInfo?: ModeInfo;
  environment?: Environment;
  facades?: { N: number; E: number; S: number; W: number };
  pvSonnenindex01?: number;
  /**
   * PV self-consumption fraction in [0,1] (Eigenverbrauch). Derived
   * server-side from FusionSolar `inputPower` vs `meterActivePower`.
   * Omitted when not derivable (e.g. no generation) — the UI then hides
   * the line rather than showing a dash.
   */
  pvSelfUse01?: number;
  /** PV energy produced today in kWh, when the source provides it. */
  pvTodayKwh?: number;
  /**
   * Current outdoor temperature from the internet weather service
   * (OpenMeteo), in °C, when available alongside the local sensor. Lets
   * the outdoor KPI card show a "Lokaler Sensor X · Wetterdienst Y"
   * comparison. Omitted when no internet value is present.
   */
  outdoorTempInternetC?: number | null;
  /**
   * Highest average indoor temperature observed today (since local
   * midnight), in °C. Surfaced as the "Peak" readout on the indoor card.
   */
  indoorPeakTempC?: number | null;
  roomsDetail?: RoomDetail[];
  forecastTimeline?: ForecastTimelineCard[];
  /** 15-min precipitation outlook for the next ~2 h (Open-Meteo minutely_15). */
  precipNowcast?: Array<{ ts: string; precipMm: number }>;
  /** Active DWD warnings; `active` (max level ≥ 3) drives the Alert-Mode UI. */
  weatherAlert?: WeatherAlert;
  plannedActions?: PlannedAction[];
  trajectories?: Trajectories;
  ventilation?: VentilationAdvice;
  cooling?: CoolingAdvice;
  learning?: LearningInfo;
  impact?: ImpactInfo;
  gardena?: GardenaInfo;
  irrigation?: IrrigationInfo;
}

/**
 * Gardena smart-irrigation devices bridged into the HCU by the Gardena
 * Connect plugin. Present only when at least one Gardena sensor/valve is
 * visible. Mirrors the server `DashboardSnapshotV2['gardena']`.
 */
export interface GardenaInfo {
  sensors: Array<{
    deviceId: string;
    name: string;
    soilMoisturePct: number | null;
    soilTempC: number | null;
    lux: number | null;
    ambientTempC?: number | null;
    batteryPct?: number | null;
  }>;
  valves: Array<{
    deviceId: string;
    name: string;
    channelIndex: number;
    on: boolean | null;
    activity?: string | null;
    source?: 'cloud' | 'hcu';
  }>;
  cloud?: boolean;
  connected?: boolean;
  error?: string | null;
}

/** SPA mirror of the irrigation controller's snapshot. */
export interface IrrigationZoneView {
  id: string;
  name: string;
  enabled: boolean;
  valveOn: boolean | null;
  activity: string | null;
  hasValve: boolean;
  soilMoisturePct: number | null;
  soilTempC: number | null;
  depletionMm: number;
  availablePct: number;
  rawMm: number;
  tawMm: number;
  dailyNeedMm: number;
  dailySecondsUsed: number;
  windowStartHour: number;
  windowEndHour: number;
  openUntilTs: string | null;
  nextActionLabel: string;
  blockedBy: string | null;
  hoursUntilNext: number | null;
  nextWateringTs: string | null;
  plannedNextSeconds: number | null;
  forecastPoints: Array<{ ts: string; availablePct: number }>;
  learned: {
    kcFactor: number;
    precipRateFactor: number;
    sampleDays: number;
    emitterFault: boolean;
    note: string;
  };
  plant: string;
  priority: string;
}

export interface IrrigationInfo {
  enabled: boolean;
  mode: string;
  autoMode: boolean;
  cloud: boolean;
  connected: boolean;
  error: string | null;
  et0TodayMm: number | null;
  rainTodayMm: number | null;
  rainForecastMm: number | null;
  pvSurplusKw: number | null;
  mowerActive: boolean;
  totalSecondsUsedToday: number;
  zones: IrrigationZoneView[];
  plan: IrrigationPlanEntryView[];
}

/** One editable day-ahead plan entry (mirrors controller IrrigationPlanView). */
export interface IrrigationPlanEntryView {
  id: string;
  zoneId: string;
  zoneName: string;
  startTs: string;
  durationMin: number;
  enabled: boolean;
  source: 'auto' | 'manual';
  done: boolean;
}

/** Per-room learned shading model (mirrors engine/learning/shadeLearner.ts). */
export interface LearnedRoomInfo {
  id: string;
  name: string;
  sampleDays: number;
  avgIndoorPeakC: number | null;
  avgOvershootC: number | null;
  avgMovesPerDay: number;
  comfortBiasC: number;
  recommendationLevel: 'shade_earlier' | 'allow_more_light' | 'balanced' | 'insufficient_data';
  recommendation: string;
  /** Calibrated thermal inertia (min) when self-calibration adjusted it. */
  calibratedInertiaMinutes?: number;
  /** Human note describing the calibration adjustment. */
  calibrationNote?: string;
}

export interface LearningInfo {
  days: number;
  rooms: LearnedRoomInfo[];
}

/** "Wirkung" / impact metrics (mirrors index.ts buildImpact). */
export interface ImpactInfo {
  comfortShareToday01: number | null;
  avgMovesPerDay: number | null;
  calibratedRooms: number;
  tunedRooms: number;
  learnDays: number;
  /** Mean |predicted − actual| indoor peak (°C) over recent days. Optional. */
  forecastAccuracyC?: number;
  pvSelfUse01?: number;
}

/** Cooling advice level (mirrors engine/coolingAdvice.ts). */
export type CoolAdviceLevel =
  | 'cool_now'
  | 'cool_grid'
  | 'precool'
  | 'no_cooling'
  | 'neutral';

export interface CoolingAdvice {
  level: CoolAdviceLevel;
  headline: string;
  detail: string;
  pvSurplusKw: number | null;
}

/** Ventilation advice level (mirrors engine/ventilationAdvice.ts). */
export type VentAdviceLevel =
  | 'air_now'
  | 'air_possible'
  | 'close_window'
  | 'keep_closed'
  | 'neutral';

export interface VentAdviceItem {
  level: VentAdviceLevel;
  headline: string;
  detail: string;
}

export interface VentilationAdvice {
  overall: VentAdviceItem;
  rooms: Array<{ id: string; name: string } & VentAdviceItem>;
}

/** Planned-action lifecycle state (mirrors positionSelector). */
export type PlannedActionState =
  | 'recommended'
  | 'scheduled'
  | 'executing'
  | 'completed'
  | 'blocked'
  | 'manuallyOverridden';

/** A single planned shutter action (predictive-control-dashboard). */
export interface PlannedAction {
  windowId: string;
  scheduledTs: string;
  targetPercent: number;
  reason: string;
  state: PlannedActionState;
}

/** A displayed value with provenance + confidence (Requirement 15.2). */
export interface ValueWithQuality {
  value: number | null;
  origin: 'measured' | 'forecast' | 'estimated';
  source: string;
  confidence01: number;
}

export type FacadeKey = 'N' | 'E' | 'S' | 'W';

export interface ModeInfo {
  id: string;
  label: string;
  goal: string;
  reasons: string[];
  /** One-line German headline naming the deciding factor for the mode. */
  decidedBy?: string;
}

export interface Environment {
  radiationWm2: ValueWithQuality;
  uvIndex: ValueWithQuality;
  windMs: ValueWithQuality;
  humidity01: ValueWithQuality;
}

export interface RoomDetail {
  id: string;
  name: string;
  /** Free-form floor/level label from config (e.g. "KG", "EG", "OG", "DG"). */
  floor?: string;
  facade: FacadeKey;
  shutterPercent: number;
  indoorTempC: number | null;
  trend: 'up' | 'down' | 'flat';
  nextAction: PlannedAction | null;
  status: PlannedActionState;
  /** True when at least one window/contact in the room is open or tilted. */
  windowOpen?: boolean;
  /** Window orientation in degrees (0=N,90=E,180=S,270=W) for compass ordering. */
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
   * (future = active). While active the engine holds the position, so the
   * timeline/forecast stay put. Absent/null = no override.
   */
  manualOverrideUntil?: string | null;
  /**
   * Predicted shutter percent (0=open … 95/100=closed) over the next ~12 h,
   * hourly. Drives the scrub-based 12 h shutter preview in the house twin.
   */
  shutterForecast?: Array<{ ts: string; percent: number }>;
}

export interface WeatherWarning {
  level: number;
  event: string;
  headline: string;
  description: string;
  instruction: string;
  start: string | null;
  end: string | null;
}

export interface WeatherAlert {
  active: boolean;
  maxLevel: number;
  region: string;
  updatedTs: string;
  warnings: WeatherWarning[];
}

export interface ForecastTimelineCard {
  ts: string;
  weatherIcon: string;
  tempC: number;
  radiationWm2: number;
  precipitationOrCloud01: number;
  /** Estimated PV yield (kW) from the radiation forecast. Optional. */
  pvForecastKw?: number;
}

export interface Trajectories {
  indoorForecastWithShade: Array<{ ts: string; tempC: number }>;
  indoorForecastNoShade: Array<{ ts: string; tempC: number }>;
  heatLoadForecast: Array<{ ts: string; load01: number }>;
}

/** In-app notification message kind. */
export type MessageKind = 'ventilate' | 'open' | 'close' | 'weather' | 'info';

/** In-app notification message (mirrors `shared/message-schema.ts`). */
export interface Message {
  id: string;
  ts: string;
  kind: MessageKind;
  title: string;
  body: string;
  read: boolean;
}

/**
 * Server-Sent-Event payload as published on `GET /api/stream`. The
 * `type` discriminator is free-form on purpose — the orchestrator
 * publishes domain events such as `cycle.completed`, `mode.changed`,
 * and the SPA branches on the string. We also recognise a synthetic
 * `state.snapshot` event so the polling fallback and the SSE handler
 * can share the same store-update path.
 */
export interface DashboardStreamEvent {
  type: string;
  payload: unknown;
}

/**
 * One factor that contributes to a window's risk score. Mirrors the
 * `factors` map produced by `engine/risk.ts`; we keep the eight
 * canonical names as a closed union so the stacked risk bar can
 * iterate over them in stable colour order.
 */
export type RiskFactorName =
  | 'sunFactor'
  | 'roomTempFactor'
  | 'windowTypeFactor'
  | 'forecastTempFactor'
  | 'pvFactor'
  | 'radiationFactor'
  | 'outdoorTempFactor'
  | 'priorityFactor';

export interface WindowRiskBreakdown {
  windowId: string;
  factors: Partial<Record<RiskFactorName, number>>;
  weights: Partial<Record<RiskFactorName, number>>;
  risk: number;
  rawTarget: number;
  finalTarget: number;
  mode: Mode | null;
}
