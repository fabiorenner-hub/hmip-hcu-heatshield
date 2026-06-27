/**
 * Heat Shield — irrigation controller (orchestration).
 *
 * Owns the per-zone water-balance runtime, drives the engine each cycle, learns
 * the dry-down behaviour, forecasts the next watering, and dispatches Gardena
 * valve/pump/mower commands. Persists its runtime + a rolling observation log
 * under `/data/irrigation.json` (persistence only under /data per steering).
 *
 * Stages implemented:
 *   0  read sensors + manual valve control
 *   1  schedule + rain-skip + windows + budgets
 *   2  ET-based FAO-56 water balance per zone, closed loop via moisture sensor
 *   3  learning (Kc + precip-rate calibration, emitter-fault), PV-preferred,
 *      mower coordination, leak/fault surfacing, cycle-and-soak, sequencing
 *   4  forecast model (next-watering ETA, moisture trajectory) + optimisation
 *
 * Safety: actuation only when `irrigation.enabled` AND a valve is bound; STORM
 * locks everything; frost/rain/wind/budget/cooldown gates apply; concurrent
 * valves capped by `maxConcurrentValves`.
 */

import { promises as fs } from 'node:fs';

import type { GardenaCloudAdapter } from '../sources/gardena.js';
import type { OpenMeteoAdapter } from '../sources/openMeteo.js';
import {
  decideZone,
  modeFactors,
  orderForSequencing,
  type DecisionEnv,
  type GlobalGates,
  type IrrigationDecision,
  type IrrigationMode,
  type ZoneGates,
} from '../engine/irrigation/decision.js';
import {
  forecastZone,
  dailyNeedMm,
  type IrrigationForecast,
} from '../engine/irrigation/forecast.js';
import {
  learnZoneModel,
  NEUTRAL_MODEL,
  type IrrigationObservation,
  type LearnedZoneModel,
} from '../engine/irrigation/learn.js';
import {
  defaultEmitterRate,
  defaultKc,
  defaultMad,
  defaultRootDepthCm,
  depthMmToSeconds,
  secondsToDepthMm,
} from '../engine/irrigation/soilModel.js';
import {
  advanceBalance,
  computeDose,
  effectiveRainMm,
  type ZoneProfile,
} from '../engine/irrigation/waterBalance.js';
import type { Config, IrrigationConfig, IrrigationZone } from '../../shared/types.js';

type Logger = (
  level: 'info' | 'warn' | 'error',
  msg: string,
  ctx?: Record<string, unknown>,
) => void;

export interface IrrigationControllerDeps {
  config: () => Config;
  gardena: () => GardenaCloudAdapter | null;
  openMeteo: () => OpenMeteoAdapter;
  pvSurplusKw: () => number | null;
  statePath: string;
  now?: () => Date;
  logger?: Logger;
  /** Emit a dashboard/notification event. */
  emit?: (event: { type: string; payload: unknown }) => void;
}

interface ZoneRuntime {
  depletionMm: number;
  lastWateredAtMs: number | null;
  dailySecondsUsed: number;
  dayKey: string;
  // Daily accumulators for the learning observation.
  dayEt0Mm: number;
  dayRainMm: number;
  dayIrrigationMm: number;
  dayIrrigationSeconds: number;
  moistureStartPct: number | null;
  skippedDayKey: string | null;
  /** Epoch ms until which this zone's valve is expected to stay open. */
  openUntilMs: number | null;
}

interface PersistedState {
  zones: Record<string, ZoneRuntime>;
  observations: Record<string, IrrigationObservation[]>;
  lastCycleMs: number | null;
  pausedUntilMs: number | null;
  /** Editable day-ahead watering plan (auto-seeded + user-moved entries). */
  plan: PlanEntry[];
  /** Auto-entry ids the user deleted, so we don't re-seed them. */
  suppressedPlanIds: string[];
}

/**
 * One scheduled watering in the day-ahead plan. `startTs` is an absolute ISO
 * timestamp (no timezone ambiguity); the UI renders/edits it in local time.
 * `source` distinguishes engine-seeded ('auto') from user-created ('manual')
 * entries; `doneTs` is set once the controller has dispatched it.
 */
interface PlanEntry {
  id: string;
  zoneId: string;
  startTs: string;
  durationMin: number;
  enabled: boolean;
  source: 'auto' | 'manual';
  doneTs: string | null;
}

const MAX_OBS_PER_ZONE = 60;

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
  /** Configured watering window (local hours). */
  windowStartHour: number;
  windowEndHour: number;
  /** ISO time the valve is expected to close (when currently open), else null. */
  openUntilTs: string | null;
  nextActionLabel: string;
  blockedBy: string | null;
  hoursUntilNext: number | null;
  nextWateringTs: string | null;
  /** Estimated valve runtime (s) for the next forecast watering, else null. */
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

