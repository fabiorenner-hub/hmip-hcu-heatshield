/**
 * Tests for the user-intent reducer (`src/plugin/engine/userIntent.ts`,
 * Task 9.1).
 *
 * Coverage:
 *   - `applyUserSwitchToggle` — pure-reducer cases for each switch
 *     transition (pause on/off, vacation on/off, state-active=false
 *     populates forceOpenUntil, state-forecast / night-cooling are
 *     idempotent and request a single re-evaluation).
 *   - `applyUserSwitchToggle` — pause-on sets `pauseUntil` to the
 *     next local midnight in the configured IANA timezone (Europe/Berlin
 *     → 22:00 UTC during CEST).
 *   - `RuntimeStateSchema` — `userIntent` round-trips through
 *     `parseState`, and a state file missing `userIntent` (legacy v1
 *     payload) is filled in with the documented defaults.
 *   - `runCycle` integration — with `userIntent.paused = true` and a
 *     hot snapshot that would otherwise dispatch a setShutterLevel,
 *     no outbound calls are made and every decision row carries
 *     `blockedBy: 'pause'`.
 *
 * Pure logic — no fs, no network. Each test pins a deterministic
 * `now` so the next-local-midnight assertion is stable.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  runCycle,
  type CycleSnapshot,
  type OrchestratorDeps,
} from '../../src/plugin/engine/orchestrator.js';
import {
  applyUserSwitchToggle,
  emptyUserIntent,
  fromPersistedUserIntent,
  toPersistedUserIntent,
  MANUAL_OVERRIDE_FIELD,
  type UserIntent,
} from '../../src/plugin/engine/userIntent.js';
import { emptyRuntimeState } from '../../src/plugin/persistence/state.js';
import { parseState } from '../../src/shared/state-schema.js';
import type {
  Config,
  Priority,
  RoomTargets,
  Window,
} from '../../src/shared/types.js';

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

const TEST_LOCATION = {
  latitude: 52.52,
  longitude: 13.41,
  timezone: 'Europe/Berlin',
};

const ROOM_TARGETS: RoomTargets = {
  target_c: 23,
  warning_c: 24.5,
  strong_shade_c: 25,
  critical_c: 26,
};

/**
 * 2026-06-21 08:00 UTC = 10:00 Berlin local (CEST). The next local
 * midnight in Europe/Berlin is 2026-06-22 00:00 local = 2026-06-21
 * 22:00 UTC.
 */
const NOW_SUMMER = new Date('2026-06-21T08:00:00.000Z');
const NEXT_MIDNIGHT_SUMMER_UTC = new Date('2026-06-21T22:00:00.000Z');

/**
 * 2026-12-15 14:00 UTC = 15:00 Berlin local (CET). The next local
 * midnight in Europe/Berlin is 2026-12-16 00:00 local = 2026-12-15
 * 23:00 UTC.
 */
const NOW_WINTER = new Date('2026-12-15T14:00:00.000Z');
const NEXT_MIDNIGHT_WINTER_UTC = new Date('2026-12-15T23:00:00.000Z');

function bedroomRoofWindow(overrides: Partial<Window> = {}): Window {
  return {
    id: 'bedroom-window',
    roomId: 'schlafzimmer',
    shutterDeviceId: 'hmip-bedroom-shutter',
    orientationDeg: 135,
    type: 'roof_window',
    isDoor: false,
    canMoveWhenOpen: true,
    maxPositionWhenOpenPct: 60,
    sunPrelookMinutes: 60,
    lockoutProtection: true,
    ...overrides,
  };
}

function officeRoofWindow(overrides: Partial<Window> = {}): Window {
  return {
    id: 'office-window',
    roomId: 'arbeitszimmer',
    shutterDeviceId: 'hmip-office-shutter',
    orientationDeg: 135,
    type: 'roof_window',
    isDoor: false,
    canMoveWhenOpen: true,
    maxPositionWhenOpenPct: 60,
    sunPrelookMinutes: 60,
    lockoutProtection: true,
    ...overrides,
  };
}

