/**
 * Heat Shield — source resolver tests (Task 5.4).
 *
 * No real network, no real timers. The HCU cache is fed a synthetic
 * `getSystemState` body with a single `CLIMATE_SENSOR` providing
 * `actualTemperature` (used both as the `hmip` and the `openmeteo`
 * primary in different cases). The FusionSolar adapter is driven by a
 * mocked `fetchFn` returning the realistic `fusion-snapshot` fixture
 * and an injected `now`, so `observedAt` stamps are deterministic.
 *
 * Cases (one per acceptance bullet):
 *   - `static` primary           → resolved value.
 *   - `hmip` primary             → resolved from cache.
 *   - `openmeteo` primary        → resolved from cache.
 *   - `fusion` primary           → resolved from FusionSolar adapter.
 *   - `fusion` primary, fusion=null → `'no_value'`.
 *   - `fusion` primary stale     → `'stale'`.
 *   - `hmip` primary missing,
 *     `fusion` fallback           → success with `usedFallback: true`.
 *   - `fusion` primary missing
 *     (field never observed),
 *     `static` fallback           → success with `usedFallback: true`.
 *   - `undefined` binding         → `'unbound'`.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  FusionSolarAdapter,
  HcuSourceCache,
  resolveSignal,
  type SourceContext,
} from '../../src/plugin/sources/index.js';
import type { SignalBinding } from '../../src/shared/types.js';
import { fusionSnapshotBody } from '../_fixtures/fusion-snapshot.js';

// ---------------------------------------------------------------------------
// Helpers.
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

const FIXED_NOW = new Date('2026-06-21T10:00:00.000Z');

/**
 * Synthetic snapshot body: one CLIMATE_SENSOR called
 * `climate-bedroom` exposing `actualTemperature: 23.4`. The same
 * device is reused for both `hmip` and `openmeteo` cases — the
 * resolver uses `kind` only to decide the routing, not to filter
 * device types.
 */
function makeSnapshot(): unknown {
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
            actualTemperature: 23.4,
          },
        },
      },
    },
  };
}

/**
 * Build a SourceContext wired with:
 *   - an HcuSourceCache primed via `applySystemState` and stamped at
 *     `cacheNow` (defaults to `FIXED_NOW`),
 *   - a FusionSolarAdapter that has polled exactly once at
 *     `fusionNow` (defaults to `FIXED_NOW`) — except when
 *     `withFusion: false` is requested, in which case `fusion` is
 *     `null`,
 *   - a fixed `now` for the resolver (defaults to `FIXED_NOW`).
 */
async function makeContext(
  options: {
    cacheNow?: Date;
    fusionNow?: Date;
    now?: Date;
    withFusion?: boolean;
    skipFusionPoll?: boolean;
  } = {},
): Promise<SourceContext> {
  const cacheNow = options.cacheNow ?? FIXED_NOW;
  const fusionNow = options.fusionNow ?? FIXED_NOW;
  const now = options.now ?? FIXED_NOW;
  const withFusion = options.withFusion ?? true;
  const skipFusionPoll = options.skipFusionPoll ?? false;

  const hcu = new HcuSourceCache({ now: () => cacheNow });
  hcu.applySystemState(makeSnapshot());

  let fusion: FusionSolarAdapter | null = null;
  if (withFusion) {
    const fetchFn = vi.fn<FetchFn>(async () =>
      ok(structuredClone(fusionSnapshotBody)),
    );
    fusion = new FusionSolarAdapter({
      baseUrl: 'http://host.containers.internal:8088',
      fetchFn,
      now: () => fusionNow,
    });
    if (!skipFusionPoll) {
      await fusion.pollOnce();
    }
  }

  return { hcu, fusion, now };
}

// ---------------------------------------------------------------------------
// Cases.
// ---------------------------------------------------------------------------

