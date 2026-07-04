/**
 * Übersicht view-model (uebersicht-rework, Task 2) — unit + property tests.
 *
 * Validates the pure derivations against design.md Correctness Properties:
 *   P1 honesty, P2 avoided warming ≥ 0, P3 safety precedence,
 *   P6 next-action causality, P7 room-status total.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import type {
  DashboardSnapshot,
  PlannedAction,
  RoomDetail,
} from '../../src/plugin/dashboard/spa/types.js';
import {
  avoidedWarmingC,
  cloudPercent,
  dataAgeMinutes,
  isStormActive,
  nextPlannedAction,
  outlookPeakIndex,
  precip2hMm,
  primaryHeadline,
  roomStatuses,
  strongestFacade,
  ventilationLevel,
} from '../../src/plugin/dashboard/spa/components/uebersicht/uebersichtModel.js';

const BASE: DashboardSnapshot = {
  ts: new Date().toISOString(),
  mode: 'NORMAL',
  rooms: [],
  windows: [],
  sources: {
    fusionSolar: { sourceOk: true, lastSuccess: null, consecutiveFailures: 0 },
    hcu: { connected: true },
  },
  userIntent: { paused: false, pauseUntil: null, vacation: false },
  storm: { holdUntil: null },
  pluginReadiness: 'READY',
};

function snap(over: Partial<DashboardSnapshot> = {}): DashboardSnapshot {
  return { ...BASE, ...over };
}

function room(over: Partial<RoomDetail> = {}): RoomDetail {
  return {
    id: 'r',
    name: 'Raum',
    facade: 'S',
    shutterPercent: 50,
    indoorTempC: 24,
    trend: 'flat',
    nextAction: null,
    status: 'recommended',
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

describe('primaryHeadline', () => {
  it('prioritises storm over heat', () => {
    const s = snap({ mode: 'HEATWAVE', storm: { holdUntil: new Date(Date.now() + 3600_000).toISOString() } });
    expect(primaryHeadline(s)).toEqual({ tone: 'alert', key: 'storm' });
  });
  it('maps heat modes to active', () => {
    expect(primaryHeadline(snap({ mode: 'ACTIVE_HEAT_PROTECTION' })).tone).toBe('active');
  });
  it('is calm in NORMAL', () => {
    expect(primaryHeadline(snap({ mode: 'NORMAL' }))).toEqual({ tone: 'calm', key: 'calm' });
  });
});

describe('strongestFacade / KPIs', () => {
  it('picks the max facade', () => {
    expect(strongestFacade(snap({ facades: { N: 5, E: 30, S: 88, W: 22 } }))).toEqual({ key: 'S', pct: 88 });
  });
  it('returns null when facades are absent', () => {
    expect(strongestFacade(snap())).toBeNull();
  });
  it('reads the ventilation level', () => {
    expect(
      ventilationLevel(snap({ ventilation: { overall: { level: 'air_now', headline: '', detail: '' }, rooms: [] } })),
    ).toBe('air_now');
  });
  it('sums the 2 h precipitation nowcast', () => {
    const now = new Date().toISOString();
    expect(precip2hMm(snap({ precipNowcast: [{ ts: now, precipMm: 0.5 }, { ts: now, precipMm: 0.7 }] }))).toBe(1.2);
  });
  it('derives cloud percent from a 0..1 or 0..100 value', () => {
    expect(cloudPercent(snap({ signals: { forecastCloudCover: { value: 0.4, ts: null, state: 'fresh' } } as DashboardSnapshot['signals'] }))).toBe(40);
  });
});

describe('outlookPeakIndex', () => {
  it('finds the hottest card', () => {
    expect(outlookPeakIndex([{ tempC: 20 }, { tempC: 31 }, { tempC: 28 }])).toBe(1);
  });
  it('is null for an empty list', () => {
    expect(outlookPeakIndex([])).toBeNull();
  });
});

describe('dataAgeMinutes', () => {
  it('computes whole minutes', () => {
    const now = new Date('2026-07-01T10:00:00Z');
    expect(dataAgeMinutes('2026-07-01T09:30:00Z', now)).toBe(30);
  });
  it('is null for an unparseable ts', () => {
    expect(dataAgeMinutes('not-a-date')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

describe('Property 2 — avoided warming ≥ 0 or null', () => {
  it('never returns a negative number', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: -10, max: 60, noNaN: true }), { maxLength: 8 }),
        fc.array(fc.double({ min: -10, max: 60, noNaN: true }), { maxLength: 8 }),
        (withShade, noShade) => {
          const s = snap({
            trajectories: {
              indoorForecastWithShade: withShade.map((tempC, i) => ({ ts: String(i), tempC })),
              indoorForecastNoShade: noShade.map((tempC, i) => ({ ts: String(i), tempC })),
              heatLoadForecast: [],
            },
          });
          const v = avoidedWarmingC(s);
          if (v === null) {
            expect(withShade.length === 0 || noShade.length === 0).toBe(true);
          } else {
            expect(v).toBeGreaterThanOrEqual(0);
          }
        },
      ),
    );
  });
});

describe('Property 3 — safety precedence', () => {
  it('storm or alert always forces the alert tone', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<DashboardSnapshot['mode']>('NORMAL', 'SUMMER_WATCH', 'ACTIVE_HEAT_PROTECTION', 'HEATWAVE', 'NIGHT_COOLING'),
        fc.boolean(),
        fc.boolean(),
        (mode, stormHold, alert) => {
          const s = snap({
            mode,
            storm: { holdUntil: stormHold ? new Date(Date.now() + 3600_000).toISOString() : null },
            ...(alert ? { weatherAlert: { active: true, maxLevel: 3, region: 'x', updatedTs: '', warnings: [] } } : {}),
          });
          const head = primaryHeadline(s);
          if (stormHold || alert || mode === 'STORM') {
            expect(head.tone).toBe('alert');
          }
          if (stormHold) expect(isStormActive(s)).toBe(true);
        },
      ),
    );
  });
});

describe('Property 6 — next-action causality', () => {
  it('returns the earliest future, non-blocked action', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            offsetMin: fc.integer({ min: -120, max: 120 }),
            state: fc.constantFrom<PlannedAction['state']>('recommended', 'scheduled', 'executing', 'blocked', 'manuallyOverridden', 'completed'),
          }),
          { maxLength: 10 },
        ),
        (rows) => {
          const now = new Date('2026-07-01T12:00:00Z');
          const actions: PlannedAction[] = rows.map((r, i) => ({
            windowId: `w${i}`,
            scheduledTs: new Date(now.getTime() + r.offsetMin * 60000).toISOString(),
            targetPercent: 60,
            reason: 'x',
            state: r.state,
          }));
          const next = nextPlannedAction(snap({ plannedActions: actions }), now);
          const eligible = actions
            .filter((a) => a.state !== 'blocked' && a.state !== 'manuallyOverridden' && a.state !== 'completed')
            .filter((a) => Date.parse(a.scheduledTs) >= now.getTime())
            .sort((a, b) => Date.parse(a.scheduledTs) - Date.parse(b.scheduledTs));
          expect(next).toEqual(eligible[0] ?? null);
        },
      ),
    );
  });
});

describe('Property 7 — room-status total + Property 1 honesty', () => {
  it('preserves count/order and never fabricates a temperature for unbound sensors', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.string({ minLength: 1, maxLength: 6 }),
            unbound: fc.boolean(),
            temp: fc.double({ min: 10, max: 40, noNaN: true }),
            load: fc.double({ min: 0, max: 1, noNaN: true }),
          }),
          { maxLength: 12 },
        ),
        (rows) => {
          const rd: RoomDetail[] = rows.map((r, i) =>
            room({
              id: `${r.id}-${i}`,
              indoorTempC: r.temp,
              heatLoad01: r.load,
              ...(r.unbound ? { indoorTempState: 'unbound' as const } : {}),
            }),
          );
          const vms = roomStatuses(snap({ roomsDetail: rd }));
          expect(vms.length).toBe(rd.length);
          vms.forEach((vm, i) => {
            expect(vm.id).toBe(rd[i]!.id);
            if (rd[i]!.indoorTempState === 'unbound') {
              expect(vm.tempC).toBeNull();
              expect(vm.tone).toBe('unknown');
            }
          });
        },
      ),
    );
  });
});