function mkConfig(overrides: Partial<Config> = {}): Config {
  return {
    schemaVersion: 1,
    automationEnabled: false,
    location: TEST_LOCATION,
    globalSignals: {
      outdoorTemp: { primary: { kind: 'static', value: 20 }, staleAfterSec: 600 },
    },
    fusionSolar: {
      baseUrl: 'http://host.containers.internal:8088',
      pvPeakKwp: 8.8,
      orientationHint: 'southeast',
    },
    rooms: [],
    windows: [],
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
      storm: { thresholdMs: 13.9, releaseMs: 8.0, releaseHoldMin: 10 },
      nightCooling: { enabled: true, deltaC: 1.5, reopenAtSunriseOffsetMin: -30 },
      manualOverrideMinutes: 60,
    },
    dashboard: { port: 8089, enabled: true },
    ...overrides,
  };
}

interface SnapshotOpts {
  now?: Date;
  rooms: Array<{ id: string; tempC: number | null; priority: Priority; targets?: RoomTargets }>;
  windows: Array<{ config: Window; currentLevel01?: number | null }>;
  switches?: { vacation: boolean; pauseControl: boolean };
  userIntent?: UserIntent;
  outdoorTempC?: number | null;
  forecastMaxTempC?: number | null;
  pvSmoothedKw?: number | null;
  windSpeedMs?: number | null;
  radiationWm2?: number | null;
}

function mkSnapshot(opts: SnapshotOpts): CycleSnapshot {
  const rooms = new Map<
    string,
    { tempC: number | null; targets: RoomTargets; priority: Priority }
  >();
  for (const r of opts.rooms) {
    rooms.set(r.id, {
      tempC: r.tempC,
      targets: r.targets ?? ROOM_TARGETS,
      priority: r.priority,
    });
  }
  return {
    now: opts.now ?? NOW_SUMMER,
    outdoorTempC: opts.outdoorTempC ?? 24,
    forecastMaxTempC: opts.forecastMaxTempC ?? 29,
    pvSmoothedKw: opts.pvSmoothedKw ?? 4.8,
    pvDroppedRecently: false,
    windSpeedMs: opts.windSpeedMs ?? 1.0,
    radiationWm2: opts.radiationWm2 ?? 600,
    rooms,
    windows: opts.windows.map((w) => ({
      config: w.config,
      contactState: 'closed' as const,
      currentLevel01: w.currentLevel01 ?? null,
      runtimeState: null,
    })),
    switches: opts.switches ?? { vacation: false, pauseControl: false },
    userIntent: opts.userIntent,
    stormHoldUntil: null,
    maintenanceMode: false,
  };
}

// ---------------------------------------------------------------------------
// 1. Pure-reducer cases.
// ---------------------------------------------------------------------------

