// @vitest-environment jsdom
/**
 * Liquid Glass V2 Garten + Automatik — expert expansion (ui-v2-release, Task 9.3).
 * Garten: manual Gardena valve control. Automatik: normalised risk weights.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, fireEvent } from '@testing-library/preact';
import { h } from 'preact';

import { LiquidGlass2Garten } from '../../src/plugin/dashboard/spa/components/liquidglass2/liquidGlass2Garten.js';
import { LiquidGlass2Automatik } from '../../src/plugin/dashboard/spa/components/liquidglass2/liquidGlass2Automatik.js';
import { snapshot, setRiskBreakdowns } from '../../src/plugin/dashboard/spa/store.js';
import { setExpertMode } from '../../src/plugin/dashboard/spa/expertMode.js';
import { setLangPref } from '../../src/plugin/dashboard/spa/i18n.js';
import type { DashboardSnapshot, WindowRiskBreakdown } from '../../src/plugin/dashboard/spa/types.js';

afterEach(() => {
  cleanup();
  snapshot.value = null;
  setExpertMode(false);
  setRiskBreakdowns([]);
  setLangPref('auto');
});

function base(): Record<string, unknown> {
  return {
    ts: new Date().toISOString(),
    mode: 'ACTIVE_HEAT_PROTECTION',
    rooms: [],
    windows: [],
    sources: { fusionSolar: { sourceOk: true, lastSuccess: '', consecutiveFailures: 0 }, hcu: { connected: true } },
    userIntent: { paused: false, pauseUntil: null, vacation: false },
    storm: { holdUntil: null },
    pluginReadiness: 'READY',
    roomsDetail: [],
  };
}

describe('LiquidGlass2Garten expert valve control', () => {
  it('shows per-zone manual valve buttons in expert mode', () => {
    snapshot.value = {
      ...base(),
      irrigation: {
        rainTodayMm: 0, et0TodayMm: 3, rainForecastMm: 0, totalSecondsUsedToday: 0,
        zones: [{
          id: 'beet', name: 'Beet', plant: 'Tomaten', soilMoisturePct: 40, availablePct: 40,
          valveOn: false, blockedBy: null, nextWateringTs: null, nextActionLabel: '',
          depletionMm: 5, rawMm: 12, tawMm: 20, dailyNeedMm: 3,
          learned: { kcFactor: 1.1, sampleDays: 4, emitterFault: false },
        }],
      },
    } as unknown as DashboardSnapshot;
    setExpertMode(true);
    const { container } = render(<LiquidGlass2Garten />);
    const ctl = container.querySelector('[data-testid="lg2-expert-garden-control"]');
    expect(ctl).not.toBeNull();
    expect(ctl?.querySelectorAll('button').length).toBe(3);
  });
});

describe('LiquidGlass2Automatik expert risk weights', () => {
  it('shows normalised risk weights on the Strategie tab in expert mode', () => {
    const rb: WindowRiskBreakdown = {
      windowId: 'w1',
      factors: { sunFactor: 0.8, roomTempFactor: 0.4 },
      weights: { sunFactor: 0.5, roomTempFactor: 0.3 },
      risk: 0.6, rawTarget: 0.7, finalTarget: 0.7, mode: 'ACTIVE_HEAT_PROTECTION',
    };
    setRiskBreakdowns([rb]);
    snapshot.value = { ...base(), modeInfo: { id: 'active', label: 'Aktiv', goal: '', reasons: [] } } as unknown as DashboardSnapshot;
    setExpertMode(true);
    setLangPref('de');
    const { container } = render(<LiquidGlass2Automatik />);
    // Switch to the Strategie tab (2nd tab).
    const tabs = container.querySelectorAll('.lg2-auto__tab');
    fireEvent.click(tabs[1]!);
    expect(container.querySelector('[data-testid="lg2-expert-weights"]')).not.toBeNull();
    expect(container.querySelectorAll('.lg2-auto__weightrow').length).toBe(2);
  });
});
