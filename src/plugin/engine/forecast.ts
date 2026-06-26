/**
 * Heat Shield — forecast lookahead (Task 8.2).
 *
 * The orchestrator's primary `runCycle` produces actions for *now*. The
 * `heatshield-state-forecast` switch (Requirement 3.3) instead has to
 * answer a different question: **will an active heat-protection phase
 * fire within the next `forecastHorizonMinutes` (default 60)?** The
 * native HMIP routine `if heatshield-state-forecast = true → start
 * scenes` lets the user wire a pre-conditioning sequence that closes
 * windows / dims lights *before* the engine starts moving shutters.
 *
 * This module is intentionally a **synthetic future-cycle**. We do not
 * call `setShutterLevel`, do not write history, and do not touch any
 * persisted state. The only thing we do is project forward in time
 * by `horizonMinutes` and re-evaluate two cheap predicates:
 *
 *   1. **Future FSM**: re-run `determineMode` with the snapshot's
 *      outdoor / forecast / PV / wind values (which hold steady on
 *      the 60-minute scale we care about) but with a sun position +
 *      sunrise key derived from `futureNow`. If the future FSM lands
 *      in `ACTIVE_HEAT_PROTECTION` or `HEATWAVE`, the answer is
 *      "yes, predict heat protection".
 *
 *   2. **Sun-on-priority-window**: for every priority window
 *      (room.priority ∈ {very_high, high}) check whether the future
 *      sun position falls inside the window's incidence cone *and*
 *      the room is already warm (within 1.5 °C of `warning_c`). The
 *      sun-on-window branch covers the case where the FSM has not
 *      yet escalated past `SUMMER_WATCH` but a priorised room is on
 *      track to warm up further once the sun lands on its glass.
 *
 * The first match short-circuits — we only need a single trigger to
 * decide "yes, the engine will heat-protect". The deterministic
 * `reason` string is surfaced through the dashboard's diagnostics tab
 * and the decision-record sink (Task 13).
 *
 * Module rules (mirrored from sibling engine modules):
 *   - Pure: no fs, no logging, no Connect-API artefacts, no globals.
 *   - Strict TS, ESM, `.js` import suffixes.
 *   - Same inputs → same outputs. Tests pin a deterministic UTC
 *     timestamp.
 */

import type { Config, Mode, Priority, Window } from '../../shared/types.js';

import { determineMode, isHeatModeActive } from './modes.js';
import type { CycleSnapshot } from './orchestrator.js';
import * as sunModule from './sun.js';

// ---------------------------------------------------------------------------
// Public types.
// ---------------------------------------------------------------------------

/**
 * Inputs for one forecast lookahead. The orchestrator / dashboard
 * builds this object from the same `CycleSnapshot` it feeds into
 * `runCycle`; otherwise {@link computeForecastLookahead} is pure.
 *
 *   - `horizonMinutes` is supplied explicitly (rather than read out of
 *     `config.rules.automation`) so callers can run multiple horizons
 *     in parallel (e.g. the dashboard's "what would happen in 30 / 60
 *     / 120 min" probe).
 *   - `sun` is an opt-in module override for testability. Defaults to
 *     the live `engine/sun.ts` module.
 */
export interface ForecastInputs {
  snapshot: CycleSnapshot;
  config: Config;
  horizonMinutes: number;
  sun?: typeof import('./sun.js');
}

/**
 * Result of one forecast lookahead.
 *
 *   - `willHeatProtect` is the boolean fed straight into
 *     `heatshield-state-forecast.switchState`.
 *   - `checkedAt` is the UTC instant the lookahead was *evaluated for*
 *     — i.e. `snapshot.now`. The dashboard renders the relative offset
 *     ("predicted at 10:00, horizon 60 min").
 *   - `horizonMinutes` echoes the input so consumers can store the
 *     result alongside the horizon it was computed against.
 *   - `reason` is a deterministic, human-readable string. Stable
 *     wording so log-grepping / regression tests stay simple.
 */
export interface ForecastResult {
  willHeatProtect: boolean;
  checkedAt: Date;
  horizonMinutes: number;
  reason: string;
}

// ---------------------------------------------------------------------------
// Constants / helpers.
// ---------------------------------------------------------------------------

/**
 * Priority levels that count as "priorised rooms" for the sun-on-window
 * branch — same set the orchestrator uses for the priority-room temp
 * aggregation (steering: `Schlafzimmer` and `Arbeitszimmer`).
 */
const PRIORITY_LEVELS: ReadonlySet<Priority> = new Set<Priority>([
  'very_high',
  'high',
]);

/**
 * Buffer below `warning_c` at which a room counts as "warm" for the
 * sun-on-window branch. The 1.5 °C value matches the regelwerk §13
 * bedroom rule (warm sleeping rooms start at 23.0 °C, warning at
 * 24.5 °C → buffer of 1.5 °C). Lifting the buffer to 2 °C would also
 * be defensible, but 1.5 °C keeps the prediction in lockstep with the
 * §13 special-rules layer that fires for the same room.
 */
const WARM_BUFFER_C = 1.5;

/**
 * Build the `Pick<Window, 'orientationDeg' | 'type'>` shape that
 * `sunOnWindow` expects. Avoids leaking the full `Window` schema into
 * the predicate signature so the helper stays trivially testable.
 */
function windowGeometry(w: Window): Pick<Window, 'orientationDeg' | 'type'> {
  return { orientationDeg: w.orientationDeg, type: w.type };
}

// ---------------------------------------------------------------------------
// Top-level: computeForecastLookahead.
// ---------------------------------------------------------------------------

