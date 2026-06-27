/**
 * Heat Shield — persisted PV-orientation learner state. Persists ONLY under
 * `/data/pv-orientation.json` (a tiny accumulator). Defensive reads: a missing
 * or corrupt file resolves to an empty accumulator rather than throwing, so
 * the engine never blocks on persistence.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { atomicWriteJson } from './_atomic.js';
import {
  coercePvOrientationState,
  emptyPvOrientationState,
  type PvOrientationState,
} from '../engine/learning/pvOrientation.js';

export const DEFAULT_DATA_DIR = '/data';

export interface PvOrientationStoreOptions {
  dataDir?: string;
}

function statePath(o?: PvOrientationStoreOptions): string {
  return path.join(o?.dataDir ?? DEFAULT_DATA_DIR, 'pv-orientation.json');
}

/** Read the learner accumulator, or an empty state when missing/corrupt. */
export async function readPvOrientation(
  options?: PvOrientationStoreOptions,
): Promise<PvOrientationState> {
  try {
    const raw = await fs.readFile(statePath(options), 'utf8');
    return coercePvOrientationState(JSON.parse(raw));
  } catch {
    return emptyPvOrientationState();
  }
}

/** Write the learner accumulator. Atomic temp+rename. */
export async function writePvOrientation(
  state: PvOrientationState,
  options?: PvOrientationStoreOptions,
): Promise<void> {
  await atomicWriteJson(statePath(options), state);
}
