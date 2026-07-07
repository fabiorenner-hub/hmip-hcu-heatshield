/**
 * Heat Shield — Building Model Studio editor core (building-model-editor spec,
 * Phase 1). PURE, deterministic command reducer + undo/redo history over a
 * canonical {@link BuildingModel}. No fs, no network, no globals, no logging —
 * `newId` is injected so id generation (the only nondeterminism) lives at the
 * edge (see {@link defaultEditorContext}).
 *
 * Design:
 *   - Transient state (selection, active storey) is NOT part of the canonical
 *     model; it rides alongside in {@link EditorState}. Only `model` is ever
 *     persisted.
 *   - Undo/redo is snapshot-based (whole {@link EditorState} per step). A home
 *     model is small; snapshotting is simple and robust, and it keeps every
 *     command trivially reversible without per-command inverse logic.
 *   - Every command returns a NEW state (immutable update); callers push it
 *     through {@link applyCommand} which maintains the history stacks.
 */

import type {
  BuildingModel,
  Point,
  Storey,
  Wall,
  Opening,
  Space,
  WallBoundary,
  OpeningType,
  GlazingType,
  Roof,
  RoofType,
  PvArray,
} from './building-model.js';
import {
  SCHEMA_VERSION,
  validateBuildingModel,
  type BuildingModelValidation,
} from './building-model-core.js';
import { detectRooms, pointInPolygon, centroid } from './building-rooms.js';
import { BUILDING_TOLERANCES } from './building-tolerances.js';

// ---------------------------------------------------------------------------
// Editor context (id generation edge).
// ---------------------------------------------------------------------------

export interface EditorContext {
  /** Returns a fresh RFC-4122 uuid. Injected so the reducer stays pure. */
  newId: () => string;
}