export interface IrrigationSnapshot {
  enabled: boolean;
  mode: IrrigationMode;
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
  plan: IrrigationPlanView[];
}

/** One editable day-ahead plan entry, resolved for the dashboard. */
export interface IrrigationPlanView {
  id: string;
  zoneId: string;
  zoneName: string;
  startTs: string;
  durationMin: number;
  enabled: boolean;
  source: 'auto' | 'manual';
  done: boolean;
}

export class IrrigationController {
  private readonly deps: IrrigationControllerDeps;
  private readonly now: () => Date;
  private readonly logger: Logger | null;
  private state: PersistedState = {
    zones: {},
    observations: {},
    lastCycleMs: null,
    pausedUntilMs: null,
    plan: [],
    suppressedPlanIds: [],
  };
  private learned: Map<string, LearnedZoneModel> = new Map();
  private lastDecisions: Map<string, IrrigationDecision> = new Map();
  private loaded = false;

  public constructor(deps: IrrigationControllerDeps) {
    this.deps = deps;
    this.now = deps.now ?? ((): Date => new Date());
    this.logger = deps.logger ?? null;
  }

  // -------------------------------------------------------------------------
  // Persistence.
  // -------------------------------------------------------------------------

  public async init(): Promise<void> {
    try {
      const raw = await fs.readFile(this.deps.statePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedState>;
      this.state = {
        zones: parsed.zones ?? {},
        observations: parsed.observations ?? {},
        lastCycleMs: parsed.lastCycleMs ?? null,
        pausedUntilMs: parsed.pausedUntilMs ?? null,
        plan: parsed.plan ?? [],
        suppressedPlanIds: parsed.suppressedPlanIds ?? [],
      };
    } catch {
      // fresh start
    }
    this.recomputeLearned();
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    try {
      await fs.writeFile(this.deps.statePath, JSON.stringify(this.state), 'utf8');
    } catch (err) {
      this.log('warn', 'irrigation persist failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private recomputeLearned(): void {
    this.learned.clear();
    const cfg = this.cfg();
    for (const zone of cfg.zones) {
      const obs = this.state.observations[zone.id] ?? [];
      const model = learnZoneModel(obs, zone.soil, this.rootDepth(zone));
      this.learned.set(zone.id, model);
    }
  }

  // -------------------------------------------------------------------------
  // Helpers.
  // -------------------------------------------------------------------------

  private cfg(): IrrigationConfig {
    return this.deps.config().irrigation;
  }

  private rootDepth(z: IrrigationZone): number {
    return z.rootDepthCm > 0 ? z.rootDepthCm : defaultRootDepthCm(z.plant);
  }

  private effectiveProfile(z: IrrigationZone): ZoneProfile {
    const learned = this.learned.get(z.id) ?? NEUTRAL_MODEL;
    const baseKc = z.kc > 0 ? z.kc : defaultKc(z.plant);
    const precipBase = z.precipRateMmH > 0 ? z.precipRateMmH : defaultEmitterRate(z.emitter);
    return {
      plant: z.plant,
      soil: z.soil,
      exposure: z.exposure,
      slope: z.slope,
      rootDepthCm: this.rootDepth(z),
      kc: baseKc * learned.kcFactor,
      mad: z.mad > 0 ? z.mad : defaultMad(z.plant),
      precipRateMmH: precipBase * learned.precipRateFactor,
    };
  }

  private dayKey(now: Date): string {
    return now.toISOString().slice(0, 10);
  }

  private zoneRuntime(zoneId: string, now: Date): ZoneRuntime {
    const existing = this.state.zones[zoneId];
    if (existing !== undefined) return existing;
    const fresh: ZoneRuntime = {
      depletionMm: 0,
      lastWateredAtMs: null,
      dailySecondsUsed: 0,
      dayKey: this.dayKey(now),
      dayEt0Mm: 0,
      dayRainMm: 0,
      dayIrrigationMm: 0,
      dayIrrigationSeconds: 0,
      moistureStartPct: null,
      skippedDayKey: null,
      openUntilMs: null,
    };
    this.state.zones[zoneId] = fresh;
    return fresh;
  }

  private measuredMoisture(z: IrrigationZone): number | null {
    if (z.moistureSensorDeviceId === '') return null;
    const g = this.deps.gardena();
    if (g === null) return null;
    const sensor = g.listSensors().find((s) => s.deviceId === z.moistureSensorDeviceId);
    return sensor?.soilHumidityPct ?? null;
  }

  /**
   * Soil temperature (°C) from the zone's bound Gardena sensor, used for the
   * per-zone frost gate and display. Null when no sensor is bound or it has no
   * reading — the caller falls back to the OpenMeteo soil temperature.
   */
  private measuredSoilTempC(z: IrrigationZone): number | null {
    if (z.moistureSensorDeviceId === '') return null;
    const g = this.deps.gardena();
    if (g === null) return null;
    const sensor = g.listSensors().find((s) => s.deviceId === z.moistureSensorDeviceId);
    return sensor?.soilTempC ?? null;
  }

  private log(level: 'info' | 'warn' | 'error', msg: string, ctx?: Record<string, unknown>): void {
    if (this.logger === null) return;
    try {
      this.logger(level, msg, ctx);
    } catch {
      /* never break the controller */
    }
  }

  // -------------------------------------------------------------------------
  // Mode selection.
  // -------------------------------------------------------------------------

  private resolveMode(): IrrigationMode {
    const cfg = this.cfg();
    if (!cfg.autoMode) return cfg.mode;
    // Auto: derive from weather. Heat → heat; otherwise normal. Vacation /
    // establishment are explicit-only.
    const om = this.deps.openMeteo();
    const maxT = om.getDailySummary()[0]?.tempMaxC ?? null;
    if (maxT !== null && maxT >= 30) return 'heat';
    return 'normal';
  }

  // -------------------------------------------------------------------------
  // Cycle.
  // -------------------------------------------------------------------------

  public async runCycle(): Promise<void> {
    if (!this.loaded) await this.init();
    const cfg = this.cfg();
    const now = this.now();
    const nowMs = now.getTime();
    const dayKey = this.dayKey(now);
    const om = this.deps.openMeteo();
    const g = this.deps.gardena();

    // Elapsed time for ET integration (clamp to avoid huge jumps after downtime).
    const dtHours =
      this.state.lastCycleMs === null
        ? 0
        : Math.max(0, Math.min(3, (nowMs - this.state.lastCycleMs) / 3_600_000));
    this.state.lastCycleMs = nowMs;

    const et0HourMm = om.getCurrentHourEt0Mm(now) ?? (om.getEt0TodayMm() ?? 0) / 24;
    const rainHourMm = this.currentHourRainMm(om, now);
    const soilTempEnv = om.getSoilTempC() ?? (om.getValue('temperature')?.value ?? null);
    const windMs = om.getValue('windSpeed')?.value ?? null;
    const rainForecastMm = om.getForecastRainMm(now, cfg.rainSkipWindowH);
    const mode = this.resolveMode();
    const storm = this.isStorm();
    const mowerActive = cfg.mowerCoordination && g !== null ? g.isMowerActive(cfg.mowerServiceId || undefined) : false;
    const pvSurplus = this.deps.pvSurplusKw();

    const global: GlobalGates = {
      mode,
      rainSkipMm: cfg.rainSkipMm,
      frostLockoutC: cfg.frostLockoutC,
      windSkipMs: cfg.windSkipMs,
    };
    const triggerBiasMm = modeFactors(mode).triggerBiasMm;
    const disabledValves = new Set(cfg.disabledValveIds);

    // Per-zone: advance balance + form intent.
    interface Intent {
      zone: IrrigationZone;
      decision: IrrigationDecision;
      appliedDepthMm: number;
    }
    const intents: Intent[] = [];
    let totalSecondsToday = 0;

    for (const zone of cfg.zones) {
      const rt = this.zoneRuntime(zone.id, now);
      // Day rollover → record observation, relearn, reset accumulators.
      if (rt.dayKey !== dayKey) {
        this.rolloverZone(zone, rt, now);
      }
      const profile = this.effectiveProfile(zone);
      const measured = this.measuredMoisture(zone);
      const etInc = et0HourMm * dtHours;
      const rainInc = rainHourMm * dtHours;

      const balance = advanceBalance(profile, {
        prevDepletionMm: rt.depletionMm,
        et0Mm: etInc,
        rainMm: effectiveRainMm(rainInc),
        irrigationMm: 0,
        ...(measured !== null ? { measuredMoisturePct: measured, sensorWeight: cfg.sensorWeight } : {}),
      });
      rt.depletionMm = balance.depletionMm;
      rt.dayEt0Mm += etInc;
      rt.dayRainMm += rainInc;
      if (rt.moistureStartPct === null && measured !== null) rt.moistureStartPct = measured;
      totalSecondsToday += rt.dailySecondsUsed;

      const dose = computeDose(profile, balance, triggerBiasMm);
      const hasValve =
        zone.valveServiceId !== '' &&
        !disabledValves.has(zone.valveServiceId) &&
        g !== null &&
        g.hasValve(zone.valveServiceId);

      // Wind only gates sprinkler/rotor zones.
      const windForZone = zone.emitter === 'sprinkler' || zone.emitter === 'rotor' ? windMs : null;
      const gates: ZoneGates = {
        enabled: cfg.enabled && zone.enabled && rt.skippedDayKey !== dayKey,
        hasValve,
        allowedStartHour: zone.allowedStartHour,
        allowedEndHour: zone.allowedEndHour,
        maxDailySeconds: zone.maxDailySeconds,
        dailySecondsUsed: rt.dailySecondsUsed,
        minutesSinceLast:
          rt.lastWateredAtMs === null ? null : (nowMs - rt.lastWateredAtMs) / 60_000,
        cooldownMinutes: zone.cooldownMinutes,
        priority: zone.priority,
        moistCeilingPct: zone.moistCeilingPct,
      };
      const env: DecisionEnv = {
        hour: now.getUTCHours(),
        rainNowMm: rainHourMm,
        rainForecastMm,
        // Prefer the zone's own Gardena soil-temperature sensor; fall back to
        // the OpenMeteo soil/air temperature when no sensor is bound.
        soilTempC: this.measuredSoilTempC(zone) ?? soilTempEnv,
        windMs: windForZone,
        measuredMoisturePct: measured,
        storm,
      };

      let decision = decideZone(dose, gates, env, global);

      // Mower coordination + PV-preferred deferrals (controller-level gates).
      if (decision.action === 'water' && mowerActive) {
        decision = { ...decision, action: 'hold', seconds: 0, reason: 'Mäher aktiv – warte', blockedBy: 'cooldown' };
      }
      if (
        decision.action === 'water' &&
        cfg.pvPreferred &&
        zone.priority !== 'critical' &&
        pvSurplus !== null &&
        pvSurplus < cfg.pvSurplusKw
      ) {
        decision = { ...decision, action: 'hold', seconds: 0, reason: 'Warte auf PV-Überschuss', blockedBy: 'cooldown' };
      }

      this.lastDecisions.set(zone.id, decision);
      intents.push({
        zone,
        decision,
        appliedDepthMm: secondsToDepthMm(decision.seconds, profile.precipRateMmH),
      });
    }

    // Day-ahead plan: seed/prune editable entries, then execute any due entry
    // (explicit user intent — takes the single-valve slot before auto runs).
    await this.runPlan(now);

    // Sequencing: HARD RULE — only ONE valve open at a time on the shared
    // water supply. We never open a second valve while any is open.
    const wanting = orderForSequencing(intents.filter((i) => i.decision.action === 'water'));
    const alreadyOn = this.countOpenValves();
    let slots = alreadyOn > 0 ? 0 : 1;
    let globalRemaining =
      cfg.maxDailySecondsTotal > 0
        ? Math.max(0, cfg.maxDailySecondsTotal - totalSecondsToday)
        : Number.POSITIVE_INFINITY;

    for (const intent of wanting) {
      if (slots <= 0) break;
      if (globalRemaining <= 0) break;
      const rt = this.zoneRuntime(intent.zone.id, now);
      const seconds = Math.min(intent.decision.seconds, globalRemaining);
      if (seconds < 30) continue;
      await this.dispatchWater(intent.zone, seconds, intent.appliedDepthMm, rt, nowMs);
      slots -= 1;
      globalRemaining -= seconds;
    }

    await this.persist();
  }

  private async dispatchWater(
    zone: IrrigationZone,
    seconds: number,
    appliedDepthMm: number,
    rt: ZoneRuntime,
    nowMs: number,
  ): Promise<void> {
    const g = this.deps.gardena();
    if (g === null) return;
    try {
      // Enforce single-valve: close any other open valve before opening this
      // one (shared water supply — only one valve at a time).
      await g.closeOtherValves(zone.valveServiceId);
      // Run the pump first if configured.
      const cfg = this.cfg();
      if (cfg.pumpSocketId !== '') {
        await g.setPowerSocket(cfg.pumpSocketId, true, seconds + 30);
      }
      await g.setValve(zone.valveServiceId, true, seconds);
      rt.lastWateredAtMs = nowMs;
      rt.openUntilMs = nowMs + seconds * 1000;
      rt.dailySecondsUsed += seconds;
      rt.dayIrrigationSeconds += seconds;
      rt.dayIrrigationMm += appliedDepthMm;
      rt.depletionMm = Math.max(0, rt.depletionMm - appliedDepthMm);
      this.log('info', 'irrigation watering', {
        zone: zone.id,
        seconds,
        mm: Math.round(appliedDepthMm * 10) / 10,
      });
      this.deps.emit?.({
        type: 'irrigation.watering',
        payload: { zoneId: zone.id, name: zone.name, seconds },
      });
    } catch (err) {
      this.log('warn', 'irrigation dispatch failed', {
        zone: zone.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private rolloverZone(zone: IrrigationZone, rt: ZoneRuntime, now: Date): void {
    const measured = this.measuredMoisture(zone);
    const obs: IrrigationObservation = {
      date: rt.dayKey,
      et0Mm: Math.round(rt.dayEt0Mm * 100) / 100,
      rainMm: Math.round(rt.dayRainMm * 100) / 100,
      irrigationMm: Math.round(rt.dayIrrigationMm * 100) / 100,
      irrigationSeconds: rt.dayIrrigationSeconds,
      moistureStartPct: rt.moistureStartPct,
      moistureEndPct: measured,
    };
    const list = this.state.observations[zone.id] ?? [];
    list.push(obs);
    while (list.length > MAX_OBS_PER_ZONE) list.shift();
    this.state.observations[zone.id] = list;
    // Reset for the new day.
    rt.dayKey = this.dayKey(now);
    rt.dailySecondsUsed = 0;
    rt.dayEt0Mm = 0;
    rt.dayRainMm = 0;
    rt.dayIrrigationMm = 0;
    rt.dayIrrigationSeconds = 0;
    rt.moistureStartPct = measured;
    // Relearn this zone from the updated observation window.
    this.learned.set(zone.id, learnZoneModel(this.state.observations[zone.id]!, zone.soil, this.rootDepth(zone)));
  }

  private countOpenValves(): number {
    const g = this.deps.gardena();
    if (g === null) return 0;
    return g.listValves().filter((v) => v.on).length;
  }

  private currentHourRainMm(om: OpenMeteoAdapter, now: Date): number {
    const steps = om.getEt0ForecastSteps(new Date(now.getTime() - 3_600_000));
    const hourMs = 3_600_000;
    for (const s of steps) {
      const t = Date.parse(s.ts);
      if (Number.isFinite(t) && Math.abs(t - now.getTime()) <= hourMs) {
        return s.precipMm;
      }
    }
    return om.getValue('precipitation')?.value ?? 0;
  }

  private isStorm(): boolean {
    // Reuse the shutter engine's storm signal via wind threshold if available.
    const wind = this.deps.openMeteo().getValue('windSpeed')?.value ?? null;
    return wind !== null && wind >= 17; // ~ Bft 8; conservative hard lock
  }

  // -------------------------------------------------------------------------
  // Manual controls.
  // -------------------------------------------------------------------------

  public async runZone(zoneId: string, seconds?: number): Promise<void> {
    const cfg = this.cfg();
    const zone = cfg.zones.find((z) => z.id === zoneId);
    const g = this.deps.gardena();
    if (zone === undefined || g === null || zone.valveServiceId === '') {
      throw new Error('Zone oder Ventil nicht verfügbar');
    }
    const dur = seconds ?? this.deps.config().gardena.defaultWateringSeconds;
    const rt = this.zoneRuntime(zoneId, this.now());
    const profile = this.effectiveProfile(zone);
    // Single-valve guarantee: close any other open valve first.
    await g.closeOtherValves(zone.valveServiceId);
    await g.setValve(zone.valveServiceId, true, dur);
    rt.lastWateredAtMs = this.now().getTime();
    rt.openUntilMs = this.now().getTime() + dur * 1000;
    rt.dailySecondsUsed += dur;
    rt.dayIrrigationSeconds += dur;
    const mm = secondsToDepthMm(dur, profile.precipRateMmH);
    rt.dayIrrigationMm += mm;
    rt.depletionMm = Math.max(0, rt.depletionMm - mm);
    await this.persist();
  }

  public async stopZone(zoneId: string): Promise<void> {
    const cfg = this.cfg();
    const zone = cfg.zones.find((z) => z.id === zoneId);
    const g = this.deps.gardena();
    if (zone === undefined || g === null || zone.valveServiceId === '') {
      throw new Error('Zone oder Ventil nicht verfügbar');
    }
    await g.setValve(zone.valveServiceId, false);
    const rt = this.zoneRuntime(zoneId, this.now());
    rt.openUntilMs = null;
    await this.persist();
  }

  public async skipZoneToday(zoneId: string): Promise<void> {
    const rt = this.zoneRuntime(zoneId, this.now());
    rt.skippedDayKey = this.dayKey(this.now());
    await this.persist();
  }

  /**
   * Calibrate a zone's modeled soil-water to an observed availability
   * (0..100 %). Sets the running depletion so the engine + dashboard reflect
   * reality at once — e.g. "Boden ist gerade trocken" → a low percentage.
   * Needed when no moisture sensor is bound and the open-loop model otherwise
   * assumes the soil started at field capacity.
   */
  public async calibrateZone(zoneId: string, availablePct: number): Promise<void> {
    const cfg = this.cfg();
    const zone = cfg.zones.find((z) => z.id === zoneId);
    if (zone === undefined) throw new Error('Zone nicht gefunden');
    const profile = this.effectiveProfile(zone);
    const taw = profileTaw(profile);
    const frac = Math.min(1, Math.max(0, availablePct / 100));
    const rt = this.zoneRuntime(zoneId, this.now());
    rt.depletionMm = Math.min(taw, Math.max(0, taw * (1 - frac)));
    await this.persist();
  }

  // -------------------------------------------------------------------------
  // Day-ahead plan (editable, drag-to-move).
  // -------------------------------------------------------------------------

  /**
   * Seed auto entries from the forecast (one per zone, next watering within
   * 48 h, unless suppressed or a manual entry already covers that day), prune
   * stale entries, and execute any due entry honoring STORM + single-valve.
   */
  private async runPlan(now: Date): Promise<void> {
    const cfg = this.cfg();
    const nowMs = now.getTime();
    const g = this.deps.gardena();
    const disabled = new Set(cfg.disabledValveIds);
    const zoneIds = new Set(cfg.zones.map((z) => z.id));

    // Prune: drop entries for unknown zones or older than 12 h.
    this.state.plan = this.state.plan.filter(
      (e) => zoneIds.has(e.zoneId) && Date.parse(e.startTs) > nowMs - 12 * 3_600_000,
    );

    // Seed auto entries from the per-zone forecast.
    for (const zone of cfg.zones) {
      if (!zone.enabled) continue;
      const rt = this.zoneRuntime(zone.id, now);
      const profile = this.effectiveProfile(zone);
      const steps = this.deps.openMeteo().getEt0ForecastSteps(now).slice(0, 72);
      const fc = forecastZone(profile, rt.depletionMm, steps, 1);
      if (fc.nextWateringTs === null) continue;
      const startMs = Date.parse(fc.nextWateringTs);
      if (!Number.isFinite(startMs) || startMs > nowMs + 48 * 3_600_000) continue;
      const dateKey = localDateKey(new Date(startMs));
      const autoId = `auto-${zone.id}-${dateKey}`;
      if (this.state.suppressedPlanIds.includes(autoId)) continue;
      const coversDate = this.state.plan.some(
        (e) => e.zoneId === zone.id && localDateKey(new Date(Date.parse(e.startTs))) === dateKey,
      );
      if (coversDate) continue;
      const durMin = Math.round(
        depthMmToSeconds(profileRaw(profile), profile.precipRateMmH) / 60,
      );
      const dur = Math.min(180, Math.max(5, Math.round(durMin / 5) * 5));
      // Find a start that doesn't collide with an existing entry (single
      // supply → never two valves at once). Nudge later in 15-min steps.
      let seedMs = startMs;
      let tries = 0;
      while (this.planConflict(seedMs, dur, null) && tries < 16) {
        seedMs += 15 * 60_000;
        tries += 1;
      }
      if (this.planConflict(seedMs, dur, null)) continue; // no free slot — skip
      this.state.plan.push({
        id: autoId,
        zoneId: zone.id,
        startTs: new Date(seedMs).toISOString(),
        durationMin: dur,
        enabled: true,
        source: 'auto',
        doneTs: null,
      });
    }

    // Execute the earliest due entry — only when the master automation switch
    // is ON. Seeding above still runs so the plan preview stays populated, but
    // a disabled system never dispatches. STORM locks everything; single valve.
    if (!cfg.enabled || this.isStorm() || this.countOpenValves() > 0) return;
    const due = this.state.plan
      .filter((e) => e.enabled && e.doneTs === null && Date.parse(e.startTs) <= nowMs)
      .sort((a, b) => Date.parse(a.startTs) - Date.parse(b.startTs));
    for (const entry of due) {
      const lateMs = nowMs - Date.parse(entry.startTs);
      const zone = cfg.zones.find((z) => z.id === entry.zoneId);
      const hasValve =
        zone !== undefined &&
        zone.valveServiceId !== '' &&
        !disabled.has(zone.valveServiceId) &&
        g !== null &&
        g.hasValve(zone.valveServiceId);
      if (zone === undefined || !hasValve) {
        if (lateMs > 3 * 3_600_000) entry.doneTs = new Date(nowMs).toISOString();
        continue;
      }
      if (lateMs > 6 * 3_600_000) {
        entry.doneTs = new Date(nowMs).toISOString(); // missed window — clear it
        continue;
      }
      const rt = this.zoneRuntime(zone.id, now);
      const profile = this.effectiveProfile(zone);
      const seconds = Math.max(60, entry.durationMin * 60);
      const mm = secondsToDepthMm(seconds, profile.precipRateMmH);
      await this.dispatchWater(zone, seconds, mm, rt, nowMs);
      entry.doneTs = new Date(nowMs).toISOString();
      break;
    }
  }

  /** Move/resize/enable a plan entry. Editing an auto entry pins it (manual). */
  public async updatePlanEntry(
    id: string,
    patch: { startTs?: string; durationMin?: number; enabled?: boolean },
  ): Promise<void> {
    const e = this.state.plan.find((x) => x.id === id);
    if (e === undefined) throw new Error('Plan-Eintrag nicht gefunden');
    const nextStartMs = patch.startTs !== undefined ? Date.parse(patch.startTs) : Date.parse(e.startTs);
    if (!Number.isFinite(nextStartMs)) throw new Error('Ungültige Zeit');
    const nextDur =
      patch.durationMin !== undefined
        ? Math.min(180, Math.max(5, Math.round(patch.durationMin)))
        : e.durationMin;
    const nextEnabled = patch.enabled !== undefined ? patch.enabled : e.enabled;
    // Single water supply → no two enabled entries may overlap in time.
    if (nextEnabled && this.planConflict(nextStartMs, nextDur, id)) {
      throw new Error('Überschneidet sich mit einem anderen Eintrag (nur ein Ventil gleichzeitig)');
    }
    if (patch.startTs !== undefined) {
      e.startTs = new Date(nextStartMs).toISOString();
      e.doneTs = null;
    }
    e.durationMin = nextDur;
    e.enabled = nextEnabled;
    if (e.source === 'auto') e.source = 'manual';
    await this.persist();
  }

  /** Delete a plan entry. Deleting an auto entry suppresses its re-seeding. */
  public async deletePlanEntry(id: string): Promise<void> {
    const e = this.state.plan.find((x) => x.id === id);
    if (e !== undefined && e.source === 'auto' && !this.state.suppressedPlanIds.includes(id)) {
      this.state.suppressedPlanIds.push(id);
    }
    this.state.plan = this.state.plan.filter((x) => x.id !== id);
    await this.persist();
  }

  /**
   * Reset the day-ahead plan to the pure AUTO strategy: drop every manual
   * entry and every "pinned" (user-edited) auto entry, clear the deletion
   * suppressions, then immediately re-seed the optimal per-zone waterings from
   * the live ET/water-balance forecast. After this the plan is fully managed by
   * the daily computation again (per plant, soil and sensor data).
   */
  public async resetPlanToAuto(): Promise<void> {
    if (!this.loaded) await this.init();
    this.state.plan = [];
    this.state.suppressedPlanIds = [];
    await this.runPlan(this.now()); // re-seed fresh auto entries right away
    await this.persist();
    this.log('info', 'irrigation plan reset to AUTO strategy');
  }

  /** Add a manual plan entry for a zone at an absolute time. */
  public async addPlanEntry(zoneId: string, startTs: string, durationMin: number): Promise<void> {
    if (!this.cfg().zones.some((z) => z.id === zoneId)) throw new Error('Zone nicht gefunden');
    const ms = Date.parse(startTs);
    if (!Number.isFinite(ms)) throw new Error('Ungültige Zeit');
    const dur = Math.min(180, Math.max(5, Math.round(durationMin)));
    if (this.planConflict(ms, dur, null)) {
      throw new Error('Überschneidet sich mit einem anderen Eintrag (nur ein Ventil gleichzeitig)');
    }
    this.state.plan.push({
      id: `man-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      zoneId,
      startTs: new Date(ms).toISOString(),
      durationMin: dur,
      enabled: true,
      source: 'manual',
      doneTs: null,
    });
    await this.persist();
  }

  /**
   * True when [startMs, startMs+dur) overlaps any OTHER enabled plan entry.
   * Enforces the hard "only one valve open at a time" rule at plan level so the
   * planner can never schedule two simultaneous waterings on the shared supply.
   */
  private planConflict(startMs: number, durationMin: number, excludeId: string | null): boolean {
    const endMs = startMs + durationMin * 60_000;
    return this.state.plan.some((e) => {
      if (e.id === excludeId || !e.enabled) return false;
      const s = Date.parse(e.startTs);
      if (!Number.isFinite(s)) return false;
      const en = s + e.durationMin * 60_000;
      return startMs < en && s < endMs;
    });
  }

  // -------------------------------------------------------------------------
  // Snapshot + forecast.
  // -------------------------------------------------------------------------

  public buildSnapshot(): IrrigationSnapshot {
    const cfg = this.cfg();
    const now = this.now();
    const om = this.deps.openMeteo();
    const g = this.deps.gardena();
    const mode = this.resolveMode();
    const gstatus = g?.getStatus() ?? null;

    const zones: IrrigationZoneView[] = cfg.zones.map((zone) => {
      const rt = this.zoneRuntime(zone.id, now);
      const profile = this.effectiveProfile(zone);
      const learned = this.learned.get(zone.id) ?? NEUTRAL_MODEL;
      const measured = this.measuredMoisture(zone);
      const valve = g?.listValves().find((v) => v.serviceId === zone.valveServiceId) ?? null;
      const taw = profileTaw(profile);
      const availablePct = taw > 0 ? Math.round((1 - rt.depletionMm / taw) * 100) : 100;
      const decision = this.lastDecisions.get(zone.id);

      // Forecast trajectory.
      const steps = om.getEt0ForecastSteps(now).slice(0, 72);
      const fc: IrrigationForecast = forecastZone(profile, rt.depletionMm, steps, 1);
      const need = dailyNeedMm(
        profile,
        om.getEt0TodayMm() ?? 0,
        om.getRainTodayMm() ?? 0,
        1,
        mode,
      );

      return {
        id: zone.id,
        name: zone.name,
        enabled: zone.enabled,
        valveOn: valve?.on ?? null,
        activity: valve?.activity ?? null,
        hasValve: valve !== null,
        soilMoisturePct: measured,
        soilTempC: this.measuredSoilTempC(zone) ?? om.getSoilTempC(),
        depletionMm: Math.round(rt.depletionMm * 10) / 10,
        availablePct: Math.max(0, Math.min(100, availablePct)),
        rawMm: Math.round(profileRaw(profile) * 10) / 10,
        tawMm: Math.round(taw * 10) / 10,
        dailyNeedMm: need,
        dailySecondsUsed: rt.dailySecondsUsed,
        windowStartHour: zone.allowedStartHour,
        windowEndHour: zone.allowedEndHour,
        openUntilTs:
          valve?.on === true && rt.openUntilMs !== null && rt.openUntilMs > now.getTime()
            ? new Date(rt.openUntilMs).toISOString()
            : null,
        nextActionLabel: decision?.reason ?? 'warte auf Zyklus',
        blockedBy: decision?.blockedBy ?? null,
        hoursUntilNext: fc.hoursUntilNext,
        nextWateringTs: fc.nextWateringTs,
        plannedNextSeconds:
          fc.nextWateringTs !== null
            ? Math.round(depthMmToSeconds(profileRaw(profile), profile.precipRateMmH))
            : null,
        forecastPoints: fc.points
          .filter((_, i) => i % 3 === 0)
          .map((p) => ({ ts: p.ts, availablePct: Math.round(p.availableFraction * 100) })),
        learned: {
          kcFactor: learned.kcFactor,
          precipRateFactor: learned.precipRateFactor,
          sampleDays: learned.sampleDays,
          emitterFault: learned.emitterFault,
          note: learned.note,
        },
        plant: zone.plant,
        priority: zone.priority,
      };
    });

    let totalSeconds = 0;
    for (const zone of cfg.zones) totalSeconds += this.zoneRuntime(zone.id, now).dailySecondsUsed;

    const zoneNameOf = (id: string): string => cfg.zones.find((z) => z.id === id)?.name ?? id;
    const plan: IrrigationPlanView[] = this.state.plan
      .slice()
      .sort((a, b) => Date.parse(a.startTs) - Date.parse(b.startTs))
      .map((e) => ({
        id: e.id,
        zoneId: e.zoneId,
        zoneName: zoneNameOf(e.zoneId),
        startTs: e.startTs,
        durationMin: e.durationMin,
        enabled: e.enabled,
        source: e.source,
        done: e.doneTs !== null,
      }));

    return {
      enabled: cfg.enabled,
      mode,
      autoMode: cfg.autoMode,
      cloud: this.deps.config().gardena.enabled,
      connected: gstatus?.connected ?? false,
      error: gstatus?.lastError ?? null,
      et0TodayMm: om.getEt0TodayMm(),
      rainTodayMm: om.getRainTodayMm(),
      rainForecastMm: Math.round(om.getForecastRainMm(now, cfg.rainSkipWindowH) * 10) / 10,
      pvSurplusKw: this.deps.pvSurplusKw(),
      mowerActive: g?.isMowerActive() ?? false,
      totalSecondsUsedToday: totalSeconds,
      zones,
      plan,
    };
  }
}

// Local TAW/RAW helpers (avoid importing soilModel twice with different sig).
function profileTaw(p: ZoneProfile): number {
  // (FC-PWP)*rootMm via soilModel through waterBalance's exported types is not
  // exposed; recompute here using the same constants is avoided by reusing the
  // balance's state. Instead derive from a fresh advance with zero inputs.
  const state = advanceBalance(p, { prevDepletionMm: 0, et0Mm: 0, rainMm: 0, irrigationMm: 0 });
  return state.tawMm;
}

function profileRaw(p: ZoneProfile): number {
  const state = advanceBalance(p, { prevDepletionMm: 0, et0Mm: 0, rainMm: 0, irrigationMm: 0 });
  return state.rawMm;
}

/** Local-time YYYY-MM-DD key for grouping/deduping plan entries by day. */
function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
