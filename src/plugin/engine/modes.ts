/**
 * Heat Shield — mode FSM (Task 7.2).
 *
 * This module implements the engine's coarse-grained finite state
 * machine that classifies every cycle into one of eight modes
 * (design.md §Property 5). The orchestrator runs the FSM exactly once
 * per cycle, before the per-window risk pipeline; the resulting mode
 * gates the special rules, ventilation logic, and dashboard surface.
 *
 * Decision precedence (steering hard rule, top-down):
 *
 *   1. STORM       — wind currently exceeds `rules.storm.thresholdMs`,
 *                    or a previous storm hold (`stormHoldUntil`) has
 *                    not yet elapsed. STORM has the **highest**
 *                    priority above every other mode.
 *   2. MAINTENANCE — dashboard override. The engine still evaluates
 *                    inputs and renders the UI, but does not move any
 *                    shutter (downstream gate).
 *   3. VACATION    — `heatshield-control-vacation` switch is on. The
 *                    user has explicitly chosen the vacation profile,
 *                    so VACATION beats SUMMER_WATCH / ACTIVE /
 *                    HEATWAVE; only STORM and MAINTENANCE outrank it.
 *   4. NIGHT_COOLING — `nightCooling.enabled`, sun is below the
 *                    horizon, outdoor air is at least `deltaC` cooler
 *                    than the warmest priority room, and we have not
 *                    yet reached the morning close-up moment
 *                    (`sunriseUtc + reopenAtSunriseOffsetMin`).
 *                    NIGHT_COOLING is checked *before* HEATWAVE /
 *                    ACTIVE because at night active shading is no
 *                    longer the actionable strategy — opening
 *                    shutters to flush warm air out is. The sun-down
 *                    gate guarantees this branch never fires during
 *                    daytime, so HEATWAVE / ACTIVE keep their place
 *                    on the daytime path.
 *   5. HEATWAVE    — forecast max ≥ 30 °C, or any priority room is
 *                    already at ≥ 24.5 °C.
 *   6. ACTIVE_HEAT_PROTECTION — forecast max ≥ 25 °C, or any priority
 *                    room is at the warning threshold ≥ 23.5 °C.
 *   7. SUMMER_WATCH — forecast ≥ 24 °C, outdoor ≥ 22 °C, or smoothed
 *                    PV power above 2.0 kW.
 *   8. NORMAL      — fallback.
 *
 * Notes on the **pause** flag (`switches.pauseControl`): pause is
 * *not* its own mode. It is a downstream gate that the orchestrator
 * checks separately to suppress shutter writes; the FSM stays geared
 * toward the regelwerk semantics. We deliberately do **not** inject
 * pause into mode determination — keeping the two concerns separate
 * lets the dashboard render the "real" mode while the pause indicator
 * is shown alongside, which matches the design.md §Components Wizard
 * diagnostics tab layout.
 *
 * The hard-rule steering definition `heat_mode_active = mode ∈
 * {ACTIVE_HEAT_PROTECTION, HEATWAVE}` is exposed via
 * {@link HEAT_MODE_ACTIVE} and {@link isHeatModeActive}. It must not
 * be widened — special rules elsewhere (Task 7.3) consume it directly.
 *
 * Module rules (mirrored from `engine/risk.ts` and `engine/sun.ts`):
 *   - Pure: no fs, no logging, no Connect-API artefacts, no globals.
 *   - Strict TS, ESM, `.js` import suffixes.
 */

import type { Mode, ModeThresholds, Rules } from '../../shared/types.js';

// ---------------------------------------------------------------------------
// Threshold constants (steering hard rules — do not widen).
// ---------------------------------------------------------------------------

/** Forecast max ≥ this value forces HEATWAVE (design §Property 5 correction). */
const HEATWAVE_FORECAST_C = 30;
/** Any priority room ≥ this value forces HEATWAVE. */
const HEATWAVE_ROOM_C = 24.5;
/** Forecast max ≥ this value forces ACTIVE_HEAT_PROTECTION. */
const ACTIVE_FORECAST_C = 25;
/** Any priority room ≥ this value forces ACTIVE_HEAT_PROTECTION (regelwerk §8 warning). */
const ACTIVE_ROOM_C = 23.5;
/** Forecast max ≥ this value triggers SUMMER_WATCH. */
const SUMMER_FORECAST_C = 20;
/** Outdoor temp ≥ this value triggers SUMMER_WATCH. */
const SUMMER_OUTDOOR_C = 18;
/** Smoothed PV power > this value triggers SUMMER_WATCH. */
const SUMMER_PV_KW = 2.0;

