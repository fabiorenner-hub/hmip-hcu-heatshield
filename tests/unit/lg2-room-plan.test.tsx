// @vitest-environment jsdom
/**
 * Heat Shield — "Tagesplan" (24h room plan) render test (bug report item 6).
 * Verifies the per-room plan renders the forecast curve, the planned decisions
 * with their reasons, and stays crash-free with realistic snapshot data.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/preact';
import { h } from 'preact';

import { RoomPlan24h } from '../../src/plugin/dashboard/spa/components/liquidglass2/roomPlan24h.js';
import { snapshot } from '../../src/plugin/dashboard/spa/store.js';
import { setExpertMode } from '../../src/plugin/dashboard/spa/expertMode.js';
import { __resetConfigStateForTests } from '../../src/plugin/dashboard/spa/hooks/useConfig.js';
import type { DashboardSnapshot } from '../../src/plugin/dashboard/spa/types.js';

function installFetch(): void {
  const now = Date.now();
  const iso = (h2: number): string => new Date(now + h2 * 3600_000).toISOString();
  const impl = async (input: unknown): Promise<unknown> => {
    const url = typeof input === 'string' ? input : String(input);
    if (url.includes('/api/config')) {
      return {
        ok: true, status: 200,
        json: async (): Promise<unknown> => ({
          rules: {
            comfort: { maxIndoorTempC: 26 },
            planning: { horizonHours: 24, timeStepMinutes: 15, deviationToleranceC: 1.5, deviationToleranceLoad01: 0.15, plannedMinSecondsBetweenMoves: 10800, movementBudgetPerInterval: 1, candidateLevels01: [0, 0.5, 1] },
          },
          windows: [{ id: 'w1', roomId: 'r1', type: 'facade', orientationDeg: 135 }],
        }),
      };
    }
    if (url.includes('/api/forecast')) {
      return {
        ok: true, status: 200,
        json: async (): Promise<unknown> => [
          {
            roomId: 'r1', hours: 24, uncertain: false, confidence01: 0.7,
            points: Array.from({ length: 25 }, (_, i) => ({ ts: iso(i), indoorTempC: 22 + Math.sin(i / 4) * 4, heatLoad01: 0.4 })),
          },
        ],
      };
    }
    throw new Error(`unmatched fetch: ${url}`);
  };
  (globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(impl) as unknown as typeof fetch;
}

function snap(): DashboardSnapshot {
  const now = Date.now();
  const iso = (h2: number): string => new Date(now + h2 * 3600_000).toISOString();
  return {
    ts: new Date(now).toISOString(),
    mode: 'ACTIVE_HEAT_PROTECTION',
    rooms: [{ id: 'r1', name: 'Schlafzimmer' }],
    windows: [],
    sources: { fusionSolar: { sourceOk: true, lastSuccess: '', consecutiveFailures: 0 }, hcu: { connected: true } },
    userIntent: { paused: false, pauseUntil: null, vacation: false },
    storm: { holdUntil: null },
    pluginReadiness: 'READY',
    forecastTimeline: Array.from({ length: 25 }, (_, i) => ({ ts: iso(i), weatherIcon: 'sun', tempC: 18 + i * 0.2, radiationWm2: 400, precipitationOrCloud01: 0.2, pvForecastKw: 2 })),
    roomsDetail: [{ id: 'r1', name: 'Schlafzimmer', facade: 'S', shutterPercent: 0, indoorTempC: 23, trend: 'up', nextAction: null, status: 'recommended', windowId: 'w1' }],
    plannedActions: [
      { windowId: 'w1', scheduledTs: iso(3), targetPercent: 50, reason: 'Vorausschauende Position hält Komfort über den Horizont', state: 'scheduled' },
      { windowId: 'w1', scheduledTs: iso(9), targetPercent: 0, reason: 'Öffnen für Tageslicht – keine Wärmelast erwartet', state: 'scheduled' },
    ],
  } as unknown as DashboardSnapshot;
}

beforeEach(() => {
  __resetConfigStateForTests();
  snapshot.value = null;
  installFetch();
});

afterEach(() => {
  cleanup();
  setExpertMode(false);
  vi.restoreAllMocks();
});

describe('RoomPlan24h', () => {
  it('renders the plan chart (expert) and the planned decisions with reasons', async () => {
    setExpertMode(true); // the temperature/shutter chart is Expert-only now
    snapshot.value = snap();
    const { container, findByTestId } = render(<RoomPlan24h snap={snapshot.value} />);
    expect(container.querySelector('[data-testid="lg2-room-plan"]')).not.toBeNull();
    // Chart appears once the forecast fetch resolves (Expert view).
    await waitFor(() => {
      expect(container.querySelector('.lg2-plan__svg')).not.toBeNull();
    });
    const list = await findByTestId('lg2-plan-decisions');
    expect(list.querySelectorAll('.lg2-plan__decision').length).toBe(2);
    expect(list.textContent).toContain('50%');
  });

  it('hides the chart in the Basis view but still shows the planned decisions', async () => {
    setExpertMode(false);
    snapshot.value = snap();
    const { container, findByTestId } = render(<RoomPlan24h snap={snapshot.value} />);
    // Decisions still render (fetch-independent, from the snapshot).
    const list = await findByTestId('lg2-plan-decisions');
    expect(list.querySelectorAll('.lg2-plan__decision').length).toBe(2);
    // The SVG chart is NOT rendered in Basis (compact, no-scroll view).
    expect(container.querySelector('.lg2-plan__svg')).toBeNull();
  });
});
