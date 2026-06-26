/**
 * Heat Shield — engine/learn.ts unit tests (Task 14.3).
 *
 * Builds a synthetic NDJSON-style history (5 days for one room)
 * plus matching room temperature samples and exercises the two
 * public functions in `engine/learn.ts`:
 *
 *   - `aggregateDailyMetrics(records, samples, options)` — should
 *     produce one row per (room, local-date), with the
 *     pre-shade rise rate, post-shade rise rate, and effective
 *     gain in `°C / h`.
 *   - `deriveRecommendations(metrics, config, options)` — should
 *     emit a `'warn'` recommendation when the streak of
 *     low-gain days reaches `minDays`, and an `'info'`
 *     recommendation when the rolling average exceeds 0.5 °C / h.
 *
 * The fixtures are deterministic. The synthetic history places the
 * first shading event at 11:00 local (Europe/Berlin), and the
 * temperature samples cover the 60-min pre / post windows in
 * 5-minute steps.
 */

import { describe, expect, it } from 'vitest';

import {
  aggregateDailyMetrics,
  deriveRecommendations,
  type DailyShadeMetrics,
  type RoomTempSample,
} from '../../src/plugin/engine/learn.js';
import type { HistoryRecord } from '../../src/plugin/persistence/history.js';
import type { Config, DecisionRecord } from '../../src/shared/types.js';

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

const TZ = 'Europe/Berlin';
const ROOM_ID = 'schlafzimmer';
const WINDOW_ID = 'fenster-schlafzimmer-1';

/**
 * Build a config that contains a single room with a single window
 * — enough for `deriveRecommendations` to map a recommendation to
 * a window-level patch path.
 */
function singleRoomConfig(prelookMinutes: number = 60): Config {
  return {
    schemaVersion: 1,
    automationEnabled: false,
    location: {
      latitude: 52.52,
      longitude: 13.41,
      timezone: TZ,
    },
    globalSignals: {
      outdoorTemp: {
        primary: { kind: 'static', value: 22 },
        staleAfterSec: 600,
      },
    },
    fusionSolar: {
      baseUrl: 'http://host.containers.internal:8088',
      pvPeakKwp: 8.8,
      orientationHint: 'southeast',
    },
    rooms: [
      {
        id: ROOM_ID,
        name: 'Schlafzimmer',
        priority: 'very_high',
        targets: {
          target_c: 22,
          warning_c: 23.5,
          strong_shade_c: 24,
          critical_c: 25,
        },
        signals: {},
        occupancyMode: 'always_priority',
      },
    ],
    windows: [
      {
        id: WINDOW_ID,
        roomId: ROOM_ID,
        shutterDeviceId: 'hmip-shutter-1',
        orientationDeg: 135,
        type: 'roof_window',
        isDoor: false,
        canMoveWhenOpen: true,
        maxPositionWhenOpenPct: 60,
        sunPrelookMinutes: prelookMinutes,
        lockoutProtection: true,
      },
    ],
    rules: {
      profile: 'standard',
      comfort: {
        maxIndoorTempC: 25,
        preShadeTempC: 23.5,
        nightCoolingDeltaC: 1.5,
        vacationOffsetC: 0.5,
      },
      automation: {
        controlIntervalSeconds: 180,
        minSecondsBetweenMoves: 900,
        minPositionDeltaPct: 15,
        temperatureHysteresisC: 0.5,
        pvHysteresisKw: 0.7,
        pvSmoothingSamples: 3,
        forecastHorizonMinutes: 60,
      },
      sun: {
        minElevationDeg: 5,
        maxIncidenceAngleFacadeDeg: 90,
        maxIncidenceAngleRoofDeg: 95,
      },
      storm: {
        thresholdMs: 13.9,
        releaseMs: 8,
        releaseHoldMin: 10,
      },
      nightCooling: {
        enabled: true,
        deltaC: 1.5,
        reopenAtSunriseOffsetMin: -30,
      },
      manualOverrideMinutes: 60,
    },
    dashboard: { port: 8089, enabled: true },
  };
}

/**
 * Compute the UTC instant for "11:00 local in Europe/Berlin" on a
 * given local YYYY-MM-DD. June dates use UTC+02:00, so 11:00 local
 * = 09:00 UTC. We hardcode that — the production code consumes
 * `Intl.DateTimeFormat` for the inverse direction.
 */
function shadeMomentUtc(localDate: string): Date {
  return new Date(`${localDate}T09:00:00.000Z`);
}

/**
 * Build a single decision record on `localDate` (Europe/Berlin)
 * where the `WINDOW_ID` window crosses `finalTarget = 0.7` (≥
 * 0.5, the spec's first-shade threshold).
 */
