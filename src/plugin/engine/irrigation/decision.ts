/**
 * Heat Shield — irrigation decision engine (pure & testable).
 *
 * Turns a zone's water-balance dose + the environment + the operating mode
 * into a concrete action: water (with seconds/passes), skip (with a reason),
 * or hold. Encodes every gate from the concept: mode scaling, rain-skip
 * (current + forecast), frost lockout, wind skip (sprinkler drift), watering
 * time-window, daily water budget, and a measured-moisture override.
 *
 * Sequencing across zones (flow limit) is applied by the caller after it has
 * collected each zone's intent — see {@link orderForSequencing}.
 */

import type { DoseResult } from './waterBalance.js';

export type IrrigationMode =
  | 'off'
  | 'eco'
  | 'normal'
  | 'heat'
  | 'vacation'
  | 'establishment';

export type ZonePriority = 'low' | 'normal' | 'high' | 'critical';

export type IrrigationAction = 'water' | 'skip' | 'hold';

export type IrrigationBlock =
  | 'disabled'
  | 'mode_off'
  | 'storm'
  | 'frost'
  | 'wind'
  | 'rain_now'
  | 'rain_forecast'
  | 'out_of_window'
  | 'budget'
  | 'moist_enough'
  | 'no_valve'
  | 'cooldown';

export interface ModeFactors {
  /** Multiplier applied to the computed dose seconds. */
  readonly doseFactor: number;
  /** Extra depletion headroom: water a bit earlier when > 0 (mm). */
  readonly triggerBiasMm: number;
}

/** Per-mode behaviour. `establishment` waters little & often; `eco` is lean. */
export function modeFactors(mode: IrrigationMode): ModeFactors {
  switch (mode) {
    case 'off':
      return { doseFactor: 0, triggerBiasMm: 0 };
    case 'eco':
      return { doseFactor: 0.8, triggerBiasMm: -3 };
    case 'normal':
      return { doseFactor: 1, triggerBiasMm: 0 };
    case 'heat':
      return { doseFactor: 1.2, triggerBiasMm: 3 };
    case 'vacation':
      return { doseFactor: 1, triggerBiasMm: 0 };
    case 'establishment':
      return { doseFactor: 0.6, triggerBiasMm: 6 };
  }
}

export interface DecisionEnv {
  /** Local hour (0..23) for the watering window check. */
  readonly hour: number;
  /** Rain falling right now (mm in the last step). */
  readonly rainNowMm: number;
  /** Forecast rainfall (mm) within the configured look-ahead window. */
  readonly rainForecastMm: number;
  /** Soil temperature (°C) if known, else air temperature. */
  readonly soilTempC: number | null;
  /** Wind speed (m/s) for sprinkler drift. */
  readonly windMs: number | null;
  /** Measured volumetric soil moisture (%) if a sensor is bound. */
  readonly measuredMoisturePct: number | null;
  /** True when STORM mode is active (highest-priority lockout). */
  readonly storm: boolean;
}

export interface ZoneGates {
  readonly enabled: boolean;
  readonly hasValve: boolean;
  readonly allowedStartHour: number;
  readonly allowedEndHour: number;
  readonly maxDailySeconds: number;
  readonly dailySecondsUsed: number;
  /** Minutes since last watering; null = never. */
  readonly minutesSinceLast: number | null;
  /** Minimum minutes between two waterings for this zone. */
  readonly cooldownMinutes: number;
  readonly priority: ZonePriority;
  /** Moisture (%) above which watering is skipped even if modeled dry. */
  readonly moistCeilingPct: number;
}

export interface GlobalGates {
  readonly mode: IrrigationMode;
  readonly rainSkipMm: number;
  readonly frostLockoutC: number;
  readonly windSkipMs: number;
}

export interface IrrigationDecision {
  readonly action: IrrigationAction;
  readonly seconds: number;
  readonly passes: number;
  readonly secondsPerPass: number;
  readonly reason: string;
  readonly blockedBy: IrrigationBlock | null;
  readonly priority: ZonePriority;
}

const HOLD = (reason: string, blockedBy: IrrigationBlock, priority: ZonePriority): IrrigationDecision => ({
  action: blockedBy === 'moist_enough' || blockedBy === 'cooldown' ? 'hold' : 'skip',
  seconds: 0,
  passes: 0,
  secondsPerPass: 0,
  reason,
  blockedBy,
  priority,
});

/** Is `hour` inside the (possibly midnight-wrapping) [start, end) window? */
export function inWindow(hour: number, start: number, end: number): boolean {
  if (start === end) return true; // 24 h window
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end; // wraps midnight
}

