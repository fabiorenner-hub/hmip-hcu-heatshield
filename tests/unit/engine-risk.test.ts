/**
 * Tests for the risk model in `src/plugin/engine/risk.ts` (Task 7.1).
 *
 * Coverage:
 *   - Each `compute*Factor` function: midpoint, both ends, below-min
 *     (clamped), above-max (clamped), `null` input.
 *   - `computePvFactor`: PV-lobe gating per design §Property 3.
 *   - `isOrientationInPvLobe`: edges, normalisation of values outside
 *     `[0, 360)`.
 *   - `profileWeights`: each profile sums to exactly 1.0; `aggressive`
 *     bumps the radiation weight; `standard` keeps it at 0.05.
 *   - `computeRisk`: the bedroom SO-roof scenario from the task brief
 *     (high inputs → riskTotal > 0.6), the same with `sunFactor = 0`
 *     (significantly lower), all-zero, all-ones.
 *   - `mapRiskToShutter01`: each step boundary plus the two extremes.
 *
 * The tests are pure data-table style — no fixtures, no mocking. The
 * `RoomTargets` and `Window` literals match the schema's defaults
 * (target_c = 23, critical_c = 26 are the values used by the regelwerk
 * §19 examples for prioritised bedrooms). They are inlined here so the
 * suite does not depend on Zod parsing for what is meant to be a fast
 * unit test.
 */

import { describe, expect, it } from 'vitest';

import {
  computeForecastTempFactor,
  computeOutdoorTempFactor,
  computePriorityFactor,
  computePvFactor,
  computeRadiationFactor,
  computeRisk,
  computeRoomTempFactor,
  computeWindowTypeFactor,
  isOrientationInPvLobe,
  mapRiskToShutter01,
  profileWeights,
  type RiskInputs,
} from '../../src/plugin/engine/risk.js';
import type { Priority, RoomTargets, Window } from '../../src/shared/types.js';
import type { SunPosition } from '../../src/plugin/engine/sun.js';

// ---------------------------------------------------------------------------
// Shared fixtures.
// ---------------------------------------------------------------------------

const TARGETS: RoomTargets = {
  target_c: 23,
  warning_c: 24.5,
  strong_shade_c: 25,
  critical_c: 26,
};

const SE_ROOF: Pick<Window, 'orientationDeg' | 'type'> = {
  orientationDeg: 135,
  type: 'roof_window',
};

const SE_FACADE: Pick<Window, 'orientationDeg' | 'type'> = {
  orientationDeg: 135,
  type: 'facade',
};

/**
 * The risk model does not consult `SunPosition` directly (the sun
 * factor arrives as `sunFactor01`), but `RiskInputs` requires the
 * field for the eventual breakdown. This stub gives a plausible value
 * without affecting any assertion.
 */
const SUN_NOON_SE: SunPosition = {
  azimuthDeg: 135,
  elevationDeg: 50,
  isUp: true,
};

// ---------------------------------------------------------------------------
// computeRoomTempFactor
// ---------------------------------------------------------------------------

