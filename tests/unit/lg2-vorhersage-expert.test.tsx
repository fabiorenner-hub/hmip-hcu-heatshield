// @vitest-environment jsdom
/**
 * Liquid Glass V2 Vorhersage — expert expansion (ui-v2-release, Task 9.3):
 * forecast quality/calibration panel + reused sun-path plot.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import { h } from 'preact';

import { LiquidGlass2Vorhersage } from '../../src/plugin/dashboard/spa/components/liquidglass2/liquidGlass2Vorhersage.js';
import { snapshot } from '../../src/plugin/dashboard/spa/store.js';
import { setExpertMode } from '../../src/plugin/dashboard/spa/expertMode.js';
import type { DashboardSnapshot } from '../../src/plugin/dashboard/spa/types.js';

function snap(): DashboardSnapshot {
  const now = Date.now();
  const card = (h2: number): unknown => ({
    ts: new Date(now + h2 * 3600_000).toISOString(),
    weatherIcon: 'sun', tempC: 28 + h2, radiationWm2: 600, precipitationOrCloud01: 0.2, pvForecastKw: 3.2,
  });
  return {
    ts: new Date(now).toISOString(),
    mode: 'ACTIVE_HEAT_PROTECTION',
    rooms: [],
    windows: [],
    sources: { fusionSolar: { sourceOk: true, lastSuccess: '', consecutiveFailures: 0 }, hcu: { connected: true } },
    userIntent: { paused: false, pauseUntil: null, vacation: false },
    storm: { holdUntil: null },
    pluginReadiness: 'READY',
    forecastTimeline: [card(0), card(1), card(2)],
    impact: { comfortShareToday01: 0.82, avgMovesPerDay: 2.1, calibratedRooms: 3, tunedRooms: 1, learnDays: 6, forecastAccuracyC: 0.9 },
    roomsDetail: [],
    trajectories: {
      indoorForecastWithShade: [{ ts: new Date(now).toISOString(), tempC: 24 }, { ts: new Date(now + 3600_000).toISOString(), tempC: 25 }],
      indoorForecastNoShade: [{ ts: new Date(now).toISOString(), tempC: 26 }, { ts: new Date(now + 3600_000).toISOString(), tempC: 27 }],
      heatLoadForecast: [{ ts: new Date(now).toISOString(), load01: 0.4 }, { ts: new Date(now + 3600_000).toISOString(), load01: 0.5 }],
    },
    precipNowcast: [
      { ts: new Date(now).toISOString(), precipMm: 0.2 },
      { ts: new Date(now + 900_000).toISOString(), precipMm: 0.5 },
    ],
  } as unknown as DashboardSnapshot;
}

afterEach(() => {
  cleanup();
  snapshot.value = null;
  setExpertMode(false);
});

describe('LiquidGlass2Vorhersage expert', () => {
  it('shows the forecast-quality panel and sun-path plot in expert mode', () => {
    snapshot.value = snap();
    setExpertMode(true);
    const { container } = render(<LiquidGlass2Vorhersage />);
    expect(container.querySelector('[data-testid="lg2-expert-forecast-quality"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="lg2-expert-sunpath"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="lg2-expert-sunpath"] svg')).not.toBeNull();
  });

  it('hides the expert panels in basic mode', () => {
    snapshot.value = snap();
    setExpertMode(false);
    const { container } = render(<LiquidGlass2Vorhersage />);
    expect(container.querySelector('[data-testid="lg2-expert-forecast-quality"]')).toBeNull();
    expect(container.querySelector('[data-testid="lg2-expert-sunpath"]')).toBeNull();
  });

  // Regression: the precipitation-nowcast table must render in expert mode.
  // A local `const h` used to shadow the Preact `h` JSX pragma, so as soon as
  // the snapshot carried precipNowcast data the tab crashed with
  // "h is not a function" (minified: "l is not a function").
  it('renders the precipitation nowcast table without crashing in expert mode', () => {
    snapshot.value = snap();
    setExpertMode(true);
    const { container } = render(<LiquidGlass2Vorhersage />);
    expect(container.querySelector('[data-testid="lg2-expert-nowcast"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="lg2-expert-trajectory"]')).not.toBeNull();
  });
});
