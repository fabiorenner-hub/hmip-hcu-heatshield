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

// ---------------------------------------------------------------------------
// Shared movement-block schedule — "do not move on these weekdays within this
// clock-time window". Used both per-window (`Window.blockSchedules`) and, since
// v2.1, per-room (`Room.quietSchedules`, the granular successor to the single
// `noMoveBeforeHour`/`noMoveAfterHour` bounds). STORM always overrides a block.
// ---------------------------------------------------------------------------

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/u;

export const MoveBlockScheduleSchema = z.object({
  // JS `Date.getDay()` weekdays the block applies to: 0=Sun … 6=Sat. Empty
  // array = every day.
  days: z.array(z.number().int().min(0).max(6)).default([]),
  // Local clock-time window "HH:MM"–"HH:MM"; wraps across midnight when
  // start > end (e.g. 22:00 → 10:00).
  start: z.string().regex(HHMM, 'Erwartet "HH:MM" im 24h-Format').default('22:00'),
  end: z.string().regex(HHMM, 'Erwartet "HH:MM" im 24h-Format').default('10:00'),
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
  // Granular per-room quiet schedules (v2.1): a list of {weekdays + clock-time
  // window} rules during which NO automatic move is dispatched for this room's
  // shutters. Finer-grained successor to the `noMoveBeforeHour`/`noMoveAfterHour`
  // hour bounds (both continue to work and are honoured together). STORM always
  // overrides. Empty/omitted = never blocked by a schedule. Optional (not
  // `.default([])`) so existing Room literals across the app stay valid; the
  // engine and UI both treat `undefined` as "no schedules".
  quietSchedules: z.array(MoveBlockScheduleSchema).optional(),
  // Building thermal inertia (Thermal_Inertia) as time constant τ in minutes
  // (predictive-control-dashboard Requirement 2.2). Higher = slower indoor
  // response. Default 120 min applied at read time; optional in config.
  thermalInertiaMinutes: z.number().min(15).max(1440).optional(),
  // Active cooling marker (e.g. a mobile AC unit cools this room). When true
  // the self-learning loop (thermal calibration + comfort-bias recommendations)
  // IGNORES this room: an AC-cooled room's indoor temperature no longer
  // reflects the shutter/solar response, so learning from it would corrupt the
  // model. The room is still controlled and shown normally — only learning
  // skips it. Default false.
  activeCooling: z.boolean().default(false),
  // Per-room shading-profile override (configurability Phase 2). When set, it
  // overrides the global `rules.shadingProfile` for every window in this room
  // (window-level override still wins). Absent = inherit global.
  shadingProfile: z.enum(['daylight', 'balanced', 'protection']).optional(),
});

// ---------------------------------------------------------------------------
// Per-window movement block schedule — "do not move this shutter on these
// weekdays within this clock-time window" (e.g. roof window in the bedroom,
// Mon–Fri 22:00–10:00). Multiple entries allowed per window. STORM safety
// force-open always overrides a block. This is a finer-grained successor to
// the per-room `noMoveBeforeHour`/`noMoveAfterHour` hour bounds.
// ---------------------------------------------------------------------------

// Per-window block schedule — identical shape to the shared room schedule
// (defined above as `MoveBlockScheduleSchema`). Kept as a named export for
// backward compatibility with existing imports and derived types.
export const WindowBlockScheduleSchema = MoveBlockScheduleSchema;

// ---------------------------------------------------------------------------
// Window — physical opening with shutter device + geometry + safety flags.
// ---------------------------------------------------------------------------

export const WindowSchema = z.object({
  id: z.string().min(1),
  roomId: z.string().min(1),
  // Human-friendly shutter name (e.g. "Rollladen Terrasse"). Shown in the plan
  // instead of the generic "Fenster SW". Optional — falls back to type/facade.
  name: z.string().min(1).max(60).optional(),
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
  // Per-window movement block schedules (weekday + clock-time windows). The
  // engine dispatches NO automatic move for this shutter while now falls into
  // any entry. STORM force-open always overrides. Empty = never blocked.
  blockSchedules: z.array(WindowBlockScheduleSchema).default([]),
  // Per-window shading-profile override (configurability Phase 2). Wins over
  // both the room override and the global `rules.shadingProfile`.
  shadingProfile: z.enum(['daylight', 'balanced', 'protection']).optional(),
  // Per-window evening-open threshold override (Phase 2/3): only open once the
  // window's DIRECT exposure is below this (0..1). Lower = keeps this shutter
  // shaded longer into the evening (e.g. NW with late sun). Absent = global.
  eveningOpenExposureBelow: z.number().min(0).max(1).optional(),
});

