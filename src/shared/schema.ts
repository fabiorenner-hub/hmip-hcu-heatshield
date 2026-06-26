/**
 * Heat Shield — single source of truth for the configuration shape.
 *
 * This module exposes the Zod schemas that describe the contents of
 * `/data/config.json`. It is the only place where the structure of a
 * `Config` is defined; the rest of the codebase derives types from these
 * schemas via `z.infer<...>` (see `src/shared/types.ts` — added in Task 2.2).
 *
 * Field naming policy: identifiers in this schema are English. The
 * German-language strings live exclusively in user-facing `friendlyName`
 * payloads (Connect API DiscoverResponse / dashboard copy), not in the
 * config keys themselves.
 *
 * Defaults policy: every numeric / boolean threshold that has a documented
 * default in `design.md` or `rolladen-hitzeschutz-regelwerk-dokumentation.md`
 * §19 is wired up via `.default(...)` so a partial config still validates to
 * a sensible shape. Fields without a documented default (e.g. `location`,
 * `globalSignals.outdoorTemp`) stay required — the wizard fills them in.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// SourceRef — discriminated union over the four supported signal origins.
// ---------------------------------------------------------------------------

const SourceRefStaticSchema = z.object({
  kind: z.literal('static'),
  value: z.number(),
});

const SourceRefHmipSchema = z.object({
  kind: z.literal('hmip'),
  deviceId: z.string().min(1),
  feature: z.string().min(1),
});

const SourceRefFusionSchema = z.object({
  kind: z.literal('fusion'),
  field: z.enum([
    'inputPower',
    'activePower',
    'batterySoc',
    'batteryChargeDischargePower',
    'meterActivePower',
    'internalTemp',
  ]),
});

const SourceRefOpenMeteoSchema = z.object({
  kind: z.literal('openmeteo'),
  feature: z.enum([
    'actualTemperature',
    'humidity',
    'illumination',
    'windSpeed',
    'raining',
    'sunshineDuration',
  ]),
  // OpenMeteo plugin's CLIMATE_SENSOR id, resolved from the HCU device list.
  deviceId: z.string().min(1),
});

// Direct OpenMeteo HTTP source (Wave 5): values polled straight from
// open-meteo.com, independent of the HCU plugin. No deviceId — the
// adapter is keyed only on the requested field.
const SourceRefOpenMeteoHttpSchema = z.object({
  kind: z.literal('openmeteo_http'),
  field: z.enum([
    'temperature',
    'humidity',
    'cloudCover',
    'radiation',
    'windSpeed',
    'precipitation',
    'maxTempToday',
  ]),
});

export const SourceRefSchema = z.discriminatedUnion('kind', [
  SourceRefStaticSchema,
  SourceRefHmipSchema,
  SourceRefFusionSchema,
  SourceRefOpenMeteoSchema,
  SourceRefOpenMeteoHttpSchema,
]);

// ---------------------------------------------------------------------------
// Signal binding — primary source plus optional fallback and stale window.
// ---------------------------------------------------------------------------

export const SignalBindingSchema = z.object({
  primary: SourceRefSchema,
  fallback: SourceRefSchema.optional(),
  staleAfterSec: z.number().int().min(60).max(3600).default(600),
});

// ---------------------------------------------------------------------------
// Room — logical zone with target temperatures and signal bindings.
// ---------------------------------------------------------------------------

export const RoomTargetsSchema = z.object({
  target_c: z.number(),
  warning_c: z.number(),
  strong_shade_c: z.number(),
  critical_c: z.number(),
});

const RoomSignalsSchema = z.object({
  indoorTemp: SignalBindingSchema.optional(),
  illumination: SignalBindingSchema.optional(),
});

export const RoomSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  // Free-form floor/level label so the layout stays fully
  // configurable (e.g. "KG", "EG", "OG", "DG", or anything the user
  // invents). Optional — rooms without a floor sort into "Sonstige".
  floor: z.string().min(1).max(40).optional(),
  priority: z.enum(['very_high', 'high', 'medium', 'low']),
  targets: RoomTargetsSchema,
  signals: RoomSignalsSchema.prefault({}),
  occupancyMode: z
    .enum(['always_priority', 'optional', 'guest_only'])
    .default('always_priority'),
  // Per-room quiet schedule (V1.5). When set, the engine dispatches NO
  // automatic move for this room's shutters before `noMoveBeforeHour` or at/
  // after `noMoveAfterHour` (local clock hours). STORM always overrides.
  // Example: noMoveBeforeHour=7, noMoveAfterHour=22 → moves only 07:00–21:59.
  noMoveBeforeHour: z.number().int().min(0).max(23).optional(),
  noMoveAfterHour: z.number().int().min(1).max(24).optional(),
  // Building thermal inertia (Thermal_Inertia) as time constant τ in minutes
  // (predictive-control-dashboard Requirement 2.2). Higher = slower indoor
  // response. Default 120 min applied at read time; optional in config.
  thermalInertiaMinutes: z.number().min(15).max(1440).optional(),
});

// ---------------------------------------------------------------------------
// Window — physical opening with shutter device + geometry + safety flags.
// ---------------------------------------------------------------------------

export const WindowSchema = z.object({
  id: z.string().min(1),
  roomId: z.string().min(1),
  // HMIP WINDOW_COVERING channel id used in HmipSystemRequest setShutterLevel.
  shutterDeviceId: z.string().min(1),
  contactDeviceId: z.string().min(1).optional(),
  // Per-window automation block. When true the engine evaluates the
  // window (risk, UI) but never dispatches a move — e.g. the shutter
  // is mechanically obstructed (AC exhaust hose clamped in the sash).
  automationBlocked: z.boolean().default(false),
  orientationDeg: z.number().min(0).max(359),
  type: z.enum(['facade', 'roof_window']),
  isDoor: z.boolean().default(false),
  canMoveWhenOpen: z.boolean().default(true),
  maxPositionWhenOpenPct: z.number().min(0).max(100).default(60),
  sunPrelookMinutes: z.number().int().min(15).max(120).default(60),
  lockoutProtection: z.boolean().default(true),
  // Maximum closing level the heat-shield logic may command during the
  // day, in [0,1] (1 = fully closed). Leaving a small gap (default 0.95
  // for façades) prevents heat building up behind a fully-closed
  // shutter. Roof windows default to 1.0 (full close is fine — the
  // glass is overhead, no trapped-air wall effect). At night the engine
  // may still fully close regardless of this cap. Optional: when unset
  // the engine applies the type-based default (0.95 façade / 1.0 roof).
  maxHeatProtectionLevel01: z.number().min(0).max(1).optional(),
  // Glazing area in m² for the solar heat-load weighting
  // (predictive-control-dashboard Requirement 2.2). Default 1.5 at read time.
  areaM2: z.number().min(0.1).max(20).optional(),
});

// ---------------------------------------------------------------------------
// Rules — concrete schemas for comfort, automation, sun (regelwerk §19),
// plus storm, night cooling, and manual override.
// ---------------------------------------------------------------------------

export const ComfortRulesSchema = z
  .object({
    // Indoor temperature at which the room is considered uncomfortably warm.
    maxIndoorTempC: z.number().default(25),
    // Pre-shading already kicks in slightly below the comfort threshold.
    preShadeTempC: z.number().default(23.5),
    // Indoor/outdoor delta required before night cooling opens shutters.
    nightCoolingDeltaC: z.number().default(1.5),
    // Offset (°C) subtracted from each room's `target_c`, `warning_c`, and
    // `strong_shade_c` while the user-driven VACATION intent is on
    // (`heatshield-control-vacation` switch). `critical_c` is *not*
    // shifted — it remains the absolute hard ceiling. The default 0.5 °C
    // matches design.md §10 ("VACATION (neu) … senkt alle target_c um
    // vacationOffsetC (Default 0.5)").
    vacationOffsetC: z.number().min(0).default(0.5),
  })
  .prefault({});

export const AutomationRulesSchema = z
  .object({
    // Engine cycle period. Range widened to allow up to 60 min between cycles
    // (V1.8) for users who want very calm operation.
    controlIntervalSeconds: z.number().int().min(180).max(3600).default(180),
    // Minimum time between two consecutive moves on the same shutter (8.1).
    // Up to 6 h so a shutter can be held very still.
    minSecondsBetweenMoves: z.number().int().min(0).max(21600).default(900),
    // Minimum |target − current| in percent before a move is dispatched (8.2).
    minPositionDeltaPct: z.number().min(0).max(100).default(15),
    // V1.8 — directional hysteresis. Closing moves (more shading = more
    // protection) use thresholds scaled by this factor, so the plugin reacts
    // faster to protect and stays lazier about re-opening. 1.0 = symmetric.
    closeEagerness: z.number().min(0.2).max(1).default(0.6),
    // Temperature hysteresis around comfort thresholds (regelwerk §15).
    temperatureHysteresisC: z.number().min(0).default(0.5),
    // PV-power hysteresis around the roof-force-close threshold.
    pvHysteresisKw: z.number().min(0).default(0.7),
    // Number of PV samples used for the smoothed signal.
    pvSmoothingSamples: z.number().int().min(1).max(60).default(3),
    // Look-ahead horizon for the forecast switch (Requirement 3.3).
    forecastHorizonMinutes: z.number().int().min(15).max(240).default(60),
    // When true, the plugin moves NO shutters automatically while the sun is
    // below the horizon (between sunset and sunrise). Morning-up / evening-
    // down is intentionally NOT the plugin's job; this toggle enforces that.
    // STORM safety force-open still overrides this (highest priority).
    pauseBetweenSunsetAndSunrise: z.boolean().default(false),
    // Global quiet hours (V1.5): during this daily interval the plugin makes
    // NO automatic shutter moves (positions are held), wrapping across
    // midnight when startHour > endHour. STORM force-open always overrides.
    quietHours: z
      .object({
        enabled: z.boolean().default(false),
        startHour: z.number().int().min(0).max(23).default(22),
        endHour: z.number().int().min(0).max(23).default(6),
      })
      .prefault({}),
  })
  .prefault({});

export const SunRulesSchema = z
  .object({
    // Sun has to be at least this high before any incidence is counted.
    minElevationDeg: z.number().min(0).max(90).default(5),
    // Maximum azimuth deviation considered "on the window" for façades.
    maxIncidenceAngleFacadeDeg: z.number().min(0).max(180).default(90),
    // Same for roof windows — slightly wider per design §10 correction.
    maxIncidenceAngleRoofDeg: z.number().min(0).max(180).default(95),
  })
  .prefault({});

// ---------------------------------------------------------------------------
// Mode thresholds (V1.8) — the °C / kW trip points of the mode FSM, now
// configurable instead of hard-coded constants. Defaults match the previous
// steering constants exactly so existing behaviour is unchanged.
// ---------------------------------------------------------------------------

export const ModeThresholdsSchema = z
  .object({
    heatwaveForecastC: z.number().default(30),
    heatwaveRoomC: z.number().default(24.5),
    activeForecastC: z.number().default(25),
    activeRoomC: z.number().default(23.5),
    summerForecastC: z.number().default(20),
    summerOutdoorC: z.number().default(18),
    summerPvKw: z.number().min(0).default(2.0),
  })
  .prefault({});

export const StormRulesSchema = z
  .object({
    // Wind speed at which all external shutters are forced open (7.3).
    thresholdMs: z.number().min(0).default(13.9),
    // Wind speed below which the storm hold may be released.
    releaseMs: z.number().min(0).default(8.0),
    // Minutes wind must stay below releaseMs before normal operation resumes.
    releaseHoldMin: z.number().int().min(0).default(10),
  })
  .prefault({});

export const NightCoolingRulesSchema = z
  .object({
    enabled: z.boolean().default(true),
    deltaC: z.number().default(1.5),
    // Offset (signed) on top of sunrise at which night cooling ends.
    reopenAtSunriseOffsetMin: z.number().int().default(-30),
  })
  .prefault({});

// ---------------------------------------------------------------------------
// Insulation (winter) — close shutters on cold nights to cut heat loss.
// The mirror image of summer night cooling: only fires when it is dark and
// the outdoor temperature is below `maxOutdoorTempC`. STORM and NIGHT_COOLING
// take precedence (the engine never both insulates and night-cools).
// ---------------------------------------------------------------------------

export const InsulationRulesSchema = z
  .object({
    enabled: z.boolean().default(false),
    // Only insulate when the outdoor temperature is at/below this (°C).
    maxOutdoorTempC: z.number().default(5),
    // How far to close for insulation in [0,1] (1 = fully closed).
    level01: z.number().min(0).max(1).default(1),
  })
  .prefault({});

// ---------------------------------------------------------------------------
// HeatLoad — PV-led feels-like model + asymmetric shading hysteresis
// (smart-shading-notifications Task 11.1). Mirrors the `HeatLoadInputs`
// weights and the shading-FSM thresholds. All values have documented
// defaults so a partial config still validates.
// ---------------------------------------------------------------------------

export const HeatLoadRulesSchema = z
  .object({
    // Driver weights for `effectiveHeatLoad01`. PV leads (Requirement 1.1).
    pvWeight: z.number().min(0).default(0.5),
    tempWeight: z.number().min(0).default(0.3),
    trendWeight: z.number().min(0).default(0.2),
    // Asymmetric hysteresis band (Requirement 3.4): separate trip points.
    activateThreshold: z.number().min(0).max(1).default(0.45),
    releaseThreshold: z.number().min(0).max(1).default(0.3),
    // Minimum minutes the release condition must hold (Requirement 3.2/3.3).
    releaseHoldMinutes: z.number().int().min(0).default(60),
    // Rolling trend window in hours (Requirement 6.1).
    trendWindowHours: z.number().min(0.5).max(24).default(3),
  })
  .prefault({});

// ---------------------------------------------------------------------------
// Planning (predictive-control-dashboard) — forecast-driven, movement-
// minimizing pre-positioning. The Forecast_Planner runs before the existing
// engine pipeline and proposes a per-window base target; safety + hysteresis
// remain the final authority. All values have defaults so existing configs
// validate without migration.
// ---------------------------------------------------------------------------

export const PlanningRulesSchema = z
  .object({
    // Planning horizon in hours (Requirement 2.4). Default 12, range 1..48.
    horizonHours: z.number().int().min(1).max(48).default(12),
    // Trajectory time-step in minutes (Requirement 2.5). Default 15, 5..60.
    timeStepMinutes: z.number().int().min(5).max(60).default(15),
    // Deviation tolerance, indoor temp °C (Requirement 4.4). Default 1.5.
    deviationToleranceC: z.number().min(0).default(1.5),
    // Deviation tolerance, normalized heat load (Requirement 4.4). Default 0.15.
    deviationToleranceLoad01: z.number().min(0).max(1).default(0.15),
    // Minimum seconds between two PLANNED moves of the same shutter
    // (Requirement 3.3). Default 10800 s (3 h); target band 7200..10800.
    // A shutter should move at most once every three hours.
    plannedMinSecondsBetweenMoves: z
      .number()
      .int()
      .min(7200)
      .max(10800)
      .default(10800),
    // Planned moves allowed per interval (Movement_Budget). Default 1.
    movementBudgetPerInterval: z.number().int().min(1).max(4).default(1),
    // Discrete candidate position grid in [0,1] (0=open .. 1=closed).
    candidateLevels01: z
      .array(z.number().min(0).max(1))
      .min(2)
      .default([0, 0.25, 0.5, 0.75, 0.95, 1]),
  })
  .prefault({});

export const RulesSchema = z
  .object({
    profile: z
      .enum(['conservative', 'standard', 'aggressive', 'custom'])
      .default('standard'),
    comfort: ComfortRulesSchema,
    automation: AutomationRulesSchema,
    sun: SunRulesSchema,
    storm: StormRulesSchema,
    nightCooling: NightCoolingRulesSchema,
    insulation: InsulationRulesSchema,
    heatLoad: HeatLoadRulesSchema,
    thresholds: ModeThresholdsSchema,
    planning: PlanningRulesSchema.optional(),
    // Pause window after detected manual operation of a shutter (7.4).
    manualOverrideMinutes: z.number().int().min(0).default(60),
  })
  .prefault({});

// ---------------------------------------------------------------------------
// Top-level config — everything ties together here.
// ---------------------------------------------------------------------------

export const LocationSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  timezone: z.string().min(1),
});

export const GlobalSignalsSchema = z.object({
  outdoorTemp: SignalBindingSchema,
  // Local outdoor sensors front (NE) and back (SW) of the house — used by
  // the multi-sensor comparison (smart-shading-notifications Requirement 5).
  // Optional: the wizard binds them when the user has dedicated sensors.
  frontOutdoorTemp: SignalBindingSchema.optional(),
  backOutdoorTemp: SignalBindingSchema.optional(),
  pvPower: SignalBindingSchema.optional(),
  radiation: SignalBindingSchema.optional(),
  windSpeed: SignalBindingSchema.optional(),
  forecastMaxTemp: SignalBindingSchema.optional(),
  forecastCloudCover: SignalBindingSchema.optional(),
});

export const FusionSolarSchema = z
  .object({
    baseUrl: z.string().url().default('http://host.containers.internal:8088'),
    pvPeakKwp: z.number().positive().default(8.8),
    orientationHint: z
      .enum(['southeast', 'south', 'southwest', 'east', 'west', 'mixed'])
      .default('southeast'),
  })
  .prefault({});

export const DashboardSchema = z
  .object({
    port: z.number().int().min(1).max(65535).default(8089),
    enabled: z.boolean().default(true),
  })
  .prefault({});

// ---------------------------------------------------------------------------
// Direct OpenMeteo HTTP integration (Wave 5). When enabled the plugin polls
// open-meteo.com directly (location from `config.location`) and exposes its
// fields via the `openmeteo_http` SourceRef variant — independent of the
// HCU's OpenMeteo plugin.
// ---------------------------------------------------------------------------

export const OpenMeteoHttpSchema = z
  .object({
    enabled: z.boolean().default(false),
    // Poll cadence in minutes; weather changes slowly and the public API
    // is rate-limited, so the floor is 5 min.
    pollIntervalMinutes: z.number().int().min(5).max(180).default(15),
    // Override the API base URL (tests / self-hosted Open-Meteo).
    baseUrl: z.string().url().default('https://api.open-meteo.com'),
  })
  .prefault({});

// ---------------------------------------------------------------------------
// Notifications — Telegram + morning brief + per-event toggles
// (smart-shading-notifications Task 11.1). Telegram is the only new outbound
// endpoint and is opt-in (disabled by default). The bot token is stored here
// but MUST be masked in any `/api/config` response and never logged
// (Requirement 8.5).
// ---------------------------------------------------------------------------

export const TelegramConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    botToken: z.string().default(''),
    chatId: z.string().default(''),
    // Two-way bot: poll getUpdates and react to commands (/status, /set …).
    commandsEnabled: z.boolean().default(false),
    // Allow control/config commands (pause, vacation, set …). When false the
    // bot answers read-only queries only. Gated to authorized chats.
    allowControl: z.boolean().default(true),
    // Additional chat ids allowed to issue commands (besides `chatId`).
    allowedChatIds: z.array(z.string()).default([]),
  })
  .prefault({});

export const NotificationEventsSchema = z
  .object({
    ventilate: z.boolean().default(true),
    open: z.boolean().default(true),
    close: z.boolean().default(true),
    weather: z.boolean().default(true),
  })
  .prefault({});

export const ForecastUpdatesSchema = z
  .object({
    enabled: z.boolean().default(false),
    // Push a forecast/status update every N hours (during the day).
    everyHours: z.number().min(1).max(24).default(3),
  })
  .prefault({});

export const NotificationsSchema = z
  .object({
    telegram: TelegramConfigSchema,
    // Local time-of-day for the daily morning brief, "HH:MM" 24h.
    morningBriefLocalTime: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/u, 'Erwartet "HH:MM" im 24h-Format')
      .default('07:30'),
    // Local time-of-day for the evening daily summary, "HH:MM" 24h.
    dailySummaryLocalTime: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/u, 'Erwartet "HH:MM" im 24h-Format')
      .default('21:00'),
    dailySummaryEnabled: z.boolean().default(false),
    /** Language for server-sent notifications (Telegram). UI language is
     *  per-device; this is the installation-wide notification language. */
    language: z.enum(['de', 'en']).default('de'),
    events: NotificationEventsSchema,
    forecastUpdates: ForecastUpdatesSchema,
  })
  .prefault({});

