/**
 * Heat Shield — deterministic Building mesh builder (digital-twin-renderer T-01).
 *
 * Turns the canonical {@link BuildingModel} into a set of flat polygon faces
 * (walls extruded to storey height, floor/ceiling polygons from rooms, and
 * parametric roof faces). This is the SINGLE geometry source the 3D preview
 * renders; renderer-specific meshes are NEVER persisted (blueprint §3D).
 *
 * Coordinate frame: x = east (m), y = north (m), z = up (m). Deterministic for
 * a given model — no randomness, no globals.
 *
 * PURE, ZOD-FREE: imports only TYPES from `building-model.ts` (erased), so the
 * SPA stays free of the Zod runtime.
 *
 * Roof generators implemented: flat, gable, shed, hip, half_hip. `half_hip`
 * (Krüppelwalm) is a DISTINCT generator, not a visual approximation of `hip`
 * (steering): a vertical gablet fills the lower end and only the upper part is
 * hipped back to a shortened ridge. The ridge axis honours `ridgeAzimuthDeg`
 * when present, otherwise it follows the longer footprint axis.
 */

import type { BuildingModel, Opening, Point, PvArray, Roof, Storey, Wall } from './building-model.js';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export type FaceKind = 'wall' | 'floor' | 'ceiling' | 'roof' | 'pv';

export interface MeshFace {
  vertices: Vec3[];
  kind: FaceKind;
  /** Canonical entity id this face belongs to (wall/space/roof/storey). */
  entityId: string;
  /** Storey the face belongs to (for isolation). */
  storeyId: string;
}

export interface MeshDiagnostic {
  code: 'ROOF_TYPE_UNSUPPORTED' | 'STOREY_NO_FOOTPRINT';
  message: string;
  refId?: string;
}

export interface BuildingMesh {
  faces: MeshFace[];
  bounds: { min: Vec3; max: Vec3 };
  diagnostics: MeshDiagnostic[];
}

export interface BuildMeshOptions {
  /** Default wall height when a storey/wall does not specify one (m). */
  defaultWallHeightM?: number;
}

/**
 * Clip a polygon (3D vertices, planar or not) against the half-space `z ≤ cutZ`,
 * returning the portion at or below the cut plane. Standard Sutherland–Hodgman
 * clip against a single horizontal plane:
 *   - a polygon entirely below the plane is returned unchanged,
 *   - a polygon entirely above returns `null` (nothing survives),
 *   - a spanning polygon is clipped, inserting intersection vertices on the
 *     plane so the cut edge is straight.
 * Used by the 3D twin's section/clipping-plane view. Pure.
 */
export function clipPolygonBelowZ(vertices: readonly Vec3[], cutZ: number): Vec3[] | null {
  if (vertices.length < 3) return null;
  const out: Vec3[] = [];
  const inside = (v: Vec3): boolean => v.z <= cutZ;
  const intersect = (a: Vec3, b: Vec3): Vec3 => {
    const dz = b.z - a.z;
    const tt = dz === 0 ? 0 : (cutZ - a.z) / dz;
    return { x: a.x + (b.x - a.x) * tt, y: a.y + (b.y - a.y) * tt, z: cutZ };
  };
  for (let i = 0; i < vertices.length; i += 1) {
    const cur = vertices[i] as Vec3;
    const prev = vertices[(i + vertices.length - 1) % vertices.length] as Vec3;
    const curIn = inside(cur);
    const prevIn = inside(prev);
    if (curIn) {
      if (!prevIn) out.push(intersect(prev, cur));
      out.push(cur);
    } else if (prevIn) {
      out.push(intersect(prev, cur));
    }
  }
  return out.length >= 3 ? out : null;
}

function normalize(dx: number, dy: number): { x: number; y: number } {
  const len = Math.hypot(dx, dy);
  return len === 0 ? { x: 0, y: 0 } : { x: dx / len, y: dy / len };
}

