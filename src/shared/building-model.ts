/**
 * Heat Shield — Shared Building Model (HeatShield Unified Programme, Gate 1).
 *
 * Canonical, revisioned building geometry. This is the SINGLE source of truth
 * for geometry across the 2D editor, 3D Digital Twin and Thermal Load engine
 * (blueprint §2.3 / §7). It mirrors the programme JSON Schema
 * `schemas/building-model.schema.json` (`schemaVersion` 1.0.0) as Zod so the
 * TypeScript side has one validated contract.
 *
 * ─── Design rules honoured ────────────────────────────────────────────────
 *   - PURE module: no fs, no network, no globals, no logging. I/O lives at the
 *     adapter/persistence edge (later tasks 2.1+).
 *   - Defensive but explicit: this schema is `strict()` on its OWN objects (we
 *     author them), unlike Connect-API device payloads which must be parsed
 *     leniently. A building model is internal data we fully control.
 *   - Units are SI and explicit in field suffixes (`*M` = metres, `*Deg` =
 *     degrees, `*Wm2K`, `*KJm2K`). Coordinates are a local planar CRS in
 *     metres; see {@link COORDINATE_CONVENTIONS}.
 *   - AI/imported geometry stays a *candidate* until human confirmation — that
 *     status lives in the editor/adapter layer, not in this canonical schema.
 *
 * This module is inert until imported behind the `sharedBuildingModel` feature
 * flag; creating it changes no runtime behaviour.
 */

import { z } from 'zod';

import { SCHEMA_VERSION } from './building-model-core.js';
export {
  SCHEMA_VERSION,
  validateBuildingModel,
  type BuildingModelIssue,
  type BuildingModelIssueCode,
  type BuildingModelValidation,
} from './building-model-core.js';

// ---------------------------------------------------------------------------
// Conventions (task 1.1 — identifiers, units, coordinates).
// ---------------------------------------------------------------------------

/**
 * Coordinate + unit conventions for the Shared Building Model.
 *
 *   - All lengths are metres (suffix `M`), all angles degrees (suffix `Deg`).
 *   - Plan coordinates (`Point.x`, `.y`) live in a local right-handed planar
 *     CRS in metres, origin arbitrary per project, +x = east-ish, +y =
 *     north-ish BEFORE applying `site.northAzimuthDeg`.
 *   - `site.northAzimuthDeg` is the compass azimuth (0=N, 90=E, clockwise)
 *     that the local +y axis points to. Façade orientation is derived from
 *     wall geometry + this value (never hand-stored on the wall).
 *   - Azimuth fields are `[0,360)`; pitch `[0,80]`.
 */
export const COORDINATE_CONVENTIONS = {
  lengthUnit: 'metre',
  angleUnit: 'degree',
  azimuthZero: 'north',
  azimuthDirection: 'clockwise',
  planAxis: '+x east, +y north (pre-rotation by site.northAzimuthDeg)',
} as const;

// A UUID identifier. Kept as a named helper so every id field is identical.
const uuid = () => z.string().uuid();

// ---------------------------------------------------------------------------
// Primitives.
// ---------------------------------------------------------------------------

export const PointSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
  })
  .strict();

export const WallBoundarySchema = z.enum([
  'outside',
  'ground',
  'adjacent_conditioned',
  'adjacent_unconditioned',
  'adiabatic',
]);

export const OpeningTypeSchema = z.enum(['door', 'window']);

export const RoofTypeSchema = z.enum(['flat', 'gable', 'hip', 'half_hip', 'shed']);

export const ConstructionSourceSchema = z.enum([
  'measured',
  'declared',
  'template',
  'assumed',
]);

// ---------------------------------------------------------------------------
// Elements.
// ---------------------------------------------------------------------------

export const WallSchema = z
  .object({
    id: uuid(),
    axis: z.array(PointSchema).min(2),
    thicknessM: z.number().positive(),
    heightM: z.number().positive().nullable().default(null),
    constructionId: uuid().nullable().default(null),
    boundary: WallBoundarySchema,
  })
  .strict();

export const OpeningSchema = z
  .object({
    id: uuid(),
    type: OpeningTypeSchema,
    hostWallId: uuid(),
    offsetM: z.number().min(0),
    widthM: z.number().positive(),
    heightM: z.number().positive(),
    sillM: z.number().min(0).default(0),
  })
  .strict();

