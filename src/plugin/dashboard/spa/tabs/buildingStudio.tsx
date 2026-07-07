/**
 * Heat Shield — Building Model Studio (building-model-editor spec, Phase 1 MVP).
 *
 * A 2D floor-plan editor over the canonical Shared Building Model. Feature-
 * flagged (`buildingStudioV2`, default OFF). Uses the PURE editor core
 * (`src/shared/building-editor.ts`) for every mutation so the UI holds no
 * geometry logic — it only maps pointer gestures to domain commands and paints
 * an SVG. Persistence is optimistic-concurrency save via `PUT /api/building`.
 *
 * Scope (Phase 1): storeys (add/switch/rename), walls (draw with grid + angle
 * snapping, live length/angle, select, numeric edit, delete), openings
 * (window/door on a selected wall), rooms (polygon draw, name/use), undo/redo,
 * validation panel, save + revision/dirty state. Pointer ops have keyboard/
 * numeric alternatives (BME-19). No path reaches the actuator (BME-16).
 *
 * Deferred (documented in the plan): underlays/calibration, assisted
 * extraction, 3D twin, roof/PV editors, GLB export, mobile drawing.
 */

import { h, Fragment, type JSX } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';

import { t } from '../i18n.js';
import { latestBuildingRevision } from '../store.js';
import { snapshot } from '../store.js';
import { useConfig } from '../hooks/useConfig.js';
import { roomStatuses } from '../components/uebersicht/uebersichtModel.js';
import { exportSvgAsPng } from '../svgExport.js';
import { Twin3D } from '../components/building/twin3d.js';
import { ThermalPanel } from '../components/building/thermalPanel.js';
import type { BuildingModel, Opening, Point, PvArray, Roof, RoofType, Space, Storey, Wall } from '../../../../shared/building-model.js';
import {
  calibrateTwoPoint,
  effectiveMpp,
  hasCrop,
  modelToImageFraction,
  normalizeCropPolygon,
  UNDERLAY_KINDS,
  type UnderlayKind,
  type UnderlayMeta,
} from '../../../../shared/building-underlay.js';
import {
  type EditorHistory,
  type EditorState,
  type AngleConstraint,
  type RoofPlaneInfo,
  addOpening,
  addSpace,
  updateSpace,
  deleteSpace,
  addStorey,
  duplicateStorey,
  removeStorey,
  addWall,
  addRoof,
  addRoofWindow,
  addPvArray,
  alignWalls,
  canRedo,
  canUndo,
  clearSelection,
  constrainAngle,
  defaultEditorContext,
  deleteOpening,
  deleteWall,
  extendWallToWall,
  headingDeg,
  initHistory,
  mergeWalls,
  moveWallVertex,
  moveSpaceVertex,
  deleteWallVertex,
  deleteSpaceVertex,
  nearestVertex,
  newEditorState,
  offsetWall,
  polygonArea,
  pushHistory,
  pvAutoFit,
  redo,
  roofPlaneInfo,
  roofSectionProfile,
  type RoofSection,
  segmentLength,
  setActiveStorey,
  setSelection,
  snapToGrid,
  splitWall,
  suggestRooms,
  undo,
  updateOpening,
  updateStorey,
  updateWall,
  updatePvArray,
  removePvArray,
  removeRoof,
  updateRoof,
  validateState,
} from '../../../../shared/building-editor.js';

interface RoutableProps {
  path?: string;
  default?: boolean;
}

const CTX = defaultEditorContext();

// ---------------------------------------------------------------------------
// API client.
// ---------------------------------------------------------------------------

async function loadModel(): Promise<BuildingModel> {
  const res = await fetch('/api/building');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as BuildingModel;
}

type SaveOutcome =
  | { ok: true; model: BuildingModel; changed: boolean }
  | { ok: false; kind: 'stale' | 'error'; message: string };

