/**
 * Heat Shield — Building-project index (shared-building-model 2.2).
 *
 * Multi-project support layered on top of {@link buildingStore} without
 * breaking the legacy single-model install:
 *   - The index lives at `/data/building/projects.json` and records the set of
 *     projects plus the active one.
 *   - The DEFAULT project (`'default'`) maps to the legacy root paths
 *     (`/data/building/model.json` + `history/`); any other project lives under
 *     `/data/building/projects/<id>/`.
 *   - When the index is missing it is seeded with a single `'default'` project,
 *     so existing installs transparently gain a one-project index.
 *
 * Pure I/O at the edge: atomic writes, defensive reads (a corrupt index
 * re-seeds rather than throwing). No engine logic, no logging.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { atomicWriteJson } from './_atomic.js';
import {
  DEFAULT_DATA_DIR,
  DEFAULT_PROJECT_ID,
  type BuildingStoreOptions,
} from './buildingStore.js';

export interface ProjectMeta {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectIndex {
  activeId: string;
  projects: ProjectMeta[];
}

function indexPath(dataDir: string): string {
  return path.join(dataDir, 'building', 'projects.json');
}

function projectDir(dataDir: string, id: string): string {
  return id === DEFAULT_PROJECT_ID
    ? path.join(dataDir, 'building')
    : path.join(dataDir, 'building', 'projects', id);
}

function nowIso(): string {
  return new Date().toISOString();
}

function seedIndex(): ProjectIndex {
  const ts = nowIso();
  return {
    activeId: DEFAULT_PROJECT_ID,
    projects: [{ id: DEFAULT_PROJECT_ID, name: 'Standard', createdAt: ts, updatedAt: ts }],
  };
}

function isProjectMeta(v: unknown): v is ProjectMeta {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.id === 'string' && typeof o.name === 'string' && typeof o.createdAt === 'string' && typeof o.updatedAt === 'string';
}

/** Defensively parse a persisted index, falling back to a fresh seed. */
function parseIndex(raw: unknown): ProjectIndex {
  if (raw === null || typeof raw !== 'object') return seedIndex();
  const o = raw as Record<string, unknown>;
  const projects = Array.isArray(o.projects) ? o.projects.filter(isProjectMeta) : [];
  if (projects.length === 0) return seedIndex();
  const activeId = typeof o.activeId === 'string' && projects.some((p) => p.id === o.activeId)
    ? o.activeId
    : (projects[0] as ProjectMeta).id;
  return { activeId, projects };
}

/** Read the project index, seeding + persisting a default one when absent. */
export async function readProjectIndex(options?: BuildingStoreOptions): Promise<ProjectIndex> {
  const dataDir = options?.dataDir ?? DEFAULT_DATA_DIR;
  try {
    const raw = await fs.readFile(indexPath(dataDir), 'utf8');
    return parseIndex(JSON.parse(raw));
  } catch {
    const seeded = seedIndex();
    try {
      await atomicWriteJson(indexPath(dataDir), seeded);
    } catch {
      /* best-effort seed */
    }
    return seeded;
  }
}

async function writeIndex(index: ProjectIndex, options?: BuildingStoreOptions): Promise<void> {
  const dataDir = options?.dataDir ?? DEFAULT_DATA_DIR;
  await atomicWriteJson(indexPath(dataDir), index);
}

/** The active project's id (seeds the index if missing). */
export async function getActiveProjectId(options?: BuildingStoreOptions): Promise<string> {
  return (await readProjectIndex(options)).activeId;
}

/** Create a new project. Returns the updated index (new project becomes active). */
export async function createProject(name: string, options?: BuildingStoreOptions): Promise<ProjectIndex> {
  const index = await readProjectIndex(options);
  const trimmed = name.trim() || `Projekt ${index.projects.length + 1}`;
  const ts = nowIso();
  const meta: ProjectMeta = { id: randomUUID(), name: trimmed, createdAt: ts, updatedAt: ts };
  const next: ProjectIndex = { activeId: meta.id, projects: [...index.projects, meta] };
  await writeIndex(next, options);
  return next;
}

/** Rename a project. No-op when the id is unknown. */
export async function renameProject(id: string, name: string, options?: BuildingStoreOptions): Promise<ProjectIndex> {
  const index = await readProjectIndex(options);
  const trimmed = name.trim();
  const next: ProjectIndex = {
    activeId: index.activeId,
    projects: index.projects.map((p) => (p.id === id && trimmed.length > 0 ? { ...p, name: trimmed, updatedAt: nowIso() } : p)),
  };
  await writeIndex(next, options);
  return next;
}

/** Set the active project. No-op when the id is unknown. */
export async function setActiveProject(id: string, options?: BuildingStoreOptions): Promise<ProjectIndex> {
  const index = await readProjectIndex(options);
  if (!index.projects.some((p) => p.id === id)) return index;
  const next: ProjectIndex = { activeId: id, projects: index.projects };
  await writeIndex(next, options);
  return next;
}

/**
 * Delete a project (never the default, never the last remaining one). Removes
 * its data directory too. If the deleted project was active, the default (or
 * the first remaining) becomes active. Returns the updated index.
 */
export async function deleteProject(id: string, options?: BuildingStoreOptions): Promise<ProjectIndex> {
  const dataDir = options?.dataDir ?? DEFAULT_DATA_DIR;
  const index = await readProjectIndex(options);
  if (id === DEFAULT_PROJECT_ID || index.projects.length <= 1 || !index.projects.some((p) => p.id === id)) {
    return index;
  }
  const remaining = index.projects.filter((p) => p.id !== id);
  const activeId = index.activeId === id
    ? (remaining.some((p) => p.id === DEFAULT_PROJECT_ID) ? DEFAULT_PROJECT_ID : (remaining[0] as ProjectMeta).id)
    : index.activeId;
  const next: ProjectIndex = { activeId, projects: remaining };
  await writeIndex(next, options);
  // Best-effort removal of the project's data (never the shared default root).
  try {
    await fs.rm(projectDir(dataDir, id), { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  return next;
}
