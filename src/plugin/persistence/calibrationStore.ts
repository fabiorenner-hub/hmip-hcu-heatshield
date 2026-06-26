/**
 * Heat Shield — daily thermal-calibration store (learning module, V1.1).
 *
 * `/data/calibration.ndjson` persists one {@link CalibrationObservation} per
 * room per day (actual vs. predicted indoor peak) so the self-calibration loop
 * survives restarts. Append-only NDJSON; malformed lines are skipped. Same
 * atomicity trade-off as `learningStore.ts`/`history.ts`.
 */

import { createReadStream, promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';

import type { CalibrationObservation } from '../engine/learning/thermalCalibration.js';

export const DEFAULT_CALIBRATION_PATH = '/data/calibration.ndjson';

export interface CalibrationStoreOptions {
  calibrationPath?: string;
  /** Calendar days to retain on compaction. Default 60. */
  keepDays?: number;
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === 'string';
}

function resolvePath(options?: CalibrationStoreOptions): string {
  return options?.calibrationPath ?? DEFAULT_CALIBRATION_PATH;
}

function isValid(v: unknown): v is CalibrationObservation {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.date === 'string' &&
    o.date.length > 0 &&
    typeof o.roomId === 'string' &&
    o.roomId.length > 0
  );
}

async function appendOne(
  obs: CalibrationObservation,
  options?: CalibrationStoreOptions,
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
export async function appendCalibrationObservations(
  batch: ReadonlyArray<CalibrationObservation>,
  options?: CalibrationStoreOptions,
): Promise<void> {
  for (const obs of batch) {
    await appendOne(obs, options);
  }
}

/** Read every persisted observation, skipping malformed lines. */
export async function readCalibrationObservations(
  options?: CalibrationStoreOptions,
): Promise<CalibrationObservation[]> {
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
  const out: CalibrationObservation[] = [];
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (isValid(parsed)) out.push(parsed);
      } catch {
        /* skip malformed line */
      }
    }
  } finally {
    rl.close();
    stream.close();
  }
  return out;
}

/**
 * Atomically rewrite the file keeping only the most recent `keepDays` calendar
 * days from the supplied in-memory list.
 */
export async function compactCalibration(
  all: ReadonlyArray<CalibrationObservation>,
  options?: CalibrationStoreOptions,
): Promise<void> {
  const p = resolvePath(options);
  const keepDays = options?.keepDays ?? 60;
  const days = Array.from(new Set(all.map((o) => o.date))).sort();
  const keep = new Set(days.slice(-keepDays));
  const kept = all.filter((o) => keep.has(o.date));
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  const body = kept.map((o) => JSON.stringify(o)).join('\n');
  await fs.writeFile(tmp, body.length > 0 ? `${body}\n` : '', 'utf8');
  await fs.rename(tmp, p);
}
