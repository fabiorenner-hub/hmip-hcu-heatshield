/**
 * Heat Shield — FusionSolar source adapter tests (Task 5.1).
 *
 * No real network. Every fetch is mocked; the polling clock is driven
 * by `vi.useFakeTimers` so the 30 s recurrence is deterministic.
 *
 * Coverage map:
 *   - success path + `getValue('activePower')` returns the captured
 *     `2474` after the first poll (Acceptance criteria).
 *   - polling cadence: a second mocked response is consumed after
 *     `pollIntervalMs` and `getValue` reflects the new sample.
 *   - 3-strikes failure ledger: three throwing fetches flip
 *     `sourceOk: true → false` and emit `sourceUnavailable` exactly
 *     once; the next success flips back and emits `sourceRecovered`.
 *   - timeout: a never-resolving fetch is aborted by the
 *     `AbortController` after `httpTimeoutMs` and counts as a failure.
 *   - 404 / non-2xx counts as a failure.
 *   - `Response.json()` rejection (SyntaxError-style) counts as a
 *     failure.
 *   - Schema-mismatch counts as a failure but does not propagate out
 *     of `start()` / `pollOnce()`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FusionSolarAdapter,
  type FusionField,
  type FusionSnapshotValue,
} from '../../src/plugin/sources/fusionSolar.js';
import { fusionSnapshotBody } from '../_fixtures/fusion-snapshot.js';

// ---------------------------------------------------------------------------
// Helpers — keep each test in sync with the public adapter surface.
// ---------------------------------------------------------------------------

type FetchFn = typeof globalThis.fetch;

/**
 * Minimal fake `Response`. Only the properties the adapter consumes
 * (`ok`, `status`, `json`) are populated; the rest of the
 * `Response` surface is intentionally not stubbed because exercising
 * it in the adapter would itself be a regression worth catching.
 */
function fakeResponse(init: {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}): Response {
  // Cast at the boundary: the adapter only uses the documented subset,
  // and a full DOM `Response` would force importing the `undici` types
  // into a unit test that has no business knowing about them.
  return init as unknown as Response;
}

/** Convenience: wrap a body literal in a successful `Response`. */
function ok(body: unknown): Response {
  return fakeResponse({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  });
}

/**
 * Build an adapter wired to a deterministic clock. The clock advances
 * via `vi.advanceTimersByTimeAsync`; `now()` reads `Date.now()` (which
 * vitest's fake timers also advance), so `observedAt` stamps line up
 * with the simulated wall clock.
 */
function makeAdapter(opts: {
  fetchFn: FetchFn;
  pollIntervalMs?: number;
  httpTimeoutMs?: number;
  failureThreshold?: number;
}): FusionSolarAdapter {
  return new FusionSolarAdapter({
    baseUrl: 'http://host.containers.internal:8088',
    pollIntervalMs: opts.pollIntervalMs ?? 30_000,
    httpTimeoutMs: opts.httpTimeoutMs ?? 5_000,
    failureThreshold: opts.failureThreshold ?? 3,
    fetchFn: opts.fetchFn,
    now: () => new Date(),
  });
}

/**
 * Yield to the microtask queue so an awaited fetch promise resolves
 * before the test assertions. Combined with `vi.advanceTimersByTimeAsync`
 * this gives deterministic control over the adapter's pipeline.
 */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Lifecycle.
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-06-21T10:00:00.000Z'));
});