/**
 * Resolve the active thresholds for one evaluation. Falls back to the
 * steering default constants when `inputs.thresholds` is absent (so older
 * callers / tests keep the historical behaviour exactly).
 */
function resolveThresholds(inputs: ModeInputs): ModeThresholds {
  const t = inputs.thresholds;
  return {
    heatwaveForecastC: t?.heatwaveForecastC ?? HEATWAVE_FORECAST_C,
    heatwaveRoomC: t?.heatwaveRoomC ?? HEATWAVE_ROOM_C,
    activeForecastC: t?.activeForecastC ?? ACTIVE_FORECAST_C,
    activeRoomC: t?.activeRoomC ?? ACTIVE_ROOM_C,
    summerForecastC: t?.summerForecastC ?? SUMMER_FORECAST_C,
    summerOutdoorC: t?.summerOutdoorC ?? SUMMER_OUTDOOR_C,
    summerPvKw: t?.summerPvKw ?? SUMMER_PV_KW,
  };
}

// ---------------------------------------------------------------------------
// Public types.
// ---------------------------------------------------------------------------

/**
 * Inputs for one mode-FSM evaluation. The orchestrator assembles this
 * object from the cycle snapshot + persisted runtime state; otherwise
 * {@link determineMode} is pure.
 */
export interface ModeInputs {
  /** Current wall-clock instant (UTC). Used for night cooling sunrise calc. */
  now: Date;
  /** Outdoor temperature (used for SUMMER_WATCH and night cooling). */
  outdoorTempC: number | null;
  /** Forecast daily max temperature (used for SUMMER_WATCH/ACTIVE/HEATWAVE thresholds). */
  forecastMaxTempC: number | null;
  /** Smoothed PV power (used for SUMMER_WATCH threshold). */
  pvSmoothedKw: number | null;
  /** Wind speed in m/s (used for STORM detection). null treats as 0. */
  windSpeedMs: number | null;
  /** Maximum room temperature across all priority rooms (HEATWAVE input). */
  maxPriorityRoomTempC: number | null;
  /** Sunrise UTC instant for today (from engine/sun.ts::getSunDay). */
  sunriseUtc: Date | null;
  /** Whether sun is currently above horizon. */
  sunIsUp: boolean;
  /** Switch states: vacation, pause-from-control. */
  switches: { vacation: boolean; pauseControl: boolean };
  /** Whether the orchestrator is in maintenance mode (set via dashboard). */
  maintenanceMode: boolean;
  /** Persistent storm-hold-until ISO timestamp; null when no storm hold active. */
  stormHoldUntil: Date | null;
  /** Engine rules (pulled from Config.rules). */
  rules: Pick<Rules, 'storm' | 'nightCooling'>;
  /**
   * Optional configurable mode thresholds (V1.8). When omitted, the steering
   * default constants apply — older callers and tests are unaffected.
   */
  thresholds?: Partial<ModeThresholds>;
}

/**
 * Result of one mode-FSM evaluation.
 *
 *   - `mode` is the selected FSM mode for the current cycle.
 *   - `newStormHoldUntil` is the value the orchestrator should persist
 *     to `RuntimeState.stormHoldUntil`. `null` means "no change" — the
 *     existing value (which may already have expired naturally) is
 *     left alone.
 *   - `reason` is a short, deterministic, human-readable string the
 *     dashboard surfaces in the mode-header tooltip and the diagnostics
 *     tab. The wording is stable across versions so log-grepping works.
 */
export interface ModeDecision {
  /** Selected mode. */
  mode: Mode;
  /** New stormHoldUntil to persist; null if no change. */
  newStormHoldUntil: Date | null;
  /** Reason string for logging/dashboard. */
  reason: string;
  /** Structured, German explanation of the deciding factor (dashboard). */
  explanation: ModeExplanation;
}

/**
 * Human-readable, German explanation of *why* the FSM picked the mode it
 * picked. `decidedBy` is the single deciding factor (the branch that fired,
 * with its measured value vs. threshold); `factors` are the relevant input
 * values that the dashboard renders as chips so the decision is transparent
 * ("no blackbox", Requirement 13.1 / 17.1).
 */