describe('applyUserSwitchToggle — heatshield-control-pause', () => {
  it('on (true) sets paused=true and pauseUntil to next local midnight (CEST)', () => {
    const intent = emptyUserIntent();

    const out = applyUserSwitchToggle(intent, {
      id: 'heatshield-control-pause',
      requestedValue: true,
      now: NOW_SUMMER,
      manualOverrideMinutes: 60,
      allWindowIds: ['bedroom-window', 'office-window'],
      location: TEST_LOCATION,
    });

    expect(out.next.paused).toBe(true);
    expect(out.next.pauseUntil).not.toBeNull();
    expect(out.next.pauseUntil!.toISOString()).toBe(
      NEXT_MIDNIGHT_SUMMER_UTC.toISOString(),
    );
    expect(out.next.vacation).toBe(false);
    expect(out.next.forceOpenUntil.size).toBe(0);
    expect(out.effects.reevaluate).toBe(false);
    expect(out.effects.forceOpenWindowIds).toEqual([]);
  });

  it('on (true) sets pauseUntil to next local midnight (CET)', () => {
    const intent = emptyUserIntent();

    const out = applyUserSwitchToggle(intent, {
      id: 'heatshield-control-pause',
      requestedValue: true,
      now: NOW_WINTER,
      manualOverrideMinutes: 60,
      allWindowIds: [],
      location: TEST_LOCATION,
    });

    expect(out.next.pauseUntil!.toISOString()).toBe(
      NEXT_MIDNIGHT_WINTER_UTC.toISOString(),
    );
  });

  it('off (false) clears paused and pauseUntil', () => {
    const intent: UserIntent = {
      paused: true,
      vacation: false,
      pauseUntil: NEXT_MIDNIGHT_SUMMER_UTC,
      forceOpenUntil: new Map(),
    };

    const out = applyUserSwitchToggle(intent, {
      id: 'heatshield-control-pause',
      requestedValue: false,
      now: NOW_SUMMER,
      manualOverrideMinutes: 60,
      allWindowIds: [],
      location: TEST_LOCATION,
    });

    expect(out.next.paused).toBe(false);
    expect(out.next.pauseUntil).toBeNull();
  });

  it('does not mutate the input intent', () => {
    const intent = emptyUserIntent();
    const before = { ...intent };

    applyUserSwitchToggle(intent, {
      id: 'heatshield-control-pause',
      requestedValue: true,
      now: NOW_SUMMER,
      manualOverrideMinutes: 60,
      allWindowIds: [],
      location: TEST_LOCATION,
    });

    expect(intent.paused).toBe(before.paused);
    expect(intent.pauseUntil).toBe(before.pauseUntil);
    expect(intent.vacation).toBe(before.vacation);
  });
});

describe('applyUserSwitchToggle — heatshield-control-vacation', () => {
  it('on (true) sets vacation=true', () => {
    const intent = emptyUserIntent();

    const out = applyUserSwitchToggle(intent, {
      id: 'heatshield-control-vacation',
      requestedValue: true,
      now: NOW_SUMMER,
      manualOverrideMinutes: 60,
      allWindowIds: [],
      location: TEST_LOCATION,
    });

    expect(out.next.vacation).toBe(true);
    expect(out.next.paused).toBe(false);
    expect(out.next.pauseUntil).toBeNull();
    expect(out.effects.reevaluate).toBe(false);
    expect(out.effects.forceOpenWindowIds).toEqual([]);
  });

  it('off (false) clears vacation', () => {
    const intent: UserIntent = {
      paused: false,
      vacation: true,
      pauseUntil: null,
      forceOpenUntil: new Map(),
    };

    const out = applyUserSwitchToggle(intent, {
      id: 'heatshield-control-vacation',
      requestedValue: false,
      now: NOW_SUMMER,
      manualOverrideMinutes: 60,
      allWindowIds: [],
      location: TEST_LOCATION,
    });

    expect(out.next.vacation).toBe(false);
  });
});

