/**
 * Heat Shield — Shared Building Model ZOD-FREE core (schema version constant +
 * referential-integrity validation + stable issue codes).
 *
 * WHY this module exists separately from `building-model.ts`:
 *   The dashboard SPA needs the pure editor logic (validation, the schema
 *   version, the editor command reducer) but must NOT pull the Zod runtime
 *   into the browser bundle. `building-model.ts` builds Zod schemas at module
 *   load, so importing ANY value from it drags Zod (~100 KB min) into the SPA.
 *   Everything in THIS module is plain TypeScript — it imports only TYPES from
 *   `building-model.ts` (erased at compile time), so the SPA stays Zod-free.
 *
 * PURE: no fs, no network, no globals, no logging, no Zod.
 */

import type { BuildingModel } from './building-model.js';

export const SCHEMA_VERSION = '1.0.0' as const;

// ---------------------------------------------------------------------------
// Model-level validation — stable codes for cross-references and invariants a
// per-field schema cannot express. Codes are STABLE strings (safe to surface
// in the UI / map to localized messages) — never renumber, only add.
// ---------------------------------------------------------------------------

export type BuildingModelIssueCode =
  | 'DUPLICATE_ID'
  | 'OPENING_HOST_WALL_MISSING'
  | 'OPENING_HOST_WALL_WRONG_STOREY'
  | 'OPENING_HOST_ROOF_MISSING'
  | 'OPENING_HOST_ROOF_WRONG_STOREY'
  | 'SPACE_THERMAL_ZONE_MISSING'
  | 'WALL_CONSTRUCTION_MISSING'
  | 'ROOF_STOREY_MISSING'
  | 'THERMAL_ZONE_SPACE_MISSING'
  | 'THERMAL_ZONE_EMPTY';

export interface BuildingModelIssue {
  code: BuildingModelIssueCode;
  /** Dotted path to the offending element, e.g. `storeys[0].openings[2]`. */
  path: string;
  /** The id that triggered the issue, when applicable. */
  refId?: string;
}

export interface BuildingModelValidation {
  valid: boolean;
  issues: BuildingModelIssue[];
}

/**
 * Referential-integrity validation over an already shape-valid model. Returns
 * every issue found (does not short-circuit) so the editor can show them all.
 */
export function validateBuildingModel(model: BuildingModel): BuildingModelValidation {
  const issues: BuildingModelIssue[] = [];

  const constructionIds = new Set(model.constructions.map((c) => c.id));
  const storeyIds = new Set(model.storeys.map((s) => s.id));
  const thermalZoneIds = new Set(model.thermalZones.map((z2) => z2.id));
  // Roof id → hosting storey id, for roof-window (Dachfenster) host checks.
  const roofStoreyById = new Map(model.roofs.map((r) => [r.id, r.storeyId]));

  // Global id uniqueness across every element that carries a uuid.
  const seen = new Set<string>();
  const note = (id: string, path: string): void => {
    if (seen.has(id)) issues.push({ code: 'DUPLICATE_ID', path, refId: id });
    else seen.add(id);
  };
  note(model.id, 'id');
  model.constructions.forEach((c, i) => note(c.id, `constructions[${i}]`));
  model.thermalZones.forEach((z2, i) => note(z2.id, `thermalZones[${i}]`));
  model.roofs.forEach((r, i) => note(r.id, `roofs[${i}]`));
  model.pvArrays.forEach((p, i) => note(p.id, `pvArrays[${i}]`));

  for (const [si, storey] of model.storeys.entries()) {
    note(storey.id, `storeys[${si}]`);
    const wallIds = new Set(storey.walls.map((w) => w.id));

    storey.walls.forEach((wall, wi) => {
      note(wall.id, `storeys[${si}].walls[${wi}]`);
      if (wall.constructionId !== null && !constructionIds.has(wall.constructionId)) {
        issues.push({
          code: 'WALL_CONSTRUCTION_MISSING',
          path: `storeys[${si}].walls[${wi}]`,
          refId: wall.constructionId,
        });
      }
    });

    storey.openings.forEach((opening, oi) => {
      note(opening.id, `storeys[${si}].openings[${oi}]`);
      const path = `storeys[${si}].openings[${oi}]`;
      if (opening.hostRoofId !== undefined) {
        // Roof window (Dachfenster): its roof must exist AND cap THIS storey.
        const roofStorey = roofStoreyById.get(opening.hostRoofId);
        if (roofStorey === undefined) {
          issues.push({ code: 'OPENING_HOST_ROOF_MISSING', path, refId: opening.hostRoofId });
        } else if (roofStorey !== storey.id) {
          issues.push({ code: 'OPENING_HOST_ROOF_WRONG_STOREY', path, refId: opening.hostRoofId });
        }
      } else if (opening.hostWallId === undefined || !wallIds.has(opening.hostWallId)) {
        // Façade opening: its host wall must exist AND live on the SAME storey.
        const existsElsewhere =
          opening.hostWallId !== undefined &&
          model.storeys.some((s) => s.walls.some((w) => w.id === opening.hostWallId));
        issues.push({
          code: existsElsewhere ? 'OPENING_HOST_WALL_WRONG_STOREY' : 'OPENING_HOST_WALL_MISSING',
          path,
          ...(opening.hostWallId !== undefined ? { refId: opening.hostWallId } : {}),
        });
      }
    });

    storey.spaces.forEach((space, spi) => {
      note(space.id, `storeys[${si}].spaces[${spi}]`);
      if (space.thermalZoneId !== null && !thermalZoneIds.has(space.thermalZoneId)) {
        issues.push({
          code: 'SPACE_THERMAL_ZONE_MISSING',
          path: `storeys[${si}].spaces[${spi}]`,
          refId: space.thermalZoneId,
        });
      }
    });
  }

  // Collect every space id once for thermal-zone membership checks.
  const spaceIds = new Set(model.storeys.flatMap((s) => s.spaces.map((sp) => sp.id)));

  model.roofs.forEach((roof, ri) => {
    if (!storeyIds.has(roof.storeyId)) {
      issues.push({ code: 'ROOF_STOREY_MISSING', path: `roofs[${ri}]`, refId: roof.storeyId });
    }
  });

  model.thermalZones.forEach((zone, zi) => {
    if (zone.spaceIds.length === 0) {
      issues.push({ code: 'THERMAL_ZONE_EMPTY', path: `thermalZones[${zi}]`, refId: zone.id });
    }
    zone.spaceIds.forEach((sid) => {
      if (!spaceIds.has(sid)) {
        issues.push({
          code: 'THERMAL_ZONE_SPACE_MISSING',
          path: `thermalZones[${zi}]`,
          refId: sid,
        });
      }
    });
  });

  return { valid: issues.length === 0, issues };
}
