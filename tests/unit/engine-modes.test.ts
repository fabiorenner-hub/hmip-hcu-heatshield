/**
 * Tests for the mode FSM in `src/plugin/engine/modes.ts` (Task 7.2).
 *
 * Coverage:
 *   - STORM: wind > threshold arms a hold; persistent hold keeps STORM
 *     active even when wind drops; expired hold releases STORM; null
 *     wind treats as 0.
 *   - MAINTENANCE: dashboard override beats every non-storm signal.
 *   - VACATION: switch beats SUMMER_WATCH / ACTIVE / HEATWAVE but yields
 *     to STORM and MAINTENANCE.
 *   - HEATWAVE / ACTIVE: forecast and room thresholds (per regelwerk
 *     §8 warning).
 *   - NIGHT_COOLING: cooler outdoor air with sun down opens windows;
 *     sun up disables; morning close-up cutoff terminates.
 *   - SUMMER_WATCH: each individual trigger (forecast / outdoor / pv).
 *   - NORMAL fallback.
 *   - Precedence: storm > maintenance > vacation > heat cascade.
 *   - `isHeatModeActive` mirrors `HEAT_MODE_ACTIVE`.
 *
 * Style mirrors `engine-risk.test.ts`: pure data-table assertions, no
 * mocking, no fixtures. Inputs are constructed inline via a small
 * `mkInputs` helper so each test reads as a single self-contained
 * scenario.
 */

import { describe, expect, it } from 'vitest';

import {
  HEAT_MODE_ACTIVE,
  checkStormHold,
  determineMode,
  isHeatModeActive,
  type ModeInputs,
} from '../../src/plugin/engine/modes.js';
import type { Mode } from '../../src/shared/types.js';

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

const NOW = new Date('2025-07-15T12:00:00.000Z');

const STORM_RULES = {
  thresholdMs: 13.9,
  releaseMs: 8.0,
  releaseHoldMin: 10,
};

const NIGHT_COOLING_RULES = {
  enabled: true,
  deltaC: 1.5,
  reopenAtSunriseOffsetMin: -30,
};

/**
 * Builds a fully-populated `ModeInputs` object with benign defaults
 * (everything nullish, no triggers) and lets callers override the few
 * fields a given test cares about.
 */
