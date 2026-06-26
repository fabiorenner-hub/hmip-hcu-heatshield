/**
 * Tests for the special-rules engine in `src/plugin/engine/specialRules.ts`
 * (Task 7.3, Regelwerk §13).
 *
 * Coverage:
 *   - `isBedroomLike` / `isOfficeLike` heuristics: positive English
 *     and German hits, negative cases, case-insensitivity.
 *   - `isSouthEastFacing`: edges of the `[105°, 165°]` band, plus
 *     out-of-band probes.
 *   - §13.1 Schlafzimmer-Dachfenster: each rule (a–d), plus negative
 *     cases that prove the section does not fire for non-roof windows
 *     or non-bedroom rooms.
 *   - §13.2 Arbeitszimmer-Dachfenster: mirror of §13.1 with office
 *     thresholds (warm 23.5 / warning 24.0).
 *   - §13.3 Hitzewellenmodus: forecast trigger, mode trigger, SE-band
 *     gate, room-priority gate, roof vs facade target.
 *   - Combined: bedroom + SE roof + warm + heatwave produces multiple
 *     rules and target = 1.0.
 *   - Base preservation: no triggers ⇒ target unchanged, rules empty.
 *
 * Style mirrors `engine-modes.test.ts`: no fixtures, no mocking.
 * Inputs are constructed inline via a small `mkInputs` helper so each
 * test reads as a single self-contained scenario.
 */

import { describe, expect, it } from 'vitest';

import {
  ROOF_FORCE_CLOSE_KW,
  applySpecialRules,
  isBedroomLike,
  isOfficeLike,
  isSouthEastFacing,
  type SpecialRulesInputs,
} from '../../src/plugin/engine/specialRules.js';
import type { Mode } from '../../src/shared/types.js';

// ---------------------------------------------------------------------------
// mkInputs — benign defaults that no §13 rule fires on.
// ---------------------------------------------------------------------------

