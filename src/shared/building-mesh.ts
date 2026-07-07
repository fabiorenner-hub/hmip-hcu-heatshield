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

export type FaceKind = 'wall' | 'floor' | 'ceiling' | 'roof' | 'pv' | 'roofwin';

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

/**
 * A plane `nx·x + ny·y + nz·z = d` with the normal pointing UP (`nz ≥ 0`).
 * "Below the plane" (the side the roof solid is on) is `n·p ≤ d`.
 */
interface Plane { nx: number; ny: number; nz: number; d: number }

/** Newell-normal plane through a polygon; `null` if degenerate or near-vertical. */
function planeFromPolygon(verts: readonly Vec3[]): Plane | null {
  if (verts.length < 3) return null;
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < verts.length; i += 1) {
    const a = verts[i] as Vec3;
    const b = verts[(i + 1) % verts.length] as Vec3;
    nx += (a.y - b.y) * (a.z + b.z);
    ny += (a.z - b.z) * (a.x + b.x);
    nz += (a.x - b.x) * (a.y + b.y);
  }
  const len = Math.hypot(nx, ny, nz);
  if (len < 1e-9) return null;
  nx /= len; ny /= len; nz /= len;
  if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; }
  const v0 = verts[0] as Vec3;
  return { nx, ny, nz, d: nx * v0.x + ny * v0.y + nz * v0.z };
}

/**
 * Clip a polygon to the half-space at/below a plane (`n·p ≤ d`) via
 * Sutherland–Hodgman. Entirely-below → unchanged; entirely-above → `null`;
 * spanning → clipped with vertices inserted exactly on the plane. Used to trim
 * walls/ceilings under a roof so nothing pokes through the roof surface.
 */