// ---------------------------------------------------------------------------
// Rules — concrete schemas for comfort, automation, sun (regelwerk §19),
// plus storm, night cooling, and manual override.
// ---------------------------------------------------------------------------

export const ComfortRulesSchema = z
  .object({
    // Indoor temperature at which the room is considered uncomfortably warm.
    maxIndoorTempC: z.number().default(25),
    // Cooling target (Kühl-Soll): the indoor temperature the automation aims to
    // keep rooms at. When set, each room's comfort target (`target_c`) is
    // shifted to this value and the room's warning/strong/critical offsets ride
    // along, so the whole comfort band moves with the cool target. Optional —
    // absent = use each room's own configured `target_c` (unchanged behaviour).
    coolTargetC: z.number().min(16).max(30).optional(),
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
    // Master switch for the storm safety force-open. Default ON (true) — the
    // storm force-open is a safety feature and stays enabled unless the user
    // explicitly disables it in the settings. When false, the engine never
    // enters STORM mode and never force-opens shutters on high wind.
    enabled: z.boolean().default(true),
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
    // Hard cap on how many planned moves a single shutter may make per day
    // (Bewegungs-Deckel). The phased schedule drops further transitions once
    // this many have been emitted, keeping the "as few moves as possible"
    // principle (target 2–4/day) even with a fine segment grid. Scaled by the
    // horizon (e.g. a 12 h horizon allows half the daily budget).
    maxMovesPerDay: z.number().int().min(1).max(8).default(4),
    // Discrete candidate position grid in [0,1] (0=open .. 1=closed).
    candidateLevels01: z
      .array(z.number().min(0).max(1))
      .min(2)
      .default([0, 0.25, 0.5, 0.75, 0.95, 1]),
  })
  .prefault({});

// ---------------------------------------------------------------------------
// Floor-based shading lead (Obergeschoss/Dachgeschoss shade earlier). Upper
// floors heat up faster (warm-air stratification, roof proximity), so the
// planner should close them a little earlier than the ground floor / cellar.
// We express this as a per-floor "lead" in °C that TIGHTENS the room's upper
// comfort bound (a smaller bound → the forecast planner shades sooner). Heat
// and sun are still tracked per window; this only nudges the comfort target
// per floor. `leadByFloor` is keyed by the room's free-form floor label; when
// a label is missing the default classifier (DG/OG warmer, EG neutral, KG
// cooler) supplies a sensible value.
// ---------------------------------------------------------------------------

export const FloorShadingSchema = z
  .object({
    enabled: z.boolean().default(true),
    // Explicit per-floor lead in °C (0..4). Tighter upper comfort bound =
    // shade earlier. Keyed by the room's floor label (e.g. "OG", "DG").
    leadByFloor: z.record(z.string(), z.number().min(0).max(4)).default({}),
  })
  .prefault({});

// ---------------------------------------------------------------------------
// Hot-day minimum-shade floor. On very hot days with sun (PV power available),
// keep a baseline of shading: never OPEN a shutter beyond `maxOpenPercent`
// (i.e. hold it at least partly closed) so the room does not bake. Applies
// only while the outdoor temperature is at/above `outdoorThresholdC` and PV
// power signals real sun. STORM and NIGHT_COOLING are exempt.
// ---------------------------------------------------------------------------

/**
 * One hot-day shading stage: at/above `outdoorThresholdC` outdoor, hold the
 * shutter at least `shadingPercent` closed (0 = may stay fully open … 100 =
 * fully closed). Multiple stages let the user ramp the baseline shade with the
 * outdoor temperature, e.g. `{30 °C → 30 %}`, `{35 °C → 50 %}`. The engine picks
 * the highest threshold whose temperature is reached.
 */
export const HotDayStageSchema = z.object({
  outdoorThresholdC: z.number().min(20).max(50),
  // Minimum shading (closed fraction) in percent. 0 = no floor … 100 = closed.
  shadingPercent: z.number().int().min(0).max(100),
});