/** Default context using the platform crypto (Node ≥ 16 / browsers). */
export function defaultEditorContext(): EditorContext {
  return {
    newId: (): string => {
      const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
      if (c?.randomUUID !== undefined) return c.randomUUID();
      // Fallback (test/edge environments without crypto.randomUUID): RFC-4122
      // v4 shape from Math.random. Not cryptographic — ids need only be unique.
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/gu, (ch) => {
        const r = (Math.random() * 16) | 0;
        const v = ch === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Editor state + history.
// ---------------------------------------------------------------------------

export interface EditorState {
  model: BuildingModel;
  activeStoreyId: string | null;
  /** Selected element ids (walls/openings/spaces), transient. */
  selection: string[];
}

export interface EditorHistory {
  past: EditorState[];
  present: EditorState;
  future: EditorState[];
}

const MAX_HISTORY = 100;

export function initHistory(state: EditorState): EditorHistory {
  return { past: [], present: state, future: [] };
}

/**
 * Push a new present onto the history. `record: false` replaces the present
 * without adding an undo step (used for pure selection/camera changes).
 */
export function pushHistory(
  history: EditorHistory,
  next: EditorState,
  record: boolean,
): EditorHistory {
  if (!record) return { ...history, present: next };
  const past = [...history.past, history.present];
  if (past.length > MAX_HISTORY) past.shift();
  return { past, present: next, future: [] };
}

export function canUndo(h: EditorHistory): boolean {
  return h.past.length > 0;
}

export function canRedo(h: EditorHistory): boolean {
  return h.future.length > 0;
}

export function undo(h: EditorHistory): EditorHistory {
  if (h.past.length === 0) return h;
  const previous = h.past[h.past.length - 1] as EditorState;
  return {
    past: h.past.slice(0, -1),
    present: previous,
    future: [h.present, ...h.future],
  };
}

export function redo(h: EditorHistory): EditorHistory {
  if (h.future.length === 0) return h;
  const next = h.future[0] as EditorState;
  return {
    past: [...h.past, h.present],
    present: next,
    future: h.future.slice(1),
  };
}

// ---------------------------------------------------------------------------
// Geometry helpers (pure).
// ---------------------------------------------------------------------------

export function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Compass-independent segment length in metres. */
export function segmentLength(axis: Point[]): number {
  let total = 0;
  for (let i = 1; i < axis.length; i += 1) {
    total += distance(axis[i - 1] as Point, axis[i] as Point);
  }
  return total;
}

/** Signed heading of a→b in degrees, 0° = +x (east), CCW positive. */
export function headingDeg(a: Point, b: Point): number {
  const deg = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  return ((deg % 360) + 360) % 360;
}

/** Snap a coordinate to a grid of `stepM` metres. */
export function snapToGrid(p: Point, stepM: number): Point {
  if (stepM <= 0) return p;
  return { x: Math.round(p.x / stepM) * stepM, y: Math.round(p.y / stepM) * stepM };
}

/**
 * Snap `p` to the nearest candidate vertex within `maxDistM` metres, or return
 * `null` when none is close enough. Used for strong point-snapping so polylines
 * and room polygons close exactly on existing endpoints/vertices. Pure.
 */
export function nearestVertex(
  candidates: readonly Point[],
  p: Point,
  maxDistM: number,
): Point | null {
  let best: Point | null = null;
  let bestD = maxDistM;
  for (const c of candidates) {
    const d = Math.hypot(c.x - p.x, c.y - p.y);
    if (d <= bestD) {
      best = c;
      bestD = d;
    }
  }
  return best;
}

export type AngleConstraint = 'ortho' | 'deg45' | 'free';

/**
 * Constrain point `to` relative to anchor `from` so the segment lies on an
 * allowed angle. `ortho` → nearest of 0/90/180/270; `deg45` → nearest 45°
 * multiple; `free` → unchanged. Length is preserved along the constrained
 * direction.
 */
export function constrainAngle(from: Point, to: Point, mode: AngleConstraint): Point {
  if (mode === 'free') return to;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return to;
  const step = mode === 'ortho' ? 90 : 45;
  const ang = Math.atan2(dy, dx);
  const snapped = Math.round(ang / ((step * Math.PI) / 180)) * ((step * Math.PI) / 180);
  return { x: from.x + Math.cos(snapped) * len, y: from.y + Math.sin(snapped) * len };
}

/** Shoelace polygon area (m²), always non-negative. */
export function polygonArea(polygon: Point[]): number {
  let sum = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i] as Point;
    const b = polygon[(i + 1) % polygon.length] as Point;
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

// ---------------------------------------------------------------------------
// Model / storey factories.
// ---------------------------------------------------------------------------

export interface NewModelInput {
  latitude: number;
  longitude: number;
  timezone: string;
  northAzimuthDeg?: number;
}

/** Create an empty, schema-valid model with one default ground storey. */
export function newBuildingModel(ctx: EditorContext, input: NewModelInput): BuildingModel {
  const storey: Storey = {
    id: ctx.newId(),
    name: 'Erdgeschoss',
    elevationM: 0,
    heightM: 2.5,
    walls: [],
    openings: [],
    spaces: [],
  };
  return {
    schemaVersion: SCHEMA_VERSION,
    id: ctx.newId(),
    revision: 1,
    site: {
      latitude: input.latitude,
      longitude: input.longitude,
      timezone: input.timezone,
      northAzimuthDeg: input.northAzimuthDeg ?? 0,
    },
    storeys: [storey],
    roofs: [],
    pvArrays: [],
    constructions: [],
    thermalZones: [],
  };
}

export function newEditorState(model: BuildingModel): EditorState {
  return {
    model,
    activeStoreyId: model.storeys[0]?.id ?? null,
    selection: [],
  };
}

/**
 * Update the site metadata (orientation / location / timezone). Only the given
 * fields change; `northAzimuthDeg` is normalised to [0, 360) and latitude /
 * longitude are clamped to valid ranges so the model stays schema-valid.
 */
export function updateSite(
  state: EditorState,
  patch: { northAzimuthDeg?: number; latitude?: number; longitude?: number; timezone?: string },
): EditorState {
  const site = { ...state.model.site };
  if (patch.northAzimuthDeg !== undefined && Number.isFinite(patch.northAzimuthDeg)) {
    site.northAzimuthDeg = ((patch.northAzimuthDeg % 360) + 360) % 360;
  }
  if (patch.latitude !== undefined && Number.isFinite(patch.latitude)) {
    site.latitude = Math.max(-90, Math.min(90, patch.latitude));
  }
  if (patch.longitude !== undefined && Number.isFinite(patch.longitude)) {
    site.longitude = Math.max(-180, Math.min(180, patch.longitude));
  }
  if (patch.timezone !== undefined && patch.timezone.length > 0) {
    site.timezone = patch.timezone;
  }
  return { ...state, model: { ...state.model, site } };
}

// ---------------------------------------------------------------------------
// Internal helpers.
// ---------------------------------------------------------------------------

function mapStorey(
  model: BuildingModel,
  storeyId: string,
  fn: (s: Storey) => Storey,
): BuildingModel {
  return {
    ...model,
    storeys: model.storeys.map((s) => (s.id === storeyId ? fn(s) : s)),
  };
}

function activeStorey(state: EditorState): Storey | null {
  if (state.activeStoreyId === null) return null;
  return state.model.storeys.find((s) => s.id === state.activeStoreyId) ?? null;
}

// ---------------------------------------------------------------------------
// Commands — storeys.
// ---------------------------------------------------------------------------

export interface StoreyInput {
  name: string;
  elevationM: number;
  heightM: number;
}

export function addStorey(ctx: EditorContext, state: EditorState, input: StoreyInput): EditorState {
  const storey: Storey = {
    id: ctx.newId(),
    name: input.name,
    elevationM: input.elevationM,
    heightM: input.heightM,
    walls: [],
    openings: [],
    spaces: [],
  };
  const storeys = [...state.model.storeys, storey].sort((a, b) => a.elevationM - b.elevationM);
  return { ...state, model: { ...state.model, storeys }, activeStoreyId: storey.id, selection: [] };
}

/**
 * Duplicate a storey and stack the copy directly ABOVE it (same walls,
 * openings and spaces, transferred upward). All ids are regenerated and
 * `opening.hostWallId` is remapped to the copied walls so referential
 * integrity holds. The roof is NOT copied (roofs cap the top storey). The new
 * storey becomes active.
 */
export function duplicateStorey(
  ctx: EditorContext,
  state: EditorState,
  storeyId: string,
  direction: 'up' | 'down' = 'up',
): EditorState {
  const src = state.model.storeys.find((s) => s.id === storeyId);
  if (src === undefined) return state;
  const wallIdMap = new Map<string, string>();
  const walls = src.walls.map((w) => {
    const id = ctx.newId();
    wallIdMap.set(w.id, id);
    return { ...w, id, axis: w.axis.map((p) => ({ ...p })) };
  });
  const openings = src.openings
    .filter((o) => o.hostWallId !== undefined && wallIdMap.has(o.hostWallId))
    .map((o) => ({ ...o, id: ctx.newId(), hostWallId: wallIdMap.get(o.hostWallId as string) as string }));
  const spaces = src.spaces.map((sp) => ({
    ...sp,
    id: ctx.newId(),
    polygon: sp.polygon.map((p) => ({ ...p })),
    thermalZoneId: null,
  }));
  const copy: Storey = {
    id: ctx.newId(),
    name: t2(src.name),
    elevationM: direction === 'down' ? src.elevationM - src.heightM : src.elevationM + src.heightM,
    heightM: src.heightM,
    walls,
    openings,
    spaces,
  };
  const storeys = [...state.model.storeys, copy].sort((a, b) => a.elevationM - b.elevationM);
  return { ...state, model: { ...state.model, storeys }, activeStoreyId: copy.id, selection: [] };
}

/** Derive a "(Kopie)" name without a translation dependency in the pure core. */
function t2(name: string): string {
  return name.endsWith(')') ? name : `${name} (Kopie)`;
}

export function updateStorey(
  state: EditorState,
  storeyId: string,
  patch: Partial<StoreyInput>,
): EditorState {
  const model = mapStorey(state.model, storeyId, (s) => ({
    ...s,
    name: patch.name ?? s.name,
    elevationM: patch.elevationM ?? s.elevationM,
    heightM: patch.heightM ?? s.heightM,
  }));
  return { ...state, model };
}

export function removeStorey(state: EditorState, storeyId: string): EditorState {
  if (state.model.storeys.length <= 1) return state; // keep at least one storey
  const storeys = state.model.storeys.filter((s) => s.id !== storeyId);
  const roofs = state.model.roofs.filter((r) => r.storeyId !== storeyId);
  const activeStoreyId =
    state.activeStoreyId === storeyId ? (storeys[0]?.id ?? null) : state.activeStoreyId;
  return { ...state, model: { ...state.model, storeys, roofs }, activeStoreyId, selection: [] };
}

export function setActiveStorey(state: EditorState, storeyId: string): EditorState {
  return { ...state, activeStoreyId: storeyId, selection: [] };
}

// ---------------------------------------------------------------------------
// Commands — roofs (BME-13/14). A roof caps one storey; the mesh builder turns
// its type/pitch/ridge into faces. Ridge axis and overhang are optional hints.
// ---------------------------------------------------------------------------

export interface RoofInput {
  storeyId: string;
  type: RoofType;
  pitchDeg: number;
  ridgeAzimuthDeg?: number;
  overhangM?: number;
  kneeHeightM?: number;
}

/**
 * Patch for {@link updateRoof}. Optional geometry hints accept an explicit
 * `null` to CLEAR them (ridge back to "auto / longer axis", no overhang),
 * distinct from `undefined` which keeps the current value.
 */
export interface RoofPatch {
  storeyId?: string;
  type?: RoofType;
  pitchDeg?: number;
  ridgeAzimuthDeg?: number | null;
  overhangM?: number | null;
  kneeHeightM?: number | null;
}

/** Clamp a pitch into the schema range [0, 80] (flat forces 0). */
function clampPitch(type: RoofType, pitchDeg: number): number {
  if (type === 'flat') return 0;
  if (!Number.isFinite(pitchDeg)) return 30;
  return Math.max(0, Math.min(80, pitchDeg));
}

/** Normalise an azimuth into [0, 360). */
function normAzimuth(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/**
 * Add a roof to a storey. A storey typically carries at most one roof, so an
 * existing roof on the same storey is REPLACED (keeps the UI a single "roof of
 * this storey" affordance) unless `allowMultiple` is set.
 */
export function addRoof(
  ctx: EditorContext,
  state: EditorState,
  input: RoofInput,
  allowMultiple = false,
): EditorState {
  const roof: Roof = {
    id: ctx.newId(),
    type: input.type,
    storeyId: input.storeyId,
    pitchDeg: clampPitch(input.type, input.pitchDeg),
    ...(input.ridgeAzimuthDeg !== undefined ? { ridgeAzimuthDeg: normAzimuth(input.ridgeAzimuthDeg) } : {}),
    // Default roof overhang (Dachüberstand) is 1 m unless explicitly given.
    overhangM: Math.max(0, input.overhangM ?? 1),
    ...(input.kneeHeightM !== undefined && input.kneeHeightM > 0 ? { kneeHeightM: input.kneeHeightM } : {}),
  };
  const kept = allowMultiple
    ? state.model.roofs
    : state.model.roofs.filter((r) => r.storeyId !== input.storeyId);
  return { ...state, model: { ...state.model, roofs: [...kept, roof] } };
}

export function updateRoof(
  state: EditorState,
  roofId: string,
  patch: RoofPatch,
): EditorState {
  const roofs = state.model.roofs.map((r) => {
    if (r.id !== roofId) return r;
    const type = patch.type ?? r.type;
    const next: Roof = {
      id: r.id,
      storeyId: patch.storeyId ?? r.storeyId,
      type,
      pitchDeg: clampPitch(type, patch.pitchDeg ?? r.pitchDeg),
    };
    // Optional fields: `undefined` in the patch keeps the current value,
    // explicit `null` clears it (e.g. ridge back to "auto / longer axis").
    const ridge = patch.ridgeAzimuthDeg !== undefined ? patch.ridgeAzimuthDeg : (r.ridgeAzimuthDeg ?? null);
    if (ridge !== null) next.ridgeAzimuthDeg = normAzimuth(ridge);
    const overhang = patch.overhangM !== undefined ? patch.overhangM : (r.overhangM ?? null);
    if (overhang !== null) next.overhangM = Math.max(0, overhang);
    const knee = patch.kneeHeightM !== undefined ? patch.kneeHeightM : (r.kneeHeightM ?? null);
    if (knee !== null && knee > 0) next.kneeHeightM = knee;
    return next;
  });
  return { ...state, model: { ...state.model, roofs } };
}

export function removeRoof(state: EditorState, roofId: string): EditorState {
  const roofs = state.model.roofs.filter((r) => r.id !== roofId);
  // Drop any PV arrays hosted by a face of this roof (roofFaceId prefixed by id).
  const pvArrays = state.model.pvArrays.filter((p) => !p.roofFaceId.startsWith(roofId));
  return { ...state, model: { ...state.model, roofs, pvArrays } };
}

// ---------------------------------------------------------------------------
// Commands — PV arrays (BME-14). A PV array sits on a roof face; the mesh
// builder lays a module grid on the roof footprint. `roofFaceId` is prefixed
// with the roof id so `removeRoof` can cascade.
// ---------------------------------------------------------------------------

export interface PvInput {
  roofId: string;
  moduleWidthM?: number;
  moduleHeightM?: number;
  gapM?: number;
  rows?: number;
  columns?: number;
}

/** Roof plane metrics for the PV editor (footprint bbox + tilt + azimuth). */
export interface RoofPlaneInfo {
  widthM: number;
  depthM: number;
  areaM2: number;
  tiltDeg: number;
  azimuthDeg: number | null;
}

/** Footprint metrics of a roof's storey (bbox of that storey's wall vertices). */
export function roofPlaneInfo(state: EditorState, roofId: string): RoofPlaneInfo | null {
  const roof = state.model.roofs.find((r) => r.id === roofId);
  if (roof === undefined) return null;
  const storey = state.model.storeys.find((s) => s.id === roof.storeyId);
  if (storey === undefined) return null;
  const pts = storey.walls.flatMap((w) => w.axis);
  if (pts.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const widthM = Math.max(0, maxX - minX);
  const depthM = Math.max(0, maxY - minY);
  return {
    widthM,
    depthM,
    areaM2: widthM * depthM,
    tiltDeg: roof.pitchDeg,
    azimuthDeg: roof.ridgeAzimuthDeg ?? null,
  };
}

/** A vertical roof cross-section (perpendicular to the ridge) for the inspector. */
export interface RoofSection {
  type: RoofType;
  /** Footprint width across the ridge (m). */
  spanM: number;
  /** Wall top above the storey floor (m). */
  wallHeightM: number;
  /** Knee-wall (Kniestock) height above the wall top before the slope (m). */
  kneeHeightM: number;
  /** Ridge/high-eave rise above the eaves (wall top + knee) (m). */
  ridgeHeightM: number;
  pitchDeg: number;
  /**
   * Roof outline polyline in section coords: `x ∈ [0, spanM]` across the span,
   * `y` = height above the storey floor (wall top = `wallHeightM`).
   */
  profile: Point[];
}

/**
 * Compute a vertical roof cross-section taken PERPENDICULAR to the ridge. This
 * is the classic architectural section: flat = level line; shed = single slope;
 * gable/hip/half-hip = symmetric triangle (a hip's mid-section equals a gable's
 * — the hips only shorten the end elevations, not the central cut). Pure.
 */
export function roofSectionProfile(state: EditorState, roofId: string): RoofSection | null {
  const roof = state.model.roofs.find((r) => r.id === roofId);
  if (roof === undefined) return null;
  const storey = state.model.storeys.find((s) => s.id === roof.storeyId);
  if (storey === undefined) return null;
  const info = roofPlaneInfo(state, roofId);
  if (info === null) return null;
  const wallHeightM = storey.heightM > 0 ? storey.heightM : 2.5;
  const kneeHeightM = roof.type === 'flat' ? 0 : Math.max(0, roof.kneeHeightM ?? 0);
  const eavesY = wallHeightM + kneeHeightM; // roof starts sloping here
  // Ridge axis: along X (east–west) when the azimuth is ~90/270°, else along Y;
  // without a hint it follows the longer footprint axis. The section span is the
  // dimension PERPENDICULAR to the ridge.
  const ridgeAlongX =
    roof.ridgeAzimuthDeg !== undefined
      ? Math.abs((((roof.ridgeAzimuthDeg % 180) + 180) % 180) - 90) < 45
      : info.widthM >= info.depthM;
  const spanM = ridgeAlongX ? info.depthM : info.widthM;
  const pitchRad = (roof.pitchDeg * Math.PI) / 180;
  let profile: Point[];
  let ridgeHeightM: number;
  if (roof.type === 'flat') {
    ridgeHeightM = 0;
    profile = [{ x: 0, y: eavesY }, { x: spanM, y: eavesY }];
  } else if (roof.type === 'shed') {
    ridgeHeightM = spanM * Math.tan(pitchRad);
    profile = [{ x: 0, y: eavesY }, { x: spanM, y: eavesY + ridgeHeightM }];
  } else {
    // gable / hip / half_hip — symmetric ridge in the middle.
    ridgeHeightM = (spanM / 2) * Math.tan(pitchRad);
    profile = [
      { x: 0, y: eavesY },
      { x: spanM / 2, y: eavesY + ridgeHeightM },
      { x: spanM, y: eavesY },
    ];
  }
  return { type: roof.type, spanM, wallHeightM, kneeHeightM, ridgeHeightM, pitchDeg: roof.pitchDeg, profile };
}

/**
 * Pure module-count fit: how many `moduleW × moduleH` modules (with `gap`
 * between and `clearance` around the edges) fit into a `usableW × usableD`
 * roof plane. Returns whole rows/columns (≥0).
 */
export function pvAutoFit(
  usableWidthM: number,
  usableDepthM: number,
  moduleWidthM: number,
  moduleHeightM: number,
  gapM: number,
  clearanceM: number,
): { rows: number; columns: number } {
  const w = usableWidthM - 2 * clearanceM;
  const d = usableDepthM - 2 * clearanceM;
  if (w <= 0 || d <= 0 || moduleWidthM <= 0 || moduleHeightM <= 0) return { rows: 0, columns: 0 };
  const columns = Math.max(0, Math.floor((w + gapM) / (moduleWidthM + gapM)));
  const rows = Math.max(0, Math.floor((d + gapM) / (moduleHeightM + gapM)));
  return { rows, columns };
}

export function addPvArray(ctx: EditorContext, state: EditorState, input: PvInput): EditorState {
  const roof = state.model.roofs.find((r) => r.id === input.roofId);
  if (roof === undefined) return state;
  const pv: PvArray = {
    id: ctx.newId(),
    roofFaceId: `${input.roofId}:main`,
    rows: Math.max(1, Math.round(input.rows ?? 1)),
    columns: Math.max(1, Math.round(input.columns ?? 1)),
    moduleWidthM: input.moduleWidthM !== undefined && input.moduleWidthM > 0 ? input.moduleWidthM : 1.7,
    moduleHeightM: input.moduleHeightM !== undefined && input.moduleHeightM > 0 ? input.moduleHeightM : 1.0,
    ...(input.gapM !== undefined ? { gapM: Math.max(0, input.gapM) } : {}),
  };
  return { ...state, model: { ...state.model, pvArrays: [...state.model.pvArrays, pv] }, selection: [pv.id] };
}

export function updatePvArray(
  state: EditorState,
  pvId: string,
  patch: Partial<Pick<PvArray, 'rows' | 'columns' | 'moduleWidthM' | 'moduleHeightM' | 'gapM'>>,
): EditorState {
  const pvArrays = state.model.pvArrays.map((p) => {
    if (p.id !== pvId) return p;
    const next: PvArray = { ...p };
    if (patch.rows !== undefined) next.rows = Math.max(1, Math.round(patch.rows));
    if (patch.columns !== undefined) next.columns = Math.max(1, Math.round(patch.columns));
    if (patch.moduleWidthM !== undefined && patch.moduleWidthM > 0) next.moduleWidthM = patch.moduleWidthM;
    if (patch.moduleHeightM !== undefined && patch.moduleHeightM > 0) next.moduleHeightM = patch.moduleHeightM;
    if (patch.gapM !== undefined) next.gapM = Math.max(0, patch.gapM);
    return next;
  });
  return { ...state, model: { ...state.model, pvArrays } };
}

export function removePvArray(state: EditorState, pvId: string): EditorState {
  return {
    ...state,
    model: { ...state.model, pvArrays: state.model.pvArrays.filter((p) => p.id !== pvId) },
    selection: state.selection.filter((id) => id !== pvId),
  };
}

// ---------------------------------------------------------------------------
// Commands — walls.
// ---------------------------------------------------------------------------

export interface WallInput {
  axis: Point[];
  thicknessM?: number;
  heightM?: number | null;
  boundary?: WallBoundary;
}

export function addWall(ctx: EditorContext, state: EditorState, input: WallInput): EditorState {
  const s = activeStorey(state);
  if (s === null) return state;
  if (input.axis.length < 2 || segmentLength(input.axis) <= 0) return state;
  const wall: Wall = {
    id: ctx.newId(),
    axis: input.axis,
    thicknessM: input.thicknessM ?? 0.24,
    heightM: input.heightM ?? null,
    constructionId: null,
    boundary: input.boundary ?? 'outside',
  };
  const model = mapStorey(state.model, s.id, (st) => ({ ...st, walls: [...st.walls, wall] }));
  return { ...state, model, selection: [wall.id] };
}

export function updateWall(
  state: EditorState,
  wallId: string,
  patch: Partial<Pick<Wall, 'thicknessM' | 'heightM' | 'boundary' | 'constructionId'>>,
): EditorState {
  const s = activeStorey(state);
  if (s === null) return state;
  const model = mapStorey(state.model, s.id, (st) => ({
    ...st,
    walls: st.walls.map((w) => (w.id === wallId ? { ...w, ...patch } : w)),
  }));
  return { ...state, model };
}

export function moveWallVertex(
  state: EditorState,
  wallId: string,
  index: number,
  point: Point,
): EditorState {
  const s = activeStorey(state);
  if (s === null) return state;
  const model = mapStorey(state.model, s.id, (st) => ({
    ...st,
    walls: st.walls.map((w) => {
      if (w.id !== wallId) return w;
      if (index < 0 || index >= w.axis.length) return w;
      const axis = w.axis.map((p, i) => (i === index ? point : p));
      return { ...w, axis };
    }),
  }));
  return { ...state, model };
}

/**
 * Delete a vertex from a wall polyline. A wall needs ≥2 points, so removing a
 * vertex that would drop it below 2 deletes the whole wall (and its openings).
 */
export function deleteWallVertex(state: EditorState, wallId: string, index: number): EditorState {
  const s = activeStorey(state);
  if (s === null) return state;
  const wall = s.walls.find((w) => w.id === wallId);
  if (wall === undefined || index < 0 || index >= wall.axis.length) return state;
  if (wall.axis.length <= 2) return deleteWall(state, wallId);
  const model = mapStorey(state.model, s.id, (st) => ({
    ...st,
    walls: st.walls.map((w) => (w.id === wallId ? { ...w, axis: w.axis.filter((_, i) => i !== index) } : w)),
  }));
  return { ...state, model };
}

export function deleteWall(state: EditorState, wallId: string): EditorState {
  const s = activeStorey(state);
  if (s === null) return state;
  const model = mapStorey(state.model, s.id, (st) => ({
    ...st,
    walls: st.walls.filter((w) => w.id !== wallId),
    // Cascade: drop openings hosted on the removed wall.
    openings: st.openings.filter((o) => o.hostWallId !== wallId),
  }));
  return { ...state, model, selection: state.selection.filter((id) => id !== wallId) };
}

// ---------------------------------------------------------------------------
// Commands — openings.
// ---------------------------------------------------------------------------

export interface OpeningInput {
  type: OpeningType;
  hostWallId: string;
  offsetM: number;
  widthM: number;
  heightM: number;
  sillM?: number;
  glazing?: GlazingType;
  roofWindow?: boolean;
  name?: string;
}

export function addOpening(
  ctx: EditorContext,
  state: EditorState,
  input: OpeningInput,
): EditorState {
  const s = activeStorey(state);
  if (s === null) return state;
  const host = s.walls.find((w) => w.id === input.hostWallId);
  if (host === undefined) return state; // opening must sit on a wall of this storey
  const opening: Opening = {
    id: ctx.newId(),
    type: input.type,
    ...(input.name !== undefined && input.name.trim().length > 0 ? { name: input.name.trim() } : {}),
    hostWallId: input.hostWallId,
    offsetM: Math.max(0, input.offsetM),
    widthM: input.widthM,
    heightM: input.heightM,
    // Windows sit on a sill; doors and passages (Durchgang) go to the floor.
    sillM: input.sillM ?? (input.type === 'window' ? 0.9 : 0),
    // Only windows carry glazing; doors and passages have none.
    ...(input.type === 'window' ? { glazing: input.glazing ?? 'double' } : {}),
    ...(input.roofWindow === true ? { roofWindow: true } : {}),
  };
  const model = mapStorey(state.model, s.id, (st) => ({
    ...st,
    openings: [...st.openings, opening],
  }));
  return { ...state, model, selection: [opening.id] };
}

export interface RoofWindowInput {
  roofId: string;
  offsetM?: number;
  widthM?: number;
  heightM?: number;
  glazing?: GlazingType;
  name?: string;
}

/**
 * Add a roof window (Dachfenster) to the storey's roof. Unlike a façade
 * opening it is hosted by the ROOF (`hostRoofId`), not a wall — no synthetic
 * wall is created. `offsetM` positions it along the ridge; `widthM`/`heightM`
 * are its size in the roof plane. Requires a roof on the active storey.
 */
export function addRoofWindow(
  ctx: EditorContext,
  state: EditorState,
  input: RoofWindowInput,
): EditorState {
  const s = activeStorey(state);
  if (s === null) return state;
  const roof = state.model.roofs.find((r) => r.id === input.roofId && r.storeyId === s.id);
  if (roof === undefined) return state; // roof window needs a roof on this storey
  const opening: Opening = {
    id: ctx.newId(),
    type: 'window',
    ...(input.name !== undefined && input.name.trim().length > 0 ? { name: input.name.trim() } : {}),
    hostRoofId: roof.id,
    offsetM: Math.max(0, input.offsetM ?? 0),
    widthM: input.widthM !== undefined && input.widthM > 0 ? input.widthM : 0.78,
    heightM: input.heightM !== undefined && input.heightM > 0 ? input.heightM : 1.4,
    sillM: 0,
    glazing: input.glazing ?? 'double',
    roofWindow: true,
  };
  const model = mapStorey(state.model, s.id, (st) => ({ ...st, openings: [...st.openings, opening] }));
  return { ...state, model, selection: [opening.id] };
}

export interface OpeningPatch {
  widthM?: number;
  heightM?: number;
  offsetM?: number;
  sillM?: number;
  glazing?: GlazingType;
  roofWindow?: boolean;
  /** Rename; empty string clears the name back to the type default. */
  name?: string;
  /** Link to a config window; `null` clears it, `undefined` keeps it. */
  linkedWindowId?: string | null;
}

/**
 * Edit a hosted opening's geometry (width/height/offset/sill). Values are
 * clamped to sane minimums; `undefined` fields are left unchanged. Pure.
 */
export function updateOpening(
  state: EditorState,
  openingId: string,
  patch: OpeningPatch,
): EditorState {
  const s = activeStorey(state);
  if (s === null) return state;
  const model = mapStorey(state.model, s.id, (st) => ({
    ...st,
    openings: st.openings.map((o) => {
      if (o.id !== openingId) return o;
      const next: Opening = {
        ...o,
        ...(patch.widthM !== undefined ? { widthM: Math.max(0.1, patch.widthM) } : {}),
        ...(patch.heightM !== undefined ? { heightM: Math.max(0.1, patch.heightM) } : {}),
        ...(patch.offsetM !== undefined ? { offsetM: Math.max(0, patch.offsetM) } : {}),
        ...(patch.sillM !== undefined ? { sillM: Math.max(0, patch.sillM) } : {}),
        ...(patch.glazing !== undefined ? { glazing: patch.glazing } : {}),
        ...(patch.roofWindow !== undefined ? { roofWindow: patch.roofWindow } : {}),
      };
      // Rename: a non-empty string sets the label, empty clears it.
      if (patch.name !== undefined) {
        const nm = patch.name.trim();
        if (nm.length > 0) next.name = nm;
        else delete next.name;
      }
      // `null` clears the config-window link; a string sets it.
      if (patch.linkedWindowId === null) delete next.linkedWindowId;
      else if (patch.linkedWindowId !== undefined) next.linkedWindowId = patch.linkedWindowId;
      return next;
    }),
  }));
  return { ...state, model };
}

export function deleteOpening(state: EditorState, openingId: string): EditorState {
  const s = activeStorey(state);
  if (s === null) return state;
  const model = mapStorey(state.model, s.id, (st) => ({
    ...st,
    openings: st.openings.filter((o) => o.id !== openingId),
  }));
  return { ...state, model, selection: state.selection.filter((id) => id !== openingId) };
}

// ---------------------------------------------------------------------------
// Commands — spaces (rooms).
// ---------------------------------------------------------------------------

export interface SpaceInput {
  name: string;
  polygon: Point[];
}

export function addSpace(ctx: EditorContext, state: EditorState, input: SpaceInput): EditorState {
  const s = activeStorey(state);
  if (s === null) return state;
  if (input.polygon.length < 3) return state;
  const space: Space = {
    id: ctx.newId(),
    name: input.name,
    polygon: input.polygon,
    useProfileId: null,
    thermalZoneId: null,
  };
  const model = mapStorey(state.model, s.id, (st) => ({ ...st, spaces: [...st.spaces, space] }));
  return { ...state, model, selection: [space.id] };
}

export function updateSpace(
  state: EditorState,
  spaceId: string,
  patch: Partial<Pick<Space, 'name' | 'useProfileId'>> & { linkedRoomId?: string | null },
): EditorState {
  const s = activeStorey(state);
  if (s === null) return state;
  const model = mapStorey(state.model, s.id, (st) => ({
    ...st,
    spaces: st.spaces.map((sp) => {
      if (sp.id !== spaceId) return sp;
      const next: Space = { ...sp };
      if (patch.name !== undefined) next.name = patch.name;
      if (patch.useProfileId !== undefined) next.useProfileId = patch.useProfileId;
      // `null` clears the link (exactOptionalPropertyTypes → delete the key);
      // a string sets it; `undefined` leaves it unchanged.
      if (patch.linkedRoomId === null) delete next.linkedRoomId;
      else if (patch.linkedRoomId !== undefined) next.linkedRoomId = patch.linkedRoomId;
      return next;
    }),
  }));
  return { ...state, model };
}

export function moveSpaceVertex(
  state: EditorState,
  spaceId: string,
  index: number,
  point: Point,
): EditorState {
  const s = activeStorey(state);
  if (s === null) return state;
  const model = mapStorey(state.model, s.id, (st) => ({
    ...st,
    spaces: st.spaces.map((sp) => {
      if (sp.id !== spaceId) return sp;
      if (index < 0 || index >= sp.polygon.length) return sp;
      return { ...sp, polygon: sp.polygon.map((p, i) => (i === index ? point : p)) };
    }),
  }));
  return { ...state, model };
}

/**
 * Delete a vertex from a room polygon. A polygon needs ≥3 points, so removing a
 * vertex that would drop it below 3 deletes the whole room.
 */
export function deleteSpaceVertex(state: EditorState, spaceId: string, index: number): EditorState {
  const s = activeStorey(state);
  if (s === null) return state;
  const sp = s.spaces.find((x) => x.id === spaceId);
  if (sp === undefined || index < 0 || index >= sp.polygon.length) return state;
  if (sp.polygon.length <= 3) return deleteSpace(state, spaceId);
  const model = mapStorey(state.model, s.id, (st) => ({
    ...st,
    spaces: st.spaces.map((x) => (x.id === spaceId ? { ...x, polygon: x.polygon.filter((_, i) => i !== index) } : x)),
  }));
  return { ...state, model };
}

export function deleteSpace(state: EditorState, spaceId: string): EditorState {
  const s = activeStorey(state);
  if (s === null) return state;
  const model = mapStorey(state.model, s.id, (st) => ({
    ...st,
    spaces: st.spaces.filter((sp) => sp.id !== spaceId),
  }));
  return { ...state, model, selection: state.selection.filter((id) => id !== spaceId) };
}

// ---------------------------------------------------------------------------
// Selection (transient — never recorded as an undo step by callers).
// ---------------------------------------------------------------------------

export function setSelection(state: EditorState, ids: string[]): EditorState {
  return { ...state, selection: [...ids] };
}

export function clearSelection(state: EditorState): EditorState {
  return { ...state, selection: [] };
}

// ---------------------------------------------------------------------------
// Validation passthrough.
// ---------------------------------------------------------------------------

export function validateState(state: EditorState): BuildingModelValidation {
  return validateBuildingModel(state.model);
}

// ---------------------------------------------------------------------------
// Advanced wall ops (BME-08): split, merge, align.
// ---------------------------------------------------------------------------

const MERGE_TOL_M = BUILDING_TOLERANCES.mergeM;

/** Project `p` onto a polyline, returning the nearest segment + foot point. */
function projectOnAxis(
  axis: Point[],
  p: Point,
): { segIndex: number; point: Point } | null {
  let best: { segIndex: number; point: Point; d: number } | null = null;
  for (let i = 1; i < axis.length; i += 1) {
    const a = axis[i - 1] as Point;
    const b = axis[i] as Point;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) continue;
    let tt = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    tt = Math.max(0, Math.min(1, tt));
    const foot = { x: a.x + tt * dx, y: a.y + tt * dy };
    const d = Math.hypot(p.x - foot.x, p.y - foot.y);
    if (best === null || d < best.d) best = { segIndex: i - 1, point: foot, d };
  }
  return best === null ? null : { segIndex: best.segIndex, point: best.point };
}

/**
 * Split the wall nearest to `at` into two walls at the projected point. The
 * two halves inherit the original wall's attributes. No-op if the split point
 * coincides with an endpoint (would create a zero-length wall).
 */
export function splitWall(ctx: EditorContext, state: EditorState, wallId: string, at: Point): EditorState {
  const s = activeStorey(state);
  if (s === null) return state;
  const wall = s.walls.find((w) => w.id === wallId);
  if (wall === undefined) return state;
  const proj = projectOnAxis(wall.axis, at);
  if (proj === null) return state;

  const insertIdx = proj.segIndex + 1;
  const axisWith = [...wall.axis.slice(0, insertIdx), proj.point, ...wall.axis.slice(insertIdx)];
  const axisA = axisWith.slice(0, insertIdx + 1);
  const axisB = axisWith.slice(insertIdx);
  if (segmentLength(axisA) <= MERGE_TOL_M || segmentLength(axisB) <= MERGE_TOL_M) return state;

  const wallA: Wall = { ...wall, id: ctx.newId(), axis: axisA };
  const wallB: Wall = { ...wall, id: ctx.newId(), axis: axisB };
  const model = mapStorey(state.model, s.id, (st) => ({
    ...st,
    walls: st.walls.flatMap((w) => (w.id === wallId ? [wallA, wallB] : [w])),
    // Openings on the split wall move to the first half (offset kept; a later
    // pass could re-home by offset, but never orphan them).
    openings: st.openings.map((o) => (o.hostWallId === wallId ? { ...o, hostWallId: wallA.id } : o)),
  }));
  return { ...state, model, selection: [wallA.id, wallB.id] };
}

function sharedEnd(a: Wall, b: Wall): { aStart: boolean; bStart: boolean } | null {
  const aS = a.axis[0] as Point;
  const aE = a.axis[a.axis.length - 1] as Point;
  const bS = b.axis[0] as Point;
  const bE = b.axis[b.axis.length - 1] as Point;
  const near = (p: Point, q: Point): boolean => Math.hypot(p.x - q.x, p.y - q.y) <= MERGE_TOL_M;
  if (near(aE, bS)) return { aStart: false, bStart: true };
  if (near(aE, bE)) return { aStart: false, bStart: false };
  if (near(aS, bS)) return { aStart: true, bStart: true };
  if (near(aS, bE)) return { aStart: true, bStart: false };
  return null;
}

/**
 * Merge two walls that share an endpoint into a single polyline wall (keeping
 * wall A's attributes). Openings on both walls re-home to the merged wall so
 * they are never orphaned. No-op if the walls do not share an endpoint.
 */
export function mergeWalls(ctx: EditorContext, state: EditorState, aId: string, bId: string): EditorState {
  if (aId === bId) return state;
  const s = activeStorey(state);
  if (s === null) return state;
  const a = s.walls.find((w) => w.id === aId);
  const b = s.walls.find((w) => w.id === bId);
  if (a === undefined || b === undefined) return state;
  const rel = sharedEnd(a, b);
  if (rel === null) return state;

  const aAxis = rel.aStart ? [...a.axis].reverse() : a.axis; // shared point at end of A
  const bAxis = rel.bStart ? b.axis : [...b.axis].reverse(); // shared point at start of B
  const mergedAxis = [...aAxis, ...bAxis.slice(1)];

  const merged: Wall = { ...a, id: ctx.newId(), axis: mergedAxis };
  const model = mapStorey(state.model, s.id, (st) => ({
    ...st,
    walls: st.walls.flatMap((w) => (w.id === aId ? [merged] : w.id === bId ? [] : [w])),
    openings: st.openings.map((o) =>
      o.hostWallId === aId || o.hostWallId === bId ? { ...o, hostWallId: merged.id } : o,
    ),
  }));
  return { ...state, model, selection: [merged.id] };
}

/**
 * Align the given walls onto a shared axis line: snaps the chosen coordinate of
 * every vertex of those walls to their common average, straightening them onto
 * a common vertical (`x`) or horizontal (`y`) line.
 */
export function alignWalls(state: EditorState, wallIds: string[], axis: 'x' | 'y'): EditorState {
  const s = activeStorey(state);
  if (s === null || wallIds.length === 0) return state;
  const ids = new Set(wallIds);
  const coords: number[] = [];
  for (const w of s.walls) {
    if (!ids.has(w.id)) continue;
    for (const p of w.axis) coords.push(axis === 'x' ? p.x : p.y);
  }
  if (coords.length === 0) return state;
  const avg = coords.reduce((sum, c) => sum + c, 0) / coords.length;
  const model = mapStorey(state.model, s.id, (st) => ({
    ...st,
    walls: st.walls.map((w) =>
      ids.has(w.id)
        ? { ...w, axis: w.axis.map((p) => (axis === 'x' ? { x: avg, y: p.y } : { x: p.x, y: avg })) }
        : w,
    ),
  }));
  return { ...state, model };
}

// ---------------------------------------------------------------------------
// Trim / extend to intersection + parallel offset (BME-08).
// ---------------------------------------------------------------------------

/** Intersection of the two INFINITE lines through (p1,p2) and (p3,p4). */
export function lineIntersection(p1: Point, p2: Point, p3: Point, p4: Point): Point | null {
  const d1x = p2.x - p1.x;
  const d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x;
  const d2y = p4.y - p3.y;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-9) return null; // parallel / degenerate
  const tt = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / denom;
  return { x: p1.x + tt * d1x, y: p1.y + tt * d1y };
}

/** Average midpoint of a wall axis (endpoints), for "which end is nearer B". */
function nearestEndInfo(a: Wall, b: Wall): { endIndex: number; segFrom: number } {
  const aS = a.axis[0] as Point;
  const aE = a.axis[a.axis.length - 1] as Point;
  const bMid = midOfAxis(b.axis);
  const dS = Math.hypot(aS.x - bMid.x, aS.y - bMid.y);
  const dE = Math.hypot(aE.x - bMid.x, aE.y - bMid.y);
  return dS <= dE
    ? { endIndex: 0, segFrom: 1 } // move start; terminal segment is axis[0..1]
    : { endIndex: a.axis.length - 1, segFrom: a.axis.length - 2 };
}

function midOfAxis(axis: Point[]): Point {
  let x = 0;
  let y = 0;
  for (const p of axis) {
    x += p.x;
    y += p.y;
  }
  const n = axis.length || 1;
  return { x: x / n, y: y / n };
}

/** Nearest segment of a wall to a point, as an index pair. */
function nearestSegment(axis: Point[], p: Point): { i0: number; i1: number } {
  let best = { i0: 0, i1: 1, d: Infinity };
  for (let i = 1; i < axis.length; i += 1) {
    const a = axis[i - 1] as Point;
    const b = axis[i] as Point;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy || 1;
    let tt = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    tt = Math.max(0, Math.min(1, tt));
    const d = Math.hypot(p.x - (a.x + tt * dx), p.y - (a.y + tt * dy));
    if (d < best.d) best = { i0: i - 1, i1: i, d };
  }
  return { i0: best.i0, i1: best.i1 };
}

/**
 * Extend or trim wall A so its endpoint nearest to wall B lands exactly on the
 * intersection of A's terminal segment line and B's nearest segment line. A
 * single operation covers BOTH extend (endpoint moves outward to meet B) and
 * trim (endpoint moves inward), because it just relocates the endpoint to the
 * line–line intersection. No-op when the lines are parallel.
 */
export function extendWallToWall(state: EditorState, wallId: string, targetWallId: string): EditorState {
  if (wallId === targetWallId) return state;
  const s = activeStorey(state);
  if (s === null) return state;
  const a = s.walls.find((w) => w.id === wallId);
  const b = s.walls.find((w) => w.id === targetWallId);
  if (a === undefined || b === undefined || a.axis.length < 2 || b.axis.length < 2) return state;

  const { endIndex, segFrom } = nearestEndInfo(a, b);
  const aP1 = a.axis[segFrom] as Point;
  const aP2 = a.axis[endIndex] as Point;
  const bSeg = nearestSegment(b.axis, aP2);
  const bP1 = b.axis[bSeg.i0] as Point;
  const bP2 = b.axis[bSeg.i1] as Point;

  const hit = lineIntersection(aP1, aP2, bP1, bP2);
  if (hit === null) return state;

  const model = mapStorey(state.model, s.id, (st) => ({
    ...st,
    walls: st.walls.map((w) =>
      w.id === wallId ? { ...w, axis: w.axis.map((p, i) => (i === endIndex ? hit : p)) } : w,
    ),
  }));
  return { ...state, model };
}

/**
 * Create a parallel copy of a wall offset by `distanceM` along its normal
 * (positive = left of the a→b direction). Each vertex is displaced by the
 * average of its adjacent segment normals so polylines offset smoothly. The
 * new wall inherits the source attributes.
 */
export function offsetWall(ctx: EditorContext, state: EditorState, wallId: string, distanceM: number): EditorState {
  const s = activeStorey(state);
  if (s === null || distanceM === 0) return state;
  const wall = s.walls.find((w) => w.id === wallId);
  if (wall === undefined || wall.axis.length < 2) return state;

  const axis = wall.axis;
  const segNormals: Array<{ x: number; y: number }> = [];
  for (let i = 1; i < axis.length; i += 1) {
    const a = axis[i - 1] as Point;
    const b = axis[i] as Point;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    segNormals.push({ x: -dy / len, y: dx / len });
  }
  const vertexNormal = (i: number): { x: number; y: number } => {
    const left = segNormals[i - 1];
    const right = segNormals[i];
    const nx = (left?.x ?? 0) + (right?.x ?? 0);
    const ny = (left?.y ?? 0) + (right?.y ?? 0);
    const len = Math.hypot(nx, ny) || 1;
    return { x: nx / len, y: ny / len };
  };
  const newAxis: Point[] = axis.map((p, i) => {
    const n = vertexNormal(i);
    return { x: p.x + n.x * distanceM, y: p.y + n.y * distanceM };
  });

  const copy: Wall = { ...wall, id: ctx.newId(), axis: newAxis };
  const model = mapStorey(state.model, s.id, (st) => ({ ...st, walls: [...st.walls, copy] }));
  return { ...state, model, selection: [copy.id] };
}

// ---------------------------------------------------------------------------
// Automatic room suggestion (BME-10).
// ---------------------------------------------------------------------------

export interface SuggestRoomsResult {
  state: EditorState;
  added: number;
}

/**
 * Detect enclosed wall loops on the active storey and add a room (space) for
 * every face NOT already covered by an existing room (dedupe by centroid).
 * Returns the new state plus how many rooms were added.
 */
export function suggestRooms(ctx: EditorContext, state: EditorState): SuggestRoomsResult {
  const s = activeStorey(state);
  if (s === null) return { state, added: 0 };
  const faces = detectRooms(s.walls);
  const newSpaces: Space[] = [];
  const existing = s.spaces.map((sp) => sp.polygon);
  for (const face of faces) {
    const c = centroid(face.polygon);
    const covered = existing.some((poly) => pointInPolygon(c, poly));
    if (covered) continue;
    newSpaces.push({
      id: ctx.newId(),
      name: `Raum ${s.spaces.length + newSpaces.length + 1}`,
      polygon: face.polygon,
      useProfileId: null,
      thermalZoneId: null,
    });
  }
  if (newSpaces.length === 0) return { state, added: 0 };
  const model = mapStorey(state.model, s.id, (st) => ({ ...st, spaces: [...st.spaces, ...newSpaces] }));
  return { state: { ...state, model, selection: newSpaces.map((sp) => sp.id) }, added: newSpaces.length };
}
