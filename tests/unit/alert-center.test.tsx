// @vitest-environment jsdom
/**
 * AlertCenter — the temporary "Katastrophenschutz-Zentrale". Renders only when
 * an active DWD warning of level ≥ 3 is present, and surfaces the warning copy
 * plus the live safety metrics (thunderstorm / wind / precipitation).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import { h } from 'preact';

import { AlertCenter } from '../../src/plugin/dashboard/spa/components/dashboard/alertCenter.js';
import { snapshot } from '../../src/plugin/dashboard/spa/store.js';
import type { DashboardSnapshot, WeatherAlert } from '../../src/plugin/dashboard/spa/types.js';

const NOW = new Date('2026-06-27T16:00:00.000Z');

function withAlert(alert: WeatherAlert | undefined): DashboardSnapshot {
  return {
    ts: NOW.toISOString(),
    mode: 'HEATWAVE',
    environment: {
      radiationWm2: { value: 200, origin: 'forecast', source: 'OpenMeteo', confidence01: 0.9 },
      uvIndex: { value: 3, origin: 'forecast', source: 'OpenMeteo', confidence01: 0.9 },
      windMs: { value: 18, origin: 'forecast', source: 'OpenMeteo', confidence01: 0.9 },
      humidity01: { value: 0.6, origin: 'measured', source: 'OpenMeteo', confidence01: 0.9 },
    },
    precipNowcast: [
      { ts: NOW.toISOString(), precipMm: 1.2 },
      { ts: new Date(NOW.getTime() + 900_000).toISOString(), precipMm: 0.8 },
    ],
    ...(alert !== undefined ? { weatherAlert: alert } : {}),
  } as unknown as DashboardSnapshot;
}

const activeAlert: WeatherAlert = {
  active: true,
  maxLevel: 3,
  region: 'Musterstadt',
  updatedTs: NOW.toISOString(),
  warnings: [
    {
      level: 3,
      event: 'GEWITTER',
      headline: 'Amtliche UNWETTERWARNUNG vor schwerem Gewitter',
      description: 'Schwere Gewitter mit Starkregen.',
      instruction: 'Suchen Sie geschützte Bereiche auf.',
      start: NOW.toISOString(),
      end: new Date(NOW.getTime() + 3 * 3_600_000).toISOString(),
    },
  ],
};

afterEach(() => {
  cleanup();
  snapshot.value = null;
});

describe('AlertCenter', () => {
  it('renders nothing when there is no active alert', () => {
    snapshot.value = withAlert(undefined);
    const { container } = render(h(AlertCenter, { latitude: 52.52, longitude: 13.41, surface: 'dashboard' }));
    expect(container.querySelector('[data-testid="alert-center"]')).toBeNull();
  });

  it('renders nothing when a warning is below level 3 (active=false)', () => {
    snapshot.value = withAlert({ ...activeAlert, active: false, maxLevel: 2 });
    const { container } = render(h(AlertCenter, { latitude: 52.52, longitude: 13.41, surface: 'dashboard' }));
    expect(container.querySelector('[data-testid="alert-center"]')).toBeNull();
  });

  it('renders the alert center with warning + live metrics when active', () => {
    snapshot.value = withAlert(activeAlert);
    const { container } = render(h(AlertCenter, { latitude: 52.52, longitude: 13.41, surface: 'dashboard' }));
    const center = container.querySelector('[data-testid="alert-center"]');
    expect(center).not.toBeNull();
    expect(center?.getAttribute('data-level')).toBe('3');
    // Behavioural advice (DWD instruction) is shown.
    expect(center?.textContent ?? '').toContain('Suchen Sie geschützte Bereiche auf.');
    // Live metrics: thunderstorm active, wind in km/h (18 m/s ≈ 65 km/h), precip sum.
    const metrics = container.querySelector('[data-testid="alert-metrics"]');
    expect(metrics?.textContent ?? '').toContain('65 km/h');
    expect(metrics?.textContent ?? '').toMatch(/aktiv|active/);
  });

  it('shows the compact radar only when showRadar is set', () => {
    snapshot.value = withAlert(activeAlert);
    const { container } = render(
      h(AlertCenter, { latitude: 52.52, longitude: 13.41, surface: 'dashboard', showRadar: true }),
    );
    expect(container.querySelector('[data-testid="alert-radar"]')).not.toBeNull();
  });
});
