/**
 * Heat Shield — NDJSON trend store
 * (smart-shading-notifications Task 1.3).
 *
 * `/data/trends.ndjson` persists the rolling multi-hour signal history so a
 * plugin restart does not lose the trend window (Requirement 6.4). Each line
 * is one `TrendSample` (`{ ts, key, value }`); the file is append-only and
 * read back defensively on boot.
 *
 * The atomicity / concurrency trade-offs are identical to `history.ts`:
 * append-only NDJSON, one independently-parseable object per line, the reader
 * skips any line that fails `JSON.parse` so a torn last line after a crash is
 * recoverable. We do not pay write-temp + rename per append.
 *
 * Retention is handled by the in-memory `TrendStore` pruning to its window;
 * to keep the file from growing without bound across restarts, `compact()`
 * rewrites the file atomically with only the samples still inside the window.
 * The orchestrator calls `compact()` opportunistically (e.g. on boot after
 * load, and periodically) rather than on every cycle.
 *
 * No logging, no engine logic.
 */

import { createReadStream, promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';

import type { TrendSample } from '../engine/trends.js';

/** Default location of the persisted trend file inside the container. */
export const DEFAULT_TRENDS_PATH = '/data/trends.ndjson';

export interface TrendStoreOptions {
  trendsPath?: string;
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return (
    err instanceof Error &&
    typeof (err as NodeJS.ErrnoException).code === 'string'
  );
}

function resolvePath(options?: TrendStoreOptions): string {
  return options?.trendsPath ?? DEFAULT_TRENDS_PATH;
}

function isValidSample(v: unknown): v is TrendSample {
  if (typeof v !== 'object' || v === null) {
    return false;
  }
  const o = v as Record<string, unknown>;
  return (
    typeof o.ts === 'string' &&
    typeof o.key === 'string' &&
    o.key.length > 0 &&
    typeof o.value === 'number' &&
    Number.isFinite(o.value)
  );
}

/**
 * Append one trend sample as a single NDJSON line. Creates the parent
 * directory on first use. Retries transient Windows file locks the same way
 * `history.appendRecord` does.
 */
export async function appendSample(
  sample: TrendSample,
  options?: TrendStoreOptions,
): Promise<void> {
  const trendsPath = resolvePath(options);
  await fs.mkdir(path.dirname(trendsPath), { recursive: true });

  const line = `${JSON.stringify(sample)}\n`;
  const transientCodes: ReadonlySet<string> = new Set([
    'EBUSY',
    'EPERM',
    'EACCES',
  ]);
  const maxAttempts = 8;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      await fs.appendFile(trendsPath, line, 'utf8');
      return;
    } catch (err) {
      if (
        attempt + 1 < maxAttempts &&
        isErrnoException(err) &&
        transientCodes.has(err.code ?? '')
      ) {
        await new Promise((resolve) => setTimeout(resolve, 25 + attempt * 25));
        continue;
      }
      throw err;
    }
  }
}

/** Append a batch of samples (one append per line, in order). */
export async function appendSamples(
  samples: ReadonlyArray<TrendSample>,
  options?: TrendStoreOptions,
): Promise<void> {
  for (const sample of samples) {
    await appendSample(sample, options);
  }
}

/**
 * Read every persisted sample, skipping malformed lines. Returns `[]` when
 * the file does not exist (fresh container). Streams the file so the memory
 * footprint stays O(line).
 */
export async function readSamples(
  options?: TrendStoreOptions,
): Promise<TrendSample[]> {
  const trendsPath = resolvePath(options);
  try {
    await fs.stat(trendsPath);
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') {
      return [];
    }
    throw err;
  }

  const stream = createReadStream(trendsPath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const out: TrendSample[] = [];
  try {
    for await (const line of rl) {
      if (line.length === 0) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (isValidSample(parsed)) {
        out.push(parsed);
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return out;
}

/**
 * Rewrite the file atomically with only the supplied samples (typically the
 * window-pruned set exported from the in-memory `TrendStore`). Keeps the
 * on-disk file from growing without bound across restarts.
 */
export async function compact(
  samples: ReadonlyArray<TrendSample>,
  options?: TrendStoreOptions,
): Promise<void> {
  const trendsPath = resolvePath(options);
  await fs.mkdir(path.dirname(trendsPath), { recursive: true });
  const body =
    samples.length === 0
      ? ''
      : `${samples.map((s) => JSON.stringify(s)).join('\n')}\n`;
  await atomicWriteText(trendsPath, body);
}

/**
 * Atomic write of a raw NDJSON text body (write-temp + rename). Mirrors the
 * Windows-aware transient-lock retry semantics of `_atomic.ts`; we cannot
 * reuse `atomicWriteJson` because the on-disk format is line-delimited JSON,
 * not a single JSON document.
 */
async function atomicWriteText(filePath: string, body: string): Promise<void> {
  const dir = path.dirname(filePath);
  const tempPath = path.join(
    dir,
    `${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  let consumed = false;
  try {
    await fs.writeFile(tempPath, body, 'utf8');
    const transientCodes: ReadonlySet<string> = new Set([
      'EPERM',
      'EACCES',
      'EEXIST',
      'EBUSY',
    ]);
    const maxAttempts = 8;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        await fs.rename(tempPath, filePath);
        consumed = true;
        break;
      } catch (err) {
        if (
          attempt + 1 < maxAttempts &&
          isErrnoException(err) &&
          transientCodes.has(err.code ?? '')
        ) {
          await new Promise((resolve) => setTimeout(resolve, 25 + attempt * 25));
          continue;
        }
        throw err;
      }
    }
  } finally {
    if (!consumed) {
      try {
        await fs.unlink(tempPath);
      } catch {
        // best-effort
      }
    }
  }
}
