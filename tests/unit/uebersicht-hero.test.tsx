// @vitest-environment jsdom
/**
 * Übersicht hero + KPI row (Blueprint Phase 4).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import { h } from 'preact';

import { UebersichtHero, UebersichtKpis } from '../../src/plugin/dashboard/spa/components/dashboard/uebersichtHero.js';
import type { DashboardSnapshot } from '../../src/plugin/dashboard/spa/types.js';

function snap(over: Partial<DashboardSnapshot> = {}): DashboardSnapshot {
  const now = new Date().toISOString();
  return {
    ts: now,
    mode: 'ACTIVE_HEAT_PROTECTION',
    rooms: [],
    windows: [],
    sources: { fusionSolar: { sourceOk: true, lastSuccess: now, consecutiveFailures: 0 }, hcu: { connected: true } },
    userIntent: { paused: false, pauseUntil: null, vacation: false },
    storm: { holdUntil: null },
    pluginReadiness: 'READY',
    modeInfo: { id: 'active', label: 'Aktiver Hitzeschutz', goal: '', reasons: [] },
    facades: { N: 10, E: 40, S: 80, W: 20 },
    ventilation: { overall: { level: 'air_now', headline: '', detail: '' }, rooms: [] },
    precipNowcast: [
      { ts: now, precipMm: 0.5 },
      { ts: now, precipMm: 0.7 },
    ],
    impact: { comfortShareToday01: null, avgMovesPerDay: null, calibratedRooms: 0, tunedRooms: 0, learnDays: 3, forecastAccuracyC: 1.2 },
    trajectories: {
      indoorForecastWithShade: [{ ts: now, tempC: 25 }],
      indoorForecastNoShade: [{ ts: now, tempC: 27 }],
      heatLoadForecast: [],
    },
    ...over,
  } as DashboardSnapshot;
}

afterEach(cleanup);

describe('UebersichtHero', () => {
  it('shows the avoided-warming benefit and heat-protection tone', () => {
    const { container } = render(<UebersichtHero snapshot={snap()} />);
    const hero = container.querySelector('[data-testid="uebersicht-hero"]')!;
    expect(hero.getAttribute('data-tone')).toBe('active');
    expect(container.querySelector('[data-testid="hero-benefit"]')!.textContent).toContain('2.0');
  });

  it('uses an alert tone during a storm hold', () => {
    const { container } = render(
      <UebersichtHero snapshot={snap({ mode: 'NORMAL', storm: { holdUntil: new Date(Date.now() + 3600_000).toISOString() } })} />,
    );
    expect(container.querySelector('[data-testid="uebersicht-hero"]')!.getAttribute('data-tone')).toBe('alert');
  });
});

describe('UebersichtKpis', () => {
  it('renders the four decision KPIs from the snapshot', () => {
    const { container } = render(<UebersichtKpis snapshot={snap()} />);
    expect(container.querySelector('[data-testid="kpi-avoided"]')!.textContent).toContain('2.0 °C');
    const solar = container.querySelector('[data-testid="kpi-solar"]')!;
    expect(solar.textContent).toContain('80 %');
    expect(solar.textContent).toContain('Süd');
    expect(container.querySelector('[data-testid="kpi-vent"]')!.textContent).toContain('Jetzt lüften');
    expect(container.querySelector('[data-testid="kpi-rain"]')!.textContent).toContain('1.2 mm');
  });

  it('degrades to – when sources are missing', () => {
    const bare = snap({ facades: undefined, ventilation: undefined, precipNowcast: undefined, trajectories: undefined, signals: undefined });
    const { container } = render(<UebersichtKpis snapshot={bare} />);
    expect(container.querySelector('[data-testid="kpi-avoided"]')!.textContent).toContain('–');
    expect(container.querySelector('[data-testid="kpi-solar"]')!.textContent).toContain('–');
  });
});