export interface ModeExplanation {
  /** One-line headline naming the deciding factor (German). */
  decidedBy: string;
  /** Supporting value/threshold chips (German). */
  factors: string[];
}

/** Round to one decimal and stringify (German uses a dot here for brevity). */
function f1(n: number): string {
  return (Math.round(n * 10) / 10).toString();
}

// ---------------------------------------------------------------------------
// Storm-hold helper.
// ---------------------------------------------------------------------------

/**
 * Inspects the current wind speed and any persisted storm hold, returns
 * whether STORM is the active mode and the (optional) new hold-until
 * value to persist.
 *
 * Two ways to be "active":
 *   - **Wind trigger**: the current wind speed exceeds
 *     `rules.storm.thresholdMs`. While the trigger is active, the hold
 *     is *extended* on every cycle (`now + releaseHoldMin * 60 s`) so a
 *     gust that briefly drops below the threshold does not release the
 *     storm prematurely. This matches Requirement 7.3 ("wind 10 min
 *     unter `storm_release_threshold`").
 *   - **Existing hold**: a previous wind trigger set
 *     `stormHoldUntil > now`. STORM stays active until that timestamp
 *     elapses, regardless of the current wind speed.
 *
 * Returned `until` is `null` when there is nothing new to persist:
 *   - wind below threshold and the existing hold (if any) is being
 *     consulted as-is, or
 *   - wind below threshold and the existing hold has already expired.
 *
 * `null` for `windSpeedMs` is treated as 0 so a temporarily missing
 * wind sensor does not silently keep the engine in STORM forever.
 */
export function checkStormHold(inputs: ModeInputs): { active: boolean; until: Date | null } {
  const wind = inputs.windSpeedMs ?? 0;
  const threshold = inputs.rules.storm.thresholdMs;
  const holdMs = inputs.rules.storm.releaseHoldMin * 60 * 1000;

  if (wind > threshold) {
    // Wind currently exceeds the threshold — extend (or arm) the hold.
    return {
      active: true,
      until: new Date(inputs.now.getTime() + holdMs),
    };
  }

  if (inputs.stormHoldUntil !== null && inputs.stormHoldUntil.getTime() > inputs.now.getTime()) {
    // Wind is calm but a previous hold has not yet elapsed.
    return { active: true, until: null };
  }

  return { active: false, until: null };
}

// ---------------------------------------------------------------------------
// heat_mode_active — steering hard rule.
// ---------------------------------------------------------------------------

/**
 * The two modes that count as "heat mode active" per steering. The set
 * is frozen so consumers cannot accidentally widen it at runtime. Task
 * 7.3 (`engine/specialRules.ts`) consumes this set directly to decide
 * whether to apply the regelwerk §13 special rules.
 *
 * Steering: this set is exactly `{ACTIVE_HEAT_PROTECTION, HEATWAVE}`.
 * Do not widen.
 */
export const HEAT_MODE_ACTIVE: ReadonlySet<Mode> = Object.freeze(
  new Set<Mode>(['ACTIVE_HEAT_PROTECTION', 'HEATWAVE']),
);

/**
 * Convenience wrapper around {@link HEAT_MODE_ACTIVE}. Use this in
 * orchestrator / engine code to keep the steering definition in one
 * place.
 */
export function isHeatModeActive(mode: Mode): boolean {
  return HEAT_MODE_ACTIVE.has(mode);
}

// ---------------------------------------------------------------------------
// Internal predicates for the FSM cascade.
// ---------------------------------------------------------------------------

function isHeatwave(inputs: ModeInputs, t: ModeThresholds): boolean {
  if (inputs.forecastMaxTempC !== null && inputs.forecastMaxTempC >= t.heatwaveForecastC) {
    return true;
  }
  if (inputs.maxPriorityRoomTempC !== null && inputs.maxPriorityRoomTempC >= t.heatwaveRoomC) {
    return true;
  }
  return false;
}

function isActiveHeatProtection(inputs: ModeInputs, t: ModeThresholds): boolean {
  if (inputs.forecastMaxTempC !== null && inputs.forecastMaxTempC >= t.activeForecastC) {
    return true;
  }
  if (inputs.maxPriorityRoomTempC !== null && inputs.maxPriorityRoomTempC >= t.activeRoomC) {
    return true;
  }
  return false;
}