function shadeRecord(localDate: string): HistoryRecord<DecisionRecord> {
  const at = shadeMomentUtc(localDate);
  const cycleId = `cycle-${localDate}`;
  return {
    ts: at.toISOString(),
    cycleId,
    payload: {
      cycleId,
      ts: at.toISOString(),
      mode: 'ACTIVE_HEAT_PROTECTION',
      windowDecisions: [
        {
          windowId: WINDOW_ID,
          factors: { sunFactor: 0.5 },
          risk: 0.6,
          rawTarget: 0.7,
          afterSpecialRules: 0.7,
          afterSafety: 0.7,
          finalTarget: 0.7,
          moved: true,
        },
      ],
    },
  };
}

/**
 * Build a 5-minute-cadence stream of temperature samples around
 * the shade moment. The pre-window is 60 min wide with a constant
 * slope of `preSlopeCph`; the post-window is 60 min wide with a
 * constant slope of `postSlopeCph`.
 *
 * Effective gain in this fixture is `preSlopeCph - postSlopeCph`.
 */
function tempSamples(
  localDate: string,
  preSlopeCph: number,
  postSlopeCph: number,
  baseTempC: number = 22,
): RoomTempSample[] {
  const moment = shadeMomentUtc(localDate);
  const samples: RoomTempSample[] = [];
  // Pre-window: t in [-60, 0) min.
  for (let mins = -60; mins < 0; mins += 5) {
    const at = new Date(moment.getTime() + mins * 60_000);
    const tempC = baseTempC + ((mins + 60) / 60) * preSlopeCph;
    samples.push({
      ts: at.toISOString(),
      roomId: ROOM_ID,
      tempC,
    });
  }
  // Sample at t=0: post window starts here (half-open [0, 60)).
  // Pre slope reached temp = base + preSlopeCph at the moment.
  const tempAtMoment = baseTempC + preSlopeCph;
  // Post-window: t in [0, 60) min.
  for (let mins = 0; mins < 60; mins += 5) {
    const at = new Date(moment.getTime() + mins * 60_000);
    const tempC = tempAtMoment + (mins / 60) * postSlopeCph;
    samples.push({
      ts: at.toISOString(),
      roomId: ROOM_ID,
      tempC,
    });
  }
  return samples;
}

/**
 * The five consecutive June days we use for the 5-day fixture.
 * June 2026 sits in DST (UTC+02:00), so 11:00 local consistently
 * maps to 09:00 UTC across all five days.
 */
const FIVE_DAYS = [
  '2026-06-15',
  '2026-06-16',
  '2026-06-17',
  '2026-06-18',
  '2026-06-19',
];

// ---------------------------------------------------------------------------
// aggregateDailyMetrics.
// ---------------------------------------------------------------------------

