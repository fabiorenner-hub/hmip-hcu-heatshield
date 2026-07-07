/**
 * Underlay calibration + transform math (building-model-editor Phase 2, BME-05).
 */

import { describe, expect, it } from 'vitest';

import {
  pixelToModel,
  modelToPixel,
  modelToImageFraction,
  calibrateTwoPoint,
  effectiveMpp,
  clampUnderlayDisplay,
  normalizeCropPolygon,
  cropPolygonToPixels,
  hasCrop,
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

  it('normalises a crop polygon in the patch path', () => {
    const out = clampUnderlayDisplay({ crop: [{ x: -1, y: 0.5 }, { x: 2, y: 0.5 }, { x: 0.5, y: 0.5 }] });
    expect(out.crop).toEqual([{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }, { x: 0.5, y: 0.5 }]);
  });
});

describe('modelToPixel', () => {
  it('is the inverse of pixelToModel', () => {
    for (const u of [base, { ...base, rotationDeg: 37, offsetXM: 2, offsetYM: -1 }]) {
      const m = pixelToModel(123, 45, u);
      const px = modelToPixel(m.x, m.y, u);
      expect(px.x).toBeCloseTo(123, 5);
      expect(px.y).toBeCloseTo(45, 5);
    }
  });

  it('maps a model point to an image fraction', () => {
    const u = { ...base, metersPerPixel: 0.01, widthPx: 200, heightPx: 100 };
    // pixel (100, 50) → model (1, -0.5); fraction back = (0.5, 0.5).
    const f = modelToImageFraction({ x: 1, y: -0.5 }, u);
    expect(f.x).toBeCloseTo(0.5, 6);
    expect(f.y).toBeCloseTo(0.5, 6);
  });
});

describe('normalizeCropPolygon', () => {
  it('clamps coordinates into [0,1]', () => {
    expect(normalizeCropPolygon([{ x: -0.2, y: 1.5 }, { x: 0.5, y: 0.5 }, { x: 2, y: -1 }])).toEqual([
      { x: 0, y: 1 },
      { x: 0.5, y: 0.5 },
      { x: 1, y: 0 },
    ]);
  });

  it('drops the crop when fewer than three valid points remain', () => {
    expect(normalizeCropPolygon([{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }])).toEqual([]);
    expect(normalizeCropPolygon([{ x: 0.1, y: 0.1 }, { x: NaN, y: 0.2 }, { x: 0.3, y: 0.3 }])).toEqual([]);
  });

  it('defensively handles non-array / malformed JSON input', () => {
    expect(normalizeCropPolygon(undefined)).toEqual([]);
    expect(normalizeCropPolygon('nope')).toEqual([]);
    expect(normalizeCropPolygon([1, null, { x: 'a', y: 0 }])).toEqual([]);
  });
});

describe('cropPolygonToPixels / hasCrop', () => {
  it('scales fractions to pixel coordinates', () => {
    expect(cropPolygonToPixels([{ x: 0, y: 0 }, { x: 1, y: 0.5 }], 200, 100)).toEqual([
      { x: 0, y: 0 },
      { x: 200, y: 50 },
    ]);
  });

  it('reports a usable crop only with three or more points', () => {
    expect(hasCrop({ crop: [] })).toBe(false);
    expect(hasCrop({ crop: [{ x: 0, y: 0 }, { x: 1, y: 0 }] })).toBe(false);
    expect(hasCrop({ crop: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] })).toBe(true);
    expect(hasCrop({})).toBe(false);
  });
});