// ---------------------------------------------------------------------------
// Learning loop options.
// ---------------------------------------------------------------------------

export const LearningSchema = z
  .object({
    // When true, the engine auto-applies its tuning recommendations.
    autoApply: z.boolean().default(false),
  })
  .prefault({});

// ---------------------------------------------------------------------------
// DWD severe-weather warnings (Wetter tab). Reads the official DWD warnings
// feed for the configured region. `regionName` is resolved to a Warncell-ID
// via the DWD warncell CSV; `warncellId` overrides that lookup when set.
// ---------------------------------------------------------------------------

export const DwdSchema = z
  .object({
    enabled: z.boolean().default(true),
    regionName: z.string().default(''),
    warncellId: z.string().default(''),
  })
  .prefault({});

// ---------------------------------------------------------------------------
// Gardena smart system (Bewässerung). Direct integration with the
// Husqvarna/GARDENA cloud API (api.smart.gardena.dev) using the user's own
// Application key + secret (OAuth2 client-credentials). When enabled, Heat
// Shield reads sensors (soil moisture/temp, light) and controls valves
// itself — no separate Gardena Connect plugin on the HCU required.
//
// `clientSecret` is a credential: it MUST be masked in any `/api/config`
// response (like the Telegram bot token) and never logged.
// ---------------------------------------------------------------------------

