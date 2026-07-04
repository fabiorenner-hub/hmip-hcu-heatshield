/**
 * Heat Shield — compatibility adapter: current config → *candidate* Shared
 * Building Model (HeatShield Unified Programme, shared-building-model 2.5).
 *
 * The live plugin stores logical rooms + windows (no geometry) in
 * `/data/config.json`. This adapter projects that config into a CANDIDATE
 * building model so the programme's Building Model Studio / Digital Twin can
 * offer "adopt existing rooms" as a starting point.
 *
 * ─── Hard rules honoured (DEC-004, blueprint §3, execution-contract) ──────
 *   - ONE-WAY + NON-DESTRUCTIVE: a pure function of `Config`. It NEVER writes
 *     back to config, never mutates its input, never touches `/data`, and
 *     never changes the orientation/area the live engine uses.
 *   - NO SYNTHETIC GEOMETRY (DEC-004 A1): the config has no walls/polygons, so
 *     spaces/openings are emitted WITHOUT geometry and flagged
 *     `hasGeometry: false`. We do not fabricate walls to satisfy the canonical
 *     schema — the result is a *candidate*, not a valid canonical
 *     `BuildingModel`. Canonical geometry only exists after human drawing/
 *     confirmation in the editor.
 *   - ALIAS IDS (DEC-004 A2): each generated uuid keeps the original free-form
 *     config id as `aliasOf`, and the `aliases` table maps both directions.
 *   - DETERMINISTIC: generated uuids are derived from the original id via a
 *     stable hash, so re-running the adapter on the same config yields the
 *     same candidate (re-import is idempotent).
 *
 * PURE: no fs, no network, no globals, no logging.
 */

import type { Config, Room, Window } from './types.js';
import type { Site } from './building-model.js';
import { fnv1a64Hex } from './building-model-canonical.js';

// ---------------------------------------------------------------------------
// Candidate types — deliberately distinct from the canonical BuildingModel.
// ---------------------------------------------------------------------------

export interface CandidateMeta {
  status: 'candidate';
  source: 'heatshield-config';
  /** Original free-form config id this element was derived from. */
  aliasOf: string;
  /** Always false from this adapter — config carries no geometry. */
  hasGeometry: false;
}

export interface CandidateStorey {
  id: string;
  name: string;
  /** Unknown from config → null (editor fills it in). */
  elevationM: number | null;
  meta: Omit<CandidateMeta, 'aliasOf'> & { aliasOf: string };
}

export interface CandidateSpace {
  id: string;
  name: string;
  storeyId: string;
  /** No geometry from config. */
  polygon: null;
  thermalZoneId: string | null;
  meta: CandidateMeta;
}

export interface CandidateOpening {
  id: string;
  type: 'window' | 'door';
  spaceId: string;
  /** Orientation is carried through unchanged (the engine relies on it). */
  orientationDeg: number;
  /** m² when known, else null. */
  areaM2: number | null;
  isRoofWindow: boolean;
  /** No host wall yet (DEC-004: no synthetic walls). */
  hostWallId: null;
  meta: CandidateMeta;
}

/** Device binding kept OUTSIDE geometry (blueprint §7.2). */
export interface CandidateBinding {
  openingId: string;
  windowAlias: string;
  shutterDeviceId: string;
  contactDeviceId: string | null;
}

export interface AliasEntry {
  kind: 'storey' | 'space' | 'opening';
  originalId: string;
  uuid: string;
}

export type CandidateWarningCode =
  | 'NO_GEOMETRY'
  | 'ASSUMED_NORTH'
  | 'UNKNOWN_FLOOR'
  | 'ORPHAN_WINDOW';

export interface CandidateWarning {
  code: CandidateWarningCode;
  message: string;
  refId?: string;
}

export interface CandidateBuildingModel {
  kind: 'candidate';
  source: 'heatshield-config';
  site: Site;
  storeys: CandidateStorey[];
  spaces: CandidateSpace[];
  openings: CandidateOpening[];
  bindings: CandidateBinding[];
  aliases: AliasEntry[];
  warnings: CandidateWarning[];
}

// ---------------------------------------------------------------------------
// Deterministic uuid derivation (RFC-4122 v4 shape, stable per seed).
// ---------------------------------------------------------------------------

const UNKNOWN_FLOOR_LABEL = 'Sonstige';