async function saveModel(model: BuildingModel): Promise<SaveOutcome> {
  const res = await fetch(`/api/building?expectedRevision=${model.revision}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(model),
  });
  if (res.ok) {
    const json = (await res.json()) as { model: BuildingModel; changed: boolean };
    return { ok: true, model: json.model, changed: json.changed };
  }
  if (res.status === 409) {
    return { ok: false, kind: 'stale', message: t('Konflikt: das Modell wurde zwischenzeitlich geändert. Bitte neu laden.', 'Conflict: the model changed meanwhile. Please reload.') };
  }
  return { ok: false, kind: 'error', message: `HTTP ${res.status}` };
}

// ---------------------------------------------------------------------------
// Underlay API client.
// ---------------------------------------------------------------------------

async function loadUnderlays(): Promise<UnderlayMeta[]> {
  const res = await fetch('/api/building/underlays');
  if (!res.ok) return [];
  return ((await res.json()) as { underlays: UnderlayMeta[] }).underlays ?? [];
}

async function uploadUnderlay(dataUrl: string, storeyId: string, name: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch('/api/building/underlays', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataUrl, storeyId, name }),
  });
  if (res.ok) return { ok: true };
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  return { ok: false, error: body?.error?.message ?? `HTTP ${res.status}` };
}

async function patchUnderlay(id: string, patch: Partial<UnderlayMeta>): Promise<void> {
  await fetch(`/api/building/underlays/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

async function removeUnderlay(id: string): Promise<void> {
  await fetch(`/api/building/underlays/${id}`, { method: 'DELETE' });
}

// ---------------------------------------------------------------------------
// View transform (metres ↔ screen px).
// ---------------------------------------------------------------------------

interface View {
  scale: number; // px per metre
  offsetX: number; // px
  offsetY: number; // px
}

const DEFAULT_VIEW: View = { scale: 40, offsetX: 400, offsetY: 300 };

function toScreen(p: Point, v: View): { sx: number; sy: number } {
  // y is flipped so +y (north-ish) points up on screen.
  return { sx: p.x * v.scale + v.offsetX, sy: -p.y * v.scale + v.offsetY };
}

function toModel(sx: number, sy: number, v: View): Point {
  return { x: (sx - v.offsetX) / v.scale, y: -(sy - v.offsetY) / v.scale };
}

/** Point + unit tangent at distance `d` (m) along a wall polyline (clamped). */
function pointAlongPolyline(axis: Point[], d: number): { p: Point; tx: number; ty: number } | null {
  if (axis.length < 2) return null;
  let remaining = Math.max(0, d);
  for (let i = 0; i < axis.length - 1; i += 1) {
    const a = axis[i] as Point;
    const b = axis[i + 1] as Point;
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    if (segLen <= 1e-9) continue;
    if (remaining <= segLen || i === axis.length - 2) {
      const f = Math.min(1, remaining / segLen);
      return { p: { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }, tx: (b.x - a.x) / segLen, ty: (b.y - a.y) / segLen };
    }
    remaining -= segLen;
  }
  return null;
}

/** True while the viewport is phone/tablet-narrow (desktop-only editor). */
function useIsNarrow(maxWidth = 820): boolean {
  const [narrow, setNarrow] = useState<boolean>(() => {
    try { return window.matchMedia?.(`(max-width:${maxWidth}px)`).matches === true; } catch { return false; }
  });
  useEffect(() => {
    let mq: MediaQueryList;
    try { mq = window.matchMedia(`(max-width:${maxWidth}px)`); } catch { return undefined; }
    const update = (): void => setNarrow(mq.matches);
    update();
    try { mq.addEventListener('change', update); return (): void => mq.removeEventListener('change', update); }
    catch { mq.addListener?.(update); return (): void => mq.removeListener?.(update); }
  }, [maxWidth]);
  return narrow;
}

/**
 * Per-vertex mitered offset points (left/right) for a wall polyline. At an
 * interior corner the offset of the two adjacent segments is joined with a
 * miter so both segments share the SAME corner point — no gap / white edge and
 * no double-painted overlap. Clamped so very sharp angles don't spike.
 */
function wallMiterOffsets(axis: Point[], half: number): { left: Point[]; right: Point[] } {
  const n = axis.length;
  const left: Point[] = new Array(n);
  const right: Point[] = new Array(n);
  const unit = (a: Point, b: Point): Point | null => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    return len < 1e-9 ? null : { x: dx / len, y: dy / len };
  };
  // Closed loop (a room's enclosing walls): the first and last vertices are the
  // SAME point, so treat that shared vertex as an interior corner — mitre it
  // with the last segment (incoming) and the first segment (outgoing) so the
  // closing corner is as clean as every other L corner (no white edge).
  const closed = n >= 3 && Math.hypot((axis[0] as Point).x - (axis[n - 1] as Point).x, (axis[0] as Point).y - (axis[n - 1] as Point).y) < 1e-6;
  for (let k = 0; k < n; k += 1) {
    const p = axis[k] as Point;
    let dIn = k > 0 ? unit(axis[k - 1] as Point, p) : null;
    let dOut = k < n - 1 ? unit(p, axis[k + 1] as Point) : null;
    if (closed && k === 0) dIn = unit(axis[n - 2] as Point, axis[n - 1] as Point);
    if (closed && k === n - 1) dOut = unit(axis[0] as Point, axis[1] as Point);
    let normal: Point;
    let scale = half;
    if (dIn !== null && dOut !== null) {
      const nIn = { x: -dIn.y, y: dIn.x };
      const nOut = { x: -dOut.y, y: dOut.x };
      const mx = nIn.x + nOut.x;
      const my = nIn.y + nOut.y;
      const mlen = Math.hypot(mx, my);
      if (mlen < 1e-6) {
        normal = nIn; // near 180° reversal — degenerate, use one side.
      } else {
        const mUnit = { x: mx / mlen, y: my / mlen };
        const cosHalf = mUnit.x * nIn.x + mUnit.y * nIn.y;
        scale = half / Math.max(cosHalf, 0.25); // cap miter at 4×half.
        normal = mUnit;
      }
    } else if (dOut !== null) {
      normal = { x: -dOut.y, y: dOut.x };
    } else if (dIn !== null) {
      normal = { x: -dIn.y, y: dIn.x };
    } else {
      normal = { x: 0, y: 1 };
    }
    left[k] = { x: p.x + normal.x * scale, y: p.y + normal.y * scale };
    right[k] = { x: p.x - normal.x * scale, y: p.y - normal.y * scale };
  }
  return { left, right };
}

/**
 * Screen-space quads for the SOLID parts of a wall — the wall polyline offset
 * by ±thickness/2 with MITERED corners (so an L-shaped wall shows a clean
 * corner, no white edge), with the opening spans (`holes`, in arc-length metres
 * along the whole polyline) cut out so doors/windows/passages leave a real
 * notch in the wall instead of being painted over it.
 */
function wallSolidQuads(axis: Point[], thicknessM: number, holes: Array<[number, number]>, view: View): string[] {
  const quads: string[] = [];
  const half = thicknessM / 2;
  const { left: miterL, right: miterR } = wallMiterOffsets(axis, half);
  let segStart = 0;
  for (let i = 1; i < axis.length; i += 1) {
    const a = axis[i - 1] as Point;
    const b = axis[i] as Point;
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    if (segLen < 1e-9) continue;
    const segEnd = segStart + segLen;
    const dx = (b.x - a.x) / segLen;
    const dy = (b.y - a.y) / segLen;
    const nx = -dy * half; // segment perpendicular (left) offset
    const ny = dx * half;
    // Offset point for an arc-length position: mitered at the segment's own
    // end vertices, plain perpendicular for hole-cut points inside the segment.
    const leftAt = (arc: number, atStart: boolean, atEnd: boolean): Point => {
      if (atStart) return miterL[i - 1] as Point;
      if (atEnd) return miterL[i] as Point;
      const local = arc - segStart;
      return { x: a.x + dx * local + nx, y: a.y + dy * local + ny };
    };
    const rightAt = (arc: number, atStart: boolean, atEnd: boolean): Point => {
      if (atStart) return miterR[i - 1] as Point;
      if (atEnd) return miterR[i] as Point;
      const local = arc - segStart;
      return { x: a.x + dx * local - nx, y: a.y + dy * local - ny };
    };
    const emit = (s0: number, e0: number): void => {
      if (e0 - s0 <= 1e-4) return;
      const atS = s0 <= segStart + 1e-4;
      const atE = e0 >= segEnd - 1e-4;
      const corners = [leftAt(s0, atS, false), leftAt(e0, false, atE), rightAt(e0, false, atE), rightAt(s0, atS, false)];
      quads.push(corners.map((c) => { const s = toScreen(c, view); return `${s.sx},${s.sy}`; }).join(' '));
    };
    const segHoles = holes
      .map(([s, e]): [number, number] => [Math.max(s, segStart), Math.min(e, segEnd)])
      .filter(([s, e]) => e > s + 1e-4)
      .sort((x, y) => x[0] - y[0]);
    let cursor = segStart;
    for (const [hs, he] of segHoles) {
      emit(cursor, hs);
      cursor = Math.max(cursor, he);
    }
    emit(cursor, segEnd);
    segStart = segEnd;
  }
  return quads;
}

/**
 * Offset a traced polyline so the STORED axis is the wall centre-line when the
 * user traced an outer/inner face. `outer` shifts the wall to the RIGHT of the
 * draw direction (trace the outside clockwise), `inner` to the LEFT; `center`
 * is unchanged. Uses the same mitered offsets as the wall body so corners stay
 * clean.
 */
function applyWallReference(axis: Point[], thicknessM: number, ref: 'center' | 'outer' | 'inner'): Point[] {
  if (ref === 'center' || axis.length < 2) return axis;
  const { left, right } = wallMiterOffsets(axis, thicknessM / 2);
  // left[k] = axis + leftNormal*half, right[k] = axis − leftNormal*half.
  // Traced OUTER face → centre lies to the right of travel → use right[]; the
  // INNER face → centre to the left → use left[].
  return ref === 'outer' ? right : left;
}

/** Arc-length distance (m) of the point on a polyline closest to `p`. */
function projectPointToPolyline(axis: Point[], p: Point): number {
  let best = Infinity;
  let bestS = 0;
  let acc = 0;
  for (let i = 1; i < axis.length; i += 1) {
    const a = axis[i - 1] as Point;
    const b = axis[i] as Point;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const segLen = Math.hypot(dx, dy);
    const len2 = dx * dx + dy * dy;
    let tt = len2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    tt = Math.max(0, Math.min(1, tt));
    const cx = a.x + tt * dx;
    const cy = a.y + tt * dy;
    const d = Math.hypot(p.x - cx, p.y - cy);
    if (d < best) { best = d; bestS = acc + segLen * tt; }
    acc += segLen;
  }
  return bestS;
}

/** Simple centroid (vertex average) for label placement. */
function spaceCentroid(polygon: Point[]): Point {
  if (polygon.length === 0) return { x: 0, y: 0 };
  let x = 0;
  let y = 0;
  for (const p of polygon) {
    x += p.x;
    y += p.y;
  }
  return { x: x / polygon.length, y: y / polygon.length };
}

type Tool = 'select' | 'wall' | 'room' | 'calibrate' | 'crop' | 'moveUnderlay';

// ---------------------------------------------------------------------------
// Revision history API (BME-18).
// ---------------------------------------------------------------------------

interface RevisionSummary {
  revision: number;
  contentHash: string;
  savedAt: string;
}

async function loadHistory(): Promise<RevisionSummary[]> {
  const res = await fetch('/api/building/history');
  if (!res.ok) return [];
  return ((await res.json()) as { revisions: RevisionSummary[] }).revisions ?? [];
}

// ---------------------------------------------------------------------------
// Multi-project API (shared-building-model 2.2).
// ---------------------------------------------------------------------------

interface ProjectMeta {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}
interface ProjectIndex {
  activeId: string;
  projects: ProjectMeta[];
}

async function loadProjects(): Promise<ProjectIndex | null> {
  const res = await fetch('/api/building/projects');
  if (!res.ok) return null;
  const idx = (await res.json()) as ProjectIndex;
  // Defensive: only accept a well-formed index (the route may be unavailable
  // or a catch-all mock may return an unrelated shape).
  if (idx === null || typeof idx !== 'object' || !Array.isArray((idx as ProjectIndex).projects) || typeof (idx as ProjectIndex).activeId !== 'string') {
    return null;
  }
  return idx;
}
async function apiCreateProject(name: string): Promise<ProjectIndex | null> {
  const res = await fetch('/api/building/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  return res.ok ? ((await res.json()) as ProjectIndex) : null;
}
async function apiRenameProject(id: string, name: string): Promise<ProjectIndex | null> {
  const res = await fetch(`/api/building/projects/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  return res.ok ? ((await res.json()) as ProjectIndex) : null;
}
async function apiDeleteProject(id: string): Promise<ProjectIndex | null> {
  const res = await fetch(`/api/building/projects/${id}`, { method: 'DELETE' });
  return res.ok ? ((await res.json()) as ProjectIndex) : null;
}
async function apiActivateProject(id: string): Promise<ProjectIndex | null> {
  const res = await fetch(`/api/building/projects/${id}/activate`, { method: 'POST' });
  return res.ok ? ((await res.json()) as ProjectIndex) : null;
}

async function restoreRevision(rev: number): Promise<boolean> {
  const res = await fetch(`/api/building/restore/${rev}`, { method: 'POST' });
  return res.ok;
}

// ---------------------------------------------------------------------------
// Component.
// ---------------------------------------------------------------------------

export function BuildingStudioView(_props: RoutableProps): JSX.Element {
  // Read-only view of the HeatShield config for linking drawn geometry to real
  // automated rooms/windows (never mutated here — the Rooms/Windows settings
  // pages own config edits).
  const { config } = useConfig();
  const configRooms = useMemo(
    () => (config.value?.rooms ?? []).map((r) => ({ id: r.id, name: r.name })),
    [config.value],
  );
  const configWindows = useMemo(
    () => (config.value?.windows ?? []).map((w) => ({ id: w.id, roomId: w.roomId, orientationDeg: w.orientationDeg })),
    [config.value],
  );

  const [history, setHistory] = useState<EditorHistory | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<{ busy: boolean; msg: string | null }>({ busy: false, msg: null });
  const [dirty, setDirty] = useState<boolean>(false);

  const [tool, setTool] = useState<Tool>('select');
  const [angle, setAngle] = useState<AngleConstraint>('ortho');
  const [gridM, setGridM] = useState<number>(0.5);
  // Two-click opening placement: after picking a type on a selected wall, the
  // next two clicks on that wall set the opening's start + end (position + size
  // = distance between the clicks). `s0` = first click arc-length along the wall.
  const [openingPlace, setOpeningPlace] = useState<{ type: 'window' | 'door' | 'passage'; wallId: string; s0: number | null } | null>(null);
  // Inline two-step confirm for deleting a storey (window.confirm is blocked in
  // the HCU webview, so a native confirm silently no-ops).
  const [armDeleteStorey, setArmDeleteStorey] = useState<boolean>(false);
  // Default wall thickness applied to newly drawn walls (Außen/Innen presets).
  const [defaultThicknessM, setDefaultThicknessM] = useState<number>(0.24);
  // Reference edge for newly drawn walls: the traced line is the wall centre,
  // its outer face, or its inner face (relative to draw direction). On commit
  // the drawn axis is offset by ±thickness/2 so the STORED axis is the centre.
  const [wallRef, setWallRef] = useState<'center' | 'outer' | 'inner'>('center');
  const [view, setView] = useState<View>(DEFAULT_VIEW);
  const [draft, setDraft] = useState<Point[]>([]);
  const [cursor, setCursor] = useState<Point | null>(null);
  const [show3d, setShow3d] = useState<boolean>(false);
  const [showThermal, setShowThermal] = useState<boolean>(false);
  const [showHistory, setShowHistory] = useState<boolean>(false);
  const [moreOpen, setMoreOpen] = useState<boolean>(false);
  const moreRef = useRef<HTMLDivElement | null>(null);
  // Dismissible "start your floor plan" hint (persisted per device).
  const [onboardingDismissed, setOnboardingDismissed] = useState<boolean>(() => {
    try { return window.localStorage.getItem('heatshield.building.onboardingDismissed') === '1'; } catch { return false; }
  });
  const dismissOnboarding = useCallback((): void => {
    setOnboardingDismissed(true);
    try { window.localStorage.setItem('heatshield.building.onboardingDismissed', '1'); } catch { /* ignore */ }
  }, []);
  const [revisions, setRevisions] = useState<RevisionSummary[]>([]);
  const [projects, setProjects] = useState<ProjectIndex | null>(null);
  const [renaming, setRenaming] = useState<boolean>(false);

  // Underlays (BME-03/04/05/12).
  const [underlays, setUnderlays] = useState<UnderlayMeta[]>([]);
  const [showUnderlays, setShowUnderlays] = useState<boolean>(false);
  const [calibratingId, setCalibratingId] = useState<string | null>(null);
  const [calibPoints, setCalibPoints] = useState<Point[]>([]);
  const [calibDist, setCalibDist] = useState<string>('1');
  // Freeform crop (BME-04): pick a polygon over the underlay in model space.
  const [croppingId, setCroppingId] = useState<string | null>(null);
  const [cropPoints, setCropPoints] = useState<Point[]>([]);
  // Underlay move: drag the reference image to reposition it (offsetXM/YM).
  const [movingUnderlayId, setMovingUnderlayId] = useState<string | null>(null);
  const [underlayOverride, setUnderlayOverride] = useState<{ id: string; offsetXM: number; offsetYM: number } | null>(null);
  const isNarrow = useIsNarrow();

  const svgRef = useRef<SVGSVGElement | null>(null);
  const panRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const underlayDragRef = useRef<{ id: string; startX: number; startY: number; offX: number; offY: number } | null>(null);
  // Vertex drag (move a wall/room point). `recorded` marks the one undo step.
  const vertexDragRef = useRef<{ kind: 'wall' | 'space'; id: string; index: number; recorded: boolean } | null>(null);
  // Opening endpoint drag (move/resize a window/door/passage along its wall).
  const openingDragRef = useRef<{ id: string; end: 'start' | 'end'; recorded: boolean } | null>(null);

  const refreshUnderlays = useCallback((): void => {
    void loadUnderlays().then(setUnderlays).catch(() => setUnderlays([]));
  }, []);

  // Load underlays once on mount (best-effort; the routes may be unavailable).
  useEffect(() => {
    refreshUnderlays();
  }, [refreshUnderlays]);

  // Load the project index once on mount (best-effort).
  useEffect(() => {
    void loadProjects().then((idx) => { if (idx !== null) setProjects(idx); }).catch(() => undefined);
  }, []);

  // Close the "Mehr" menu on an outside click or Escape.
  useEffect(() => {
    if (!moreOpen) return undefined;
    const onDown = (e: MouseEvent): void => {
      if (moreRef.current !== null && !moreRef.current.contains(e.target as Node)) setMoreOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setMoreOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return (): void => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [moreOpen]);

  // Load once on mount.
  useEffect(() => {
    let alive = true;
    void loadModel()
      .then((model) => {
        if (alive) setHistory(initHistory(newEditorState(model)));
      })
      .catch((err: unknown) => {
        if (alive) setLoadError(err instanceof Error ? err.message : 'load failed');
      });
    return (): void => {
      alive = false;
    };
  }, []);

  const state: EditorState | null = history?.present ?? null;
  const model = state?.model ?? null;
  const storey: Storey | null =
    model !== null && state !== null
      ? (model.storeys.find((s) => s.id === state.activeStoreyId) ?? null)
      : null;

  // Apply a recorded (undoable) command.
  const commit = useCallback(
    (next: EditorState): void => {
      setHistory((h) => (h === null ? h : pushHistory(h, next, true)));
      setDirty(true);
    },
    [],
  );
  // Apply a transient (non-undoable) change, e.g. selection.
  const transient = useCallback((next: EditorState): void => {
    setHistory((h) => (h === null ? h : pushHistory(h, next, false)));
  }, []);

  const doUndo = useCallback(() => {
    setHistory((h) => (h === null ? h : undo(h)));
    setDirty(true);
  }, []);
  const doRedo = useCallback(() => {
    setHistory((h) => (h === null ? h : redo(h)));
    setDirty(true);
  }, []);

  // Keyboard: undo/redo, escape cancels a draft, Enter commits a wall/room.
  const commitDraft = useCallback(() => {
    if (state === null) return;
    if (tool === 'wall' && draft.length >= 2) {
      commit(addWall(CTX, state, { axis: applyWallReference(draft, defaultThicknessM, wallRef), thicknessM: defaultThicknessM }));
      setDraft([]);
    } else if (tool === 'room' && draft.length >= 3) {
      const name = t(`Raum ${(storey?.spaces.length ?? 0) + 1}`, `Room ${(storey?.spaces.length ?? 0) + 1}`);
      commit(addSpace(CTX, state, { name, polygon: draft }));
      setDraft([]);
    }
  }, [state, tool, draft, commit, storey, defaultThicknessM, wallRef]);

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        doUndo();
      } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
        e.preventDefault();
        doRedo();
      } else if (e.key === 'Escape') {
        setDraft([]);
        setOpeningPlace(null);
      } else if (e.key === 'Enter') {
        commitDraft();
      }
    }
    window.addEventListener('keydown', onKey);
    return (): void => window.removeEventListener('keydown', onKey);
  }, [doUndo, doRedo, commitDraft]);

  // Disarm the storey-delete confirm + cancel opening placement when the active
  // storey changes (so a stale confirm/placement never applies to another floor).
  useEffect(() => { setArmDeleteStorey(false); setOpeningPlace(null); }, [state?.activeStoreyId]);

  // Snap a raw model point. Priority: (1) strong snap to an existing vertex
  // (wall endpoints, room corners, the draft's start point) so polylines and
  // room polygons close exactly on a point; else (2) grid + angle constraint.
  const snapPoint = useCallback(
    (raw: Point): Point => {
      const maxDistM = 14 / view.scale;
      const verts: Point[] = [];
      for (const w of storey?.walls ?? []) {
        // Centre-line vertices + BOTH face corners (inner/outer), so a new wall
        // sticks flush to an existing wall's inside or outside edge, not just
        // its centre-line.
        for (const p of w.axis) verts.push(p);
        const faces = wallMiterOffsets(w.axis, w.thicknessM / 2);
        for (const p of faces.left) verts.push(p);
        for (const p of faces.right) verts.push(p);
      }
      for (const sp of storey?.spaces ?? []) for (const p of sp.polygon) verts.push(p);
      if (draft.length > 0) verts.push(draft[0] as Point);
      const v = nearestVertex(verts, raw, maxDistM);
      if (v !== null) return v;
      const g = snapToGrid(raw, gridM);
      if (draft.length > 0 && (tool === 'wall' || tool === 'room')) {
        return constrainAngle(draft[draft.length - 1] as Point, g, angle);
      }
      return g;
    },
    [gridM, draft, tool, angle, view.scale, storey],
  );

  const eventToModel = useCallback(
    (e: PointerEvent | MouseEvent): Point | null => {
      const svg = svgRef.current;
      if (svg === null) return null;
      const rect = svg.getBoundingClientRect();
      return toModel(e.clientX - rect.left, e.clientY - rect.top, view);
    },
    [view],
  );

  const onPointerDown = useCallback(
    (e: PointerEvent): void => {
      if (state === null) return;
      // Middle button or space-less right → pan.
      if (e.button === 1) {
        panRef.current = { x: e.clientX, y: e.clientY, ox: view.offsetX, oy: view.offsetY };
        return;
      }
      const m = eventToModel(e);
      if (m === null) return;
      // Two-click opening placement takes priority over every tool: click once
      // to set the start along the wall, click again to set the end. The two
      // arc-length positions become offset (min) + width (distance).
      if (openingPlace !== null) {
        const wall = storey?.walls.find((w) => w.id === openingPlace.wallId);
        if (wall === undefined) { setOpeningPlace(null); return; }
        const wallLen = segmentLength(wall.axis);
        let s = Math.max(0, Math.min(wallLen, projectPointToPolyline(wall.axis, m)));
        if (gridM > 0) s = Math.max(0, Math.min(wallLen, Math.round(s / gridM) * gridM));
        if (openingPlace.s0 === null) {
          setOpeningPlace({ ...openingPlace, s0: s });
        } else {
          const offsetM = Math.min(openingPlace.s0, s);
          const widthM = Math.max(0.1, Math.abs(s - openingPlace.s0));
          const heightM = openingPlace.type === 'window' ? 1.2 : 2;
          commit(addOpening(CTX, state, { type: openingPlace.type, hostWallId: wall.id, offsetM, widthM, heightM }));
          setOpeningPlace(null);
        }
        return;
      }
      if (tool === 'calibrate') {
        // Capture up to two precise (un-snapped) model points for scaling.
        setCalibPoints((pts) => (pts.length >= 2 ? [m] : [...pts, m]));
        return;
      }
      if (tool === 'crop') {
        // Collect un-snapped model points for the freeform crop polygon.
        setCropPoints((pts) => [...pts, m]);
        return;
      }
      if (tool === 'moveUnderlay') {
        const u = underlays.find((x) => x.id === movingUnderlayId);
        if (u !== undefined) {
          underlayDragRef.current = { id: u.id, startX: m.x, startY: m.y, offX: u.offsetXM, offY: u.offsetYM };
        }
        return;
      }
      const p = snapPoint(m);
      const first = draft[0];
      // Both tools auto-finish when the click lands back on the START point
      // (snapPoint snaps exactly onto draft[0] within tolerance): a wall closes
      // into a loop, a room closes into its polygon.
      const closesOnStart = first !== undefined && Math.hypot(p.x - first.x, p.y - first.y) < 1e-6;
      if (tool === 'wall') {
        if (draft.length >= 2 && closesOnStart) {
          commit(addWall(CTX, state, { axis: applyWallReference([...draft, first as Point], defaultThicknessM, wallRef), thicknessM: defaultThicknessM }));
          setDraft([]);
        } else {
          setDraft((d) => [...d, p]);
        }
      } else if (tool === 'room') {
        if (draft.length >= 3 && closesOnStart) {
          const name = t(`Raum ${(storey?.spaces.length ?? 0) + 1}`, `Room ${(storey?.spaces.length ?? 0) + 1}`);
          commit(addSpace(CTX, state, { name, polygon: draft }));
          setDraft([]);
        } else {
          setDraft((d) => [...d, p]);
        }
      } else {
        // First: an opening endpoint handle (on a selected wall)? Start dragging.
        const oh = hitTestOpeningHandle(storey, state.selection, m, view);
        if (oh !== null) {
          openingDragRef.current = { id: oh.id, end: oh.end, recorded: false };
          return;
        }
        // Next: a vertex handle of the selected wall/space? Alt-click deletes
        // it, otherwise start dragging it.
        const vh = hitTestVertex(storey, state.selection, m, view);
        if (vh !== null) {
          if (e.altKey) {
            commit(vh.kind === 'wall' ? deleteWallVertex(state, vh.id, vh.index) : deleteSpaceVertex(state, vh.id, vh.index));
          } else {
            vertexDragRef.current = { kind: vh.kind, id: vh.id, index: vh.index, recorded: false };
          }
          return;
        }
        // select: hit-test walls (nearest endpoint/segment) → select or clear.
        const hit = hitTestWall(storey, m, view);
        if (hit === null) {
          transient(clearSelection(state));
        } else if (e.shiftKey) {
          // Shift toggles the hit into a multi-selection (merge/align need ≥2).
          const sel = state.selection.includes(hit)
            ? state.selection.filter((id) => id !== hit)
            : [...state.selection, hit];
          transient(setSelection(state, sel));
        } else {
          transient(setSelection(state, [hit]));
        }
      }
    },
    [state, view, eventToModel, snapPoint, tool, storey, transient, draft, commit, underlays, movingUnderlayId, defaultThicknessM, wallRef, openingPlace, gridM],
  );

  const onPointerMove = useCallback(
    (e: PointerEvent): void => {
      if (panRef.current !== null) {
        const pan = panRef.current;
        setView((v) => ({ ...v, offsetX: pan.ox + (e.clientX - pan.x), offsetY: pan.oy + (e.clientY - pan.y) }));
        return;
      }
      if (underlayDragRef.current !== null) {
        const m = eventToModel(e);
        if (m !== null) {
          const d = underlayDragRef.current;
          setUnderlayOverride({ id: d.id, offsetXM: d.offX + (m.x - d.startX), offsetYM: d.offY + (m.y - d.startY) });
        }
        return;
      }
      if (vertexDragRef.current !== null && state !== null) {
        const m = eventToModel(e);
        if (m !== null) {
          const d = vertexDragRef.current;
          // Snap to OTHER vertices (join corners) — excluding the dragged one so
          // it never sticks to itself — else strong grid snap.
          const maxDistM = 14 / view.scale;
          const verts: Point[] = [];
          for (const w of storey?.walls ?? []) w.axis.forEach((pp, i) => { if (!(d.kind === 'wall' && w.id === d.id && i === d.index)) verts.push(pp); });
          for (const sp of storey?.spaces ?? []) sp.polygon.forEach((pp, i) => { if (!(d.kind === 'space' && sp.id === d.id && i === d.index)) verts.push(pp); });
          const p = nearestVertex(verts, m, maxDistM) ?? snapToGrid(m, gridM);
          const next = d.kind === 'wall'
            ? moveWallVertex(state, d.id, d.index, p)
            : moveSpaceVertex(state, d.id, d.index, p);
          // First move records ONE undo step (pushing the pre-drag state);
          // subsequent moves are transient so the drag is a single undo.
          if (!d.recorded) { commit(next); d.recorded = true; } else { transient(next); }
          setCursor(p);
        }
        return;
      }
      if (openingDragRef.current !== null && state !== null && storey !== null) {
        const m = eventToModel(e);
        if (m !== null) {
          const d = openingDragRef.current;
          const o = storey.openings.find((x) => x.id === d.id);
          const wall = o === undefined ? undefined : storey.walls.find((w) => w.id === o.hostWallId);
          if (o !== undefined && wall !== undefined) {
            const wallLen = segmentLength(wall.axis);
            const s = Math.max(0, Math.min(wallLen, projectPointToPolyline(wall.axis, m)));
            const end0 = o.offsetM + o.widthM;
            let patch: { offsetM?: number; widthM?: number };
            if (d.end === 'start') {
              const start = Math.max(0, Math.min(s, end0 - 0.1));
              patch = { offsetM: start, widthM: end0 - start };
            } else {
              const end = Math.max(o.offsetM + 0.1, Math.min(s, wallLen));
              patch = { widthM: end - o.offsetM };
            }
            const next = updateOpening(state, d.id, patch);
            if (!d.recorded) { commit(next); d.recorded = true; } else { transient(next); }
            setCursor(m);
          }
        }
        return;
      }
      const m = eventToModel(e);
      if (m !== null) setCursor(snapPoint(m));
    },
    [eventToModel, snapPoint, state, commit, transient, storey, gridM, view.scale],
  );

  const onPointerUp = useCallback((): void => {
    panRef.current = null;
    vertexDragRef.current = null;
    openingDragRef.current = null;
    const d = underlayDragRef.current;
    if (d !== null) {
      underlayDragRef.current = null;
      const ov = underlayOverride;
      if (ov !== null && ov.id === d.id) {
        void patchUnderlay(d.id, { offsetXM: ov.offsetXM, offsetYM: ov.offsetYM }).then(() => refreshUnderlays());
      }
      setUnderlayOverride(null);
      setMovingUnderlayId(null);
      setTool('select');
      setSaveState({ busy: false, msg: t('Unterlage verschoben.', 'Underlay moved.') });
    }
  }, [underlayOverride, refreshUnderlays]);

  const onWheel = useCallback((e: WheelEvent): void => {
    e.preventDefault();
    setView((v) => {
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      const next = Math.min(200, Math.max(8, v.scale * factor));
      return { ...v, scale: next };
    });
  }, []);

  const onSave = useCallback(async (): Promise<void> => {
    if (model === null) return;
    setSaveState({ busy: true, msg: null });
    const outcome = await saveModel(model);
    if (outcome.ok) {
      // Adopt the committed (revision-bumped) model as the new baseline.
      setHistory((h) => (h === null ? h : initHistory({ ...h.present, model: outcome.model })));
      setDirty(false);
      setSaveState({ busy: false, msg: t(`Gespeichert (Rev. ${outcome.model.revision}).`, `Saved (rev. ${outcome.model.revision}).`) });
    } else {
      setSaveState({ busy: false, msg: outcome.message });
    }
  }, [model]);

  const onReload = useCallback((): void => {
    setSaveState({ busy: true, msg: null });
    void loadModel()
      .then((m) => {
        setHistory(initHistory(newEditorState(m)));
        setDirty(false);
        setSaveState({ busy: false, msg: t('Neu geladen.', 'Reloaded.') });
      })
      .catch((err: unknown) => setSaveState({ busy: false, msg: err instanceof Error ? err.message : 'reload failed' }));
  }, []);

  // Project actions (switch/create/delete/rename) — each reloads the model.
  const switchProject = useCallback((id: string): void => {
    void apiActivateProject(id)
      .then((idx) => { if (idx !== null) setProjects(idx); onReload(); })
      .catch(() => setSaveState({ busy: false, msg: t('Projektwechsel fehlgeschlagen.', 'Project switch failed.') }));
  }, [onReload]);
  const newProject = useCallback((): void => {
    void apiCreateProject('')
      .then((idx) => { if (idx !== null) { setProjects(idx); onReload(); } })
      .catch(() => undefined);
  }, [onReload]);
  const removeProject = useCallback((id: string): void => {
    void apiDeleteProject(id)
      .then((idx) => { if (idx !== null) { setProjects(idx); onReload(); } })
      .catch(() => undefined);
  }, [onReload]);
  const commitRename = useCallback((id: string, name: string): void => {
    void apiRenameProject(id, name)
      .then((idx) => { if (idx !== null) setProjects(idx); setRenaming(false); })
      .catch(() => setRenaming(false));
  }, []);

  const [offsetDist, setOffsetDist] = useState<string>('0.24');

  const startCalibration = useCallback((id: string): void => {
    setCalibratingId(id);
    setCalibPoints([]);
    setTool('calibrate');
    setSaveState({ busy: false, msg: t('Zwei Punkte bekannter Distanz auf der Unterlage anklicken.', 'Click two points of known distance on the underlay.') });
  }, []);

  const applyCalibration = useCallback((): void => {
    if (calibratingId === null || calibPoints.length < 2) return;
    const u = underlays.find((x) => x.id === calibratingId);
    if (u === undefined) return;
    const real = Number(calibDist);
    if (!Number.isFinite(real) || real <= 0) return;
    const cal = calibrateTwoPoint(u, calibPoints[0] as Point, calibPoints[1] as Point, real);
    void patchUnderlay(u.id, cal).then(() => {
      refreshUnderlays();
      setCalibratingId(null);
      setCalibPoints([]);
      setTool('select');
      setSaveState({ busy: false, msg: t(`Maßstab gesetzt: ${cal.metersPerPixel.toFixed(4)} m/px.`, `Scale set: ${cal.metersPerPixel.toFixed(4)} m/px.`) });
    });
  }, [calibratingId, calibPoints, underlays, calibDist, refreshUnderlays]);

  const startCrop = useCallback((id: string): void => {
    setCroppingId(id);
    setCropPoints([]);
    setTool('crop');
    setSaveState({ busy: false, msg: t('Eckpunkte des sichtbaren Bereichs auf der Unterlage anklicken (mind. 3), dann „Anwenden“.', 'Click the corners of the visible area on the underlay (min. 3), then “Apply”.') });
  }, []);

  const cancelCrop = useCallback((): void => {
    setCroppingId(null);
    setCropPoints([]);
    setTool('select');
  }, []);

  const applyCrop = useCallback((): void => {
    if (croppingId === null || cropPoints.length < 3) return;
    const u = underlays.find((x) => x.id === croppingId);
    if (u === undefined) return;
    const crop = normalizeCropPolygon(cropPoints.map((p) => modelToImageFraction(p, u)));
    if (crop.length < 3) {
      setSaveState({ busy: false, msg: t('Zuschnitt liegt außerhalb des Bildes.', 'Crop lies outside the image.') });
      return;
    }
    void patchUnderlay(u.id, { crop }).then(() => {
      refreshUnderlays();
      setCroppingId(null);
      setCropPoints([]);
      setTool('select');
      setSaveState({ busy: false, msg: t(`Zuschnitt gesetzt (${crop.length} Punkte).`, `Crop set (${crop.length} points).`) });
    });
  }, [croppingId, cropPoints, underlays, refreshUnderlays]);

  const clearCrop = useCallback((id: string): void => {
    void patchUnderlay(id, { crop: [] }).then(() => {
      refreshUnderlays();
      setSaveState({ busy: false, msg: t('Zuschnitt entfernt.', 'Crop cleared.') });
    });
  }, [refreshUnderlays]);

  const startMoveUnderlay = useCallback((id: string): void => {
    setMovingUnderlayId(id);
    setUnderlayOverride(null);
    setTool('moveUnderlay');
    setSaveState({ busy: false, msg: t('Unterlage mit der Maus ziehen, um sie zu verschieben.', 'Drag the underlay with the mouse to move it.') });
  }, []);

  const validation = useMemo(() => (state === null ? null : validateState(state)), [state]);

  // Timed autosave: 3 s after the last edit, when dirty and not already saving.
  // Each edit re-runs this (model changes) and resets the debounce timer; a
  // successful save clears `dirty` and stops the loop.
  useEffect(() => {
    if (!dirty || model === null || saveState.busy) return undefined;
    const id = setTimeout(() => {
      void onSave();
    }, 3000);
    return (): void => clearTimeout(id);
  }, [dirty, model, saveState.busy, onSave]);

  if (isNarrow) {
    return (
      <section class="module-panel" data-testid="tab-building">
        <div class="module-panel__head"><h1>{t('Gebäude-Studio', 'Building Studio')}</h1></div>
        <div class="bs-mobile-block" data-testid="building-mobile-block">
          <strong>{t('Nur am Desktop verfügbar', 'Desktop only')}</strong>
          <p>{t(
            'Das Gebäude-Studio ist ein präziser Zeichen- und 3D-Editor und braucht einen großen Bildschirm mit Maus. Bitte wechsle an einen PC-Browser.',
            'The Building Studio is a precise drawing & 3D editor and needs a large screen with a mouse. Please switch to a PC browser.',
          )}</p>
        </div>
      </section>
    );
  }
  if (loadError !== null) {
    return (
      <section class="module-panel" data-testid="tab-building">
        <div class="module-panel__head"><h1>{t('Gebäude-Studio', 'Building Studio')}</h1></div>
        <p class="module-panel__hint" data-testid="building-error">{t('Konnte das Gebäudemodell nicht laden: ', 'Could not load the building model: ')}{loadError}</p>
      </section>
    );
  }
  if (history === null || state === null || model === null || storey === null) {
    return (
      <section class="module-panel" data-testid="tab-building">
        <div class="module-panel__head"><h1>{t('Gebäude-Studio', 'Building Studio')}</h1></div>
        <p class="module-panel__hint">{t('Lade Gebäudemodell …', 'Loading building model …')}</p>
      </section>
    );
  }

  const selectedWall = storey.walls.find((w) => state.selection.includes(w.id)) ?? null;
  const selectedWalls = storey.walls.filter((w) => state.selection.includes(w.id));
  // Live cross-session sync (SSE `building.revision`): another session or a
  // history restore advanced the model past the one we loaded.
  const latestRev = latestBuildingRevision.value;
  const staleRemotely = latestRev !== null && latestRev > model.revision;
  // Live room-state overlay data for the twin (T-03): map matched rooms by name.
  const snap = snapshot.value;
  const roomOverlays = snap === null ? [] : roomStatuses(snap).map((r) => ({ name: r.name, tone: r.tone, tempC: r.tempC }));
  // Selection in click order (extend uses "wall A extends to wall B").
  const selectedWallsOrdered = state.selection
    .map((id) => storey.walls.find((w) => w.id === id))
    .filter((w): w is Wall => w !== undefined);
  const storeyUnderlays = underlays.filter((u) => u.storeyId === storey.id);

  return (
    <section class="module-panel building-studio" data-testid="tab-building">
      <div class="module-panel__head bs-head">
        <h1>{t('Gebäude-Studio', 'Building Studio')}</h1>
        <span class="module-panel__badge" data-testid="building-rev">
          {t(`Rev. ${model.revision}`, `Rev. ${model.revision}`)}{dirty ? ' •' : ''}
        </span>
        {projects !== null && (
          <div class="bs-head__projects" data-testid="building-projects">
            {renaming ? (
              <input
                type="text"
                class="bs-projects__rename"
                data-testid="building-project-rename"
                value={projects.projects.find((p) => p.id === projects.activeId)?.name ?? ''}
                autoFocus
                onKeyDown={(e): void => { if (e.key === 'Enter') commitRename(projects.activeId, (e.currentTarget as HTMLInputElement).value); if (e.key === 'Escape') setRenaming(false); }}
                onBlur={(e): void => commitRename(projects.activeId, (e.currentTarget as HTMLInputElement).value)}
              />
            ) : (
              <select
                value={projects.activeId}
                data-testid="building-project-select"
                title={t('Projekt', 'Project')}
                disabled={saveState.busy}
                onChange={(e): void => switchProject((e.currentTarget as HTMLSelectElement).value)}
              >
                {projects.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            )}
            <button type="button" data-testid="building-project-rename-btn" title={t('Projekt umbenennen', 'Rename project')} disabled={saveState.busy || renaming} onClick={(): void => setRenaming(true)}>✎</button>
            <button type="button" data-testid="building-project-new" title={t('Neues Projekt', 'New project')} disabled={saveState.busy} onClick={newProject}>＋</button>
            <button
              type="button"
              class="bs-danger"
              data-testid="building-project-delete"
              title={t('Projekt löschen', 'Delete project')}
              disabled={saveState.busy || projects.activeId === 'default' || projects.projects.length <= 1}
              onClick={(): void => removeProject(projects.activeId)}
            >🗑</button>
          </div>
        )}
      </div>

      {storey.walls.length === 0 && storey.spaces.length === 0 && !onboardingDismissed && (
        <div class="bs-onboarding" data-testid="building-onboarding">
          <button
            type="button"
            class="bs-onboarding__close"
            data-testid="building-onboarding-close"
            title={t('Hinweis schließen', 'Dismiss')}
            aria-label={t('Hinweis schließen', 'Dismiss')}
            onClick={dismissOnboarding}
          >✕</button>
          <div class="bs-onboarding__text">
            <strong>{t('Grundriss anlegen', 'Start your floor plan')}</strong>
            <p>{t(
              'Optional eine Grundriss-Vorlage unter „Unterlagen" laden und kalibrieren. Mit dem Raum-Werkzeug klickst du die Ecken – der Raum schließt automatisch, sobald du wieder auf den ersten Punkt klickst. Winkel wählbar: 90°, 45° oder frei. Punkte rasten stark auf vorhandene Ecken, damit die Fläche sicher geschlossen wird.',
              'Optionally load & calibrate a plan under “Underlays”. With the Room tool, click the corners — the room closes automatically as soon as you click the first point again. Angle: 90°, 45° or free. Points snap strongly onto existing corners so the area closes reliably.',
            )}</p>
          </div>
        </div>
      )}

      <div class="bs-toolbar" data-testid="building-toolbar">
        <div class="bs-toolbar__group seg" role="group" aria-label={t('Werkzeug', 'Tool')}>
          {(['select', 'wall', 'room'] as Tool[]).map((tl) => (
            <button
              key={tl}
              type="button"
              class={`seg__btn ${tool === tl ? 'seg__btn--active' : ''}`}
              data-testid={`building-tool-${tl}`}
              aria-pressed={tool === tl}
              onClick={(): void => { setTool(tl); setDraft([]); }}
            >
              {tl === 'select' ? t('Auswahl', 'Select') : tl === 'wall' ? t('Wand', 'Wall') : t('Raum', 'Room')}
            </button>
          ))}
        </div>
        <label class="bs-toolbar__field">
          {t('Winkel', 'Angle')}
          <select value={angle} onChange={(e): void => setAngle((e.currentTarget as HTMLSelectElement).value as AngleConstraint)} data-testid="building-angle">
            <option value="ortho">{t('90°', '90°')}</option>
            <option value="deg45">{t('45°', '45°')}</option>
            <option value="free">{t('frei', 'free')}</option>
          </select>
        </label>
        <label class="bs-toolbar__field">
          {t('Raster', 'Grid')}
          <select value={String(gridM)} onChange={(e): void => setGridM(Number((e.currentTarget as HTMLSelectElement).value))} data-testid="building-grid">
            {[0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1].map((g) => (
              <option key={g} value={String(g)}>{g < 1 ? `${Math.round(g * 100)} cm` : `${g} m`}</option>
            ))}
          </select>
        </label>
        <label class="bs-toolbar__field">
          {t('Wanddicke', 'Wall thickness')}
          <select value={String(defaultThicknessM)} data-testid="building-wall-thickness-default" onChange={(e): void => setDefaultThicknessM(Number((e.currentTarget as HTMLSelectElement).value))}>
            <option value="0.115">{t('Innenwand 11,5 cm', 'Interior 11.5 cm')}</option>
            <option value="0.175">{t('Innenwand 17,5 cm', 'Interior 17.5 cm')}</option>
            <option value="0.24">{t('Außenwand 24 cm', 'Exterior 24 cm')}</option>
            <option value="0.3">{t('Außenwand 30 cm', 'Exterior 30 cm')}</option>
            <option value="0.365">{t('Außenwand 36,5 cm', 'Exterior 36.5 cm')}</option>
          </select>
        </label>
        <label class="bs-toolbar__field" title={t('Bezugskante der gezeichneten Linie (relativ zur Zeichenrichtung: außen = Gebäude im Uhrzeigersinn umfahren).', 'Reference edge of the traced line (relative to draw direction: outer = trace the building clockwise).')}>
          {t('Bezugskante', 'Reference edge')}
          <select value={wallRef} data-testid="building-wall-ref" onChange={(e): void => setWallRef((e.currentTarget as HTMLSelectElement).value as 'center' | 'outer' | 'inner')}>
            <option value="center">{t('Wandmitte', 'Centre')}</option>
            <option value="outer">{t('Außenkante', 'Outer edge')}</option>
            <option value="inner">{t('Innenkante', 'Inner edge')}</option>
          </select>
        </label>
        <div class="bs-toolbar__group">
          <button type="button" onClick={doUndo} disabled={!canUndo(history)} data-testid="building-undo">↶ {t('Zurück', 'Undo')}</button>
          <button type="button" onClick={doRedo} disabled={!canRedo(history)} data-testid="building-redo">↷ {t('Vor', 'Redo')}</button>
        </div>
        {(tool === 'wall' || tool === 'room') && (
          <button type="button" onClick={commitDraft} disabled={draft.length < (tool === 'wall' ? 2 : 3)} data-testid="building-commit">
            {t('Fertig', 'Finish')} ⏎
          </button>
        )}
        <div class="bs-toolbar__group">
          <button
            type="button"
            data-testid="building-detect-rooms"
            onClick={(): void => {
              const r = suggestRooms(CTX, state);
              if (r.added > 0) {
                commit(r.state);
                setSaveState({ busy: false, msg: t(`${r.added} Raum/Räume erkannt.`, `${r.added} room(s) detected.`) });
              } else {
                setSaveState({ busy: false, msg: t('Keine neuen geschlossenen Räume gefunden.', 'No new enclosed rooms found.') });
              }
            }}
          >
            {t('Räume erkennen', 'Detect rooms')}
          </button>
          {selectedWalls.length > 0 && (
          <Fragment>
          <button
            type="button"
            data-testid="building-split"
            disabled={selectedWalls.length !== 1}
            onClick={(): void => {
              const w = selectedWalls[0];
              if (w !== undefined) commit(splitWall(CTX, state, w.id, midpointOfAxis(w.axis)));
            }}
          >
            {t('Teilen', 'Split')}
          </button>
          <button
            type="button"
            data-testid="building-merge"
            disabled={selectedWalls.length !== 2}
            onClick={(): void => {
              const [a, b] = selectedWalls;
              if (a !== undefined && b !== undefined) commit(mergeWalls(CTX, state, a.id, b.id));
            }}
          >
            {t('Verbinden', 'Merge')}
          </button>
          <button
            type="button"
            data-testid="building-align-x"
            disabled={selectedWalls.length < 1}
            onClick={(): void => commit(alignWalls(state, selectedWalls.map((w) => w.id), 'x'))}
          >
            {t('⇥ X', '⇥ X')}
          </button>
          <button
            type="button"
            data-testid="building-align-y"
            disabled={selectedWalls.length < 1}
            onClick={(): void => commit(alignWalls(state, selectedWalls.map((w) => w.id), 'y'))}
          >
            {t('⇥ Y', '⇥ Y')}
          </button>
          <button
            type="button"
            data-testid="building-extend"
            disabled={selectedWallsOrdered.length !== 2}
            title={t('Erste Wand bis zur zweiten verlängern/kürzen', 'Extend/trim the first wall to the second')}
            onClick={(): void => {
              const [a, b] = selectedWallsOrdered;
              if (a !== undefined && b !== undefined) commit(extendWallToWall(state, a.id, b.id));
            }}
          >
            {t('Verlängern/Kürzen', 'Extend/Trim')}
          </button>
          <label class="bs-toolbar__field">
            {t('Offset (m)', 'Offset (m)')}
            <input
              type="number"
              step={0.01}
              value={offsetDist}
              data-testid="building-offset-dist"
              style={{ width: '70px' }}
              onInput={(e): void => setOffsetDist((e.currentTarget as HTMLInputElement).value)}
            />
          </label>
          <button
            type="button"
            data-testid="building-offset"
            disabled={selectedWalls.length !== 1}
            onClick={(): void => {
              const w = selectedWalls[0];
              const d = Number(offsetDist);
              if (w !== undefined && Number.isFinite(d) && d !== 0) commit(offsetWall(CTX, state, w.id, d));
            }}
          >
            {t('Offset', 'Offset')}
          </button>
          </Fragment>
          )}
        </div>
        <div class="bs-toolbar__group bs-toolbar__group--end">
          <div class="bs-toolbar__group seg" role="group" aria-label={t('Ansicht', 'View')}>
            <button type="button" class={`seg__btn ${!show3d ? 'seg__btn--active' : ''}`} aria-pressed={!show3d} data-testid="building-view-2d" onClick={(): void => setShow3d(false)}>2D</button>
            <button type="button" class={`seg__btn ${show3d ? 'seg__btn--active' : ''}`} aria-pressed={show3d} data-testid="building-toggle-3d" onClick={(): void => setShow3d(true)}>3D</button>
          </div>
          <button type="button" onClick={(): void => { void onSave(); }} disabled={saveState.busy || !dirty} data-testid="building-save">
            {saveState.busy ? t('Speichere…', 'Saving…') : t('Speichern', 'Save')}
          </button>
          <div class="bs-more" ref={moreRef}>
            <button type="button" data-testid="building-more" aria-expanded={moreOpen} aria-haspopup="menu" onClick={(): void => setMoreOpen((v) => !v)}>{t('Mehr', 'More')} ▾</button>
            {moreOpen && (
              <div class="bs-more__menu" role="menu" data-testid="building-more-menu">
                <button type="button" role="menuitem" aria-pressed={showUnderlays} data-testid="building-toggle-underlays" onClick={(): void => { setShowUnderlays((v) => !v); setMoreOpen(false); }}>
                  {t('Unterlagen', 'Underlays')}{storeyUnderlays.length > 0 ? ` (${storeyUnderlays.length})` : ''}
                </button>
                <button type="button" role="menuitem" aria-pressed={showThermal} data-testid="building-toggle-thermal" onClick={(): void => { setShowThermal((v) => !v); setMoreOpen(false); }}>
                  {t('Wärmelast', 'Thermal load')}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  aria-pressed={showHistory}
                  data-testid="building-toggle-history"
                  onClick={(): void => { setShowHistory((v) => !v); void loadHistory().then(setRevisions).catch(() => setRevisions([])); setMoreOpen(false); }}
                >
                  {t('Verlauf', 'History')}
                </button>
                <button type="button" role="menuitem" data-testid="building-reload" disabled={saveState.busy} onClick={(): void => { onReload(); setMoreOpen(false); }}>{t('Neu laden', 'Reload')}</button>
                <div class="bs-more__sep" role="separator" />
                <button
                  type="button"
                  role="menuitem"
                  data-testid="building-export"
                  onClick={(): void => {
                    setMoreOpen(false);
                    void (async (): Promise<void> => {
                      try {
                        const res = await fetch('/api/building/export');
                        if (!res.ok) { setSaveState({ busy: false, msg: `HTTP ${res.status}` }); return; }
                        const text = await res.text();
                        const blob = new Blob([text], { type: 'application/json' });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = `heatshield-building-rev${model.revision}.json`;
                        document.body.appendChild(a);
                        a.click();
                        a.remove();
                        URL.revokeObjectURL(url);
                        setSaveState({ busy: false, msg: t('Exportiert.', 'Exported.') });
                      } catch (err) {
                        setSaveState({ busy: false, msg: err instanceof Error ? err.message : 'export failed' });
                      }
                    })();
                  }}
                >
                  {t('Export JSON', 'Export JSON')}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  data-testid="building-export-glb"
                  onClick={(): void => {
                    setMoreOpen(false);
                    void (async (): Promise<void> => {
                      try {
                        const res = await fetch('/api/building/export/glb');
                        if (!res.ok) { setSaveState({ busy: false, msg: `HTTP ${res.status}` }); return; }
                        const blob = await res.blob();
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = `heatshield-building-rev${model.revision}.glb`;
                        document.body.appendChild(a);
                        a.click();
                        a.remove();
                        URL.revokeObjectURL(url);
                        setSaveState({ busy: false, msg: t('3D-Modell (GLB) exportiert.', '3D model (GLB) exported.') });
                      } catch (err) {
                        setSaveState({ busy: false, msg: err instanceof Error ? err.message : 'GLB export failed' });
                      }
                    })();
                  }}
                >
                  {t('Export GLB (3D)', 'Export GLB (3D)')}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  data-testid="building-export-png"
                  onClick={(): void => {
                    setMoreOpen(false);
                    const svg = svgRef.current;
                    if (svg === null) { setSaveState({ busy: false, msg: t('Keine Zeichenfläche.', 'No canvas.') }); return; }
                    void (async (): Promise<void> => {
                      try {
                        const rect = svg.getBoundingClientRect();
                        const width = Math.round(rect.width) || 900;
                        const height = Math.round(rect.height) || 600;
                        // Underlays are excluded by default so the PNG never leaks a
                        // source floor-plan/scan (Phase 5: "without source underlays").
                        await exportSvgAsPng(svg, `heatshield-plan-rev${model.revision}.png`, { width, height, includeUnderlays: false });
                        setSaveState({ busy: false, msg: t('Grundriss als PNG exportiert.', 'Floor plan exported as PNG.') });
                      } catch (err) {
                        setSaveState({ busy: false, msg: err instanceof Error ? err.message : 'PNG export failed' });
                      }
                    })();
                  }}
                >
                  {t('Export PNG', 'Export PNG')}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
      {saveState.msg !== null && <p class="module-panel__hint" data-testid="building-save-msg">{saveState.msg}</p>}

      {staleRemotely && (
        <div class="bs-stale" role="status" data-testid="building-stale-banner">
          <span class="bs-stale__text">
            {dirty
              ? t(
                  `Das Modell wurde an anderer Stelle auf Rev. ${latestRev ?? 0} geändert. „Neu laden" verwirft deine lokalen Änderungen.`,
                  `The model changed elsewhere to rev. ${latestRev ?? 0}. “Reload” discards your local changes.`,
                )
              : t(
                  `Das Modell wurde an anderer Stelle auf Rev. ${latestRev ?? 0} geändert.`,
                  `The model changed elsewhere to rev. ${latestRev ?? 0}.`,
                )}
          </span>
          <button
            type="button"
            class="bs-stale__btn"
            data-testid="building-stale-reload"
            disabled={saveState.busy}
            onClick={onReload}
          >
            {t('Neu laden', 'Reload')}
          </button>
        </div>
      )}

      <div class="bs-layout">
        <aside class="bs-tree" data-testid="building-storeys" aria-label={t('Stockwerke', 'Storeys')}>
          <div class="bs-tree__head">
            <span>{t('Stockwerke', 'Storeys')}</span>
            <div class="bs-tree__head-actions">
              <button
                type="button"
                data-testid="building-duplicate-storey"
                title={t('Aktives Stockwerk nach oben duplizieren (gleiche Wände)', 'Duplicate active storey upward (same walls)')}
                onClick={(): void => commit(duplicateStorey(CTX, state, storey.id, 'up'))}
              >⧉↑</button>
              <button
                type="button"
                data-testid="building-duplicate-storey-down"
                title={t('Aktives Stockwerk nach unten duplizieren (Richtung Keller)', 'Duplicate active storey downward (toward basement)')}
                onClick={(): void => commit(duplicateStorey(CTX, state, storey.id, 'down'))}
              >⧉↓</button>
              <button
                type="button"
                class={`bs-danger${armDeleteStorey ? ' bs-danger--armed' : ''}`}
                data-testid="building-delete-storey"
                title={armDeleteStorey
                  ? t(`Stockwerk „${storey.name}" wirklich löschen? Nochmal klicken.`, `Really delete storey “${storey.name}”? Click again.`)
                  : t('Aktives Stockwerk löschen', 'Delete active storey')}
                disabled={model.storeys.length <= 1}
                onClick={(): void => {
                  if (armDeleteStorey) {
                    commit(removeStorey(state, storey.id));
                    setArmDeleteStorey(false);
                  } else {
                    setArmDeleteStorey(true);
                  }
                }}
              >{armDeleteStorey ? t('Löschen?', 'Delete?') : '🗑'}</button>
              {armDeleteStorey && (
                <button
                  type="button"
                  data-testid="building-delete-storey-cancel"
                  title={t('Abbrechen', 'Cancel')}
                  onClick={(): void => setArmDeleteStorey(false)}
                >✕</button>
              )}
              <button
                type="button"
                data-testid="building-add-basement"
                title={t('Keller hinzufügen (unter dem Erdgeschoss)', 'Add basement (below ground floor)')}
                onClick={(): void => {
                  const bottom = Math.min(...model.storeys.map((s) => s.elevationM), 0);
                  const h = 2.5;
                  commit(addStorey(CTX, state, { name: t('Keller', 'Basement'), elevationM: bottom - h, heightM: h }));
                }}
              >＋ KG</button>
              <button
                type="button"
                data-testid="building-add-storey"
                title={t('Stockwerk hinzufügen (darüber)', 'Add storey (above)')}
                onClick={(): void => {
                  const top = Math.max(...model.storeys.map((s) => s.elevationM + s.heightM), 0);
                  commit(addStorey(CTX, state, { name: t(`Etage ${model.storeys.length + 1}`, `Floor ${model.storeys.length + 1}`), elevationM: top, heightM: 2.5 }));
                }}
              >＋</button>
            </div>
          </div>
          <ul>
            {model.storeys.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  class={`bs-tree__item ${s.id === state.activeStoreyId ? 'bs-tree__item--active' : ''}`}
                  data-testid={`building-storey-${s.id}`}
                  onClick={(): void => transient(setActiveStorey(state, s.id))}
                >
                  <span>{s.name}</span>
                  <small>{t(`${s.walls.length} Wände · ${s.spaces.length} Räume`, `${s.walls.length} walls · ${s.spaces.length} rooms`)}</small>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <div class="bs-canvas-wrap">
          {show3d ? (
            <div class="bs-canvas bs-canvas--3d" data-testid="building-canvas-3d">
              <Twin3D model={model} roomStates={roomOverlays} />
            </div>
          ) : (
          <Fragment>
          <svg
            ref={svgRef}
            class="bs-canvas"
            data-testid="building-canvas"
            role="img"
            aria-label={t('Grundriss-Zeichenfläche', 'Floor-plan canvas')}
            onPointerDown={onPointerDown as unknown as JSX.PointerEventHandler<SVGSVGElement>}
            onPointerMove={onPointerMove as unknown as JSX.PointerEventHandler<SVGSVGElement>}
            onPointerUp={onPointerUp as unknown as JSX.PointerEventHandler<SVGSVGElement>}
            onWheel={onWheel as unknown as JSX.WheelEventHandler<SVGSVGElement>}
          >
            <UnderlayLayer underlays={storeyUnderlays} view={view} override={underlayOverride} />
            <GridLayer view={view} gridM={gridM} />
            {storey.spaces.map((sp) => {
              const pts = sp.polygon.map((p) => { const s = toScreen(p, view); return `${s.sx},${s.sy}`; }).join(' ');
              const selected = state.selection.includes(sp.id);
              return <polygon key={sp.id} points={pts} class={`bs-space ${selected ? 'bs-space--sel' : ''}`} data-testid={`building-space-${sp.id}`} />;
            })}
            {storey.walls.map((w) => <WallShape key={w.id} wall={w} view={view} selected={state.selection.includes(w.id)} openings={storey.openings.filter((o) => o.hostWallId === w.id)} />)}
            <OpeningLayer storey={storey} view={view} selection={state.selection} />
            {openingPlace !== null && (() => {
              const wall = storey.walls.find((w) => w.id === openingPlace.wallId);
              if (wall === undefined) return null;
              const wallLen = segmentLength(wall.axis);
              const projS = cursor !== null ? Math.max(0, Math.min(wallLen, projectPointToPolyline(wall.axis, cursor))) : null;
              const half = wall.thicknessM / 2;
              const marks: JSX.Element[] = [];
              const tick = (s: number, key: string): void => {
                const a = pointAlongPolyline(wall.axis, s);
                if (a === null) return;
                const nx = -a.ty * half;
                const ny = a.tx * half;
                const p1 = toScreen({ x: a.p.x + nx, y: a.p.y + ny }, view);
                const p2 = toScreen({ x: a.p.x - nx, y: a.p.y - ny }, view);
                marks.push(<line key={key} x1={p1.sx} y1={p1.sy} x2={p2.sx} y2={p2.sy} class="bs-place-tick" />);
              };
              if (openingPlace.s0 !== null) tick(openingPlace.s0, 's0');
              if (projS !== null) tick(projS, 'cur');
              if (openingPlace.s0 !== null && projS !== null) {
                const a = pointAlongPolyline(wall.axis, openingPlace.s0);
                const b = pointAlongPolyline(wall.axis, projS);
                if (a !== null && b !== null) {
                  const pa = toScreen(a.p, view);
                  const pb = toScreen(b.p, view);
                  marks.push(<line key="band" x1={pa.sx} y1={pa.sy} x2={pb.sx} y2={pb.sy} class="bs-place-band" />);
                }
              }
              return <g data-testid="building-opening-preview">{marks}</g>;
            })()}
            {storey.spaces.map((sp) => {
              const c = toScreen(spaceCentroid(sp.polygon), view);
              return (
                <text key={`lbl-${sp.id}`} x={c.sx} y={c.sy} class="bs-space-label" text-anchor="middle" data-testid={`building-space-label-${sp.id}`}>
                  <tspan x={c.sx} dy="-0.2em">{sp.name}</tspan>
                  <tspan x={c.sx} dy="1.2em" class="bs-space-label__area">{polygonArea(sp.polygon).toFixed(1)} m²</tspan>
                </text>
              );
            })}
            {tool === 'select' && storey.walls.filter((w) => state.selection.includes(w.id)).map((w) => (
              w.axis.map((p, i) => { const s = toScreen(p, view); return <circle key={`vh-${w.id}-${i}`} cx={s.sx} cy={s.sy} r={5} class="bs-vertex" data-testid={`building-vertex-wall-${w.id}-${i}`} />; })
            ))}
            {tool === 'select' && storey.spaces.filter((sp) => state.selection.includes(sp.id)).map((sp) => (
              sp.polygon.map((p, i) => { const s = toScreen(p, view); return <circle key={`vs-${sp.id}-${i}`} cx={s.sx} cy={s.sy} r={5} class="bs-vertex" data-testid={`building-vertex-space-${sp.id}-${i}`} />; })
            ))}
            {draft.length > 0 && <DraftShape draft={draft} cursor={cursor} view={view} tool={tool} />}
            {cursor !== null && <CursorDot point={cursor} view={view} />}
            {tool === 'calibrate' && calibPoints.map((p, i) => {
              const s = toScreen(p, view);
              return <circle key={i} cx={s.sx} cy={s.sy} r={5} class="bs-calib-pt" data-testid={`building-calib-pt-${i}`} />;
            })}
            {tool === 'calibrate' && calibPoints.length === 2 && (() => {
              const a = toScreen(calibPoints[0] as Point, view);
              const b = toScreen(calibPoints[1] as Point, view);
              return <line x1={a.sx} y1={a.sy} x2={b.sx} y2={b.sy} class="bs-calib-line" />;
            })()}
            {tool === 'crop' && cropPoints.length > 0 && (() => {
              const scr = cropPoints.map((p) => toScreen(p, view));
              const poly = scr.map((s) => `${s.sx},${s.sy}`).join(' ');
              return (
                <Fragment>
                  {cropPoints.length >= 2 && <polygon points={poly} class="bs-crop-poly" />}
                  {scr.map((s, i) => <circle key={i} cx={s.sx} cy={s.sy} r={5} class="bs-crop-pt" data-testid={`building-crop-pt-${i}`} />)}
                </Fragment>
              );
            })()}
          </svg>
          <div class="bs-readout" data-testid="building-readout">
            {cursor !== null && <span>x {cursor.x.toFixed(2)} m · y {cursor.y.toFixed(2)} m</span>}
            {openingPlace !== null && (
              <span data-testid="building-place-hint"> · {openingPlace.s0 === null
                ? t('Öffnung: Startpunkt auf der Wand klicken (Esc bricht ab)', 'Opening: click the start point on the wall (Esc cancels)')
                : (() => {
                    const wall = storey.walls.find((w) => w.id === openingPlace.wallId);
                    const projS = wall !== undefined && cursor !== null ? Math.max(0, Math.min(segmentLength(wall.axis), projectPointToPolyline(wall.axis, cursor))) : null;
                    const w = projS !== null && openingPlace.s0 !== null ? Math.abs(projS - openingPlace.s0) : 0;
                    return t(`Endpunkt klicken · Breite ${w.toFixed(2)} m`, `Click the end · width ${w.toFixed(2)} m`);
                  })()}</span>
            )}
            {tool === 'wall' && (
              <span> · {t('Dicke', 'Thickness')} {defaultThicknessM.toFixed(3)} m</span>
            )}
            {draft.length >= 2 && tool === 'wall' && (
              <span> · {t('Länge', 'Length')} {segmentLength(draft).toFixed(2)} m · {headingDeg(draft[draft.length - 2] as Point, draft[draft.length - 1] as Point).toFixed(0)}° · {t('Startpunkt anklicken zum Schließen', 'Click the start point to close')}</span>
            )}
            {draft.length >= 3 && tool === 'room' && (
              <span> · {t('Fläche', 'Area')} {polygonArea(draft).toFixed(1)} m² · {t('Startpunkt anklicken zum Schließen', 'Click the start point to close')}</span>
            )}
            {tool === 'select' && (selectedWall !== null || storey.spaces.some((sp) => state.selection.includes(sp.id))) && (
              <span> · {t('Punkt ziehen = verschieben · Alt+Klick = Punkt löschen', 'Drag a point = move · Alt-click = delete point')}</span>
            )}
          </div>
          </Fragment>
          )}
        </div>

        <aside class="bs-inspector" data-testid="building-inspector" aria-label={t('Eigenschaften', 'Properties')}>
          {selectedWall !== null ? (
            <WallInspector
              wall={selectedWall}
              onPatch={(patch): void => commit(updateWall(state, selectedWall.id, patch))}
              onDelete={(): void => commit(deleteWall(state, selectedWall.id))}
              onAddOpening={(type): void => { setOpeningPlace({ type, wallId: selectedWall.id, s0: null }); }}
              openings={storey.openings.filter((o) => o.hostWallId === selectedWall.id)}
              configWindows={configWindows}
              onUpdateOpening={(id, patch): void => commit(updateOpening(state, id, patch))}
              onDeleteOpening={(id): void => commit(deleteOpening(state, id))}
            />
          ) : (
            <Fragment>
              <StoreyInspector
                storey={storey}
                canDelete={model.storeys.length > 1}
                onPatch={(patch): void => commit(updateStorey(state, storey.id, patch))}
                onDelete={(): void => commit(removeStorey(state, storey.id))}
              />
              <RoomList
                spaces={storey.spaces}
                selection={state.selection}
                configRooms={configRooms}
                onRename={(id, name): void => commit(updateSpace(state, id, { name }))}
                onSelect={(id): void => transient(setSelection(state, [id]))}
                onDelete={(id): void => commit(deleteSpace(state, id))}
                onLinkRoom={(id, roomId): void => commit(updateSpace(state, id, { linkedRoomId: roomId }))}
              />
              <RoofInspector
                roof={model.roofs.find((r) => r.storeyId === storey.id) ?? null}
                section={(() => {
                  const rf = model.roofs.find((r) => r.storeyId === storey.id) ?? null;
                  return rf === null ? null : roofSectionProfile(state, rf.id);
                })()}
                onAdd={(input): void => commit(addRoof(CTX, state, { ...input, storeyId: storey.id }))}
                onPatch={(id, patch): void => commit(updateRoof(state, id, patch))}
                onDelete={(id): void => commit(removeRoof(state, id))}
                roofWindows={(() => {
                  const rf = model.roofs.find((r) => r.storeyId === storey.id) ?? null;
                  return rf === null ? [] : storey.openings.filter((o) => o.roofWindow === true && o.hostRoofId === rf.id);
                })()}
                onAddRoofWindow={(): void => {
                  const rf = model.roofs.find((r) => r.storeyId === storey.id) ?? null;
                  if (rf !== null) commit(addRoofWindow(CTX, state, { roofId: rf.id }));
                }}
                onUpdateRoofWindow={(id, patch): void => commit(updateOpening(state, id, patch))}
                onDeleteRoofWindow={(id): void => commit(deleteOpening(state, id))}
              />
              {(() => {
                const roof = model.roofs.find((r) => r.storeyId === storey.id) ?? null;
                if (roof === null) return null;
                const plane = roofPlaneInfo(state, roof.id);
                const arrays = model.pvArrays.filter((p) => p.roofFaceId.startsWith(roof.id));
                return (
                  <PvInspector
                    plane={plane}
                    arrays={arrays}
                    onAdd={(): void => {
                      const mw = 1.7;
                      const mh = 1.0;
                      const gap = 0.02;
                      const fit = plane === null ? { rows: 1, columns: 1 } : pvAutoFit(plane.widthM, plane.depthM, mw, mh, gap, 0.3);
                      commit(addPvArray(CTX, state, { roofId: roof.id, moduleWidthM: mw, moduleHeightM: mh, gapM: gap, rows: Math.max(1, fit.rows), columns: Math.max(1, fit.columns) }));
                    }}
                    onAutoFit={(id): void => {
                      const pv = arrays.find((p) => p.id === id);
                      if (pv === undefined || plane === null) return;
                      const fit = pvAutoFit(plane.widthM, plane.depthM, pv.moduleWidthM, pv.moduleHeightM, pv.gapM ?? 0.02, 0.3);
                      commit(updatePvArray(state, id, { rows: Math.max(1, fit.rows), columns: Math.max(1, fit.columns) }));
                    }}
                    onPatch={(id, patch): void => commit(updatePvArray(state, id, patch))}
                    onDelete={(id): void => commit(removePvArray(state, id))}
                  />
                );
              })()}
            </Fragment>
          )}
          <ValidationPanel validation={validation} onSelect={(id): void => transient(setSelection(state, [id]))} />
        </aside>
      </div>

      {tool === 'calibrate' && calibratingId !== null && (
        <div class="bs-calib-bar" data-testid="building-calib-bar">
          <span>
            {calibPoints.length < 2
              ? t(`Punkt ${calibPoints.length + 1}/2 auf der Unterlage anklicken …`, `Click point ${calibPoints.length + 1}/2 on the underlay …`)
              : t('Reale Distanz zwischen den zwei Punkten (m):', 'Real distance between the two points (m):')}
          </span>
          {calibPoints.length === 2 && (
            <Fragment>
              <input
                type="number"
                step={0.01}
                min={0.01}
                value={calibDist}
                data-testid="building-calib-dist"
                style={{ width: '90px' }}
                onInput={(e): void => setCalibDist((e.currentTarget as HTMLInputElement).value)}
              />
              <button type="button" data-testid="building-calib-apply" onClick={applyCalibration}>{t('Übernehmen', 'Apply')}</button>
            </Fragment>
          )}
          <button type="button" data-testid="building-calib-cancel" onClick={(): void => { setCalibratingId(null); setCalibPoints([]); setTool('select'); }}>
            {t('Abbrechen', 'Cancel')}
          </button>
        </div>
      )}

      {tool === 'crop' && croppingId !== null && (
        <div class="bs-calib-bar" data-testid="building-crop-bar">
          <span>
            {t(`Zuschnitt: ${cropPoints.length} Punkt(e) — mind. 3.`, `Crop: ${cropPoints.length} point(s) — min. 3.`)}
          </span>
          <button type="button" data-testid="building-crop-apply" disabled={cropPoints.length < 3} onClick={applyCrop}>{t('Anwenden', 'Apply')}</button>
          <button type="button" data-testid="building-crop-undo" disabled={cropPoints.length === 0} onClick={(): void => setCropPoints((pts) => pts.slice(0, -1))}>{t('Punkt zurück', 'Undo point')}</button>
          <button type="button" data-testid="building-crop-cancel" onClick={cancelCrop}>{t('Abbrechen', 'Cancel')}</button>
        </div>
      )}

      {tool === 'moveUnderlay' && movingUnderlayId !== null && (
        <div class="bs-calib-bar" data-testid="building-move-bar">
          <span>{t('Unterlage ziehen zum Verschieben, dann loslassen.', 'Drag the underlay to move it, then release.')}</span>
          <button type="button" data-testid="building-move-cancel" onClick={(): void => { underlayDragRef.current = null; setUnderlayOverride(null); setMovingUnderlayId(null); setTool('select'); }}>{t('Fertig', 'Done')}</button>
        </div>
      )}

      {showUnderlays && (
        <UnderlayPanel
          storeyId={storey.id}
          underlays={storeyUnderlays}
          onUploaded={refreshUnderlays}
          onPatch={(id, patch): void => { void patchUnderlay(id, patch).then(refreshUnderlays); }}
          onDelete={(id): void => { void removeUnderlay(id).then(refreshUnderlays); }}
          onCalibrate={startCalibration}
          onCrop={startCrop}
          onClearCrop={clearCrop}
          onMove={startMoveUnderlay}
        />
      )}

      {showThermal && <ThermalPanel model={model} />}

      {showHistory && (
        <section class="bs-underlays" data-testid="building-history">
          <div class="bs-underlays__head">
            <strong>{t('Versionsverlauf', 'Revision history')}</strong>
            <span class="module-panel__hint">{t('Frühere Stände als neue Revision wiederherstellen.', 'Restore a past state as a new revision.')}</span>
          </div>
          {revisions.length === 0 ? (
            <p class="module-panel__hint" data-testid="building-history-empty">{t('Noch keine gespeicherten Revisionen.', 'No saved revisions yet.')}</p>
          ) : (
            <ul class="bs-underlays__list">
              {revisions.map((r) => (
                <li key={r.revision} class="bs-underlays__item" data-testid={`building-history-${r.revision}`}>
                  <div class="bs-underlays__row">
                    <span><strong>{t(`Rev. ${r.revision}`, `Rev. ${r.revision}`)}</strong> · <small>{r.savedAt.slice(0, 19).replace('T', ' ')}</small> · <code>{r.contentHash.slice(0, 8)}</code></span>
                    <button
                      type="button"
                      data-testid={`building-history-restore-${r.revision}`}
                      disabled={r.revision === model.revision}
                      onClick={(): void => {
                        void restoreRevision(r.revision).then((ok) => {
                          if (ok) {
                            onReload();
                            void loadHistory().then(setRevisions).catch(() => undefined);
                            setSaveState({ busy: false, msg: t(`Rev. ${r.revision} als neue Revision wiederhergestellt.`, `Rev. ${r.revision} restored as a new revision.`) });
                          }
                        });
                      }}
                    >
                      {t('Wiederherstellen', 'Restore')}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Hit test (nearest wall within tolerance).
// ---------------------------------------------------------------------------

function hitTestWall(storey: Storey | null, m: Point, view: View): string | null {
  if (storey === null) return null;
  const tolM = 10 / view.scale; // ~10px tolerance in metres
  let best: { id: string; d: number } | null = null;
  for (const w of storey.walls) {
    for (let i = 1; i < w.axis.length; i += 1) {
      const d = distToSegment(m, w.axis[i - 1] as Point, w.axis[i] as Point);
      if (d <= tolM && (best === null || d < best.d)) best = { id: w.id, d };
    }
  }
  return best?.id ?? null;
}

/**
 * Hit-test the vertex handles of the currently selected wall(s)/space(s). Only
 * selected elements expose draggable handles, so we test just those. Returns
 * the nearest handle within ~11px, or null.
 */
function hitTestVertex(
  storey: Storey | null,
  selection: string[],
  m: Point,
  view: View,
): { kind: 'wall' | 'space'; id: string; index: number } | null {
  if (storey === null) return null;
  const tolM = 11 / view.scale;
  const cands: Array<{ kind: 'wall' | 'space'; id: string; index: number; d: number }> = [];
  for (const w of storey.walls) {
    if (!selection.includes(w.id)) continue;
    w.axis.forEach((p, i) => { const d = Math.hypot(p.x - m.x, p.y - m.y); if (d <= tolM) cands.push({ kind: 'wall', id: w.id, index: i, d }); });
  }
  for (const sp of storey.spaces) {
    if (!selection.includes(sp.id)) continue;
    sp.polygon.forEach((p, i) => { const d = Math.hypot(p.x - m.x, p.y - m.y); if (d <= tolM) cands.push({ kind: 'space', id: sp.id, index: i, d }); });
  }
  if (cands.length === 0) return null;
  const b = cands.reduce((acc, c) => (c.d < acc.d ? c : acc));
  return { kind: b.kind, id: b.id, index: b.index };
}

/**
 * Hit-test opening endpoint handles. Handles are shown (and thus draggable)
 * only for openings whose host wall is selected. Returns the nearest endpoint
 * within ~11px, or null.
 */
function hitTestOpeningHandle(
  storey: Storey | null,
  selection: string[],
  m: Point,
  view: View,
): { id: string; end: 'start' | 'end' } | null {
  if (storey === null) return null;
  const tolM = 11 / view.scale;
  const cands: Array<{ id: string; end: 'start' | 'end'; d: number }> = [];
  for (const o of storey.openings) {
    if (o.hostWallId === undefined) continue; // roof windows aren't wall-dragged
    if (!selection.includes(o.hostWallId) && !selection.includes(o.id)) continue;
    const wall = storey.walls.find((w) => w.id === o.hostWallId);
    if (wall === undefined) continue;
    const a = pointAlongPolyline(wall.axis, o.offsetM);
    const b = pointAlongPolyline(wall.axis, o.offsetM + o.widthM);
    if (a !== null) { const d = Math.hypot(a.p.x - m.x, a.p.y - m.y); if (d <= tolM) cands.push({ id: o.id, end: 'start', d }); }
    if (b !== null) { const d = Math.hypot(b.p.x - m.x, b.p.y - m.y); if (d <= tolM) cands.push({ id: o.id, end: 'end', d }); }
  }
  if (cands.length === 0) return null;
  const best = cands.reduce((acc, c) => (c.d < acc.d ? c : acc));
  return { id: best.id, end: best.end };
}

function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let tt = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  tt = Math.max(0, Math.min(1, tt));
  return Math.hypot(p.x - (a.x + tt * dx), p.y - (a.y + tt * dy));
}

/** Point at half the total polyline length — used for a one-click split. */
function midpointOfAxis(axis: Point[]): Point {
  const total = segmentLength(axis);
  if (total === 0 || axis.length < 2) return axis[0] as Point;
  let target = total / 2;
  for (let i = 1; i < axis.length; i += 1) {
    const a = axis[i - 1] as Point;
    const b = axis[i] as Point;
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    if (segLen >= target) {
      const tt = segLen === 0 ? 0 : target / segLen;
      return { x: a.x + (b.x - a.x) * tt, y: a.y + (b.y - a.y) * tt };
    }
    target -= segLen;
  }
  return axis[axis.length - 1] as Point;
}

// ---------------------------------------------------------------------------
// SVG sub-components.
// ---------------------------------------------------------------------------

function GridLayer(props: { view: View; gridM: number }): JSX.Element {
  const { view, gridM } = props;
  const lines: JSX.Element[] = [];
  const stepPx = gridM * view.scale;
  if (stepPx >= 6) {
    const w = 1200;
    const hgt = 700;
    const startX = view.offsetX % stepPx;
    const startY = view.offsetY % stepPx;
    for (let x = startX; x < w; x += stepPx) lines.push(<line key={`x${x}`} x1={x} y1={0} x2={x} y2={hgt} class="bs-grid-line" />);
    for (let y = startY; y < hgt; y += stepPx) lines.push(<line key={`y${y}`} x1={0} y1={y} x2={w} y2={y} class="bs-grid-line" />);
  }
  // Origin axes.
  lines.push(<line key="ax" x1={0} y1={view.offsetY} x2={1200} y2={view.offsetY} class="bs-axis" />);
  lines.push(<line key="ay" x1={view.offsetX} y1={0} x2={view.offsetX} y2={700} class="bs-axis" />);
  return <g>{lines}</g>;
}

function WallShape(props: { wall: Wall; view: View; selected: boolean; openings: Opening[] }): JSX.Element {
  // Filled wall body: each segment becomes a rectangle offset by ±thickness/2,
  // so the inner + outer faces and the fill are all visible (real floor-plan
  // look). Corners overlap and merge visually. The centre line + vertex handles
  // (drawn elsewhere when selected) stay on the axis for editing. Openings
  // (doors/windows/passages) are cut out as real notches (holes) rather than
  // painted over the wall.
  const holes = props.openings
    .map((o): [number, number] => [o.offsetM, o.offsetM + o.widthM])
    .sort((x, y) => x[0] - y[0]);
  const quads = wallSolidQuads(props.wall.axis, props.wall.thicknessM, holes, props.view);
  const centre = props.wall.axis.map((p) => { const s = toScreen(p, props.view); return `${s.sx},${s.sy}`; }).join(' ');
  return (
    <g data-testid={`building-wall-${props.wall.id}`}>
      {quads.map((q, i) => (
        <polygon key={i} points={q} class={`bs-wall-body ${props.selected ? 'bs-wall-body--sel' : ''}`} />
      ))}
      <polyline points={centre} class="bs-wall-centre" />
    </g>
  );
}

function DraftShape(props: { draft: Point[]; cursor: Point | null; view: View; tool: Tool }): JSX.Element {
  const all = props.cursor !== null ? [...props.draft, props.cursor] : props.draft;
  const pts = all.map((p) => { const s = toScreen(p, props.view); return `${s.sx},${s.sy}`; }).join(' ');
  return (
    <Fragment>
      <polyline points={pts} class="bs-draft" />
      {props.draft.map((p, i) => { const s = toScreen(p, props.view); return <circle key={i} cx={s.sx} cy={s.sy} r={3} class="bs-draft-node" />; })}
    </Fragment>
  );
}

function CursorDot(props: { point: Point; view: View }): JSX.Element {
  const s = toScreen(props.point, props.view);
  return <circle cx={s.sx} cy={s.sy} r={4} class="bs-cursor" />;
}

/**
 * Render hosted openings as architectural symbols drawn INSIDE the wall cutout
 * (the wall body itself is notched out by `wallSolidQuads`). All types get the
 * two jamb lines (Laibungen) closing the gap across the wall faces. Windows add
 * the two face lines + a centre glass line; doors add a leaf line + swing arc;
 * passages stay an open gap (faint jambs only). When the host wall (or the
 * opening) is selected the two endpoints show as draggable handles.
 */
function OpeningLayer(props: { storey: Storey; view: View; selection: string[] }): JSX.Element {
  const { storey, view } = props;
  return (
    <g data-testid="building-opening-layer">
      {storey.openings.map((o) => {
        const wall = storey.walls.find((w) => w.id === o.hostWallId);
        if (wall === undefined) return null;
        const a = pointAlongPolyline(wall.axis, o.offsetM);
        const b = pointAlongPolyline(wall.axis, o.offsetM + o.widthM);
        if (a === null || b === null) return null;
        const half = wall.thicknessM / 2;
        // Unit normal of the wall at the opening start.
        const un = { x: -a.ty, y: a.tx };
        const nx = un.x * half;
        const ny = un.y * half;
        // Jamb / face corner points (model space).
        const aN = { x: a.p.x + nx, y: a.p.y + ny };
        const aS = { x: a.p.x - nx, y: a.p.y - ny };
        const bN = { x: b.p.x + nx, y: b.p.y + ny };
        const bS = { x: b.p.x - nx, y: b.p.y - ny };
        const toS = (pt: Point): { sx: number; sy: number } => toScreen(pt, view);
        const sel = props.selection.includes(o.id);
        const showHandles = props.selection.includes(wall.id) || sel;
        const isDoor = o.type === 'door';
        const isPassage = o.type === 'passage';
        const isRoof = o.roofWindow === true;
        const kind = isDoor
          ? 'bs-opening-door'
          : isPassage
            ? 'bs-opening-passage'
            : isRoof
              ? 'bs-opening-roofwin'
              : 'bs-opening-win';
        const sAN = toS(aN);
        const sAS = toS(aS);
        const sBN = toS(bN);
        const sBS = toS(bS);
        // Door leaf + swing arc: hinge at the aS face corner, leaf swings into
        // the room (+normal side) at 90°, radius = opening width.
        const leafTip = { x: aS.x + un.x * o.widthM, y: aS.y + un.y * o.widthM };
        const sHinge = toS(aS);
        const sLeaf = toS(leafTip);
        const rPx = o.widthM * view.scale;
        const arc = `M ${sLeaf.sx} ${sLeaf.sy} A ${rPx} ${rPx} 0 0 1 ${sBS.sx} ${sBS.sy}`;
        const sa = toScreen(a.p, view);
        const sb = toScreen(b.p, view);
        return (
          <Fragment key={o.id}>
            <g class={`bs-opening ${kind}${sel ? ' bs-opening--sel' : ''}`} data-testid={`building-opening-shape-${o.id}`}>
              {/* Jamb lines close the cutout across the two wall faces. */}
              <line x1={sAN.sx} y1={sAN.sy} x2={sAS.sx} y2={sAS.sy} class="bs-opening-jamb" />
              <line x1={sBN.sx} y1={sBN.sy} x2={sBS.sx} y2={sBS.sy} class="bs-opening-jamb" />
              {!isPassage && !isDoor && (
                <Fragment>
                  {/* Window: outer + inner face lines + centre glass line. */}
                  <line x1={sAN.sx} y1={sAN.sy} x2={sBN.sx} y2={sBN.sy} class="bs-opening-face" />
                  <line x1={sAS.sx} y1={sAS.sy} x2={sBS.sx} y2={sBS.sy} class="bs-opening-face" />
                  <line x1={sa.sx} y1={sa.sy} x2={sb.sx} y2={sb.sy} class="bs-opening-glass" />
                </Fragment>
              )}
              {isDoor && (
                <Fragment>
                  {/* Door: leaf line from hinge + quarter-circle swing arc. */}
                  <line x1={sHinge.sx} y1={sHinge.sy} x2={sLeaf.sx} y2={sLeaf.sy} class="bs-opening-leaf" />
                  <path d={arc} class="bs-opening-swing" fill="none" />
                </Fragment>
              )}
            </g>
            {showHandles && <circle cx={sa.sx} cy={sa.sy} r={5} class="bs-opening-handle" data-testid={`building-opening-handle-${o.id}-start`} />}
            {showHandles && <circle cx={sb.sx} cy={sb.sy} r={5} class="bs-opening-handle" data-testid={`building-opening-handle-${o.id}-end`} />}
          </Fragment>
        );
      })}
    </g>
  );
}

/**
 * Render visible underlays as transformed SVG images behind the grid. The
 * matrix maps image pixels (y-down) → screen via the underlay's calibration
 * (metres-per-pixel), rotation and model offset, composed with the view.
 */
function UnderlayLayer(props: { underlays: UnderlayMeta[]; view: View; override?: { id: string; offsetXM: number; offsetYM: number } | null }): JSX.Element {
  const { view } = props;
  return (
    <g data-testid="building-underlay-layer">
      {props.underlays
        .filter((u) => u.visible)
        .map((u) => {
          const mpp = effectiveMpp(u);
          const rad = (u.rotationDeg * Math.PI) / 180;
          const cos = Math.cos(rad);
          const sin = Math.sin(rad);
          const sm = view.scale * mpp;
          const a = sm * cos;
          const b = -sm * sin;
          const c = sm * sin;
          const d = sm * cos;
          // Live drag override (move tool) takes precedence over the stored offset.
          const offX = props.override != null && props.override.id === u.id ? props.override.offsetXM : u.offsetXM;
          const offY = props.override != null && props.override.id === u.id ? props.override.offsetYM : u.offsetYM;
          const e = offX * view.scale + view.offsetX;
          const f = -offY * view.scale + view.offsetY;
          // Freeform crop → clip the image to the polygon. objectBoundingBox
          // units let us feed the normalised [0,1] crop fractions directly.
          const cropped = hasCrop(u);
          const clipId = `bs-underlay-clip-${u.id}`;
          const imgStyle: JSX.CSSProperties = {
            opacity: u.opacityPct / 100,
            filter: `contrast(${u.contrastPct}%)`,
            pointerEvents: 'none',
          };
          if (cropped) imgStyle.clipPath = `url(#${clipId})`;
          return (
            <Fragment key={u.id}>
              {cropped && (
                <clipPath id={clipId} clipPathUnits="objectBoundingBox" data-testid={`building-underlay-clip-${u.id}`}>
                  <polygon points={(u.crop ?? []).map((p) => `${p.x},${p.y}`).join(' ')} />
                </clipPath>
              )}
              <image
                href={`/api/building/underlays/${u.id}/image`}
                width={u.widthPx}
                height={u.heightPx}
                preserveAspectRatio="none"
                transform={`matrix(${a} ${b} ${c} ${d} ${e} ${f})`}
                style={imgStyle}
                data-testid={`building-underlay-img-${u.id}`}
              />
            </Fragment>
          );
        })}
    </g>
  );
}

// ---------------------------------------------------------------------------
// Inspector sub-components.
// ---------------------------------------------------------------------------

function NumberField(props: { label: string; value: number; step?: number; min?: number; onCommit: (v: number) => void; testId?: string }): JSX.Element {
  const [text, setText] = useState<string>(String(props.value));
  useEffect(() => { setText(String(props.value)); }, [props.value]);
  return (
    <label class="bs-field">
      <span>{props.label}</span>
      <input
        type="number"
        step={props.step ?? 0.01}
        min={props.min}
        value={text}
        data-testid={props.testId}
        onInput={(e): void => setText((e.currentTarget as HTMLInputElement).value)}
        onBlur={(): void => { const v = Number(text); if (Number.isFinite(v)) props.onCommit(v); }}
      />
    </label>
  );
}

function WallInspector(props: {
  wall: Wall;
  onPatch: (patch: Partial<Pick<Wall, 'thicknessM' | 'heightM' | 'boundary'>>) => void;
  onDelete: () => void;
  onAddOpening: (type: 'window' | 'door' | 'passage') => void;
  openings: Opening[];
  configWindows: Array<{ id: string; roomId: string; orientationDeg: number }>;
  onUpdateOpening: (id: string, patch: { widthM?: number; heightM?: number; offsetM?: number; sillM?: number; glazing?: 'single' | 'double' | 'triple'; roofWindow?: boolean; linkedWindowId?: string | null }) => void;
  onDeleteOpening: (id: string) => void;
}): JSX.Element {
  const { wall } = props;
  const wallLen = segmentLength(wall.axis);
  return (
    <div class="bs-inspector__card" data-testid="building-inspector-wall">
      <h3>{t('Wand', 'Wall')}</h3>
      <p class="module-panel__hint">{t('Länge', 'Length')} {wallLen.toFixed(2)} m</p>
      <NumberField label={t('Dicke (m)', 'Thickness (m)')} value={wall.thicknessM} min={0.01} onCommit={(v): void => props.onPatch({ thicknessM: Math.max(0.01, v) })} testId="building-wall-thickness" />
      <NumberField label={t('Höhe (m)', 'Height (m)')} value={wall.heightM ?? 2.5} min={0.1} onCommit={(v): void => props.onPatch({ heightM: v })} testId="building-wall-height" />
      <label class="bs-field">
        <span>{t('Grenze', 'Boundary')}</span>
        <select value={wall.boundary} data-testid="building-wall-boundary" onChange={(e): void => props.onPatch({ boundary: (e.currentTarget as HTMLSelectElement).value as Wall['boundary'] })}>
          <option value="outside">{t('außen', 'outside')}</option>
          <option value="ground">{t('Erdreich', 'ground')}</option>
          <option value="adjacent_conditioned">{t('beheizt angrenzend', 'adjacent conditioned')}</option>
          <option value="adjacent_unconditioned">{t('unbeheizt angrenzend', 'adjacent unconditioned')}</option>
          <option value="adiabatic">{t('adiabat', 'adiabatic')}</option>
        </select>
      </label>
      <div class="bs-inspector__row">
        <button type="button" onClick={(): void => props.onAddOpening('window')} data-testid="building-add-window">＋ {t('Fenster', 'Window')}</button>
        <button type="button" onClick={(): void => props.onAddOpening('door')} data-testid="building-add-door">＋ {t('Tür', 'Door')}</button>
        <button type="button" onClick={(): void => props.onAddOpening('passage')} data-testid="building-add-passage">＋ {t('Durchgang', 'Passage')}</button>
      </div>
      {props.openings.length > 0 && (
        <ul class="bs-openings">
          {props.openings.map((o) => (
            <li key={o.id} data-testid={`building-opening-${o.id}`}>
              <div class="bs-opening__head">
                <span>{o.type === 'door' ? t('Tür', 'Door') : o.type === 'passage' ? t('Durchgang', 'Passage') : t('Fenster', 'Window')}</span>
                <button type="button" class="bs-opening__del" onClick={(): void => props.onDeleteOpening(o.id)} data-testid={`building-opening-delete-${o.id}`} aria-label={t('Öffnung löschen', 'Delete opening')}>✕</button>
              </div>
              <div class="bs-opening__fields">
                <NumberField label={t('Breite (m)', 'Width (m)')} value={o.widthM} min={0.1} onCommit={(v): void => props.onUpdateOpening(o.id, { widthM: v })} testId={`building-opening-width-${o.id}`} />
                <NumberField label={t('Höhe (m)', 'Height (m)')} value={o.heightM} min={0.1} onCommit={(v): void => props.onUpdateOpening(o.id, { heightM: v })} testId={`building-opening-height-${o.id}`} />
                <NumberField label={t('Abstand (m)', 'Offset (m)')} value={o.offsetM} min={0} onCommit={(v): void => props.onUpdateOpening(o.id, { offsetM: v })} testId={`building-opening-offset-${o.id}`} />
                <NumberField label={t('Brüstung (m)', 'Sill (m)')} value={o.sillM ?? (o.type === 'door' ? 0 : 0.9)} min={0} onCommit={(v): void => props.onUpdateOpening(o.id, { sillM: v })} testId={`building-opening-sill-${o.id}`} />
              </div>
              {o.type === 'window' && (
                <div class="bs-opening__fields">
                  <label class="bs-field">
                    <span>{t('Verglasung', 'Glazing')}</span>
                    <select
                      value={o.glazing ?? 'double'}
                      data-testid={`building-opening-glazing-${o.id}`}
                      onChange={(e): void => props.onUpdateOpening(o.id, { glazing: (e.currentTarget as HTMLSelectElement).value as 'single' | 'double' | 'triple' })}
                    >
                      <option value="single">{t('1-fach', 'Single')}</option>
                      <option value="double">{t('2-fach', 'Double')}</option>
                      <option value="triple">{t('3-fach', 'Triple')}</option>
                    </select>
                  </label>
                  <label class="bs-field" title={t('Mit einem konfigurierten HeatShield-Fenster verknüpfen', 'Link to a configured HeatShield window')}>
                    <span>{t('Verknüpftes Fenster', 'Linked window')}</span>
                    <select
                      value={o.linkedWindowId ?? ''}
                      data-testid={`building-opening-link-${o.id}`}
                      onChange={(e): void => { const v = (e.currentTarget as HTMLSelectElement).value; props.onUpdateOpening(o.id, { linkedWindowId: v === '' ? null : v }); }}
                    >
                      <option value="">{t('— nicht verknüpft —', '— not linked —')}</option>
                      {o.linkedWindowId !== undefined && !props.configWindows.some((w) => w.id === o.linkedWindowId) && (
                        <option value={o.linkedWindowId}>{t('(unbekannt)', '(unknown)')} {o.linkedWindowId}</option>
                      )}
                      {props.configWindows.map((w) => (
                        <option key={w.id} value={w.id}>{`${w.orientationDeg}° · …${w.id.slice(-4)}`}</option>
                      ))}
                    </select>
                  </label>
                  <p class="module-panel__hint">{t('Dachfenster werden im Dach-Bereich angelegt, nicht an der Wand.', 'Roof windows are created in the Roof section, not on a wall.')}</p>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <button type="button" class="bs-danger" onClick={props.onDelete} data-testid="building-wall-delete">{t('Wand löschen', 'Delete wall')}</button>
    </div>
  );
}

function StoreyInspector(props: {
  storey: Storey;
  canDelete: boolean;
  onPatch: (patch: { name?: string; heightM?: number; elevationM?: number }) => void;
  onDelete: () => void;
}): JSX.Element {
  const { storey } = props;
  const [name, setName] = useState<string>(storey.name);
  const [armDelete, setArmDelete] = useState<boolean>(false);
  useEffect(() => { setName(storey.name); setArmDelete(false); }, [storey.name, storey.id]);
  return (
    <div class="bs-inspector__card" data-testid="building-inspector-storey">
      <h3>{t('Stockwerk', 'Storey')}</h3>
      <label class="bs-field">
        <span>{t('Name', 'Name')}</span>
        <input type="text" value={name} data-testid="building-storey-name" onInput={(e): void => setName((e.currentTarget as HTMLInputElement).value)} onBlur={(): void => { if (name.trim().length > 0) props.onPatch({ name: name.trim() }); }} />
      </label>
      <NumberField label={t('Höhe (m)', 'Height (m)')} value={storey.heightM} min={0.1} onCommit={(v): void => props.onPatch({ heightM: v })} testId="building-storey-height" />
      <NumberField label={t('Sockelhöhe (m)', 'Elevation (m)')} value={storey.elevationM} onCommit={(v): void => props.onPatch({ elevationM: v })} testId="building-storey-elevation" />
      <p class="module-panel__hint">{t('Wähle eine Wand auf der Zeichenfläche, um sie zu bearbeiten.', 'Select a wall on the canvas to edit it.')}</p>
      {props.canDelete ? (
        armDelete ? (
          <div class="bs-inspector__row">
            <button type="button" class="bs-danger" data-testid="building-storey-delete-confirm" onClick={(): void => { props.onDelete(); setArmDelete(false); }}>
              {t('Wirklich löschen', 'Really delete')}
            </button>
            <button type="button" data-testid="building-storey-delete-cancel" onClick={(): void => setArmDelete(false)}>
              {t('Abbrechen', 'Cancel')}
            </button>
          </div>
        ) : (
          <button type="button" class="bs-danger" data-testid="building-storey-delete" onClick={(): void => setArmDelete(true)}>
            🗑 {t('Stockwerk löschen', 'Delete storey')}
          </button>
        )
      ) : (
        <p class="module-panel__hint">{t('Das letzte Stockwerk kann nicht gelöscht werden.', 'The last storey cannot be deleted.')}</p>
      )}
    </div>
  );
}

/**
 * Room list for the active storey: name (editable), area (m²), select + delete.
 * The primary place to name rooms after drawing/detecting them.
 */
/**
 * Room-name input backed by LOCAL state (synced from the prop only when it
 * actually changes). This fixes the "jumps back to the default name" bug: with
 * a directly-controlled `value={sp.name}` the 3 s autosave / snapshot re-renders
 * reset the field mid-typing. Commits on blur or Enter.
 */
function RoomNameField(props: { name: string; onRename: (name: string) => void; testId?: string }): JSX.Element {
  const [text, setText] = useState<string>(props.name);
  useEffect(() => { setText(props.name); }, [props.name]);
  const commit = (): void => { const v = text.trim(); if (v.length > 0 && v !== props.name) props.onRename(v); };
  return (
    <input
      type="text"
      class="bs-roomlist__name"
      value={text}
      data-testid={props.testId}
      onInput={(e): void => setText((e.currentTarget as HTMLInputElement).value)}
      onBlur={commit}
      onKeyDown={(e): void => { if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur(); }}
    />
  );
}

function RoomList(props: {
  spaces: Space[];
  selection: string[];
  configRooms: Array<{ id: string; name: string }>;
  onRename: (id: string, name: string) => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onLinkRoom: (id: string, roomId: string | null) => void;
}): JSX.Element {
  return (
    <div class="bs-inspector__card" data-testid="building-roomlist">
      <h3>{t('Räume', 'Rooms')} ({props.spaces.length})</h3>
      {props.spaces.length === 0 ? (
        <p class="module-panel__hint">{t('Noch keine Räume. Mit dem Raum-Werkzeug zeichnen oder „Räume erkennen".', 'No rooms yet. Draw with the Room tool or “Detect rooms”.')}</p>
      ) : (
        <ul class="bs-roomlist">
          {props.spaces.map((sp) => {
            const linkMissing = sp.linkedRoomId !== undefined && !props.configRooms.some((r) => r.id === sp.linkedRoomId);
            return (
            <li key={sp.id} class={`bs-roomlist__row${props.selection.includes(sp.id) ? ' bs-roomlist__row--sel' : ''}`} data-testid={`building-room-${sp.id}`}>
              <div class="bs-roomlist__main">
                <button type="button" class="bs-roomlist__pick" title={t('Auf der Zeichenfläche hervorheben', 'Highlight on canvas')} onClick={(): void => props.onSelect(sp.id)} aria-label={t('Raum auswählen', 'Select room')}>◎</button>
                <RoomNameField name={sp.name} testId={`building-room-name-${sp.id}`} onRename={(v): void => props.onRename(sp.id, v)} />
                <span class="bs-roomlist__area">{polygonArea(sp.polygon).toFixed(1)} m²</span>
                <button type="button" class="bs-roomlist__del" data-testid={`building-room-delete-${sp.id}`} title={t('Raum löschen', 'Delete room')} aria-label={t('Raum löschen', 'Delete room')} onClick={(): void => props.onDelete(sp.id)}>✕</button>
              </div>
              <label class="bs-roomlist__link" title={t('Mit einem konfigurierten HeatShield-Raum verknüpfen', 'Link to a configured HeatShield room')}>
                <span>{t('Verknüpfter Raum', 'Linked room')}</span>
                <select
                  value={sp.linkedRoomId ?? ''}
                  data-testid={`building-room-link-${sp.id}`}
                  onChange={(e): void => { const v = (e.currentTarget as HTMLSelectElement).value; props.onLinkRoom(sp.id, v === '' ? null : v); }}
                >
                  <option value="">{t('— nicht verknüpft —', '— not linked —')}</option>
                  {linkMissing && <option value={sp.linkedRoomId}>{t('(unbekannt)', '(unknown)')} {sp.linkedRoomId}</option>}
                  {props.configRooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </label>
            </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

const ROOF_TYPES: Array<{ v: RoofType; de: string; en: string }> = [
  { v: 'flat', de: 'Flachdach', en: 'Flat' },
  { v: 'gable', de: 'Satteldach', en: 'Gable' },
  { v: 'hip', de: 'Walmdach', en: 'Hip' },
  { v: 'half_hip', de: 'Krüppelwalmdach', en: 'Half-hip' },
  { v: 'shed', de: 'Pultdach', en: 'Shed' },
];

const RIDGE_OPTIONS: Array<{ v: string; de: string; en: string }> = [
  { v: 'auto', de: 'Auto (längere Seite)', en: 'Auto (longer axis)' },
  { v: '90', de: 'Ost–West', en: 'East–West' },
  { v: '0', de: 'Nord–Süd', en: 'North–South' },
];

/**
 * Roof editor for the ACTIVE storey (BME-13/14). One roof per storey; the mesh
 * builder turns type/pitch/ridge into 3D faces (see the 3D preview). A plain
 * HTML `<select>` in our own dashboard is fine here — the `dataType: ENUM`
 * caveat only applies to HCU config dropdowns, not this SPA.
 */
function RoofInspector(props: {
  roof: Roof | null;
  section: RoofSection | null;
  onAdd: (input: { type: RoofType; pitchDeg: number }) => void;
  onPatch: (id: string, patch: { type?: RoofType; pitchDeg?: number; ridgeAzimuthDeg?: number | null; overhangM?: number | null; kneeHeightM?: number | null }) => void;
  onDelete: (id: string) => void;
  roofWindows: Opening[];
  onAddRoofWindow: () => void;
  onUpdateRoofWindow: (id: string, patch: { widthM?: number; heightM?: number; offsetM?: number }) => void;
  onDeleteRoofWindow: (id: string) => void;
}): JSX.Element {
  const { roof } = props;
  if (roof === null) {
    return (
      <div class="bs-inspector__card" data-testid="building-inspector-roof">
        <h3>{t('Dach', 'Roof')}</h3>
        <p class="module-panel__hint">{t('Dieses Stockwerk hat kein Dach.', 'This storey has no roof.')}</p>
        <button type="button" data-testid="building-roof-add" onClick={(): void => props.onAdd({ type: 'gable', pitchDeg: 30 })}>
          ＋ {t('Dach hinzufügen', 'Add roof')}
        </button>
      </div>
    );
  }
  const hasRidge = roof.type !== 'flat' && roof.type !== 'shed';
  const ridgeValue = roof.ridgeAzimuthDeg === undefined ? 'auto' : String(Math.round(roof.ridgeAzimuthDeg));
  const ridgeSelectValue = RIDGE_OPTIONS.some((o) => o.v === ridgeValue) ? ridgeValue : 'auto';
  return (
    <div class="bs-inspector__card" data-testid="building-inspector-roof">
      <h3>{t('Dach', 'Roof')}</h3>
      <label class="bs-field">
        <span>{t('Form', 'Type')}</span>
        <select
          value={roof.type}
          data-testid="building-roof-type"
          onChange={(e): void => props.onPatch(roof.id, { type: (e.currentTarget as HTMLSelectElement).value as RoofType })}
        >
          {ROOF_TYPES.map((r) => <option key={r.v} value={r.v}>{t(r.de, r.en)}</option>)}
        </select>
      </label>
      {roof.type !== 'flat' && (
        <NumberField
          label={t('Neigung (°)', 'Pitch (°)')}
          value={roof.pitchDeg}
          step={1}
          min={0}
          onCommit={(v): void => props.onPatch(roof.id, { pitchDeg: v })}
          testId="building-roof-pitch"
        />
      )}
      {hasRidge && (
        <label class="bs-field">
          <span>{t('First', 'Ridge')}</span>
          <select
            value={ridgeSelectValue}
            data-testid="building-roof-ridge"
            onChange={(e): void => {
              const v = (e.currentTarget as HTMLSelectElement).value;
              props.onPatch(roof.id, { ridgeAzimuthDeg: v === 'auto' ? null : Number(v) });
            }}
          >
            {RIDGE_OPTIONS.map((o) => <option key={o.v} value={o.v}>{t(o.de, o.en)}</option>)}
          </select>
        </label>
      )}
      <NumberField
        label={t('Dachüberstand (m)', 'Overhang (m)')}
        value={roof.overhangM ?? 0}
        step={0.05}
        min={0}
        onCommit={(v): void => props.onPatch(roof.id, { overhangM: v })}
        testId="building-roof-overhang"
      />
      {roof.type !== 'flat' && (
        <NumberField
          label={t('Sockelhöhe/Kniestock (m)', 'Knee wall (m)')}
          value={roof.kneeHeightM ?? 0}
          step={0.05}
          min={0}
          onCommit={(v): void => props.onPatch(roof.id, { kneeHeightM: v > 0 ? v : null })}
          testId="building-roof-knee"
        />
      )}
      <p class="module-panel__hint">{t('Sichtbar in der 3D-Vorschau. Kniestock macht das Dachgeschoss zum Halbgeschoss.', 'Visible in the 3D preview. A knee wall turns the roof space into a half-storey.')}</p>
      {roof.type !== 'flat' && (
        <div class="bs-roofwindows" data-testid="building-roofwindows">
          <div class="bs-opening__head">
            <span>{t('Dachfenster', 'Roof windows')}</span>
            <button type="button" data-testid="building-roofwindow-add" onClick={props.onAddRoofWindow}>＋ {t('Dachfenster', 'Roof window')}</button>
          </div>
          {props.roofWindows.length === 0 && (
            <p class="module-panel__hint">{t('Dachfenster sitzen im Dach, nicht in der Wand.', 'Roof windows sit in the roof plane, not a wall.')}</p>
          )}
          <ul class="bs-openings">
            {props.roofWindows.map((o) => (
              <li key={o.id} data-testid={`building-roofwindow-${o.id}`}>
                <div class="bs-opening__head">
                  <span>{t('Dachfenster', 'Roof window')}</span>
                  <button type="button" class="bs-opening__del" data-testid={`building-roofwindow-del-${o.id}`} onClick={(): void => props.onDeleteRoofWindow(o.id)}>✕</button>
                </div>
                <div class="bs-opening__fields">
                  <NumberField label={t('Breite (m)', 'Width (m)')} value={o.widthM} min={0.1} step={0.05} onCommit={(v): void => props.onUpdateRoofWindow(o.id, { widthM: v })} testId={`building-roofwindow-w-${o.id}`} />
                  <NumberField label={t('Höhe (m)', 'Height (m)')} value={o.heightM} min={0.1} step={0.05} onCommit={(v): void => props.onUpdateRoofWindow(o.id, { heightM: v })} testId={`building-roofwindow-h-${o.id}`} />
                  <NumberField label={t('Position First (m)', 'Ridge offset (m)')} value={o.offsetM} min={0} step={0.1} onCommit={(v): void => props.onUpdateRoofWindow(o.id, { offsetM: v })} testId={`building-roofwindow-o-${o.id}`} />
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
      {props.section !== null && <RoofSectionPreview section={props.section} />}
      <button type="button" class="bs-danger" data-testid="building-roof-delete" onClick={(): void => props.onDelete(roof.id)}>
        {t('Dach entfernen', 'Remove roof')}
      </button>
    </div>
  );
}

/**
 * Vertical roof cross-section preview (BME Phase 3 "section preview"). Draws the
 * wall box + roof profile perpendicular to the ridge, to scale, with span,
 * ridge-rise and pitch labels. Pure render over the {@link RoofSection}.
 */
function RoofSectionPreview(props: { section: RoofSection }): JSX.Element {
  const { section } = props;
  const W = 240;
  const H = 130;
  const pad = 18;
  const totalH = section.wallHeightM + section.ridgeHeightM;
  const span = section.spanM > 0 ? section.spanM : 1;
  const scale = Math.min((W - 2 * pad) / span, (H - 2 * pad) / (totalH > 0 ? totalH : 1));
  const sx = (x: number): number => pad + x * scale;
  const sy = (y: number): number => H - pad - y * scale;
  const wallTop = section.wallHeightM;
  const roofPts = section.profile.map((p) => `${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ');
  return (
    <figure class="bs-section" data-testid="building-roof-section">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t('Dach-Querschnitt', 'Roof cross-section')}>
        {/* Ground line */}
        <line x1={pad} y1={sy(0)} x2={W - pad} y2={sy(0)} class="bs-section__ground" />
        {/* Wall box */}
        <polygon
          points={`${sx(0).toFixed(1)},${sy(0).toFixed(1)} ${sx(span).toFixed(1)},${sy(0).toFixed(1)} ${sx(span).toFixed(1)},${sy(wallTop).toFixed(1)} ${sx(0).toFixed(1)},${sy(wallTop).toFixed(1)}`}
          class="bs-section__wall"
        />
        {/* Roof profile */}
        <polyline points={roofPts} class="bs-section__roof" />
      </svg>
      <figcaption class="module-panel__hint" data-testid="building-roof-section-caption">
        {t(
          `Querschnitt: Spannweite ${section.spanM.toFixed(1)} m · Firsthöhe +${section.ridgeHeightM.toFixed(2)} m · Neigung ${Math.round(section.pitchDeg)}°`,
          `Section: span ${section.spanM.toFixed(1)} m · ridge +${section.ridgeHeightM.toFixed(2)} m · pitch ${Math.round(section.pitchDeg)}°`,
        )}
      </figcaption>
    </figure>
  );
}

const ISSUE_LABEL: Record<string, { de: string; en: string }> = {
  DUPLICATE_ID: { de: 'Doppelte ID', en: 'Duplicate id' },
  OPENING_HOST_WALL_MISSING: { de: 'Öffnung ohne Wand', en: 'Opening without wall' },
  OPENING_HOST_WALL_WRONG_STOREY: { de: 'Öffnung im falschen Stockwerk', en: 'Opening on wrong storey' },
  SPACE_THERMAL_ZONE_MISSING: { de: 'Raum: Zone fehlt', en: 'Room: zone missing' },
  WALL_CONSTRUCTION_MISSING: { de: 'Wand: Konstruktion fehlt', en: 'Wall: construction missing' },
  ROOF_STOREY_MISSING: { de: 'Dach: Stockwerk fehlt', en: 'Roof: storey missing' },
  THERMAL_ZONE_SPACE_MISSING: { de: 'Zone: Raum fehlt', en: 'Zone: room missing' },
  THERMAL_ZONE_EMPTY: { de: 'Leere Zone', en: 'Empty zone' },
};

function ValidationPanel(props: {
  validation: { valid: boolean; issues: Array<{ code: string; path: string; refId?: string }> } | null;
  onSelect: (id: string) => void;
}): JSX.Element {
  const v = props.validation;
  return (
    <div class="bs-inspector__card" data-testid="building-validation">
      <h3>{t('Prüfung', 'Validation')}</h3>
      {v === null || v.valid ? (
        <p class="module-panel__hint bs-valid-ok" data-testid="building-validation-ok">✓ {t('Keine Probleme gefunden.', 'No problems found.')}</p>
      ) : (
        <ul class="bs-issues">
          {v.issues.map((iss, i) => {
            const label = ISSUE_LABEL[iss.code];
            return (
              <li key={i} class="bs-issue" data-testid="building-issue">
                <button type="button" onClick={(): void => { if (iss.refId !== undefined) props.onSelect(iss.refId); }}>
                  {label !== undefined ? t(label.de, label.en) : iss.code} <small>{iss.path}</small>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Underlay panel (BME-03/04/05/12).
// ---------------------------------------------------------------------------

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = (): void => resolve(String(fr.result));
    fr.onerror = (): void => reject(new Error('read failed'));
    fr.readAsDataURL(file);
  });
}

function UnderlayPanel(props: {
  storeyId: string;
  underlays: UnderlayMeta[];
  onUploaded: () => void;
  onPatch: (id: string, patch: Partial<UnderlayMeta>) => void;
  onDelete: (id: string) => void;
  onCalibrate: (id: string) => void;
  onCrop: (id: string) => void;
  onClearCrop: (id: string) => void;
  onMove: (id: string) => void;
}): JSX.Element {
  const [busy, setBusy] = useState<boolean>(false);
  const [err, setErr] = useState<string | null>(null);

  const onFile = (file: File | undefined): void => {
    if (file === undefined) return;
    setBusy(true);
    setErr(null);
    void readFileAsDataUrl(file)
      .then((dataUrl) => uploadUnderlay(dataUrl, props.storeyId, file.name))
      .then((res) => {
        setBusy(false);
        if (!res.ok) setErr(res.error ?? 'upload failed');
        else props.onUploaded();
      })
      .catch((e: unknown) => {
        setBusy(false);
        setErr(e instanceof Error ? e.message : 'upload failed');
      });
  };

  return (
    <section class="bs-underlays" data-testid="building-underlays">
      <div class="bs-underlays__head">
        <strong>{t('Unterlagen (Grundriss-Vorlagen)', 'Underlays (floor-plan templates)')}</strong>
        <label class="bs-underlays__upload">
          {busy ? t('Lädt hoch …', 'Uploading …') : t('Bild hinzufügen (PNG/JPEG)', 'Add image (PNG/JPEG)')}
          <input
            type="file"
            accept="image/png,image/jpeg"
            data-testid="building-underlay-file"
            style={{ display: 'none' }}
            disabled={busy}
            onChange={(e): void => onFile((e.currentTarget as HTMLInputElement).files?.[0])}
          />
        </label>
      </div>
      <p class="module-panel__hint">
        {t(
          'Lade einen Grundriss als Bild, richte ihn aus und kalibriere den Maßstab über zwei Punkte bekannter Distanz. Danach die Wände darüber zeichnen. Bilder werden vor dem Speichern von Metadaten befreit und liegen nur lokal unter /data.',
          'Upload a floor plan image, position it and calibrate the scale via two points of known distance. Then trace the walls over it. Images are metadata-stripped before storage and live only locally under /data.',
        )}
      </p>
      {err !== null && <p class="diag-error" data-testid="building-underlay-error">{err}</p>}
      {props.underlays.length === 0 ? (
        <p class="module-panel__hint" data-testid="building-underlays-empty">{t('Noch keine Unterlage für dieses Stockwerk.', 'No underlay for this storey yet.')}</p>
      ) : (
        <ul class="bs-underlays__list">
          {props.underlays.map((u) => (
            <li key={u.id} class="bs-underlays__item" data-testid={`building-underlay-${u.id}`}>
              <div class="bs-underlays__row">
                <input
                  type="text"
                  value={u.name}
                  data-testid={`building-underlay-name-${u.id}`}
                  onBlur={(e): void => props.onPatch(u.id, { name: (e.currentTarget as HTMLInputElement).value })}
                />
                <select
                  value={u.kind}
                  data-testid={`building-underlay-kind-${u.id}`}
                  onChange={(e): void => props.onPatch(u.id, { kind: (e.currentTarget as HTMLSelectElement).value as UnderlayKind })}
                >
                  {UNDERLAY_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
                </select>
                <span class="bs-underlays__scale">
                  {u.metersPerPixel === null ? t('unkalibriert', 'uncalibrated') : `${u.metersPerPixel.toFixed(4)} m/px`}
                </span>
              </div>
              <div class="bs-underlays__row">
                <label>{t('Deckkraft', 'Opacity')}
                  <input type="range" min={0} max={100} value={u.opacityPct} data-testid={`building-underlay-opacity-${u.id}`}
                    onInput={(e): void => props.onPatch(u.id, { opacityPct: Number((e.currentTarget as HTMLInputElement).value) })} />
                </label>
                <label>{t('Kontrast', 'Contrast')}
                  <input type="range" min={50} max={150} value={u.contrastPct}
                    onInput={(e): void => props.onPatch(u.id, { contrastPct: Number((e.currentTarget as HTMLInputElement).value) })} />
                </label>
                <label>{t('Drehung°', 'Rotation°')}
                  <input type="number" step={1} value={u.rotationDeg} style={{ width: '64px' }} data-testid={`building-underlay-rot-${u.id}`}
                    onInput={(e): void => props.onPatch(u.id, { rotationDeg: Number((e.currentTarget as HTMLInputElement).value) })} />
                </label>
              </div>
              <div class="bs-underlays__row">
                <label class="tab-rules__check"><input type="checkbox" checked={u.visible} data-testid={`building-underlay-visible-${u.id}`}
                  onChange={(e): void => props.onPatch(u.id, { visible: (e.currentTarget as HTMLInputElement).checked })} /> {t('sichtbar', 'visible')}</label>
                <label class="tab-rules__check"><input type="checkbox" checked={u.locked} data-testid={`building-underlay-lock-${u.id}`}
                  onChange={(e): void => props.onPatch(u.id, { locked: (e.currentTarget as HTMLInputElement).checked })} /> {t('gesperrt', 'locked')}</label>
                <label class="tab-rules__check"><input type="checkbox" checked={u.northAssumed}
                  onChange={(e): void => props.onPatch(u.id, { northAssumed: (e.currentTarget as HTMLInputElement).checked })} /> {t('Norden angenommen', 'north assumed')}</label>
                <button type="button" data-testid={`building-underlay-calibrate-${u.id}`} onClick={(): void => props.onCalibrate(u.id)}>{t('Maßstab', 'Scale')}</button>
                <button type="button" data-testid={`building-underlay-move-${u.id}`} onClick={(): void => props.onMove(u.id)}>{t('Verschieben', 'Move')}</button>
                <button type="button" data-testid={`building-underlay-crop-${u.id}`} onClick={(): void => props.onCrop(u.id)}>{t('Zuschneiden', 'Crop')}</button>
                {hasCrop(u) && (
                  <button type="button" data-testid={`building-underlay-clearcrop-${u.id}`} onClick={(): void => props.onClearCrop(u.id)}>{t('Zuschnitt entfernen', 'Clear crop')}</button>
                )}
                <button type="button" class="bs-danger" data-testid={`building-underlay-delete-${u.id}`} onClick={(): void => props.onDelete(u.id)}>{t('Löschen', 'Delete')}</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// PV array inspector (BME-14).
// ---------------------------------------------------------------------------

function PvInspector(props: {
  plane: RoofPlaneInfo | null;
  arrays: PvArray[];
  onAdd: () => void;
  onAutoFit: (id: string) => void;
  onPatch: (id: string, patch: Partial<Pick<PvArray, 'rows' | 'columns' | 'moduleWidthM' | 'moduleHeightM' | 'gapM'>>) => void;
  onDelete: (id: string) => void;
}): JSX.Element {
  const { plane } = props;
  return (
    <div class="bs-inspector__card" data-testid="building-pv">
      <h3>{t('PV-Anlage', 'PV array')}</h3>
      {plane !== null && (
        <p class="module-panel__hint" data-testid="building-pv-plane">
          {t(
            `Dachfläche ${plane.widthM.toFixed(1)}×${plane.depthM.toFixed(1)} m (${plane.areaM2.toFixed(1)} m²) · Neigung ${plane.tiltDeg.toFixed(0)}° · Azimut ${plane.azimuthDeg === null ? 'auto' : `${plane.azimuthDeg.toFixed(0)}°`}`,
            `Roof plane ${plane.widthM.toFixed(1)}×${plane.depthM.toFixed(1)} m (${plane.areaM2.toFixed(1)} m²) · tilt ${plane.tiltDeg.toFixed(0)}° · azimuth ${plane.azimuthDeg === null ? 'auto' : `${plane.azimuthDeg.toFixed(0)}°`}`,
          )}
        </p>
      )}
      {props.arrays.length === 0 ? (
        <button type="button" data-testid="building-pv-add" onClick={props.onAdd}>＋ {t('PV automatisch einpassen', 'Auto-fit PV')}</button>
      ) : (
        <ul class="bs-openings">
          {props.arrays.map((pv) => (
            <li key={pv.id} data-testid={`building-pv-${pv.id}`}>
              <span>{t(`${pv.rows}×${pv.columns} Module (${(pv.moduleWidthM).toFixed(2)}×${(pv.moduleHeightM).toFixed(2)} m)`, `${pv.rows}×${pv.columns} modules (${(pv.moduleWidthM).toFixed(2)}×${(pv.moduleHeightM).toFixed(2)} m)`)}</span>
              <NumberField label={t('Reihen', 'Rows')} value={pv.rows} step={1} min={1} onCommit={(v): void => props.onPatch(pv.id, { rows: v })} testId={`building-pv-rows-${pv.id}`} />
              <NumberField label={t('Spalten', 'Columns')} value={pv.columns} step={1} min={1} onCommit={(v): void => props.onPatch(pv.id, { columns: v })} testId={`building-pv-cols-${pv.id}`} />
              <div class="bs-inspector__row">
                <button type="button" data-testid={`building-pv-autofit-${pv.id}`} onClick={(): void => props.onAutoFit(pv.id)}>{t('Auto-Einpassen', 'Auto-fit')}</button>
                <button type="button" class="bs-danger" data-testid={`building-pv-delete-${pv.id}`} onClick={(): void => props.onDelete(pv.id)}>{t('Entfernen', 'Remove')}</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
