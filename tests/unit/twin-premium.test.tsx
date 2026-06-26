// @vitest-environment jsdom
/**
 * Heat Shield — house-twin premium interactions (V4).
 *
 * Structural + interaction assertions for the redesigned twin: the control
 * chrome lives in a header bar above the image, a Schutz-Score ring renders
 * from per-room heat load, and the "Wärme" toggle tints the badges (no neon
 * glow) by adding the heat-band class.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, fireEvent } from '@testing-library/preact';
import { h } from 'preact';

import { DashboardGrid } from '../../src/plugin/dashboard/spa/components/dashboard/dashboardGrid.js';
import type { DashboardSnapshot } from '../../src/plugin/dashboard/spa/types.js';

const NOW = new Date('2026-06-21T10:00:00.000Z');

function snap(): DashboardSnapshot {
  return {
    ts: NOW.toISOString(),
    mode: 'ACTIVE_HEAT_PROTECTION',
    rooms: [{ id: 'r1', name: 'Schlafzimmer', tempC: 24 }],
    windows: [],
    sources: {
      fusionSolar: { sourceOk: true, lastSuccess: NOW.toISOString(), consecutiveFailures: 0 },
      hcu: { connected: true },
    },
    userIntent: { paused: false, pauseUntil: null, vacation: false },
    storm: { holdUntil: null },
    pluginReadiness: 'READY',
    automationEnabled: true,
    facades: { N: 5, E: 30, S: 88, W: 22 },
    environment: {
      radiationWm2: { value: 700, origin: 'forecast', source: 'OpenMeteo', confidence01: 0.9 },
      uvIndex: { value: 6, origin: 'estimated', source: 'OpenMeteo', confidence01: 0.4 },
      windMs: { value: 3, origin: 'forecast', source: 'OpenMeteo', confidence01: 0.9 },
      humidity01: { value: 0.4, origin: 'estimated', source: 'OpenMeteo', confidence01: 0.4 },
    },
    forecastTimeline: [
      { ts: NOW.toISOString(), weatherIcon: '☀️', tempC: 29, radiationWm2: 700, precipitationOrCloud01: 0.2 },
      { ts: new Date(NOW.getTime() + 2 * 3600_000).toISOString(), weatherIcon: '⛅', tempC: 31, radiationWm2: 600, precipitationOrCloud01: 0.3 },
    ],
    roomsDetail: [
      {
        id: 'r1',
        name: 'Schlafzimmer',
        floor: 'OG',
        facade: 'S',
        shutterPercent: 60,
        indoorTempC: 24,
        indoorTempState: 'fresh',
        trend: 'up',
        nextAction: null,
        status: 'scheduled',
        roof: false,
        heatLoad01: 0.6,
        shutterForecast: [
          { ts: NOW.toISOString(), percent: 40 },
          { ts: new Date(NOW.getTime() + 3600_000).toISOString(), percent: 70 },
        ],
      },
    ],
  };
}

afterEach(() => cleanup());

describe('House twin — premium V4', () => {
  it('renders the control header above the image with a Schutz-Score', () => {
    const { container } = render(
      <DashboardGrid snapshot={snap()} latitude={52.52} longitude={13.41} now={NOW} />,
    );
    // Header chrome moved out of the image into a wrapper above it.
    expect(container.querySelector('[data-testid="twin-wrap"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="twin-toolbar"]')).not.toBeNull();
    expect(container.querySelector('.twin-score')).not.toBeNull();
    expect(container.querySelector('[data-testid="room-badge-r1"]')).not.toBeNull();
  });

  it('tints badges by heat band when the Wärme toggle is on (no neon glow)', () => {
    const { container } = render(
      <DashboardGrid snapshot={snap()} latitude={52.52} longitude={13.41} now={NOW} />,
    );
    const badge = container.querySelector('[data-testid="room-badge-r1"]') as HTMLElement;
    expect(badge.className).not.toContain('room-badge--heat-');
    const toggle = container.querySelector('[data-testid="twin-heatmap-toggle"]') as HTMLElement;
    fireEvent.click(toggle);
    const badgeAfter = container.querySelector('[data-testid="room-badge-r1"]') as HTMLElement;
    // heatLoad01 = 0.6 → "high" band tint.
    expect(badgeAfter.className).toContain('room-badge--heat-high');
    const twin = container.querySelector('[data-testid="house-twin"]') as HTMLElement;
    expect(twin.className).toContain('house-twin--heatmap');
  });
});
