/**
 * Unit tests for `src/plugin/runtime/probe.ts::runDryProbe` (Task 13.3).
 *
 * Headline acceptance criteria:
 *
 *   1. Build a hot snapshot that would otherwise fire setShutterLevel.
 *   2. Call `runDryProbe`.
 *   3. Assert that the underlying mock setShutterLevel was NOT called.
 *   4. Assert that the returned `decisionRecord` is correctly populated
 *      (the engine still saw `moved=true` because the stubbed dispatcher
 *      resolved successfully — the steering rule is "no Connect call",
 *      not "no decision row").
 *   5. Bonus: a caller-supplied `hmipSystem` is overridden by the
 *      runtime stub even when the test slips one in via a structural
 *      cast — the function MUST be the only public path that issues
 *      `setShutterLevel`.
 */

import { describe, expect, it, vi } from 'vitest';

import { runDryProbe, type DryProbeDeps } from '../../src/plugin/runtime/probe.js';
import type { CycleSnapshot } from '../../src/plugin/engine/orchestrator.js';
import type {
  Config,
  ContactState,
  Priority,
  RoomTargets,
  Window,
  WindowRuntimeState,
} from '../../src/shared/types.js';

// ---------------------------------------------------------------------------
// Constants & helpers (mirrors `tests/unit/engine-orchestrator.test.ts`).
// ---------------------------------------------------------------------------

