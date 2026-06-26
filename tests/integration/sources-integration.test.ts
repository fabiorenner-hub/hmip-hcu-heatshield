/**
 * Heat Shield — sources end-to-end integration (Task 5.5).
 *
 * Wires {@link HcuSourceCache}, {@link FusionSolarAdapter}, and
 * {@link resolveSignal} together to exercise the full adapter →
 * resolver pipeline that the orchestrator (Task 8) will use.
 *
 * No real network and no real timers. The FusionSolar fetch is
 * mocked; the failure-cascade test drives the clock with
 * `vi.useFakeTimers` so the staleness ledger is deterministic.
 *
 * Coverage map (one acceptance bullet per test):
 *   1. outdoorTemp binding (primary `hmip` bedroom, fallback
 *      `openmeteo` Beispielstadt) resolves to bedroom value first.
 *   2. once bedroom ages past `staleAfterSec`, the resolver falls
 *      back to OpenMeteo with `usedFallback: true`.
 *   3. pvPower binding (primary `fusion`) resolves to 2474 from the
 *      realistic fixture.
 *   4. when the FusionSolar adapter sees three consecutive fetch
 *      failures, `getStatus().sourceOk` flips to `false` and the
 *      next `resolveSignal` for `fusion` returns `'stale'` (cached
 *      value present but past `staleAfterSec`) or `'no_value'`
 *      (nothing was ever cached). Both branches are exercised by
 *      separate cases.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FusionSolarAdapter,
  HcuSourceCache,
  resolveSignal,
  type SourceContext,
} from '../../src/plugin/sources/index.js';
import type { SignalBinding } from '../../src/shared/types.js';
import { fusionSnapshotBody } from '../_fixtures/fusion-snapshot.js';

// ---------------------------------------------------------------------------
// Helpers — deliberately minimal so each test reads top-down.
// ---------------------------------------------------------------------------

type FetchFn = typeof globalThis.fetch;

/** Minimal `Response`-shaped object the FusionSolar adapter consumes. */
function ok(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

/**
 * Synthetic HCU snapshot with two CLIMATE_SENSORs:
 *   - `climate-bedroom`     : Wandsensor (HmIP-STH), 22.0 °C — primary.
 *   - `climate-example`   : OpenMeteo Beispielstadt (manufacturerCode
 *     `OpenMeteo`), 28.5 °C — fallback candidate.
 */
function makeHcuSnapshot(): unknown {
  return {
    devices: {
      'climate-bedroom': {
        id: 'climate-bedroom',
        type: 'CLIMATE_SENSOR',
        label: 'Wandsensor Schlafzimmer',
        modelType: 'HmIP-STH',
        functionalChannels: {
          '1': {
            functionalChannelType: 'CLIMATE_SENSOR_CHANNEL',
            index: 1,
            groupIndex: 1,
            deviceId: 'climate-bedroom',
            actualTemperature: 22.0,
          },
        },
      },
      'climate-example': {
        id: 'climate-example',
        type: 'CLIMATE_SENSOR',
        label: 'OpenMeteo Beispielstadt',
        manufacturerCode: 'OpenMeteo',
        functionalChannels: {
          '1': {
            functionalChannelType: 'CLIMATE_SENSOR_CHANNEL',
            index: 1,
            groupIndex: 1,
            deviceId: 'climate-example',
            actualTemperature: 28.5,
          },
        },
      },
    },
  };
}

/**
 * Refresh-event for `climate-example` only — used to bump the
 * OpenMeteo `observedAt` past the bedroom's stamp so the fallback
 * leg has a fresh value when the primary ages out.
 */
function makeBeispielstadtRefreshEvent(temperatureC: number): unknown {
  return {
    eventTransaction: {
      accessPointId: 'AP',
      events: {
        '0': {
          pushEventType: 'DEVICE_CHANGED',
          device: {
            id: 'climate-example',
            type: 'CLIMATE_SENSOR',
            label: 'OpenMeteo Beispielstadt',
            manufacturerCode: 'OpenMeteo',
            functionalChannels: {
              '1': {
                functionalChannelType: 'CLIMATE_SENSOR_CHANNEL',
                index: 1,
                groupIndex: 1,
                deviceId: 'climate-example',
                actualTemperature: temperatureC,
              },
            },
          },
        },
      },
      origin: { type: 'DEVICE' },
    },
  };
}

// ---------------------------------------------------------------------------
// Case 1 + 2: hmip primary, openmeteo fallback.
// ---------------------------------------------------------------------------

describe('sources integration — hmip primary + openmeteo fallback', () => {
  it('resolves the bedroom value first while it is still fresh', () => {
    const cacheNow = new Date('2026-06-21T10:00:00.000Z');
    const cache = new HcuSourceCache({ now: () => cacheNow });
    cache.applySystemState(makeHcuSnapshot());

    const binding: SignalBinding = {
      primary: {
        kind: 'hmip',
        deviceId: 'climate-bedroom',
        feature: 'actualTemperature',
      },
      fallback: {
        kind: 'openmeteo',
        deviceId: 'climate-example',
        feature: 'actualTemperature',
      },
      staleAfterSec: 60,
    };

    // 5 s after the snapshot — both legs are fresh, primary wins.
    const ctx: SourceContext = {
      hcu: cache,
      fusion: null,
      now: new Date(cacheNow.getTime() + 5_000),
    };
    const r = resolveSignal(binding, ctx);

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toBe(22.0);
      expect(r.usedFallback).toBe(false);
      expect(r.observedAt.getTime()).toBe(cacheNow.getTime());
    }
  });

  it('falls back to OpenMeteo with usedFallback=true once the bedroom ages out', () => {
    let cacheNow = new Date('2026-06-21T10:00:00.000Z');
    const cache = new HcuSourceCache({ now: () => cacheNow });

    // T0: ingest snapshot — bedroom and Beispielstadt both stamped at T0.
    cache.applySystemState(makeHcuSnapshot());

    // T0+50 s: refresh OpenMeteo so its stamp is newer than bedroom's.
    cacheNow = new Date(cacheNow.getTime() + 50_000);
    cache.applyEvent(makeBeispielstadtRefreshEvent(28.5));

    const binding: SignalBinding = {
      primary: {
        kind: 'hmip',
        deviceId: 'climate-bedroom',
        feature: 'actualTemperature',
      },
      fallback: {
        kind: 'openmeteo',
        deviceId: 'climate-example',
        feature: 'actualTemperature',
      },
      staleAfterSec: 60,
    };

    // T0+90 s: bedroom is 90 s old (stale, > 60 s); Beispielstadt is 40 s
    // old (fresh, ≤ 60 s).
    const resolverNow = new Date('2026-06-21T10:00:00.000Z').getTime() + 90_000;
    const ctx: SourceContext = {
      hcu: cache,
      fusion: null,
      now: new Date(resolverNow),
    };
    const r = resolveSignal(binding, ctx);

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toBe(28.5);
      expect(r.usedFallback).toBe(true);
      // The fallback's observedAt is the Beispielstadt refresh stamp.
      expect(r.observedAt.getTime()).toBe(
        new Date('2026-06-21T10:00:00.000Z').getTime() + 50_000,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Case 3: fusion primary success.
// ---------------------------------------------------------------------------

describe('sources integration — fusion primary', () => {
  it('resolves pvPower to 2474 from the realistic fixture', async () => {
    const fixedNow = new Date('2026-06-21T10:00:00.000Z');
    const fetchFn = vi.fn<FetchFn>(async () =>
      ok(structuredClone(fusionSnapshotBody)),
    );
    const fusion = new FusionSolarAdapter({
      baseUrl: 'http://host.containers.internal:8088',
      fetchFn,
      now: () => fixedNow,
    });
    await fusion.pollOnce();

    const cache = new HcuSourceCache({ now: () => fixedNow });
    cache.applySystemState(makeHcuSnapshot());

    const ctx: SourceContext = {
      hcu: cache,
      fusion,
      now: fixedNow,
    };

    const binding: SignalBinding = {
      primary: { kind: 'fusion', field: 'activePower' },
      staleAfterSec: 600,
    };
    const r = resolveSignal(binding, ctx);

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toBe(2474);
      expect(r.usedFallback).toBe(false);
      expect(r.observedAt.getTime()).toBe(fixedNow.getTime());
    }
  });
});

// ---------------------------------------------------------------------------
// Case 4: fusion failure cascade. Uses vi.useFakeTimers per task spec.
// ---------------------------------------------------------------------------

describe('sources integration — fusion failure cascade', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-21T10:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('flips sourceOk after 3 failures and resolveSignal returns "stale" for a previously cached value', async () => {
    let mode: 'ok' | 'fail' = 'ok';
    const fetchFn = vi.fn<FetchFn>(async () => {
      if (mode === 'fail') {
        throw new Error('ECONNREFUSED');
      }
      return ok(structuredClone(fusionSnapshotBody));
    });
    // Adapter `now` defaults to `() => new Date()` — fake timers control
    // it deterministically.
    const fusion = new FusionSolarAdapter({
      baseUrl: 'http://host.containers.internal:8088',
      fetchFn,
      failureThreshold: 3,
    });

    // Initial successful poll caches activePower=2474 at T0.
    await fusion.pollOnce();
    expect(fusion.getStatus().sourceOk).toBe(true);

    const cache = new HcuSourceCache();
    const binding: SignalBinding = {
      primary: { kind: 'fusion', field: 'activePower' },
      staleAfterSec: 600,
    };

    // Sanity: with sourceOk and a fresh cached value, the resolver
    // produces the cached number.
    const ctxFresh: SourceContext = { hcu: cache, fusion, now: new Date() };
    const rFresh = resolveSignal(binding, ctxFresh);
    expect(rFresh.ok).toBe(true);
    if (rFresh.ok) {
      expect(rFresh.value).toBe(2474);
    }

    // Switch to failure mode and drive three consecutive failed polls.
    mode = 'fail';
    await fusion.pollOnce();
    await fusion.pollOnce();
    await fusion.pollOnce();

    const status = fusion.getStatus();
    expect(status.sourceOk).toBe(false);
    expect(status.consecutiveFailures).toBe(3);

    // Advance system time past staleAfterSec=600 s. The cached value
    // is now older than the staleness budget — resolveSignal must
    // surface that.
    vi.setSystemTime(new Date('2026-06-21T10:11:00.000Z'));

    const ctxStale: SourceContext = { hcu: cache, fusion, now: new Date() };
    const rStale = resolveSignal(binding, ctxStale);
    expect(rStale.ok).toBe(false);
    if (!rStale.ok) {
      expect(rStale.reason).toBe('stale');
    }
  });

  it('returns "no_value" when 3 failures hit the adapter before any value is cached', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => {
      throw new Error('ECONNREFUSED');
    });
    const fusion = new FusionSolarAdapter({
      baseUrl: 'http://host.containers.internal:8088',
      fetchFn,
      failureThreshold: 3,
    });

    await fusion.pollOnce();
    await fusion.pollOnce();
    await fusion.pollOnce();

    const status = fusion.getStatus();
    expect(status.sourceOk).toBe(false);
    expect(status.consecutiveFailures).toBe(3);

    const cache = new HcuSourceCache();
    const ctx: SourceContext = { hcu: cache, fusion, now: new Date() };
    const binding: SignalBinding = {
      primary: { kind: 'fusion', field: 'activePower' },
      staleAfterSec: 600,
    };
    const r = resolveSignal(binding, ctx);

    expect(r).toEqual({ ok: false, reason: 'no_value' });
  });
});