export const SpaceSchema = z
  .object({
    id: uuid(),
    name: z.string().min(1),
    polygon: z.array(PointSchema).min(3),
    useProfileId: z.string().min(1).nullable().default(null),
    thermalZoneId: uuid().nullable().default(null),
  })
  .strict();

export const StoreySchema = z
  .object({
    id: uuid(),
    name: z.string().min(1),
    elevationM: z.number().finite(),
    heightM: z.number().positive(),
    walls: z.array(WallSchema),
    openings: z.array(OpeningSchema),
    spaces: z.array(SpaceSchema),
  })
  .strict();

export const RoofSchema = z
  .object({
    id: uuid(),
    type: RoofTypeSchema,
    storeyId: uuid(),
    pitchDeg: z.number().min(0).max(80),
    ridgeAzimuthDeg: z.number().min(0).lt(360).optional(),
    overhangM: z.number().min(0).optional(),
  })
  .strict();

export const PvArraySchema = z
  .object({
    id: uuid(),
    roofFaceId: z.string().min(1),
    rows: z.number().int().min(1),
    columns: z.number().int().min(1),
    moduleWidthM: z.number().positive(),
    moduleHeightM: z.number().positive(),
    gapM: z.number().min(0).optional(),
  })
  .strict();

export const ConstructionSchema = z
  .object({
    id: uuid(),
    name: z.string().min(1),
    sourceType: ConstructionSourceSchema,
    uValueWm2K: z.number().positive().nullable().default(null),
    heatCapacityKJm2K: z.number().min(0).nullable().default(null),
  })
  .strict();

export const SiteSchema = z
  .object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    timezone: z.string().min(1),
    northAzimuthDeg: z.number().min(0).lt(360),
  })
  .strict();

export const ThermalZoneSchema = z
  .object({
    id: uuid(),
    name: z.string().min(1),
    spaceIds: z.array(uuid()),
  })
  .strict();

// ---------------------------------------------------------------------------
// Top-level project.
// ---------------------------------------------------------------------------

export const BuildingModelSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    id: uuid(),
    revision: z.number().int().min(1),
    site: SiteSchema,
    storeys: z.array(StoreySchema),
    roofs: z.array(RoofSchema),
    pvArrays: z.array(PvArraySchema),
    constructions: z.array(ConstructionSchema),
    thermalZones: z.array(ThermalZoneSchema),
  })
  .strict();

// ---------------------------------------------------------------------------
// Inferred types.
// ---------------------------------------------------------------------------

export type Point = z.infer<typeof PointSchema>;
export type WallBoundary = z.infer<typeof WallBoundarySchema>;
export type OpeningType = z.infer<typeof OpeningTypeSchema>;
export type RoofType = z.infer<typeof RoofTypeSchema>;
export type Wall = z.infer<typeof WallSchema>;
export type Opening = z.infer<typeof OpeningSchema>;
export type Space = z.infer<typeof SpaceSchema>;
export type Storey = z.infer<typeof StoreySchema>;
export type Roof = z.infer<typeof RoofSchema>;
export type PvArray = z.infer<typeof PvArraySchema>;
export type Construction = z.infer<typeof ConstructionSchema>;
export type Site = z.infer<typeof SiteSchema>;
export type ThermalZone = z.infer<typeof ThermalZoneSchema>;
export type BuildingModel = z.infer<typeof BuildingModelSchema>;

// ---------------------------------------------------------------------------
// Shape parsing (Zod). Referential-integrity `validateBuildingModel` +
// `SCHEMA_VERSION` + issue types live in the Zod-FREE `building-model-core.ts`
// and are re-exported at the top of this file, so the SPA can validate/edit
// without pulling Zod into the browser bundle.
// ---------------------------------------------------------------------------

/** Parse + shape-validate. Throws `ZodError` on malformed input. */
export function parseBuildingModel(input: unknown): BuildingModel {
  return BuildingModelSchema.parse(input);
}

/** Shape-validate without throwing. */
export function safeParseBuildingModel(
  input: unknown,
): ReturnType<typeof BuildingModelSchema.safeParse> {
  return BuildingModelSchema.safeParse(input);
}