/**
 * Decide a single zone's action. `dose` is the balance-derived dose (already
 * accounts for depletion ≥ RAW). Gates are evaluated in priority order;
 * STORM and frost always win.
 */
export function decideZone(
  dose: DoseResult,
  gates: ZoneGates,
  env: DecisionEnv,
  global: GlobalGates,
): IrrigationDecision {
  const prio = gates.priority;
  if (!gates.enabled) return HOLD('Zone deaktiviert', 'disabled', prio);
  if (!gates.hasValve) return HOLD('Kein Ventil zugeordnet', 'no_valve', prio);
  if (env.storm) return HOLD('Sturm – Bewässerung gesperrt', 'storm', prio);
  if (global.mode === 'off') return HOLD('Modus AUS', 'mode_off', prio);

  // Frost lockout (soil/air temp at/below threshold).
  if (env.soilTempC !== null && env.soilTempC <= global.frostLockoutC) {
    return HOLD(`Frostschutz (${env.soilTempC.toFixed(1)} °C)`, 'frost', prio);
  }

  // Measured moisture override — already wet enough.
  if (env.measuredMoisturePct !== null && env.measuredMoisturePct >= gates.moistCeilingPct) {
    return HOLD(
      `Boden feucht genug (${Math.round(env.measuredMoisturePct)} %)`,
      'moist_enough',
      prio,
    );
  }

  if (!dose.needed) {
    return HOLD('Kein Bedarf (über Schwelle)', 'moist_enough', prio);
  }

  // Rain gates.
  if (env.rainNowMm > 0.2) {
    return HOLD(`Es regnet (${env.rainNowMm.toFixed(1)} mm)`, 'rain_now', prio);
  }
  if (env.rainForecastMm >= global.rainSkipMm) {
    return HOLD(
      `Regen erwartet (${env.rainForecastMm.toFixed(1)} mm)`,
      'rain_forecast',
      prio,
    );
  }

  // Wind drift (sprinklers/rotors): the caller passes windMs; drip is exempt
  // because precipRate-based dose is unaffected — caller sets windMs=null for drip.
  if (env.windMs !== null && env.windMs >= global.windSkipMs) {
    return HOLD(`Zu windig (${env.windMs.toFixed(1)} m/s)`, 'wind', prio);
  }

  // Cooldown between waterings.
  if (gates.minutesSinceLast !== null && gates.minutesSinceLast < gates.cooldownMinutes) {
    return HOLD('Mindestpause aktiv', 'cooldown', prio);
  }

  // Watering window.
  if (!inWindow(env.hour, gates.allowedStartHour, gates.allowedEndHour)) {
    return HOLD('Außerhalb des Zeitfensters', 'out_of_window', prio);
  }

  // Apply mode scaling.
  const mf = modeFactors(global.mode);
  let seconds = Math.round(dose.totalSeconds * mf.doseFactor);
  if (seconds <= 0) return HOLD('Modus skaliert auf 0', 'mode_off', prio);

  // Daily budget cap.
  const remaining = Math.max(0, gates.maxDailySeconds - gates.dailySecondsUsed);
  if (gates.maxDailySeconds > 0 && remaining <= 0) {
    return HOLD('Tagesbudget erreicht', 'budget', prio);
  }
  if (gates.maxDailySeconds > 0 && seconds > remaining) {
    seconds = remaining;
  }

  const passes = Math.max(1, dose.passes);
  const secondsPerPass = Math.max(1, Math.round(seconds / passes));
  return {
    action: 'water',
    seconds,
    passes,
    secondsPerPass,
    reason: `Bewässern: Defizit ${dose.depthMm.toFixed(1)} mm`,
    blockedBy: null,
    priority: prio,
  };
}

const PRIORITY_RANK: Record<ZonePriority, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
};

/**
 * Order zones that want water by priority (critical first), so a caller
 * honoring a concurrent-valve flow limit serves the most important zones
 * first. Stable for equal priorities (preserves input order).
 */
export function orderForSequencing<T extends { decision: IrrigationDecision }>(
  zones: readonly T[],
): T[] {
  return zones
    .map((z, i) => ({ z, i }))
    .sort((a, b) => {
      const pa = PRIORITY_RANK[a.z.decision.priority];
      const pb = PRIORITY_RANK[b.z.decision.priority];
      return pa !== pb ? pa - pb : a.i - b.i;
    })
    .map((x) => x.z);
}