export const GardenaSchema = z
  .object({
    enabled: z.boolean().default(false),
    // GARDENA Application "Application Key" (used as both OAuth2 client_id
    // and the X-Api-Key header).
    clientId: z.string().default(''),
    // GARDENA Application "Application Secret" (OAuth2 client_secret).
    clientSecret: z.string().default(''),
    // Optional explicit location id; empty → auto-resolve the first location.
    locationId: z.string().default(''),
    // Default run duration for a manual "Bewässern" command, in seconds.
    defaultWateringSeconds: z
      .number()
      .int()
      .min(60)
      .max(86_400)
      .default(1800),
  })
  .prefault({});

// ---------------------------------------------------------------------------
// Irrigation — full ET-based, zone-aware water control (Bewässerung).
// Each zone maps to one Gardena VALVE service and an optional soil-moisture
// sensor; the engine maintains a per-zone FAO-56 water balance, learns the
// dry-down behaviour, forecasts the next watering and dispatches valve runs.
// ---------------------------------------------------------------------------

export const IrrigationPlantSchema = z.enum([
  'lawn',
  'bed',
  'hedge',
  'vegetable',
  'pot',
  'tree',
]);
export const IrrigationSoilSchema = z.enum(['sand', 'loam', 'silt', 'clay']);
export const IrrigationExposureSchema = z.enum(['full_sun', 'partial', 'shade']);
export const IrrigationEmitterSchema = z.enum(['drip', 'sprinkler', 'rotor', 'soaker']);
export const IrrigationSlopeSchema = z.enum(['flat', 'moderate', 'steep']);
export const IrrigationPrioritySchema = z.enum(['low', 'normal', 'high', 'critical']);
export const IrrigationModeSchema = z.enum([
  'off',
  'eco',
  'normal',
  'heat',
  'vacation',
  'establishment',
]);

