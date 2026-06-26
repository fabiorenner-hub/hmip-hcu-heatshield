/**
 * Tests for the ventilation engine in `src/plugin/engine/ventilation.ts`
 * (Task 7.4, Regelwerk §14).
 *
 * Coverage:
 *   - Contact gate: `closed` and `unknown` short-circuit § 14, `tilted` and
 *     `open` activate it.
 *   - §14.2 outside-cooler: target picks the upper bound of the regelwerk
 *     band (no sun → 0.20, sun + low PV → 0.50, sun + high PV → 0.60).
 *     Heat-protection floor *loses* in this branch (cooling wins).
 *   - §14.3 similar temps: target picks the upper band (no sun → 0.40,
 *     sun → 0.70, sun + room ≥ 24.5 °C → 0.90), heat-protection floor
 *     wins via `Math.max`.
 *   - §14.4 outside-warmer: target picks 0.60 / 0.90 / 0.95 depending on
 *     sun + roof, heat-protection floor wins via `Math.max`.
 *   - §14.5 door lockout: hard cap at `maxPositionWhenOpenPct / 100` even
 *     if heat protection wanted 1.0; cap not applied when door is closed;
 *     `lockoutProtection = true` caps non-door windows too.
 *   - §14.6 `canMoveWhenOpen = false`: surfaces `blockedByOpenWindow = true`
 *     while the contact is open or tilted; does not block when closed.
 *   - Combined: door + roof + sun + outside-warmer scenario respects the
 *     §14.5 cap.
 *   - Partial / missing temps: branch defaults to §14.3.
 *
 * Style mirrors `engine-specialRules.test.ts`: no fixtures, no mocking.
 * Inputs are constructed inline via a small `mkInputs` helper so each
 * test reads as a single self-contained scenario.
 */

import { describe, expect, it } from 'vitest';

import {
  COOL_DELTA_C,
  HIGH_PV_KW,
  HIGH_ROOM_TEMP_C,
  WARM_DELTA_C,
  applyVentilation,
  isVentingLockout,
  type VentilationInputs,
} from '../../src/plugin/engine/ventilation.js';

// ---------------------------------------------------------------------------
// mkInputs — benign defaults: closed window, no sun, room ≈ outdoor.
// ---------------------------------------------------------------------------