describe('aggregateDailyMetrics', () => {
  it('produces one row per day with effectiveShadeGain ≈ 0.2 for a 5-day low-gain fixture', () => {
    const records: HistoryRecord<DecisionRecord>[] = [];
    const samples: RoomTempSample[] = [];
    for (const date of FIVE_DAYS) {
      records.push(shadeRecord(date));
      // pre 0.4 °C/h, post 0.2 °C/h → gain 0.2
      samples.push(...tempSamples(date, 0.4, 0.2));
    }
    const metrics = aggregateDailyMetrics(records, samples, {
      timezone: TZ,
      windowsByRoom: { [ROOM_ID]: [WINDOW_ID] },
    });
    expect(metrics).toHaveLength(5);
    for (const row of metrics) {
      expect(row.roomId).toBe(ROOM_ID);
      expect(row.firstShadeTimeIso).not.toBeNull();
      expect(row.preShadeRiseCph).not.toBeNull();
      expect(row.postShadeRiseCph).not.toBeNull();
      expect(row.effectiveShadeGain).not.toBeNull();
      expect(row.effectiveShadeGain ?? 0).toBeCloseTo(0.2, 2);
      expect(row.samplesPre).toBeGreaterThanOrEqual(10);
      expect(row.samplesPost).toBeGreaterThanOrEqual(10);
    }
  });

  it('emits a no-shade row with all metrics null when no decision crosses 0.5', () => {
    const day = '2026-06-20';
    const noShadeRecord: HistoryRecord<DecisionRecord> = {
      ts: shadeMomentUtc(day).toISOString(),
      cycleId: 'cycle-no-shade',
      payload: {
        cycleId: 'cycle-no-shade',
        ts: shadeMomentUtc(day).toISOString(),
        mode: 'NORMAL',
        windowDecisions: [
          {
            windowId: WINDOW_ID,
            factors: { sunFactor: 0 },
            risk: 0.1,
            rawTarget: 0.2,
            afterSpecialRules: 0.2,
            afterSafety: 0.2,
            finalTarget: 0.2,
            moved: false,
          },
        ],
      },
    };
    const samples = tempSamples(day, 0.4, 0.4);
    const metrics = aggregateDailyMetrics([noShadeRecord], samples, {
      timezone: TZ,
      windowsByRoom: { [ROOM_ID]: [WINDOW_ID] },
    });
    expect(metrics).toHaveLength(1);
    expect(metrics[0]?.firstShadeTimeIso).toBeNull();
    expect(metrics[0]?.preShadeRiseCph).toBeNull();
    expect(metrics[0]?.postShadeRiseCph).toBeNull();
    expect(metrics[0]?.effectiveShadeGain).toBeNull();
    expect(metrics[0]?.samplesPre).toBe(0);
    expect(metrics[0]?.samplesPost).toBe(0);
  });

  it('uses the FIRST decision of the day where finalTarget crosses 0.5', () => {
    const day = '2026-06-21';
    const earlyAt = new Date(`${day}T09:00:00.000Z`);
    const lateAt = new Date(`${day}T13:00:00.000Z`);
    const records: HistoryRecord<DecisionRecord>[] = [
      {
        ts: earlyAt.toISOString(),
        cycleId: 'early',
        payload: {
          cycleId: 'early',
          ts: earlyAt.toISOString(),
          mode: 'ACTIVE_HEAT_PROTECTION',
          windowDecisions: [
            {
              windowId: WINDOW_ID,
              factors: { sunFactor: 0.4 },
              risk: 0.6,
              rawTarget: 0.6,
              afterSpecialRules: 0.6,
              afterSafety: 0.6,
              finalTarget: 0.6,
              moved: true,
            },
          ],
        },
      },
      {
        ts: lateAt.toISOString(),
        cycleId: 'late',
        payload: {
          cycleId: 'late',
          ts: lateAt.toISOString(),
          mode: 'ACTIVE_HEAT_PROTECTION',
          windowDecisions: [
            {
              windowId: WINDOW_ID,
              factors: { sunFactor: 0.7 },
              risk: 0.8,
              rawTarget: 0.9,
              afterSpecialRules: 0.9,
              afterSafety: 0.9,
              finalTarget: 0.9,
              moved: false,
            },
          ],
        },
      },
    ];
    const samples = tempSamples(day, 0.4, 0.2);
    const metrics = aggregateDailyMetrics(records, samples, {
      timezone: TZ,
      windowsByRoom: { [ROOM_ID]: [WINDOW_ID] },
    });
    expect(metrics).toHaveLength(1);
    expect(metrics[0]?.firstShadeTimeIso).toBe(earlyAt.toISOString());
  });
});

// ---------------------------------------------------------------------------
// deriveRecommendations.
// ---------------------------------------------------------------------------

