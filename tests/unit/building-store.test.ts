/**
 * Building Studio persistence (building-model-editor Phase 1). Verifies the
 * atomic round-trip and optimistic-concurrency (stale-write) behaviour under a
 * real temp dir.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  readBuildingModel,
  writeBuildingModel,
  saveBuildingModel,
  buildingModelPath,
  listRevisions,
  restoreRevision,
} from '../../src/plugin/persistence/buildingStore.js';
import { newBuildingModel, newEditorState, addWall, defaultEditorContext } from '../../src/shared/building-editor.js';
import type { BuildingModel } from '../../src/shared/building-model.js';

let dataDir: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'heat-shield-building-'));
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

function seed(): BuildingModel {
  const ctx = defaultEditorContext();
  return newBuildingModel(ctx, { latitude: 52.5, longitude: 13.4, timezone: 'Europe/Berlin' });
}

describe('buildingStore', () => {
  it('returns null when no model exists', async () => {
    expect(await readBuildingModel({ dataDir })).toBeNull();
  });

  it('round-trips a written model', async () => {
    const model = seed();
    await writeBuildingModel(model, { dataDir });
    const back = await readBuildingModel({ dataDir });
    expect(back).not.toBeNull();
    expect(back?.id).toBe(model.id);
    // The file lives under /building/model.json.
    expect(buildingModelPath({ dataDir }).endsWith(path.join('building', 'model.json'))).toBe(true);
  });

  it('saveBuildingModel bumps revision only when content changed', async () => {
    const model = seed();
    const first = await saveBuildingModel(model, model.revision, { dataDir });
    expect(first.ok).toBe(true);

    // Same content again → no revision bump.
    const current = (await readBuildingModel({ dataDir })) as BuildingModel;
    const noop = await saveBuildingModel(current, current.revision, { dataDir });
    expect(noop.ok && noop.changed).toBe(false);

    // Real change → revision advances.
    const ctx = defaultEditorContext();
    const edited = addWall(ctx, newEditorState(current), { axis: [{ x: 0, y: 0 }, { x: 4, y: 0 }] }).model;
    const changed = await saveBuildingModel(edited, current.revision, { dataDir });
    expect(changed.ok).toBe(true);
    if (changed.ok) expect(changed.model.revision).toBe(current.revision + 1);
  });

  it('rejects a stale write', async () => {
    const model = seed();
    await saveBuildingModel(model, model.revision, { dataDir });
    const current = (await readBuildingModel({ dataDir })) as BuildingModel;

    // Advance the persisted revision once.
    const ctx = defaultEditorContext();
    const edited = addWall(ctx, newEditorState(current), { axis: [{ x: 0, y: 0 }, { x: 3, y: 0 }] }).model;
    await saveBuildingModel(edited, current.revision, { dataDir });

    // A second client that still holds the OLD revision must be rejected.
    const stale = await saveBuildingModel(edited, current.revision, { dataDir });
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.reason).toBe('stale');
      expect(stale.actual).toBe(current.revision + 1);
    }
  });
});

describe('revision history (BME-18)', () => {
  it('snapshots each committed revision and restores as a new revision', async () => {
    const model = seed();
    await saveBuildingModel(model, model.revision, { dataDir }); // rev 1
    const current = (await readBuildingModel({ dataDir })) as BuildingModel;

    const ctx = defaultEditorContext();
    const edited = addWall(ctx, newEditorState(current), { axis: [{ x: 0, y: 0 }, { x: 4, y: 0 }] }).model;
    const r2 = await saveBuildingModel(edited, current.revision, { dataDir }); // rev 2
    expect(r2.ok).toBe(true);

    const revs = await listRevisions({ dataDir });
    expect(revs.map((r) => r.revision).sort((a, b) => a - b)).toEqual([1, 2]);
    // Newest first.
    expect(revs[0]?.revision).toBe(2);

    // Restore revision 1 → becomes a NEW revision (3), with rev-1 geometry (0 walls).
    const restored = await restoreRevision(1, { dataDir });
    expect(restored.ok).toBe(true);
    if (restored.ok) {
      expect(restored.model.revision).toBe(3);
      expect(restored.model.storeys[0]?.walls ?? []).toHaveLength(0);
    }
  });

  it('restoreRevision returns a failure for a missing snapshot', async () => {
    const model = seed();
    await saveBuildingModel(model, model.revision, { dataDir });
    const res = await restoreRevision(999, { dataDir });
    expect(res.ok).toBe(false);
  });
});