function mkInputs(overrides: Partial<ModeInputs> = {}): ModeInputs {
  return {
    now: NOW,
    outdoorTempC: null,
    forecastMaxTempC: null,
    pvSmoothedKw: null,
    windSpeedMs: null,
    maxPriorityRoomTempC: null,
    sunriseUtc: null,
    sunIsUp: false,
    switches: { vacation: false, pauseControl: false },
    maintenanceMode: false,
    stormHoldUntil: null,
    rules: { storm: STORM_RULES, nightCooling: NIGHT_COOLING_RULES },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// STORM
// ---------------------------------------------------------------------------

describe('determineMode — STORM', () => {
  it('arms a hold when wind exceeds threshold', () => {
    const r = determineMode(mkInputs({ windSpeedMs: 14 }));
    expect(r.mode).toBe('STORM');
    expect(r.newStormHoldUntil).not.toBeNull();
    expect(r.newStormHoldUntil!.getTime()).toBe(
      NOW.getTime() + STORM_RULES.releaseHoldMin * 60 * 1000,
    );
    expect(r.reason).toBe('storm: wind=14m/s > 13.9m/s');
  });

  it('keeps STORM while a previous hold is still active', () => {
    const future = new Date(NOW.getTime() + 5 * 60 * 1000);
    const r = determineMode(mkInputs({ windSpeedMs: 5, stormHoldUntil: future }));
    expect(r.mode).toBe('STORM');
    // Wind below threshold and hold not yet renewed → no new persist value.
    expect(r.newStormHoldUntil).toBeNull();
  });

  it('releases STORM once the hold has elapsed', () => {
    const past = new Date(NOW.getTime() - 60 * 1000);
    const r = determineMode(mkInputs({ windSpeedMs: 5, stormHoldUntil: past }));
    expect(r.mode).toBe('NORMAL');
    expect(r.newStormHoldUntil).toBeNull();
  });

  it('treats null wind as 0 (no STORM unless hold persists)', () => {
    const r = determineMode(mkInputs({ windSpeedMs: null }));
    expect(r.mode).toBe('NORMAL');
  });

  it('extends the hold while wind keeps exceeding the threshold', () => {
    // Existing hold expiring soon, new gust extends it past the original.
    const soon = new Date(NOW.getTime() + 60 * 1000);
    const r = determineMode(mkInputs({ windSpeedMs: 20, stormHoldUntil: soon }));
    expect(r.mode).toBe('STORM');
    expect(r.newStormHoldUntil).not.toBeNull();
    expect(r.newStormHoldUntil!.getTime()).toBe(
      NOW.getTime() + STORM_RULES.releaseHoldMin * 60 * 1000,
    );
  });
});

// ---------------------------------------------------------------------------
// checkStormHold (exposed for testing).
// ---------------------------------------------------------------------------

describe('checkStormHold', () => {
  it('returns active=false with no wind and no hold', () => {
    expect(checkStormHold(mkInputs())).toEqual({ active: false, until: null });
  });

  it('arms a fresh hold on wind trigger', () => {
    const r = checkStormHold(mkInputs({ windSpeedMs: 15 }));
    expect(r.active).toBe(true);
    expect(r.until).not.toBeNull();
  });

  it('holds without renewing while previous hold is active', () => {
    const future = new Date(NOW.getTime() + 5 * 60 * 1000);
    const r = checkStormHold(mkInputs({ windSpeedMs: 0, stormHoldUntil: future }));
    expect(r).toEqual({ active: true, until: null });
  });

  it('reports inactive when hold has expired and wind is calm', () => {
    const past = new Date(NOW.getTime() - 1);
    const r = checkStormHold(mkInputs({ windSpeedMs: 0, stormHoldUntil: past }));
    expect(r).toEqual({ active: false, until: null });
  });
});

// ---------------------------------------------------------------------------
// MAINTENANCE
// ---------------------------------------------------------------------------

describe('determineMode — MAINTENANCE', () => {
  it('selects MAINTENANCE when the dashboard flag is on', () => {
    const r = determineMode(mkInputs({ maintenanceMode: true }));
    expect(r.mode).toBe('MAINTENANCE');
    expect(r.reason).toBe('maintenance: dashboard override');
  });

  it('STORM still wins over MAINTENANCE', () => {
    const r = determineMode(mkInputs({ maintenanceMode: true, windSpeedMs: 14 }));
    expect(r.mode).toBe('STORM');
  });
});

// ---------------------------------------------------------------------------
// VACATION
// ---------------------------------------------------------------------------

describe('determineMode — VACATION', () => {
  it('selects VACATION when the switch is on', () => {
    const r = determineMode(mkInputs({ switches: { vacation: true, pauseControl: false } }));
    expect(r.mode).toBe('VACATION');
    expect(r.reason).toBe('vacation: control switch on');
  });

  it('VACATION beats HEATWAVE-level signals', () => {
    const r = determineMode(
      mkInputs({
        switches: { vacation: true, pauseControl: false },
        forecastMaxTempC: 30,
        maxPriorityRoomTempC: 25,
      }),
    );
    expect(r.mode).toBe('VACATION');
  });

  it('STORM still wins over VACATION', () => {
    const r = determineMode(
      mkInputs({
        switches: { vacation: true, pauseControl: false },
        windSpeedMs: 14,
      }),
    );
    expect(r.mode).toBe('STORM');
  });

  it('MAINTENANCE still wins over VACATION', () => {
    const r = determineMode(
      mkInputs({
        switches: { vacation: true, pauseControl: false },
        maintenanceMode: true,
      }),
    );
    expect(r.mode).toBe('MAINTENANCE');
  });
});

// ---------------------------------------------------------------------------
// HEATWAVE
// ---------------------------------------------------------------------------

describe('determineMode — HEATWAVE', () => {
  it('triggers on forecast >= 30°C', () => {
    const r = determineMode(mkInputs({ forecastMaxTempC: 30 }));
    expect(r.mode).toBe('HEATWAVE');
    expect(r.reason).toContain('heatwave');
  });

  it('triggers on priority room >= 24.5°C', () => {
    const r = determineMode(mkInputs({ maxPriorityRoomTempC: 25 }));
    expect(r.mode).toBe('HEATWAVE');
  });

  it('does not trigger just below the threshold', () => {
    const r = determineMode(mkInputs({ forecastMaxTempC: 29.9, maxPriorityRoomTempC: 24.4 }));
    expect(r.mode).not.toBe('HEATWAVE');
  });
});

// ---------------------------------------------------------------------------
// ACTIVE_HEAT_PROTECTION
// ---------------------------------------------------------------------------

describe('determineMode — ACTIVE_HEAT_PROTECTION', () => {
  it('triggers on forecast >= 25°C with no room data', () => {
    const r = determineMode(mkInputs({ forecastMaxTempC: 26 }));
    expect(r.mode).toBe('ACTIVE_HEAT_PROTECTION');
    expect(r.reason).toContain('active heat protection');
  });

  it('triggers on warning room threshold (23.5°C) with cooler forecast', () => {
    const r = determineMode(mkInputs({ forecastMaxTempC: 20, maxPriorityRoomTempC: 23.5 }));
    expect(r.mode).toBe('ACTIVE_HEAT_PROTECTION');
  });

  it('does not trigger below both thresholds', () => {
    const r = determineMode(mkInputs({ forecastMaxTempC: 24.9, maxPriorityRoomTempC: 23.4 }));
    expect(r.mode).not.toBe('ACTIVE_HEAT_PROTECTION');
  });
});

// ---------------------------------------------------------------------------
// NIGHT_COOLING
// ---------------------------------------------------------------------------

describe('determineMode — NIGHT_COOLING', () => {
  it('triggers when outdoor is at least deltaC cooler than the room and sun is down', () => {
    const r = determineMode(
      mkInputs({
        outdoorTempC: 20,
        maxPriorityRoomTempC: 24,
        sunIsUp: false,
      }),
    );
    expect(r.mode).toBe('NIGHT_COOLING');
    expect(r.reason).toBe('night cooling: outdoor 20°C cools room 24°C');
  });

  it('does not trigger when sun is up', () => {
    const r = determineMode(
      mkInputs({
        outdoorTempC: 20,
        maxPriorityRoomTempC: 24,
        sunIsUp: true,
      }),
    );
    expect(r.mode).not.toBe('NIGHT_COOLING');
  });

  it('does not trigger when outdoor is too warm (delta < deltaC)', () => {
    // room - delta = 24 - 1.5 = 22.5; outdoor 23 > 22.5 → no NIGHT_COOLING
    const r = determineMode(
      mkInputs({
        outdoorTempC: 23,
        maxPriorityRoomTempC: 24,
        sunIsUp: false,
      }),
    );
    expect(r.mode).not.toBe('NIGHT_COOLING');
  });

  it('terminates after sunrise + reopenAtSunriseOffsetMin', () => {
    // sunrise at 04:00 UTC, offset -30 → cutoff 03:30 UTC. NOW = 12:00 UTC > cutoff.
    const sunrise = new Date('2025-07-15T04:00:00.000Z');
    const r = determineMode(
      mkInputs({
        outdoorTempC: 18,
        maxPriorityRoomTempC: 24,
        sunIsUp: false,
        sunriseUtc: sunrise,
      }),
    );
    expect(r.mode).not.toBe('NIGHT_COOLING');
  });

  it('still active before the sunrise cutoff', () => {
    // sunrise far in the future (next morning) → cutoff is also in the future.
    const sunrise = new Date('2025-07-16T04:00:00.000Z');
    const r = determineMode(
      mkInputs({
        outdoorTempC: 18,
        maxPriorityRoomTempC: 24,
        sunIsUp: false,
        sunriseUtc: sunrise,
      }),
    );
    expect(r.mode).toBe('NIGHT_COOLING');
  });

  it('respects the enabled flag', () => {
    const r = determineMode(
      mkInputs({
        outdoorTempC: 20,
        maxPriorityRoomTempC: 24,
        sunIsUp: false,
        rules: {
          storm: STORM_RULES,
          nightCooling: { ...NIGHT_COOLING_RULES, enabled: false },
        },
      }),
    );
    expect(r.mode).not.toBe('NIGHT_COOLING');
  });
});

// ---------------------------------------------------------------------------
// SUMMER_WATCH
// ---------------------------------------------------------------------------

describe('determineMode — SUMMER_WATCH', () => {
  it('triggers on forecast >= 24°C', () => {
    const r = determineMode(mkInputs({ forecastMaxTempC: 24, maxPriorityRoomTempC: 22 }));
    expect(r.mode).toBe('SUMMER_WATCH');
    expect(r.reason).toBe('summer watch: forecast/outdoor/pv');
  });

  it('triggers on outdoor >= 22°C alone', () => {
    const r = determineMode(mkInputs({ outdoorTempC: 22 }));
    expect(r.mode).toBe('SUMMER_WATCH');
  });

  it('triggers on PV smoothed > 2.0 kW alone', () => {
    const r = determineMode(mkInputs({ pvSmoothedKw: 2.5 }));
    expect(r.mode).toBe('SUMMER_WATCH');
  });

  it('does not trigger at PV exactly 2.0 kW (strict greater-than)', () => {
    const r = determineMode(mkInputs({ pvSmoothedKw: 2.0 }));
    expect(r.mode).toBe('NORMAL');
  });
});

// ---------------------------------------------------------------------------
// NORMAL
// ---------------------------------------------------------------------------

describe('determineMode — NORMAL', () => {
  it('falls back to NORMAL with no triggers', () => {
    const r = determineMode(mkInputs());
    expect(r.mode).toBe('NORMAL');
    expect(r.reason).toBe('normal');
  });
});

// ---------------------------------------------------------------------------
// Precedence cross-checks (from the task brief).
// ---------------------------------------------------------------------------

describe('determineMode — precedence', () => {
  it('STORM beats MAINTENANCE (wind=14 + maintenance=true)', () => {
    const r = determineMode(mkInputs({ windSpeedMs: 14, maintenanceMode: true }));
    expect(r.mode).toBe('STORM');
  });

  it('VACATION beats HEATWAVE (vacation=true + forecast=30)', () => {
    const r = determineMode(
      mkInputs({
        switches: { vacation: true, pauseControl: false },
        forecastMaxTempC: 30,
      }),
    );
    expect(r.mode).toBe('VACATION');
  });

  it('HEATWAVE beats ACTIVE (room=25 + forecast=26)', () => {
    const r = determineMode(mkInputs({ forecastMaxTempC: 26, maxPriorityRoomTempC: 25 }));
    expect(r.mode).toBe('HEATWAVE');
  });

  it('ACTIVE beats SUMMER_WATCH (forecast=26)', () => {
    const r = determineMode(mkInputs({ forecastMaxTempC: 26 }));
    expect(r.mode).toBe('ACTIVE_HEAT_PROTECTION');
  });

  it('NIGHT_COOLING beats SUMMER_WATCH at night when applicable', () => {
    // outdoor=22 alone would be SUMMER_WATCH, but cooler than room and sun
    // down → NIGHT_COOLING wins per the cascade order.
    const r = determineMode(
      mkInputs({
        outdoorTempC: 22,
        maxPriorityRoomTempC: 24,
        sunIsUp: false,
      }),
    );
    expect(r.mode).toBe('NIGHT_COOLING');
  });
});

// ---------------------------------------------------------------------------
// HEAT_MODE_ACTIVE / isHeatModeActive
// ---------------------------------------------------------------------------

describe('HEAT_MODE_ACTIVE / isHeatModeActive', () => {
  it('contains exactly ACTIVE_HEAT_PROTECTION and HEATWAVE', () => {
    expect(HEAT_MODE_ACTIVE.size).toBe(2);
    expect(HEAT_MODE_ACTIVE.has('ACTIVE_HEAT_PROTECTION')).toBe(true);
    expect(HEAT_MODE_ACTIVE.has('HEATWAVE')).toBe(true);
  });

  const allModes: Mode[] = [
    'NORMAL',
    'SUMMER_WATCH',
    'ACTIVE_HEAT_PROTECTION',
    'HEATWAVE',
    'NIGHT_COOLING',
    'STORM',
    'VACATION',
    'MAINTENANCE',
  ];

  it.each(allModes)('isHeatModeActive(%s) matches the steering definition', (m) => {
    const expected = m === 'ACTIVE_HEAT_PROTECTION' || m === 'HEATWAVE';
    expect(isHeatModeActive(m)).toBe(expected);
  });
});