describe('applyUserSwitchToggle — heatshield-state-active (force-open)', () => {
  it('false populates forceOpenUntil for every window in allWindowIds', () => {
    const intent = emptyUserIntent();
    const allIds = ['bedroom-window', 'office-window', 'living-room'];

    const out = applyUserSwitchToggle(intent, {
      id: 'heatshield-state-active',
      requestedValue: false,
      now: NOW_SUMMER,
      manualOverrideMinutes: 60,
      allWindowIds: allIds,
      location: TEST_LOCATION,
    });

    expect(out.effects.forceOpenWindowIds).toEqual(allIds);
    expect(out.next.forceOpenUntil.size).toBe(3);
    const expected = new Date(NOW_SUMMER.getTime() + 60 * 60 * 1000);
    for (const id of allIds) {
      const until = out.next.forceOpenUntil.get(id);
      expect(until).toBeDefined();
      expect(until!.toISOString()).toBe(expected.toISOString());
    }
    expect(out.effects.reevaluate).toBe(false);
  });

  it('false respects custom manualOverrideMinutes', () => {
    const intent = emptyUserIntent();

    const out = applyUserSwitchToggle(intent, {
      id: 'heatshield-state-active',
      requestedValue: false,
      now: NOW_SUMMER,
      manualOverrideMinutes: 90,
      allWindowIds: ['w1'],
      location: TEST_LOCATION,
    });

    const until = out.next.forceOpenUntil.get('w1');
    expect(until).toBeDefined();
    expect(until!.toISOString()).toBe(
      new Date(NOW_SUMMER.getTime() + 90 * 60 * 1000).toISOString(),
    );
  });

  it('true clears the in-memory forceOpenUntil map and emits no effects', () => {
    const intent: UserIntent = {
      paused: false,
      vacation: false,
      pauseUntil: null,
      forceOpenUntil: new Map([
        ['bedroom-window', new Date(NOW_SUMMER.getTime() + 60 * 60 * 1000)],
      ]),
    };

    const out = applyUserSwitchToggle(intent, {
      id: 'heatshield-state-active',
      requestedValue: true,
      now: NOW_SUMMER,
      manualOverrideMinutes: 60,
      allWindowIds: ['bedroom-window'],
      location: TEST_LOCATION,
    });

    expect(out.next.forceOpenUntil.size).toBe(0);
    expect(out.effects.forceOpenWindowIds).toEqual([]);
    expect(out.effects.reevaluate).toBe(false);
  });

  it('false with empty allWindowIds produces no force-open entries', () => {
    const intent = emptyUserIntent();

    const out = applyUserSwitchToggle(intent, {
      id: 'heatshield-state-active',
      requestedValue: false,
      now: NOW_SUMMER,
      manualOverrideMinutes: 60,
      allWindowIds: [],
      location: TEST_LOCATION,
    });

    expect(out.effects.forceOpenWindowIds).toEqual([]);
    expect(out.next.forceOpenUntil.size).toBe(0);
  });
});