/**
 * Project the engine forward by `horizonMinutes` and decide whether
 * the heat-protection logic will be active at that future instant.
 *
 * Algorithm (see module header for the rationale):
 *
 *   1. Compute `futureNow = snapshot.now + horizonMinutes * 60_000`.
 *   2. Look up the sun position + day key events at `futureNow`.
 *   3. Re-run the mode FSM with the snapshot's outdoor/forecast/PV/
 *      wind values but with the future sun position + sunrise. If the
 *      result is in `HEAT_MODE_ACTIVE`, return early.
 *   4. Otherwise, scan each priority window. If the future sun is on
 *      the window AND the corresponding room is already warm (within
 *      1.5 °C of `warning_c`), return early.
 *   5. Else, return `willHeatProtect: false`.
 *
 * Pure with respect to the inputs — no side effects, no I/O.
 */
export function computeForecastLookahead(inputs: ForecastInputs): ForecastResult {
  const sun = inputs.sun ?? sunModule;
  const horizonMs = inputs.horizonMinutes * 60 * 1000;
  const futureNow = new Date(inputs.snapshot.now.getTime() + horizonMs);

  // -------------------------------------------------------------------------
  // 1. Future sun position + sunrise key.
  // -------------------------------------------------------------------------
  const futureSunPos = sun.getSunPosition(futureNow, inputs.config.location);
  const futureSunDay = sun.getSunDay(futureNow, inputs.config.location);

  // -------------------------------------------------------------------------
  // 2. Maximum priority-room temp (mirrors orchestrator helper). We
  //    inline the loop here rather than import a private helper from
  //    the orchestrator so this module stays self-contained.
  // -------------------------------------------------------------------------
  let maxRoomC: number | null = null;
  for (const room of inputs.snapshot.rooms.values()) {
    if (!PRIORITY_LEVELS.has(room.priority)) {
      continue;
    }
    if (room.tempC === null) {
      continue;
    }
    if (maxRoomC === null || room.tempC > maxRoomC) {
      maxRoomC = room.tempC;
    }
  }

  // -------------------------------------------------------------------------
  // 3. Future FSM.
  //
  //    Outdoor / forecast / PV / wind values are reused as-is —
  //    these signals do not change meaningfully on a 60-minute
  //    horizon, and we have no per-cycle weather forecast feed at
  //    minute resolution. Switch states (vacation, pause) and
  //    maintenance mode are also held steady; if the user toggles
  //    one mid-horizon, the next cycle's lookahead reflects that.
  //
  //    `stormHoldUntil` is forwarded unchanged so a still-active
  //    storm hold correctly suppresses heat-protection prediction.
  // -------------------------------------------------------------------------
  const futureMode: Mode = determineMode({
    now: futureNow,
    outdoorTempC: inputs.snapshot.outdoorTempC,
    forecastMaxTempC: inputs.snapshot.forecastMaxTempC,
    pvSmoothedKw: inputs.snapshot.pvSmoothedKw,
    windSpeedMs: inputs.snapshot.windSpeedMs,
    maxPriorityRoomTempC: maxRoomC,
    sunriseUtc: futureSunDay.sunriseUtc,
    sunIsUp: futureSunPos.isUp,
    switches: inputs.snapshot.switches,
    maintenanceMode: inputs.snapshot.maintenanceMode,
    stormHoldUntil: inputs.snapshot.stormHoldUntil,
    rules: {
      storm: inputs.config.rules.storm,
      nightCooling: inputs.config.rules.nightCooling,
    },
  }).mode;

  if (isHeatModeActive(futureMode)) {
    return {
      willHeatProtect: true,
      checkedAt: inputs.snapshot.now,
      horizonMinutes: inputs.horizonMinutes,
      reason: `future FSM mode ${futureMode} within ${inputs.horizonMinutes} min`,
    };
  }

  // -------------------------------------------------------------------------
  // 4. Sun-on-priority-window scan.
  //
  //    The FSM did not escalate to ACTIVE_HEAT_PROTECTION / HEATWAVE,
  //    but a priorised room may still be on a heating trajectory:
  //    forecast says 24 °C (so SUMMER_WATCH), the room is already
  //    23.4 °C, and within the next 60 min the sun lands on its
  //    SE-facing roof window. The §13 special rules will then clamp
  //    the shutter to 0.9+ on the *real* cycle; we surface that
  //    expectation here so the routine pre-condition fires in time.
  // -------------------------------------------------------------------------
  for (const winEntry of inputs.snapshot.windows) {
    const winCfg = winEntry.config;
    const room = inputs.snapshot.rooms.get(winCfg.roomId);
    if (room === undefined) {
      continue;
    }
    if (!PRIORITY_LEVELS.has(room.priority)) {
      continue;
    }
    if (room.tempC === null) {
      continue;
    }
    const warmThresholdC = room.targets.warning_c - WARM_BUFFER_C;
    if (room.tempC < warmThresholdC) {
      continue;
    }
    const onWindow = sun.sunOnWindow(
      futureSunPos,
      windowGeometry(winCfg),
      inputs.config.rules.sun,
    );
    if (!onWindow) {
      continue;
    }
    return {
      willHeatProtect: true,
      checkedAt: inputs.snapshot.now,
      horizonMinutes: inputs.horizonMinutes,
      reason: `sun on priority window ${winCfg.id} at +${inputs.horizonMinutes}min with warm room ${room.tempC.toFixed(1)}°C`,
    };
  }

  // -------------------------------------------------------------------------
  // 5. No trigger — heat protection not predicted.
  // -------------------------------------------------------------------------
  return {
    willHeatProtect: false,
    checkedAt: inputs.snapshot.now,
    horizonMinutes: inputs.horizonMinutes,
    reason: `no heat protection predicted within ${inputs.horizonMinutes} min`,
  };
}