export const HotDayRulesSchema = z
  .object({
    enabled: z.boolean().default(true),
    // Legacy single-stage fields (kept for backward compatibility and as the
    // fallback when `stages` is empty/absent).
    // Outdoor temperature (°C) at/above which the floor applies.
    outdoorThresholdC: z.number().min(20).max(50).default(35),
    // Maximum allowed openness in percent (0=closed … 100=open). 50 = the
    // shutter is held at least half closed while it is hot and sunny.
    maxOpenPercent: z.number().int().min(0).max(100).default(50),
    // Minimum PV power (kW) that counts as "sun is really shining".
    minPvKw: z.number().min(0).max(50).default(0.5),
    // Multi-stage temperature → shading ramp. When present and non-empty it
    // REPLACES the single-stage `outdoorThresholdC`/`maxOpenPercent` gate.
    stages: z.array(HotDayStageSchema).optional(),
  })
  .prefault({});

// ---------------------------------------------------------------------------
// Gentle shading (opt-in) — "shade gradually, then observe".
//
// When enabled, the summer heat-protection escalation (§13 roof/SE force-close
// rules + the roof-under-sun close) is capped to `maxClose01` so the plugin
// does not slam shutters fully shut on mild-warm days (e.g. 24 °C). The cap
// never pulls below the risk model's own base target, and a real HEATWAVE (or
// STORM) is exempt so genuine heat protection is never weakened. Default OFF so
// existing installs keep their current behaviour until the user opts in.
// ---------------------------------------------------------------------------

export const GentleShadingSchema = z
  .object({
    enabled: z.boolean().default(false),
    // Maximum closed fraction the heat-protection escalation may reach while
    // gentle shading is on and it is not a real heatwave (0=open … 1=closed).
    // 0.5 = "at most half closed first, then let the risk model decide".
    maxClose01: z.number().min(0).max(1).default(0.5),
  })
  .prefault({});

// ---------------------------------------------------------------------------
// Roof-window rules. Roof (skylight) glazing is the single strongest heat
// entry point — glass overhead, near-normal incidence at midday. Roof windows
// therefore get dedicated, more aggressive handling than façades:
//   - they close fully (100 %) rather than to the 95 % heat-trap gap;
//   - they close EARLIER (already when the sun will reach them soon);
//   - "gentle shading" only applies to them when it is cooler outside than the
//     indoor comfort temperature (otherwise a roof window closes fully — its
//     heat entry is too strong to only half-shade on a hot day);
//   - their shutters are only OPENED once PV power is low AND the solar
//     forecast is trending down for the look-ahead (afternoon decline), so
//     they are not opened while the sun is still strong overhead;
//   - the open window/sash contact can be ignored (their awnings/shutters may
//     operate while the roof window is tilted open).
// ---------------------------------------------------------------------------

export const RoofRulesSchema = z
  .object({
    // Close level for roof windows in [0,1] (1 = fully closed). Default 1.0.
    closeLevel01: z.number().min(0).max(1).default(1),
    // Pre-shade: close already when the sun WILL reach the roof window soon
    // (sun-prelook), not only when it is on it now → closes earlier.
    preShade: z.boolean().default(true),
    // Gentle shading applies to roof windows ONLY when it is cooler outside
    // than the indoor (comfort) temperature; otherwise they close fully.
    gentleOnlyWhenOutdoorBelowIndoor: z.boolean().default(true),
    // Opening gate: only OPEN a roof window's shutter once PV power is low AND
    // the solar forecast is falling for the look-ahead.
    openRequiresPvLowAndFalling: z.boolean().default(true),
    // "PV low" threshold in kW for the opening gate.
    openPvLowKw: z.number().min(0).max(50).default(1.5),
    // Look-ahead (hours) over which the solar forecast must be falling.
    openFallingHours: z.number().int().min(1).max(6).default(3),
    // Ignore the open window/sash contact for roof windows: move the shutter
    // anyway (roof-window awnings/shutters can operate while the sash is open).
    ignoreOpenContact: z.boolean().default(true),
  })
  .prefault({});

// ---------------------------------------------------------------------------
// Engine tuning (configurability overhaul, Phase 1). Every value here was
// previously a hard-coded module constant in the engine; exposing it makes the
// full shading/thermal behaviour tunable. Defaults EXACTLY match the former
// constants, so a config without a `tuning` block behaves identically.
// ---------------------------------------------------------------------------

