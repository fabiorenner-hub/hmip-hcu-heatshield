/**
 * Heat Shield — Building Studio underlay store (BME-03/04/12).
 *
 * Underlay binaries live UNDER `<dataDir>/building/underlays/<id>.<ext>` with a
 * JSON metadata index `underlays.json` — separate from the canonical model so
 * source rasters carry their own retention state and never bloat the model
 * (design §Data privacy). All writes are atomic (temp + rename). Uploads are
 * validated (media type, byte size, pixel dimensions) and metadata-stripped
 * before they touch disk.
 *
 * No engine logic, no logging.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  parseDataUrl,
  isAllowedUnderlayMedia,
  imageDimensions,
  stripImageMetadata,
} from './imageUtils.js';
import {
  clampUnderlayDisplay,
  normalizeCropPolygon,
  UNDERLAY_KINDS,
  type UnderlayKind,
  type UnderlayMeta,
} from '../../shared/building-underlay.js';

export const DEFAULT_DATA_DIR = '/data';
export const MAX_UNDERLAY_BYTES = 16 * 1024 * 1024;
export const MAX_UNDERLAY_DIM = 12000;

export interface UnderlayStoreOptions {
  dataDir?: string;
}

function underlaysDir(o?: UnderlayStoreOptions): string {
  return path.join(o?.dataDir ?? DEFAULT_DATA_DIR, 'building', 'underlays');
}
function indexPath(o?: UnderlayStoreOptions): string {
  return path.join(underlaysDir(o), 'underlays.json');
}
function extFor(mediaType: string): string {
  return mediaType === 'image/png' ? 'png' : 'jpg';
}
function binaryPath(o: UnderlayStoreOptions | undefined, meta: UnderlayMeta): string {
  return path.join(underlaysDir(o), `${meta.id}.${extFor(meta.mediaType)}`);
}

async function atomicWriteBytes(filePath: string, bytes: Buffer): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.tmp-${randomUUID()}`);
  await fs.writeFile(tmp, bytes);
  await fs.rename(tmp, filePath);
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.tmp-${randomUUID()}`);
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(tmp, filePath);
}

/** Defensive: an object is a plausible UnderlayMeta. */
function coerceMeta(x: unknown): UnderlayMeta | null {
  if (x === null || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  if (typeof o['id'] !== 'string' || typeof o['storeyId'] !== 'string') return null;
  if (typeof o['mediaType'] !== 'string') return null;
  const kind = (UNDERLAY_KINDS as readonly string[]).includes(o['kind'] as string)
    ? (o['kind'] as UnderlayKind)
    : 'floorplan';
  const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const mpp = o['metersPerPixel'];
  return {
    id: o['id'],
    storeyId: o['storeyId'],
    name: typeof o['name'] === 'string' ? o['name'] : 'Unterlage',
    kind,
    mediaType: o['mediaType'],
    widthPx: num(o['widthPx'], 0),
    heightPx: num(o['heightPx'], 0),
    metersPerPixel: typeof mpp === 'number' && mpp > 0 ? mpp : null,
    offsetXM: num(o['offsetXM'], 0),
    offsetYM: num(o['offsetYM'], 0),
    rotationDeg: num(o['rotationDeg'], 0),
    opacityPct: num(o['opacityPct'], 60),
    contrastPct: num(o['contrastPct'], 100),
    visible: o['visible'] !== false,
    locked: o['locked'] === true,
    northAssumed: o['northAssumed'] !== false,
    crop: normalizeCropPolygon(o['crop']),
    createdAt: typeof o['createdAt'] === 'string' ? o['createdAt'] : new Date(0).toISOString(),
  };
}

export async function listUnderlays(o?: UnderlayStoreOptions): Promise<UnderlayMeta[]> {
  try {
    const raw = await fs.readFile(indexPath(o), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map(coerceMeta).filter((m): m is UnderlayMeta => m !== null);
  } catch {
    return [];
  }
}

export interface AddUnderlayInput {
  storeyId: string;
  name?: string;
  kind?: UnderlayKind;
}

export type AddUnderlayResult =
  | { ok: true; meta: UnderlayMeta }
  | { ok: false; error: string };

export async function addUnderlay(
  dataUrl: string,
  input: AddUnderlayInput,
  o?: UnderlayStoreOptions,
): Promise<AddUnderlayResult> {
  const decoded = parseDataUrl(dataUrl);
  if (decoded === null) return { ok: false, error: 'invalid data URL' };
  if (!isAllowedUnderlayMedia(decoded.mediaType)) {
    return { ok: false, error: `unsupported media type ${decoded.mediaType} (PNG or JPEG only)` };
  }
  if (decoded.bytes.length > MAX_UNDERLAY_BYTES) {
    return { ok: false, error: 'file too large (max 16 MB)' };
  }
  const dims = imageDimensions(decoded.bytes, decoded.mediaType);
  if (dims === null) return { ok: false, error: 'could not read image dimensions' };
  if (dims.width > MAX_UNDERLAY_DIM || dims.height > MAX_UNDERLAY_DIM) {
    return { ok: false, error: `image too large (max ${MAX_UNDERLAY_DIM}px per side)` };
  }
  const stripped = stripImageMetadata(decoded.bytes, decoded.mediaType);

  const meta: UnderlayMeta = {
    id: randomUUID(),
    storeyId: input.storeyId,
    name: input.name !== undefined && input.name.trim().length > 0 ? input.name.trim() : 'Unterlage',
    kind: input.kind ?? 'floorplan',
    mediaType: decoded.mediaType,
    widthPx: dims.width,
    heightPx: dims.height,
    metersPerPixel: null,
    offsetXM: 0,
    offsetYM: 0,
    rotationDeg: 0,
    opacityPct: 60,
    contrastPct: 100,
    visible: true,
    locked: false,
    northAssumed: true,
    crop: [],
    createdAt: new Date().toISOString(),
  };

  await atomicWriteBytes(binaryPath(o, meta), stripped);
  const list = await listUnderlays(o);
  list.push(meta);
  await atomicWriteJson(indexPath(o), list);
  return { ok: true, meta };
}

const PATCHABLE: ReadonlyArray<keyof UnderlayMeta> = [
  'name',
  'kind',
  'metersPerPixel',
  'offsetXM',
  'offsetYM',
  'rotationDeg',
  'opacityPct',
  'contrastPct',
  'visible',
  'locked',
  'northAssumed',
  'crop',
];

export async function updateUnderlay(
  id: string,
  patch: Partial<UnderlayMeta>,
  o?: UnderlayStoreOptions,
): Promise<UnderlayMeta | null> {
  const list = await listUnderlays(o);
  const idx = list.findIndex((m) => m.id === id);
  if (idx === -1) return null;
  const current = list[idx] as UnderlayMeta;
  const clamped = clampUnderlayDisplay(patch);
  const next: UnderlayMeta = { ...current };
  for (const key of PATCHABLE) {
    if (clamped[key] !== undefined) {
      // Narrowed assignment across the known-patchable keys.
      (next as unknown as Record<string, unknown>)[key] = clamped[key];
    }
  }
  list[idx] = next;
  await atomicWriteJson(indexPath(o), list);
  return next;
}

export async function deleteUnderlay(id: string, o?: UnderlayStoreOptions): Promise<boolean> {
  const list = await listUnderlays(o);
  const meta = list.find((m) => m.id === id);
  if (meta === undefined) return false;
  await atomicWriteJson(indexPath(o), list.filter((m) => m.id !== id));
  try {
    await fs.rm(binaryPath(o, meta), { force: true });
  } catch {
    /* best-effort binary cleanup */
  }
  return true;
}

export async function readUnderlayBinary(
  id: string,
  o?: UnderlayStoreOptions,
): Promise<{ mediaType: string; bytes: Buffer } | null> {
  const list = await listUnderlays(o);
  const meta = list.find((m) => m.id === id);
  if (meta === undefined) return null;
  try {
    const bytes = await fs.readFile(binaryPath(o, meta));
    return { mediaType: meta.mediaType, bytes };
  } catch {
    return null;
  }
}
