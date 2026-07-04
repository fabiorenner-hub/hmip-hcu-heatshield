/**
 * Heat Shield — thermal calculation-snapshot persistence (thermal-load-engine).
 *
 * Stores non-normative Quick Estimate v1 results per active project under
 * `/data/building/<project>/thermal/snap-<n>.json` so a computed estimate can
 * be captured for later comparison. Mirrors the revision-history pattern:
 * atomic writes, defensive reads, newest-first listing, capped retention.
 *
 * The default project maps to the legacy root (`/data/building/thermal`), other
 * projects to `/data/building/projects/<id>/thermal`. Pure I/O at the edge.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { atomicWriteJson } from './_atomic.js';
import { DEFAULT_DATA_DIR, DEFAULT_PROJECT_ID, type BuildingStoreOptions } from './buildingStore.js';

const MAX_SNAPSHOTS = 100;

function thermalDir(o?: BuildingStoreOptions): string {
  const base = path.join(o?.dataDir ?? DEFAULT_DATA_DIR, 'building');
  const root = o?.projectId === undefined || o.projectId === DEFAULT_PROJECT_ID
    ? base
    : path.join(base, 'projects', o.projectId);
  return path.join(root, 'thermal');
}

export interface ThermalSnapshotSummary {
  id: string;
  savedAt: string;
  modelRevision: number;
  profile: string;
  inputHash: string;
  buildingHeatingW: number;
  buildingCoolingW: number;
}

interface StoredSnapshot {
  id: string;
  savedAt: string;
  estimate: unknown;
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function summarise(id: string, savedAt: string, estimate: unknown): ThermalSnapshotSummary {
  const e = (estimate ?? {}) as Record<string, unknown>;
  const heating = (e['heating'] ?? {}) as Record<string, unknown>;
  const cooling = (e['cooling'] ?? {}) as Record<string, unknown>;
  return {
    id,
    savedAt,
    modelRevision: num(e['modelRevision']),
    profile: str(e['profile'], 'quick-estimate-v1'),
    inputHash: str(e['inputHash']),
    buildingHeatingW: num(heating['buildingTotalW']),
    buildingCoolingW: num(cooling['buildingPeakW']),
  };
}

/** Save a computed estimate as a new snapshot; returns its summary. */
export async function saveThermalSnapshot(
  estimate: unknown,
  options?: BuildingStoreOptions,
): Promise<ThermalSnapshotSummary> {
  const savedAt = new Date().toISOString();
  const id = `snap-${savedAt.replace(/[:.]/gu, '-')}`;
  const payload: StoredSnapshot = { id, savedAt, estimate };
  await atomicWriteJson(path.join(thermalDir(options), `${id}.json`), payload);
  return summarise(id, savedAt, estimate);
}

/** List snapshot summaries, newest first (capped). */
export async function listThermalSnapshots(options?: BuildingStoreOptions): Promise<ThermalSnapshotSummary[]> {
  let names: string[];
  try {
    names = await fs.readdir(thermalDir(options));
  } catch {
    return [];
  }
  const out: ThermalSnapshotSummary[] = [];
  for (const name of names) {
    if (!/^snap-.*\.json$/u.test(name)) continue;
    try {
      const raw = await fs.readFile(path.join(thermalDir(options), name), 'utf8');
      const parsed = JSON.parse(raw) as StoredSnapshot;
      out.push(summarise(parsed.id, parsed.savedAt, parsed.estimate));
    } catch {
      /* skip unreadable snapshot */
    }
  }
  out.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  return out.slice(0, MAX_SNAPSHOTS);
}

/** Read one full snapshot (estimate payload), or null when missing. */
export async function readThermalSnapshot(id: string, options?: BuildingStoreOptions): Promise<unknown | null> {
  if (!/^snap-[\w-]+$/u.test(id)) return null;
  try {
    const raw = await fs.readFile(path.join(thermalDir(options), `${id}.json`), 'utf8');
    return (JSON.parse(raw) as StoredSnapshot).estimate;
  } catch {
    return null;
  }
}