export const ShadingTuningSchema = z
  .object({
    // Direct-solar exposure at which a window reaches FULL close (near its
    // solar peak). Below it the closure ramps up gradually from the mild cap.
    highExposure: z.number().min(0).max(1).default(0.9),
    // Exposure at/below which a window is treated as "off-sun" (diffuse only).
    lowExposure: z.number().min(0).max(1).default(0.15),
    // Max closure at an off-sun window normally (little/no direct beam).
    offSunMildClose01: z.number().min(0).max(1).default(0.3),
    // Max closure at an off-sun window under strong solar load.
    offSunStressClose01: z.number().min(0).max(1).default(0.7),
    // Min horizon-peak reduction (K) that makes shading worthwhile.
    shadeBenefitMinC: z.number().min(0).max(5).default(0.3),
    // Min closure reduction (percentage points) worth a daylight-open move.
    lightGainMinPct: z.number().int().min(0).max(100).default(20),
    // Radiation (W/m²) at/above which the solar/PV load counts as "strong".
    solarStrongWm2: z.number().min(0).max(1200).default(400),
    // Phased-plan segment length (h) and per-segment look-ahead (h).
    segmentHours: z.number().min(1).max(6).default(2),
    lookaheadHours: z.number().min(1).max(12).default(4),
  })
  .prefault({});

export const ThermalTuningSchema = z
  .object({
    // Diffuse-radiation share reaching a window regardless of orientation.
    diffuseFraction: z.number().min(0).max(1).default(0.22),
    // Extra solar coupling for roof windows (overhead glazing).
    roofSolarBoost: z.number().min(1).max(3).default(1.3),
    // Heat-load → temperature gain (°C of forcing at full load).
    tempGainC: z.number().min(0).max(20).default(8),
    // Cloud damping: full overcast removes this fraction of the sun.
    cloudDampingK: z.number().min(0).max(1).default(0.75),
    // Minimum sun elevation (deg) for any solar contribution.
    minElevationDeg: z.number().min(0).max(30).default(3),
  })
  .prefault({});

export const TuningRulesSchema = z
  .object({
    shading: ShadingTuningSchema,
    thermal: ThermalTuningSchema,
  })
  .prefault({});

// ---------------------------------------------------------------------------
// Custom risk weights (Phase 5). Used when `profile === 'custom'`. The engine
// renormalises them to sum to 1, so only the RATIOS matter. Defaults mirror the
// former STANDARD_WEIGHTS.
// ---------------------------------------------------------------------------

export const RiskWeightsSchema = z
  .object({
    sunFactor: z.number().min(0).max(1).default(0.3),
    roomTempFactor: z.number().min(0).max(1).default(0.25),
    windowTypeFactor: z.number().min(0).max(1).default(0.1),
    forecastTempFactor: z.number().min(0).max(1).default(0.1),
    pvFactor: z.number().min(0).max(1).default(0.1),
    radiationFactor: z.number().min(0).max(1).default(0.05),
    outdoorTempFactor: z.number().min(0).max(1).default(0.05),
    priorityFactor: z.number().min(0).max(1).default(0.05),
  })
  .prefault({});

// ---------------------------------------------------------------------------
// Evening-open gate (Phase 3). Controls how late a shutter opens in the
// afternoon/evening so it is not opened while (late) direct sun is still on the
// window (e.g. NW at sunset). `sun` mode follows the real sun (recommended);
// `time`/`sunset` add a hard clock/sunset floor.
// ---------------------------------------------------------------------------

export const EveningOpenSchema = z
  .object({
    enabled: z.boolean().default(true),
    // Sun-following gate (Variant A): while the solar load is no longer strong
    // (afternoon/evening) but DIRECT exposure on the window is still at/above
    // this (0..1), the shutter keeps a mild shade instead of opening fully — so
    // it is not opened while late direct sun is still on it (e.g. NW at sunset).
    // Lower = keep shaded longer; 0 = never hold back (open as soon as comfort allows).
    openWhenExposureBelow: z.number().min(0).max(1).default(0.12),
  })
  .prefault({});

// ---------------------------------------------------------------------------
// Shading profile (Phase 4). A single high-level dial that biases the shading
// tuning toward more daylight or more heat protection. `balanced` = defaults;
// `daylight` opens more/earlier; `protection` shades more/earlier. The engine
// derives the effective tuning from this + any explicit `tuning` overrides.
// ---------------------------------------------------------------------------

export const ShadingProfileSchema = z
  .enum(['daylight', 'balanced', 'protection'])
  .default('balanced');

// ---------------------------------------------------------------------------
// PV-boost shading. When the PV array delivers a lot of power (clear sky, sun
// on the array), windows facing roughly the same direction as the array are
// closed harder (up to full) and kept closed while the PV stays high. The
// array azimuth defaults to the FusionSolar orientation hint / learned azimuth.
// ---------------------------------------------------------------------------

