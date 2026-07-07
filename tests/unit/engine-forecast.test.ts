/**
 * Tests for the synthetic forecast lookahead in
 * `src/plugin/engine/forecast.ts` (Task 8.2).
 *
 * Coverage matches the four scenarios from tasks.md §8.2:
 *   1. Early-morning cool snapshot → heat protection NOT predicted.
 *   2. 09:00 with forecast=29 °C → predicted via future FSM hitting
 *      ACTIVE_HEAT_PROTECTION.
 *   3. Deep winter night → not predicted.
 *   4. Summer afternoon, priority bedroom warming to 23.4 °C, SE roof
 *      window in the sun → predicted via sun-on-window branch with
 *      warm room buffer.
 *
 * Plus a couple of structural sanity checks:
 *   - `checkedAt` echoes `snapshot.now`.
 *   - `horizonMinutes` echoes the input.
 *   - The reason string is deterministic / non-empty.
 */

import { describe, expect, it } from 'vitest';

import { computeForecastLookahead } from '../../src/plugin/engine/forecast.js';
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
// Helpers — small, inline, no fixtures.
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

interface SnapshotOpts {
  now: Date;
  outdoorTempC?: number | null;
  forecastMaxTempC?: number | null;
  pvSmoothedKw?: number | null;
  windSpeedMs?: number | null;
  radiationWm2?: number | null;
  rooms: Array<{ id: string; tempC: number | null; priority: Priority; targets?: RoomTargets }>;
  windows: Array<{
    config: Window;
    contactState?: ContactState;
    currentLevel01?: number | null;
    runtimeState?: WindowRuntimeState | null;
  }>;
  switches?: { vacation: boolean; pauseControl: boolean };
  stormHoldUntil?: Date | null;
  maintenanceMode?: boolean;
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
    now: opts.now,
    outdoorTempC: opts.outdoorTempC ?? 20,
    forecastMaxTempC: opts.forecastMaxTempC ?? 22,
    pvSmoothedKw: opts.pvSmoothedKw ?? 0,
    pvDroppedRecently: false,
    windSpeedMs: opts.windSpeedMs ?? 1.0,
    radiationWm2: opts.radiationWm2 ?? 0,
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

// ---------------------------------------------------------------------------
// 1. Early morning, cool inputs → not predicted.
// ---------------------------------------------------------------------------

describe('computeForecastLookahead — early morning cool', () => {
  it('returns willHeatProtect=false when forecast is mild and rooms are cool', () => {
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
    // 2026-06-21 04:00 UTC = 06:00 Berlin local. +60 min still has the
    // sun well below the SE incidence cone for a 135° window (sun at
    // az≈97°, el≈35° — outside 135 ± 95° check is false).
    const snapshot = mkSnapshot({
      now: new Date('2026-06-21T04:00:00.000Z'),
      outdoorTempC: 16,
      forecastMaxTempC: 22,
      pvSmoothedKw: 0,
      rooms: [{ id: 'schlafzimmer', tempC: 21, priority: 'very_high' }],
      windows: [{ config: bedroomRoofWindow() }],
    });

    const result = computeForecastLookahead({
      snapshot,
      config,
      horizonMinutes: 60,
    });

    expect(result.willHeatProtect).toBe(false);
    expect(result.checkedAt).toEqual(snapshot.now);
    expect(result.horizonMinutes).toBe(60);
    expect(result.reason).toContain('no heat protection predicted');
  });
});

// ---------------------------------------------------------------------------
// 2. Forecast=29°C → predicted via future FSM.
// ---------------------------------------------------------------------------

describe('computeForecastLookahead — forecast 29 °C', () => {
  it('returns willHeatProtect=true via ACTIVE_HEAT_PROTECTION future mode', () => {
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
    // 2026-06-21 09:00 UTC = 11:00 Berlin local. With forecast=29 °C
    // the FSM hits ACTIVE_HEAT_PROTECTION (forecast >= 25 °C) at
    // futureNow regardless of sun specifics.
    const snapshot = mkSnapshot({
      now: new Date('2026-06-21T09:00:00.000Z'),
      outdoorTempC: 22,
      forecastMaxTempC: 29,
      pvSmoothedKw: 3.0,
      rooms: [{ id: 'schlafzimmer', tempC: 22.5, priority: 'very_high' }],
      windows: [{ config: bedroomRoofWindow() }],
    });

    const result = computeForecastLookahead({
      snapshot,
      config,
      horizonMinutes: 60,
    });

    expect(result.willHeatProtect).toBe(true);
    expect(result.reason).toContain('ACTIVE_HEAT_PROTECTION');
    expect(result.reason).toContain('60 min');
  });
});

// ---------------------------------------------------------------------------
// 3. Deep winter night → not predicted.
// ---------------------------------------------------------------------------

describe('computeForecastLookahead — winter night', () => {
  it('returns willHeatProtect=false in deep winter night', () => {
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
      // Disable night cooling so the cold-room/cold-outdoor combo
      // stays in NORMAL rather than NIGHT_COOLING — either way the
      // result is non-heat-protection, but the reason string is
      // cleaner without the night-cooling branch firing.
      windows: [bedroomRoofWindow()],
    });
    // 2026-12-21 02:00 UTC = 03:00 Berlin local. Sun is well below
    // the horizon (el ≈ -46°). +60 min still pre-dawn (el ≈ -37°).
    const snapshot = mkSnapshot({
      now: new Date('2026-12-21T02:00:00.000Z'),
      outdoorTempC: 2,
      forecastMaxTempC: 4,
      pvSmoothedKw: 0,
      rooms: [{ id: 'schlafzimmer', tempC: 19.5, priority: 'very_high' }],
      windows: [{ config: bedroomRoofWindow() }],
    });

    const result = computeForecastLookahead({
      snapshot,
      config,
      horizonMinutes: 60,
    });

    expect(result.willHeatProtect).toBe(false);
    expect(result.reason).toContain('no heat protection predicted');
  });
});