afterEach(async () => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Cases.
// ---------------------------------------------------------------------------

describe('FusionSolarAdapter — success path', () => {
  it('decodes the realistic snapshot fixture and exposes activePower=2474', async () => {
    const fetchFn = vi.fn<FetchFn>(async () =>
      ok(structuredClone(fusionSnapshotBody)),
    );
    const adapter = makeAdapter({ fetchFn });

    await adapter.pollOnce();

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0]?.[0]).toBe(
      'http://host.containers.internal:8088/api/snapshot',
    );

    const active = adapter.getValue('activePower');
    expect(active).not.toBeNull();
    expect(active?.value).toBe(2474);

    // All six fields from the fixture are exposed.
    const fields: FusionField[] = [
      'inputPower',
      'activePower',
      'meterActivePower',
      'batterySoc',
      'batteryChargeDischargePower',
      'internalTemp',
    ];
    for (const f of fields) {
      expect(adapter.getValue(f)).not.toBeNull();
    }

    expect(adapter.getValue('inputPower')?.value).toBe(2484);
    expect(adapter.getValue('meterActivePower')?.value).toBe(-315);
    expect(adapter.getValue('batterySoc')?.value).toBe(100);
    expect(adapter.getValue('internalTemp')?.value).toBeCloseTo(46.6, 5);

    const status = adapter.getStatus();
    expect(status.sourceOk).toBe(true);
    expect(status.consecutiveFailures).toBe(0);
    expect(status.lastSuccess).toBeInstanceOf(Date);
    expect(status.lastError).toBeNull();
  });

  it('returns null for fields never seen yet', async () => {
    // Snapshot with values present but missing `internalTemp`.
    const partial = structuredClone(fusionSnapshotBody) as {
      snapshot: { values: Record<string, number | undefined> };
    };
    delete partial.snapshot.values.internalTemp;

    const fetchFn = vi.fn<FetchFn>(async () => ok(partial));
    const adapter = makeAdapter({ fetchFn });

    await adapter.pollOnce();

    expect(adapter.getValue('activePower')?.value).toBe(2474);
    expect(adapter.getValue('internalTemp')).toBeNull();
  });

  it('start() polls immediately and again after pollIntervalMs', async () => {
    let activePower = 2474;
    const fetchFn = vi.fn<FetchFn>(async () => {
      const body = structuredClone(fusionSnapshotBody) as {
        snapshot: { values: { activePower: number } };
      };
      body.snapshot.values.activePower = activePower;
      return ok(body);
    });
    const adapter = makeAdapter({ fetchFn, pollIntervalMs: 30_000 });

    adapter.start();
    await flushMicrotasks();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(adapter.getValue('activePower')?.value).toBe(2474);

    activePower = 3000;
    await vi.advanceTimersByTimeAsync(30_000);
    await flushMicrotasks();

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(adapter.getValue('activePower')?.value).toBe(3000);

    await adapter.stop();
  });

  it('emits a "value" event for each field on a successful poll', async () => {
    const fetchFn = vi.fn<FetchFn>(async () =>
      ok(structuredClone(fusionSnapshotBody)),
    );
    const adapter = makeAdapter({ fetchFn });

    const events: Array<[FusionField, FusionSnapshotValue]> = [];
    adapter.on('value', (field, snapshot) => {
      events.push([field, snapshot]);
    });

    await adapter.pollOnce();

    const fieldsEmitted = events.map(([f]) => f);
    expect(fieldsEmitted).toContain('activePower');
    expect(fieldsEmitted).toContain('batterySoc');
    expect(events).toHaveLength(6);
  });
});

