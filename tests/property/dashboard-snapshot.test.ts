/**
 * Heat Shield — dashboard snapshot quality property tests
 * (predictive-control-dashboard Task 11.1, Properties 19–23).
 *
 * Exercises the pure snapshot-field helpers that back
 * `index.ts::buildSnapshot`: action transparency, data-quality, snapshot
 * shape, planned-action state validity and UUID-free device labels.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  PLANNED_ACTION_STATES,
  deviceShortLabel,
  isPlannedActionState,
  isTransparencyComplete,
  isValueWithQualityValid,
  makeValueWithQuality,
  shortId,
  toDisplayedAction,
  validateSnapshotV2,
} from '../../src/plugin/dashboard/snapshotFields.js';
import type {
  DashboardSnapshotV2,
  PlannedAction,
  PlannedActionState,
  ValueWithQuality,
} from '../../src/plugin/dashboard/server.js';

const stateArb: fc.Arbitrary<PlannedActionState> = fc.constantFrom(
  ...PLANNED_ACTION_STATES,
);

const isoArb: fc.Arbitrary<string> = fc
  .integer({ min: Date.UTC(2026, 0, 1), max: Date.UTC(2026, 11, 31) })
  .map((ms) => new Date(ms).toISOString());

const plannedActionArb: fc.Arbitrary<PlannedAction> = fc.record({
  windowId: fc.string({ minLength: 1, maxLength: 8 }),
  scheduledTs: isoArb,
  targetPercent: fc.integer({ min: 0, max: 100 }),
  reason: fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s.trim().length > 0),
  state: stateArb,
});

const originArb: fc.Arbitrary<ValueWithQuality['origin']> = fc.constantFrom(
  'measured',
  'forecast',
  'estimated',
);

describe('dashboard snapshot quality', () => {
  // Feature: predictive-control-dashboard, Property 19: Für jede dargestellte
  // automatische Aktion sind alle fünf Transparenzfelder vorhanden und
  // nichtleer: Wirkung, Zeitpunkt, Grund, Datenherkunft und Konfidenz.
  it('Property 19: displayed actions carry all five transparency fields', () => {
    fc.assert(
      fc.property(
        plannedActionArb,
        fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (action, source, confidence) => {
          const d = toDisplayedAction(action, source, confidence);
          expect(isTransparencyComplete(d)).toBe(true);
          expect(d.effectPercent).toBe(action.targetPercent);
          expect(d.whenTs).toBe(action.scheduledTs);
          expect(d.reason).toBe(action.reason);
        },
      ),
      { numRuns: 200 },
    );
  });

  // Feature: predictive-control-dashboard, Property 20: Für jeden angezeigten
  // ValueWithQuality sind origin ∈ {measured,forecast,estimated}, eine
  // nichtleere source und confidence01 ∈ [0,1] gesetzt.
  it('Property 20: ValueWithQuality is always well-formed', () => {
    fc.assert(
      fc.property(
        fc.option(fc.double({ noNaN: true }), { nil: null }),
        originArb,
        fc.string({ minLength: 1, maxLength: 16 }).filter((s) => s.length > 0),
        fc.double({ min: -5, max: 5, noNaN: true }),
        (value, origin, source, confidenceRaw) => {
          const v = makeValueWithQuality(value, origin, source, confidenceRaw);
          expect(isValueWithQualityValid(v)).toBe(true);
          expect(v.confidence01).toBeGreaterThanOrEqual(0);
          expect(v.confidence01).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: 200 },
    );
  });

  // Feature: predictive-control-dashboard, Property 21: Für jeden Dashboard-
  // Snapshot validiert dieser gegen das Schema mit den Pflichtfeldern ts,
  // mode{id,label,goal,reasons}, environment, facades und rooms[], und jeder
  // Raumeintrag führt ein nextAction-Feld.
  it('Property 21: well-formed snapshot validates; missing required field fails', () => {
    const envField = (): ValueWithQuality =>
      makeValueWithQuality(1, 'forecast', 'OpenMeteo', 0.9);
    const snapArb: fc.Arbitrary<DashboardSnapshotV2> = fc.record({
      rooms: fc.array(
        fc.record({ id: fc.string({ minLength: 1 }), tempC: fc.constant(null) }),
        { maxLength: 4 },
      ),
      roomsDetail: fc.array(
        fc.record({
          id: fc.string({ minLength: 1, maxLength: 8 }),
          name: fc.string({ minLength: 1, maxLength: 12 }),
          facade: fc.constantFrom('N', 'E', 'S', 'W') as fc.Arbitrary<'N' | 'E' | 'S' | 'W'>,
          shutterPercent: fc.integer({ min: 0, max: 100 }),
          indoorTempC: fc.constant(null),
          trend: fc.constantFrom('up', 'down', 'flat') as fc.Arbitrary<
            'up' | 'down' | 'flat'
          >,
          nextAction: fc.constant(null),
          status: stateArb,
        }),
        { maxLength: 4 },
      ),
    }).map(({ rooms, roomsDetail }) => ({
      ts: '2026-06-21T12:00:00.000Z',
      mode: 'NORMAL',
      rooms,
      windows: [],
      sources: {
        fusionSolar: { sourceOk: true, lastSuccess: null, consecutiveFailures: 0 },
        hcu: { connected: true },
      },
      userIntent: { paused: false, pauseUntil: null, vacation: false },
      storm: { holdUntil: null },
      pluginReadiness: 'READY',
      modeInfo: { id: 'NORMAL', label: 'Normal', goal: 'Komfort', reasons: [] },
      environment: {
        radiationWm2: envField(),
        uvIndex: envField(),
        windMs: envField(),
        humidity01: envField(),
      },
      facades: { N: 0, E: 0, S: 0, W: 0 },
      roomsDetail,
    }));

    fc.assert(
      fc.property(snapArb, (snap) => {
        expect(validateSnapshotV2(snap)).toBe(true);
        // Removing a required block fails validation.
        const broken = { ...snap, facades: undefined };
        expect(validateSnapshotV2(broken as DashboardSnapshotV2)).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  // Feature: predictive-control-dashboard, Property 22: Für jede PlannedAction
  // gilt state ∈ {recommended,scheduled,executing,completed,blocked,
  // manuallyOverridden}.
  it('Property 22: planned-action state is always valid', () => {
    fc.assert(
      fc.property(plannedActionArb, (action) => {
        expect(isPlannedActionState(action.state)).toBe(true);
      }),
      { numRuns: 200 },
    );
    // Arbitrary non-state strings are rejected.
    fc.assert(
      fc.property(
        fc.string().filter((s) => !(PLANNED_ACTION_STATES as readonly string[]).includes(s)),
        (s) => {
          expect(isPlannedActionState(s)).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });

  // Feature: predictive-control-dashboard, Property 23: Für beliebige Geräte-IDs
  // enthält das angezeigte Gerätelabel die letzten vier Zeichen der ID und gibt
  // nie die vollständige UUID wieder.
  it('Property 23: device label shows last-4, never the full UUID', () => {
    const uuidLikeArb = fc
      .uuid()
      .chain((u) => fc.constantFrom(u, u.replace(/-/g, ''), `sgtin-${u}`));
    fc.assert(
      fc.property(
        uuidLikeArb,
        fc.option(fc.string({ maxLength: 16 }), { nil: undefined }),
        fc.option(fc.string({ maxLength: 16 }), { nil: undefined }),
        (deviceId, friendlyName, roomName) => {
          const label = deviceShortLabel(deviceId, friendlyName ?? undefined, roomName ?? undefined);
          expect(label).toContain(shortId(deviceId));
          if (deviceId.length > 4) {
            expect(label).not.toContain(deviceId);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
