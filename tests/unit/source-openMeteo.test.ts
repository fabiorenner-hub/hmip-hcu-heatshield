/**
 * Tests for the direct OpenMeteo HTTP source adapter (Wave 5) and its
 * integration into the signal resolver via the `openmeteo_http` kind.
 *
 * The adapter is fully dependency-injected: a mocked `fetchFn` returns a
 * realistic open-meteo.com `/v1/forecast` body and an injected `now`
 * keeps `observedAt` deterministic.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HcuSourceCache,
  OpenMeteoAdapter,
  resolveSignal,
  type SourceContext,
} from '../../src/plugin/sources/index.js';

type FetchFn = typeof globalThis.fetch;

const FORECAST_BODY = {
  current: {
    temperature_2m: 24.3,
    relative_humidity_2m: 51,
    cloud_cover: 40,
    wind_speed_10m: 3.2,
    shortwave_radiation: 612,
    precipitation: 0,
  },
  daily: {
    temperature_2m_max: [29.1, 30.0],
  },
};

function fakeResponse(init: {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}): Response {
  return init as unknown as Response;
}

function ok(body: unknown): Response {
  return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(body) });
}

function makeAdapter(opts: {
  fetchFn: FetchFn;
  pollIntervalMs?: number;
  failureThreshold?: number;
}): OpenMeteoAdapter {
  return new OpenMeteoAdapter({
    latitude: 52.52,
    longitude: 13.41,
    timezone: 'Europe/Berlin',
    pollIntervalMs: opts.pollIntervalMs ?? 15 * 60_000,
    failureThreshold: opts.failureThreshold ?? 3,
    fetchFn: opts.fetchFn,
    now: () => new Date(),
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-06-21T10:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('OpenMeteoAdapter — success path', () => {
  it('builds a forecast URL with the expected params', () => {
    const adapter = makeAdapter({ fetchFn: vi.fn<FetchFn>() });
    const url = adapter.buildUrl();
    expect(url).toContain('https://api.open-meteo.com/v1/forecast?');
    expect(url).toContain('latitude=52.52');
    expect(url).toContain('longitude=13.41');
    expect(url).toContain('wind_speed_unit=ms');
    expect(url).toContain('shortwave_radiation');
    expect(url).toContain('temperature_2m_max');
  });

  it('decodes current fields and today max temperature', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => ok(structuredClone(FORECAST_BODY)));
    const adapter = makeAdapter({ fetchFn });

    await adapter.pollOnce();

    expect(adapter.getValue('temperature')?.value).toBe(24.3);
    expect(adapter.getValue('humidity')?.value).toBe(51);
    expect(adapter.getValue('cloudCover')?.value).toBe(40);
    expect(adapter.getValue('windSpeed')?.value).toBe(3.2);
    expect(adapter.getValue('radiation')?.value).toBe(612);
    expect(adapter.getValue('precipitation')?.value).toBe(0);
    // maxTempToday takes the FIRST daily entry (today).
    expect(adapter.getValue('maxTempToday')?.value).toBe(29.1);
  });

  it('emits a value event per decoded field', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => ok(structuredClone(FORECAST_BODY)));
    const adapter = makeAdapter({ fetchFn });
    const fields: string[] = [];
    adapter.on('value', (f) => fields.push(f));

    await adapter.pollOnce();

    expect(fields).toContain('temperature');
    expect(fields).toContain('radiation');
    expect(fields).toContain('maxTempToday');
  });
});

describe('OpenMeteoAdapter — 3-strikes failure', () => {
  it('flips sourceOk after threshold failures and recovers', async () => {
    let failNext = true;
    const fetchFn = vi.fn<FetchFn>(async () => {
      if (failNext) {
        throw new Error('ENOTFOUND');
      }
      return ok(structuredClone(FORECAST_BODY));
    });
    const adapter = makeAdapter({ fetchFn, failureThreshold: 3 });

    await adapter.pollOnce();
    await adapter.pollOnce();
    expect(adapter.getStatus().sourceOk).toBe(true);
    await adapter.pollOnce();
    expect(adapter.getStatus().sourceOk).toBe(false);
    expect(adapter.getStatus().consecutiveFailures).toBe(3);

    failNext = false;
    await adapter.pollOnce();
    expect(adapter.getStatus().sourceOk).toBe(true);
    expect(adapter.getStatus().consecutiveFailures).toBe(0);
  });

  it('counts a schema mismatch as a failure without throwing', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => ok({ totally: 'unrelated' }));
    const adapter = makeAdapter({ fetchFn });
    // `daily`/`current` are optional in the schema, so a mismatch needs a
    // wrong TYPE; pass a body where `current` is a string.
    const badFetch = vi.fn<FetchFn>(async () => ok({ current: 'nope' }));
    const adapter2 = makeAdapter({ fetchFn: badFetch });

    await expect(adapter.pollOnce()).resolves.toBeUndefined();
    await expect(adapter2.pollOnce()).resolves.toBeUndefined();
    // The "unrelated" body parses (all-optional) → success, no value set.
    expect(adapter.getValue('temperature')).toBeNull();
    // The "current: 'nope'" body fails schema → recorded failure.
    expect(adapter2.getStatus().consecutiveFailures).toBe(1);
  });
});

describe('resolveSignal — openmeteo_http kind', () => {
  it('resolves a direct OpenMeteo binding through the adapter', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => ok(structuredClone(FORECAST_BODY)));
    const openMeteo = makeAdapter({ fetchFn });
    await openMeteo.pollOnce();

    const ctx: SourceContext = {
      hcu: new HcuSourceCache(),
      fusion: null,
      openMeteo,
      now: new Date('2026-06-21T10:00:00.000Z'),
    };

    const res = resolveSignal(
      { primary: { kind: 'openmeteo_http', field: 'radiation' }, staleAfterSec: 3600 },
      ctx,
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toBe(612);
      expect(res.usedFallback).toBe(false);
    }
  });

  it('resolves to no_value when the adapter is absent', () => {
    const ctx: SourceContext = {
      hcu: new HcuSourceCache(),
      fusion: null,
      now: new Date(),
    };
    const res = resolveSignal(
      { primary: { kind: 'openmeteo_http', field: 'temperature' }, staleAfterSec: 600 },
      ctx,
    );
    expect(res.ok).toBe(false);
  });

  it('treats a value older than staleAfterSec as stale', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => ok(structuredClone(FORECAST_BODY)));
    const openMeteo = makeAdapter({ fetchFn });
    await openMeteo.pollOnce(); // observedAt = 2026-06-21T10:00:00Z

    const ctx: SourceContext = {
      hcu: new HcuSourceCache(),
      fusion: null,
      openMeteo,
      // 2 hours later, staleAfterSec=3600 → stale.
      now: new Date('2026-06-21T12:00:00.000Z'),
    };
    const res = resolveSignal(
      { primary: { kind: 'openmeteo_http', field: 'temperature' }, staleAfterSec: 3600 },
      ctx,
    );
    expect(res.ok).toBe(false);
  });
});
