/**
 * Heat Shield — daily learning-observation store (learning module).
 *
 * `/data/learning.ndjson` persists one {@link DailyObservation} per room per
 * day so the shading learner keeps improving across restarts. Append-only
 * NDJSON, one independently-parseable object per line; the reader skips
 * malformed lines (same atomicity trade-off as `history.ts`/`trends.ts`).
 *
 * Retention: `compact()` rewrites the file atomically keeping only the most
 * recent `keepDays` calendar days, so the file stays small.
 *
 * No logging, no engine logic.
 */

import { createReadStream, promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';

import type { DailyObservation } from '../engine/learning/shadeLearner.js';

export const DEFAULT_LEARNING_PATH = '/data/learning.ndjson';

export interface LearningStoreOptions {
  learningPath?: string;
  /** Calendar days to retain on compaction. Default 60. */
  keepDays?: number;
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === 'string';
}

function resolvePath(options?: LearningStoreOptions): string {
  return options?.learningPath ?? DEFAULT_LEARNING_PATH;
}

function isValidObservation(v: unknown): v is DailyObservation {
  if (typeof v !== 'object' || v === null) {
    return false;
  }
  const o = v as Record<string, unknown>;
  return (
    typeof o.date === 'string' &&
    o.date.length > 0 &&
    typeof o.roomId === 'string' &&
    o.roomId.length > 0 &&
    typeof o.moves === 'number'
  );
}

/** Append one daily observation as a single NDJSON line. */
export async function appendObservation(
  obs: DailyObservation,
  options?: LearningStoreOptions,
): Promise<void> {
  const p = resolvePath(options);
  await fs.mkdir(path.dirname(p), { recursive: true });
  const line = `${JSON.stringify(obs)}\n`;
  const transient: ReadonlySet<string> = new Set(['EBUSY', 'EPERM', 'EACCES']);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await fs.appendFile(p, line, 'utf8');
      return;
    } catch (err) {
      if (attempt < 7 && isErrnoException(err) && transient.has(err.code ?? '')) {
        await new Promise((resolve) => setTimeout(resolve, 25 + attempt * 25));
        continue;
      }
      throw err;
    }
  }
}

/** Append a batch of observations (one line each, in order). */
export async function appendObservations(
  batch: ReadonlyArray<DailyObservation>,
  options?: LearningStoreOptions,
): Promise<void> {
  for (const obs of batch) {
    await appendObservation(obs, options);
  }
}

/** Read every persisted observation, skipping malformed lines. */
export async function readObservations(
  options?: LearningStoreOptions,
): Promise<DailyObservation[]> {
  const p = resolvePath(options);
  try {
    await fs.stat(p);
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') {
      return [];
    }
    throw err;
  }
  const stream = createReadStream(p, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const out: DailyObservation[] = [];
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
      if (isValidObservation(parsed)) {
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
 * Rewrite the file atomically keeping only observations from the most recent
 * `keepDays` distinct calendar days present in the data.
 */
export async function compact(
  observations: ReadonlyArray<DailyObservation>,
  options?: LearningStoreOptions,
): Promise<void> {
  const p = resolvePath(options);
  const keepDays = options?.keepDays ?? 60;
  await fs.mkdir(path.dirname(p), { recursive: true });
  const days = Array.from(new Set(observations.map((o) => o.date))).sort();
  const keep = new Set(days.slice(-keepDays));
  const kept = observations.filter((o) => keep.has(o.date));
  const body = kept.length === 0 ? '' : `${kept.map((o) => JSON.stringify(o)).join('\n')}\n`;
  const tmp = path.join(
    path.dirname(p),
    `${path.basename(p)}.${process.pid}.${Date.now()}.tmp`,
  );
  let consumed = false;
  try {
    await fs.writeFile(tmp, body, 'utf8');
    const transient: ReadonlySet<string> = new Set(['EPERM', 'EACCES', 'EEXIST', 'EBUSY']);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        await fs.rename(tmp, p);
        consumed = true;
        break;
      } catch (err) {
        if (attempt < 7 && isErrnoException(err) && transient.has(err.code ?? '')) {
          await new Promise((resolve) => setTimeout(resolve, 25 + attempt * 25));
          continue;
        }
        throw err;
      }
    }
  } finally {
    if (!consumed) {
      try {
        await fs.unlink(tmp);
      } catch {
        // best-effort
      }
    }
  }
}
