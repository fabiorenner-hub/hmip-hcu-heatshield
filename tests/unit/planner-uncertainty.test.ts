/**
 * Heat Shield — confidence-aware planner margin (V1.3).
 *
 * When the per-room forecast is uncertain (low confidence01), the planner adds
 * slack to the comfort upper bound so it holds shading back rather than making
 * needless moves on volatile days. Bounded to 1 K, monotone in (1−confidence).
 */

import { describe, expect, it } from 'vitest';

import { uncertaintyMarginC } from '../../src/plugin/engine/forecast/planner.js';

describe('planner uncertainty margin', () => {
  it('is zero at full confidence and grows as confidence drops', () => {
    expect(uncertaintyMarginC(1)).toBe(0);
    expect(uncertaintyMarginC(0.9)).toBeCloseTo(0.1, 5);
    expect(uncertaintyMarginC(0.5)).toBeCloseTo(0.5, 5);
    expect(uncertaintyMarginC(0)).toBe(1);
  });

  it('is monotone and clamped to [0,1]', () => {
    let prev = -1;
    for (const c of [1, 0.9, 0.75, 0.5, 0.25, 0]) {
      const m = uncertaintyMarginC(c);
      expect(m).toBeGreaterThanOrEqual(0);
      expect(m).toBeLessThanOrEqual(1);
      expect(m).toBeGreaterThanOrEqual(prev);
      prev = m;
    }
  });

  it('handles non-finite input defensively', () => {
    expect(uncertaintyMarginC(Number.NaN)).toBeCloseTo(0.1, 5);
  });
});