export const IrrigationZoneSchema = z.object({
  id: z.string().min(1),
  name: z.string().default('Zone'),
  enabled: z.boolean().default(true),
  /** Gardena VALVE service id (control target) — empty until assigned. */
  valveServiceId: z.string().default(''),
  /** Optional Gardena sensor deviceId for closed-loop moisture. */
  moistureSensorDeviceId: z.string().default(''),
  plant: IrrigationPlantSchema.default('lawn'),
  soil: IrrigationSoilSchema.default('loam'),
  exposure: IrrigationExposureSchema.default('full_sun'),
  emitter: IrrigationEmitterSchema.default('sprinkler'),
  slope: IrrigationSlopeSchema.default('flat'),
  /** Emitter precipitation rate (mm/h). 0 → derive from emitter default. */
  precipRateMmH: z.number().min(0).max(100).default(0),
  /** Rooting depth (cm). 0 → derive from plant default. */
  rootDepthCm: z.number().min(0).max(200).default(0),
  /** Crop coefficient Kc. 0 → derive from plant default. */
  kc: z.number().min(0).max(2).default(0),
  /** Management allowed depletion (0..1). 0 → derive from plant default. */
  mad: z.number().min(0).max(1).default(0),
  /** Optional area (m²) for liter estimates. */
  areaM2: z.number().min(0).max(100000).default(0),
  priority: IrrigationPrioritySchema.default('normal'),
  /** Preferred watering window (local hours). start==end → 24 h. */
  allowedStartHour: z.number().int().min(0).max(23).default(4),
  allowedEndHour: z.number().int().min(0).max(23).default(8),
  /** Daily runtime budget cap (s). 0 → no cap. */
  maxDailySeconds: z.number().int().min(0).max(86_400).default(0),
  /** Minimum minutes between waterings. */
  cooldownMinutes: z.number().int().min(0).max(1440).default(360),
  /** Moisture (%) above which watering is skipped. */
  moistCeilingPct: z.number().min(0).max(100).default(80),
});

