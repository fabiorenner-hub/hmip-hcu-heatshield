/**
 * Tests for the NDJSON history store
 * (`src/plugin/persistence/history.ts`).
 *
 * Each test allocates its own temp directory under `os.tmpdir()` so the
 * suite never touches `/data/`. The directory is removed in `afterEach`
 * regardless of test outcome.
 *
 * Coverage:
 *   - Default constants match the steering rule.
 *   - `appendRecord` then `readRecords` round-trips a single record
 *     (payload deep-equal).
 *   - Multiple `appendRecord` calls produce N lines, all parse back
 *     in insertion order.
 *   - `appendRecord` triggers `rotate()` once `maxBytes` is exceeded;
 *     the active file ends up under threshold and a sibling rotated
 *     archive exists.
 *   - `readLastN(3)` after appending 10 records returns the last 3 in
 *     insertion order.
 *   - `readLastN(3)` on a missing file returns `[]`.
 *   - `purgeOldArchives` deletes archives older than `retentionDays`
 *     and keeps recent ones; non-rotation siblings are left alone.
 *   - `readRecords` skips a malformed line in the middle of the file
 *     but still yields the surrounding valid records.
 *   - The generic envelope works with the actual `DecisionRecord`
 *     payload type (compile-time check).
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  appendRecord,
  DEFAULT_HISTORY_PATH,
  DEFAULT_MAX_BYTES,
  DEFAULT_RETENTION_DAYS,
  purgeOldArchives,
  readLastN,
  readRecords,
} from '../../src/plugin/persistence/history.js';
import type { HistoryRecord } from '../../src/plugin/persistence/history.js';
import type { DecisionRecord } from '../../src/shared/decision-schema.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'heat-shield-history-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function tmpHistoryPath(name = 'history.ndjson'): string {
  return path.join(tmpDir, name);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw err;
  }
}

async function collect<T>(
  gen: AsyncGenerator<HistoryRecord<T>, void, void>,
): Promise<HistoryRecord<T>[]> {
  const out: HistoryRecord<T>[] = [];
  for await (const r of gen) {
    out.push(r);
  }
  return out;
}

interface DecisionPayload {
  cycleNumber: number;
  note: string;
}

describe('persistence/history — defaults', () => {
  it('DEFAULT_HISTORY_PATH points at /data/history.ndjson', () => {
    expect(DEFAULT_HISTORY_PATH).toBe('/data/history.ndjson');
  });

  it('DEFAULT_MAX_BYTES is 50 MB', () => {
    expect(DEFAULT_MAX_BYTES).toBe(50 * 1024 * 1024);
  });

  it('DEFAULT_RETENTION_DAYS is 14', () => {
    expect(DEFAULT_RETENTION_DAYS).toBe(14);
  });
});

describe('appendRecord + readRecords', () => {
  it('round-trips a single record deep-equal', async () => {
    const target = tmpHistoryPath();
    const record: HistoryRecord<DecisionPayload> = {
      ts: '2026-06-21T12:00:00.000Z',
      cycleId: 'cycle-1',
      payload: { cycleNumber: 1, note: 'first' },
    };

    await appendRecord(record, { historyPath: target });
    const read = await collect(
      readRecords<DecisionPayload>({ historyPath: target }),
    );

    expect(read).toEqual([record]);
  });

  it('preserves insertion order across N appends', async () => {
    const target = tmpHistoryPath();
    const records: HistoryRecord<DecisionPayload>[] = Array.from(
      { length: 5 },
      (_, i) => ({
        ts: `2026-06-21T12:0${i}:00.000Z`,
        cycleId: `cycle-${i + 1}`,
        payload: { cycleNumber: i + 1, note: `n=${i + 1}` },
      }),
    );

    for (const r of records) {
      await appendRecord(r, { historyPath: target });
    }

    const read = await collect(
      readRecords<DecisionPayload>({ historyPath: target }),
    );
    expect(read).toEqual(records);
  });

  it('creates the parent directory on first append', async () => {
    const nested = path.join(tmpDir, 'nested', 'deeper', 'history.ndjson');

    await appendRecord(
      {
        ts: '2026-06-21T12:00:00.000Z',
        cycleId: 'cycle-1',
        payload: { cycleNumber: 1, note: 'x' },
      },
      { historyPath: nested },
    );

    const stat = await fs.stat(nested);
    expect(stat.isFile()).toBe(true);
  });

  it('returns nothing on a missing file', async () => {
    const read = await collect(
      readRecords<DecisionPayload>({
        historyPath: tmpHistoryPath('does-not-exist.ndjson'),
      }),
    );
    expect(read).toEqual([]);
  });

  it('skips a malformed line in the middle of the file', async () => {
    const target = tmpHistoryPath();
    const ok1: HistoryRecord<DecisionPayload> = {
      ts: '2026-06-21T12:00:00.000Z',
      cycleId: 'cycle-1',
      payload: { cycleNumber: 1, note: 'first' },
    };
    const ok2: HistoryRecord<DecisionPayload> = {
      ts: '2026-06-21T12:02:00.000Z',
      cycleId: 'cycle-2',
      payload: { cycleNumber: 2, note: 'second' },
    };

    await fs.writeFile(
      target,
      `${JSON.stringify(ok1)}\n{ this is not valid json\n${JSON.stringify(ok2)}\n`,
      'utf8',
    );

    const read = await collect(
      readRecords<DecisionPayload>({ historyPath: target }),
    );
    expect(read).toEqual([ok1, ok2]);
  });
});

describe('appendRecord — rotation on size threshold', () => {
  it('rotates when the active file exceeds maxBytes', async () => {
    const target = tmpHistoryPath();
    const fixedNow = (): Date => new Date('2026-06-21T14:12:00Z');
    const longNote = 'X'.repeat(200);

    // maxBytes is intentionally small so we cross the threshold
    // after only a handful of records. Each line is ≈ 280 B.
    const opts = {
      historyPath: target,
      maxBytes: 600,
      retentionDays: DEFAULT_RETENTION_DAYS,
      now: fixedNow,
    };

    for (let i = 0; i < 5; i += 1) {
      await appendRecord<DecisionPayload>(
        {
          ts: `2026-06-21T12:0${i}:00.000Z`,
          cycleId: `cycle-${i + 1}`,
          payload: { cycleNumber: i + 1, note: longNote },
        },
        opts,
      );
    }

    // The active file should be back under the threshold (it was
    // renamed to an archive after one of the writes pushed it over,
    // then later writes started a fresh active file).
    const activeStat = await fs.stat(target).catch(() => null);
    if (activeStat !== null) {
      expect(activeStat.size).toBeLessThan(opts.maxBytes);
    }

    // At least one rotated sibling exists with the expected stamp.
    const siblings = await fs.readdir(tmpDir);
    const archives = siblings.filter(
      (e) =>
        e.startsWith('history.ndjson.') &&
        e.endsWith('.ndjson') &&
        e !== 'history.ndjson',
    );
    expect(archives.length).toBeGreaterThanOrEqual(1);
    expect(archives[0]).toContain('2026-06-21T14-12-00Z');
  });
});

describe('readLastN', () => {
  it('returns the last 3 records in order after appending 10', async () => {
    const target = tmpHistoryPath();
    const records: HistoryRecord<DecisionPayload>[] = Array.from(
      { length: 10 },
      (_, i) => ({
        ts: `2026-06-21T12:${String(i).padStart(2, '0')}:00.000Z`,
        cycleId: `cycle-${i + 1}`,
        payload: { cycleNumber: i + 1, note: `n=${i + 1}` },
      }),
    );

    for (const r of records) {
      await appendRecord(r, { historyPath: target });
    }

    const last3 = await readLastN<DecisionPayload>(3, {
      historyPath: target,
    });
    expect(last3).toEqual(records.slice(-3));
  });

  it('returns [] on a missing file', async () => {
    const result = await readLastN<DecisionPayload>(3, {
      historyPath: tmpHistoryPath('does-not-exist.ndjson'),
    });
    expect(result).toEqual([]);
  });

  it('returns the whole file when n exceeds the line count', async () => {
    const target = tmpHistoryPath();
    const records: HistoryRecord<DecisionPayload>[] = Array.from(
      { length: 2 },
      (_, i) => ({
        ts: `2026-06-21T12:0${i}:00.000Z`,
        cycleId: `cycle-${i + 1}`,
        payload: { cycleNumber: i + 1, note: 'x' },
      }),
    );
    for (const r of records) {
      await appendRecord(r, { historyPath: target });
    }

    const result = await readLastN<DecisionPayload>(50, {
      historyPath: target,
    });
    expect(result).toEqual(records);
  });

  it('returns [] when n <= 0', async () => {
    const target = tmpHistoryPath();
    await appendRecord<DecisionPayload>(
      {
        ts: '2026-06-21T12:00:00.000Z',
        cycleId: 'cycle-1',
        payload: { cycleNumber: 1, note: 'x' },
      },
      { historyPath: target },
    );

    expect(
      await readLastN<DecisionPayload>(0, { historyPath: target }),
    ).toEqual([]);
  });
});

describe('purgeOldArchives', () => {
  it('removes archives older than retentionDays and keeps recent ones', async () => {
    const target = tmpHistoryPath();
    // Active file (must be left alone).
    await fs.writeFile(target, '', 'utf8');
    // Within retention window (20 days before 2026-06-21).
    const recentArchive = path.join(
      tmpDir,
      'history.ndjson.2026-06-01T00-00-00Z.ndjson',
    );
    await fs.writeFile(recentArchive, '', 'utf8');
    // Beyond retention window (~50 days before 2026-06-21).
    const expiredArchive = path.join(
      tmpDir,
      'history.ndjson.2026-05-01T00-00-00Z.ndjson',
    );
    await fs.writeFile(expiredArchive, '', 'utf8');
    // Operator-dropped sibling that does not match the rotation
    // pattern — must NOT be touched.
    const foreignSibling = path.join(tmpDir, 'history.ndjson.notes.ndjson');
    await fs.writeFile(foreignSibling, 'human-readable notes', 'utf8');

    // retentionDays=30 keeps the 2026-06-01 archive (20 days old)
    // and expires the 2026-05-01 archive (51 days old). The 14-day
    // default would purge both, defeating the survive-vs-expire
    // contrast we want this test to make.
    await purgeOldArchives({
      historyPath: target,
      retentionDays: 30,
      now: () => new Date('2026-06-21T00:00:00Z'),
    });

    expect(await pathExists(target)).toBe(true);
    expect(await pathExists(recentArchive)).toBe(true);
    expect(await pathExists(expiredArchive)).toBe(false);
    expect(await pathExists(foreignSibling)).toBe(true);
  });

  it('does nothing on a missing directory', async () => {
    await expect(
      purgeOldArchives({
        historyPath: path.join(tmpDir, 'no-such-dir', 'history.ndjson'),
        now: () => new Date('2026-06-21T00:00:00Z'),
      }),
    ).resolves.toBeUndefined();
  });
});

describe('HistoryRecord<DecisionRecord> generic', () => {
  it('compiles and round-trips with the actual DecisionRecord payload', async () => {
    const target = tmpHistoryPath();
    const decision: DecisionRecord = {
      cycleId: 'cycle-42',
      ts: '2026-06-21T12:00:00.000Z',
      mode: 'ACTIVE_HEAT_PROTECTION',
      windowDecisions: [
        {
          windowId: 'schlafzimmer-dach-so',
          factors: { sunFactor: 0.8, roomTempFactor: 0.5 },
          risk: 0.62,
          rawTarget: 0.9,
          afterSpecialRules: 0.9,
          afterSafety: 0.9,
          finalTarget: 0.9,
          moved: true,
        },
      ],
    };
    const envelope: HistoryRecord<DecisionRecord> = {
      ts: decision.ts,
      cycleId: decision.cycleId,
      payload: decision,
    };

    await appendRecord(envelope, { historyPath: target });
    const read = await collect(
      readRecords<DecisionRecord>({ historyPath: target }),
    );

    expect(read).toEqual([envelope]);
  });
});
