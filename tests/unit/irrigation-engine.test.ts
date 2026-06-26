/**
 * Heat Shield — irrigation engine unit tests (Stufe 0–4 core).
 * Covers soil model, water balance, decision gates, learning and forecast.
 */
import { describe, it, expect } from 'vitest';

import {
  totalAvailableWaterMm,
  readilyAvailableWaterMm,
  depthMmToSeconds,
  secondsToDepthMm,
  cycleSoakPasses,
  moisturePctToDepletionMm,
} from '../../src/plugin/engine/irrigation/soilModel.js';
import {
  advanceBalance,
  computeDose,
  cropEtMm,
  effectiveRainMm,
  type ZoneProfile,
} from '../../src/plugin/engine/irrigation/waterBalance.js';
import {
  decideZone,
  inWindow,
  orderForSequencing,
  modeFactors,
  type DecisionEnv,
  type GlobalGates,
  type ZoneGates,
} from '../../src/plugin/engine/irrigation/decision.js';
import { learnZoneModel, type IrrigationObservation } from '../../src/plugin/engine/irrigation/learn.js';
import { forecastZone, dailyNeedMm, type ForecastStep } from '../../src/plugin/engine/irrigation/forecast.js';

const lawn: ZoneProfile = {
  plant: 'lawn',
  soil: 'loam',
  exposure: 'full_sun',
  slope: 'flat',
  rootDepthCm: 15,
  kc: 0.85,
  mad: 0.5,
  precipRateMmH: 12,
};

describe('soil model', () => {
  it('TAW = (FC-PWP)*rootMm; loam@15cm = (0.28-0.12)*150 = 24mm', () => {
    expect(totalAvailableWaterMm('loam', 15)).toBeCloseTo(24, 5);
  });
  it('RAW = MAD*TAW', () => {
    expect(readilyAvailableWaterMm('loam', 15, 0.5)).toBeCloseTo(12, 5);
  });
  it('depth↔seconds round-trips with precip rate', () => {
    const s = depthMmToSeconds(6, 12); // 6mm at 12mm/h = 0.5h = 1800s
    expect(s).toBe(1800);
    expect(secondsToDepthMm(s, 12)).toBeCloseTo(6, 5);
  });
  it('cycle-soak splits big doses on clay/steep into >1 pass', () => {
    expect(cycleSoakPasses(20, 'clay', 'steep')).toBeGreaterThan(1);
    expect(cycleSoakPasses(2, 'sand', 'flat')).toBe(1);
  });
  it('moisture % maps to depletion (100% = FC = 0 depletion)', () => {
    expect(moisturePctToDepletionMm(100, 'loam', 15)).toBeCloseTo(0, 5);
    expect(moisturePctToDepletionMm(0, 'loam', 15)).toBeCloseTo(24, 5);
  });
});

describe('water balance', () => {
  it('ETc = ET0 * Kc * exposure', () => {
    expect(cropEtMm(lawn, 5)).toBeCloseTo(5 * 0.85 * 1.1, 5);
  });
  it('depletion grows with ET and shrinks with rain/irrigation, clamped to TAW', () => {
    const s1 = advanceBalance(lawn, { prevDepletionMm: 0, et0Mm: 10, rainMm: 0, irrigationMm: 0 });
    expect(s1.depletionMm).toBeGreaterThan(0);
    const s2 = advanceBalance(lawn, { prevDepletionMm: s1.depletionMm, et0Mm: 0, rainMm: 100, irrigationMm: 0 });
    expect(s2.depletionMm).toBe(0); // heavy rain refills, clamped at 0
    const dry = advanceBalance(lawn, { prevDepletionMm: 0, et0Mm: 1000, rainMm: 0, irrigationMm: 0 });
    expect(dry.depletionMm).toBeCloseTo(dry.tawMm, 5); // clamped to TAW
  });
  it('dose only triggers at/above RAW and refills to field capacity', () => {
    const below = advanceBalance(lawn, { prevDepletionMm: 5, et0Mm: 0, rainMm: 0, irrigationMm: 0 });
    expect(computeDose(lawn, below).needed).toBe(false);
    const at = advanceBalance(lawn, { prevDepletionMm: 14, et0Mm: 0, rainMm: 0, irrigationMm: 0 });
    const dose = computeDose(lawn, at);
    expect(dose.needed).toBe(true);
    expect(dose.depthMm).toBeCloseTo(14, 1);
    expect(dose.totalSeconds).toBe(depthMmToSeconds(14, 12));
  });
  it('measured moisture blends into modeled depletion', () => {
    const s = advanceBalance(lawn, {
      prevDepletionMm: 0,
      et0Mm: 0,
      rainMm: 0,
      irrigationMm: 0,
      measuredMoisturePct: 0, // bone dry → pulls depletion up
      sensorWeight: 1,
    });
    expect(s.depletionMm).toBeCloseTo(s.tawMm, 1);
  });
  it('effective rain discounts interception + runoff', () => {
    expect(effectiveRainMm(1)).toBe(0); // < interception
    expect(effectiveRainMm(12)).toBeCloseTo((12 - 2) * 0.9, 5);
  });
});