/**
 * Night-cooling predicate. All four conditions must hold:
 *   1. `nightCooling.enabled` — the user has not disabled the feature.
 *   2. The sun is below the horizon — we never night-cool in daylight.
 *   3. Outdoor air is at least `deltaC` cooler than the warmest
 *      priority room — otherwise opening the shutters would let *warm*
 *      air into the building.
 *   4. We have not yet reached the morning close-up moment. The cutoff
 *      is `sunriseUtc + reopenAtSunriseOffsetMin`; the offset is
 *      *signed* and defaults to `-30` (close 30 min before sunrise).
 *      When `sunriseUtc` is unknown (polar night, source not yet
 *      seeded) we keep cooling — the next cycle re-evaluates.
 */
function isNightCooling(inputs: ModeInputs): boolean {
  if (!inputs.rules.nightCooling.enabled) {
    return false;
  }
  if (inputs.sunIsUp) {
    return false;
  }
  if (inputs.outdoorTempC === null || inputs.maxPriorityRoomTempC === null) {
    return false;
  }
  if (inputs.outdoorTempC > inputs.maxPriorityRoomTempC - inputs.rules.nightCooling.deltaC) {
    return false;
  }
  if (inputs.sunriseUtc !== null) {
    const cutoffMs =
      inputs.sunriseUtc.getTime() + inputs.rules.nightCooling.reopenAtSunriseOffsetMin * 60 * 1000;
    if (inputs.now.getTime() >= cutoffMs) {
      return false;
    }
  }
  return true;
}

