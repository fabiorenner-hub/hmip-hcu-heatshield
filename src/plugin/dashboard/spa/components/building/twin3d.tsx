/**
 * Heat Shield — dependency-free 3D preview (digital-twin-renderer T-02/T-04,
 * BME-15). Renders the deterministic building mesh with an orthographic
 * projection to SVG (no WebGL / no Three.js — keeps the SPA LOCAL and small).
 *
 * Features: orbit (drag to change azimuth/elevation), storey isolation, roof
 * toggle, and a structured textual scene tree as the accessible fallback
 * (BME-19 / T-04). Faces are painted back-to-front (painter's algorithm) and
 * tinted by kind from the design tokens.
 */

import { h, Fragment, type JSX } from 'preact';
import { useMemo, useRef, useState } from 'preact/hooks';

import { t } from '../../i18n.js';
import { getSunPosition } from '../sunPolarPlot.js';
import type { BuildingModel } from '../../../../../shared/building-model.js';
import { buildMesh, faceCounts, clipPolygonBelowZ, type FaceKind, type MeshFace, type Vec3 } from '../../../../../shared/building-mesh.js';

const KIND_FILL: Record<FaceKind, string> = {
  wall: 'rgba(232, 237, 246, 0.16)',
  floor: 'rgba(59, 130, 246, 0.20)',
  ceiling: 'rgba(154, 166, 184, 0.10)',
  roof: 'rgba(245, 158, 11, 0.28)',
  pv: 'rgba(59, 130, 246, 0.55)',
};
const KIND_STROKE: Record<FaceKind, string> = {
  wall: 'rgba(232, 237, 246, 0.5)',
  floor: 'rgba(59, 130, 246, 0.7)',
  ceiling: 'rgba(154, 166, 184, 0.45)',
  roof: 'rgba(245, 158, 11, 0.8)',
  pv: 'rgba(120, 170, 255, 0.95)',
};

/** Live room-state overlay (digital-twin-renderer T-03 / BME-16). */
export type RoomTone = 'ok' | 'warm' | 'hot' | 'unknown';
export interface RoomOverlay {
  name: string;
  tone: RoomTone;
  tempC: number | null;
}
const TONE_FILL: Record<RoomTone, string> = {
  ok: 'rgba(102, 214, 107, 0.34)',
  warm: 'rgba(255, 157, 46, 0.38)',
  hot: 'rgba(255, 93, 87, 0.42)',
  unknown: 'rgba(154, 166, 184, 0.16)',
};
const TONE_LABEL: Record<RoomTone, { de: string; en: string }> = {
  ok: { de: 'komfortabel', en: 'comfortable' },
  warm: { de: 'wird warm', en: 'getting warm' },
  hot: { de: 'heiß', en: 'hot' },
  unknown: { de: 'keine Daten', en: 'no data' },
};
const normName = (s: string): string => s.trim().toLowerCase();

interface Projected {
  x: number;
  y: number;
  depth: number;
}

function project(v: Vec3, azDeg: number, elDeg: number): Projected {
  const a = (azDeg * Math.PI) / 180;
  const p = (elDeg * Math.PI) / 180;
  const rx = v.x * Math.cos(a) - v.y * Math.sin(a);
  const ry = v.x * Math.sin(a) + v.y * Math.cos(a);
  return {
    x: rx,
    y: ry * Math.sin(p) - v.z * Math.cos(p),
    depth: ry * Math.cos(p) + v.z * Math.sin(p),
  };
}

const W = 640;
const HGT = 360;

