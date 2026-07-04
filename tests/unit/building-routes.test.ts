/**
 * Building Model HTTP integration tests (shared-building-model 3.3). Drives the
 * real DashboardServer routes via `inject()` with the building deps wired to
 * the REAL `buildingStore` on a temp dir — so GET/PUT/validate/export and the
 * 409 stale-conflict path are exercised end-to-end.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { DashboardServer, type DashboardServerDeps, type DashboardSnapshot } from '../../src/plugin/dashboard/server.js';
import { readBuildingModel, writeBuildingModel, saveBuildingModel, listRevisions, restoreRevision } from '../../src/plugin/persistence/buildingStore.js';
import { readProjectIndex, createProject, renameProject, deleteProject, setActiveProject, getActiveProjectId } from '../../src/plugin/persistence/projectStore.js';
import { saveThermalSnapshot, listThermalSnapshots, readThermalSnapshot } from '../../src/plugin/persistence/thermalStore.js';
import { newBuildingModel, newEditorState, addWall, defaultEditorContext } from '../../src/shared/building-editor.js';
import type { BuildingModel } from '../../src/shared/building-model.js';
import type { Config } from '../../src/shared/types.js';

let dataDir: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'heat-shield-broutes-'));
});
afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

async function getOrSeed(): Promise<BuildingModel> {
  const projectId = await getActiveProjectId({ dataDir });
  const existing = await readBuildingModel({ dataDir, projectId });
  if (existing !== null) return existing;
  const seed = newBuildingModel(defaultEditorContext(), { latitude: 52.5, longitude: 13.4, timezone: 'Europe/Berlin' });
  await writeBuildingModel(seed, { dataDir, projectId });
  return seed;
}

async function activeOpts(): Promise<{ dataDir: string; projectId: string }> {
  return { dataDir, projectId: await getActiveProjectId({ dataDir }) };
}

function baseDeps(withBuilding: boolean): DashboardServerDeps {
  const noop = async (): Promise<void> => undefined;
  const deps: DashboardServerDeps = {
    config: () => ({}) as unknown as Config,
    updateConfig: noop,
    readState: async () => null,
    readDecisions: async () => [],
    readHistory: async () => [],
    readTrends: async () => [],
    getSnapshot: async () => ({}) as unknown as DashboardSnapshot,
    probe: async () => ({ mode: 'NORMAL' as const, windowDecisions: [] }),
    setShutterManually: noop,
    setMaintenanceMode: noop,
    resetConfig: noop,
    subscribe: () => () => undefined,
  };
  if (withBuilding) {
    deps.getBuildingModel = getOrSeed;
    deps.saveBuildingModel = async (draft, expectedRevision) => saveBuildingModel(draft, expectedRevision, await activeOpts());
    deps.listRevisions = async () => listRevisions(await activeOpts());
    deps.restoreRevision = async (revision) => restoreRevision(revision, await activeOpts());
    deps.listProjects = () => readProjectIndex({ dataDir });
    deps.createProject = (name) => createProject(name, { dataDir });
    deps.renameProject = (id, name) => renameProject(id, name, { dataDir });
    deps.deleteProject = (id) => deleteProject(id, { dataDir });
    deps.activateProject = (id) => setActiveProject(id, { dataDir });
    deps.saveThermalSnapshot = async (estimate) => saveThermalSnapshot(estimate, await activeOpts());
    deps.listThermalSnapshots = async () => listThermalSnapshots(await activeOpts());
    deps.readThermalSnapshot = async (id) => readThermalSnapshot(id, await activeOpts());
  }
  return deps;
}

function makeServer(withBuilding = true): DashboardServer {
  return new DashboardServer(baseDeps(withBuilding), { port: 0 });
}

describe('building HTTP routes', () => {
  it('GET /api/building seeds and returns a model', async () => {
    const server = makeServer();
    const res = await server.fastify.inject({ method: 'GET', url: '/api/building' });
    expect(res.statusCode).toBe(200);
    const model = res.json() as BuildingModel;
    expect(model.revision).toBe(1);
    expect(model.storeys).toHaveLength(1);
  });

  it('PUT saves an edit and bumps the revision', async () => {
    const server = makeServer();
    const model = (await server.fastify.inject({ method: 'GET', url: '/api/building' })).json() as BuildingModel;
    const edited = addWall(defaultEditorContext(), newEditorState(model), { axis: [{ x: 0, y: 0 }, { x: 4, y: 0 }] }).model;
    const res = await server.fastify.inject({
      method: 'PUT',
      url: `/api/building?expectedRevision=${model.revision}`,
      payload: edited,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; changed: boolean; model: BuildingModel };
    expect(body.ok).toBe(true);
    expect(body.changed).toBe(true);
    expect(body.model.revision).toBe(model.revision + 1);
  });

  it('PUT with a stale expectedRevision returns 409', async () => {
    const server = makeServer();
    const model = (await server.fastify.inject({ method: 'GET', url: '/api/building' })).json() as BuildingModel;
    const edited = addWall(defaultEditorContext(), newEditorState(model), { axis: [{ x: 0, y: 0 }, { x: 3, y: 0 }] }).model;
    // First save advances the persisted revision.
    await server.fastify.inject({ method: 'PUT', url: `/api/building?expectedRevision=${model.revision}`, payload: edited });
    // Second save with the OLD revision is stale.
    const res = await server.fastify.inject({ method: 'PUT', url: `/api/building?expectedRevision=${model.revision}`, payload: edited });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('building_stale');
  });

  it('PUT with an invalid body returns 400 invalid_schema', async () => {
    const server = makeServer();
    const res = await server.fastify.inject({ method: 'PUT', url: '/api/building', payload: { not: 'a model' } });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('invalid_schema');
  });

  it('GET /api/building/validate reports a clean model', async () => {
    const server = makeServer();
    const res = await server.fastify.inject({ method: 'GET', url: '/api/building/validate' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { valid: boolean }).valid).toBe(true);
  });

  it('GET /api/building/export returns canonical JSON + content hash', async () => {
    const server = makeServer();
    const res = await server.fastify.inject({ method: 'GET', url: '/api/building/export' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { contentHash: string; canonicalJson: string; schemaVersion: string };
    expect(body.contentHash).toMatch(/^[0-9a-f]{16}$/u);
    expect(body.schemaVersion).toBe('1.0.0');
    expect(() => JSON.parse(body.canonicalJson)).not.toThrow();
  });

  it('GET /api/building/export/glb returns a binary glTF', async () => {
    const server = makeServer();
    const res = await server.fastify.inject({ method: 'GET', url: '/api/building/export/glb' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('model/gltf-binary');
    // GLB magic "glTF" (0x46546c67) little-endian at byte 0.
    const buf = res.rawPayload;
    expect(buf.readUInt32LE(0)).toBe(0x46546c67);
    expect(buf.readUInt32LE(4)).toBe(2);
  });

  it('lists history and restores a revision as a new one', async () => {
    const server = makeServer();
    const model = (await server.fastify.inject({ method: 'GET', url: '/api/building' })).json() as BuildingModel;
    const edited = addWall(defaultEditorContext(), newEditorState(model), { axis: [{ x: 0, y: 0 }, { x: 4, y: 0 }] }).model;
    await server.fastify.inject({ method: 'PUT', url: `/api/building?expectedRevision=${model.revision}`, payload: edited });

    const hist = await server.fastify.inject({ method: 'GET', url: '/api/building/history' });
    expect(hist.statusCode).toBe(200);
    const revisions = (hist.json() as { revisions: Array<{ revision: number }> }).revisions;
    expect(revisions.length).toBeGreaterThanOrEqual(2);

    const restore = await server.fastify.inject({ method: 'POST', url: '/api/building/restore/1' });
    expect(restore.statusCode).toBe(200);
    expect((restore.json() as { model: BuildingModel }).model.revision).toBeGreaterThan(2);

    const missing = await server.fastify.inject({ method: 'POST', url: '/api/building/restore/999' });
    expect(missing.statusCode).toBe(404);
  });

  it('returns 503 when the building deps are not wired', async () => {
    const server = makeServer(false);
    for (const url of ['/api/building', '/api/building/validate', '/api/building/export']) {
      const res = await server.fastify.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(503);
    }
  });
});

describe('building project routes (shared-building-model 2.2)', () => {
  it('lists a seeded default project, creates, activates and isolates models', async () => {
    const server = makeServer();
    // Seed the default project + edit it.
    const m0 = (await server.fastify.inject({ method: 'GET', url: '/api/building' })).json() as BuildingModel;
    const edited = addWall(defaultEditorContext(), newEditorState(m0), { axis: [{ x: 0, y: 0 }, { x: 5, y: 0 }] }).model;
    await server.fastify.inject({ method: 'PUT', url: `/api/building?expectedRevision=${m0.revision}`, payload: edited });

    // Index starts with the default project active.
    const idx0 = (await server.fastify.inject({ method: 'GET', url: '/api/building/projects' })).json() as { activeId: string; projects: Array<{ id: string; name: string }> };
    expect(idx0.activeId).toBe('default');
    expect(idx0.projects).toHaveLength(1);

    // Create a second project → becomes active.
    const created = (await server.fastify.inject({ method: 'POST', url: '/api/building/projects', payload: { name: 'Ferienhaus' } })).json() as { activeId: string; projects: Array<{ id: string; name: string }> };
    expect(created.projects).toHaveLength(2);
    const newId = created.activeId;
    expect(newId).not.toBe('default');

    // The active (new) project seeds a FRESH model — the default's wall is not present.
    const mNew = (await server.fastify.inject({ method: 'GET', url: '/api/building' })).json() as BuildingModel;
    expect(mNew.storeys[0]?.walls ?? []).toHaveLength(0);

    // Switch back to default → the edited model with the wall returns.
    await server.fastify.inject({ method: 'POST', url: `/api/building/projects/default/activate` });
    const mBack = (await server.fastify.inject({ method: 'GET', url: '/api/building' })).json() as BuildingModel;
    expect(mBack.storeys[0]?.walls.length ?? 0).toBeGreaterThan(0);
  });

  it('renames and deletes a project (never the default/last)', async () => {
    const server = makeServer();
    const created = (await server.fastify.inject({ method: 'POST', url: '/api/building/projects', payload: { name: 'Temp' } })).json() as { activeId: string };
    const id = created.activeId;
    const renamed = (await server.fastify.inject({ method: 'PUT', url: `/api/building/projects/${id}`, payload: { name: 'Neu' } })).json() as { projects: Array<{ id: string; name: string }> };
    expect(renamed.projects.find((p) => p.id === id)?.name).toBe('Neu');
    // Delete the default is refused (still present).
    const afterDefaultDelete = (await server.fastify.inject({ method: 'DELETE', url: '/api/building/projects/default' })).json() as { projects: Array<{ id: string }> };
    expect(afterDefaultDelete.projects.some((p) => p.id === 'default')).toBe(true);
    // Delete the created project succeeds.
    const afterDelete = (await server.fastify.inject({ method: 'DELETE', url: `/api/building/projects/${id}` })).json() as { projects: Array<{ id: string }> };
    expect(afterDelete.projects.some((p) => p.id === id)).toBe(false);
  });

  it('returns 503 when project deps are not wired', async () => {
    const server = makeServer(false);
    const res = await server.fastify.inject({ method: 'GET', url: '/api/building/projects' });
    expect(res.statusCode).toBe(503);
  });
});

describe('thermal snapshot routes (thermal-load-engine)', () => {
  const estimate = {
    profile: 'quick-estimate-v1',
    modelRevision: 3,
    inputHash: 'deadbeef',
    heating: { buildingTotalW: 999.5, sumOfRoomsW: 1100 },
    cooling: { buildingPeakW: 640 },
  };

  it('saves, lists and reads a snapshot; 404 for unknown', async () => {
    const server = makeServer();
    const empty = (await server.fastify.inject({ method: 'GET', url: '/api/building/thermal/snapshots' })).json() as { snapshots: unknown[] };
    expect(empty.snapshots).toHaveLength(0);

    const saved = (await server.fastify.inject({ method: 'POST', url: '/api/building/thermal/snapshots', payload: estimate })).json() as { id: string; buildingHeatingW: number };
    expect(saved.buildingHeatingW).toBeCloseTo(999.5, 4);

    const list = (await server.fastify.inject({ method: 'GET', url: '/api/building/thermal/snapshots' })).json() as { snapshots: Array<{ id: string }> };
    expect(list.snapshots).toHaveLength(1);

    const one = await server.fastify.inject({ method: 'GET', url: `/api/building/thermal/snapshots/${saved.id}` });
    expect(one.statusCode).toBe(200);
    expect((one.json() as { estimate: { inputHash: string } }).estimate.inputHash).toBe('deadbeef');

    const missing = await server.fastify.inject({ method: 'GET', url: '/api/building/thermal/snapshots/snap-nope' });
    expect(missing.statusCode).toBe(404);
  });

  it('rejects a non-object body with 400 and 503 when unwired', async () => {
    const server = makeServer();
    const bad = await server.fastify.inject({ method: 'POST', url: '/api/building/thermal/snapshots', payload: '"not an object"', headers: { 'content-type': 'application/json' } });
    expect(bad.statusCode).toBe(400);
    const unwired = makeServer(false);
    const res = await unwired.fastify.inject({ method: 'GET', url: '/api/building/thermal/snapshots' });
    expect(res.statusCode).toBe(503);
  });
});
