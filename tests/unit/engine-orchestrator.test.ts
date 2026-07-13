/**
 * Tests for the per-cycle orchestrator in
 * `src/plugin/engine/orchestrator.ts` (Task 8.1).
 *
 * Coverage:
 *   - Single bedroom roof window, hot inputs → setShutterLevel called
 *     with target=1.0 and DecisionRecord shape is correct (cycleId,
 *     ts, mode, one window entry, moved=true, finalTarget=1.0).
 *   - History sink receives a HistoryRecord<DecisionRecord> envelope
 *     with matching ts + cycleId.
 *   - STORM cycle (wind=14m/s) → all windows fired with target=0.0,
 *     newStormHoldUntil set.
 *   - pauseControl=true → no setShutterLevel calls and decision
 *     entries carry blockedBy='pause' (mapped from safety_suppress).
 *   - Manual override (manualOverrideUntil 30 min in future) → no
 *     setShutterLevel call, blockedBy='manual_override'.
 *   - Multiple windows: each gets its own decision entry in config
 *     order.
 *   - setShutterLevel error: rejection → blockedBy='system_error',
 *     moved=false, history still appended.
 *   - channelIndexFor injection respected.
 *
 * No fixtures. Configs are constructed inline via `mkConfig`.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  runCycle,
  type CycleSnapshot,
  type OrchestratorDeps,
} from '../../src/plugin/engine/orchestrator.js';
import type { HistoryRecord } from '../../src/plugin/persistence/history.js';
import type {
  Config,
  ContactState,
  DecisionRecord,
  Priority,
  RoomTargets,
  Window,
  WindowRuntimeState,
} from '../../src/shared/types.js';

// ---------------------------------------------------------------------------
// Constants & helpers.
// ---------------------------------------------------------------------------

/**
 * 2026-06-21 08:00 UTC = 10:00 Berlin local — same instant the
 * regelwerk integration test pins. At Beispielstadt the sun is at
 * az≈110°, el≈44°, well inside the SE incidence cone for a 135°
 * window.
 */
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

/** Build a complete `Config` with sensible defaults — tests override fields they care about. */
function mkConfig(overrides: Partial<Config> = {}): Config {
  return {
    schemaVersion: 1,
    automationEnabled: false,
    location: TEST_LOCATION,
    globalSignals: {
      // Required by the schema; tests do not exercise the resolver here.
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
      storm: { enabled: true, thresholdMs: 13.9, releaseMs: 8.0, releaseHoldMin: 10 },
      nightCooling: { enabled: true, deltaC: 1.5, reopenAtSunriseOffsetMin: -30 },
      manualOverrideMinutes: 60,
    },
    dashboard: { port: 8089, enabled: true },
    ...overrides,
  };
}

/** Bedroom roof window @ SE 135° (matches the regelwerk §18.1 fixture). */
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

/** Office roof window — second window for the multi-window scenario. */
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

interface WindowEntry {
  config: Window;
  contactState?: ContactState;
  currentLevel01?: number | null;
  runtimeState?: WindowRuntimeState | null;
}

/** Build a `CycleSnapshot` with hot-day defaults; tests override per scenario. */
function mkSnapshot(opts: {
  now?: Date;
  outdoorTempC?: number | null;
  forecastMaxTempC?: number | null;
  pvSmoothedKw?: number | null;
  pvDroppedRecently?: boolean;
  windSpeedMs?: number | null;
  radiationWm2?: number | null;
  rooms: Array<{ id: string; tempC: number | null; priority: Priority; targets?: RoomTargets }>;
  windows: WindowEntry[];
  switches?: { vacation: boolean; pauseControl: boolean };
  stormHoldUntil?: Date | null;
  maintenanceMode?: boolean;
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
    now: opts.now ?? NOW,
    outdoorTempC: opts.outdoorTempC ?? 24,
    forecastMaxTempC: opts.forecastMaxTempC ?? 29,
    pvSmoothedKw: opts.pvSmoothedKw ?? 4.8,
    pvDroppedRecently: opts.pvDroppedRecently ?? false,
    windSpeedMs: opts.windSpeedMs ?? 1.0,
    radiationWm2: opts.radiationWm2 ?? 600,
    rooms,
    windows: opts.windows.map((w) => ({
      config: w.config,
      contactState: w.contactState ?? 'closed',
      currentLevel01: w.currentLevel01 ?? null,
      runtimeState: w.runtimeState ?? null,
    })),
    switches: opts.switches ?? { vacation: false, pauseControl: false },
    stormHoldUntil: opts.stormHoldUntil ?? null,
    maintenanceMode: opts.maintenanceMode ?? false,
  };
}