describe('deriveRecommendations', () => {
  function buildLowGainMetrics(): DailyShadeMetrics[] {
    const records: HistoryRecord<DecisionRecord>[] = [];
    const samples: RoomTempSample[] = [];
    for (const date of FIVE_DAYS) {
      records.push(shadeRecord(date));
      samples.push(...tempSamples(date, 0.4, 0.2));
    }
    return aggregateDailyMetrics(records, samples, {
      timezone: TZ,
      windowsByRoom: { [ROOM_ID]: [WINDOW_ID] },
    });
  }

  it('emits a warn recommendation with +30 min patch after 5 low-gain days', () => {
    const metrics = buildLowGainMetrics();
    const recs = deriveRecommendations(metrics, singleRoomConfig(60), {
      now: new Date('2026-06-19T20:00:00.000Z'),
      minDays: 5,
    });
    expect(recs).toHaveLength(1);
    const r = recs[0];
    expect(r?.severity).toBe('warn');
    expect(r?.roomId).toBe(ROOM_ID);
    expect(r?.suggestedConfigPatch).toBeDefined();
    expect(r?.suggestedConfigPatch?.path).toEqual([
      'windows',
      0,
      'sunPrelookMinutes',
    ]);
    expect(r?.suggestedConfigPatch?.from).toBe(60);
    expect(r?.suggestedConfigPatch?.to).toBe(90);
    expect(r?.id).toBe(`lowGain-${ROOM_ID}`);
  });

  it('caps the patch at 120 min even when current value is already high', () => {
    const metrics = buildLowGainMetrics();
    const recs = deriveRecommendations(metrics, singleRoomConfig(110), {
      now: new Date('2026-06-19T20:00:00.000Z'),
      minDays: 5,
    });
    expect(recs).toHaveLength(1);
    expect(recs[0]?.suggestedConfigPatch?.from).toBe(110);
    expect(recs[0]?.suggestedConfigPatch?.to).toBe(120);
  });

  it('emits no warn recommendation when only 4 of 5 days are below threshold', () => {
    const records: HistoryRecord<DecisionRecord>[] = [];
    const samples: RoomTempSample[] = [];
    // Days 0..2 = 0.2 gain, day 3 = 0.6 gain (resets streak),
    // day 4 = 0.2 gain (new streak only 1 day deep). Walking from
    // most recent back, we hit a defined `>= 0.3` value at day 3
    // and stop with streak = 1.
    const slopeProfile: Array<{ pre: number; post: number }> = [
      { pre: 0.4, post: 0.2 },
      { pre: 0.4, post: 0.2 },
      { pre: 0.4, post: 0.2 },
      { pre: 0.6, post: 0.0 },
      { pre: 0.4, post: 0.2 },
    ];
    for (let i = 0; i < FIVE_DAYS.length; i += 1) {
      const date = FIVE_DAYS[i]!;
      const profile = slopeProfile[i]!;
      records.push(shadeRecord(date));
      samples.push(...tempSamples(date, profile.pre, profile.post));
    }
    const metrics = aggregateDailyMetrics(records, samples, {
      timezone: TZ,
      windowsByRoom: { [ROOM_ID]: [WINDOW_ID] },
    });
    const recs = deriveRecommendations(metrics, singleRoomConfig(60), {
      now: new Date('2026-06-19T20:00:00.000Z'),
      minDays: 5,
    });
    const warnRecs = recs.filter((r) => r.severity === 'warn');
    expect(warnRecs).toHaveLength(0);
  });

  it('emits an info recommendation (no patch) when avg gain > 0.5 over 5 days', () => {
    const records: HistoryRecord<DecisionRecord>[] = [];
    const samples: RoomTempSample[] = [];
    for (const date of FIVE_DAYS) {
      records.push(shadeRecord(date));
      // pre 0.8 °C/h, post 0.0 °C/h → gain 0.8
      samples.push(...tempSamples(date, 0.8, 0.0));
    }
    const metrics = aggregateDailyMetrics(records, samples, {
      timezone: TZ,
      windowsByRoom: { [ROOM_ID]: [WINDOW_ID] },
    });
    const recs = deriveRecommendations(metrics, singleRoomConfig(60), {
      now: new Date('2026-06-19T20:00:00.000Z'),
      minDays: 5,
    });
    expect(recs).toHaveLength(1);
    expect(recs[0]?.severity).toBe('info');
    expect(recs[0]?.suggestedConfigPatch).toBeUndefined();
    expect(recs[0]?.id).toBe(`highGain-${ROOM_ID}`);
  });

  it('treats no-shade days as transparent: streak survives gaps', () => {
    // Build 5 low-gain days, then prepend a day with NO shading
    // event. The no-shade day is a "no signal" row that should
    // neither extend nor break the streak — and it shouldn't
    // count toward `minDays` either, so the streak still satisfies
    // `>= 5` because it has 5 actual low-gain days.
    const records: HistoryRecord<DecisionRecord>[] = [];
    const samples: RoomTempSample[] = [];
    const noShadeDay = '2026-06-14';
    records.push({
      ts: shadeMomentUtc(noShadeDay).toISOString(),
      cycleId: 'cycle-no-shade',
      payload: {
        cycleId: 'cycle-no-shade',
        ts: shadeMomentUtc(noShadeDay).toISOString(),
        mode: 'NORMAL',
        windowDecisions: [
          {
            windowId: WINDOW_ID,
            factors: { sunFactor: 0 },
            risk: 0.1,
            rawTarget: 0.2,
            afterSpecialRules: 0.2,
            afterSafety: 0.2,
            finalTarget: 0.2,
            moved: false,
          },
        ],
      },
    });
    samples.push(...tempSamples(noShadeDay, 0.4, 0.2));
    for (const date of FIVE_DAYS) {
      records.push(shadeRecord(date));
      samples.push(...tempSamples(date, 0.4, 0.2));
    }
    const metrics = aggregateDailyMetrics(records, samples, {
      timezone: TZ,
      windowsByRoom: { [ROOM_ID]: [WINDOW_ID] },
    });
    const recs = deriveRecommendations(metrics, singleRoomConfig(60), {
      now: new Date('2026-06-19T20:00:00.000Z'),
      minDays: 5,
    });
    expect(recs.filter((r) => r.severity === 'warn')).toHaveLength(1);
  });
});
