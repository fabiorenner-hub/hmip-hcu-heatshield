// @vitest-environment jsdom
/**
 * SPA tests for the learning loop UI (Task 14.2).
 *
 * Exercises the recommendation banner + panel inside the Live tab
 * by mocking `globalThis.fetch` to return a learning snapshot, and
 * by asserting that the apply button fires a POST to the apply
 * endpoint and refreshes the snapshot.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { h } from 'preact';

import { LiveTab } from '../../src/plugin/dashboard/spa/tabs/live.js';
import {
  __resetLearningStateForTests,
  type LearningSnapshot,
} from '../../src/plugin/dashboard/spa/hooks/useLearning.js';
import {
  setRiskBreakdowns,
  snapshot,
} from '../../src/plugin/dashboard/spa/store.js';
import type { DashboardSnapshot } from '../../src/plugin/dashboard/spa/types.js';

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

const FIXTURE_SNAPSHOT: DashboardSnapshot = {
  ts: '2026-06-21T12:00:00.000Z',
  mode: 'NORMAL',
  rooms: [],
  windows: [],
  sources: {
    fusionSolar: {
      sourceOk: true,
      lastSuccess: '2026-06-21T12:00:00.000Z',
      consecutiveFailures: 0,
    },
    hcu: { connected: true },
  },
  userIntent: { paused: false, pauseUntil: null, vacation: false },
  storm: { holdUntil: null },
  pluginReadiness: 'READY',
};

const WARN_REC = {
  id: 'lowGain-schlafzimmer',
  roomId: 'schlafzimmer',
  severity: 'warn' as const,
  title: 'Vorausschauzeit erhöhen',
  message: 'Hitzeschutz wirkt zu schwach.',
  createdAt: '2026-06-21T20:00:00.000Z',
  suggestedConfigPatch: {
    path: ['windows', 0, 'sunPrelookMinutes'] as (string | number)[],
    from: 60 as unknown,
    to: 90 as unknown,
  },
};

const WARN_SNAPSHOT: LearningSnapshot = {
  computedAt: '2026-06-21T20:00:00.000Z',
  metrics: [],
  recommendations: [WARN_REC],
};

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function installFetchMock(
  responder: (call: FetchCall) => Response | Promise<Response>,
): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const call: FetchCall = init === undefined ? { url } : { url, init };
    calls.push(call);
    return responder(call);
  });
  globalThis.fetch = fakeFetch as unknown as typeof globalThis.fetch;
  return { calls };
}

function jsonResponse(payload: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// Suite.
// ---------------------------------------------------------------------------

beforeEach(() => {
  __resetLearningStateForTests();
  snapshot.value = FIXTURE_SNAPSHOT;
  setRiskBreakdowns([]);
});

afterEach(() => {
  cleanup();
  __resetLearningStateForTests();
  snapshot.value = null;
  setRiskBreakdowns([]);
  vi.restoreAllMocks();
});

describe('LiveTab — recommendation banner (Task 14.2)', () => {
  it('renders the banner once a warn recommendation arrives', async () => {
    installFetchMock(({ url }) => {
      if (url === '/api/learn/snapshot') {
        return jsonResponse(WARN_SNAPSHOT);
      }
      return jsonResponse({ error: 'unexpected' }, 404);
    });
    const { container } = render(<LiveTab />);
    await waitFor(() => {
      expect(
        container.querySelector('[data-testid="recommendation-banner"]'),
      ).not.toBeNull();
    });
    const panel = container.querySelector(
      '[data-testid="recommendation-panel"]',
    );
    expect(panel).not.toBeNull();
    const item = container.querySelector(
      '[data-testid="recommendation-lowGain-schlafzimmer"]',
    );
    expect(item).not.toBeNull();
    const patchTo = container.querySelector('[data-testid="patch-to"]');
    expect(patchTo?.textContent).toBe('90');
  });

  it('hides the banner when the snapshot has no warn recommendations', async () => {
    installFetchMock(({ url }) => {
      if (url === '/api/learn/snapshot') {
        return jsonResponse({
          computedAt: '2026-06-21T20:00:00.000Z',
          metrics: [],
          recommendations: [
            {
              ...WARN_REC,
              id: 'highGain-schlafzimmer',
              severity: 'info',
              title: 'Hitzeschutz wirkt deutlich',
              suggestedConfigPatch: undefined,
            },
          ],
        });
      }
      return jsonResponse({ error: 'unexpected' }, 404);
    });
    const { container } = render(<LiveTab />);
    // Wait for the panel to render — the banner is conditional, the
    // panel always renders when at least one rec exists.
    await waitFor(() => {
      expect(
        container.querySelector('[data-testid="recommendation-panel"]'),
      ).not.toBeNull();
    });
    expect(
      container.querySelector('[data-testid="recommendation-banner"]'),
    ).toBeNull();
  });

  it('hides the panel entirely when learning endpoint returns 503', async () => {
    installFetchMock(({ url }) => {
      if (url === '/api/learn/snapshot') {
        return jsonResponse(
          { error: { code: 'learning_unavailable', message: 'no' } },
          503,
        );
      }
      return jsonResponse({ error: 'unexpected' }, 404);
    });
    const { container } = render(<LiveTab />);
    // Give the fetch a tick to resolve.
    await new Promise((r) => setTimeout(r, 10));
    expect(
      container.querySelector('[data-testid="recommendation-panel"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="recommendation-banner"]'),
    ).toBeNull();
  });
});

describe('LiveTab — apply button (Task 14.2)', () => {
  it('fires POST /api/learn/recommendations/:id/apply when the user clicks Anwenden', async () => {
    let snapshotCallCount = 0;
    const { calls } = installFetchMock(async ({ url, init }) => {
      if (url === '/api/learn/snapshot') {
        snapshotCallCount += 1;
        return jsonResponse(WARN_SNAPSHOT);
      }
      if (
        url === '/api/learn/recommendations/lowGain-schlafzimmer/apply' &&
        init?.method === 'POST'
      ) {
        return jsonResponse({
          ok: true,
          appliedPatch: WARN_REC.suggestedConfigPatch,
        });
      }
      return jsonResponse({ error: 'unexpected' }, 404);
    });
    const { container } = render(<LiveTab />);
    await waitFor(() => {
      expect(
        container.querySelector('[data-testid="apply-lowGain-schlafzimmer"]'),
      ).not.toBeNull();
    });
    const applyBtn = container.querySelector(
      '[data-testid="apply-lowGain-schlafzimmer"]',
    ) as HTMLButtonElement;
    fireEvent.click(applyBtn);

    await waitFor(() => {
      const applyCall = calls.find(
        (c) =>
          c.url ===
            '/api/learn/recommendations/lowGain-schlafzimmer/apply' &&
          c.init?.method === 'POST',
      );
      expect(applyCall).toBeDefined();
    });
    // Snapshot is re-fetched after the apply succeeds.
    await waitFor(() => {
      expect(snapshotCallCount).toBeGreaterThanOrEqual(2);
    });
  });
});
