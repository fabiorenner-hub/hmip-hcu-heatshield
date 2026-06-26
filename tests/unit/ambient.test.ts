/**
 * Heat Shield — ambient dashboard background (V1.2).
 */

import { describe, expect, it } from 'vitest';

import { ambientPhase, ambientBackground } from '../../src/plugin/dashboard/spa/ambient.js';

describe('ambient background', () => {
  it('classifies the phase from sun elevation + storm', () => {
    expect(ambientPhase(40, false)).toBe('day');
    expect(ambientPhase(3, false)).toBe('dawn');
    expect(ambientPhase(-20, false)).toBe('night');
    expect(ambientPhase(40, true)).toBe('storm');
  });

  it('returns a distinct gradient string per phase', () => {
    const day = ambientBackground(40, 0, false);
    const night = ambientBackground(-20, 0, false);
    const storm = ambientBackground(40, 0, true);
    for (const g of [day, night, storm]) {
      expect(g).toContain('gradient');
    }
    expect(day).not.toBe(night);
    expect(day).not.toBe(storm);
  });

  it('uses an overcast palette when cloudy', () => {
    const clear = ambientBackground(40, 0, false);
    const cloudy = ambientBackground(40, 0.9, false);
    expect(clear).not.toBe(cloudy);
  });
});
