/**
 * Unit tests for the pure hot-day minimum-shade floor decision
 * (`hotDayShadingPercent`). Covers the multi-stage ramp the feature was built
 * for (30 °C → 30 %, 35 °C → 50 %) plus the legacy single-stage fallback.
 */

import { describe, it, expect } from 'vitest';

import { hotDayShadingPercent } from '../../src/plugin/engine/hotDayFloor.js';

const LEGACY = { outdoorThresholdC: 35, maxOpenPercent: 50 };

describe('hotDayShadingPercent — legacy single stage', () => {
  it('returns null below the threshold', () => {
    expect(hotDayShadingPercent(LEGACY, 30)).toBeNull();
    expect(hotDayShadingPercent(LEGACY, 34.9)).toBeNull();
  });

  it('returns 100 − maxOpenPercent at/above the threshold', () => {
    expect(hotDayShadingPercent(LEGACY, 35)).toBe(50);
    expect(hotDayShadingPercent(LEGACY, 40)).toBe(50);
    expect(hotDayShadingPercent({ outdoorThresholdC: 30, maxOpenPercent: 70 }, 31)).toBe(30);
  });
});

describe('hotDayShadingPercent — multi-stage ramp', () => {
  const rules = {
    outdoorThresholdC: 35,
    maxOpenPercent: 50,
    stages: [
      { outdoorThresholdC: 30, shadingPercent: 30 },
      { outdoorThresholdC: 35, shadingPercent: 50 },
    ],
  };

  it('applies no floor below the first stage', () => {
    expect(hotDayShadingPercent(rules, 29.9)).toBeNull();
  });

  it('picks the 30 % stage between 30 and 35 °C', () => {
    expect(hotDayShadingPercent(rules, 30)).toBe(30);
    expect(hotDayShadingPercent(rules, 33)).toBe(30);
    expect(hotDayShadingPercent(rules, 34.9)).toBe(30);
  });

  it('picks the highest reached stage at/above 35 °C', () => {
    expect(hotDayShadingPercent(rules, 35)).toBe(50);
    expect(hotDayShadingPercent(rules, 42)).toBe(50);
  });

  it('ignores stage order (highest reached threshold wins)', () => {
    const unordered = {
      outdoorThresholdC: 35,
      maxOpenPercent: 50,
      stages: [
        { outdoorThresholdC: 40, shadingPercent: 80 },
        { outdoorThresholdC: 30, shadingPercent: 30 },
        { outdoorThresholdC: 35, shadingPercent: 50 },
      ],
    };
    expect(hotDayShadingPercent(unordered, 36)).toBe(50);
    expect(hotDayShadingPercent(unordered, 41)).toBe(80);
  });

  it('falls back to the legacy fields when stages is empty', () => {
    expect(hotDayShadingPercent({ ...LEGACY, stages: [] }, 36)).toBe(50);
  });

  it('returns null for non-finite temperatures', () => {
    expect(hotDayShadingPercent(rules, Number.NaN)).toBeNull();
  });
});
