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
import { roomStatuses } from '../components/uebersicht/uebersichtModel.js';
import { exportSvgAsPng } from '../svgExport.js';
import { Twin3D } from '../components/building/twin3d.js';
import { ThermalPanel } from '../components/building/thermalPanel.js';
import type { BuildingModel, Point, PvArray, Roof, RoofType, Storey, Wall } from '../../../../shared/building-model.js';
import {
  calibrateTwoPoint,
  effectiveMpp,
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
  addStorey,
  addWall,
  addRoof,
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

type Tool = 'select' | 'wall' | 'room' | 'calibrate';

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
  const [history, setHistory] = useState<EditorHistory | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<{ busy: boolean; msg: string | null }>({ busy: false, msg: null });
  const [dirty, setDirty] = useState<boolean>(false);

  const [tool, setTool] = useState<Tool>('select');
  const [angle, setAngle] = useState<AngleConstraint>('ortho');
  const [gridM, setGridM] = useState<number>(0.5);
  const [view, setView] = useState<View>(DEFAULT_VIEW);
  const [draft, setDraft] = useState<Point[]>([]);
  const [cursor, setCursor] = useState<Point | null>(null);
  const [show3d, setShow3d] = useState<boolean>(false);
  const [showThermal, setShowThermal] = useState<boolean>(false);
  const [showHistory, setShowHistory] = useState<boolean>(false);
  const [revisions, setRevisions] = useState<RevisionSummary[]>([]);
  const [projects, setProjects] = useState<ProjectIndex | null>(null);
  const [renaming, setRenaming] = useState<boolean>(false);

  // Underlays (BME-03/04/05/12).
  const [underlays, setUnderlays] = useState<UnderlayMeta[]>([]);
  const [showUnderlays, setShowUnderlays] = useState<boolean>(false);
  const [calibratingId, setCalibratingId] = useState<string | null>(null);
  const [calibPoints, setCalibPoints] = useState<Point[]>([]);
  const [calibDist, setCalibDist] = useState<string>('1');

  const svgRef = useRef<SVGSVGElement | null>(null);
  const panRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

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
      commit(addWall(CTX, state, { axis: draft }));
      setDraft([]);
    } else if (tool === 'room' && draft.length >= 3) {
      const name = t(`Raum ${(storey?.spaces.length ?? 0) + 1}`, `Room ${(storey?.spaces.length ?? 0) + 1}`);
      commit(addSpace(CTX, state, { name, polygon: draft }));
      setDraft([]);
    }
  }, [state, tool, draft, commit, storey]);

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
      } else if (e.key === 'Enter') {
        commitDraft();
      }
    }
    window.addEventListener('keydown', onKey);
    return (): void => window.removeEventListener('keydown', onKey);
  }, [doUndo, doRedo, commitDraft]);

  // Snap a raw model point to grid + (for the second+ draft point) angle.
  const snapPoint = useCallback(
    (raw: Point): Point => {
      const g = snapToGrid(raw, gridM);
      if (draft.length > 0 && (tool === 'wall' || tool === 'room')) {
        return constrainAngle(draft[draft.length - 1] as Point, g, angle);
      }
      return g;
    },
    [gridM, draft, tool, angle],
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
      if (tool === 'calibrate') {
        // Capture up to two precise (un-snapped) model points for scaling.
        setCalibPoints((pts) => (pts.length >= 2 ? [m] : [...pts, m]));
        return;
      }
      const p = snapPoint(m);
      if (tool === 'wall' || tool === 'room') {
        setDraft((d) => [...d, p]);
      } else {
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
    [state, view, eventToModel, snapPoint, tool, storey, transient],
  );

  const onPointerMove = useCallback(
    (e: PointerEvent): void => {
      if (panRef.current !== null) {
        const pan = panRef.current;
        setView((v) => ({ ...v, offsetX: pan.ox + (e.clientX - pan.x), offsetY: pan.oy + (e.clientY - pan.y) }));
        return;
      }
      const m = eventToModel(e);
      if (m !== null) setCursor(snapPoint(m));
    },
    [eventToModel, snapPoint],
  );

  const onPointerUp = useCallback((): void => {
    panRef.current = null;
  }, []);

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
      <div class="module-panel__head">
        <h1>{t('Gebäude-Studio', 'Building Studio')}</h1>
        <span class="module-panel__badge" data-testid="building-rev">
          {t(`Rev. ${model.revision}`, `Rev. ${model.revision}`)}{dirty ? ' •' : ''}
        </span>
      </div>

      {projects !== null && (
        <div class="bs-projects" data-testid="building-projects">
          <label class="bs-projects__field">
            <span>{t('Projekt', 'Project')}</span>
            <select
              value={projects.activeId}
              data-testid="building-project-select"
              disabled={saveState.busy || renaming}
              onChange={(e): void => switchProject((e.currentTarget as HTMLSelectElement).value)}
            >
              {projects.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
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
            <button type="button" data-testid="building-project-rename-btn" disabled={saveState.busy} onClick={(): void => setRenaming(true)}>{t('Umbenennen', 'Rename')}</button>
          )}
          <button type="button" data-testid="building-project-new" disabled={saveState.busy} onClick={newProject}>＋ {t('Neu', 'New')}</button>
          <button
            type="button"
            class="bs-danger"
            data-testid="building-project-delete"
            disabled={saveState.busy || projects.activeId === 'default' || projects.projects.length <= 1}
            onClick={(): void => removeProject(projects.activeId)}
          >{t('Löschen', 'Delete')}</button>
        </div>
      )}
      <p class="module-panel__hint">
        {t(
          'Vorschau-Funktion. Zeichne Grundriss-Geometrie (Wände, Räume) je Stockwerk. Wähle Wände mit Umschalt-Klick mehrfach aus (verbinden/ausrichten). Steuert keine Geräte.',
          'Preview feature. Draw floor-plan geometry (walls, rooms) per storey. Shift-click walls to multi-select (merge/align). Controls no devices.',
        )}
      </p>

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
            {[0.25, 0.5, 1].map((g) => <option key={g} value={String(g)}>{g} m</option>)}
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
        </div>
        <div class="bs-toolbar__group bs-toolbar__group--end">
          <button type="button" aria-pressed={showUnderlays} data-testid="building-toggle-underlays" onClick={(): void => setShowUnderlays((v) => !v)}>
            {t('Unterlagen', 'Underlays')}{storeyUnderlays.length > 0 ? ` (${storeyUnderlays.length})` : ''}
          </button>
          <button
            type="button"
            aria-pressed={showHistory}
            data-testid="building-toggle-history"
            onClick={(): void => {
              setShowHistory((v) => !v);
              void loadHistory().then(setRevisions).catch(() => setRevisions([]));
            }}
          >
            {t('Verlauf', 'History')}
          </button>
          <button type="button" aria-pressed={show3d} data-testid="building-toggle-3d" onClick={(): void => setShow3d((v) => !v)}>
            {show3d ? t('3D aus', '3D off') : t('3D-Vorschau', '3D preview')}
          </button>
          <button type="button" aria-pressed={showThermal} data-testid="building-toggle-thermal" onClick={(): void => setShowThermal((v) => !v)}>
            {showThermal ? t('Wärmelast aus', 'Thermal off') : t('Wärmelast', 'Thermal load')}
          </button>
          <button type="button" onClick={(): void => { void onSave(); }} disabled={saveState.busy || !dirty} data-testid="building-save">
            {saveState.busy ? t('Speichere…', 'Saving…') : t('Speichern', 'Save')}
          </button>
          <button type="button" onClick={onReload} disabled={saveState.busy} data-testid="building-reload">{t('Neu laden', 'Reload')}</button>
          <button
            type="button"
            data-testid="building-export"
            onClick={(): void => {
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
            {t('Export', 'Export')}
          </button>
          <button
            type="button"
            data-testid="building-export-glb"
            onClick={(): void => {
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
            {t('GLB', 'GLB')}
          </button>
          <button
            type="button"
            data-testid="building-export-png"
            onClick={(): void => {
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
            {t('PNG', 'PNG')}
          </button>
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

      {storey.walls.length === 0 && storey.spaces.length === 0 && (
        <div class="bs-onboarding" data-testid="building-onboarding">
          <div class="bs-onboarding__text">
            <strong>{t('Grundriss anlegen', 'Start your floor plan')}</strong>
            <p>{t(
              'Optional eine Grundriss-Vorlage unter „Unterlagen" laden und kalibrieren, dann mit dem Wand-Werkzeug die Außenwände nachzeichnen und „Räume erkennen".',
              'Optionally load & calibrate a plan under “Underlays”, then trace the outer walls with the Wall tool and “Detect rooms”.',
            )}</p>
          </div>
        </div>
      )}

      <div class="bs-layout">
        <aside class="bs-tree" data-testid="building-storeys" aria-label={t('Stockwerke', 'Storeys')}>
          <div class="bs-tree__head">
            <span>{t('Stockwerke', 'Storeys')}</span>
            <button
              type="button"
              data-testid="building-add-storey"
              onClick={(): void => {
                const top = Math.max(...model.storeys.map((s) => s.elevationM + s.heightM), 0);
                commit(addStorey(CTX, state, { name: t(`Etage ${model.storeys.length + 1}`, `Floor ${model.storeys.length + 1}`), elevationM: top, heightM: 2.5 }));
              }}
            >＋</button>
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
            <UnderlayLayer underlays={storeyUnderlays} view={view} />
            <GridLayer view={view} gridM={gridM} />
            {storey.spaces.map((sp) => {
              const pts = sp.polygon.map((p) => { const s = toScreen(p, view); return `${s.sx},${s.sy}`; }).join(' ');
              const selected = state.selection.includes(sp.id);
              return <polygon key={sp.id} points={pts} class={`bs-space ${selected ? 'bs-space--sel' : ''}`} data-testid={`building-space-${sp.id}`} />;
            })}
            {storey.walls.map((w) => <WallShape key={w.id} wall={w} view={view} selected={state.selection.includes(w.id)} />)}
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
          </svg>
          <div class="bs-readout" data-testid="building-readout">
            {cursor !== null && <span>x {cursor.x.toFixed(2)} m · y {cursor.y.toFixed(2)} m</span>}
            {draft.length >= 2 && tool === 'wall' && (
              <span> · {t('Länge', 'Length')} {segmentLength(draft).toFixed(2)} m · {headingDeg(draft[draft.length - 2] as Point, draft[draft.length - 1] as Point).toFixed(0)}°</span>
            )}
            {draft.length >= 3 && tool === 'room' && <span> · {t('Fläche', 'Area')} {polygonArea(draft).toFixed(1)} m²</span>}
          </div>
        </div>

        <aside class="bs-inspector" data-testid="building-inspector" aria-label={t('Eigenschaften', 'Properties')}>
          {selectedWall !== null ? (
            <WallInspector
              wall={selectedWall}
              onPatch={(patch): void => commit(updateWall(state, selectedWall.id, patch))}
              onDelete={(): void => commit(deleteWall(state, selectedWall.id))}
              onAddOpening={(type): void => {
                const len = segmentLength(selectedWall.axis);
                commit(addOpening(CTX, state, { type, hostWallId: selectedWall.id, offsetM: Math.max(0, len / 2 - 0.5), widthM: 1, heightM: type === 'door' ? 2 : 1.2 }));
              }}
              openings={storey.openings.filter((o) => o.hostWallId === selectedWall.id)}
              onDeleteOpening={(id): void => commit(deleteOpening(state, id))}
            />
          ) : (
            <Fragment>
              <StoreyInspector storey={storey} onPatch={(patch): void => commit(updateStorey(state, storey.id, patch))} />
              <RoofInspector
                roof={model.roofs.find((r) => r.storeyId === storey.id) ?? null}
                section={(() => {
                  const rf = model.roofs.find((r) => r.storeyId === storey.id) ?? null;
                  return rf === null ? null : roofSectionProfile(state, rf.id);
                })()}
                onAdd={(input): void => commit(addRoof(CTX, state, { ...input, storeyId: storey.id }))}
                onPatch={(id, patch): void => commit(updateRoof(state, id, patch))}
                onDelete={(id): void => commit(removeRoof(state, id))}
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

      {showUnderlays && (
        <UnderlayPanel
          storeyId={storey.id}
          underlays={storeyUnderlays}
          onUploaded={refreshUnderlays}
          onPatch={(id, patch): void => { void patchUnderlay(id, patch).then(refreshUnderlays); }}
          onDelete={(id): void => { void removeUnderlay(id).then(refreshUnderlays); }}
          onCalibrate={startCalibration}
        />
      )}

      {show3d && <Twin3D model={model} roomStates={roomOverlays} />}

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

function WallShape(props: { wall: Wall; view: View; selected: boolean }): JSX.Element {
  const pts = props.wall.axis.map((p) => { const s = toScreen(p, props.view); return `${s.sx},${s.sy}`; }).join(' ');
  const strokePx = Math.max(2, props.wall.thicknessM * props.view.scale);
  return (
    <polyline
      points={pts}
      class={`bs-wall ${props.selected ? 'bs-wall--sel' : ''}`}
      style={{ strokeWidth: `${strokePx}px` }}
      data-testid={`building-wall-${props.wall.id}`}
    />
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
 * Render visible underlays as transformed SVG images behind the grid. The
 * matrix maps image pixels (y-down) → screen via the underlay's calibration
 * (metres-per-pixel), rotation and model offset, composed with the view.
 */
function UnderlayLayer(props: { underlays: UnderlayMeta[]; view: View }): JSX.Element {
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
          const e = u.offsetXM * view.scale + view.offsetX;
          const f = -u.offsetYM * view.scale + view.offsetY;
          return (
            <image
              key={u.id}
              href={`/api/building/underlays/${u.id}/image`}
              width={u.widthPx}
              height={u.heightPx}
              preserveAspectRatio="none"
              transform={`matrix(${a} ${b} ${c} ${d} ${e} ${f})`}
              style={{ opacity: u.opacityPct / 100, filter: `contrast(${u.contrastPct}%)`, pointerEvents: 'none' }}
              data-testid={`building-underlay-img-${u.id}`}
            />
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
  onAddOpening: (type: 'window' | 'door') => void;
  openings: Array<{ id: string; type: 'window' | 'door'; widthM: number; offsetM: number }>;
  onDeleteOpening: (id: string) => void;
}): JSX.Element {
  const { wall } = props;
  return (
    <div class="bs-inspector__card" data-testid="building-inspector-wall">
      <h3>{t('Wand', 'Wall')}</h3>
      <p class="module-panel__hint">{t('Länge', 'Length')} {segmentLength(wall.axis).toFixed(2)} m</p>
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
      </div>
      {props.openings.length > 0 && (
        <ul class="bs-openings">
          {props.openings.map((o) => (
            <li key={o.id} data-testid={`building-opening-${o.id}`}>
              <span>{o.type === 'door' ? t('Tür', 'Door') : t('Fenster', 'Window')} · {o.widthM.toFixed(2)} m @ {o.offsetM.toFixed(2)} m</span>
              <button type="button" onClick={(): void => props.onDeleteOpening(o.id)} aria-label={t('Öffnung löschen', 'Delete opening')}>✕</button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" class="bs-danger" onClick={props.onDelete} data-testid="building-wall-delete">{t('Wand löschen', 'Delete wall')}</button>
    </div>
  );
}

function StoreyInspector(props: { storey: Storey; onPatch: (patch: { name?: string; heightM?: number; elevationM?: number }) => void }): JSX.Element {
  const { storey } = props;
  const [name, setName] = useState<string>(storey.name);
  useEffect(() => { setName(storey.name); }, [storey.name]);
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
  onPatch: (id: string, patch: { type?: RoofType; pitchDeg?: number; ridgeAzimuthDeg?: number | null }) => void;
  onDelete: (id: string) => void;
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
      <p class="module-panel__hint">{t('Sichtbar in der 3D-Vorschau.', 'Visible in the 3D preview.')}</p>
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
                <button type="button" data-testid={`building-underlay-calibrate-${u.id}`} onClick={(): void => props.onCalibrate(u.id)}>{t('Kalibrieren', 'Calibrate')}</button>
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