/** Stable RFC-4122-v4-shaped uuid derived from a seed string. */
export function deterministicUuid(seed: string): string {
  const h = fnv1a64Hex(`a:${seed}`) + fnv1a64Hex(`b:${seed}`); // 32 hex chars
  const variantNibble = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return (
    `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-` +
    `${variantNibble}${h.slice(17, 20)}-${h.slice(20, 32)}`
  );
}

// ---------------------------------------------------------------------------
// Adapter.
// ---------------------------------------------------------------------------

/**
 * Project a live `Config` into a candidate building model. Pure; the input is
 * never mutated. The result is a candidate (no geometry) — feed it into the
 * editor, never directly into the canonical `BuildingModelSchema`.
 */
export function configToCandidateModel(config: Config): CandidateBuildingModel {
  const warnings: CandidateWarning[] = [];
  const aliases: AliasEntry[] = [];

  // --- Site (north is unknown in config → assume 0, warn). ---
  const site: Site = {
    latitude: config.location.latitude,
    longitude: config.location.longitude,
    timezone: config.location.timezone,
    northAzimuthDeg: 0,
  };
  warnings.push({
    code: 'ASSUMED_NORTH',
    message: 'northAzimuthDeg assumed 0°; confirm building orientation in the editor.',
  });

  // --- Storeys from distinct room.floor labels (first-appearance order). ---
  const storeyByLabel = new Map<string, CandidateStorey>();
  const ensureStorey = (label: string): CandidateStorey => {
    const existing = storeyByLabel.get(label);
    if (existing) return existing;
    const id = deterministicUuid(`storey:${label}`);
    const storey: CandidateStorey = {
      id,
      name: label,
      elevationM: null,
      meta: { status: 'candidate', source: 'heatshield-config', aliasOf: label, hasGeometry: false },
    };
    storeyByLabel.set(label, storey);
    aliases.push({ kind: 'storey', originalId: label, uuid: id });
    return storey;
  };

  // --- Spaces (one per room), no polygon. ---
  const spaceByRoomId = new Map<string, CandidateSpace>();
  for (const room of config.rooms as Room[]) {
    const floorLabel = room.floor ?? UNKNOWN_FLOOR_LABEL;
    if (room.floor === undefined) {
      warnings.push({
        code: 'UNKNOWN_FLOOR',
        message: `Room "${room.name}" has no floor label; placed on "${UNKNOWN_FLOOR_LABEL}".`,
        refId: room.id,
      });
    }
    const storey = ensureStorey(floorLabel);
    const id = deterministicUuid(`space:${room.id}`);
    const space: CandidateSpace = {
      id,
      name: room.name,
      storeyId: storey.id,
      polygon: null,
      thermalZoneId: null,
      meta: { status: 'candidate', source: 'heatshield-config', aliasOf: room.id, hasGeometry: false },
    };
    spaceByRoomId.set(room.id, space);
    aliases.push({ kind: 'space', originalId: room.id, uuid: id });
  }

  // --- Openings (one per window) + device bindings, no host wall. ---
  const openings: CandidateOpening[] = [];
  const bindings: CandidateBinding[] = [];
  for (const win of config.windows as Window[]) {
    const space = spaceByRoomId.get(win.roomId);
    if (!space) {
      warnings.push({
        code: 'ORPHAN_WINDOW',
        message: `Window "${win.id}" references unknown room "${win.roomId}"; skipped.`,
        refId: win.id,
      });
      continue;
    }
    const id = deterministicUuid(`opening:${win.id}`);
    openings.push({
      id,
      type: win.isDoor ? 'door' : 'window',
      spaceId: space.id,
      orientationDeg: win.orientationDeg,
      areaM2: win.areaM2 ?? null,
      isRoofWindow: win.type === 'roof_window',
      hostWallId: null,
      meta: { status: 'candidate', source: 'heatshield-config', aliasOf: win.id, hasGeometry: false },
    });
    aliases.push({ kind: 'opening', originalId: win.id, uuid: id });
    bindings.push({
      openingId: id,
      windowAlias: win.id,
      shutterDeviceId: win.shutterDeviceId,
      contactDeviceId: win.contactDeviceId ?? null,
    });
  }

  // Config never carries geometry — surface that once at the model level.
  warnings.push({
    code: 'NO_GEOMETRY',
    message:
      'Imported from config without geometry: spaces/openings have no polygon or host wall. ' +
      'Draw or confirm geometry in the editor to make this a canonical model.',
  });

  return {
    kind: 'candidate',
    source: 'heatshield-config',
    site,
    storeys: [...storeyByLabel.values()],
    spaces: [...spaceByRoomId.values()],
    openings,
    bindings,
    aliases,
    warnings,
  };
}
