/**
 * Tests for the PV-led feels-like heat-load model
 * (`src/plugin/engine/heatLoad.ts`, Tasks 2.1 / 2.2 / 2.3).
 *
 * Coverage:
 *   - Output always in [0, 1].
 *   - Higher PV raises the load at constant temperature (Requirement 2.2).
 *   - The same PV yields a higher load at warm air than at cool air
 *     (Requirement 1.2 — the feels-like interaction).
 *   - Missing PV with a solar fallback keeps shading active and flags
 *     `degraded` (Requirement 1.3 / 5.4).
 *   - Missing PV without a fallback renormalizes onto temp/trend.
 *   - `feelsLikeC` rises with PV and is null when air temp is null
 *     (Requirement 2.1 display).
 *   - Negative (cooling) trend does not add load.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_HEAT_LOAD_WEIGHTS,
  effectiveHeatLoad01,
} from '../../src/plugin/engine/heatLoad.js';
import type { HeatLoadInputs } from '../../src/plugin/engine/heatLoad.js';

function base(overrides: Partial<HeatLoadInputs> = {}): HeatLoadInputs {
  return {
    pvKw: 4,
    pvPeakKwp: 8.8,
    outdoorTempC: 25,
    outdoorTrendCph: 1,
    weights: DEFAULT_HEAT_LOAD_WEIGHTS,
    ...overrides,
  };
}

describe('effectiveHeatLoad01 — bounds', () => {
  it('clamps to [0, 1] at the extremes', () => {
    const hot = effectiveHeatLoad01(
      base({ pvKw: 100, outdoorTempC: 45, outdoorTrendCph: 10 }),
    );
    expect(hot.load01).toBeGreaterThanOrEqual(0);
    expect(hot.load01).toBeLessThanOrEqual(1);

    const cold = effectiveHeatLoad01(
      base({ pvKw: 0, outdoorTempC: 5, outdoorTrendCph: -5 }),
    );
    expect(cold.load01).toBeGreaterThanOrEqual(0);
    expect(cold.load01).toBeLessThanOrEqual(1);
  });
});

describe('effectiveHeatLoad01 — PV is the leading indicator', () => {
  it('higher PV raises load at constant temperature (Req 2.2)', () => {
    const lo = effectiveHeatLoad01(base({ pvKw: 1 })).load01;
    const hi = effectiveHeatLoad01(base({ pvKw: 7 })).load01;
    expect(hi).toBeGreaterThan(lo);
  });

  it('same PV feels hotter in warm air than cool air (Req 1.2)', () => {
    const warm = effectiveHeatLoad01(base({ outdoorTempC: 30 })).load01;
    const cool = effectiveHeatLoad01(base({ outdoorTempC: 18 })).load01;
    expect(warm).toBeGreaterThan(cool);
  });
});

describe('effectiveHeatLoad01 — fallback without PV (Req 1.3 / 5.4)', () => {
  it('uses the solar proxy and flags degraded when PV is null', () => {
    const r = effectiveHeatLoad01(
      base({ pvKw: null, fallbackSolar01: 0.8 }),
    );
    expect(r.degraded).toBe(true);
    expect(r.solar01).toBeCloseTo(0.8, 6);
    expect(r.load01).toBeGreaterThan(0);
  });

  it('renormalizes onto temp/trend when PV and fallback are both absent', () => {
    const r = effectiveHeatLoad01(
      base({ pvKw: null, fallbackSolar01: null }),
    );
    expect(r.degraded).toBe(true);
    expect(r.solar01).toBeNull();
    // temp=25 (~0.5 of 18..32) and trend=1/3 still produce a positive load.
    expect(r.load01).toBeGreaterThan(0);
    expect(r.load01).toBeLessThanOrEqual(1);
  });

  it('does not switch shading off entirely when only PV is missing', () => {
    const withPv = effectiveHeatLoad01(base()).load01;
    const noPv = effectiveHeatLoad01(
      base({ pvKw: null, fallbackSolar01: 0.6 }),
    ).load01;
    expect(noPv).toBeGreaterThan(0);
    // sanity: still a comparable order of magnitude, not collapsed to 0
    expect(noPv).toBeGreaterThan(withPv * 0.3);
  });
});

describe('effectiveHeatLoad01 — feels-like display (Req 2.1)', () => {
  it('feelsLikeC rises with PV at constant air temperature', () => {
    const lo = effectiveHeatLoad01(base({ pvKw: 1 })).feelsLikeC;
    const hi = effectiveHeatLoad01(base({ pvKw: 8 })).feelsLikeC;
    expect(lo).not.toBeNull();
    expect(hi).not.toBeNull();
    expect(hi!).toBeGreaterThan(lo!);
    // never below the actual air temperature
    expect(lo!).toBeGreaterThanOrEqual(25);
  });

  it('feelsLikeC is null when outdoor temperature is null', () => {
    const r = effectiveHeatLoad01(base({ outdoorTempC: null }));
    expect(r.feelsLikeC).toBeNull();
  });
});

describe('effectiveHeatLoad01 — trend handling', () => {
  it('a cooling (negative) trend does not add load vs. zero trend', () => {
    const cooling = effectiveHeatLoad01(base({ outdoorTrendCph: -3 })).load01;
    const flat = effectiveHeatLoad01(base({ outdoorTrendCph: 0 })).load01;
    expect(cooling).toBeCloseTo(flat, 6);
  });

  it('a warming trend adds load vs. flat', () => {
    const warming = effectiveHeatLoad01(base({ outdoorTrendCph: 3 })).load01;
    const flat = effectiveHeatLoad01(base({ outdoorTrendCph: 0 })).load01;
    expect(warming).toBeGreaterThan(flat);
  });
});
