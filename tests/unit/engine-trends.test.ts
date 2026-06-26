/**
 * Tests for the rolling trend store
 * (`src/plugin/engine/trends.ts` + `src/plugin/persistence/trends.ts`).
 *
 * Each persistence test allocates its own temp directory under
 * `os.tmpdir()` so the suite never touches `/data/`. The directory is
 * removed in `afterEach`.
 *
 * Coverage (Task 1.4):
 *   - `slopePerHour` returns a known least-squares slope for a linear ramp.
 *   - `slopePerHour` returns `null` for < 2 points and for zero x-variance.
 *   - `record` skips `null`/non-finite values.
 *   - `prune` drops samples outside the window.
 *   - `summary` returns latest + average over the window.
 *   - Persistence round-trip: append → read → load rebuilds the trend.
 *   - A malformed NDJSON line is skipped on read.
 *   - `compact` rewrites the file with only the supplied samples.
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_TREND_WINDOW_HOURS,
  TrendStore,
} from '../../src/plugin/engine/trends.js';
import type { TrendSample } from '../../src/plugin/engine/trends.js';
import {
  appendSample,
  appendSamples,
  compact,
  DEFAULT_TRENDS_PATH,
  readSamples,
} from '../../src/plugin/persistence/trends.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'heat-shield-trends-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function tmpTrendsPath(name = 'trends.ndjson'): string {
  return path.join(tmpDir, name);
}

const HOUR = 3_600_000;

describe('TrendStore — defaults', () => {
  it('exposes the documented default window and path', () => {
    expect(DEFAULT_TREND_WINDOW_HOURS).toBe(3);
    expect(DEFAULT_TRENDS_PATH).toBe('/data/trends.ndjson');
  });
});

describe('TrendStore.slopePerHour', () => {
  it('recovers a known slope from a linear ramp (2 °C/h)', () => {
    const store = new TrendStore(3);
    const t0 = new Date('2026-06-22T08:00:00Z').getTime();
    // value = 20 + 2 * hours
    for (let h = 0; h <= 2; h += 0.5) {
      store.record(new Date(t0 + h * HOUR), [
        { key: 'outdoor', value: 20 + 2 * h },
      ]);
    }
    const slope = store.slopePerHour('outdoor');
    expect(slope).not.toBeNull();
    expect(slope!).toBeCloseTo(2, 6);
  });

  it('returns null for fewer than two points', () => {
    const store = new TrendStore(3);
    store.record(new Date('2026-06-22T08:00:00Z'), [
      { key: 'pv', value: 4 },
    ]);
    expect(store.slopePerHour('pv')).toBeNull();
    expect(store.slopePerHour('missing')).toBeNull();
  });

  it('returns null when all samples share one timestamp (zero x-variance)', () => {
    const store = new TrendStore(3);
    const now = new Date('2026-06-22T08:00:00Z');
    store.record(now, [{ key: 'pv', value: 4 }]);
    store.record(now, [{ key: 'pv', value: 6 }]);
    expect(store.slopePerHour('pv')).toBeNull();
  });

  it('reports a negative slope for a falling signal', () => {
    const store = new TrendStore(3);
    const t0 = new Date('2026-06-22T08:00:00Z').getTime();
    for (let h = 0; h <= 2; h += 1) {
      store.record(new Date(t0 + h * HOUR), [
        { key: 'temp', value: 30 - 3 * h },
      ]);
    }
    expect(store.slopePerHour('temp')!).toBeCloseTo(-3, 6);
  });
});

describe('TrendStore.record / prune', () => {
  it('skips null and non-finite values', () => {
    const store = new TrendStore(3);
    const now = new Date('2026-06-22T08:00:00Z');
    store.record(now, [
      { key: 'a', value: null },
      { key: 'a', value: Number.NaN },
      { key: 'a', value: Number.POSITIVE_INFINITY },
    ]);
    expect(store.summary('a')).toEqual({ latest: null, avg: null });
    expect(store.keys()).not.toContain('a');
  });

  it('drops samples older than the window', () => {
    const store = new TrendStore(3);
    const t0 = new Date('2026-06-22T08:00:00Z').getTime();
    store.record(new Date(t0), [{ key: 'temp', value: 20 }]);
    store.record(new Date(t0 + 1 * HOUR), [{ key: 'temp', value: 22 }]);
    // 4h later: the first two (now 4h/3h old) fall outside the 3h window.
    store.record(new Date(t0 + 4 * HOUR), [{ key: 'temp', value: 28 }]);
    const summary = store.summary('temp');
    // Only the 3h-old (22) and the latest (28) survive within 3h of t0+4h.
    expect(summary.latest).toBe(28);
    expect(summary.avg).toBeCloseTo(25, 6);
  });

  it('removes an empty buffer entirely after pruning', () => {
    const store = new TrendStore(1);
    const t0 = new Date('2026-06-22T08:00:00Z').getTime();
    store.record(new Date(t0), [{ key: 'temp', value: 20 }]);
    store.prune(new Date(t0 + 2 * HOUR));
    expect(store.keys()).not.toContain('temp');
    expect(store.summary('temp')).toEqual({ latest: null, avg: null });
  });
});

describe('TrendStore.summary', () => {
  it('returns latest and average over the window', () => {
    const store = new TrendStore(3);
    const t0 = new Date('2026-06-22T08:00:00Z').getTime();
    store.record(new Date(t0), [{ key: 'pv', value: 2 }]);
    store.record(new Date(t0 + HOUR), [{ key: 'pv', value: 4 }]);
    store.record(new Date(t0 + 2 * HOUR), [{ key: 'pv', value: 6 }]);
    expect(store.summary('pv')).toEqual({ latest: 6, avg: 4 });
  });
});

describe('persistence/trends round-trip', () => {
  it('append → read → load rebuilds the in-memory trend', async () => {
    const trendsPath = tmpTrendsPath();
    const t0 = new Date('2026-06-22T08:00:00Z').getTime();
    const samples: TrendSample[] = [];
    for (let h = 0; h <= 2; h += 1) {
      samples.push({
        ts: new Date(t0 + h * HOUR).toISOString(),
        key: 'outdoor',
        value: 20 + 2 * h,
      });
    }
    await appendSamples(samples, { trendsPath });

    const read = await readSamples({ trendsPath });
    expect(read).toHaveLength(3);

    const store = new TrendStore(3);
    store.load(read, new Date(t0 + 2 * HOUR));
    expect(store.slopePerHour('outdoor')!).toBeCloseTo(2, 6);
    expect(store.summary('outdoor').latest).toBe(24);
  });

  it('returns [] for a missing file', async () => {
    const read = await readSamples({ trendsPath: tmpTrendsPath('nope.ndjson') });
    expect(read).toEqual([]);
  });

  it('skips a malformed line but keeps surrounding valid samples', async () => {
    const trendsPath = tmpTrendsPath();
    await appendSample(
      { ts: '2026-06-22T08:00:00.000Z', key: 'pv', value: 1 },
      { trendsPath },
    );
    await fs.appendFile(trendsPath, '{ this is not json\n', 'utf8');
    await appendSample(
      { ts: '2026-06-22T09:00:00.000Z', key: 'pv', value: 3 },
      { trendsPath },
    );
    const read = await readSamples({ trendsPath });
    expect(read.map((s) => s.value)).toEqual([1, 3]);
  });

  it('skips structurally-invalid samples (wrong field types)', async () => {
    const trendsPath = tmpTrendsPath();
    await fs.appendFile(
      trendsPath,
      `${JSON.stringify({ ts: 5, key: 'pv', value: 'x' })}\n`,
      'utf8',
    );
    await appendSample(
      { ts: '2026-06-22T09:00:00.000Z', key: 'pv', value: 3 },
      { trendsPath },
    );
    const read = await readSamples({ trendsPath });
    expect(read).toEqual([
      { ts: '2026-06-22T09:00:00.000Z', key: 'pv', value: 3 },
    ]);
  });

  it('compact rewrites the file with only the supplied samples', async () => {
    const trendsPath = tmpTrendsPath();
    await appendSamples(
      [
        { ts: '2026-06-22T05:00:00.000Z', key: 'pv', value: 1 },
        { ts: '2026-06-22T06:00:00.000Z', key: 'pv', value: 2 },
        { ts: '2026-06-22T07:00:00.000Z', key: 'pv', value: 3 },
      ],
      { trendsPath },
    );
    const kept: TrendSample[] = [
      { ts: '2026-06-22T07:00:00.000Z', key: 'pv', value: 3 },
    ];
    await compact(kept, { trendsPath });
    const read = await readSamples({ trendsPath });
    expect(read).toEqual(kept);
  });

  it('compact with an empty set truncates the file', async () => {
    const trendsPath = tmpTrendsPath();
    await appendSample(
      { ts: '2026-06-22T05:00:00.000Z', key: 'pv', value: 1 },
      { trendsPath },
    );
    await compact([], { trendsPath });
    expect(await readSamples({ trendsPath })).toEqual([]);
  });
});

describe('TrendStore.load defensiveness', () => {
  it('skips samples with unparseable timestamps or non-finite values', () => {
    const store = new TrendStore(3);
    const now = new Date('2026-06-22T10:00:00Z');
    store.load(
      [
        { ts: 'not-a-date', key: 'pv', value: 5 },
        { ts: '2026-06-22T09:00:00.000Z', key: 'pv', value: Number.NaN },
        { ts: '2026-06-22T09:30:00.000Z', key: 'pv', value: 7 },
      ],
      now,
    );
    expect(store.summary('pv')).toEqual({ latest: 7, avg: 7 });
  });
});