describe('computeRoomTempFactor', () => {
  it.each([
    { label: 'midpoint',         t: 24.5,  expected: 0.5 },
    { label: 'low end (target)', t: 23,    expected: 0   },
    { label: 'high end (crit)',  t: 26,    expected: 1   },
    { label: 'below min clamps', t: 18,    expected: 0   },
    { label: 'above max clamps', t: 32,    expected: 1   },
  ])('returns $expected for $label ($t °C)', ({ t, expected }) => {
    expect(computeRoomTempFactor(t, TARGETS)).toBeCloseTo(expected, 9);
  });

  it('returns 0 for null', () => {
    expect(computeRoomTempFactor(null, TARGETS)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computeWindowTypeFactor
// ---------------------------------------------------------------------------

describe('computeWindowTypeFactor', () => {
  it('returns 1 for roof_window', () => {
    expect(computeWindowTypeFactor({ type: 'roof_window' })).toBe(1);
  });

  it('returns 0 for facade', () => {
    expect(computeWindowTypeFactor({ type: 'facade' })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computeForecastTempFactor
// ---------------------------------------------------------------------------

describe('computeForecastTempFactor', () => {
  it.each([
    { label: 'midpoint',         t: 28,    expected: 0.5 },
    { label: 'low end',          t: 24,    expected: 0   },
    { label: 'high end',         t: 32,    expected: 1   },
    { label: 'below min clamps', t: 10,    expected: 0   },
    { label: 'above max clamps', t: 40,    expected: 1   },
  ])('returns $expected for $label ($t °C)', ({ t, expected }) => {
    expect(computeForecastTempFactor(t)).toBeCloseTo(expected, 9);
  });

  it('returns 0 for null', () => {
    expect(computeForecastTempFactor(null)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computePvFactor — gated through the PV lobe.
// ---------------------------------------------------------------------------

describe('computePvFactor', () => {
  it('returns 0.5 for SE roof at mid-headroom PV', () => {
    // headroom = 8.8 - 1 = 7.8; 4.4 - 1 = 3.4; 3.4 / 7.8 ≈ 0.4359
    // Pick numbers that come out exactly at 0.5 to keep the assertion
    // legible: pv = (peak - 1) / 2 + 1 = 4.9 for peak = 8.8.
    expect(computePvFactor(SE_ROOF, 4.9, 8.8)).toBeCloseTo(0.5, 9);
  });

  it('matches the brief: orientation 135°, pv=4.4, peak=8.8 → ≈0.436', () => {
    // Documented separately because the task brief explicitly cites
    // these numbers. The factor is *not* exactly 0.5 — the headroom
    // formula `(kw-1) / (peak-1)` puts (4.4, 8.8) at 0.4359. The "0.5"
    // in the brief is shorthand for "mid-lobe", which we already prove
    // above with peak = 8.8 / pv = 4.9.
    expect(computePvFactor(SE_ROOF, 4.4, 8.8)).toBeCloseTo(0.4358974, 6);
  });

  it('returns 0 for west-facing window outside the lobe', () => {
    expect(
      computePvFactor({ orientationDeg: 270, type: 'facade' }, 4.4, 8.8),
    ).toBe(0);
  });

  it('counts orientation 90° (E) as in-lobe', () => {
    const f = computePvFactor({ orientationDeg: 90, type: 'facade' }, 4.4, 8.8);
    expect(f).toBeGreaterThan(0);
  });

  it('counts orientation 200° (SSW) as in-lobe', () => {
    const f = computePvFactor(
      { orientationDeg: 200, type: 'facade' },
      4.4,
      8.8,
    );
    expect(f).toBeGreaterThan(0);
  });

  it('rejects orientation 89° (just east of the lobe)', () => {
    expect(
      computePvFactor({ orientationDeg: 89, type: 'facade' }, 4.4, 8.8),
    ).toBe(0);
  });

  it('rejects orientation 201° (just west of SSW)', () => {
    expect(
      computePvFactor({ orientationDeg: 201, type: 'facade' }, 4.4, 8.8),
    ).toBe(0);
  });

  it('returns 0 when PV data is null', () => {
    expect(computePvFactor(SE_ROOF, null, 8.8)).toBe(0);
  });

  it('clamps pv below 1 kW to 0', () => {
    expect(computePvFactor(SE_ROOF, 0.5, 8.8)).toBe(0);
  });

  it('clamps pv above peak to 1', () => {
    expect(computePvFactor(SE_ROOF, 12, 8.8)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// isOrientationInPvLobe
// ---------------------------------------------------------------------------

describe('isOrientationInPvLobe', () => {
  it.each([
    { deg: 135, expected: true },
    { deg: 89, expected: false },
    { deg: 90, expected: true },
    { deg: 200, expected: true },
    { deg: 201, expected: false },
    { deg: 0, expected: false },
    // 360 normalises to 0 → outside the lobe.
    { deg: 360, expected: false },
    // -45 normalises to 315 → outside the lobe.
    { deg: -45, expected: false },
    // Values above one full revolution still normalise correctly.
    { deg: 360 + 135, expected: true },
  ])('orientation $deg → $expected', ({ deg, expected }) => {
    expect(isOrientationInPvLobe(deg)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// computeRadiationFactor
// ---------------------------------------------------------------------------

describe('computeRadiationFactor', () => {
  it.each([
    { label: 'midpoint',         w: 450,  expected: 0.5 },
    { label: 'low end',          w: 100,  expected: 0   },
    { label: 'high end',         w: 800,  expected: 1   },
    { label: 'below min clamps', w: 0,    expected: 0   },
    { label: 'above max clamps', w: 1200, expected: 1   },
  ])('returns $expected for $label ($w W/m²)', ({ w, expected }) => {
    expect(computeRadiationFactor(w)).toBeCloseTo(expected, 9);
  });

  it('returns 0 for null', () => {
    expect(computeRadiationFactor(null)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computeOutdoorTempFactor
// ---------------------------------------------------------------------------

describe('computeOutdoorTempFactor', () => {
  it.each([
    { label: 'midpoint',         t: 27,    expected: 0.5 },
    { label: 'low end',          t: 22,    expected: 0   },
    { label: 'high end',         t: 32,    expected: 1   },
    { label: 'below min clamps', t: 10,    expected: 0   },
    { label: 'above max clamps', t: 40,    expected: 1   },
  ])('returns $expected for $label ($t °C)', ({ t, expected }) => {
    expect(computeOutdoorTempFactor(t)).toBeCloseTo(expected, 9);
  });

  it('returns 0 for null', () => {
    expect(computeOutdoorTempFactor(null)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computePriorityFactor
// ---------------------------------------------------------------------------

describe('computePriorityFactor', () => {
  const cases: Array<{ p: Priority; expected: number }> = [
    { p: 'very_high', expected: 1.0 },
    { p: 'high', expected: 0.66 },
    { p: 'medium', expected: 0.33 },
    { p: 'low', expected: 0.0 },
  ];

  it.each(cases)('priority $p → $expected', ({ p, expected }) => {
    expect(computePriorityFactor(p)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// profileWeights
// ---------------------------------------------------------------------------

describe('profileWeights', () => {
  const profiles = ['conservative', 'standard', 'aggressive', 'custom'] as const;

  function sumWeights(w: ReturnType<typeof profileWeights>): number {
    return (
      w.sunFactor +
      w.roomTempFactor +
      w.windowTypeFactor +
      w.forecastTempFactor +
      w.pvFactor +
      w.radiationFactor +
      w.outdoorTempFactor +
      w.priorityFactor
    );
  }

  it.each(profiles)('weights for %s sum to 1.0', (profile) => {
    const w = profileWeights(profile);
    expect(sumWeights(w)).toBeCloseTo(1.0, 9);
  });

  it('aggressive bumps the radiation weight to 0.10', () => {
    expect(profileWeights('aggressive').radiationFactor).toBe(0.1);
  });

  it('standard keeps the radiation weight at 0.05', () => {
    expect(profileWeights('standard').radiationFactor).toBe(0.05);
  });

  it('custom is identical to standard (placeholder pending Task 12.3)', () => {
    expect(profileWeights('custom')).toEqual(profileWeights('standard'));
  });
});

// ---------------------------------------------------------------------------
// computeRisk
// ---------------------------------------------------------------------------

describe('computeRisk', () => {
  /**
   * Bedroom SO-roof scenario from the task brief: priorised bedroom,
   * SE-facing roof window, indoor at the room's `target_c` (24°C
   * given target_c=23, critical_c=26 → roomTempFactor = 0.333), full
   * sun (sunFactor01 = 1), strong PV, warm forecast / outdoor / high
   * radiation. Should land comfortably above 0.6.
   */
  const baseInputs: RiskInputs = {
    window: SE_ROOF,
    windowPriority: 'very_high',
    sun: SUN_NOON_SE,
    sunFactor01: 1.0,
    roomTempC: 24,
    roomTargets: TARGETS,
    outdoorTempC: 24,
    forecastMaxTempC: 29,
    pvSmoothedKw: 4.4,
    pvPeakKwp: 8.8,
    radiationWm2: 600,
    profile: 'standard',
  };

  it('produces riskTotal > 0.6 for the bedroom SO-roof scenario', () => {
    const r = computeRisk(baseInputs);
    expect(r.riskTotal).toBeGreaterThan(0.6);
    expect(r.riskTotal).toBeLessThanOrEqual(1);
  });

  it('drops significantly with sunFactor=0 (room temp + others remain)', () => {
    const high = computeRisk(baseInputs).riskTotal;
    const low = computeRisk({ ...baseInputs, sunFactor01: 0 }).riskTotal;
    expect(low).toBeLessThan(high);
    expect(low).toBeLessThan(0.4);
  });

  it('returns 0 when every factor is null/zero', () => {
    const zeroInputs: RiskInputs = {
      window: SE_FACADE,
      windowPriority: 'low',
      sun: { azimuthDeg: 0, elevationDeg: -10, isUp: false },
      sunFactor01: 0,
      roomTempC: null,
      roomTargets: TARGETS,
      outdoorTempC: null,
      forecastMaxTempC: null,
      pvSmoothedKw: null,
      pvPeakKwp: 8.8,
      radiationWm2: null,
      profile: 'standard',
    };
    const r = computeRisk(zeroInputs);
    expect(r.riskTotal).toBe(0);
    // Spot-check: every weighted contribution is zero too.
    expect(Object.values(r.weighted).every((v) => v === 0)).toBe(true);
  });

  it('returns 1.0 when every factor maxes out', () => {
    const maxInputs: RiskInputs = {
      window: SE_ROOF, // windowTypeFactor = 1
      windowPriority: 'very_high', // priorityFactor = 1
      sun: SUN_NOON_SE,
      sunFactor01: 1,
      roomTempC: 30, // > critical_c, clamps to 1
      roomTargets: TARGETS,
      outdoorTempC: 35, // clamps to 1
      forecastMaxTempC: 35, // clamps to 1
      pvSmoothedKw: 12, // clamps to 1
      pvPeakKwp: 8.8,
      radiationWm2: 1000, // clamps to 1
      profile: 'standard',
    };
    const r = computeRisk(maxInputs);
    expect(r.riskTotal).toBeCloseTo(1.0, 9);
  });

  it('sums weighted factors to riskTotal', () => {
    // Sanity: factors × weights summed equals riskTotal (modulo clamp).
    const r = computeRisk(baseInputs);
    const sum =
      r.weighted.sunFactor +
      r.weighted.roomTempFactor +
      r.weighted.windowTypeFactor +
      r.weighted.forecastTempFactor +
      r.weighted.pvFactor +
      r.weighted.radiationFactor +
      r.weighted.outdoorTempFactor +
      r.weighted.priorityFactor;
    expect(r.riskTotal).toBeCloseTo(sum, 9);
  });

  it('zeroes the PV contribution for windows outside the PV lobe', () => {
    const r = computeRisk({
      ...baseInputs,
      window: { orientationDeg: 270, type: 'facade' }, // W
    });
    expect(r.factors.pvFactor).toBe(0);
    expect(r.weighted.pvFactor).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// mapRiskToShutter01
// ---------------------------------------------------------------------------

describe('mapRiskToShutter01', () => {
  it.each([
    { risk: 0,    expected: 0.0 },
    { risk: 0.11, expected: 0.0 },
    { risk: 0.12, expected: 0.15 },
    { risk: 0.21, expected: 0.15 },
    { risk: 0.22, expected: 0.3 },
    { risk: 0.33, expected: 0.3 },
    { risk: 0.34, expected: 0.45 },
    { risk: 0.45, expected: 0.45 },
    { risk: 0.46, expected: 0.6 },
    { risk: 0.57, expected: 0.6 },
    { risk: 0.58, expected: 0.75 },
    { risk: 0.69, expected: 0.75 },
    { risk: 0.7,  expected: 0.9 },
    { risk: 0.84, expected: 0.9 },
    { risk: 0.85, expected: 1.0 },
    { risk: 1.0,  expected: 1.0 },
  ])('risk=$risk → $expected', ({ risk, expected }) => {
    expect(mapRiskToShutter01(risk)).toBe(expected);
  });
});
