// @vitest-environment jsdom
/**
 * Heat Shield — Beschattung dashboard render tests
 * (predictive-control-dashboard Tasks 13.1, 14.1, 15.1, 17.1, 18.1, 19.1).
 *
 * Structural assertions (DOM presence, classes, counts) against JSDOM. The
 * tests stay structural rather than visual so they survive CSS tweaks.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import { h } from 'preact';

import { App } from '../../src/plugin/dashboard/spa/app.js';
import { DashboardGrid } from '../../src/plugin/dashboard/spa/components/dashboard/dashboardGrid.js';
import {
  IndoorTemperatureCard,
  OutdoorTemperatureCard,
  PvPowerCard,
} from '../../src/plugin/dashboard/spa/components/dashboard/liveMetricsRail.js';
import { snapshot, setRiskBreakdowns } from '../../src/plugin/dashboard/spa/store.js';
import type { DashboardSnapshot, PlannedAction } from '../../src/plugin/dashboard/spa/types.js';

const NOW = new Date('2026-06-21T10:00:00.000Z');

function action(windowId: string, reason: string, state: PlannedAction['state'] = 'scheduled'): PlannedAction {
  return {
    windowId,
    scheduledTs: NOW.toISOString(),
    targetPercent: 60,
    reason,
    state,
  };
}

function v2Snapshot(): DashboardSnapshot {
  return {
    ts: NOW.toISOString(),
    mode: 'ACTIVE_HEAT_PROTECTION',
    rooms: [{ id: 'schlafzimmer', name: 'Schlafzimmer', tempC: 23.1 }],
    windows: [
      {
        id: 'fenster-1',
        name: 'Schlafzimmer – Rollladen (…AB12)',
        currentLevel01: 0.6,
        manualOverrideUntil: null,
        lastDecisionMode: 'ACTIVE_HEAT_PROTECTION',
      },
    ],
    sources: {
      fusionSolar: { sourceOk: true, lastSuccess: NOW.toISOString(), consecutiveFailures: 0 },
      hcu: { connected: true },
    },
    userIntent: { paused: false, pauseUntil: null, vacation: false },
    storm: { holdUntil: null },
    pluginReadiness: 'READY',
    automationEnabled: true,
    signals: {
      outdoorTemp: { value: 29.4, ts: NOW.toISOString(), state: 'fresh' },
      pvPower: { value: 6.2, ts: NOW.toISOString(), state: 'fresh' },
      windSpeed: { value: 3.1, ts: NOW.toISOString(), state: 'fresh' },
      radiation: { value: 720, ts: NOW.toISOString(), state: 'fresh' },
      forecastMaxTemp: { value: 31, ts: NOW.toISOString(), state: 'fresh' },
      forecastCloudCover: { value: 0.2, ts: NOW.toISOString(), state: 'fresh' },
    },
    sun: { azimuthDeg: 135, elevationDeg: 42 },
    feelsLike: { effectiveLoad01: 0.72, feelsLikeC: 33 },
    modeInfo: {
      id: 'ACTIVE_HEAT_PROTECTION',
      label: 'Aktiver Hitzeschutz',
      goal: 'Räume aktiv verschatten',
      reasons: ['Gefühlte Wärme 72 %', 'Süd-Fassade stark besonnt'],
    },
    environment: {
      radiationWm2: { value: 720, origin: 'forecast', source: 'OpenMeteo', confidence01: 0.9 },
      uvIndex: { value: 6, origin: 'estimated', source: 'OpenMeteo', confidence01: 0.4 },
      windMs: { value: 3.1, origin: 'forecast', source: 'OpenMeteo', confidence01: 0.9 },
      humidity01: { value: 0.45, origin: 'estimated', source: 'OpenMeteo', confidence01: 0.4 },
    },
    facades: { N: 5, E: 30, S: 88, W: 22 },
    pvSonnenindex01: 0.71,
    roomsDetail: [
      {
        id: 'schlafzimmer',
        name: 'Schlafzimmer',
        facade: 'S',
        shutterPercent: 60,
        indoorTempC: 23.1,
        trend: 'up',
        nextAction: action('fenster-1', 'Vorausschauende Position hält Komfort'),
        status: 'scheduled',
      },
    ],
    forecastTimeline: [
      { ts: NOW.toISOString(), weatherIcon: '☀️', tempC: 29, radiationWm2: 720, precipitationOrCloud01: 0.2 },
      { ts: new Date(NOW.getTime() + 2 * 3600_000).toISOString(), weatherIcon: '⛅', tempC: 30, radiationWm2: 650, precipitationOrCloud01: 0.4 },
    ],
    plannedActions: [action('fenster-1', 'Vorausschauende Position hält Komfort')],
    trajectories: {
      indoorForecastWithShade: [
        { ts: NOW.toISOString(), tempC: 23.1 },
        { ts: new Date(NOW.getTime() + 3600_000).toISOString(), tempC: 23.6 },
      ],
      indoorForecastNoShade: [
        { ts: NOW.toISOString(), tempC: 23.1 },
        { ts: new Date(NOW.getTime() + 3600_000).toISOString(), tempC: 25.0 },
      ],
      heatLoadForecast: [
        { ts: NOW.toISOString(), load01: 0.5 },
        { ts: new Date(NOW.getTime() + 3600_000).toISOString(), load01: 0.7 },
      ],
    },
  };
}

afterEach(() => {
  cleanup();
  snapshot.value = null;
  setRiskBreakdowns([]);
});

describe('App v2 sidebar nav + overview decision surface (uebersicht-rework)', () => {
  it('renders the v2 sidebar with Übersicht active and surfaces the next actions', () => {
    snapshot.value = v2Snapshot();
    const { container } = render(<App initialUrl="/uebersicht" />);
    const modules = container.querySelectorAll('[data-testid^="nav-module-"]');
    expect(modules.length).toBe(6);
    const uebersicht = container.querySelector('[data-testid="nav-module-uebersicht"]');
    expect(uebersicht?.className).toContain('lg2-nav__item--active');
    // The pending-action affordance moved from the v1 nav badge onto the v2
    // overview's "Nächste Aktionen" card.
    expect(container.querySelector('[data-testid="lg2-actions-card"]')).not.toBeNull();
  });

  it('renders the native v2 overview blocks instead of the legacy 3-column grid', () => {
    snapshot.value = v2Snapshot();
    const { container } = render(<App initialUrl="/uebersicht" />);
    expect(container.querySelector('[data-testid="liquid-glass2-overview"]')).not.toBeNull();
    // The v2 overview surfaces the same decision info via its own blocks:
    expect(container.querySelector('[data-testid="lg2-hero"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="lg2-actions-card"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="lg2-house-card"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="lg2-kpis"]')).not.toBeNull();
    // The legacy three-column grid is gone from the overview.
    expect(container.querySelector('[data-testid="dashboard-grid"]')).toBeNull();
  });
});

describe('DashboardGrid content', () => {
  function renderGrid() {
    return render(
      <DashboardGrid snapshot={v2Snapshot()} latitude={52.52} longitude={13.41} now={NOW} />,
    );
  }

  it('renders the five KPI cards (Task 14.1)', () => {
    const { container } = renderGrid();
    for (const id of ['card-pv', 'card-indoor', 'card-outdoor', 'card-sun', 'card-heatindex']) {
      expect(container.querySelector(`[data-testid="${id}"]`)).not.toBeNull();
    }
    expect(container.querySelector('[data-testid="heatindex-ring"]')).not.toBeNull();
  });

  it('renders the house twin with a background asset and four overlays (Task 15.1)', () => {
    const { container } = renderGrid();
    const twin = container.querySelector('[data-testid="house-twin"]') as HTMLElement | null;
    expect(twin).not.toBeNull();
    expect(twin?.getAttribute('data-asset')).toMatch(/\/house\.png$/);
    for (const id of ['overlay-sunarc', 'overlay-facades', 'overlay-rooms', 'overlay-environment']) {
      expect(container.querySelector(`[data-testid="${id}"]`)).not.toBeNull();
    }
  });

  it('renders the forecast timeline with an active "Jetzt" card and colour-coded actions (Task 17.1)', () => {
    const { container } = renderGrid();
    const now = container.querySelector('[data-testid="forecast-card-now"]');
    expect(now).not.toBeNull();
    expect(now?.className).toContain('forecast-card--now');
    const chip = container.querySelector('[data-testid="action-chip"]');
    expect(chip).not.toBeNull();
    expect(chip?.className).toMatch(/action--(shade|vent|nightvent|cool|warn)/);
  });

  it('renders the rooms table with shutter bar and a highlighted strongest facade (Task 18.1)', () => {
    const { container } = renderGrid();
    expect(container.querySelector('[data-testid="rooms-table"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="shutter-bar"]')).not.toBeNull();
    const strongest = container.querySelector('.facade--strongest');
    expect(strongest).not.toBeNull();
    // South is the max exposure (88%) in the fixture.
    expect(strongest?.getAttribute('data-facade')).toBe('S');
  });

  it('renders the analysis cards and the per-room shutter heatmap (Task 19.1)', () => {
    const { container } = renderGrid();
    for (const id of [
      'automation-status',
      'temperature-chart',
      'pv-history-chart',
      'heat-load-chart',
      'shutter-heatmap',
    ]) {
      expect(container.querySelector(`[data-testid="${id}"]`)).not.toBeNull();
    }
    expect(container.querySelector('[data-testid="heatmap-row-schlafzimmer"]')).not.toBeNull();
    // Reasoning chips are present (Requirement 14.1 transparency).
    expect(container.querySelectorAll('[data-testid="reason-chip"]').length).toBeGreaterThan(0);
  });

  it('shows the loading placeholder when the snapshot is null', () => {
    const { container } = render(
      <DashboardGrid snapshot={null} latitude={52.52} longitude={13.41} now={NOW} />,
    );
    expect(container.querySelector('.dashboard-grid__loading')).not.toBeNull();
  });
});

describe('LiveMetricsRail KPI cards aligned with the mock', () => {
  it('shows Eigenverbrauch, Heute kWh and a PV sparkline when derivable', () => {
    const snap = { ...v2Snapshot(), pvSelfUse01: 0.87, pvTodayKwh: 12.4 };
    const { container } = render(<PvPowerCard snapshot={snap} history={[1, 2, 3, 4]} />);
    expect(container.querySelector('[data-testid="card-pv-selfuse"]')?.textContent).toContain(
      '87',
    );
    expect(container.querySelector('[data-testid="card-pv-today"]')?.textContent).toContain(
      '12.4',
    );
    expect(
      container.querySelector('[data-testid="pv-sparkline"]')?.tagName.toLowerCase(),
    ).toBe('svg');
  });

  it('omits Eigenverbrauch and the sparkline cleanly when not derivable', () => {
    const { container } = render(<PvPowerCard snapshot={v2Snapshot()} history={[]} />);
    expect(container.querySelector('[data-testid="card-pv-selfuse"]')).toBeNull();
    // Empty history → no sparkline node at all (no "–" noise).
    expect(container.querySelector('[data-testid="pv-sparkline"]')).toBeNull();
  });

  it('shows a local vs Wetterdienst comparison on the outdoor card when both exist', () => {
    const snap = { ...v2Snapshot(), outdoorTempInternetC: 30.2 };
    const { container } = render(
      <OutdoorTemperatureCard snapshot={snap} history={[28, 29, 30]} />,
    );
    const cmp = container.querySelector('[data-testid="card-outdoor-compare"]');
    expect(cmp?.textContent).toContain('Lokaler Sensor');
    expect(cmp?.textContent).toContain('Wetterdienst');
    expect(
      container.querySelector('[data-testid="outdoor-sparkline"]')?.tagName.toLowerCase(),
    ).toBe('svg');
  });

  it('renders a comfort label and a blue sparkline on the indoor card', () => {
    const { container } = render(
      <IndoorTemperatureCard snapshot={v2Snapshot()} history={[22, 23]} />,
    );
    const comfort = container.querySelector('[data-testid="card-indoor-comfort"]');
    expect((comfort?.textContent ?? '').length).toBeGreaterThan(0);
    expect(
      container.querySelector('[data-testid="indoor-sparkline"]')?.tagName.toLowerCase(),
    ).toBe('svg');
  });
});
