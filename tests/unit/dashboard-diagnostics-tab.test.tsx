// @vitest-environment jsdom
/**
 * Unit tests for the Diagnose tab (Tasks 13.1 / 13.2 / 13.3).
 *
 * Mirrors the structural style of `dashboard-config-tabs.test.tsx`:
 * each case installs a stub `globalThis.fetch`, renders the
 * component through `@testing-library/preact`, and asserts on
 * `data-testid` selectors. Side effects on `Blob` and
 * `URL.createObjectURL` are mocked at the global level so the JSON
 * export path can be observed without a real DOM download.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from '@testing-library/preact';
import { h } from 'preact';

import { DiagnosticsTab } from '../../src/plugin/dashboard/spa/tabs/diagnostics.js';

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

interface DecisionRow {
  ts: string;
  cycleId: string;
  payload: {
    cycleId: string;
    ts: string;
    mode: string;
    windowDecisions: Array<{
      windowId: string;
      factors: Record<string, number>;
      risk: number;
      rawTarget: number;
      afterSpecialRules: number;
      afterSafety: number;
      finalTarget: number;
      moved: boolean;
      blockedBy?: string;
    }>;
  };
}

function makeDecisions(): DecisionRow[] {
  return [
    {
      ts: '2026-06-21T12:00:00.000Z',
      cycleId: 'cycle-001',
      payload: {
        cycleId: 'cycle-001',
        ts: '2026-06-21T12:00:00.000Z',
        mode: 'NORMAL',
        windowDecisions: [
          {
            windowId: 'fenster-1',
            factors: { sunFactor: 0.5 },
            risk: 0.5,
            rawTarget: 0.7,
            afterSpecialRules: 0.7,
            afterSafety: 0.7,
            finalTarget: 0.7,
            moved: true,
          },
        ],
      },
    },
    {
      ts: '2026-06-21T12:01:00.000Z',
      cycleId: 'cycle-002',
      payload: {
        cycleId: 'cycle-002',
        ts: '2026-06-21T12:01:00.000Z',
        mode: 'STORM',
        windowDecisions: [
          {
            windowId: 'fenster-1',
            factors: {},
            risk: 0,
            rawTarget: 0,
            afterSpecialRules: 0,
            afterSafety: 0,
            finalTarget: 0,
            moved: true,
            blockedBy: 'storm',
          },
        ],
      },
    },
    {
      ts: '2026-06-21T12:02:00.000Z',
      cycleId: 'cycle-003',
      payload: {
        cycleId: 'cycle-003',
        ts: '2026-06-21T12:02:00.000Z',
        mode: 'ACTIVE_HEAT_PROTECTION',
        windowDecisions: [
          {
            windowId: 'fenster-2',
            factors: { sunFactor: 0.9 },
            risk: 0.9,
            rawTarget: 1,
            afterSpecialRules: 1,
            afterSafety: 1,
            finalTarget: 1,
            moved: true,
          },
        ],
      },
    },
  ];
}

function makeConnectLog(): Array<{
  ts: string;
  level: string;
  msg: string;
  ctx?: Record<string, unknown>;
}> {
  return [
    { ts: '2026-06-21T11:59:00.000Z', level: 'info', msg: 'connect open' },
    { ts: '2026-06-21T11:59:30.000Z', level: 'warn', msg: 'reconnect' },
    {
      ts: '2026-06-21T12:00:00.000Z',
      level: 'error',
      msg: 'send failed',
      ctx: { code: 'ECONNRESET' },
    },
  ];
}

function makeProbeResult(): {
  mode: string;
  windowDecisions: Array<{
    windowId: string;
    factors: Record<string, number>;
    risk: number;
    rawTarget: number;
    afterSpecialRules: number;
    afterSafety: number;
    finalTarget: number;
    moved: boolean;
  }>;
  ts: string;
  cycleId: string;
} {
  return {
    mode: 'ACTIVE_HEAT_PROTECTION',
    windowDecisions: [
      {
        windowId: 'fenster-1',
        factors: { sunFactor: 0.6 },
        risk: 0.6,
        rawTarget: 0.8,
        afterSpecialRules: 0.8,
        afterSafety: 0.8,
        finalTarget: 0.8,
        moved: false,
      },
    ],
    ts: '2026-06-21T12:05:00.000Z',
    cycleId: 'probe-001',
  };
}

// ---------------------------------------------------------------------------
// Mock fetch — same shape as the config-tabs test.
// ---------------------------------------------------------------------------

interface MockFetchEntry {
  url: RegExp;
  method?: string;
  status?: number;
  body: unknown;
}

function makeMockFetch(entries: MockFetchEntry[]): ReturnType<typeof vi.fn> {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const impl = async (input: unknown, init?: unknown): Promise<unknown> => {
    const url =
      typeof input === 'string'
        ? input
        : (input as { toString(): string }).toString();
    const initObj = (init ?? {}) as { method?: string; body?: unknown };
    const method = initObj.method ?? 'GET';
    calls.push({
      url,
      method,
      ...(typeof initObj.body === 'string' ? { body: initObj.body } : {}),
    });
    for (const e of entries) {
      if (e.url.test(url) && (e.method === undefined || e.method === method)) {
        return {
          ok: (e.status ?? 200) < 400,
          status: e.status ?? 200,
          json: async (): Promise<unknown> => e.body,
        };
      }
    }
    throw new Error(`unmatched fetch: ${method} ${url}`);
  };
  const fn = vi.fn(impl) as unknown as ReturnType<typeof vi.fn>;
  (fn as unknown as { __calls: typeof calls }).__calls = calls;
  return fn;
}

function installMockFetch(entries: MockFetchEntry[]): ReturnType<typeof vi.fn> {
  const fn = makeMockFetch(entries);
  (globalThis as unknown as { fetch: typeof fetch }).fetch =
    fn as unknown as typeof fetch;
  return fn;
}

// ---------------------------------------------------------------------------
// Lifecycle.
// ---------------------------------------------------------------------------

beforeEach(() => {
  // jsdom does not provide Blob / URL.createObjectURL with full
  // download semantics, but it does provide Blob in recent versions.
  // We replace both with deterministic spies so the JSON export
  // case can assert against them.
  const blobCtorSpy = vi.fn(
    (parts?: BlobPart[], opts?: BlobPropertyBag) =>
      new (Object.getPrototypeOf((globalThis as { Blob: typeof Blob }).Blob)
        .constructor)(parts ?? [], opts),
  );
  void blobCtorSpy; // not used directly; we patch the global below.

  // Patch the global Blob constructor so we can observe calls.
  const realBlob = (globalThis as { Blob: typeof Blob }).Blob;
  const trackedBlob = vi.fn((parts?: BlobPart[], opts?: BlobPropertyBag) => {
    return new realBlob(parts ?? [], opts);
  });
  (globalThis as unknown as { Blob: unknown }).Blob =
    trackedBlob as unknown as typeof Blob;

  // Patch URL.createObjectURL / revokeObjectURL — jsdom does not
  // implement them, so we must define both.
  (URL as unknown as { createObjectURL: ReturnType<typeof vi.fn> }).createObjectURL =
    vi.fn(() => 'blob:mock-url');
  (URL as unknown as { revokeObjectURL: ReturnType<typeof vi.fn> }).revokeObjectURL =
    vi.fn();

  // jsdom logs "Not implemented: navigation to another Document"
  // when an `<a download>` element is clicked. The export path
  // creates such an anchor; we stub its click handler to a no-op
  // so the warning does not pollute the test output. The Blob /
  // createObjectURL spies above are what we actually assert on.
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
    /* download-anchor click is a no-op in tests. */
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe('<DiagnosticsTab/> — three sections (Task 13)', () => {
  it('renders all three sections (decisions, connect log, probe)', async () => {
    installMockFetch([
      { url: /\/api\/decisions/, body: { records: makeDecisions() } },
      { url: /\/api\/connect\/log/, body: { entries: makeConnectLog() } },
    ]);
    await act(async () => {
      render(<DiagnosticsTab />);
    });
    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="diag-decisions"]'),
      ).not.toBeNull(),
    );
    expect(
      document.querySelector('[data-testid="diag-connect-log"]'),
    ).not.toBeNull();
    expect(document.querySelector('[data-testid="diag-probe"]')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Task 13.1 — decision records table.
// ---------------------------------------------------------------------------

describe('<DiagnosticsTab/> — decision records (Task 13.1)', () => {
  it('renders rows for every decision returned by /api/decisions', async () => {
    installMockFetch([
      { url: /\/api\/decisions/, body: { records: makeDecisions() } },
      { url: /\/api\/connect\/log/, body: { entries: [] } },
    ]);
    await act(async () => {
      render(<DiagnosticsTab />);
    });
    await waitFor(() =>
      expect(
        document.querySelector(
          '[data-testid="diag-decisions-row-cycle-001"]',
        ),
      ).not.toBeNull(),
    );
    expect(
      document.querySelector('[data-testid="diag-decisions-row-cycle-002"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="diag-decisions-row-cycle-003"]'),
    ).not.toBeNull();
    const count = document.querySelector(
      '[data-testid="diag-decisions-count"]',
    );
    expect(count?.textContent).toBe('3');
  });

  it('narrows the table to the selected mode via the filter', async () => {
    installMockFetch([
      { url: /\/api\/decisions/, body: { records: makeDecisions() } },
      { url: /\/api\/connect\/log/, body: { entries: [] } },
    ]);
    await act(async () => {
      render(<DiagnosticsTab />);
    });
    await waitFor(() =>
      expect(
        document.querySelector(
          '[data-testid="diag-decisions-row-cycle-001"]',
        ),
      ).not.toBeNull(),
    );

    const select = document.querySelector(
      '[data-testid="diag-decisions-filter-mode"]',
    ) as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(select, { target: { value: 'STORM' } });
    });

    // Only the STORM row should be visible after the filter.
    expect(
      document.querySelector('[data-testid="diag-decisions-row-cycle-002"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="diag-decisions-row-cycle-001"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="diag-decisions-row-cycle-003"]'),
    ).toBeNull();
    const count = document.querySelector(
      '[data-testid="diag-decisions-count"]',
    );
    expect(count?.textContent).toBe('1');
  });

  it('JSON export click invokes Blob and URL.createObjectURL', async () => {
    installMockFetch([
      { url: /\/api\/decisions/, body: { records: makeDecisions() } },
      { url: /\/api\/connect\/log/, body: { entries: [] } },
    ]);
    await act(async () => {
      render(<DiagnosticsTab />);
    });
    await waitFor(() =>
      expect(
        document.querySelector(
          '[data-testid="diag-decisions-row-cycle-001"]',
        ),
      ).not.toBeNull(),
    );

    const blobSpy = (globalThis as unknown as { Blob: ReturnType<typeof vi.fn> })
      .Blob;
    const createUrlSpy = (
      URL as unknown as { createObjectURL: ReturnType<typeof vi.fn> }
    ).createObjectURL;

    const exportBtn = document.querySelector(
      '[data-testid="diag-decisions-export"]',
    ) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(exportBtn);
    });

    expect(blobSpy).toHaveBeenCalledTimes(1);
    expect(createUrlSpy).toHaveBeenCalledTimes(1);
    // The Blob constructor was called with a JSON string + the
    // application/json content type — assert both for confidence.
    const callArgs = blobSpy.mock.calls[0]!;
    const parts = callArgs[0] as unknown as string[];
    const opts = callArgs[1] as { type?: string };
    expect(typeof parts[0]).toBe('string');
    expect((parts[0] as unknown as string).includes('cycle-001')).toBe(true);
    expect(opts.type).toBe('application/json');
  });
});