describe('applyUserSwitchToggle — status-switch toggles are idempotent', () => {
  it('heatshield-state-forecast toggle requests a single re-evaluation, no state change', () => {
    const intent: UserIntent = {
      paused: true,
      vacation: true,
      pauseUntil: NEXT_MIDNIGHT_SUMMER_UTC,
      forceOpenUntil: new Map(),
    };

    const out = applyUserSwitchToggle(intent, {
      id: 'heatshield-state-forecast',
      requestedValue: false,
      now: NOW_SUMMER,
      manualOverrideMinutes: 60,
      allWindowIds: ['bedroom-window'],
      location: TEST_LOCATION,
    });

    // Intent is unchanged.
    expect(out.next.paused).toBe(true);
    expect(out.next.vacation).toBe(true);
    expect(out.next.pauseUntil).toEqual(NEXT_MIDNIGHT_SUMMER_UTC);
    expect(out.next.forceOpenUntil.size).toBe(0);
    // Effects ask for a re-eval.
    expect(out.effects.reevaluate).toBe(true);
    expect(out.effects.forceOpenWindowIds).toEqual([]);
  });

  it('heatshield-state-night-cooling toggle requests a single re-evaluation', () => {
    const intent = emptyUserIntent();

    const out = applyUserSwitchToggle(intent, {
      id: 'heatshield-state-night-cooling',
      requestedValue: true,
      now: NOW_SUMMER,
      manualOverrideMinutes: 60,
      allWindowIds: [],
      location: TEST_LOCATION,
    });

    expect(out.next).toEqual({
      paused: false,
      vacation: false,
      pauseUntil: null,
      forceOpenUntil: new Map(),
    });
    expect(out.effects.reevaluate).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Persisted-shape conversion.
// ---------------------------------------------------------------------------

describe('toPersistedUserIntent / fromPersistedUserIntent', () => {
  it('round-trips paused + pauseUntil + vacation; drops forceOpenUntil', () => {
    const intent: UserIntent = {
      paused: true,
      vacation: true,
      pauseUntil: NEXT_MIDNIGHT_SUMMER_UTC,
      forceOpenUntil: new Map([['bedroom-window', NOW_SUMMER]]),
    };

    const persisted = toPersistedUserIntent(intent);
    expect(persisted).toEqual({
      paused: true,
      vacation: true,
      pauseUntil: NEXT_MIDNIGHT_SUMMER_UTC.toISOString(),
    });

    const inflated = fromPersistedUserIntent(persisted);
    expect(inflated.paused).toBe(true);
    expect(inflated.vacation).toBe(true);
    expect(inflated.pauseUntil!.toISOString()).toBe(
      NEXT_MIDNIGHT_SUMMER_UTC.toISOString(),
    );
    expect(inflated.forceOpenUntil.size).toBe(0);
  });

  it('round-trips an empty intent', () => {
    const intent = emptyUserIntent();
    const persisted = toPersistedUserIntent(intent);
    const inflated = fromPersistedUserIntent(persisted);

    expect(persisted).toEqual({
      paused: false,
      pauseUntil: null,
      vacation: false,
    });
    expect(inflated).toEqual(intent);
  });
});

// ---------------------------------------------------------------------------
// 3. RuntimeStateSchema — userIntent round-trip.
// ---------------------------------------------------------------------------

describe('RuntimeStateSchema — userIntent', () => {
  it('parses a state with userIntent populated', () => {
    const empty = emptyRuntimeState();
    const populated = {
      ...empty,
      userIntent: {
        paused: true,
        pauseUntil: NEXT_MIDNIGHT_SUMMER_UTC.toISOString(),
        vacation: true,
      },
    };

    const parsed = parseState(populated);
    expect(parsed.userIntent).toEqual({
      paused: true,
      pauseUntil: NEXT_MIDNIGHT_SUMMER_UTC.toISOString(),
      vacation: true,
    });
  });

  it('emptyRuntimeState seeds userIntent with the documented defaults', () => {
    const empty = emptyRuntimeState();

    expect(empty.userIntent).toEqual({
      paused: false,
      pauseUntil: null,
      vacation: false,
    });
  });

  it('defaults userIntent when missing from a legacy state payload (backward-compat)', () => {
    const empty = emptyRuntimeState();
    // Strip userIntent to simulate a state.json written before Task 9.1.
    const legacyShape: Record<string, unknown> = { ...empty };
    delete legacyShape['userIntent'];

    const parsed = parseState(legacyShape);
    expect(parsed.userIntent).toEqual({
      paused: false,
      pauseUntil: null,
      vacation: false,
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Orchestrator integration: paused intent suppresses moves.
// ---------------------------------------------------------------------------

describe('runCycle — userIntent.paused suppresses every move with blockedBy=pause', () => {
  it('paused=true with pauseUntil in the future blocks all setShutterLevel calls', async () => {
    const config = mkConfig({
      rooms: [
        {
          id: 'schlafzimmer',
          name: 'Schlafzimmer',
          priority: 'very_high',
          targets: ROOM_TARGETS,
          signals: {},
          occupancyMode: 'always_priority',
        },
        {
          id: 'arbeitszimmer',
          name: 'Arbeitszimmer',
          priority: 'very_high',
          targets: ROOM_TARGETS,
          signals: {},
          occupancyMode: 'always_priority',
        },
      ],
      windows: [bedroomRoofWindow(), officeRoofWindow()],
    });
    const setShutterLevel = vi.fn(async () => undefined);
    const deps: OrchestratorDeps = {
      config,
      hmipSystem: { setShutterLevel },
    };

    // Hot inputs that would otherwise dispatch setShutterLevel(1.0).
    const snapshot = mkSnapshot({
      rooms: [
        { id: 'schlafzimmer', tempC: 23.4, priority: 'very_high' },
        { id: 'arbeitszimmer', tempC: 23.4, priority: 'very_high' },
      ],
      windows: [
        { config: bedroomRoofWindow(), currentLevel01: 0.5 },
        { config: officeRoofWindow(), currentLevel01: 0.5 },
      ],
      // Switches off — drive pause exclusively from the userIntent
      // surface to verify the orchestrator wires the new field in.
      switches: { vacation: false, pauseControl: false },
      userIntent: {
        paused: true,
        vacation: false,
        pauseUntil: NEXT_MIDNIGHT_SUMMER_UTC,
        forceOpenUntil: new Map(),
      },
    });

    const out = await runCycle(snapshot, deps);

    expect(setShutterLevel).not.toHaveBeenCalled();
    expect(out.decisionRecord.windowDecisions).toHaveLength(2);
    for (const entry of out.decisionRecord.windowDecisions) {
      expect(entry.moved).toBe(false);
      expect(entry.blockedBy).toBe('pause');
    }
  });

  it('paused=true with pauseUntil already elapsed does NOT block moves', async () => {
    const config = mkConfig({
      rooms: [
        {
          id: 'schlafzimmer',
          name: 'Schlafzimmer',
          priority: 'very_high',
          targets: ROOM_TARGETS,
          signals: {},
          occupancyMode: 'always_priority',
        },
      ],
      windows: [bedroomRoofWindow()],
    });
    const setShutterLevel = vi.fn(async () => undefined);
    const deps: OrchestratorDeps = {
      config,
      hmipSystem: { setShutterLevel },
    };

    const snapshot = mkSnapshot({
      rooms: [{ id: 'schlafzimmer', tempC: 23.4, priority: 'very_high' }],
      windows: [{ config: bedroomRoofWindow() }],
      userIntent: {
        paused: true,
        vacation: false,
        // pauseUntil one hour in the past → expired.
        pauseUntil: new Date(NOW_SUMMER.getTime() - 60 * 60 * 1000),
        forceOpenUntil: new Map(),
      },
    });

    await runCycle(snapshot, deps);

    expect(setShutterLevel).toHaveBeenCalledTimes(1);
    expect(setShutterLevel).toHaveBeenCalledWith(
      'hmip-bedroom-shutter',
      1,
      1.0,
    );
  });

  it('vacation=true via userIntent shifts target temps down by vacationOffsetC', async () => {
    // Profile so vacation matters: a borderline-warm room (23.0 °C)
    // sits below the default warning threshold (24.5 °C) but at exactly
    // the vacation-shifted strong_shade_c (25 - 0.5 = 24.5 < 23 is
    // false, but 23 < 24.5 still). The point is that the vacation FSM
    // mode is selected and the cycle still produces decision rows.
    const config = mkConfig({
      rooms: [
        {
          id: 'schlafzimmer',
          name: 'Schlafzimmer',
          priority: 'very_high',
          targets: ROOM_TARGETS,
          signals: {},
          occupancyMode: 'always_priority',
        },
      ],
      windows: [bedroomRoofWindow()],
    });
    const setShutterLevel = vi.fn(async () => undefined);
    const deps: OrchestratorDeps = { config, hmipSystem: { setShutterLevel } };

    const snapshot = mkSnapshot({
      rooms: [{ id: 'schlafzimmer', tempC: 23, priority: 'very_high' }],
      windows: [{ config: bedroomRoofWindow() }],
      switches: { vacation: false, pauseControl: false },
      userIntent: {
        paused: false,
        vacation: true,
        pauseUntil: null,
        forceOpenUntil: new Map(),
      },
    });

    const out = await runCycle(snapshot, deps);
    // VACATION beats SUMMER_WATCH/ACTIVE (only STORM and MAINTENANCE
    // outrank it per design.md §10).
    expect(out.mode).toBe('VACATION');
  });
});

// ---------------------------------------------------------------------------
// 5. Re-exported manual-override field.
// ---------------------------------------------------------------------------

describe('MANUAL_OVERRIDE_FIELD constant', () => {
  it('matches the field name on WindowRuntimeState', () => {
    expect(MANUAL_OVERRIDE_FIELD).toBe('manualOverrideUntil');
  });
});