export function Twin3D(props: { model: BuildingModel; roomStates?: RoomOverlay[] }): JSX.Element {
  const [az, setAz] = useState<number>(35);
  const [el, setEl] = useState<number>(30);
  const [storeyFilter, setStoreyFilter] = useState<string>('all');
  const [showRoof, setShowRoof] = useState<boolean>(true);
  const [sunOn, setSunOn] = useState<boolean>(false);
  const [sunMin, setSunMin] = useState<number>(() => {
    const d = new Date();
    return d.getHours() * 60 + d.getMinutes();
  });
  const dragRef = useRef<{ x: number; y: number; az: number; el: number } | null>(null);

  const mesh = useMemo(() => buildMesh(props.model), [props.model]);
  const counts = faceCounts(mesh);

  // Clipping-plane / section view (BME Phase 3): a horizontal cut at height
  // `cutZ`; geometry above the plane is removed, spanning faces are clipped.
  const zMin = mesh.bounds.min.z;
  const zMax = mesh.bounds.max.z;
  const [clipOn, setClipOn] = useState<boolean>(false);
  const [cutZ, setCutZ] = useState<number>(zMax);
  // Keep the cut height within the current model's Z extent.
  const cutClamped = Math.max(zMin, Math.min(zMax, cutZ));

  // Live room-state overlay (T-03): tint floor faces by the matched HeatShield
  // room's tone. Match model spaces to live rooms by normalised name.
  const roomStates = props.roomStates ?? [];
  const hasRoomStates = roomStates.length > 0;
  const [showRoomState, setShowRoomState] = useState<boolean>(false);
  const overlayActive = showRoomState && hasRoomStates;
  const spaceTone = useMemo(() => {
    const toneByName = new Map<string, RoomTone>();
    for (const r of roomStates) toneByName.set(normName(r.name), r.tone);
    const bySpaceId = new Map<string, RoomTone>();
    for (const s of props.model.storeys) {
      for (const sp of s.spaces) {
        const tone = toneByName.get(normName(sp.name));
        if (tone !== undefined) bySpaceId.set(sp.id, tone);
      }
    }
    return bySpaceId;
  }, [roomStates, props.model]);

  // Sun preview: position for the site + selected time-of-day. The shadow falls
  // AWAY from the sun; its length grows as the sun sinks. Azimuth is compass
  // (0=N, clockwise); local +y points to `northAzimuthDeg`.
  const sun = useMemo(() => {
    const d = new Date();
    d.setHours(Math.floor(sunMin / 60), sunMin % 60, 0, 0);
    const pos = getSunPosition(d, props.model.site.latitude, props.model.site.longitude);
    const localBearingRad = ((pos.azimuthDeg - props.model.site.northAzimuthDeg) * Math.PI) / 180;
    // Unit vector pointing toward the sun in local plan coords (x=east, y=north).
    const toward = { x: Math.sin(localBearingRad), y: Math.cos(localBearingRad) };
    const up = pos.elevationDeg > 3;
    // 1/tan(elevation), clamped so a low sun does not produce an infinite shadow.
    const shadowFactor = up ? Math.min(8, 1 / Math.tan((pos.elevationDeg * Math.PI) / 180)) : 0;
    return { ...pos, date: d, toward, up, shadowFactor };
  }, [sunMin, props.model.site.latitude, props.model.site.longitude, props.model.site.northAzimuthDeg]);
  const sunActive = sunOn && sun.up;

  const visibleFaces: MeshFace[] = useMemo(
    () => {
      const base = mesh.faces.filter(
        (f) => (storeyFilter === 'all' || f.storeyId === storeyFilter) && (showRoof || f.kind !== 'roof'),
      );
      if (!clipOn) return base;
      // Section cut: clip every face to the half-space z ≤ cutClamped.
      const clipped: MeshFace[] = [];
      for (const f of base) {
        const poly = clipPolygonBelowZ(f.vertices, cutClamped);
        if (poly !== null) clipped.push({ ...f, vertices: poly });
      }
      return clipped;
    },
    [mesh, storeyFilter, showRoof, clipOn, cutClamped],
  );

  const painted = useMemo(() => {
    const polys = visibleFaces.map((f) => {
      const pts = f.vertices.map((v) => project(v, az, el));
      const depth = pts.reduce((s, p) => s + p.depth, 0) / (pts.length || 1);
      return { kind: f.kind, entityId: f.entityId, pts, depth };
    });
    // Fit to viewport.
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const poly of polys) {
      for (const p of poly.pts) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
    }
    const spanX = maxX - minX || 1;
    const spanY = maxY - minY || 1;
    const scale = Math.min((W - 40) / spanX, (HGT - 40) / spanY);
    const ox = (W - spanX * scale) / 2 - minX * scale;
    const oy = (HGT - spanY * scale) / 2 - minY * scale;
    const toScreen = (p: Projected): string => `${(p.x * scale + ox).toFixed(1)},${(p.y * scale + oy).toFixed(1)}`;

    const faces = polys
      .sort((a, b) => a.depth - b.depth)
      .map((poly) => {
        const tone = overlayActive && poly.kind === 'floor' ? spaceTone.get(poly.entityId) : undefined;
        return {
          kind: poly.kind,
          points: poly.pts.map(toScreen).join(' '),
          ...(tone !== undefined ? { fill: TONE_FILL[tone] } : {}),
        };
      });

    // Ground shadows: project each elevated face down to z=0 along the light
    // ray (away from the sun) and paint the resulting polygon beneath the model.
    let shadows: string[] = [];
    let sunLine: { x1: number; y1: number; x2: number; y2: number } | null = null;
    if (sunActive) {
      const lx = -sun.toward.x;
      const ly = -sun.toward.y;
      shadows = visibleFaces
        .filter((f) => f.vertices.some((v) => v.z > 0.05))
        .map((f) =>
          f.vertices
            .map((v) => toScreen(project({ x: v.x + v.z * sun.shadowFactor * lx, y: v.y + v.z * sun.shadowFactor * ly, z: 0 }, az, el)))
            .join(' '),
        );
      // Sun-direction gnomon on the ground from the footprint centre.
      const cx = (mesh.bounds.min.x + mesh.bounds.max.x) / 2;
      const cy = (mesh.bounds.min.y + mesh.bounds.max.y) / 2;
      const reach = Math.max(mesh.bounds.max.x - mesh.bounds.min.x, mesh.bounds.max.y - mesh.bounds.min.y, 2) * 0.6;
      const base = project({ x: cx, y: cy, z: 0 }, az, el);
      const tip = project({ x: cx + sun.toward.x * reach, y: cy + sun.toward.y * reach, z: 0 }, az, el);
      sunLine = {
        x1: base.x * scale + ox,
        y1: base.y * scale + oy,
        x2: tip.x * scale + ox,
        y2: tip.y * scale + oy,
      };
    }
    return { faces, shadows, sunLine };
  }, [visibleFaces, az, el, sunActive, sun, mesh.bounds, overlayActive, spaceTone]);

  const onDown = (e: PointerEvent): void => {
    dragRef.current = { x: e.clientX, y: e.clientY, az, el };
  };
  const onMove = (e: PointerEvent): void => {
    const d = dragRef.current;
    if (d === null) return;
    setAz(d.az + (e.clientX - d.x) * 0.5);
    setEl(Math.max(5, Math.min(85, d.el - (e.clientY - d.y) * 0.5)));
  };
  const onUp = (): void => {
    dragRef.current = null;
  };

  return (
    <section class="twin3d" data-testid="building-twin3d">
      <div class="twin3d__toolbar">
        <strong>{t('3D-Vorschau', '3D preview')}</strong>
        <label class="bs-toolbar__field">
          {t('Stockwerk', 'Storey')}
          <select value={storeyFilter} data-testid="twin3d-storey" onChange={(e): void => setStoreyFilter((e.currentTarget as HTMLSelectElement).value)}>
            <option value="all">{t('alle', 'all')}</option>
            {props.model.storeys.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </label>
        <label class="tab-rules__check">
          <input type="checkbox" data-testid="twin3d-roof" checked={showRoof} onChange={(e): void => setShowRoof((e.currentTarget as HTMLInputElement).checked)} />
          <span>{t('Dach', 'Roof')}</span>
        </label>
        <button type="button" data-testid="twin3d-reset" onClick={(): void => { setAz(35); setEl(30); }}>{t('Ansicht zurücksetzen', 'Reset view')}</button>
        <label class="tab-rules__check">
          <input type="checkbox" data-testid="twin3d-sun" checked={sunOn} onChange={(e): void => setSunOn((e.currentTarget as HTMLInputElement).checked)} />
          <span>{t('Sonne', 'Sun')}</span>
        </label>
        {sunOn && (
          <label class="bs-toolbar__field twin3d__suntime">
            {t('Uhrzeit', 'Time')}
            <input
              type="range"
              min={0}
              max={1439}
              step={15}
              value={sunMin}
              data-testid="twin3d-suntime"
              onInput={(e): void => setSunMin(Number((e.currentTarget as HTMLInputElement).value))}
            />
            <span class="twin3d__sunreadout" data-testid="twin3d-sun-readout">
              {`${String(Math.floor(sunMin / 60)).padStart(2, '0')}:${String(sunMin % 60).padStart(2, '0')} · ${sun.up ? t(`Az ${Math.round(sun.azimuthDeg)}° · H ${Math.round(sun.elevationDeg)}°`, `Az ${Math.round(sun.azimuthDeg)}° · Alt ${Math.round(sun.elevationDeg)}°`) : t('Sonne unter Horizont', 'Sun below horizon')}`}
            </span>
          </label>
        )}
        <label class="tab-rules__check">
          <input type="checkbox" data-testid="twin3d-clip" checked={clipOn} onChange={(e): void => { const on = (e.currentTarget as HTMLInputElement).checked; setClipOn(on); if (on) setCutZ(zMax); }} />
          <span>{t('Schnitt', 'Section')}</span>
        </label>
        {clipOn && (
          <label class="bs-toolbar__field twin3d__suntime">
            {t('Höhe', 'Height')}
            <input
              type="range"
              min={zMin}
              max={zMax}
              step={0.1}
              value={cutClamped}
              data-testid="twin3d-clip-height"
              onInput={(e): void => setCutZ(Number((e.currentTarget as HTMLInputElement).value))}
            />
            <span class="twin3d__sunreadout" data-testid="twin3d-clip-readout">{`${cutClamped.toFixed(1)} m`}</span>
          </label>
        )}
        {hasRoomStates && (
          <label class="tab-rules__check">
            <input type="checkbox" data-testid="twin3d-roomstate" checked={showRoomState} onChange={(e): void => setShowRoomState((e.currentTarget as HTMLInputElement).checked)} />
            <span>{t('Raumstatus', 'Room state')}</span>
          </label>
        )}
      </div>

      {mesh.faces.length === 0 ? (
        <p class="module-panel__hint" data-testid="twin3d-empty">
          {t('Noch keine Geometrie — zeichne Wände und Räume, dann erscheint hier das 3D-Modell.', 'No geometry yet — draw walls and rooms and the 3D model appears here.')}
        </p>
      ) : (
        <svg
          class="twin3d__canvas"
          data-testid="twin3d-canvas"
          viewBox={`0 0 ${W} ${HGT}`}
          role="img"
          aria-label={t('3D-Vorschau des Gebäudes (ziehen zum Drehen)', 'Building 3D preview (drag to orbit)')}
          onPointerDown={onDown as unknown as JSX.PointerEventHandler<SVGSVGElement>}
          onPointerMove={onMove as unknown as JSX.PointerEventHandler<SVGSVGElement>}
          onPointerUp={onUp as unknown as JSX.PointerEventHandler<SVGSVGElement>}
          onPointerLeave={onUp as unknown as JSX.PointerEventHandler<SVGSVGElement>}
        >
          {painted.shadows.map((pts, i) => (
            <polygon key={`sh-${i}`} points={pts} style={{ fill: 'rgba(5, 7, 13, 0.28)', stroke: 'none' }} />
          ))}
          {painted.faces.map((poly, i) => (
            <polygon key={i} points={poly.points} style={{ fill: poly.fill ?? KIND_FILL[poly.kind], stroke: KIND_STROKE[poly.kind], strokeWidth: 1 }} />
          ))}
          {painted.sunLine !== null && (
            <g data-testid="twin3d-sun-indicator">
              <line
                x1={painted.sunLine.x1.toFixed(1)}
                y1={painted.sunLine.y1.toFixed(1)}
                x2={painted.sunLine.x2.toFixed(1)}
                y2={painted.sunLine.y2.toFixed(1)}
                style={{ stroke: 'rgba(245, 158, 11, 0.7)', strokeWidth: 2, strokeDasharray: '4 3' }}
              />
              <circle cx={painted.sunLine.x2.toFixed(1)} cy={painted.sunLine.y2.toFixed(1)} r={7} style={{ fill: 'rgba(251, 191, 36, 0.95)', stroke: 'rgba(245, 158, 11, 1)', strokeWidth: 1.5 }} />
            </g>
          )}
        </svg>
      )}

      {overlayActive && (
        <div class="twin3d__legend" data-testid="twin3d-roomstate-legend">
          {(['ok', 'warm', 'hot', 'unknown'] as RoomTone[]).map((tone) => (
            <span key={tone} class="twin3d__legend-item">
              <i style={{ background: TONE_FILL[tone] }} />
              {t(TONE_LABEL[tone].de, TONE_LABEL[tone].en)}
            </span>
          ))}
        </div>
      )}

      {mesh.diagnostics.length > 0 && (
        <ul class="twin3d__diag" data-testid="twin3d-diagnostics">
          {mesh.diagnostics.map((d, i) => (
            <li key={i}>{d.message}</li>
          ))}
        </ul>
      )}

      {/* Structured textual scene tree — accessible fallback (BME-19 / T-04). */}
      <details class="twin3d__tree" data-testid="twin3d-tree">
        <summary>{t('Szenen-Struktur (barrierefrei)', 'Scene structure (accessible)')}</summary>
        <p class="module-panel__hint">
          {t(
            `${counts.total} Flächen: ${counts.wall} Wand, ${counts.floor} Boden, ${counts.ceiling} Decke, ${counts.roof} Dach, ${counts.pv} PV.`,
            `${counts.total} faces: ${counts.wall} wall, ${counts.floor} floor, ${counts.ceiling} ceiling, ${counts.roof} roof, ${counts.pv} PV.`,
          )}
        </p>
        <ul>
          {props.model.storeys.map((s) => {
            const sc = faceCounts({ faces: mesh.faces.filter((f) => f.storeyId === s.id), bounds: mesh.bounds, diagnostics: [] });
            return (
              <li key={s.id}>
                <strong>{s.name}</strong> — {t(`${s.walls.length} Wände, ${s.spaces.length} Räume`, `${s.walls.length} walls, ${s.spaces.length} rooms`)}
                {` · ${sc.total} ${t('Flächen', 'faces')}`}
              </li>
            );
          })}
        </ul>
      </details>
    </section>
  );
}
