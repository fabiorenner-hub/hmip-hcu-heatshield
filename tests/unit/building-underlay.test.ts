/**
 * Underlay calibration + transform math (building-model-editor Phase 2, BME-05).
 */

import { describe, expect, it } from 'vitest';

import {
  pixelToModel,
  calibrateTwoPoint,
  effectiveMpp,
  clampUnderlayDisplay,
  DEFAULT_MPP,
} from '../../src/shared/building-underlay.js';

const base = { metersPerPixel: 0.01, offsetXM: 0, offsetYM: 0, rotationDeg: 0 };

describe('effectiveMpp', () => {
  it('falls back to the default when uncalibrated', () => {
    expect(effectiveMpp({ metersPerPixel: null })).toBe(DEFAULT_MPP);
    expect(effectiveMpp({ metersPerPixel: 0.05 })).toBe(0.05);
  });
});

describe('pixelToModel', () => {
  it('maps pixels to metres with y flipped', () => {
    const m = pixelToModel(100, 50, base);
    expect(m.x).toBeCloseTo(1, 6); // 100 px × 0.01 m/px
    expect(m.y).toBeCloseTo(-0.5, 6); // image y grows downward → model −y
  });

  it('applies rotation about the origin', () => {
    const m = pixelToModel(100, 0, { ...base, rotationDeg: 90 });
    expect(m.x).toBeCloseTo(0, 6);
    expect(m.y).toBeCloseTo(1, 6);
  });
});

describe('calibrateTwoPoint', () => {
  it('rescales so the picked distance equals the real distance', () => {
    // Two model points 2 m apart under the current calibration; user says 4 m.
    const cal = calibrateTwoPoint(base, { x: 0, y: 0 }, { x: 2, y: 0 }, 4);
    expect(cal.metersPerPixel).toBeCloseTo(0.02, 6); // doubled
  });

  it('keeps the first point fixed', () => {
    const cal = calibrateTwoPoint({ ...base, offsetXM: 1, offsetYM: 1 }, { x: 3, y: 1 }, { x: 5, y: 1 }, 4);
    // Applying the new transform: the model point m1 must be preserved, which
    // means offset shifts by (1−k)*(m1−offset). k = 4/2 = 2.
    expect(cal.offsetXM).toBeCloseTo(1 + (1 - 2) * (3 - 1), 6);
  });

  it('is a no-op when the points coincide', () => {
    const cal = calibrateTwoPoint(base, { x: 1, y: 1 }, { x: 1, y: 1 }, 4);
    expect(cal.metersPerPixel).toBe(base.metersPerPixel);
  });
});

describe('clampUnderlayDisplay', () => {
  it('clamps opacity/contrast and normalises rotation', () => {
    const out = clampUnderlayDisplay({ opacityPct: 150, contrastPct: 10, rotationDeg: 370 });
    expect(out.opacityPct).toBe(100);
    expect(out.contrastPct).toBe(50);
    expect(out.rotationDeg).toBe(10);
  });

  it('coerces a non-positive metersPerPixel to null', () => {
    expect(clampUnderlayDisplay({ metersPerPixel: 0 }).metersPerPixel).toBeNull();
  });
});