// ---------------------------------------------------------------------------
// Task 13.3 — Probelauf button hits POST /api/probe/run.
// ---------------------------------------------------------------------------

describe('<DiagnosticsTab/> — probe (Task 13.3)', () => {
  it('clicking "Run probe" issues POST /api/probe/run and renders the result', async () => {
    const fetchMock = installMockFetch([
      { url: /\/api\/decisions/, body: { records: makeDecisions() } },
      { url: /\/api\/connect\/log/, body: { entries: [] } },
      {
        url: /\/api\/probe\/run/,
        method: 'POST',
        body: makeProbeResult(),
      },
    ]);
    await act(async () => {
      render(<DiagnosticsTab />);
    });
    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="diag-probe-run"]'),
      ).not.toBeNull(),
    );

    const btn = document.querySelector(
      '[data-testid="diag-probe-run"]',
    ) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(btn);
    });

    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="diag-probe-mode"]'),
      ).not.toBeNull(),
    );

    const modeEl = document.querySelector('[data-testid="diag-probe-mode"]');
    expect(modeEl?.textContent).toBe('ACTIVE_HEAT_PROTECTION');
    const winEl = document.querySelector(
      '[data-testid="diag-probe-window-fenster-1"]',
    );
    expect(winEl).not.toBeNull();

    // POST hit was made.
    const calls = (
      fetchMock as unknown as {
        __calls: Array<{ url: string; method: string }>;
      }
    ).__calls;
    expect(
      calls.some((c) => /\/api\/probe\/run/.test(c.url) && c.method === 'POST'),
    ).toBe(true);
  });
});
