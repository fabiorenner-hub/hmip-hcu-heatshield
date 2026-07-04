/**
 * Building-project index store (shared-building-model 2.2). Verifies seeding,
 * create/rename/activate/delete and the guards (never delete the default or the
 * last project) against a real temp dir.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  readProjectIndex,
  createProject,
  renameProject,
  setActiveProject,
  deleteProject,
  getActiveProjectId,
} from '../../src/plugin/persistence/projectStore.js';

let dataDir: string;
beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'heat-shield-proj-'));
});
afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('projectStore', () => {
  it('seeds a single default project when none exists', async () => {
    const idx = await readProjectIndex({ dataDir });
    expect(idx.activeId).toBe('default');
    expect(idx.projects).toHaveLength(1);
    expect(idx.projects[0]?.id).toBe('default');
  });

  it('creates a project (auto-active) and can switch back', async () => {
    const created = await createProject('Ferienhaus', { dataDir });
    expect(created.projects).toHaveLength(2);
    expect(created.activeId).not.toBe('default');
    const back = await setActiveProject('default', { dataDir });
    expect(back.activeId).toBe('default');
    expect(await getActiveProjectId({ dataDir })).toBe('default');
  });

  it('auto-names when the given name is blank', async () => {
    const created = await createProject('   ', { dataDir });
    const active = created.projects.find((p) => p.id === created.activeId);
    expect(active?.name).toMatch(/Projekt/u);
  });

  it('renames a project', async () => {
    const created = await createProject('Temp', { dataDir });
    const renamed = await renameProject(created.activeId, 'Neu', { dataDir });
    expect(renamed.projects.find((p) => p.id === created.activeId)?.name).toBe('Neu');
  });

  it('never deletes the default or the last project', async () => {
    const onlyDefault = await deleteProject('default', { dataDir });
    expect(onlyDefault.projects.some((p) => p.id === 'default')).toBe(true);
    // With two projects, deleting the default is still refused.
    const created = await createProject('X', { dataDir });
    const afterDefault = await deleteProject('default', { dataDir });
    expect(afterDefault.projects.some((p) => p.id === 'default')).toBe(true);
    // Deleting the non-default succeeds and re-activates a remaining one.
    const afterDelete = await deleteProject(created.activeId, { dataDir });
    expect(afterDelete.projects.some((p) => p.id === created.activeId)).toBe(false);
    expect(afterDelete.projects).toHaveLength(1);
  });

  it('deleting the active project re-activates the default', async () => {
    const created = await createProject('X', { dataDir });
    expect(created.activeId).not.toBe('default');
    const after = await deleteProject(created.activeId, { dataDir });
    expect(after.activeId).toBe('default');
  });
});