function summerWatchTrigger(inputs: ModeInputs, t: ModeThresholds): string | null {
  if (inputs.forecastMaxTempC !== null && inputs.forecastMaxTempC >= t.summerForecastC) {
    return 'forecast';
  }
  if (inputs.outdoorTempC !== null && inputs.outdoorTempC >= t.summerOutdoorC) {
    return 'outdoor';
  }
  if (inputs.pvSmoothedKw !== null && inputs.pvSmoothedKw > t.summerPvKw) {
    return 'pv';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Top-level: determineMode.
// ---------------------------------------------------------------------------

/**
 * Run the mode FSM for one engine cycle.
 *
 * The implementation is a strict precedence cascade matching the
 * decision-precedence list in the module header. Each branch returns
 * the moment it fires; later branches never see the inputs of earlier
 * matches.
 *
 * Pure: same inputs → same outputs, no side effects. The orchestrator
 * is responsible for persisting `result.newStormHoldUntil` to
 * `RuntimeState.stormHoldUntil` and surfacing `result.reason` to the
 * dashboard / decision log.
 */
export function determineMode(inputs: ModeInputs): ModeDecision {
  const t = resolveThresholds(inputs);
  // 1. STORM — highest priority. Always evaluate first so we never
  //    move shutters down into a wind front.
  const storm = checkStormHold(inputs);
  if (storm.active) {
    const wind = inputs.windSpeedMs ?? 0;
    const threshold = inputs.rules.storm.thresholdMs;
    const windTrigger = wind > threshold;
    return {
      mode: 'STORM',
      newStormHoldUntil: storm.until,
      reason: `storm: wind=${wind}m/s > ${threshold}m/s`,
      explanation: {
        decidedBy: windTrigger
          ? `Sturm: Wind ${f1(wind)} m/s über Schwelle ${f1(threshold)} m/s`
          : `Sturm: Haltezeit nach Windböe läuft noch`,
        factors: [
          `Wind ${f1(wind)} m/s (Schwelle ${f1(threshold)} m/s)`,
          ...(windTrigger ? [] : ['Sturm-Haltezeit aktiv']),
          'Rollläden werden zum Schutz aufgefahren',
        ],
      },
    };
  }

  // 2. MAINTENANCE — dashboard override.
  if (inputs.maintenanceMode) {
    return {
      mode: 'MAINTENANCE',
      newStormHoldUntil: null,
      reason: 'maintenance: dashboard override',
      explanation: {
        decidedBy: 'Wartung: über das Dashboard aktiviert',
        factors: ['Automatik pausiert (Wartungsmodus)'],
      },
    };
  }

  // 3. VACATION — explicit user preference. Beats heat-protection
  //    cascade because the user has chosen the vacation profile.
  if (inputs.switches.vacation) {
    return {
      mode: 'VACATION',
      newStormHoldUntil: null,
      reason: 'vacation: control switch on',
      explanation: {
        decidedBy: 'Urlaub: Urlaubsschalter ist aktiv',
        factors: ['Urlaubsprofil gewählt (geht vor Hitzeschutz)'],
      },
    };
  }

  // 4. NIGHT_COOLING — checked before HEATWAVE / ACTIVE because at
  //    night the actionable strategy is to flush warm air out, not
  //    to shade. The sun-down gate inside `isNightCooling` keeps this
  //    branch firmly off the daytime path.
  if (isNightCooling(inputs)) {
    // Both `outdoorTempC` and `maxPriorityRoomTempC` are guaranteed
    // non-null inside `isNightCooling`; assert with `as` to satisfy
    // strict-null without an extra runtime branch.
    const outdoor = inputs.outdoorTempC as number;
    const room = inputs.maxPriorityRoomTempC as number;
    return {
      mode: 'NIGHT_COOLING',
      newStormHoldUntil: null,
      reason: `night cooling: outdoor ${outdoor}°C cools room ${room}°C`,
      explanation: {
        decidedBy: `Nachtauskühlung: Außenluft ${f1(outdoor)} °C kühler als Raum ${f1(room)} °C`,
        factors: [
          `Außen ${f1(outdoor)} °C`,
          `wärmster Raum ${f1(room)} °C`,
          `Mindest-Differenz ${f1(inputs.rules.nightCooling.deltaC)} K`,
          'Sonne unter dem Horizont',
        ],
      },
    };
  }

  // 5. HEATWAVE.
  if (isHeatwave(inputs, t)) {
    return {
      mode: 'HEATWAVE',
      newStormHoldUntil: null,
      reason: heatwaveReason(inputs, t),
      explanation: heatExplanation(
        inputs,
        'Hitzewelle',
        t.heatwaveForecastC,
        t.heatwaveRoomC,
      ),
    };
  }

  // 6. ACTIVE_HEAT_PROTECTION.
  if (isActiveHeatProtection(inputs, t)) {
    return {
      mode: 'ACTIVE_HEAT_PROTECTION',
      newStormHoldUntil: null,
      reason: activeReason(inputs, t),
      explanation: heatExplanation(
        inputs,
        'Aktiver Hitzeschutz',
        t.activeForecastC,
        t.activeRoomC,
      ),
    };
  }

  // 7. SUMMER_WATCH.
  const summerTrigger = summerWatchTrigger(inputs, t);
  if (summerTrigger !== null) {
    return {
      mode: 'SUMMER_WATCH',
      newStormHoldUntil: null,
      reason: 'summer watch: forecast/outdoor/pv',
      explanation: summerExplanation(inputs, summerTrigger, t),
    };
  }

  // 8. NORMAL — fallback.
  return {
    mode: 'NORMAL',
    newStormHoldUntil: null,
    reason: 'normal',
    explanation: {
      decidedBy: 'Komfortbetrieb: keine Hitze-, Sturm- oder Sonderbedingung aktiv',
      factors: normalFactors(inputs, t),
    },
  };
}

// ---------------------------------------------------------------------------
// Reason string helpers — keep the strings deterministic for
// log-grepping / dashboard rendering.
// ---------------------------------------------------------------------------

function heatwaveReason(inputs: ModeInputs, t: ModeThresholds): string {
  const forecastHit =
    inputs.forecastMaxTempC !== null && inputs.forecastMaxTempC >= t.heatwaveForecastC;
  if (forecastHit) {
    return `heatwave: forecast ${inputs.forecastMaxTempC as number}°C >= ${t.heatwaveForecastC}°C`;
  }
  return `heatwave: room ${inputs.maxPriorityRoomTempC as number}°C >= ${t.heatwaveRoomC}°C`;
}

function activeReason(inputs: ModeInputs, t: ModeThresholds): string {
  const forecastHit =
    inputs.forecastMaxTempC !== null && inputs.forecastMaxTempC >= t.activeForecastC;
  if (forecastHit) {
    return `active heat protection: forecast ${inputs.forecastMaxTempC as number}°C >= ${t.activeForecastC}°C`;
  }
  return `active heat protection: room ${inputs.maxPriorityRoomTempC as number}°C >= ${t.activeRoomC}°C`;
}

// ---------------------------------------------------------------------------
// German explanation helpers (dashboard "Automatik-Logik" card).
// ---------------------------------------------------------------------------

/**
 * Build the explanation for the two heat modes (HEATWAVE /
 * ACTIVE_HEAT_PROTECTION). The deciding factor is whichever input crossed
 * its threshold first (forecast is checked before the room temperature).
 */
function heatExplanation(
  inputs: ModeInputs,
  label: string,
  forecastThresholdC: number,
  roomThresholdC: number,
): ModeExplanation {
  const forecast = inputs.forecastMaxTempC;
  const room = inputs.maxPriorityRoomTempC;
  const forecastHit = forecast !== null && forecast >= forecastThresholdC;
  const decidedBy = forecastHit
    ? `${label}: Tagesprognose ${f1(forecast as number)} °C ≥ ${forecastThresholdC} °C`
    : `${label}: wärmster Raum ${f1(room as number)} °C ≥ ${roomThresholdC} °C`;
  const factors: string[] = [];
  if (forecast !== null) {
    factors.push(`Tagesprognose ${f1(forecast)} °C (Schwelle ${forecastThresholdC} °C)`);
  }
  if (room !== null) {
    factors.push(`wärmster Raum ${f1(room)} °C (Schwelle ${roomThresholdC} °C)`);
  }
  if (factors.length === 0) {
    factors.push('Schwellwert überschritten');
  }
  return { decidedBy, factors };
}

/** Build the SUMMER_WATCH explanation from the trigger that fired. */
function summerExplanation(
  inputs: ModeInputs,
  trigger: string,
  t: ModeThresholds,
): ModeExplanation {
  let decidedBy: string;
  switch (trigger) {
    case 'forecast':
      decidedBy = `Sommer-Beobachtung: Tagesprognose ${f1(inputs.forecastMaxTempC as number)} °C ≥ ${t.summerForecastC} °C`;
      break;
    case 'outdoor':
      decidedBy = `Sommer-Beobachtung: Außentemperatur ${f1(inputs.outdoorTempC as number)} °C ≥ ${t.summerOutdoorC} °C`;
      break;
    default:
      decidedBy = `Sommer-Beobachtung: PV-Leistung ${f1(inputs.pvSmoothedKw as number)} kW > ${t.summerPvKw} kW`;
      break;
  }
  const factors: string[] = [];
  if (inputs.forecastMaxTempC !== null) {
    factors.push(`Prognose ${f1(inputs.forecastMaxTempC)} °C (Schwelle ${t.summerForecastC} °C)`);
  }
  if (inputs.outdoorTempC !== null) {
    factors.push(`Außen ${f1(inputs.outdoorTempC)} °C (Schwelle ${t.summerOutdoorC} °C)`);
  }
  if (inputs.pvSmoothedKw !== null) {
    factors.push(`PV ${f1(inputs.pvSmoothedKw)} kW (Schwelle ${t.summerPvKw} kW)`);
  }
  return { decidedBy, factors };
}

/**
 * For NORMAL, show the relevant inputs that stayed below their escalation
 * thresholds — this is what makes "why NORMAL" transparent.
 */
function normalFactors(inputs: ModeInputs, t: ModeThresholds): string[] {
  const factors: string[] = [];
  if (inputs.forecastMaxTempC !== null) {
    factors.push(`Prognose ${f1(inputs.forecastMaxTempC)} °C (< ${t.summerForecastC} °C)`);
  }
  if (inputs.outdoorTempC !== null) {
    factors.push(`Außen ${f1(inputs.outdoorTempC)} °C (< ${t.summerOutdoorC} °C)`);
  }
  if (inputs.maxPriorityRoomTempC !== null) {
    factors.push(`wärmster Raum ${f1(inputs.maxPriorityRoomTempC)} °C (< ${t.activeRoomC} °C)`);
  }
  if (inputs.pvSmoothedKw !== null) {
    factors.push(`PV ${f1(inputs.pvSmoothedKw)} kW (< ${t.summerPvKw} kW)`);
  }
  if (factors.length === 0) {
    factors.push('keine Messwerte verfügbar');
  }
  return factors;
}
