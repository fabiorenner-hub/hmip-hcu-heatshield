// @vitest-environment jsdom
/**
 * Regression: the 24h "Tagesplan" (RoomPlan24h) must correctly parse the
 * `/api/forecast` response. The server answers with `{ forecasts: [...] }`
 * (an object), but the client used to call `json.find(...)` directly on the
 * object → "O.find is not a function" (minified) and the plan never loaded.
 * The fix reads `json.forecasts` (and defensively accepts a bare array).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/preact';
import { h } from 'preact';

import { RoomPlan24h } from '../../src/plugin/dashboard/spa/components/liquidglass2/roomPlan24h.js';
import type { DashboardSnapshot } from '../../src/plugin/dashboard/spa/types.js';

function snap(): DashboardSnapshot {
  const now = Date.now();
  return {
    ts: new Date(now).toISOString(),
    mode: 'ACTIVE_HEAT_PROTECTION',
    rooms: [],
    windows: [],
    sources: { fusionSolar: { sourceOk: true, lastSuccess: '', consecutiveFailures: 0 }, hcu: { connected: true } },
    userIntent: { paused: false, pauseUntil: null, vacation: false },
    storm: { holdUntil: null },
    pluginReadiness: 'READY',
    forecastTimeline: [],
    roomsDetail: [{ id: 'schlafzimmer', name: 'Schlafzimmer', trend: 'up' }],
    plannedActions: [],
  } as unknown as DashboardSnapshot;
}

function forecastPoints(): Array<{ ts: string; indoorTempC: number; heatLoad01: number }> {
  const now = Date.now();
  return Array.from({ length: 6 }, (_v, i) => ({
    ts: new Date(now + i * 3600_000).toISOString(),
    indoorTempC: 24 + i * 0.5,
    heatLoad01: 0.2 + i * 0.05,
  }));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Minimal config so the useConfig() round-trip doesn't crash the component. */
function configBody(): unknown {
  return { windows: [], rooms: [], rules: { planning: { horizonHours: 24 } } };
}

/** URL-aware fetch mock: config for /api/config, forecasts for /api/forecast. */
function stubFetch(forecastResponse: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      const body = url.includes('/api/forecast') ? forecastResponse : configBody();
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
}

describe('RoomPlan24h /api/forecast parsing', () => {
  it('parses the { forecasts: [...] } object without crashing and renders the chart', async () => {
    stubFetch({ forecasts: [{ roomId: 'schlafzimmer', points: forecastPoints(), confidence01: 0.8 }] });

    const { container } = render(<RoomPlan24h snap={snap()} />);

    await waitFor(() => {
      // No error state, and the SVG chart actually rendered from the points.
      expect(container.querySelector('[data-testid="lg2-plan-error"]')).toBeNull();
      expect(container.querySelector('[data-testid="lg2-room-plan"] svg')).not.toBeNull();
    });
  });

  it('also accepts a bare array response (defensive contract fallback)', async () => {
    stubFetch([{ roomId: 'schlafzimmer', points: forecastPoints(), confidence01: 0.5 }]);

    const { container } = render(<RoomPlan24h snap={snap()} />);

    await waitFor(() => {
      expect(container.querySelector('[data-testid="lg2-plan-error"]')).toBeNull();
      expect(container.querySelector('[data-testid="lg2-room-plan"] svg')).not.toBeNull();
    });
  });
});
