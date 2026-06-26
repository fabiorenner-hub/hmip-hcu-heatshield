/**
 * Heat Shield — NDJSON history store (Task 3.3).
 *
 * `/data/history.ndjson` is the engine's append-only telemetry log. The
 * orchestrator (Task 8) writes one `HistoryRecord<DecisionRecord>` line
 * per cycle; manual-override events and storm transitions reuse the same
 * file with their own payload shapes (hence the generic `T`).
 *
 * Format: one JSON object per line, terminated by `\n`. The on-disk
 * encoding is UTF-8, no BOM, line-delimited (newline-delimited JSON,
 * NDJSON / JSON Lines).
 *
 * ## Atomicity note (NDJSON vs config.ts / state.ts)
 *
 * The config and state stores use write-temp + rename because they
 * persist a *whole document* — a partial write would leave a torn
 * JSON object and the next read would have to fail or discard. The
 * history store has different requirements:
 *
 *   - Each line is independently parseable.
 *   - The reader (`readRecords`) skips any line whose `JSON.parse`
 *     throws, so a torn last line caused by a crash mid-`appendFile`
 *     is observable but recoverable: the surviving lines before and
 *     after still yield.
 *   - On POSIX, writes up to `PIPE_BUF` (≥ 512 bytes by spec, 4096 on
 *     Linux) are atomic with respect to other writers; on Windows
 *     `appendFile` opens the file with `O_APPEND` semantics that the
 *     NTFS driver serializes. Either way, the *worst* observable
 *     failure mode is a torn last line, which our reader tolerates.
 *
 * That trade-off is the deliberate cost of being able to append at
 * the engine's cycle cadence (one record per cycle, every few minutes)
 * without paying a write-temp + rename for every cycle.
 *
 * ## Rotation and retention
 *
 *   - When the active file's size hits `maxBytes` (default 50 MB,
 *     steering rule), `rotate()` renames it to
 *     `<historyPath>.<UTC-stamp>.ndjson` (e.g.
 *     `history.ndjson.2026-06-21T14-12-00Z.ndjson`). The colons in
 *     the time portion are replaced with dashes so the name is
 *     portable across Windows volumes.
 *   - `purgeOldArchives()` then unlinks any sibling whose embedded
 *     timestamp is older than `retentionDays` (default 14 days,
 *     steering rule). Files that don't match the rotation naming
 *     pattern are left alone — the operator can drop arbitrary
 *     `.ndjson` siblings into the directory without fear of losing
 *     them to the retention sweep.
 *
 * No logging, no engine logic. The orchestrator is responsible for
 * sequencing reads/writes and producing well-formed payloads.
 */