function mkInputs(overrides: Partial<VentilationInputs> = {}): VentilationInputs {
  return {
    window: {
      isDoor: false,
      canMoveWhenOpen: true,
      maxPositionWhenOpenPct: 60,
      lockoutProtection: true,
      type: 'facade',
    },
    contactState: 'closed',
    roomTempC: 22,
    outdoorTempC: 22,
    sunOnWindowNow: false,
    pvSmoothedKw: null,
    baseTarget01: 0.4,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Contact gate.
// ---------------------------------------------------------------------------

describe('applyVentilation — contact gate', () => {
  it('closed contact: returns baseTarget unchanged with empty rules', () => {
    const r = applyVentilation(mkInputs({ contactState: 'closed', baseTarget01: 0.7 }));
    expect(r.target01).toBe(0.7);
    expect(r.appliedRules).toEqual([]);
    expect(r.blockedByOpenWindow).toBe(false);
  });

  it('unknown contact: returns baseTarget unchanged with empty rules', () => {
    const r = applyVentilation(mkInputs({ contactState: 'unknown', baseTarget01: 0.95 }));
    expect(r.target01).toBe(0.95);
    expect(r.appliedRules).toEqual([]);
    expect(r.blockedByOpenWindow).toBe(false);
  });

  it('tilted contact: §14 activates', () => {
    const r = applyVentilation(
      mkInputs({
        contactState: 'tilted',
        roomTempC: 24,
        outdoorTempC: 20, // delta = 4 → §14.2
      }),
    );
    expect(r.appliedRules).toContain('§14.2 outside-cooler');
  });

  it('open contact: §14 activates', () => {
    const r = applyVentilation(
      mkInputs({
        contactState: 'open',
        roomTempC: 24,
        outdoorTempC: 20,
      }),
    );
    expect(r.appliedRules).toContain('§14.2 outside-cooler');
  });
});

// ---------------------------------------------------------------------------
// §14.2 outside-cooler.
// ---------------------------------------------------------------------------

describe('applyVentilation — §14.2 outside cooler', () => {
  it('no sun → target ≤ 0.20', () => {
    const r = applyVentilation(
      mkInputs({
        contactState: 'open',
        roomTempC: 24,
        outdoorTempC: 20,
        sunOnWindowNow: false,
        baseTarget01: 0.4,
      }),
    );
    expect(r.target01).toBeLessThanOrEqual(0.2);
    expect(r.target01).toBe(0.2);
    expect(r.appliedRules).toContain('§14.2 outside-cooler');
  });

  it('sun + low PV (2 kW) → target ≤ 0.50', () => {
    const r = applyVentilation(
      mkInputs({
        contactState: 'open',
        roomTempC: 24,
        outdoorTempC: 20,
        sunOnWindowNow: true,
        pvSmoothedKw: 2,
        baseTarget01: 0.7,
      }),
    );
    expect(r.target01).toBeLessThanOrEqual(0.5);
    expect(r.target01).toBe(0.5);
  });

  it('sun + high PV (4 kW) → target ≤ 0.60', () => {
    const r = applyVentilation(
      mkInputs({
        contactState: 'open',
        roomTempC: 24,
        outdoorTempC: 20,
        sunOnWindowNow: true,
        pvSmoothedKw: 4,
        baseTarget01: 0.9,
      }),
    );
    expect(r.target01).toBeLessThanOrEqual(0.6);
    expect(r.target01).toBe(0.6);
  });

  it('cooling branch lowers a high baseTarget for airflow', () => {
    // Heat protection wanted 0.95; cooling forces it down to 0.20.
    const r = applyVentilation(
      mkInputs({
        contactState: 'open',
        roomTempC: 24,
        outdoorTempC: 20,
        sunOnWindowNow: false,
        baseTarget01: 0.95,
      }),
    );
    expect(r.target01).toBe(0.2);
  });

  it('delta == COOL_DELTA_C (1.5) is the §14.2 boundary (inclusive)', () => {
    const r = applyVentilation(
      mkInputs({
        contactState: 'open',
        roomTempC: 23.5,
        outdoorTempC: 22, // delta = 1.5
        baseTarget01: 0.4,
      }),
    );
    expect(r.appliedRules).toContain('§14.2 outside-cooler');
  });
});

// ---------------------------------------------------------------------------
// §14.3 similar temperatures.
// ---------------------------------------------------------------------------

describe('applyVentilation — §14.3 similar temps', () => {
  it('delta = 0.5, no sun → 0.40 (max with baseTarget)', () => {
    const r = applyVentilation(
      mkInputs({
        contactState: 'open',
        roomTempC: 24,
        outdoorTempC: 23.5, // delta = 0.5
        sunOnWindowNow: false,
        baseTarget01: 0.1,
      }),
    );
    expect(r.target01).toBe(0.4);
    expect(r.appliedRules).toContain('§14.3 similar-temps');
  });

  it('delta = 0.5, sun → 0.70', () => {
    const r = applyVentilation(
      mkInputs({
        // Disable the §14.5 cap so the §14.3 vent target shows up unmodified.
        window: {
          isDoor: false,
          canMoveWhenOpen: true,
          maxPositionWhenOpenPct: 100,
          lockoutProtection: false,
          type: 'facade',
        },
        contactState: 'open',
        roomTempC: 24,
        outdoorTempC: 23.5,
        sunOnWindowNow: true,
        baseTarget01: 0.1,
      }),
    );
    expect(r.target01).toBe(0.7);
  });

  it('room ≥ 24.5 + sun → 0.90 (high-room-temp sub-rule)', () => {
    const r = applyVentilation(
      mkInputs({
        window: {
          isDoor: false,
          canMoveWhenOpen: true,
          maxPositionWhenOpenPct: 100,
          lockoutProtection: false,
          type: 'facade',
        },
        contactState: 'open',
        roomTempC: HIGH_ROOM_TEMP_C,
        outdoorTempC: 24,
        sunOnWindowNow: true,
        baseTarget01: 0.1,
      }),
    );
    expect(r.target01).toBe(0.9);
  });

  it('§14.3 never lowers baseTarget (heat-protection floor wins)', () => {
    // baseTarget = 0.95; §14.3 vent = 0.40 — must keep 0.95.
    // Window is not a door and lockoutProtection = false, so no cap.
    const r = applyVentilation(
      mkInputs({
        window: {
          isDoor: false,
          canMoveWhenOpen: true,
          maxPositionWhenOpenPct: 60,
          lockoutProtection: false,
          type: 'facade',
        },
        contactState: 'open',
        roomTempC: 24,
        outdoorTempC: 23.5,
        sunOnWindowNow: false,
        baseTarget01: 0.95,
      }),
    );
    expect(r.target01).toBe(0.95);
  });
});

// ---------------------------------------------------------------------------
// §14.4 outside warmer.
// ---------------------------------------------------------------------------

describe('applyVentilation — §14.4 outside warmer', () => {
  it('delta = -5, no sun → 0.60', () => {
    const r = applyVentilation(
      mkInputs({
        window: {
          isDoor: false,
          canMoveWhenOpen: true,
          maxPositionWhenOpenPct: 100,
          lockoutProtection: false,
          type: 'facade',
        },
        contactState: 'open',
        roomTempC: 24,
        outdoorTempC: 29,
        sunOnWindowNow: false,
        baseTarget01: 0.1,
      }),
    );
    expect(r.target01).toBe(0.6);
    expect(r.appliedRules).toContain('§14.4 outside-warmer');
  });

  it('delta = -5, sun → 0.90', () => {
    const r = applyVentilation(
      mkInputs({
        window: {
          isDoor: false,
          canMoveWhenOpen: true,
          maxPositionWhenOpenPct: 100,
          lockoutProtection: false,
          type: 'facade',
        },
        contactState: 'open',
        roomTempC: 24,
        outdoorTempC: 29,
        sunOnWindowNow: true,
        baseTarget01: 0.1,
      }),
    );
    expect(r.target01).toBe(0.9);
  });

  it('delta = -5, sun + roof → 0.95', () => {
    const r = applyVentilation(
      mkInputs({
        window: {
          isDoor: false,
          canMoveWhenOpen: true,
          maxPositionWhenOpenPct: 100,
          lockoutProtection: false,
          type: 'roof_window',
        },
        contactState: 'open',
        roomTempC: 24,
        outdoorTempC: 29,
        sunOnWindowNow: true,
        baseTarget01: 0.1,
      }),
    );
    expect(r.target01).toBe(0.95);
  });

  it('delta == WARM_DELTA_C (-0.5) is the §14.4 boundary (inclusive)', () => {
    const r = applyVentilation(
      mkInputs({
        window: {
          isDoor: false,
          canMoveWhenOpen: true,
          maxPositionWhenOpenPct: 100,
          lockoutProtection: false,
          type: 'facade',
        },
        contactState: 'open',
        roomTempC: 22,
        outdoorTempC: 22.5, // delta = -0.5 ⇒ §14.4
        sunOnWindowNow: false,
        baseTarget01: 0.1,
      }),
    );
    expect(r.appliedRules).toContain('§14.4 outside-warmer');
    expect(r.target01).toBe(0.6);
  });
});

// ---------------------------------------------------------------------------
// §14.5 door lockout.
// ---------------------------------------------------------------------------

describe('applyVentilation — §14.5 door lockout', () => {
  it('door + open + maxPosition=60 → cap at 0.60 even when heat protection wanted 1.0', () => {
    const r = applyVentilation(
      mkInputs({
        window: {
          isDoor: true,
          canMoveWhenOpen: true,
          maxPositionWhenOpenPct: 60,
          lockoutProtection: true,
          type: 'facade',
        },
        contactState: 'open',
        roomTempC: 24,
        outdoorTempC: 29, // §14.4 → wants 0.90
        sunOnWindowNow: true,
        baseTarget01: 1.0,
      }),
    );
    expect(r.target01).toBe(0.6);
    expect(r.appliedRules).toContain('§14.5 door-lockout');
  });

  it('door + closed → no door-lockout rule fires (§14 inactive)', () => {
    const r = applyVentilation(
      mkInputs({
        window: {
          isDoor: true,
          canMoveWhenOpen: true,
          maxPositionWhenOpenPct: 60,
          lockoutProtection: true,
          type: 'facade',
        },
        contactState: 'closed',
        baseTarget01: 1.0,
      }),
    );
    expect(r.appliedRules).not.toContain('§14.5 door-lockout');
    expect(r.target01).toBe(1.0);
  });

  it('lockoutProtection=true on a non-door window also caps the target', () => {
    const r = applyVentilation(
      mkInputs({
        window: {
          isDoor: false,
          canMoveWhenOpen: true,
          maxPositionWhenOpenPct: 60,
          lockoutProtection: true,
          type: 'facade',
        },
        contactState: 'open',
        roomTempC: 24,
        outdoorTempC: 29,
        sunOnWindowNow: true,
        baseTarget01: 1.0,
      }),
    );
    expect(r.target01).toBe(0.6);
    expect(r.appliedRules).toContain('§14.5 lockout-protection');
  });
});

// ---------------------------------------------------------------------------
// §14.6 canMoveWhenOpen.
// ---------------------------------------------------------------------------

describe('applyVentilation — §14.6 cannot move when open', () => {
  it('canMoveWhenOpen=false + open → blockedByOpenWindow=true', () => {
    const r = applyVentilation(
      mkInputs({
        window: {
          isDoor: false,
          canMoveWhenOpen: false,
          maxPositionWhenOpenPct: 60,
          lockoutProtection: true,
          type: 'facade',
        },
        contactState: 'open',
        roomTempC: 22,
        outdoorTempC: 22,
        baseTarget01: 0.4,
      }),
    );
    expect(r.blockedByOpenWindow).toBe(true);
    expect(r.appliedRules).toContain('§14.6 cannot-move-when-open');
  });

  it('canMoveWhenOpen=false + closed → not blocked (§14 inactive)', () => {
    const r = applyVentilation(
      mkInputs({
        window: {
          isDoor: false,
          canMoveWhenOpen: false,
          maxPositionWhenOpenPct: 60,
          lockoutProtection: true,
          type: 'facade',
        },
        contactState: 'closed',
        baseTarget01: 0.4,
      }),
    );
    expect(r.blockedByOpenWindow).toBe(false);
    expect(r.appliedRules).toEqual([]);
  });

  it('canMoveWhenOpen=true + open → not blocked', () => {
    const r = applyVentilation(
      mkInputs({
        window: {
          isDoor: false,
          canMoveWhenOpen: true,
          maxPositionWhenOpenPct: 60,
          lockoutProtection: true,
          type: 'facade',
        },
        contactState: 'open',
        roomTempC: 22,
        outdoorTempC: 22,
        baseTarget01: 0.4,
      }),
    );
    expect(r.blockedByOpenWindow).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Partial / missing temperatures.
// ---------------------------------------------------------------------------

describe('applyVentilation — partial temps', () => {
  it('both temps null → no temp branch fires', () => {
    const r = applyVentilation(
      mkInputs({
        window: {
          isDoor: false,
          canMoveWhenOpen: true,
          maxPositionWhenOpenPct: 100,
          lockoutProtection: false,
          type: 'facade',
        },
        contactState: 'open',
        roomTempC: null,
        outdoorTempC: null,
        baseTarget01: 0.4,
      }),
    );
    expect(r.target01).toBe(0.4);
    expect(r.appliedRules).toEqual([]);
  });

  it('only roomTempC available → defaults to §14.3', () => {
    const r = applyVentilation(
      mkInputs({
        window: {
          isDoor: false,
          canMoveWhenOpen: true,
          maxPositionWhenOpenPct: 100,
          lockoutProtection: false,
          type: 'facade',
        },
        contactState: 'open',
        roomTempC: 25, // ≥ 24.5
        outdoorTempC: null,
        sunOnWindowNow: true,
        baseTarget01: 0.1,
      }),
    );
    expect(r.appliedRules).toContain('§14.3 similar-temps');
    expect(r.target01).toBe(0.9);
  });

  it('only outdoorTempC available → defaults to §14.3', () => {
    const r = applyVentilation(
      mkInputs({
        window: {
          isDoor: false,
          canMoveWhenOpen: true,
          maxPositionWhenOpenPct: 100,
          lockoutProtection: false,
          type: 'facade',
        },
        contactState: 'open',
        roomTempC: null,
        outdoorTempC: 22,
        sunOnWindowNow: false,
        baseTarget01: 0.1,
      }),
    );
    expect(r.appliedRules).toContain('§14.3 similar-temps');
    expect(r.target01).toBe(0.4);
  });
});

// ---------------------------------------------------------------------------
// Combined / safety-priority scenarios.
// ---------------------------------------------------------------------------

describe('applyVentilation — combined', () => {
  it('door + roof + sun + outside warmer → target capped by §14.5 lockout', () => {
    const r = applyVentilation(
      mkInputs({
        window: {
          isDoor: true,
          canMoveWhenOpen: true,
          maxPositionWhenOpenPct: 50,
          lockoutProtection: true,
          type: 'roof_window',
        },
        contactState: 'open',
        roomTempC: 24,
        outdoorTempC: 30, // §14.4 + roof + sun ⇒ 0.95
        sunOnWindowNow: true,
        baseTarget01: 1.0,
      }),
    );
    expect(r.target01).toBe(0.5);
    expect(r.appliedRules).toContain('§14.4 outside-warmer');
    expect(r.appliedRules).toContain('§14.5 door-lockout');
  });

  it('target01 always in [0, 1] — defensive clamp on extreme inputs', () => {
    // Hostile baseTarget outside the unit interval should still be clamped.
    const r = applyVentilation(
      mkInputs({
        window: {
          isDoor: false,
          canMoveWhenOpen: true,
          maxPositionWhenOpenPct: 100,
          lockoutProtection: false,
          type: 'facade',
        },
        contactState: 'open',
        roomTempC: 22,
        outdoorTempC: 22,
        baseTarget01: 5,
      }),
    );
    expect(r.target01).toBeLessThanOrEqual(1);
    expect(r.target01).toBeGreaterThanOrEqual(0);
  });

  it('exposes constants as module exports', () => {
    expect(HIGH_PV_KW).toBe(3.0);
    expect(COOL_DELTA_C).toBe(1.5);
    expect(WARM_DELTA_C).toBe(-0.5);
    expect(HIGH_ROOM_TEMP_C).toBe(24.5);
  });
});

// ---------------------------------------------------------------------------
// isVentingLockout (smart-shading Task 6 / Requirement 7).
// ---------------------------------------------------------------------------

describe('isVentingLockout', () => {
  it('engages when the sash is fully open (non-storm modes)', () => {
    expect(isVentingLockout('open', 'ACTIVE_HEAT_PROTECTION')).toBe(true);
    expect(isVentingLockout('open', 'NORMAL')).toBe(true);
    expect(isVentingLockout('open', 'NIGHT_COOLING')).toBe(true);
  });

  it('does not engage for closed, tilted, or unknown contacts', () => {
    expect(isVentingLockout('closed', 'ACTIVE_HEAT_PROTECTION')).toBe(false);
    expect(isVentingLockout('tilted', 'ACTIVE_HEAT_PROTECTION')).toBe(false);
    expect(isVentingLockout('unknown', 'ACTIVE_HEAT_PROTECTION')).toBe(false);
  });

  it('is bypassed during STORM so safety force-open is never blocked', () => {
    expect(isVentingLockout('open', 'STORM')).toBe(false);
  });
});
