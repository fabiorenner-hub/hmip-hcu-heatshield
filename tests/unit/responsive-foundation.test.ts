/**
 * Responsive foundation + feature flags (Gate 2 G2.1).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  breakpointFor,
  isPhone,
  isTabletUp,
  BREAKPOINT_MIN,
  type Breakpoint,
} from '../../src/plugin/dashboard/spa/responsive.js';
import { getFlag, setFlag } from '../../src/plugin/dashboard/spa/featureFlags.js';

describe('breakpointFor', () => {
  const cases: Array<[number, Breakpoint]> = [
    [320, 'compactPhone'],
    [389, 'compactPhone'],
    [390, 'largePhone'],
    [599, 'largePhone'],
    [600, 'compactTablet'],
    [839, 'compactTablet'],
    [840, 'expandedTablet'],
    [1199, 'expandedTablet'],
    [1200, 'desktop'],
    [1920, 'desktop'],
  ];
  it.each(cases)('width %i → %s', (w, expected) => {
    expect(breakpointFor(w)).toBe(expected);
  });

  it('clamps very small widths to compactPhone', () => {
    expect(breakpointFor(0)).toBe('compactPhone');
    expect(breakpointFor(100)).toBe('compactPhone');
  });

  it('boundaries match BREAKPOINT_MIN', () => {
    (Object.keys(BREAKPOINT_MIN) as Breakpoint[]).forEach((bp) => {
      expect(breakpointFor(BREAKPOINT_MIN[bp])).toBe(bp);
    });
  });
});

describe('isPhone / isTabletUp', () => {
  it('phones are compact/large phone', () => {
    expect(isPhone('compactPhone')).toBe(true);
    expect(isPhone('largePhone')).toBe(true);
    expect(isPhone('compactTablet')).toBe(false);
  });
  it('tablet-up is the complement', () => {
    (['compactPhone', 'largePhone', 'compactTablet', 'expandedTablet', 'desktop'] as Breakpoint[]).forEach(
      (bp) => expect(isTabletUp(bp)).toBe(!isPhone(bp)),
    );
  });
});

describe('feature flags', () => {
  beforeEach(() => {
    try {
      window.localStorage.clear();
    } catch {
      /* ignore */
    }
  });

  it('default OFF', () => {
    expect(getFlag('premiumUiV2')).toBe(false);
    expect(getFlag('mobileUiV2')).toBe(false);
  });

  it('override on/off and clear back to default', () => {
    setFlag('premiumUiV2', true);
    expect(getFlag('premiumUiV2')).toBe(true);
    setFlag('premiumUiV2', false);
    expect(getFlag('premiumUiV2')).toBe(false);
    setFlag('premiumUiV2', null);
    expect(getFlag('premiumUiV2')).toBe(false);
  });
});
