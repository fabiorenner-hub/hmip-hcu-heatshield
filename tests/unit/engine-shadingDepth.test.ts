/**
 * Tests for the shading depth helper
 * (`src/plugin/engine/shadingDepth.ts`, Task 4.1 / 4.2 / 4.4).
 *
 * Coverage:
 *   - open state or no incidence → open floor.
 *   - depth grows with incidence and with heat load.
 *   - depth never exceeds the heat-stau cap.
 *   - the open floor is clamped to a tight cap.
 *   - partial closure at moderate incidence/load.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MIN_OPEN_DEPTH01,
  shadingDepth01,
} from '../../src/plugin/engine/shadingDepth.js';

describe('shadingDepth01 — open / no sun', () => {
  it('returns the open floor when the FSM state is open', () => {
    expect(
      shadingDepth01({
        shadeState: 'open',
        incidence01: 1,
        heatLoad01: 1,
        heatCap01: 0.95,
      }),
    ).toBe(DEFAULT_MIN_OPEN_DEPTH01);
  });

  it('returns the open floor when there is no direct sun (incidence 0)', () => {
    expect(
      shadingDepth01({
        shadeState: 'shaded',
        incidence01: 0,
        heatLoad01: 1,
        heatCap01: 1,
      }),
    ).toBe(DEFAULT_MIN_OPEN_DEPTH01);
  });
});

describe('shadingDepth01 — partial closure', () => {
  it('drives to the cap at full incidence and full load', () => {
    const d = shadingDepth01({
      shadeState: 'shaded',
      incidence01: 1,
      heatLoad01: 1,
      heatCap01: 0.95,
    });
    expect(d).toBeCloseTo(0.95, 6);
  });

  it('closes only partially at full incidence but zero load', () => {
    const d = shadingDepth01({
      shadeState: 'shaded',
      incidence01: 1,
      heatLoad01: 0,
      heatCap01: 0.95,
    });
    // g = 1 * 0.5 = 0.5 → depth = 0.1 + (0.95-0.1)*0.5 = 0.525
    expect(d).toBeCloseTo(0.525, 6);
    expect(d).toBeLessThan(0.95);
    expect(d).toBeGreaterThan(DEFAULT_MIN_OPEN_DEPTH01);
  });

  it('is monotonic in incidence (more sun ⇒ ≥ depth)', () => {
    const lo = shadingDepth01({
      shadeState: 'shaded',
      incidence01: 0.3,
      heatLoad01: 0.6,
      heatCap01: 1,
    });
    const hi = shadingDepth01({
      shadeState: 'shaded',
      incidence01: 0.9,
      heatLoad01: 0.6,
      heatCap01: 1,
    });
    expect(hi).toBeGreaterThanOrEqual(lo);
  });

  it('is monotonic in heat load (more load ⇒ ≥ depth)', () => {
    const lo = shadingDepth01({
      shadeState: 'shaded',
      incidence01: 0.7,
      heatLoad01: 0.2,
      heatCap01: 1,
    });
    const hi = shadingDepth01({
      shadeState: 'shaded',
      incidence01: 0.7,
      heatLoad01: 0.9,
      heatCap01: 1,
    });
    expect(hi).toBeGreaterThanOrEqual(lo);
  });
});

describe('shadingDepth01 — cap conformance', () => {
  it('never exceeds the heat cap (façade 0.95)', () => {
    const d = shadingDepth01({
      shadeState: 'shaded',
      incidence01: 1,
      heatLoad01: 1,
      heatCap01: 0.95,
    });
    expect(d).toBeLessThanOrEqual(0.95);
  });

  it('clamps the open floor down to a tight cap', () => {
    const d = shadingDepth01({
      shadeState: 'open',
      incidence01: 0,
      heatLoad01: 0,
      heatCap01: 0.05,
      minOpenDepth01: 0.1,
    });
    expect(d).toBe(0.05);
  });
});