describe('resolveSignal — primary leg', () => {
  it('static primary resolves to the literal value', async () => {
    const ctx = await makeContext();
    const binding: SignalBinding = {
      primary: { kind: 'static', value: 19.5 },
      staleAfterSec: 600,
    };

    const r = resolveSignal(binding, ctx);

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toBe(19.5);
      expect(r.usedFallback).toBe(false);
      expect(r.observedAt.getTime()).toBe(FIXED_NOW.getTime());
    }
  });

  it('hmip primary resolves from the HCU cache', async () => {
    const ctx = await makeContext();
    const binding: SignalBinding = {
      primary: {
        kind: 'hmip',
        deviceId: 'climate-bedroom',
        feature: 'actualTemperature',
      },
      staleAfterSec: 600,
    };

    const r = resolveSignal(binding, ctx);

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toBe(23.4);
      expect(r.usedFallback).toBe(false);
      expect(r.observedAt.getTime()).toBe(FIXED_NOW.getTime());
    }
  });

  it('openmeteo primary resolves from the HCU cache (same routing)', async () => {
    const ctx = await makeContext();
    const binding: SignalBinding = {
      primary: {
        kind: 'openmeteo',
        deviceId: 'climate-bedroom',
        feature: 'actualTemperature',
      },
      staleAfterSec: 600,
    };

    const r = resolveSignal(binding, ctx);

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toBe(23.4);
      expect(r.usedFallback).toBe(false);
    }
  });

  it('fusion primary resolves from the FusionSolar adapter', async () => {
    const ctx = await makeContext();
    const binding: SignalBinding = {
      primary: { kind: 'fusion', field: 'activePower' },
      staleAfterSec: 600,
    };

    const r = resolveSignal(binding, ctx);

    expect(r.ok).toBe(true);
    if (r.ok) {
      // Fixture's activePower.
      expect(r.value).toBe(2474);
      expect(r.usedFallback).toBe(false);
      expect(r.observedAt.getTime()).toBe(FIXED_NOW.getTime());
    }
  });

  it('fusion primary returns no_value when the adapter is null', async () => {
    const ctx = await makeContext({ withFusion: false });
    const binding: SignalBinding = {
      primary: { kind: 'fusion', field: 'activePower' },
      staleAfterSec: 600,
    };

    const r = resolveSignal(binding, ctx);

    expect(r).toEqual({ ok: false, reason: 'no_value' });
  });

  it('fusion primary returns stale when older than staleAfterSec', async () => {
    // FusionSolar polled at 09:50; resolver clock at 10:00.10
    // staleAfterSec = 600 (10 min) → ageMs = 600.1s → stale.
    const fusionNow = new Date('2026-06-21T09:50:00.000Z');
    const resolverNow = new Date('2026-06-21T10:00:00.100Z');
    const ctx = await makeContext({
      fusionNow,
      cacheNow: resolverNow,
      now: resolverNow,
    });

    const binding: SignalBinding = {
      primary: { kind: 'fusion', field: 'activePower' },
      staleAfterSec: 600,
    };

    const r = resolveSignal(binding, ctx);

    expect(r).toEqual({ ok: false, reason: 'stale' });
  });
});

describe('resolveSignal — fallback leg', () => {
  it('hmip primary missing → fusion fallback used (usedFallback=true)', async () => {
    const ctx = await makeContext();
    const binding: SignalBinding = {
      primary: {
        kind: 'hmip',
        deviceId: 'unknown-device',
        feature: 'actualTemperature',
      },
      fallback: { kind: 'fusion', field: 'activePower' },
      staleAfterSec: 600,
    };

    const r = resolveSignal(binding, ctx);

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toBe(2474);
      expect(r.usedFallback).toBe(true);
    }
  });

  it('fusion primary missing (field never observed) → static fallback used', async () => {
    // Adapter is present but its only successful poll did not include
    // a `meterActivePower` field that we then ask for. To produce that
    // shape without surgery on the adapter, swap the snapshot to one
    // that omits the field via a one-off fetch override.
    const fetchFn = vi.fn<FetchFn>(async () => {
      const partial = structuredClone(fusionSnapshotBody) as {
        snapshot: { values: Record<string, number | undefined> };
      };
      delete partial.snapshot.values.meterActivePower;
      return ok(partial);
    });
    const fusion = new FusionSolarAdapter({
      baseUrl: 'http://host.containers.internal:8088',
      fetchFn,
      now: () => FIXED_NOW,
    });
    await fusion.pollOnce();

    const hcu = new HcuSourceCache({ now: () => FIXED_NOW });
    hcu.applySystemState(makeSnapshot());

    const ctx: SourceContext = { hcu, fusion, now: FIXED_NOW };
    const binding: SignalBinding = {
      primary: { kind: 'fusion', field: 'meterActivePower' },
      fallback: { kind: 'static', value: 0 },
      staleAfterSec: 600,
    };

    const r = resolveSignal(binding, ctx);

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toBe(0);
      expect(r.usedFallback).toBe(true);
      expect(r.observedAt.getTime()).toBe(FIXED_NOW.getTime());
    }
  });
});

describe('resolveSignal — degenerate cases', () => {
  it('undefined binding → unbound', async () => {
    const ctx = await makeContext();
    const r = resolveSignal(undefined, ctx);
    expect(r).toEqual({ ok: false, reason: 'unbound' });
  });
});