/** Build a fully-populated `OrchestratorDeps` with `vi.fn` mocks. */
function mkDeps(config: Config): {
  deps: OrchestratorDeps;
  setShutterLevel: ReturnType<typeof vi.fn>;
  appendHistoryRecord: ReturnType<typeof vi.fn>;
} {
  const setShutterLevel = vi.fn(async (_: string, __: number, ___: number) => {
    return undefined;
  });
  const appendHistoryRecord = vi.fn(async (_: HistoryRecord<DecisionRecord>) => {
    return undefined;
  });
  const deps: OrchestratorDeps = {
    config,
    hmipSystem: { setShutterLevel },
    appendHistoryRecord,
  };
  return { deps, setShutterLevel, appendHistoryRecord };
}

// ---------------------------------------------------------------------------
// 1. Hot bedroom roof window — moves to 1.0 and writes history.
// ---------------------------------------------------------------------------

describe('runCycle — hot bedroom roof window', () => {
  it('calls setShutterLevel(target=1.0) and appends a matching history record', async () => {
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
    const { deps, setShutterLevel, appendHistoryRecord } = mkDeps(config);
    const snapshot = mkSnapshot({
      rooms: [{ id: 'schlafzimmer', tempC: 23.4, priority: 'very_high' }],
      windows: [{ config: bedroomRoofWindow() }],
    });

    const out = await runCycle(snapshot, deps);

    // setShutterLevel called once with the bedroom shutter at level=1.0.
    expect(setShutterLevel).toHaveBeenCalledTimes(1);
    expect(setShutterLevel).toHaveBeenCalledWith(
      'hmip-bedroom-shutter',
      1, // default channelIndexFor → 1
      1.0,
    );

    // DecisionRecord shape.
    expect(out.decisionRecord.cycleId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(out.decisionRecord.ts).toBe(NOW.toISOString());
    expect(out.decisionRecord.mode).toBe('ACTIVE_HEAT_PROTECTION');
    expect(out.decisionRecord.windowDecisions).toHaveLength(1);
    const entry = out.decisionRecord.windowDecisions[0]!;
    expect(entry.windowId).toBe('bedroom-window');
    expect(entry.moved).toBe(true);
    expect(entry.finalTarget).toBeCloseTo(1.0, 9);
    expect(entry.blockedBy).toBeUndefined();
    expect(Object.keys(entry.factors)).toEqual(
      expect.arrayContaining([
        'sunFactor',
        'roomTempFactor',
        'windowTypeFactor',
        'forecastTempFactor',
        'pvFactor',
        'radiationFactor',
        'outdoorTempFactor',
        'priorityFactor',
      ]),
    );

    // newStormHoldUntil and mode echo.
    expect(out.newStormHoldUntil).toBeNull();
    expect(out.mode).toBe('ACTIVE_HEAT_PROTECTION');

    // History sink.
    expect(appendHistoryRecord).toHaveBeenCalledTimes(1);
    const recorded = appendHistoryRecord.mock.calls[0]![0];
    expect(recorded.ts).toBe(NOW.toISOString());
    expect(recorded.cycleId).toBe(out.decisionRecord.cycleId);
    expect(recorded.payload).toBe(out.decisionRecord);
  });

  // Bug report item 3: gentle-shading opt-in must cap the heat-protection
  // escalation so the same hot-but-not-heatwave inputs no longer slam the
  // roof shutter fully shut. The cap is exempt in a real HEATWAVE.
  it('caps the roof force-close when gentle shading is enabled (vs. full close when off)', async () => {
    const rooms = [
      {
        id: 'schlafzimmer',
        name: 'Schlafzimmer',
        priority: 'very_high' as Priority,
        targets: ROOM_TARGETS,
        signals: {},
        occupancyMode: 'always_priority' as const,
      },
    ];
    // Mild-warm, heat-protection (not heatwave) inputs: the §13 roof rules
    // still escalate, but the base risk stays well below full close.
    const snapOpts = {
      rooms: [{ id: 'schlafzimmer', tempC: 23.2, priority: 'very_high' as Priority }],
      windows: [{ config: bedroomRoofWindow() }],
      forecastMaxTempC: 26,
      outdoorTempC: 21,
      pvSmoothedKw: 2.5,
      radiationWm2: 350,
    };

    const offCfg = mkConfig({ rooms, windows: [bedroomRoofWindow()] });
    const off = mkDeps(offCfg);
    const outOff = await runCycle(mkSnapshot(snapOpts), off.deps);

    const onCfg = mkConfig({ rooms, windows: [bedroomRoofWindow()] });
    onCfg.rules.gentleShading = { enabled: true, maxClose01: 0.5 };
    const on = mkDeps(onCfg);
    const outOn = await runCycle(mkSnapshot(snapOpts), on.deps);

    expect(outOff.mode).toBe('ACTIVE_HEAT_PROTECTION');
    expect(outOn.mode).toBe('ACTIVE_HEAT_PROTECTION');
    const levelOff = off.setShutterLevel.mock.calls[0]![2] as number;
    const levelOn = on.setShutterLevel.mock.calls[0]![2] as number;
    // Gentle shading dispatches a strictly gentler (less closed) position.
    expect(levelOn).toBeLessThan(levelOff);
    expect(levelOff).toBeGreaterThanOrEqual(0.9); // slammed nearly shut when off
    expect(levelOn).toBeLessThanOrEqual(0.6); // capped to max(baseRisk, 0.5)
  });
});

// ---------------------------------------------------------------------------
// 2. STORM cycle.
// ---------------------------------------------------------------------------

describe('runCycle — STORM', () => {
  it('mode=STORM forces all windows to 0.0 and persists newStormHoldUntil', async () => {
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
    const { deps, setShutterLevel } = mkDeps(config);

    const snapshot = mkSnapshot({
      windSpeedMs: 14, // > 13.9 threshold → STORM
      rooms: [
        { id: 'schlafzimmer', tempC: 24, priority: 'very_high' },
        { id: 'arbeitszimmer', tempC: 24, priority: 'very_high' },
      ],
      windows: [{ config: bedroomRoofWindow() }, { config: officeRoofWindow() }],
    });

    const out = await runCycle(snapshot, deps);

    // Both windows fired with target=0.0 (fully open / safe position).
    expect(setShutterLevel).toHaveBeenCalledTimes(2);
    expect(setShutterLevel).toHaveBeenNthCalledWith(1, 'hmip-bedroom-shutter', 1, 0.0);
    expect(setShutterLevel).toHaveBeenNthCalledWith(2, 'hmip-office-shutter', 1, 0.0);

    expect(out.mode).toBe('STORM');
    expect(out.newStormHoldUntil).not.toBeNull();
    // Hold persists for `releaseHoldMin` (10 min) past `now`.
    expect(out.newStormHoldUntil!.getTime()).toBe(NOW.getTime() + 10 * 60 * 1000);

    // DecisionRecord — both windows show finalTarget=0 and moved=true.
    expect(out.decisionRecord.mode).toBe('STORM');
    expect(out.decisionRecord.windowDecisions).toHaveLength(2);
    for (const e of out.decisionRecord.windowDecisions) {
      expect(e.finalTarget).toBe(0.0);
      expect(e.moved).toBe(true);
      expect(e.blockedBy).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. pauseControl=true.
// ---------------------------------------------------------------------------

describe('runCycle — pauseControl', () => {
  it('skips setShutterLevel and reports blockedBy=pause for every window', async () => {
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
    const { deps, setShutterLevel } = mkDeps(config);

    const snapshot = mkSnapshot({
      switches: { vacation: false, pauseControl: true },
      rooms: [{ id: 'schlafzimmer', tempC: 23.4, priority: 'very_high' }],
      windows: [
        {
          config: bedroomRoofWindow(),
          // Engine has moved this shutter before — gives safety a real
          // hold position rather than the baseTarget fallback.
          currentLevel01: 0.5,
        },
      ],
    });

    const out = await runCycle(snapshot, deps);

    expect(setShutterLevel).not.toHaveBeenCalled();
    expect(out.decisionRecord.windowDecisions).toHaveLength(1);
    const entry = out.decisionRecord.windowDecisions[0]!;
    expect(entry.moved).toBe(false);
    expect(entry.blockedBy).toBe('pause');
  });
});

// ---------------------------------------------------------------------------
// 4. Manual override.
// ---------------------------------------------------------------------------

describe('runCycle — manual override', () => {
  it('manualOverrideUntil 30 min in the future suppresses the move', async () => {
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
    const { deps, setShutterLevel } = mkDeps(config);

    const overrideUntil = new Date(NOW.getTime() + 30 * 60 * 1000);
    const snapshot = mkSnapshot({
      rooms: [{ id: 'schlafzimmer', tempC: 23.4, priority: 'very_high' }],
      windows: [
        {
          config: bedroomRoofWindow(),
          currentLevel01: 0.5,
          runtimeState: {
            windowId: 'bedroom-window',
            lastCommandedLevel01: 0.5,
            lastCommandedAt: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(),
            manualOverrideUntil: overrideUntil.toISOString(),
            lastDecisionMode: 'ACTIVE_HEAT_PROTECTION',
          },
        },
      ],
    });

    const out = await runCycle(snapshot, deps);

    expect(setShutterLevel).not.toHaveBeenCalled();
    const entry = out.decisionRecord.windowDecisions[0]!;
    expect(entry.moved).toBe(false);
    expect(entry.blockedBy).toBe('manual_override');
  });
});

// ---------------------------------------------------------------------------
// 5. Multiple windows.
// ---------------------------------------------------------------------------

describe('runCycle — multiple windows', () => {
  it('produces one decision entry per configured window in order', async () => {
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
    const { deps, setShutterLevel } = mkDeps(config);

    const snapshot = mkSnapshot({
      rooms: [
        { id: 'schlafzimmer', tempC: 23.4, priority: 'very_high' },
        { id: 'arbeitszimmer', tempC: 23.4, priority: 'very_high' },
      ],
      windows: [{ config: bedroomRoofWindow() }, { config: officeRoofWindow() }],
    });

    const out = await runCycle(snapshot, deps);

    expect(setShutterLevel).toHaveBeenCalledTimes(2);
    expect(out.decisionRecord.windowDecisions.map((e) => e.windowId)).toEqual([
      'bedroom-window',
      'office-window',
    ]);
  });
});

// ---------------------------------------------------------------------------
// 6. setShutterLevel error → system_error.
// ---------------------------------------------------------------------------

describe('runCycle — setShutterLevel error', () => {
  it('catches the rejection, marks the entry blockedBy=system_error and still appends history', async () => {
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

    const setShutterLevel = vi.fn(async () => {
      throw new Error('HCU rejected');
    });
    const appendHistoryRecord = vi.fn(async () => {
      return undefined;
    });
    const logSpy = vi.fn();
    const deps: OrchestratorDeps = {
      config,
      hmipSystem: { setShutterLevel },
      appendHistoryRecord,
      logger: logSpy,
    };

    const snapshot = mkSnapshot({
      rooms: [{ id: 'schlafzimmer', tempC: 23.4, priority: 'very_high' }],
      windows: [{ config: bedroomRoofWindow() }],
    });

    const out = await runCycle(snapshot, deps);

    expect(setShutterLevel).toHaveBeenCalledTimes(1);
    const entry = out.decisionRecord.windowDecisions[0]!;
    expect(entry.moved).toBe(false);
    expect(entry.blockedBy).toBe('system_error');
    // History still appended.
    expect(appendHistoryRecord).toHaveBeenCalledTimes(1);
    // Logger captured the error.
    expect(logSpy).toHaveBeenCalledWith(
      'warn',
      'setShutterLevel failed',
      expect.objectContaining({ windowId: 'bedroom-window' }),
    );
  });
});

// ---------------------------------------------------------------------------
// 7. channelIndexFor injection respected.
// ---------------------------------------------------------------------------

describe('runCycle — channelIndexFor injection', () => {
  it('forwards a custom channelIndexFor to setShutterLevel', async () => {
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
      channelIndexFor: (windowId): number => (windowId === 'bedroom-window' ? 3 : 1),
    };

    const snapshot = mkSnapshot({
      rooms: [{ id: 'schlafzimmer', tempC: 23.4, priority: 'very_high' }],
      windows: [{ config: bedroomRoofWindow() }],
    });

    await runCycle(snapshot, deps);

    expect(setShutterLevel).toHaveBeenCalledWith('hmip-bedroom-shutter', 3, 1.0);
  });
});

// ---------------------------------------------------------------------------
// Heat-protection close cap (façade 95% / roof 100% / configurable).
// ---------------------------------------------------------------------------

/** Bedroom FAÇADE window @ SE 135° — same hot scenario, façade type. */
function bedroomFacadeWindow(overrides: Partial<Window> = {}): Window {
  return {
    id: 'bedroom-window',
    roomId: 'schlafzimmer',
    shutterDeviceId: 'hmip-bedroom-shutter',
    orientationDeg: 135,
    type: 'facade',
    isDoor: false,
    canMoveWhenOpen: true,
    maxPositionWhenOpenPct: 60,
    sunPrelookMinutes: 60,
    lockoutProtection: true,
    ...overrides,
  };
}

describe('runCycle — heat-protection close cap', () => {
  const hotRoom = {
    id: 'schlafzimmer',
    name: 'Schlafzimmer',
    priority: 'very_high' as Priority,
    targets: ROOM_TARGETS,
    signals: {},
    occupancyMode: 'always_priority' as const,
  };

  it('clamps a full-close target down to a configured cap (0.95)', async () => {
    // A roof window naturally reaches 1.0; with an explicit 0.95 cap the
    // engine must leave the 5% gap. This exercises the clamp against a
    // genuine full-close target (façades top out at 0.9 in the risk
    // model, so the façade default cap is a non-binding safety ceiling).
    const win = bedroomRoofWindow({ maxHeatProtectionLevel01: 0.95 });
    const config = mkConfig({ rooms: [hotRoom], windows: [win] });
    const { deps, setShutterLevel } = mkDeps(config);
    const snapshot = mkSnapshot({
      rooms: [{ id: 'schlafzimmer', tempC: 27, priority: 'very_high' }],
      forecastMaxTempC: 32,
      windows: [{ config: win }],
    });

    const out = await runCycle(snapshot, deps);

    expect(out.mode).not.toBe('NIGHT_COOLING');
    const entry = out.decisionRecord.windowDecisions[0]!;
    expect(entry.finalTarget).toBeCloseTo(0.95, 9);
    expect(setShutterLevel).toHaveBeenCalledWith('hmip-bedroom-shutter', 1, 0.95);
  });

  it('lets a roof window reach 1.0 (exempt from the cap)', async () => {
    const config = mkConfig({ rooms: [hotRoom], windows: [bedroomRoofWindow()] });
    const { deps, setShutterLevel } = mkDeps(config);
    const snapshot = mkSnapshot({
      rooms: [{ id: 'schlafzimmer', tempC: 27, priority: 'very_high' }],
      forecastMaxTempC: 32,
      windows: [{ config: bedroomRoofWindow() }],
    });

    const out = await runCycle(snapshot, deps);

    const entry = out.decisionRecord.windowDecisions[0]!;
    expect(entry.finalTarget).toBeCloseTo(1.0, 9);
    expect(setShutterLevel).toHaveBeenCalledWith('hmip-bedroom-shutter', 1, 1.0);
  });

  it('respects a per-window maxHeatProtectionLevel01 override', async () => {
    const win = bedroomFacadeWindow({ maxHeatProtectionLevel01: 0.8 });
    const config = mkConfig({ rooms: [hotRoom], windows: [win] });
    const { deps, setShutterLevel } = mkDeps(config);
    const snapshot = mkSnapshot({
      rooms: [{ id: 'schlafzimmer', tempC: 27, priority: 'very_high' }],
      forecastMaxTempC: 32,
      windows: [{ config: win }],
    });

    const out = await runCycle(snapshot, deps);

    const entry = out.decisionRecord.windowDecisions[0]!;
    expect(entry.finalTarget).toBeCloseTo(0.8, 9);
    expect(setShutterLevel).toHaveBeenCalledWith('hmip-bedroom-shutter', 1, 0.8);
  });
});

// ---------------------------------------------------------------------------
// Ventilation lockout (smart-shading Task 6, Property 5).
// ---------------------------------------------------------------------------

describe('runCycle — ventilation lockout', () => {
  const hotRoom = {
    id: 'schlafzimmer',
    name: 'Schlafzimmer',
    priority: 'very_high' as Priority,
    targets: ROOM_TARGETS,
    signals: {},
    occupancyMode: 'always_priority' as const,
  };

  it('never calls setShutterLevel while the contact is open, and reports blockedBy=venting', async () => {
    const win = bedroomRoofWindow();
    const config = mkConfig({ rooms: [hotRoom], windows: [win] });
    const { deps, setShutterLevel } = mkDeps(config);
    const snapshot = mkSnapshot({
      rooms: [{ id: 'schlafzimmer', tempC: 27, priority: 'very_high' }],
      forecastMaxTempC: 32,
      // Hot inputs would otherwise drive a close; the open sash must win.
      windows: [{ config: win, contactState: 'open' }],
    });

    const out = await runCycle(snapshot, deps);

    expect(setShutterLevel).not.toHaveBeenCalled();
    const entry = out.decisionRecord.windowDecisions[0]!;
    expect(entry.moved).toBe(false);
    expect(entry.blockedBy).toBe('venting');
  });

  it('resumes control once the contact closes again', async () => {
    const win = bedroomRoofWindow();
    const config = mkConfig({ rooms: [hotRoom], windows: [win] });
    const { deps, setShutterLevel } = mkDeps(config);
    const snapshot = mkSnapshot({
      rooms: [{ id: 'schlafzimmer', tempC: 27, priority: 'very_high' }],
      forecastMaxTempC: 32,
      windows: [{ config: win, contactState: 'closed' }],
    });

    const out = await runCycle(snapshot, deps);

    expect(setShutterLevel).toHaveBeenCalledTimes(1);
    const entry = out.decisionRecord.windowDecisions[0]!;
    expect(entry.moved).toBe(true);
    expect(entry.blockedBy).toBeUndefined();
  });

  it('STORM overrides the lockout — the safety force-open still dispatches', async () => {
    const win = bedroomRoofWindow();
    const config = mkConfig({ rooms: [hotRoom], windows: [win] });
    const { deps, setShutterLevel } = mkDeps(config);
    const snapshot = mkSnapshot({
      rooms: [{ id: 'schlafzimmer', tempC: 27, priority: 'very_high' }],
      windSpeedMs: 14, // above storm threshold 13.9
      windows: [{ config: win, contactState: 'open' }],
    });

    const out = await runCycle(snapshot, deps);

    expect(out.mode).toBe('STORM');
    // Storm forces the shutter open despite the open contact.
    expect(setShutterLevel).toHaveBeenCalledTimes(1);
    const entry = out.decisionRecord.windowDecisions[0]!;
    expect(entry.blockedBy).not.toBe('venting');
  });

  it('STORM overrides a per-window "Automatik aus" block — safety force-open wins', async () => {
    const win = { ...bedroomRoofWindow(), automationBlocked: true };
    const config = mkConfig({ rooms: [hotRoom], windows: [win] });
    const { deps, setShutterLevel } = mkDeps(config);
    const snapshot = mkSnapshot({
      rooms: [{ id: 'schlafzimmer', tempC: 27, priority: 'very_high' }],
      windSpeedMs: 14, // above storm threshold
      windows: [{ config: win, contactState: 'closed' }],
    });

    const out = await runCycle(snapshot, deps);

    expect(out.mode).toBe('STORM');
    // The per-window automation block must NOT suppress a storm force-open.
    expect(setShutterLevel).toHaveBeenCalledTimes(1);
    const entry = out.decisionRecord.windowDecisions[0]!;
    expect(entry.blockedBy).not.toBe('blocked');
  });
});

// ---------------------------------------------------------------------------
// Winter insulation (Step 3b¾) — closes shutters on cold, dark nights.
// ---------------------------------------------------------------------------

describe('runCycle — winter insulation', () => {
  // 2026-01-15 02:00 UTC = 03:00 Berlin — deep night, sun well below horizon.
  const WINTER_NIGHT = new Date('2026-01-15T02:00:00.000Z');

  const coolRoom = {
    id: 'schlafzimmer',
    name: 'Schlafzimmer',
    priority: 'very_high' as Priority,
    targets: ROOM_TARGETS,
    signals: {},
    occupancyMode: 'always_priority' as const,
  };

  /** Config with insulation on and night cooling off (so mode stays NORMAL). */
  function insulationConfig(level01 = 1, maxOutdoorTempC = 5): Config {
    const base = mkConfig({ rooms: [coolRoom], windows: [bedroomFacadeWindow()] });
    return {
      ...base,
      rules: {
        ...base.rules,
        nightCooling: { enabled: false, deltaC: 1.5, reopenAtSunriseOffsetMin: -30 },
        insulation: { enabled: true, maxOutdoorTempC, level01 },
      },
    };
  }

  it('closes a roof shutter on a cold dark night to level01', async () => {
    const base = mkConfig({ rooms: [coolRoom], windows: [bedroomRoofWindow()] });
    const config: Config = {
      ...base,
      rules: {
        ...base.rules,
        nightCooling: { enabled: false, deltaC: 1.5, reopenAtSunriseOffsetMin: -30 },
        insulation: { enabled: true, maxOutdoorTempC: 5, level01: 1 },
      },
    };
    const { deps, setShutterLevel } = mkDeps(config);
    const snapshot = mkSnapshot({
      now: WINTER_NIGHT,
      outdoorTempC: 2,
      forecastMaxTempC: 6,
      pvSmoothedKw: 0,
      radiationWm2: 0,
      rooms: [{ id: 'schlafzimmer', tempC: 21, priority: 'very_high' }],
      windows: [{ config: bedroomRoofWindow(), currentLevel01: 0 }],
    });

    const out = await runCycle(snapshot, deps);

    expect(out.mode).not.toBe('STORM');
    expect(out.mode).not.toBe('NIGHT_COOLING');
    const entry = out.decisionRecord.windowDecisions[0]!;
    expect(entry.finalTarget).toBeCloseTo(1.0, 9);
    expect(setShutterLevel).toHaveBeenCalledWith('hmip-bedroom-shutter', 1, 1.0);
  });

  it('does not insulate when the outdoor temperature is above the threshold', async () => {
    const config = insulationConfig(1, 5);
    const { deps, setShutterLevel } = mkDeps(config);
    const snapshot = mkSnapshot({
      now: WINTER_NIGHT,
      outdoorTempC: 12, // above the 5 °C threshold
      forecastMaxTempC: 14,
      pvSmoothedKw: 0,
      radiationWm2: 0,
      rooms: [{ id: 'schlafzimmer', tempC: 21, priority: 'very_high' }],
      windows: [{ config: bedroomFacadeWindow(), currentLevel01: 0 }],
    });

    const out = await runCycle(snapshot, deps);

    const entry = out.decisionRecord.windowDecisions[0]!;
    expect(entry.finalTarget).toBeLessThan(0.5);
    expect(setShutterLevel).not.toHaveBeenCalled();
  });

  it('stays open when insulation is disabled', async () => {
    const base = mkConfig({ rooms: [coolRoom], windows: [bedroomFacadeWindow()] });
    const config: Config = {
      ...base,
      rules: {
        ...base.rules,
        nightCooling: { enabled: false, deltaC: 1.5, reopenAtSunriseOffsetMin: -30 },
        insulation: { enabled: false, maxOutdoorTempC: 5, level01: 1 },
      },
    };
    const { deps, setShutterLevel } = mkDeps(config);
    const snapshot = mkSnapshot({
      now: WINTER_NIGHT,
      outdoorTempC: 2,
      forecastMaxTempC: 6,
      pvSmoothedKw: 0,
      radiationWm2: 0,
      rooms: [{ id: 'schlafzimmer', tempC: 21, priority: 'very_high' }],
      windows: [{ config: bedroomFacadeWindow(), currentLevel01: 0 }],
    });

    const out = await runCycle(snapshot, deps);

    const entry = out.decisionRecord.windowDecisions[0]!;
    expect(entry.finalTarget).toBeLessThan(0.5);
    expect(setShutterLevel).not.toHaveBeenCalled();
  });
});
