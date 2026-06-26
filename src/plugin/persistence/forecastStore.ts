/**
 * Heat Shield — forecast/plan persistence (predictive-control-dashboard
 * Requirement 4.1, 5.7). Persists ONLY under `/data/`.
 *
 *   - `forecast-plan.json`     — latest position plan + PlannedAction[].
 *   - `forecast-baseline.json` — per-room forecast-now values for the next
 *                                cycle's deviation check.
 *   - `forecast.ndjson`        — rolling per-cycle trajectory snapshots
 *                                (bounded line count).
 *
 * All reads are defensive: a missing or corrupt file resolves to a null/empty
 * result rather than throwing, so the engine never blocks on persistence.
 */

import { createReadStream, promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';

import { atomicWriteJson } from './_atomic.js';
import type { DeviationBaseline } from '../engine/forecast/planner.js';
import type { PlannedAction } from '../engine/forecast/positionSelector.js';

export const DEFAULT_DATA_DIR = '/data';
const MAX_TRAJECTORY_LINES = 500;

export interface ForecastStoreOptions {
  dataDir?: string;
}

function dir(options?: ForecastStoreOptions): string {
  return options?.dataDir ?? DEFAULT_DATA_DIR;
}
function planPath(o?: ForecastStoreOptions): string {
  return path.join(dir(o), 'forecast-plan.json');
}
function baselinePath(o?: ForecastStoreOptions): string {
  return path.join(dir(o), 'forecast-baseline.json');
}
function trajPath(o?: ForecastStoreOptions): string {
  return path.join(dir(o), 'forecast.ndjson');
}

function isEnoent(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

export interface StoredPlan {
  ts: string;
  windows: Array<{ windowId: string; target01: number; noMoveNeeded: boolean }>;
  plannedActions: PlannedAction[];
}

/** Write the latest plan snapshot. Never throws on the caller side. */
export async function writePlan(
  plan: StoredPlan,
  options?: ForecastStoreOptions,
): Promise<void> {
  await atomicWriteJson(planPath(options), plan);
}

/** Read the latest plan snapshot, or null when missing/corrupt. */
export async function readPlan(
  options?: ForecastStoreOptions,
): Promise<StoredPlan | null> {
  try {
    const raw = await fs.readFile(planPath(options), 'utf8');
    return JSON.parse(raw) as StoredPlan;
  } catch {
    return null;
  }
}

/** Write the deviation baseline for the next cycle. */
export async function writeBaseline(
  baseline: DeviationBaseline,
  options?: ForecastStoreOptions,
): Promise<void> {
  await atomicWriteJson(baselinePath(options), baseline);
}

/**
 * Read the deviation baseline. Returns `{}` when missing or corrupt, so the
 * deviation detector simply skips (no off-plan move on invalid data).
 */
export async function readBaseline(
  options?: ForecastStoreOptions,
): Promise<DeviationBaseline> {
  try {
    const raw = await fs.readFile(baselinePath(options), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    return parsed as DeviationBaseline;
  } catch {
    return {};
  }
}

/** Append a trajectory snapshot line, keeping the file bounded. */
export async function appendTrajectorySnapshot(
  snapshot: unknown,
  options?: ForecastStoreOptions,
): Promise<void> {
  const p = trajPath(options);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.appendFile(p, `${JSON.stringify(snapshot)}\n`, 'utf8');
  await rollIfNeeded(p);
}

async function rollIfNeeded(p: string): Promise<void> {
  try {
    const lines: string[] = [];
    const stream = createReadStream(p, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (line.length > 0) lines.push(line);
    }
    rl.close();
    stream.destroy();
    if (lines.length > MAX_TRAJECTORY_LINES) {
      const kept = lines.slice(lines.length - MAX_TRAJECTORY_LINES);
      await fs.writeFile(p, `${kept.join('\n')}\n`, 'utf8');
    }
  } catch (err) {
    if (!isEnoent(err)) {
      // best-effort rolling; ignore
    }
  }
}
