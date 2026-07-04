// @vitest-environment jsdom
/**
 * Übersicht view (uebersicht-rework, Task 12) — render + state tests.
 *
 * Covers loading skeleton, onboarding, the full decision surface, honest
 * fallbacks, expert-mode disclosure and the conditional Warnungen deep link.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import { h } from 'preact';

import { UebersichtView } from '../../src/plugin/dashboard/spa/components/uebersicht/uebersichtView.js';
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

describe('UebersichtView states', () => {
  it('shows the skeleton while the snapshot is null', () => {
    snapshot.value = null;
    const { container } = render(<UebersichtView />);
    expect(container.querySelector('[data-testid="uebersicht-view"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="overview-skeleton"]')).not.toBeNull();
  });

  it('shows onboarding when no rooms are configured', () => {
    snapshot.value = full({ roomsDetail: [] });
    const { container } = render(<UebersichtView />);
    expect(container.querySelector('[data-testid="onboarding"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="lagekarte"]')).toBeNull();
  });

  it('renders the full decision surface with rooms', () => {
    snapshot.value = full();
    const { container } = render(<UebersichtView />);
    for (const id of ['status-banner', 'lagekarte', 'next-action-strip', 'house-twin-compact', 'kpi-row', 'outlook-strip', 'room-status-grid', 'overview-deeplinks']) {
      expect(container.querySelector(`[data-testid="${id}"]`)).not.toBeNull();
    }
    // Benefit = 27 − 25 = 2.0 °C avoided (locale decimal separator may vary).
    expect(container.querySelector('[data-testid="hero-benefit"]')?.textContent).toMatch(/2[.,]0/);
    // Peak card marked in the outlook (hottest = 31 °C at index 1).
    expect(container.querySelector('[data-testid="outlook-card-peak"]')).not.toBeNull();
  });
});

describe('UebersichtView honesty + KPIs', () => {
  it('degrades KPIs to – when sources are missing', () => {
    snapshot.value = full({ facades: undefined, trajectories: undefined, ventilation: undefined, precipNowcast: undefined, signals: undefined });
    const { container } = render(<UebersichtView />);
    expect(container.querySelector('[data-testid="kpi-avoided"]')?.textContent).toContain('–');
    expect(container.querySelector('[data-testid="kpi-solar"]')?.textContent).toContain('–');
  });
});

describe('UebersichtView expert mode + deep links', () => {
  it('hides the expert controls by default and shows them in expert mode', () => {
    snapshot.value = full();
    const { container, rerender } = render(<UebersichtView />);
    expect(container.querySelector('[data-testid="overview-expert"]')).toBeNull();
    setExpertMode(true);
    rerender(<UebersichtView />);
    expect(expertMode.value).toBe(true);
    expect(container.querySelector('[data-testid="overview-expert"]')).not.toBeNull();
  });

  it('shows the Warnungen deep link only when an alert is active', () => {
    snapshot.value = full();
    const { container, rerender } = render(<UebersichtView />);
    expect(container.querySelector('[data-testid="deep-warnungen"]')).toBeNull();
    snapshot.value = full({ weatherAlert: { active: true, maxLevel: 4, region: 'Berlin', updatedTs: '', warnings: [] } });
    rerender(<UebersichtView />);
    expect(container.querySelector('[data-testid="deep-warnungen"]')).not.toBeNull();
  });
});