function mkInputs(overrides: Partial<SpecialRulesInputs> = {}): SpecialRulesInputs {
  return {
    window: { orientationDeg: 0, type: 'facade' }, // North, facade ⇒ no §13.1/2
    roomId: 'living-room',
    priority: 'medium',
    roomTempC: null,
    pvSmoothedKw: null,
    pvPeakKwp: 8.8,
    sunOnWindowNow: false,
    sunOnWindowSoon: false,
    forecastMaxTempC: null,
    mode: 'NORMAL' as Mode,
    baseTarget01: 0.4,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isBedroomLike
// ---------------------------------------------------------------------------

describe('isBedroomLike', () => {
  it.each([
    { id: 'bedroom', expected: true },
    { id: 'schlafzimmer', expected: true },
    { id: 'master-bedroom', expected: true },
    { id: 'BEDROOM-MAIN', expected: true },
    { id: 'Schlafzimmer-Eltern', expected: true },
    { id: 'living-room', expected: false },
    { id: 'kitchen', expected: false },
    { id: '', expected: false },
  ])('isBedroomLike($id) → $expected', ({ id, expected }) => {
    expect(isBedroomLike(id)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// isOfficeLike
// ---------------------------------------------------------------------------

describe('isOfficeLike', () => {
  it.each([
    { id: 'office', expected: true },
    { id: 'arbeitszimmer', expected: true },
    { id: 'home-office', expected: true },
    { id: 'OFFICE-2F', expected: true },
    { id: 'Arbeitszimmer', expected: true },
    { id: 'guest', expected: false },
    { id: 'living-room', expected: false },
  ])('isOfficeLike($id) → $expected', ({ id, expected }) => {
    expect(isOfficeLike(id)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// isSouthEastFacing
// ---------------------------------------------------------------------------

describe('isSouthEastFacing', () => {
  it.each([
    { deg: 135, expected: true },
    { deg: 105, expected: true },
    { deg: 165, expected: true },
    { deg: 104, expected: false },
    { deg: 166, expected: false },
    { deg: 0, expected: false },
    { deg: 180, expected: false },
    { deg: 270, expected: false },
  ])('isSouthEastFacing($deg) → $expected', ({ deg, expected }) => {
    expect(isSouthEastFacing(deg)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// §13.1 Schlafzimmer-Dachfenster
// ---------------------------------------------------------------------------

describe('applySpecialRules — §13.1 bedroom roof', () => {
  it('§13.1.a fires on prelook + ACTIVE_HEAT_PROTECTION', () => {
    const r = applySpecialRules(
      mkInputs({
        window: { orientationDeg: 135, type: 'roof_window' },
        roomId: 'bedroom',
        priority: 'very_high',
        sunOnWindowSoon: true,
        mode: 'ACTIVE_HEAT_PROTECTION',
        baseTarget01: 0.4,
      }),
    );
    expect(r.target01).toBeGreaterThanOrEqual(0.8);
    expect(r.target01).toBe(0.8);
    expect(r.appliedRules).toContain('§13.1.a bedroom-roof-prelook');
  });

  it('§13.1.a does not fire when heat mode is inactive', () => {
    const r = applySpecialRules(
      mkInputs({
        window: { orientationDeg: 135, type: 'roof_window' },
        roomId: 'bedroom',
        sunOnWindowSoon: true,
        mode: 'NORMAL',
        baseTarget01: 0.4,
      }),
    );
    expect(r.appliedRules).toEqual([]);
    expect(r.target01).toBe(0.4);
  });

  it('§13.1.b fires at 23.0 °C with sun on window (max 0.9)', () => {
    const r = applySpecialRules(
      mkInputs({
        window: { orientationDeg: 135, type: 'roof_window' },
        roomId: 'bedroom',
        sunOnWindowNow: true,
        roomTempC: 23.0,
        baseTarget01: 0.4,
      }),
    );
    expect(r.target01).toBe(0.9);
    expect(r.appliedRules).toContain('§13.1.b bedroom-roof-warm-sun');
  });

  it('§13.1.c forces close at 23.5 °C with sun (overrides §13.1.a/b)', () => {
    const r = applySpecialRules(
      mkInputs({
        window: { orientationDeg: 135, type: 'roof_window' },
        roomId: 'bedroom',
        sunOnWindowNow: true,
        sunOnWindowSoon: true,
        mode: 'HEATWAVE',
        roomTempC: 23.5,
        baseTarget01: 0.4,
      }),
    );
    expect(r.target01).toBe(1.0);
    expect(r.appliedRules).toContain('§13.1.c bedroom-roof-warning-sun');
  });

  it('§13.1.d forces close on PV > 4.0 kW with sun on window', () => {
    const r = applySpecialRules(
      mkInputs({
        window: { orientationDeg: 135, type: 'roof_window' },
        roomId: 'bedroom',
        sunOnWindowNow: true,
        pvSmoothedKw: 4.5,
        baseTarget01: 0.4,
      }),
    );
    expect(r.target01).toBe(1.0);
    expect(r.appliedRules).toContain('§13.1.d bedroom-roof-pv-force');
  });

  it('§13.1.d does not fire at exactly 4.0 kW (strict greater-than)', () => {
    const r = applySpecialRules(
      mkInputs({
        window: { orientationDeg: 135, type: 'roof_window' },
        roomId: 'bedroom',
        sunOnWindowNow: true,
        pvSmoothedKw: ROOF_FORCE_CLOSE_KW,
        baseTarget01: 0.4,
      }),
    );
    expect(r.appliedRules).not.toContain('§13.1.d bedroom-roof-pv-force');
  });

  it('does not fire for bedroom + facade (not roof)', () => {
    const r = applySpecialRules(
      mkInputs({
        window: { orientationDeg: 135, type: 'facade' },
        roomId: 'bedroom',
        sunOnWindowNow: true,
        roomTempC: 25,
        pvSmoothedKw: 6,
        mode: 'HEATWAVE',
        forecastMaxTempC: null,
        baseTarget01: 0.4,
      }),
    );
    expect(r.appliedRules.some((s) => s.startsWith('§13.1'))).toBe(false);
  });

  it('does not fire for non-bedroom + roof', () => {
    const r = applySpecialRules(
      mkInputs({
        window: { orientationDeg: 135, type: 'roof_window' },
        roomId: 'living-room',
        sunOnWindowNow: true,
        roomTempC: 25,
        pvSmoothedKw: 6,
        baseTarget01: 0.4,
      }),
    );
    expect(r.appliedRules.some((s) => s.startsWith('§13.1'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §13.2 Arbeitszimmer-Dachfenster (mirror).
// ---------------------------------------------------------------------------

describe('applySpecialRules — §13.2 office roof', () => {
  it('§13.2.a fires on prelook + heat mode active', () => {
    // Use ACTIVE_HEAT_PROTECTION (heat_mode_active but not HEATWAVE) so
    // §13.3 stays out of this scenario and §13.2.a is observed in isolation.
    const r = applySpecialRules(
      mkInputs({
        window: { orientationDeg: 135, type: 'roof_window' },
        roomId: 'office',
        sunOnWindowSoon: true,
        mode: 'ACTIVE_HEAT_PROTECTION',
        baseTarget01: 0.4,
      }),
    );
    expect(r.target01).toBe(0.8);
    expect(r.appliedRules).toContain('§13.2.a office-roof-prelook');
  });

  it('§13.2.b fires at 23.5 °C with sun on window (max 0.9)', () => {
    const r = applySpecialRules(
      mkInputs({
        window: { orientationDeg: 135, type: 'roof_window' },
        roomId: 'arbeitszimmer',
        sunOnWindowNow: true,
        roomTempC: 23.5,
        baseTarget01: 0.4,
      }),
    );
    expect(r.target01).toBe(0.9);
    expect(r.appliedRules).toContain('§13.2.b office-roof-warm-sun');
  });

  it('§13.2.b does not fire at 23.0 °C (office threshold is 23.5)', () => {
    const r = applySpecialRules(
      mkInputs({
        window: { orientationDeg: 135, type: 'roof_window' },
        roomId: 'office',
        sunOnWindowNow: true,
        roomTempC: 23.0,
        baseTarget01: 0.4,
      }),
    );
    expect(r.appliedRules).not.toContain('§13.2.b office-roof-warm-sun');
  });

  it('§13.2.c forces close at 24.0 °C with sun on window', () => {
    const r = applySpecialRules(
      mkInputs({
        window: { orientationDeg: 135, type: 'roof_window' },
        roomId: 'office',
        sunOnWindowNow: true,
        roomTempC: 24.0,
        baseTarget01: 0.4,
      }),
    );
    expect(r.target01).toBe(1.0);
    expect(r.appliedRules).toContain('§13.2.c office-roof-warning-sun');
  });

  it('§13.2.d forces close on PV > 4.0 kW with sun on window', () => {
    const r = applySpecialRules(
      mkInputs({
        window: { orientationDeg: 135, type: 'roof_window' },
        roomId: 'office',
        sunOnWindowNow: true,
        pvSmoothedKw: 4.5,
        baseTarget01: 0.4,
      }),
    );
    expect(r.target01).toBe(1.0);
    expect(r.appliedRules).toContain('§13.2.d office-roof-pv-force');
  });

  it('does not fire for office + facade', () => {
    const r = applySpecialRules(
      mkInputs({
        window: { orientationDeg: 135, type: 'facade' },
        roomId: 'office',
        sunOnWindowNow: true,
        roomTempC: 25,
        baseTarget01: 0.4,
      }),
    );
    expect(r.appliedRules.some((s) => s.startsWith('§13.2'))).toBe(false);
  });

  it('does not fire for non-office + roof', () => {
    const r = applySpecialRules(
      mkInputs({
        window: { orientationDeg: 135, type: 'roof_window' },
        roomId: 'kitchen',
        sunOnWindowNow: true,
        roomTempC: 25,
        baseTarget01: 0.4,
      }),
    );
    expect(r.appliedRules.some((s) => s.startsWith('§13.2'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §13.3 Hitzewellenmodus
// ---------------------------------------------------------------------------

describe('applySpecialRules — §13.3 heatwave SE band', () => {
  it('bedroom + SE roof + forecast=30 → target = 1.0 via §13.3.a', () => {
    const r = applySpecialRules(
      mkInputs({
        window: { orientationDeg: 135, type: 'roof_window' },
        roomId: 'bedroom',
        forecastMaxTempC: 30,
        baseTarget01: 0.4,
      }),
    );
    expect(r.target01).toBe(1.0);
    expect(r.appliedRules).toContain('§13.3.a heatwave-se-roof');
  });

  it('office + SE facade + forecast=30 → target ≥ 0.9 via §13.3.b', () => {
    const r = applySpecialRules(
      mkInputs({
        window: { orientationDeg: 135, type: 'facade' },
        roomId: 'office',
        forecastMaxTempC: 30,
        baseTarget01: 0.4,
      }),
    );
    expect(r.target01).toBe(0.9);
    expect(r.appliedRules).toContain('§13.3.b heatwave-se-facade');
  });

  it('bedroom + SE roof + mode=HEATWAVE (forecast missing) → §13.3.a fires', () => {
    const r = applySpecialRules(
      mkInputs({
        window: { orientationDeg: 135, type: 'roof_window' },
        roomId: 'bedroom',
        mode: 'HEATWAVE',
        forecastMaxTempC: null,
        baseTarget01: 0.4,
      }),
    );
    expect(r.target01).toBe(1.0);
    expect(r.appliedRules).toContain('§13.3.a heatwave-se-roof');
  });

  it('bedroom + N facade + forecast=30 → §13.3 does not fire', () => {
    const r = applySpecialRules(
      mkInputs({
        window: { orientationDeg: 0, type: 'facade' },
        roomId: 'bedroom',
        forecastMaxTempC: 30,
        baseTarget01: 0.4,
      }),
    );
    expect(r.appliedRules.some((s) => s.startsWith('§13.3'))).toBe(false);
    expect(r.target01).toBe(0.4);
  });

  it('guest_room + SE roof + forecast=30 → §13.3 does not fire', () => {
    const r = applySpecialRules(
      mkInputs({
        window: { orientationDeg: 135, type: 'roof_window' },
        roomId: 'guest_room',
        forecastMaxTempC: 30,
        baseTarget01: 0.4,
      }),
    );
    expect(r.appliedRules.some((s) => s.startsWith('§13.3'))).toBe(false);
    expect(r.target01).toBe(0.4);
  });

  it('forecast just below 30 °C and not HEATWAVE → §13.3 does not fire', () => {
    const r = applySpecialRules(
      mkInputs({
        window: { orientationDeg: 135, type: 'roof_window' },
        roomId: 'bedroom',
        forecastMaxTempC: 29.9,
        mode: 'ACTIVE_HEAT_PROTECTION',
        baseTarget01: 0.4,
      }),
    );
    expect(r.appliedRules.some((s) => s.startsWith('§13.3'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Combined scenarios.
// ---------------------------------------------------------------------------

describe('applySpecialRules — combined', () => {
  it('bedroom + roof + sun + roomTemp=24 + forecast=30 → 1.0 with multiple rules', () => {
    const r = applySpecialRules(
      mkInputs({
        window: { orientationDeg: 135, type: 'roof_window' },
        roomId: 'bedroom',
        sunOnWindowNow: true,
        sunOnWindowSoon: true,
        mode: 'HEATWAVE',
        roomTempC: 24,
        forecastMaxTempC: 30,
        baseTarget01: 0.4,
      }),
    );
    expect(r.target01).toBe(1.0);
    // §13.1.a, §13.1.b, §13.1.c, §13.3.a all fire in this scenario.
    expect(r.appliedRules).toContain('§13.1.a bedroom-roof-prelook');
    expect(r.appliedRules).toContain('§13.1.b bedroom-roof-warm-sun');
    expect(r.appliedRules).toContain('§13.1.c bedroom-roof-warning-sun');
    expect(r.appliedRules).toContain('§13.3.a heatwave-se-roof');
  });

  it('preserves baseTarget when no rule triggers', () => {
    const r = applySpecialRules(
      mkInputs({
        window: { orientationDeg: 135, type: 'facade' },
        roomId: 'bedroom',
        baseTarget01: 0.7,
      }),
    );
    expect(r.target01).toBe(0.7);
    expect(r.appliedRules).toEqual([]);
  });

  it('never lowers baseTarget when only "max" rules fire', () => {
    // baseTarget = 0.95; §13.1.a would max to 0.8 — must not decrease.
    const r = applySpecialRules(
      mkInputs({
        window: { orientationDeg: 135, type: 'roof_window' },
        roomId: 'bedroom',
        sunOnWindowSoon: true,
        mode: 'ACTIVE_HEAT_PROTECTION',
        baseTarget01: 0.95,
      }),
    );
    expect(r.target01).toBe(0.95);
    expect(r.appliedRules).toContain('§13.1.a bedroom-roof-prelook');
  });

  it('exposes ROOF_FORCE_CLOSE_KW = 4.0 as a module constant', () => {
    expect(ROOF_FORCE_CLOSE_KW).toBe(4.0);
  });
});