import { createReadStream, promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';

/**
 * Default location of the persisted history file inside the plugin
 * container. Tests must override via {@link HistoryStoreOptions}.
 */
export const DEFAULT_HISTORY_PATH = '/data/history.ndjson';

/**
 * Steering: rolling history capped at 50 MB before the active file
 * is rotated to a sibling archive.
 */
export const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

/**
 * Steering: archives older than 14 days are purged on every
 * rotation.
 */
export const DEFAULT_RETENTION_DAYS = 14;

/**
 * Optional overrides for the history-store functions.
 *
 *   - `historyPath`    — target file path (default
 *                         {@link DEFAULT_HISTORY_PATH}).
 *   - `maxBytes`       — rotation threshold (default
 *                         {@link DEFAULT_MAX_BYTES}).
 *   - `retentionDays`  — archive retention window (default
 *                         {@link DEFAULT_RETENTION_DAYS}).
 *   - `now`            — clock injection used by `rotate` (for the
 *                         archive name) and `purgeOldArchives` (for
 *                         the cutoff). Defaults to
 *                         `() => new Date()`. Tests override this
 *                         to make rotation timestamps and retention
 *                         decisions deterministic.
 */
export interface HistoryStoreOptions {
  historyPath?: string;
  maxBytes?: number;
  retentionDays?: number;
  now?: () => Date;
}

/**
 * Generic envelope for one NDJSON line. Each line carries a creation
 * timestamp, a correlation `cycleId` (so multi-window decisions from
 * the same cycle can be grouped), and a typed payload. The history
 * store itself does not constrain `T`; the orchestrator will pass
 * `DecisionRecord` (Task 8) and other writers can pass their own
 * payloads.
 */
export interface HistoryRecord<T = unknown> {
  ts: string;
  cycleId: string;
  payload: T;
}

interface ResolvedOptions {
  historyPath: string;
  maxBytes: number;
  retentionDays: number;
  now: () => Date;
}

function resolveOptions(options?: HistoryStoreOptions): ResolvedOptions {
  return {
    historyPath: options?.historyPath ?? DEFAULT_HISTORY_PATH,
    maxBytes: options?.maxBytes ?? DEFAULT_MAX_BYTES,
    retentionDays: options?.retentionDays ?? DEFAULT_RETENTION_DAYS,
    now: options?.now ?? ((): Date => new Date()),
  };
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return (
    err instanceof Error &&
    typeof (err as NodeJS.ErrnoException).code === 'string'
  );
}

/**
 * Format a UTC stamp suitable for embedding in a rotated archive
 * filename. Example: `2026-06-21T14-12-00Z`.
 *
 * Why drop the milliseconds and dash the time portion?
 *   - Windows / NTFS rejects `:` in filenames; `-` is portable.
 *   - Second precision is enough for retention decisions and avoids
 *     visual noise when the operator inspects `/data/` directly.
 */
function formatRotationStamp(d: Date): string {
  // Date.prototype.toISOString → 'YYYY-MM-DDTHH:MM:SS.sssZ'
  const iso = d.toISOString();
  const noMs = iso.replace(/\.\d{3}Z$/, 'Z');
  return noMs.replace(/T(\d{2}):(\d{2}):(\d{2})Z$/, 'T$1-$2-$3Z');
}

/**
 * Inverse of {@link formatRotationStamp}. Returns `null` when the
 * input string does not match the rotation naming pattern; callers
 * use that to skip non-rotation siblings during purge.
 */
function parseRotationStamp(s: string): Date | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z$/.exec(s);
  if (m === null) {
    return null;
  }
  const iso = `${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    return null;
  }
  return new Date(ms);
}

/**
 * Append one record as a single NDJSON line. Creates the parent
 * directory on first use. Triggers `rotate()` if the file size
 * crosses {@link HistoryStoreOptions.maxBytes} after the append.
 *
 * `record` must be JSON-serializable — `JSON.stringify` will throw on
 * a circular structure, which propagates here unchanged. The caller
 * is expected to have validated the payload (the schema layer in
 * `src/shared/decision-schema.ts` is the canonical validator for the
 * orchestrator's case).
 *
 * Concurrency: `fs.appendFile` opens the file with `O_APPEND` so the
 * kernel serializes the write — concurrent appenders cannot tear a
 * line. The rotation path is protected by treating ENOENT on the
 * stat / rename as "another appender already rotated", which is the
 * only race that matters here.
 */
export async function appendRecord<T>(
  record: HistoryRecord<T>,
  options?: HistoryStoreOptions,
): Promise<void> {
  const opts = resolveOptions(options);
  await fs.mkdir(path.dirname(opts.historyPath), { recursive: true });

  const line = `${JSON.stringify(record)}\n`;
  // appendFile opens with O_APPEND | O_CREAT, so on POSIX the kernel
  // serializes concurrent writers and the call always succeeds for a
  // regular file. Windows can briefly surface EBUSY / EPERM /  EACCES
  // when a peer appender's rotate() is mid-rename — retry a few
  // times before giving up.
  const transientCodes: ReadonlySet<string> = new Set([
    'EBUSY',
    'EPERM',
    'EACCES',
  ]);
  const maxAttempts = 8;
  let appended = false;
  for (let attempt = 0; attempt < maxAttempts && !appended; attempt += 1) {
    try {
      await fs.appendFile(opts.historyPath, line, 'utf8');
      appended = true;
    } catch (err) {
      if (
        attempt + 1 < maxAttempts &&
        isErrnoException(err) &&
        transientCodes.has(err.code ?? '')
      ) {
        await new Promise((resolve) =>
          setTimeout(resolve, 25 + attempt * 25),
        );
        continue;
      }
      throw err;
    }
  }

  // Stat may race with a rotation by a peer appender — the file may
  // already be gone when we get here. That is not an error: it just
  // means somebody else already rotated for us. Skip the rotate() in
  // that case.
  let size: number | null = null;
  try {
    const stat = await fs.stat(opts.historyPath);
    size = stat.size;
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') {
      return;
    }
    throw err;
  }
  if (size !== null && size >= opts.maxBytes) {
    await rotate(options);
  }
}

/**
 * Rotate the active history file to a timestamped sibling and run
 * `purgeOldArchives`. The active file is renamed (atomic on POSIX,
 * serialized by NTFS on Windows); subsequent `appendRecord` calls
 * create a fresh active file via the implicit `O_CREAT` of
 * `fs.appendFile`.
 *
 * Concurrency: two appenders may both observe the threshold being
 * crossed and both call `rotate()`. The first call renames the
 * active file successfully; the second call finds it gone and
 * receives `ENOENT`. We swallow that case — the post-condition
 * "active file is below threshold" is already satisfied.
 *
 * If the chosen archive name happens to already exist (two rotations
 * in the same `now()` second), Windows raises `EEXIST` /  `EPERM`
 * on `rename`. We bump the stamp by appending a numeric suffix and
 * retry, so concurrent rotations within the same second still
 * produce distinct archive files.
 */
export async function rotate(options?: HistoryStoreOptions): Promise<void> {
  const opts = resolveOptions(options);
  const baseStamp = formatRotationStamp(opts.now());

  // Try the bare stamp first, then suffix variants. We cap the
  // collision search at a reasonable number — concurrency in the
  // expected usage (one orchestrator instance writing at 30 Hz) will
  // never produce more than a handful of rotations per second.
  const candidates: string[] = [baseStamp];
  for (let i = 1; i <= 16; i += 1) {
    candidates.push(`${baseStamp}-${i.toString().padStart(2, '0')}`);
  }

  for (const stamp of candidates) {
    const archivePath = `${opts.historyPath}.${stamp}.ndjson`;
    try {
      await fs.rename(opts.historyPath, archivePath);
      await purgeOldArchives(options);
      return;
    } catch (err) {
      if (isErrnoException(err) && err.code === 'ENOENT') {
        // A peer appender already rotated. Nothing to do.
        return;
      }
      if (
        isErrnoException(err) &&
        (err.code === 'EEXIST' ||
          err.code === 'EPERM' ||
          err.code === 'EACCES' ||
          err.code === 'EBUSY')
      ) {
        // Either another rotation already produced an archive with
        // this exact stamp (EEXIST), or NTFS is briefly holding the
        // path open (EPERM/EACCES/EBUSY). Try the next candidate
        // stamp.
        continue;
      }
      throw err;
    }
  }
  // All candidates exhausted — fall back to a noop. Subsequent
  // appendRecord calls will retry rotation on the next size check.
}

/**
 * Delete sibling archives older than `retentionDays` from `now()`.
 * Files that do not match the rotation naming pattern are skipped:
 *
 *   - `history.ndjson` itself (the active file).
 *   - Any sibling whose stamp portion fails
 *     {@link parseRotationStamp}.
 *
 * Best-effort `unlink`: if a file has already disappeared (another
 * process raced us, or the operator removed it manually) we move
 * on to the next entry rather than aborting the sweep.
 */
export async function purgeOldArchives(
  options?: HistoryStoreOptions,
): Promise<void> {
  const opts = resolveOptions(options);
  const dir = path.dirname(opts.historyPath);
  const baseName = path.basename(opts.historyPath);
  const prefix = `${baseName}.`;
  const suffix = '.ndjson';

  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') {
      return;
    }
    throw err;
  }

  const cutoffMs =
    opts.now().getTime() - opts.retentionDays * 86_400 * 1000;

  for (const entry of entries) {
    if (entry === baseName) {
      continue;
    }
    if (!entry.startsWith(prefix) || !entry.endsWith(suffix)) {
      continue;
    }
    const stamp = entry.slice(prefix.length, entry.length - suffix.length);
    const ts = parseRotationStamp(stamp);
    if (ts === null) {
      continue;
    }
    if (ts.getTime() < cutoffMs) {
      try {
        await fs.unlink(path.join(dir, entry));
      } catch {
        // Best-effort: the file may already be gone. Pressing on is
        // safer than aborting and leaving the rest of the sweep
        // unfinished.
      }
    }
  }
}

/**
 * Stream the active history file as a sequence of parsed
 * `HistoryRecord<T>` values. Yields nothing when the file does not
 * exist (fresh container, just-rotated state).
 *
 * Lines that fail `JSON.parse` are silently skipped — see the
 * atomicity note at the top of the file. Empty lines (e.g. a stray
 * trailing newline after the last record) are also skipped.
 *
 * Implementation note: uses `createReadStream` + `readline` so the
 * memory footprint stays O(line) rather than O(file). The history
 * file can grow up to 50 MB; loading it whole would defeat the
 * point of the streaming API.
 */
export async function* readRecords<T = unknown>(
  options?: HistoryStoreOptions,
): AsyncGenerator<HistoryRecord<T>, void, void> {
  const opts = resolveOptions(options);

  // Stat first so a missing file is handled cleanly. createReadStream
  // surfaces ENOENT through an 'error' event, which is awkward to
  // bridge into a generator's error channel.
  try {
    await fs.stat(opts.historyPath);
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') {
      return;
    }
    throw err;
  }

  const stream = createReadStream(opts.historyPath, { encoding: 'utf8' });
  const rl = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  try {
    for await (const line of rl) {
      if (line.length === 0) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // Malformed line — see atomicity note. Skip and continue.
        continue;
      }
      yield parsed as HistoryRecord<T>;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

/**
 * Convenience wrapper for the dashboard's "last 200 decisions"
 * panel. Streams the active file with a fixed-size ring buffer of
 * size `n`, so the memory footprint stays O(n) regardless of the
 * file size.
 *
 * Returns `[]` when the file does not exist or when `n <= 0`. The
 * returned array is in insertion order (oldest of the kept window
 * first, newest last).
 */
export async function readLastN<T = unknown>(
  n: number,
  options?: HistoryStoreOptions,
): Promise<HistoryRecord<T>[]> {
  if (n <= 0) {
    return [];
  }

  const ring: (HistoryRecord<T> | undefined)[] = new Array<
    HistoryRecord<T> | undefined
  >(n);
  let count = 0;

  for await (const rec of readRecords<T>(options)) {
    ring[count % n] = rec;
    count += 1;
  }

  if (count === 0) {
    return [];
  }

  const len = Math.min(count, n);
  const start = count > n ? count % n : 0;
  const out: HistoryRecord<T>[] = [];
  for (let i = 0; i < len; i += 1) {
    const item = ring[(start + i) % n];
    if (item !== undefined) {
      out.push(item);
    }
  }
  return out;
}