export const IrrigationSchema = z
  .object({
    /** Master switch for irrigation automation (actuation). */
    enabled: z.boolean().default(false),
    /** Operating mode (or auto). */
    mode: IrrigationModeSchema.default('normal'),
    /** When true, mode is chosen from weather (heat → heat, etc.). */
    autoMode: z.boolean().default(true),
    /** Use the ET-based water-balance model (vs. simple schedule fallback). */
    etModel: z.boolean().default(true),
    /** Skip if forecast rain ≥ this many mm within the look-ahead window. */
    rainSkipMm: z.number().min(0).max(50).default(3),
    /** Rain look-ahead window (h). */
    rainSkipWindowH: z.number().int().min(1).max(48).default(12),
    /** Lock out watering at/below this soil/air temperature (°C). */
    frostLockoutC: z.number().min(-10).max(10).default(3),
    /** Skip sprinkler/rotor zones above this wind speed (m/s). */
    windSkipMs: z.number().min(0).max(30).default(8),
    /** Prefer running while PV surplus is available. */
    pvPreferred: z.boolean().default(false),
    /** PV surplus threshold (kW) for pv-preferred scheduling. */
    pvSurplusKw: z.number().min(0).max(50).default(1.5),
    /** Gardena POWER_SOCKET service id for an irrigation pump (optional). */
    pumpSocketId: z.string().default(''),
    /** Coordinate with the Gardena mower (don't water while mowing). */
    mowerCoordination: z.boolean().default(false),
    /** Gardena MOWER service id for coordination (optional). */
    mowerServiceId: z.string().default(''),
    /** Global daily runtime budget across all zones (s). 0 → no cap. */
    maxDailySecondsTotal: z.number().int().min(0).max(86_400).default(0),
    /** Max valves running concurrently (flow limit). */
    maxConcurrentValves: z.number().int().min(1).max(12).default(1),
    /** Blend weight of the moisture sensor into the modeled depletion (0..1). */
    sensorWeight: z.number().min(0).max(1).default(0.4),
    /** Hide Gardena valves not assigned to any zone from the dashboard list. */
    hideUnusedValves: z.boolean().default(false),
    /**
     * Gardena valve deviceIds the user explicitly disabled in settings. A
     * disabled valve is hidden from the irrigation control views and never
     * dispatched (even if assigned to a zone). Empty by default.
     */
    disabledValveIds: z.array(z.string()).default([]),
    zones: z.array(IrrigationZoneSchema).default([]),
  })
  .prefault({});