// ---------------------------------------------------------------------------
// 4. Summer afternoon, priority room warming to 23.4 °C, SE roof window
//    in the sun → predicted via sun-on-window branch.
// ---------------------------------------------------------------------------

describe('computeForecastLookahead — sun on warm priority window', () => {
  it('returns willHeatProtect=true when sun lands on a warm priority room within the horizon', () => {
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
    // 2026-06-21 09:00 UTC = 11:00 Berlin local; +60 min lands at
    // 12:00 Berlin where the sun (az ≈ 152°, el ≈ 60°) is well
    // inside the SE roof-window incidence cone (135° ± 95° azimuth,
    // elevation > 5°). Forecast 24 °C keeps the FSM at SUMMER_WATCH
    // and `maxPriorityRoomTempC = 23.4 < 23.5` keeps it from
    // escalating to ACTIVE — so the trigger comes from the sun-on-
    // window branch, not the FSM.
    const snapshot = mkSnapshot({
      now: new Date('2026-06-21T09:00:00.000Z'),
      outdoorTempC: 22,
      forecastMaxTempC: 24,
      pvSmoothedKw: 3.0,
      rooms: [{ id: 'schlafzimmer', tempC: 23.4, priority: 'very_high' }],
      windows: [{ config: bedroomRoofWindow() }],
    });

    const result = computeForecastLookahead({
      snapshot,
      config,
      horizonMinutes: 60,
    });

    expect(result.willHeatProtect).toBe(true);
    expect(result.reason).toContain('sun on priority window bedroom-window');
    expect(result.reason).toContain('warm room 23.4');
  });

  it('returns willHeatProtect=false when the priority room is below the warm buffer', () => {
    // Same shape as the positive case, but room temp drops to 22.5 °C
    // (below `warning_c - 1.5 = 23.0`) — sun-on-window branch must
    // not fire.
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
    const snapshot = mkSnapshot({
      now: new Date('2026-06-21T09:00:00.000Z'),
      outdoorTempC: 22,
      forecastMaxTempC: 24,
      pvSmoothedKw: 3.0,
      rooms: [{ id: 'schlafzimmer', tempC: 22.5, priority: 'very_high' }],
      windows: [{ config: bedroomRoofWindow() }],
    });

    const result = computeForecastLookahead({
      snapshot,
      config,
      horizonMinutes: 60,
    });

    expect(result.willHeatProtect).toBe(false);
  });
});
