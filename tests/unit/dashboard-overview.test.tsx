// @vitest-environment jsdom
/**
 * Unit tests for the 360° overview panel and the per-window sun card
 * (Tasks 3.4 / 4.3).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import { h } from 'preact';

import { OverviewPanel } from '../../src/plugin/dashboard/spa/components/overviewPanel.js';
import { WindowSunCard } from '../../src/plugin/dashboard/spa/components/windowSunCard.js';
import { snapshot } from '../../src/plugin/dashboard/spa/store.js';
import type { DashboardSnapshot } from '../../src/plugin/dashboard/spa/types.js';
import type { Window as WindowDef } from '../../src/shared/types.js';

function baseSnapshot(): DashboardSnapshot {
  return {
    ts: '2026-06-21T10:00:00.000Z',
    mode: 'NORMAL',
    rooms: [],
    windows: [],
    sources: {
      fusionSolar: { sourceOk: true, lastSuccess: null, consecutiveFailures: 0 },
      hcu: { connected: true },
    },
    userIntent: { paused: false, pauseUntil: null, vacation: false },
    storm: { holdUntil: null },
    pluginReadiness: 'READY',
    automationEnabled: true,
  };
}

const WINDOW: WindowDef = {
  id: 'w1',
  roomId: 'r1',
  shutterDeviceId: 'dev-shutter-5682',
  automationBlocked: false,
  orientationDeg: 135,
  type: 'roof_window',
  isDoor: false,
  canMoveWhenOpen: true,
  maxPositionWhenOpenPct: 60,
  sunPrelookMinutes: 60,
  lockoutProtection: true,
};

afterEach(() => {
  cleanup();
  snapshot.value = null;
});

describe('OverviewPanel', () => {
  it('renders a value tile with a fresh dot when the signal is present', () => {
    snapshot.value = {
      ...baseSnapshot(),
      signals: {
        outdoorTemp: { value: 24.3, ts: '2026-06-21T10:00:00Z', state: 'fresh' },
        pvPower: { value: 3.2, ts: null, state: 'fresh' },
        windSpeed: { value: 2, ts: null, state: 'fresh' },
        radiation: { value: 500, ts: null, state: 'fresh' },
        forecastMaxTemp: { value: 30, ts: null, state: 'fresh' },
        forecastCloudCover: { value: 10, ts: null, state: 'fresh' },
      },
      sun: { azimuthDeg: 135, elevationDeg: 42 },
    };
    const { getByTestId } = render(<OverviewPanel />);
    expect(getByTestId('overview-tile-outdoor').textContent).toContain('24.3 °C');
    expect(getByTestId('overview-tile-outdoor-dot').getAttribute('data-state')).toBe(
      'fresh',
    );
    expect(getByTestId('overview-tile-sun').textContent).toContain('Höhe 42°');
  });

  it('shows a "–" assign prompt when a signal value is null', () => {
    snapshot.value = {
      ...baseSnapshot(),
      signals: {
        outdoorTemp: { value: null, ts: null, state: 'unknown' },
        pvPower: { value: null, ts: null, state: 'unknown' },
        windSpeed: { value: null, ts: null, state: 'unknown' },
        radiation: { value: null, ts: null, state: 'unknown' },
        forecastMaxTemp: { value: null, ts: null, state: 'unknown' },
        forecastCloudCover: { value: null, ts: null, state: 'unknown' },
      },
      sun: { azimuthDeg: 0, elevationDeg: -5 },
    };
    const { getByTestId } = render(<OverviewPanel />);
    expect(getByTestId('overview-tile-outdoor-missing')).toBeTruthy();
  });

  it('renders without crashing when the snapshot has no signals block', () => {
    snapshot.value = baseSnapshot();
    const { getByTestId } = render(<OverviewPanel />);
    // tiles still present, all in the "–" state
    expect(getByTestId('overview-tile-wind-missing')).toBeTruthy();
  });
});

describe('WindowSunCard', () => {
  it('classifies a clearly-away orientation as "away" at night', () => {
    const { getByTestId } = render(
      <WindowSunCard
        window={WINDOW}
        latitude={52.52}
        longitude={13.41}
        minElevationDeg={5}
        maxIncidenceAngleFacadeDeg={90}
        maxIncidenceAngleRoofDeg={95}
        now={new Date('2026-06-21T00:00:00Z')}
      />,
    );
    expect(getByTestId('window-sun-card-w1').getAttribute('data-status')).toBe('away');
  });

  it('shows the compass orientation label', () => {
    const { getByTestId } = render(
      <WindowSunCard
        window={WINDOW}
        latitude={52.52}
        longitude={13.41}
        minElevationDeg={5}
        maxIncidenceAngleFacadeDeg={90}
        maxIncidenceAngleRoofDeg={95}
        now={new Date('2026-06-21T00:00:00Z')}
      />,
    );
    expect(getByTestId('window-sun-card-w1').textContent).toContain('SO');
  });
});