const baseGates: ZoneGates = {
  enabled: true,
  hasValve: true,
  allowedStartHour: 4,
  allowedEndHour: 8,
  maxDailySeconds: 0,
  dailySecondsUsed: 0,
  minutesSinceLast: null,
  cooldownMinutes: 360,
  priority: 'normal',
  moistCeilingPct: 80,
};
const baseEnv: DecisionEnv = {
  hour: 5,
  rainNowMm: 0,
  rainForecastMm: 0,
  soilTempC: 18,
  windMs: 1,
  measuredMoisturePct: null,
  storm: false,
};
const baseGlobal: GlobalGates = { mode: 'normal', rainSkipMm: 3, frostLockoutC: 3, windSkipMs: 8 };
const dose = computeDose(lawn, advanceBalance(lawn, { prevDepletionMm: 16, et0Mm: 0, rainMm: 0, irrigationMm: 0 }));

describe('decision gates', () => {
  it('waters when dry, in window, no blockers', () => {
    const d = decideZone(dose, baseGates, baseEnv, baseGlobal);
    expect(d.action).toBe('water');
    expect(d.seconds).toBeGreaterThan(0);
  });
  it('STORM and frost lock everything', () => {
    expect(decideZone(dose, baseGates, { ...baseEnv, storm: true }, baseGlobal).blockedBy).toBe('storm');
    expect(decideZone(dose, baseGates, { ...baseEnv, soilTempC: 1 }, baseGlobal).blockedBy).toBe('frost');
  });
  it('skips on rain now and rain forecast', () => {
    expect(decideZone(dose, baseGates, { ...baseEnv, rainNowMm: 1 }, baseGlobal).blockedBy).toBe('rain_now');
    expect(decideZone(dose, baseGates, { ...baseEnv, rainForecastMm: 5 }, baseGlobal).blockedBy).toBe('rain_forecast');
  });
  it('skips out of window and on wind for sprinklers', () => {
    expect(decideZone(dose, baseGates, { ...baseEnv, hour: 14 }, baseGlobal).blockedBy).toBe('out_of_window');
    expect(decideZone(dose, baseGates, { ...baseEnv, windMs: 10 }, baseGlobal).blockedBy).toBe('wind');
  });
  it('respects moisture ceiling and cooldown', () => {
    expect(decideZone(dose, baseGates, { ...baseEnv, measuredMoisturePct: 90 }, baseGlobal).blockedBy).toBe('moist_enough');
    expect(decideZone(dose, { ...baseGates, minutesSinceLast: 10 }, baseEnv, baseGlobal).blockedBy).toBe('cooldown');
  });
  it('budget cap limits or blocks watering', () => {
    const capped = decideZone(dose, { ...baseGates, maxDailySeconds: 600, dailySecondsUsed: 600 }, baseEnv, baseGlobal);
    expect(capped.blockedBy).toBe('budget');
  });
  it('mode off scales to no water', () => {
    expect(decideZone(dose, baseGates, baseEnv, { ...baseGlobal, mode: 'off' }).action).not.toBe('water');
    expect(modeFactors('heat').doseFactor).toBeGreaterThan(modeFactors('eco').doseFactor);
  });
  it('inWindow handles midnight wrap', () => {
    expect(inWindow(23, 22, 6)).toBe(true);
    expect(inWindow(12, 22, 6)).toBe(false);
    expect(inWindow(5, 4, 4)).toBe(true); // 24h
  });
  it('sequencing orders critical first', () => {
    const ordered = orderForSequencing([
      { decision: { ...dose, action: 'water', priority: 'low' } as never },
      { decision: { action: 'water', priority: 'critical' } as never },
    ]);
    expect((ordered[0]!.decision as { priority: string }).priority).toBe('critical');
  });
});