function clipPolygonBelowPlane(verts: readonly Vec3[], p: Plane): Vec3[] | null {
  if (verts.length < 3) return null;
  const val = (v: Vec3): number => p.nx * v.x + p.ny * v.y + p.nz * v.z - p.d;
  const out: Vec3[] = [];
  for (let i = 0; i < verts.length; i += 1) {
    const cur = verts[i] as Vec3;
    const prev = verts[(i + verts.length - 1) % verts.length] as Vec3;
    const cIn = val(cur) <= 1e-6;
    const pIn = val(prev) <= 1e-6;
    const cross = (): Vec3 => {
      const va = val(prev);
      const vb = val(cur);
      const tt = va === vb ? 0 : va / (va - vb);
      return { x: prev.x + (cur.x - prev.x) * tt, y: prev.y + (cur.y - prev.y) * tt, z: prev.z + (cur.z - prev.z) * tt };
    };
    if (cIn) {
      if (!pIn) out.push(cross());
      out.push(cur);
    } else if (pIn) {
      out.push(cross());
    }
  }
  return out.length >= 3 ? out : null;
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

/**
 * Per-vertex MITERED offset points (left/right) of a wall polyline, so adjacent
 * segments share the same corner point — clean L-corners in the extruded mesh
 * (no gap/overlap). Closed loops (room walls) mitre the shared first/last
 * vertex too. Mirrors the 2D editor's `wallMiterOffsets`.
 */
function wallMiterOffsets(axis: Point[], half: number): { left: Point[]; right: Point[] } {
  const n = axis.length;
  const left: Point[] = new Array(n);
  const right: Point[] = new Array(n);
  const unit = (p: Point, q: Point): Point | null => {
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const len = Math.hypot(dx, dy);
    return len < 1e-9 ? null : { x: dx / len, y: dy / len };
  };
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
        normal = nIn;
      } else {
        const mUnit = { x: mx / mlen, y: my / mlen };
        const cosHalf = mUnit.x * nIn.x + mUnit.y * nIn.y;
        scale = half / Math.max(cosHalf, 0.25);
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

function emitWallSegmentFaces(
  sL: Point,
  eL: Point,
  sR: Point,
  eR: Point,
  z0: number,
  z1: number,
  holes: SegmentHole[],
): Vec3[][] {
  // Point at fraction `f` along the segment, height `z`, side +1 = outer (left
  // offset), -1 = inner (right offset). The offset lines run between the
  // MITERED corner points so segment sides meet cleanly at corners.
  const P = (f: number, z: number, side: number): Vec3 => {
    const s = side > 0 ? sL : sR;
    const e = side > 0 ? eL : eR;
    return { x: s.x + (e.x - s.x) * f, y: s.y + (e.y - s.y) * f, z };
  };
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
  const storeyTop = storey.elevationM + storey.heightM;
  // Kniestock / knee wall: the roof mounts on a low vertical wall above the
  // storey top, so the eaves (where the slope starts) sit `knee` metres higher.
  const knee = roof.type === 'flat' ? 0 : Math.max(0, roof.kneeHeightM ?? 0);
  const zBase = storeyTop + knee;
  const { minX, minY, maxX, maxY } = box;
  const pitch = (roof.pitchDeg * Math.PI) / 180;
  const face = (vertices: Vec3[]): MeshFace => ({ vertices, kind: 'roof', entityId: roof.id, storeyId: storey.id });
  // NOTE: a roof emits ONLY sloped surfaces. Every vertical closure — the knee
  // wall (Kniestock), gable triangles and the Krüppelwalm gablet — is WALL, not
  // roof. `buildMesh` extrudes the top storey's walls up to the ridge and clips
  // them to these roof planes, so the walls form those verticals themselves.

  // Roof overhang (Dachüberstand): the eaves extend `overhang` metres beyond
  // the walls on every side and hang DOWN the slope (z drops by overhang·tanθ),
  // while the ridge stays at the wall-span height. So we build the slopes on an
  // expanded footprint with a lowered eaves base; at the wall line the roof is
  // back at `zBase`, so wall clipping is unaffected.
  const overhang = Math.max(0, roof.overhangM ?? 0);
  const bMinX = minX - overhang;
  const bMinY = minY - overhang;
  const bMaxX = maxX + overhang;
  const bMaxY = maxY + overhang;
  const bSpanY = bMaxY - bMinY;
  const zEave = zBase - overhang * Math.tan(pitch);
  const bBox = { minX: bMinX, minY: bMinY, maxX: bMaxX, maxY: bMaxY };

  const flatCap = (): MeshFace[] => [
    face([
      { x: bMinX, y: bMinY, z: zEave },
      { x: bMaxX, y: bMinY, z: zEave },
      { x: bMaxX, y: bMaxY, z: zEave },
      { x: bMinX, y: bMaxY, z: zEave },
    ]),
  ];

  const slopes: MeshFace[] = ((): MeshFace[] => {
  switch (roof.type) {
    case 'flat':
      return flatCap();
    case 'shed': {
      const dh = bSpanY * Math.tan(pitch);
      return [
        face([
          { x: bMinX, y: bMinY, z: zEave },
          { x: bMaxX, y: bMinY, z: zEave },
          { x: bMaxX, y: bMaxY, z: zEave + dh },
          { x: bMinX, y: bMaxY, z: zEave + dh },
        ]),
      ];
    }
    case 'gable': {
      const midY = (bMinY + bMaxY) / 2;
      const ridgeZ = zEave + (bSpanY / 2) * Math.tan(pitch);
      // Two sloped rectangles (south + north) meeting at the ridge along x.
      const south = face([
        { x: bMinX, y: bMinY, z: zEave },
        { x: bMaxX, y: bMinY, z: zEave },
        { x: bMaxX, y: midY, z: ridgeZ },
        { x: bMinX, y: midY, z: ridgeZ },
      ]);
      const north = face([
        { x: bMinX, y: midY, z: ridgeZ },
        { x: bMaxX, y: midY, z: ridgeZ },
        { x: bMaxX, y: bMaxY, z: zEave },
        { x: bMinX, y: bMaxY, z: zEave },
      ]);
      // The two gable ends are VERTICAL → they are formed by the walls (clipped
      // to these slopes), not emitted as roof faces.
      return [south, north];
    }
    case 'hip':
      return hipFamilyFaces(roof, bBox, zEave, false, face);
    case 'half_hip':
      return hipFamilyFaces(roof, bBox, zEave, true, face);
    default:
      diagnostics.push({
        code: 'ROOF_TYPE_UNSUPPORTED',
        message: `Roof type "${roof.type as string}" is not yet modelled; showing a flat cap.`,
        refId: roof.id,
      });
      return flatCap();
  }
  })();
  return slopes;
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
    // Low-/high-u ends: the small hip triangle (sloped) only. The vertical
    // gablet below it (eaves→knee) is WALL, formed by clipping the end wall to
    // these slopes — a roof never emits a vertical face.
    face([W(uMin, vSknee, kneeZ), W(uMin, vNknee, kneeZ), W(u0, vMid, ridgeZ)]),
    face([W(uMax, vNknee, kneeZ), W(uMax, vSknee, kneeZ), W(u1, vMid, ridgeZ)]),
  ];
}

/** Build the full building mesh from the canonical model. */
export function buildMesh(model: BuildingModel, options?: BuildMeshOptions): BuildingMesh {
  const opts: Required<BuildMeshOptions> = {
    defaultWallHeightM: options?.defaultWallHeightM ?? 2.5,
  };
  const faces: MeshFace[] = [];
  const diagnostics: MeshDiagnostic[] = [];

  // 1. Roofs FIRST — they drive two things about the walls below them:
  //    (a) clip planes: every roof trims the structural geometry of its storey
  //        and everything above to the roof underside (nothing pokes through);
  //    (b) wall cap: the TOPMOST storey under a roof has its walls extruded all
  //        the way up to the ridge, then clipped — so the walls (not the roof)
  //        form the gable / Krüppelwalm gablet / Kniestock. A roof only ever
  //        emits sloped faces.
  const roofClips: Array<{ minElevationM: number; planes: Plane[] }> = [];
  const wallCapZ = new Map<string, number>();
  for (const roof of model.roofs) {
    const storey = model.storeys.find((s) => s.id === roof.storeyId);
    if (storey === undefined) continue;
    const roofFaces = buildRoofFaces(roof, storey, opts, diagnostics);
    faces.push(...roofFaces);
    const planes: Plane[] = [];
    let maxZ = -Infinity;
    for (const rf of roofFaces) {
      for (const v of rf.vertices) if (v.z > maxZ) maxZ = v.z;
      if (rf.kind !== 'roof') continue;
      const pl = planeFromPolygon(rf.vertices);
      if (pl !== null && pl.nz > 0.2) planes.push(pl); // only downward-capping planes
    }
    if (planes.length > 0) roofClips.push({ minElevationM: storey.elevationM, planes });
    // Topmost storey at/above the roof storey fills up to the ridge.
    const covered = model.storeys.filter((s) => s.elevationM >= storey.elevationM - 1e-6);
    const top = covered.reduce((a, b) => (b.elevationM > a.elevationM ? b : a), covered[0] ?? storey);
    if (Number.isFinite(maxZ)) wallCapZ.set(top.id, Math.max(wallCapZ.get(top.id) ?? -Infinity, maxZ));
  }

  // 2. Walls + rooms.
  for (const storey of model.storeys) {
    const z0 = storey.elevationM;
    const capZ = wallCapZ.get(storey.id);
    const wallTop = (w: Wall): number => {
      const normal = z0 + (w.heightM ?? storey.heightM ?? opts.defaultWallHeightM);
      // Under a roof, fill the top storey's walls up to the ridge; the roof
      // clip then trims them exactly to the slopes.
      return capZ !== undefined && capZ > normal ? capZ : normal;
    };

    // Walls → extruded boxes with MITERED corners + openings cut as holes.
    for (const wall of storey.walls) {
      const z1 = wallTop(wall);
      const miter = wallMiterOffsets(wall.axis, wall.thicknessM / 2);
      let segStartLen = 0;
      for (let i = 1; i < wall.axis.length; i += 1) {
        const a = wall.axis[i - 1] as Point;
        const b = wall.axis[i] as Point;
        const segLen = Math.hypot(b.x - a.x, b.y - a.y);
        if (segLen < 1e-9) continue;
        const holes = holesForSegment(wall, i - 1, segStartLen, segLen, z0, z1, storey.openings);
        const quads = emitWallSegmentFaces(
          miter.left[i - 1] as Point, miter.left[i] as Point,
          miter.right[i - 1] as Point, miter.right[i] as Point,
          z0, z1, holes,
        );
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

  // Roof windows (Dachfenster) — a panel set INTO the roof plane (hostRoofId),
  // never on a wall. Placed on the primary slope like the PV grid.
  for (const storey of model.storeys) {
    for (const o of storey.openings) {
      if (o.roofWindow !== true || o.hostRoofId === undefined) continue;
      const roof = model.roofs.find((r) => r.id === o.hostRoofId);
      if (roof === undefined) continue;
      const f = buildRoofWindowFace(o, roof, storey);
      if (f !== null) faces.push(f);
    }
  }

  // PV arrays — a module grid laid on the roof plane (BME-14).
  for (const pv of model.pvArrays) {
    faces.push(...buildPvFaces(pv, model));
  }

  // Trim structural faces (walls/ceilings/floors) to the underside of every
  // roof whose storey is at or below the face's storey — the roof clips the
  // rooms. Roof/PV/roof-window faces are left untouched.
  const finalFaces: MeshFace[] = roofClips.length === 0 ? faces : (() => {
    const elevById = new Map(model.storeys.map((s) => [s.id, s.elevationM]));
    const out: MeshFace[] = [];
    for (const f of faces) {
      if (f.kind !== 'wall' && f.kind !== 'floor' && f.kind !== 'ceiling') { out.push(f); continue; }
      const el = elevById.get(f.storeyId);
      let polys: Vec3[][] = [f.vertices];
      for (const rc of roofClips) {
        if (el === undefined || el < rc.minElevationM - 1e-6) continue; // roof storey + above
        for (const plane of rc.planes) {
          polys = polys.flatMap((poly) => { const c = clipPolygonBelowPlane(poly, plane); return c === null ? [] : [c]; });
        }
      }
      for (const poly of polys) out.push({ ...f, vertices: poly });
    }
    return out;
  })();

  return { faces: finalFaces, bounds: computeBounds(finalFaces), diagnostics };
}

/**
 * Place a roof window (Dachfenster) as a single quad ON the primary roof slope
 * (above any Kniestock), positioned along the ridge by `offsetM` and sized
 * `widthM` (along ridge) × `heightM` (up the slope). Returns `null` for a flat
 * roof (a Dachfenster needs a slope). Slightly offset above the surface so it
 * reads on top of the roof.
 */
function buildRoofWindowFace(opening: Opening, roof: Roof, storey: Storey): MeshFace | null {
  if (roof.type === 'flat' || roof.pitchDeg <= 0) return null;
  const box = bbox(storeyFootprint(storey));
  if (box === null) return null;
  const storeyTop = storey.elevationM + storey.heightM;
  const knee = Math.max(0, roof.kneeHeightM ?? 0);
  const zEaves = storeyTop + knee;
  const spanX = box.maxX - box.minX;
  const spanY = box.maxY - box.minY;
  const alongX = ridgeAlongX(roof, spanX, spanY);
  const uMin = alongX ? box.minX : box.minY;
  const uMax = alongX ? box.maxX : box.maxY;
  const vMin = alongX ? box.minY : box.minX;
  const vMax = alongX ? box.maxY : box.maxX;
  const vMid = (vMin + vMax) / 2;
  const pitch = (roof.pitchDeg * Math.PI) / 180;
  const rise = ((vMax - vMin) / 2) * Math.tan(pitch);
  const slopeLen = Math.hypot(vMid - vMin, rise);
  const nUp = 0.06;
  const W = (u: number, s: number): Vec3 => {
    const t = slopeLen <= 0 ? 0 : Math.max(0, Math.min(1, s / slopeLen));
    const v = vMin + t * (vMid - vMin);
    const z = zEaves + t * rise + nUp * Math.cos(pitch);
    const vv = v - nUp * Math.sin(pitch);
    return alongX ? { x: u, y: vv, z } : { x: vv, y: u, z };
  };
  const w = Math.min(opening.widthM, Math.max(0.1, uMax - uMin));
  const ua = Math.max(uMin, Math.min(uMax - w, uMin + opening.offsetM));
  const ub = ua + w;
  const sMid = slopeLen / 2;
  const sa = Math.max(0.05, sMid - opening.heightM / 2);
  const sb = Math.min(slopeLen - 0.05, sMid + opening.heightM / 2);
  return {
    kind: 'roofwin',
    entityId: opening.id,
    storeyId: storey.id,
    vertices: [W(ua, sa), W(ub, sa), W(ub, sb), W(ua, sb)],
  };
}

/**
 * Lay a PV module grid ON the hosting roof's INCLINED plane — never on the flat
 * storey "lid". Modules follow the roof pitch and sit above any knee wall
 * (Kniestock). For a sloped roof the grid is placed on the primary slope (the
 * eaves→ridge half facing the ridge-perpendicular direction), tilting with the
 * roof; a flat roof keeps a level grid on the cap. `columns` run along the
 * ridge, `rows` up the slope. Faces slightly offset (+0.05 m normal) so they
 * read above the roof surface.
 */
function buildPvFaces(pv: PvArray, model: BuildingModel): MeshFace[] {
  const roofId = (pv.roofFaceId.split(':')[0] ?? '');
  const roof = model.roofs.find((r) => r.id === roofId);
  if (roof === undefined) return [];
  const storey = model.storeys.find((s) => s.id === roof.storeyId);
  if (storey === undefined) return [];
  const box = bbox(storeyFootprint(storey));
  if (box === null) return [];
  const gap = pv.gapM ?? 0.02;
  const storeyTop = storey.elevationM + storey.heightM;
  const knee = roof.type === 'flat' ? 0 : Math.max(0, roof.kneeHeightM ?? 0);
  const zEaves = storeyTop + knee;

  // Flat roof → level grid centred on the cap (a touch above the surface).
  if (roof.type === 'flat' || roof.pitchDeg <= 0) {
    const z = zEaves + 0.05;
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
          kind: 'pv', entityId: pv.id, storeyId: roof.storeyId,
          vertices: [
            { x: mx, y: my, z }, { x: mx + pv.moduleWidthM, y: my, z },
            { x: mx + pv.moduleWidthM, y: my + pv.moduleHeightM, z }, { x: mx, y: my + pv.moduleHeightM, z },
          ],
        });
      }
    }
    return out;
  }

  // Sloped roof → place on the primary slope plane (eaves → ridge).
  const spanX = box.maxX - box.minX;
  const spanY = box.maxY - box.minY;
  const alongX = ridgeAlongX(roof, spanX, spanY);
  const uMin = alongX ? box.minX : box.minY;
  const uMax = alongX ? box.maxX : box.maxY;
  const vMin = alongX ? box.minY : box.minX;
  const vMax = alongX ? box.maxY : box.maxX;
  const vMid = (vMin + vMax) / 2;
  const pitch = (roof.pitchDeg * Math.PI) / 180;
  const rise = (vMax - vMin) / 2 * Math.tan(pitch);
  const slopeLen = Math.hypot(vMid - vMin, rise); // eaves→ridge distance on the plane
  // Roof-window footprints in (u along ridge, s up slope) — PV modules skip
  // these so a Dachfenster leaves a real cut-out in the array.
  const winRects: Array<{ ua: number; ub: number; sa: number; sb: number }> = [];
  for (const o of storey.openings) {
    if (o.roofWindow !== true || o.hostRoofId !== roof.id) continue;
    const ww = Math.min(o.widthM, Math.max(0.1, uMax - uMin));
    const wua = Math.max(uMin, Math.min(uMax - ww, uMin + o.offsetM));
    const sMidW = slopeLen / 2;
    winRects.push({ ua: wua, ub: wua + ww, sa: Math.max(0.05, sMidW - o.heightM / 2), sb: Math.min(slopeLen - 0.05, sMidW + o.heightM / 2) });
  }
  const overlapsWindow = (ua: number, ub: number, sa: number, sb: number): boolean =>
    winRects.some((wr) => ua < wr.ub && ub > wr.ua && sa < wr.sb && sb > wr.sa);
  // World point on the primary slope: `u` along ridge, `s` = metres up the
  // slope from the eaves. Normal offset lifts modules just above the surface.
  const nUp = 0.05; // small clearance along the plane normal
  const W = (u: number, s: number): Vec3 => {
    const t = slopeLen <= 0 ? 0 : s / slopeLen;
    const v = vMin + t * (vMid - vMin);
    const z = zEaves + t * rise + nUp * Math.cos(pitch);
    const vOff = -nUp * Math.sin(pitch); // pull slightly toward the eaves-normal
    const vv = v + vOff;
    return alongX ? { x: u, y: vv, z } : { x: vv, y: u, z };
  };
  // Grid extent: columns along u (ridge), rows up the slope. Clamp to the plane.
  const totalU = pv.columns * pv.moduleWidthM + (pv.columns - 1) * gap;
  const totalS = pv.rows * pv.moduleHeightM + (pv.rows - 1) * gap;
  const uCentre = (uMin + uMax) / 2;
  const u0 = uCentre - totalU / 2;
  const s0 = Math.max(0.1, (slopeLen - totalS) / 2); // centre up the slope, keep off the eaves
  const out: MeshFace[] = [];
  for (let r = 0; r < pv.rows; r += 1) {
    for (let c = 0; c < pv.columns; c += 1) {
      const ua = u0 + c * (pv.moduleWidthM + gap);
      const ub = ua + pv.moduleWidthM;
      const sa = s0 + r * (pv.moduleHeightM + gap);
      const sb = sa + pv.moduleHeightM;
      if (overlapsWindow(ua, ub, sa, sb)) continue; // leave a cut-out for roof windows
      out.push({
        kind: 'pv', entityId: pv.id, storeyId: roof.storeyId,
        vertices: [W(ua, sa), W(ub, sa), W(ub, sb), W(ua, sb)],
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
  roofwin: number;
  total: number;
}

/** Count faces by kind — handy for the structured scene tree (a11y) + tests. */
export function faceCounts(mesh: BuildingMesh): FaceCounts {
  const c: FaceCounts = { wall: 0, floor: 0, ceiling: 0, roof: 0, pv: 0, roofwin: 0, total: mesh.faces.length };
  for (const f of mesh.faces) c[f.kind] += 1;
  return c;
}