export const ConfigSchema = z.object({
  schemaVersion: z.literal(1),
  // Master automation switch. Defaults to **false** so a freshly
  // installed plugin never moves a shutter before the user has
  // finished configuring and explicitly flips the "Automatik aktiv"
  // lever in the dashboard header. When false the engine still runs
  // every cycle (risk, modes, decision records, live UI) but holds
  // all positions — identical to MAINTENANCE — so nothing moves.
  automationEnabled: z.boolean().default(false),
  location: LocationSchema,
  globalSignals: GlobalSignalsSchema,
  fusionSolar: FusionSolarSchema,
  rooms: z.array(RoomSchema).default([]),
  windows: z.array(WindowSchema).default([]),
  rules: RulesSchema,
  dashboard: DashboardSchema,
  notifications: NotificationsSchema,
  learning: LearningSchema,
  openMeteo: OpenMeteoHttpSchema,
  dwd: DwdSchema,
  gardena: GardenaSchema,
  irrigation: IrrigationSchema,
});

// ---------------------------------------------------------------------------
// Parse helpers — the entry points the rest of the codebase will use.
// Note: inferred types are intentionally NOT exported here. That happens in
// `src/shared/types.ts` (Task 2.2) so this file stays the schema source of
// truth without leaking type aliases.
// ---------------------------------------------------------------------------

/**
 * Parse an unknown value as a Heat Shield config, throwing a `ZodError` with
 * a structured `issues` array on failure. Use this at the boundary where you
 * already expect a valid config (e.g. after migration).
 */
export function parseConfig(input: unknown): z.infer<typeof ConfigSchema> {
  return ConfigSchema.parse(input);
}

/**
 * Parse an unknown value as a Heat Shield config without throwing. Returns
 * Zod's `ZodSafeParseResult` so callers can branch on `.success` and surface
 * `.error.issues` to the dashboard.
 */
export function safeParseConfig(
  input: unknown,
): z.ZodSafeParseResult<z.infer<typeof ConfigSchema>> {
  return ConfigSchema.safeParse(input);
}