function bbox(points: Point[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (points.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Emit the faces of one wall segment (a→b, thickness t) between z0..z1, cutting
 * rectangular holes for the given openings. `openings` are expressed in local
 * fractions along the segment (0..1) plus absolute sill/head heights. With no
 * openings this returns the classic 6-face box (bottom, top, 2 ends, 2 sides).
 * With openings, each long side is tiled into solid panels + sill/head strips
 * around the holes, and each hole gets 4 reveal faces (2 jambs, sill top, head
 * bottom) so the void reads as a real opening.
 */
interface SegmentHole {
  f0: number;
  f1: number;
  sillZ: number;
  headZ: number;
}

function emitWallSegmentFaces(
  a: Point,
  b: Point,
  t: number,
  z0: number,
  z1: number,
  holes: SegmentHole[],
): Vec3[][] {
  const dir = normalize(b.x - a.x, b.y - a.y);
  const nx = -dir.y * (t / 2);
  const ny = dir.x * (t / 2);
  // Point at fraction `f` along the segment, height `z`, on side (+1 outer / -1 inner).
  const P = (f: number, z: number, side: number): Vec3 => ({
    x: a.x + (b.x - a.x) * f + nx * side,
    y: a.y + (b.y - a.y) * f + ny * side,
    z,
  });
  const faces: Vec3[][] = [];
  // Bottom, top, and the two end caps are always full.
  faces.push([P(0, z0, 1), P(1, z0, 1), P(1, z0, -1), P(0, z0, -1)]);
  faces.push([P(0, z1, 1), P(1, z1, 1), P(1, z1, -1), P(0, z1, -1)]);
  faces.push([P(0, z0, 1), P(0, z1, 1), P(0, z1, -1), P(0, z0, -1)]);
  faces.push([P(1, z0, 1), P(1, z1, 1), P(1, z1, -1), P(1, z0, -1)]);

  const sorted = [...holes].sort((h1, h2) => h1.f0 - h2.f0);
  const panel = (fa: number, fb: number, za: number, zb: number, side: number): void => {
    if (fb - fa <= 1e-6 || zb - za <= 1e-6) return;
    faces.push([P(fa, za, side), P(fb, za, side), P(fb, zb, side), P(fa, zb, side)]);
  };
  for (const side of [1, -1]) {
    let cursor = 0;
    for (const h of sorted) {
      if (h.f0 > cursor) panel(cursor, h.f0, z0, z1, side); // solid before the hole
      panel(h.f0, h.f1, z0, h.sillZ, side); // below the opening
      panel(h.f0, h.f1, h.headZ, z1, side); // above the opening
      cursor = Math.max(cursor, h.f1);
    }
    if (cursor < 1) panel(cursor, 1, z0, z1, side); // solid after the last hole
  }
  // Reveals around each hole (connect outer ↔ inner).
  for (const h of sorted) {
    faces.push([P(h.f0, h.sillZ, 1), P(h.f0, h.headZ, 1), P(h.f0, h.headZ, -1), P(h.f0, h.sillZ, -1)]);
    faces.push([P(h.f1, h.sillZ, 1), P(h.f1, h.headZ, 1), P(h.f1, h.headZ, -1), P(h.f1, h.sillZ, -1)]);
    faces.push([P(h.f0, h.sillZ, 1), P(h.f1, h.sillZ, 1), P(h.f1, h.sillZ, -1), P(h.f0, h.sillZ, -1)]);
    faces.push([P(h.f0, h.headZ, 1), P(h.f1, h.headZ, 1), P(h.f1, h.headZ, -1), P(h.f0, h.headZ, -1)]);
  }
  return faces;
}

/** Map a wall's openings onto per-segment holes in local fractions. */
function holesForSegment(
  wall: Wall,
  segIndex: number,
  segStartLen: number,
  segLen: number,
  z0: number,
  z1: number,
  openings: Opening[],
): SegmentHole[] {
  const out: SegmentHole[] = [];
  if (segLen <= 0) return out;
  for (const o of openings) {
    if (o.hostWallId !== wall.id) continue;
    const oStart = o.offsetM;
    const oEnd = o.offsetM + o.widthM;
    const segEndLen = segStartLen + segLen;
    // Intersect the opening span with this segment's span along the wall.
    const s = Math.max(oStart, segStartLen);
    const e = Math.min(oEnd, segEndLen);
    if (e - s <= 1e-6) continue;
    const f0 = (s - segStartLen) / segLen;
    const f1 = (e - segStartLen) / segLen;
    const sillZ = Math.max(z0 + 1e-3, z0 + o.sillM);
    const headZ = Math.min(z1 - 1e-3, z0 + o.sillM + o.heightM);
    if (headZ - sillZ <= 1e-3) continue;
    out.push({ f0, f1, sillZ, headZ });
    void segIndex;
  }
  return out;
}

function storeyFootprint(storey: Storey): Point[] {
  return storey.walls.flatMap((w) => w.axis);
}

function buildRoofFaces(
  roof: Roof,
  storey: Storey,
  opts: Required<BuildMeshOptions>,
  diagnostics: MeshDiagnostic[],
): MeshFace[] {
  const box = bbox(storeyFootprint(storey));
  if (box === null) {
    diagnostics.push({ code: 'STOREY_NO_FOOTPRINT', message: `Storey ${storey.name} has no walls for the roof footprint.`, refId: roof.id });
    return [];
  }
  const zBase = storey.elevationM + storey.heightM;
  const { minX, minY, maxX, maxY } = box;
  const spanY = maxY - minY;
  const pitch = (roof.pitchDeg * Math.PI) / 180;
  const face = (vertices: Vec3[]): MeshFace => ({ vertices, kind: 'roof', entityId: roof.id, storeyId: storey.id });

  const flatCap = (): MeshFace[] => [
    face([
      { x: minX, y: minY, z: zBase },
      { x: maxX, y: minY, z: zBase },
      { x: maxX, y: maxY, z: zBase },
      { x: minX, y: maxY, z: zBase },
    ]),
  ];

  switch (roof.type) {
    case 'flat':
      return flatCap();
    case 'shed': {
      const dh = spanY * Math.tan(pitch);
      return [
        face([
          { x: minX, y: minY, z: zBase },
          { x: maxX, y: minY, z: zBase },
          { x: maxX, y: maxY, z: zBase + dh },
          { x: minX, y: maxY, z: zBase + dh },
        ]),
      ];
    }
    case 'gable': {
      const midY = (minY + maxY) / 2;
      const ridgeZ = zBase + (spanY / 2) * Math.tan(pitch);
      // Two sloped rectangles (south + north) meeting at the ridge along x.
      const south = face([
        { x: minX, y: minY, z: zBase },
        { x: maxX, y: minY, z: zBase },
        { x: maxX, y: midY, z: ridgeZ },
        { x: minX, y: midY, z: ridgeZ },
      ]);
      const north = face([
        { x: minX, y: midY, z: ridgeZ },
        { x: maxX, y: midY, z: ridgeZ },
        { x: maxX, y: maxY, z: zBase },
        { x: minX, y: maxY, z: zBase },
      ]);
      // Two gable end triangles.
      const west = face([
        { x: minX, y: minY, z: zBase },
        { x: minX, y: midY, z: ridgeZ },
        { x: minX, y: maxY, z: zBase },
      ]);
      const east = face([
        { x: maxX, y: minY, z: zBase },
        { x: maxX, y: midY, z: ridgeZ },
        { x: maxX, y: maxY, z: zBase },
      ]);
      return [south, north, west, east];
    }
    case 'hip':
      return hipFamilyFaces(roof, box, zBase, false, face);
    case 'half_hip':
      return hipFamilyFaces(roof, box, zBase, true, face);
    default:
      diagnostics.push({
        code: 'ROOF_TYPE_UNSUPPORTED',
        message: `Roof type "${roof.type as string}" is not yet modelled; showing a flat cap.`,
        refId: roof.id,
      });
      return flatCap();
  }
}

/**
 * Choose the ridge axis. `ridgeAzimuthDeg` (0 = local +y/north, 90 = +x/east,
 * clockwise) is snapped to the nearest cardinal: an east–west ridge (~90/270°)
 * runs along X, a north–south ridge (~0/180°) along Y. Without the hint the
 * ridge follows the longer footprint axis (the conventional default).
 */
function ridgeAlongX(roof: Roof, spanX: number, spanY: number): boolean {
  if (roof.ridgeAzimuthDeg !== undefined) {
    const a = ((roof.ridgeAzimuthDeg % 180) + 180) % 180; // [0,180)
    return Math.abs(a - 90) < 45;
  }
  return spanX >= spanY;
}

/** Fraction of the ridge height that is hipped (upper part) for a Krüppelwalm. */
const HALF_HIP_FRACTION = 0.5;

/**
 * Hip (`half=false`) and half-hip / Krüppelwalm (`half=true`) generator over
 * the axis-aligned footprint box. Works in a normalised (u along ridge, v
 * across) frame and maps back to world, so both ridge orientations share one
 * implementation.
 *
 * Hip: two trapezoidal main slopes + two triangular hip ends meeting a ridge
 * inset by half the cross-span (equal pitch on all four faces; a square gives a
 * pyramidal/Zeltdach cap). Half-hip: the ends are a vertical gablet (eaves →
 * knee) capped by a small hip triangle (knee → shortened ridge); the main
 * slopes become planar hexagons so the surfaces stay watertight.
 */
function hipFamilyFaces(
  roof: Roof,
  box: { minX: number; minY: number; maxX: number; maxY: number },
  zBase: number,
  half: boolean,
  face: (vertices: Vec3[]) => MeshFace,
): MeshFace[] {
  const { minX, minY, maxX, maxY } = box;
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const alongX = ridgeAlongX(roof, spanX, spanY);
  const uMin = alongX ? minX : minY;
  const uMax = alongX ? maxX : maxY;
  const vMin = alongX ? minY : minX;
  const vMax = alongX ? maxY : maxX;
  const uSpan = uMax - uMin;
  const vSpan = vMax - vMin;
  const vMid = (vMin + vMax) / 2;
  const pitch = (roof.pitchDeg * Math.PI) / 180;
  const ridgeZ = zBase + (vSpan / 2) * Math.tan(pitch);
  // World mapper: u runs along the ridge, v across it.
  const W = (u: number, v: number, z: number): Vec3 =>
    alongX ? { x: u, y: v, z } : { x: v, y: u, z };

  if (!half) {
    const d = Math.min(vSpan / 2, uSpan / 2);
    const u0 = uMin + d;
    const u1 = uMax - d;
    return [
      face([W(uMin, vMin, zBase), W(uMax, vMin, zBase), W(u1, vMid, ridgeZ), W(u0, vMid, ridgeZ)]),
      face([W(uMax, vMax, zBase), W(uMin, vMax, zBase), W(u0, vMid, ridgeZ), W(u1, vMid, ridgeZ)]),
      face([W(uMin, vMax, zBase), W(uMin, vMin, zBase), W(u0, vMid, ridgeZ)]),
      face([W(uMax, vMin, zBase), W(uMax, vMax, zBase), W(u1, vMid, ridgeZ)]),
    ];
  }

  const hf = HALF_HIP_FRACTION;
  const d = Math.min((vSpan / 2) * hf, uSpan / 2);
  const u0 = uMin + d;
  const u1 = uMax - d;
  const kneeZ = zBase + (1 - hf) * (ridgeZ - zBase);
  const vSknee = vMin + (1 - hf) * (vMid - vMin);
  const vNknee = vMax - (1 - hf) * (vMax - vMid);
  return [
    // South + north main slopes (planar hexagons: eaves, knee corners, ridge).
    face([
      W(uMin, vSknee, kneeZ), W(uMin, vMin, zBase), W(uMax, vMin, zBase),
      W(uMax, vSknee, kneeZ), W(u1, vMid, ridgeZ), W(u0, vMid, ridgeZ),
    ]),
    face([
      W(uMax, vNknee, kneeZ), W(uMax, vMax, zBase), W(uMin, vMax, zBase),
      W(uMin, vNknee, kneeZ), W(u0, vMid, ridgeZ), W(u1, vMid, ridgeZ),
    ]),
    // Low-u end: small hip triangle above a vertical gablet.
    face([W(uMin, vSknee, kneeZ), W(uMin, vNknee, kneeZ), W(u0, vMid, ridgeZ)]),
    face([W(uMin, vMin, zBase), W(uMin, vMax, zBase), W(uMin, vNknee, kneeZ), W(uMin, vSknee, kneeZ)]),
    // High-u end.
    face([W(uMax, vNknee, kneeZ), W(uMax, vSknee, kneeZ), W(u1, vMid, ridgeZ)]),
    face([W(uMax, vMax, zBase), W(uMax, vMin, zBase), W(uMax, vSknee, kneeZ), W(uMax, vNknee, kneeZ)]),
  ];
}

/** Build the full building mesh from the canonical model. */
export function buildMesh(model: BuildingModel, options?: BuildMeshOptions): BuildingMesh {
  const opts: Required<BuildMeshOptions> = {
    defaultWallHeightM: options?.defaultWallHeightM ?? 2.5,
  };
  const faces: MeshFace[] = [];
  const diagnostics: MeshDiagnostic[] = [];

  for (const storey of model.storeys) {
    const z0 = storey.elevationM;
    const wallTop = (w: Wall): number => z0 + (w.heightM ?? storey.heightM ?? opts.defaultWallHeightM);

    // Walls → extruded boxes with openings cut as holes.
    for (const wall of storey.walls) {
      const z1 = wallTop(wall);
      let segStartLen = 0;
      for (let i = 1; i < wall.axis.length; i += 1) {
        const a = wall.axis[i - 1] as Point;
        const b = wall.axis[i] as Point;
        const segLen = Math.hypot(b.x - a.x, b.y - a.y);
        const holes = holesForSegment(wall, i - 1, segStartLen, segLen, z0, z1, storey.openings);
        const quads = emitWallSegmentFaces(a, b, wall.thicknessM, z0, z1, holes);
        for (const q of quads) faces.push({ vertices: q, kind: 'wall', entityId: wall.id, storeyId: storey.id });
        segStartLen += segLen;
      }
    }

    // Rooms → floor + ceiling polygons.
    const z1Storey = z0 + (storey.heightM || opts.defaultWallHeightM);
    for (const space of storey.spaces) {
      faces.push({ vertices: space.polygon.map((p) => ({ x: p.x, y: p.y, z: z0 })), kind: 'floor', entityId: space.id, storeyId: storey.id });
      faces.push({ vertices: space.polygon.map((p) => ({ x: p.x, y: p.y, z: z1Storey })), kind: 'ceiling', entityId: space.id, storeyId: storey.id });
    }
  }

  // Roofs.
  for (const roof of model.roofs) {
    const storey = model.storeys.find((s) => s.id === roof.storeyId);
    if (storey === undefined) continue;
    faces.push(...buildRoofFaces(roof, storey, opts, diagnostics));
  }

  // PV arrays — a module grid laid on the roof footprint (BME-14).
  for (const pv of model.pvArrays) {
    faces.push(...buildPvFaces(pv, model));
  }

  return { faces, bounds: computeBounds(faces), diagnostics };
}

/** Lay a PV module grid, centred on the hosting roof's storey footprint. */
function buildPvFaces(pv: PvArray, model: BuildingModel): MeshFace[] {
  const roofId = (pv.roofFaceId.split(':')[0] ?? '');
  const roof = model.roofs.find((r) => r.id === roofId);
  if (roof === undefined) return [];
  const storey = model.storeys.find((s) => s.id === roof.storeyId);
  if (storey === undefined) return [];
  const box = bbox(storeyFootprint(storey));
  if (box === null) return [];
  const z = storey.elevationM + storey.heightM + 0.05;
  const gap = pv.gapM ?? 0.02;
  const totalW = pv.columns * pv.moduleWidthM + (pv.columns - 1) * gap;
  const totalD = pv.rows * pv.moduleHeightM + (pv.rows - 1) * gap;
  const cx = (box.minX + box.maxX) / 2;
  const cy = (box.minY + box.maxY) / 2;
  const x0 = cx - totalW / 2;
  const y0 = cy - totalD / 2;
  const out: MeshFace[] = [];
  for (let r = 0; r < pv.rows; r += 1) {
    for (let c = 0; c < pv.columns; c += 1) {
      const mx = x0 + c * (pv.moduleWidthM + gap);
      const my = y0 + r * (pv.moduleHeightM + gap);
      out.push({
        kind: 'pv',
        entityId: pv.id,
        storeyId: roof.storeyId,
        vertices: [
          { x: mx, y: my, z },
          { x: mx + pv.moduleWidthM, y: my, z },
          { x: mx + pv.moduleWidthM, y: my + pv.moduleHeightM, z },
          { x: mx, y: my + pv.moduleHeightM, z },
        ],
      });
    }
  }
  return out;
}

function computeBounds(faces: MeshFace[]): { min: Vec3; max: Vec3 } {
  if (faces.length === 0) {
    return { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
  }
  const min: Vec3 = { x: Infinity, y: Infinity, z: Infinity };
  const max: Vec3 = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const f of faces) {
    for (const v of f.vertices) {
      if (v.x < min.x) min.x = v.x;
      if (v.y < min.y) min.y = v.y;
      if (v.z < min.z) min.z = v.z;
      if (v.x > max.x) max.x = v.x;
      if (v.y > max.y) max.y = v.y;
      if (v.z > max.z) max.z = v.z;
    }
  }
  return { min, max };
}

export interface FaceCounts {
  wall: number;
  floor: number;
  ceiling: number;
  roof: number;
  pv: number;
  total: number;
}

/** Count faces by kind — handy for the structured scene tree (a11y) + tests. */
export function faceCounts(mesh: BuildingMesh): FaceCounts {
  const c: FaceCounts = { wall: 0, floor: 0, ceiling: 0, roof: 0, pv: 0, total: mesh.faces.length };
  for (const f of mesh.faces) c[f.kind] += 1;
  return c;
}
