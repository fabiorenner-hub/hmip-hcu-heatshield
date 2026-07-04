/**
 * Heat Shield — Building Model Studio persistence (building-model-editor spec,
 * Phase 1 / shared-building-model 2.1). Persists the canonical building model
 * ONLY under `/data/building/model.json`.
 *
 * Contract:
 *   - {@link readBuildingModel} — defensive read: missing/corrupt file → null
 *     (the caller then seeds a default). A shape-invalid file also → null
 *     rather than throwing, so persistence never blocks the dashboard.
 *   - {@link writeBuildingModel} — atomic temp+rename via `atomicWriteJson`.
 *   - {@link saveBuildingModel} — optimistic-concurrency save: compares the
 *     incoming `expectedRevision` against the persisted revision, commits a
 *     new revision only when content changed (see `commitRevision`), and
 *     returns a typed stale result on conflict.
 *
 * No engine logic, no logging. Pure I/O at the edge; all model reasoning is
 * delegated to the pure `building-model*` modules.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { atomicWriteJson } from './_atomic.js';
import {
  parseBuildingModel,
  type BuildingModel,
} from '../../shared/building-model.js';
import { migrateBuildingModel } from '../../shared/building-migrate.js';
import {
  commitRevision,
  checkRevision,
  contentHash,
  type RevisionCheck,
} from '../../shared/building-model-canonical.js';

export const DEFAULT_DATA_DIR = '/data';

/** The default project id — its model lives at the legacy root paths. */
export const DEFAULT_PROJECT_ID = 'default';

export interface BuildingStoreOptions {
  dataDir?: string;
  /**
   * Project selector. Undefined or {@link DEFAULT_PROJECT_ID} → the legacy
   * single-model paths (`/data/building/model.json` + `/data/building/history`)
   * so existing installs keep working untouched. Any other id resolves to
   * `/data/building/projects/<id>/…`.
   */
  projectId?: string;
}

function isDefaultProject(o?: BuildingStoreOptions): boolean {
  const id = o?.projectId;
  return id === undefined || id === DEFAULT_PROJECT_ID;
}

/** Root of a project's data (legacy root for the default project). */
function projectRoot(o?: BuildingStoreOptions): string {
  const base = path.join(o?.dataDir ?? DEFAULT_DATA_DIR, 'building');
  return isDefaultProject(o) ? base : path.join(base, 'projects', o!.projectId as string);
}

export function buildingModelPath(o?: BuildingStoreOptions): string {
  return path.join(projectRoot(o), 'model.json');
}

function historyDir(o?: BuildingStoreOptions): string {
  return path.join(projectRoot(o), 'history');
}

/** Read + migrate + shape-validate the persisted model, or null when missing/invalid. */
export async function readBuildingModel(
  options?: BuildingStoreOptions,
): Promise<BuildingModel | null> {
  try {
    const raw = await fs.readFile(buildingModelPath(options), 'utf8');
    // Migrate older `schemaVersion`s up to current, then parse. A structurally
    // invalid or unsupported-version file resolves to null (caller re-seeds)
    // rather than throwing, so persistence never blocks the dashboard.
    return migrateBuildingModel(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Write a validated model atomically + snapshot it into the revision history. */
export async function writeBuildingModel(
  model: BuildingModel,
  options?: BuildingStoreOptions,
): Promise<void> {
  // Re-validate at the edge so a corrupt in-memory model never hits disk.
  const validated = parseBuildingModel(model);
  await atomicWriteJson(buildingModelPath(options), validated);
  await snapshotRevision(validated, options);
}

export type SaveResult =
  | { ok: true; model: BuildingModel; changed: boolean }
  | { ok: false; reason: 'stale'; expected: number; actual: number };

/**
 * Optimistic-concurrency save. `expectedRevision` is the revision the client
 * based its edit on. If a persisted model exists and its revision differs, the
 * write is rejected as stale (the model moved underneath the client). On
 * success the draft is committed with a bumped revision iff its content
 * changed, then persisted.
 */
export async function saveBuildingModel(
  draft: BuildingModel,
  expectedRevision: number,
  options?: BuildingStoreOptions,
): Promise<SaveResult> {
  const current = await readBuildingModel(options);

  if (current !== null) {
    const rc: RevisionCheck = checkRevision(expectedRevision, current.revision);
    if (!rc.ok) {
      return { ok: false, reason: 'stale', expected: rc.expected, actual: rc.actual };
    }
    const { model, changed } = commitRevision(current, draft);
    await writeBuildingModel(model, options);
    return { ok: true, model, changed };
  }

  // No persisted model yet — accept the draft as the initial revision.
  await writeBuildingModel(draft, options);
  return { ok: true, model: draft, changed: true };
}

// ---------------------------------------------------------------------------
// Revision history (BME-18). Each committed revision is snapshotted under
// `/data/building/history/rev-<n>.json`; restore loads a past revision and
// re-commits it as a NEW revision (never rewrites history).
// ---------------------------------------------------------------------------

const MAX_HISTORY = 100;

function revisionPath(o: BuildingStoreOptions | undefined, revision: number): string {
  return path.join(historyDir(o), `rev-${revision}.json`);
}

/** Best-effort snapshot of a committed revision (never blocks the save). */
async function snapshotRevision(model: BuildingModel, options?: BuildingStoreOptions): Promise<void> {
  try {
    await atomicWriteJson(revisionPath(options, model.revision), model);
  } catch {
    /* history is best-effort — a failed snapshot must not fail the save */
  }
}

export interface RevisionSummary {
  revision: number;
  contentHash: string;
  savedAt: string;
}

/** List snapshotted revisions, newest first (capped at {@link MAX_HISTORY}). */
export async function listRevisions(options?: BuildingStoreOptions): Promise<RevisionSummary[]> {
  let names: string[];
  try {
    names = await fs.readdir(historyDir(options));
  } catch {
    return [];
  }
  const out: RevisionSummary[] = [];
  for (const name of names) {
    const m = /^rev-(\d+)\.json$/u.exec(name);
    if (m === null) continue;
    const revision = Number(m[1]);
    try {
      const full = path.join(historyDir(options), name);
      const [raw, stat] = await Promise.all([fs.readFile(full, 'utf8'), fs.stat(full)]);
      const model = migrateBuildingModel(JSON.parse(raw));
      out.push({ revision, contentHash: contentHash(model), savedAt: stat.mtime.toISOString() });
    } catch {
      /* skip unreadable snapshot */
    }
  }
  out.sort((a, b) => b.revision - a.revision);
  return out.slice(0, MAX_HISTORY);
}

/**
 * Restore a past revision as a NEW revision. Reads the snapshot, then commits
 * it against the current model so it advances the revision counter (history is
 * append-only; a restore never rewinds it). Returns a stale-style failure when
 * the snapshot is missing.
 */
export async function restoreRevision(
  revision: number,
  options?: BuildingStoreOptions,
): Promise<SaveResult> {
  let snapshot: BuildingModel;
  try {
    const raw = await fs.readFile(revisionPath(options, revision), 'utf8');
    snapshot = migrateBuildingModel(JSON.parse(raw));
  } catch {
    return { ok: false, reason: 'stale', expected: revision, actual: -1 };
  }
  const current = await readBuildingModel(options);
  const expected = current?.revision ?? snapshot.revision;
  // Re-commit the snapshot's geometry as a fresh revision on top of current.
  return saveBuildingModel({ ...snapshot, revision: expected }, expected, options);
}