export const PvShadingSchema = z
  .object({
    enabled: z.boolean().default(false),
    // PV array azimuth (deg, N=0/E=90/S=180/W=270). Absent → derived from the
    // FusionSolar orientation hint or the learned array azimuth.
    arrayAzimuthDeg: z.number().min(0).max(359).optional(),
    // PV output fraction (0..1 of the clear-sky array potential) at/above which
    // "PV is very high" and array-aligned windows get closed harder.
    highPvFraction: z.number().min(0).max(1).default(0.6),
    // How close (deg) to the array azimuth a window must face to be boosted.
    lobeWidthDeg: z.number().min(10).max(180).default(90),
    // Maximum extra closure floor this rule may impose (0..1).
    maxClose01: z.number().min(0).max(1).default(1),
  })
  .prefault({});

// ---------------------------------------------------------------------------
// Heat lockout ("Hitze-Aussperrung"). When it is hotter OUTSIDE than inside,
// an external shutter reduces conductive/radiative heat ingress even without
// direct sun — so keep it at least partly closed instead of opening for
// daylight (a north window on a 30 °C day, room at 25 °C, stays shaded). This
// captures an effect the solar-only thermal model does not. Opt-in.
// ---------------------------------------------------------------------------

export const HeatLockoutSchema = z
  .object({
    enabled: z.boolean().default(false),
    // Outdoor must exceed indoor by at least this (°C) to keep it shaded.
    outdoorAboveIndoorC: z.number().min(0).max(15).default(3),
    // Keep at least this closed (0..1) while it is hotter outside than in.
    minClose01: z.number().min(0).max(1).default(0.5),
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
    floorShading: FloorShadingSchema,
    hotDay: HotDayRulesSchema,
    gentleShading: GentleShadingSchema,
    roof: RoofRulesSchema,
    // Configurability overhaul (Phases 1/3/4/5). Optional so existing configs
    // and hand-written Config literals stay valid; the engine applies defaults.
    tuning: TuningRulesSchema.optional(),
    shadingProfile: z.enum(['daylight', 'balanced', 'protection']).optional(),
    eveningOpen: EveningOpenSchema.optional(),
    pvShading: PvShadingSchema.optional(),
    // Editable risk weights used when `profile === 'custom'`.
    customWeights: RiskWeightsSchema.optional(),
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
    regionName: z.string().default('Berlin'),
    warncellId: z.string().default(''),
    /** Show the Alert-Mode panel on the Beschattung (start) page. */
    alertOnDashboard: z.boolean().default(true),
    /** Show the Alert-Mode panel on the Wetter tab. */
    alertOnWeather: z.boolean().default(true),
    /**
     * Telegram delivery for severe-weather warnings:
     *  - 'off'     → no Telegram (changes still show in the dashboard).
     *  - 'changes' → only new/escalated warnings + all-clear, no heartbeat.
     *  - '30'/'60'/'90' → changes PLUS a situation update every N minutes
     *    while an alert (level ≥ 3) is active. Default '30'.
     */
    telegramMode: z.enum(['off', 'changes', '30', '60', '90']).default('30'),
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

// ---------------------------------------------------------------------------
// Updates (OTA) — installation-wide update behaviour. `manual` (default) only
// surfaces a hint + button; `auto` lets the server check every
// `checkIntervalHours` and install a verified, core-compatible OTA payload.
// ---------------------------------------------------------------------------

export const UpdatesConfigSchema = z
  .object({
    // Default AUTO: verified, core-compatible OTA updates install on their own
    // and restart the plugin. Users can switch to 'manual' in the Updates tab.
    mode: z.enum(['manual', 'auto']).default('auto'),
    checkIntervalHours: z.number().int().min(1).max(168).default(6),
  })
  .prefault({});

// ---------------------------------------------------------------------------
// Telemetry (call-home) — one anonymous ping after startup so the maintainer
// can count installations per version. Identifier is a salted hash of the HCU
// SGTIN (unique per installation, not reversible). No token/location/devices.
// Opt-out via `enabled: false`; the endpoint is fixed in code (not here).
// ---------------------------------------------------------------------------

export const TelemetrySchema = z
  .object({
    enabled: z.boolean().default(true),
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
  updates: UpdatesConfigSchema,
  telemetry: TelemetrySchema,
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
