// @vitest-environment jsdom
/**
 * Liquid Glass V2 overview — regression after the shell/theme extraction
 * (ui-v2-release, Task 2). Verifies the content-only page still composes the
 * extracted shell (sidebar + config entry) and renders the body / skeleton /
 * expert values exactly as before.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import { h } from 'preact';

import { LiquidGlass2Overview } from '../../src/plugin/dashboard/spa/components/liquidglass2/liquidGlass2Overview.js';
import { snapshot } from '../../src/plugin/dashboard/spa/store.js';
import { expertMode, setExpertMode } from '../../src/plugin/dashboard/spa/expertMode.js';
import type { DashboardSnapshot, PlannedAction, RoomDetail } from '../../src/plugin/dashboard/spa/types.js';

const NOW = new Date();

function action(): PlannedAction {
  return {
    windowId: 'w1',
    scheduledTs: new Date(NOW.getTime() + 3600_000).toISOString(),
    targetPercent: 60,
    reason: 'Vorausschauende Position hält Komfort',
    state: 'scheduled',
  };
}

function room(over: Partial<RoomDetail> = {}): RoomDetail {
  return {
    id: 'schlafzimmer',
    name: 'Schlafzimmer',
    facade: 'S',
    shutterPercent: 60,
    indoorTempC: 24.1,
    trend: 'up',
    nextAction: null,
    status: 'scheduled',
    windowId: 'w1',
    heatLoad01: 0.5,
    ...over,
  };
}

function full(over: Partial<DashboardSnapshot> = {}): DashboardSnapshot {
  const now = NOW.toISOString();
  return {
    ts: now,
    mode: 'ACTIVE_HEAT_PROTECTION',
    rooms: [],
    windows: [{ id: 'w1', name: 'Schlafzimmer – Rollladen', currentLevel01: 0.6, manualOverrideUntil: null, lastDecisionMode: 'ACTIVE_HEAT_PROTECTION' }],
    sources: { fusionSolar: { sourceOk: true, lastSuccess: now, consecutiveFailures: 0 }, hcu: { connected: true } },
    userIntent: { paused: false, pauseUntil: null, vacation: false },
    storm: { holdUntil: null },
    pluginReadiness: 'READY',
    modeInfo: { id: 'active', label: 'Aktiver Hitzeschutz', goal: '', reasons: ['Süd-Fassade stark besonnt'], decidedBy: 'Aktiver Hitzeschutz: wärmster Raum 27 °C' },
    facades: { N: 5, E: 30, S: 88, W: 22 },
    ventilation: { overall: { level: 'air_now', headline: '', detail: '' }, rooms: [] },
    plannedActions: [action()],
    forecastTimeline: [
      { ts: now, weatherIcon: '☀', tempC: 29, radiationWm2: 720, precipitationOrCloud01: 0.2 },
      { ts: new Date(NOW.getTime() + 3600_000).toISOString(), weatherIcon: '⛅', tempC: 31, radiationWm2: 650, precipitationOrCloud01: 0.4 },
    ],
    trajectories: {
      indoorForecastWithShade: [{ ts: now, tempC: 25 }],
      indoorForecastNoShade: [{ ts: now, tempC: 27 }],
      heatLoadForecast: [],
    },
    impact: { comfortShareToday01: null, avgMovesPerDay: null, calibratedRooms: 0, tunedRooms: 0, learnDays: 3, forecastAccuracyC: 0.8 },
    roomsDetail: [room()],
    ...over,
  } as DashboardSnapshot;
}

afterEach(() => {
  cleanup();
  snapshot.value = null;
  setExpertMode(false);
});

describe('LiquidGlass2Overview (post-extraction)', () => {
  it('renders content-only skeleton while the snapshot is null', () => {
    snapshot.value = null;
    const { container } = render(<LiquidGlass2Overview />);
    // Content-only page (the sidebar/chrome is provided by the AppShell now).
    expect(container.querySelector('[data-testid="liquid-glass2-overview"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="lg2-skeleton"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="lg2-sidebar"]')).toBeNull();
  });

  it('renders the overview body from a full snapshot', () => {
    snapshot.value = full();
    const { container } = render(<LiquidGlass2Overview />);
    for (const id of ['liquid-glass2-overview', 'lg2-hero', 'lg2-strip', 'lg2-kpis', 'twin-chips']) {
      expect(container.querySelector(`[data-testid="${id}"]`)).not.toBeNull();
    }
  });

  it('hides expert values in basic mode', () => {
    snapshot.value = full();
    setExpertMode(false);
    const { container } = render(<LiquidGlass2Overview />);
    expect(container.querySelector('[data-testid="lg2-expert-overview"]')).toBeNull();
  });

  it('reveals expert values in expert mode', () => {
    snapshot.value = full();
    setExpertMode(true);
    const { container } = render(<LiquidGlass2Overview />);
    expect(expertMode.value).toBe(true);
    expect(container.querySelector('[data-testid="lg2-expert-overview"]')).not.toBeNull();
  });

  it('expert mode exposes manual control (Task 9.3); no duplicate actions panel (Task 11.6)', () => {
    snapshot.value = full();
    setExpertMode(true);
    const { container } = render(<LiquidGlass2Overview />);
    // Task 11.6: the duplicate "Alle geplanten Aktionen" panel was removed.
    expect(container.querySelector('[data-testid="lg2-expert-actions"]')).toBeNull();
    const control = container.querySelector('[data-testid="lg2-expert-control"]');
    expect(control).not.toBeNull();
    // Manual control offers move buttons when no storm is active.
    expect(control?.querySelectorAll('button').length).toBeGreaterThan(0);
    expect(container.querySelector('[data-testid="lg2-expert-control-locked"]')).toBeNull();
  });

  it('locks manual control during storm protection (safety precedence, R6.7)', () => {
    snapshot.value = full({ mode: 'STORM' });
    setExpertMode(true);
    const { container } = render(<LiquidGlass2Overview />);
    expect(container.querySelector('[data-testid="lg2-expert-control-locked"]')).not.toBeNull();
    const control = container.querySelector('[data-testid="lg2-expert-control"]');
    expect(control?.querySelectorAll('button').length).toBe(0);
  });
});