describe('FusionSolarAdapter — 3-strikes failure', () => {
  it('flips sourceOk after threshold consecutive errors and recovers on next success', async () => {
    let failNext = true;
    const fetchFn = vi.fn<FetchFn>(async () => {
      if (failNext) {
        throw new Error('ECONNREFUSED');
      }
      return ok(structuredClone(fusionSnapshotBody));
    });
    const adapter = makeAdapter({ fetchFn, failureThreshold: 3 });

    let unavailableEmits = 0;
    let recoveredEmits = 0;
    adapter.on('sourceUnavailable', () => {
      unavailableEmits += 1;
    });
    adapter.on('sourceRecovered', () => {
      recoveredEmits += 1;
    });

    await adapter.pollOnce();
    expect(adapter.getStatus().sourceOk).toBe(true);
    expect(adapter.getStatus().consecutiveFailures).toBe(1);
    expect(unavailableEmits).toBe(0);

    await adapter.pollOnce();
    expect(adapter.getStatus().sourceOk).toBe(true);
    expect(adapter.getStatus().consecutiveFailures).toBe(2);
    expect(unavailableEmits).toBe(0);

    await adapter.pollOnce();
    expect(adapter.getStatus().sourceOk).toBe(false);
    expect(adapter.getStatus().consecutiveFailures).toBe(3);
    expect(unavailableEmits).toBe(1);

    // A fourth failure does not re-emit sourceUnavailable.
    await adapter.pollOnce();
    expect(unavailableEmits).toBe(1);

    // Recovery.
    failNext = false;
    await adapter.pollOnce();
    const status = adapter.getStatus();
    expect(status.sourceOk).toBe(true);
    expect(status.consecutiveFailures).toBe(0);
    expect(status.lastError).toBeNull();
    expect(status.lastSuccess).toBeInstanceOf(Date);
    expect(recoveredEmits).toBe(1);
  });

  it('records a timeout via AbortController as a failure', async () => {
    const fetchFn = vi.fn<FetchFn>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          // Reject when the AbortController fires. The adapter is
          // expected to wire its `httpTimeoutMs` deadline through
          // `init.signal`.
          const signal = init?.signal;
          if (signal !== undefined && signal !== null) {
            signal.addEventListener('abort', () => {
              const e = new Error('aborted');
              e.name = 'AbortError';
              reject(e);
            });
          }
        }),
    );
    const adapter = makeAdapter({
      fetchFn,
      httpTimeoutMs: 100,
      failureThreshold: 3,
    });

    const poll = adapter.pollOnce();
    await vi.advanceTimersByTimeAsync(150);
    await poll;

    const status = adapter.getStatus();
    expect(status.consecutiveFailures).toBe(1);
    expect(status.lastError?.message).toMatch(/timeout/i);
  });

  it('counts a 404 response as a failure', async () => {
    const fetchFn = vi.fn<FetchFn>(async () =>
      fakeResponse({
        ok: false,
        status: 404,
        json: () => Promise.resolve({}),
      }),
    );
    const adapter = makeAdapter({ fetchFn });

    await adapter.pollOnce();

    const status = adapter.getStatus();
    expect(status.consecutiveFailures).toBe(1);
    expect(status.lastError?.message).toMatch(/404/);
  });

  it('counts a JSON-parse failure as a failure', async () => {
    const fetchFn = vi.fn<FetchFn>(async () =>
      fakeResponse({
        ok: true,
        status: 200,
        json: () => Promise.reject(new SyntaxError('Unexpected token <')),
      }),
    );
    const adapter = makeAdapter({ fetchFn });

    await adapter.pollOnce();

    const status = adapter.getStatus();
    expect(status.consecutiveFailures).toBe(1);
    expect(status.lastError?.message).toMatch(/Unexpected token|JSON/);
  });

  it('counts a schema-mismatch as a failure without throwing', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => ok({ unrelated: true }));
    const adapter = makeAdapter({ fetchFn });

    // Neither `start()` nor `pollOnce()` should throw.
    await expect(adapter.pollOnce()).resolves.toBeUndefined();

    const status = adapter.getStatus();
    expect(status.consecutiveFailures).toBe(1);
    expect(status.lastError?.message).toMatch(/schema/i);
    expect(status.sourceOk).toBe(true);
  });
});

describe('FusionSolarAdapter — lifecycle', () => {
  it('stop() cancels the next scheduled poll', async () => {
    const fetchFn = vi.fn<FetchFn>(async () =>
      ok(structuredClone(fusionSnapshotBody)),
    );
    const adapter = makeAdapter({ fetchFn, pollIntervalMs: 30_000 });

    adapter.start();
    await flushMicrotasks();
    expect(fetchFn).toHaveBeenCalledTimes(1);

    await adapter.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('start() is idempotent', async () => {
    const fetchFn = vi.fn<FetchFn>(async () =>
      ok(structuredClone(fusionSnapshotBody)),
    );
    const adapter = makeAdapter({ fetchFn });

    adapter.start();
    adapter.start();
    await flushMicrotasks();

    expect(fetchFn).toHaveBeenCalledTimes(1);

    await adapter.stop();
  });
});