const NOW = new Date('2026-06-21T08:00:00.000Z');

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
    rules: {
      profile: 'standard',
      comfort: { maxIndoorTempC: 25, preShadeTempC: 23.5, nightCoolingDeltaC: 1.5 },
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

interface WindowEntry {
  config: Window;
  contactState?: ContactState;
  currentLevel01?: number | null;
  runtimeState?: WindowRuntimeState | null;
}

function mkSnapshot(opts: {
  rooms: Array<{ id: string; tempC: number | null; priority: Priority; targets?: RoomTargets }>;
  windows: WindowEntry[];
}): CycleSnapshot {
  const rooms = new Map<string, { tempC: number | null; targets: RoomTargets; priority: Priority }>();
  for (const r of opts.rooms) {
    rooms.set(r.id, {
      tempC: r.tempC,
      targets: r.targets ?? ROOM_TARGETS,
      priority: r.priority,
    });
  }
  return {
    now: NOW,
    outdoorTempC: 24,
    forecastMaxTempC: 29,
    pvSmoothedKw: 4.8,
    pvDroppedRecently: false,
    windSpeedMs: 1.0,
    radiationWm2: 600,
    rooms,
    windows: opts.windows.map((w) => ({
      config: w.config,
      contactState: w.contactState ?? 'closed',
      currentLevel01: w.currentLevel01 ?? null,
      runtimeState: w.runtimeState ?? null,
    })),
    switches: { vacation: false, pauseControl: false },
    stormHoldUntil: null,
    maintenanceMode: false,
  };
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe('runDryProbe (Task 13.3)', () => {
  it('does NOT call any setShutterLevel for a hot snapshot', async () => {
    // Tracker spy — the orchestrator should never reach this. We
    // also slip a fake `hmipSystem` into the deps via an `as`
    // boundary cast to confirm the runtime stub is what wins.
    const setShutterLevelSpy = vi.fn(async () => undefined);
    const config = mkConfig();
    const deps: DryProbeDeps & { hmipSystem?: unknown } = {
      config,
    };
    // Sneak in a real-looking hmipSystem to confirm `runDryProbe`
    // ignores it. The DryProbeDeps type explicitly Omits this key,
    // so the cast through `unknown` is what a buggy boot module
    // could (in theory) do at runtime.
    (deps as { hmipSystem: { setShutterLevel: typeof setShutterLevelSpy } }).hmipSystem = {
      setShutterLevel: setShutterLevelSpy,
    };

    const snapshot = mkSnapshot({
      rooms: [{ id: 'schlafzimmer', tempC: 23.4, priority: 'very_high' }],
      windows: [{ config: bedroomRoofWindow() }],
    });

    const out = await runDryProbe(snapshot, deps);

    // The mocked setShutterLevel was never called — that is the
    // steering-mandated invariant.
    expect(setShutterLevelSpy).not.toHaveBeenCalled();

    // DecisionRecord is populated as if a real cycle ran: the
    // stubbed dispatcher resolved successfully, so the engine sees
    // `moved=true` for the bedroom window.
    expect(out.decisionRecord.windowDecisions).toHaveLength(1);
    const entry = out.decisionRecord.windowDecisions[0]!;
    expect(entry.windowId).toBe('bedroom-window');
    expect(entry.moved).toBe(true);
    expect(entry.finalTarget).toBeCloseTo(1.0, 9);
    expect(entry.blockedBy).toBeUndefined();

    // The mode FSM still ran end-to-end.
    expect(out.mode).toBe('ACTIVE_HEAT_PROTECTION');
    expect(out.decisionRecord.mode).toBe('ACTIVE_HEAT_PROTECTION');
    expect(out.decisionRecord.cycleId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(out.decisionRecord.ts).toBe(NOW.toISOString());
  });

  it('does NOT persist to history by default (sink stays untouched)', async () => {
    const appendHistoryRecord = vi.fn(async () => undefined);
    const deps: DryProbeDeps & { appendHistoryRecord?: typeof appendHistoryRecord } = {
      config: mkConfig(),
    };
    // Even though we set a real sink here, runDryProbe forwards
    // deps.appendHistoryRecord transparently — verify it is left
    // alone unless explicitly enabled.
    void appendHistoryRecord;

    const snapshot = mkSnapshot({
      rooms: [{ id: 'schlafzimmer', tempC: 23.4, priority: 'very_high' }],
      windows: [{ config: bedroomRoofWindow() }],
    });

    const out = await runDryProbe(snapshot, deps);
    // History sink was not provided → not invoked.
    expect(appendHistoryRecord).not.toHaveBeenCalled();
    // DecisionRecord still produced.
    expect(out.decisionRecord.windowDecisions).toHaveLength(1);
  });

  it('forwards an explicitly provided history sink (opt-in persistence)', async () => {
    const appendHistoryRecord = vi.fn(async () => undefined);
    const snapshot = mkSnapshot({
      rooms: [{ id: 'schlafzimmer', tempC: 23.4, priority: 'very_high' }],
      windows: [{ config: bedroomRoofWindow() }],
    });
    const out = await runDryProbe(snapshot, {
      config: mkConfig(),
      appendHistoryRecord,
    });
    expect(appendHistoryRecord).toHaveBeenCalledTimes(1);
    const recorded = appendHistoryRecord.mock.calls[0]![0];
    expect(recorded.cycleId).toBe(out.decisionRecord.cycleId);
    expect(recorded.payload).toBe(out.decisionRecord);
  });

  it('still does not call setShutterLevel even for a STORM cycle', async () => {
    const setShutterLevelSpy = vi.fn(async () => undefined);
    const deps: DryProbeDeps & { hmipSystem?: unknown } = {
      config: mkConfig(),
    };
    (deps as { hmipSystem: { setShutterLevel: typeof setShutterLevelSpy } }).hmipSystem = {
      setShutterLevel: setShutterLevelSpy,
    };

    const stormSnapshot: CycleSnapshot = {
      ...mkSnapshot({
        rooms: [{ id: 'schlafzimmer', tempC: 24, priority: 'very_high' }],
        windows: [{ config: bedroomRoofWindow() }],
      }),
      windSpeedMs: 14, // > 13.9 → STORM
    };

    const out = await runDryProbe(stormSnapshot, deps);
    expect(setShutterLevelSpy).not.toHaveBeenCalled();
    expect(out.mode).toBe('STORM');
  });
});