describe('learning', () => {
  it('raises Kc factor when soil dries faster than ET0 predicts', () => {
    const obs: IrrigationObservation[] = [];
    for (let d = 0; d < 8; d += 1) {
      // No irrigation/rain. Each day dries 60%→35% = 6mm on loam@15cm (TAW 24)
      // while ET0 is only 4mm → implied Kc ≈ 1.5 (drying faster than ET0).
      obs.push({
        date: `2026-06-${10 + d}`,
        et0Mm: 4,
        rainMm: 0,
        irrigationMm: 0,
        irrigationSeconds: 0,
        moistureStartPct: 60,
        moistureEndPct: 35,
      });
    }
    const model = learnZoneModel(obs, 'loam', 15);
    expect(model.kcFactor).toBeGreaterThan(1);
    expect(model.sampleDays).toBeGreaterThan(0);
  });
  it('flags emitter fault when watering yields no moisture rise', () => {
    const obs: IrrigationObservation[] = [];
    for (let d = 0; d < 4; d += 1) {
      obs.push({
        date: `2026-07-${10 + d}`,
        et0Mm: 1,
        rainMm: 0,
        irrigationMm: 10, // lots of water applied
        irrigationSeconds: 1800,
        moistureStartPct: 40,
        moistureEndPct: 30, // yet soil got drier → fault
      });
    }
    const model = learnZoneModel(obs, 'loam', 15);
    expect(model.emitterFault).toBe(true);
  });
  it('neutral with no observations', () => {
    expect(learnZoneModel([], 'loam', 15).kcFactor).toBe(1);
  });
});

describe('forecast', () => {
  it('projects depletion and finds next-watering ETA', () => {
    const steps: ForecastStep[] = [];
    const base = Date.UTC(2026, 6, 1, 0, 0, 0);
    for (let h = 0; h < 72; h += 1) {
      steps.push({ ts: new Date(base + h * 3_600_000).toISOString(), et0Mm: 0.3, precipMm: 0 });
    }
    const fc = forecastZone(lawn, 0, steps, 1);
    expect(fc.points.length).toBe(72);
    expect(fc.hoursUntilNext).not.toBeNull();
    expect(fc.nextWateringTs).not.toBeNull();
  });
  it('rain in forecast delays the next watering', () => {
    const dryStep: ForecastStep[] = Array.from({ length: 48 }, (_, h) => ({
      ts: new Date(Date.UTC(2026, 6, 1, h)).toISOString(),
      et0Mm: 0.5,
      precipMm: 0,
    }));
    const wetStep: ForecastStep[] = dryStep.map((s, h) => ({ ...s, precipMm: h === 5 ? 30 : 0 }));
    const dryFc = forecastZone(lawn, 6, dryStep, 1);
    const wetFc = forecastZone(lawn, 6, wetStep, 1);
    expect((wetFc.hoursUntilNext ?? 999)).toBeGreaterThan(dryFc.hoursUntilNext ?? 0);
  });
  it('daily need is non-negative and scales with mode', () => {
    expect(dailyNeedMm(lawn, 5, 0, 1, 'off')).toBe(0);
    expect(dailyNeedMm(lawn, 5, 0, 1, 'heat')).toBeGreaterThan(dailyNeedMm(lawn, 5, 0, 1, 'eco'));
  });
});
