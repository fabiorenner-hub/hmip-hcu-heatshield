/**
 * Heat Shield — automatic room detection (building-model-editor BME-10).
 *
 * Finds the minimal enclosed faces (rooms) of the wall graph on a storey via
 * planar face traversal:
 *
 *   1. break every wall axis into segments;
 *   2. snap endpoints to a tolerance so shared corners unify into one node;
 *   3. build undirected edges + directed half-edges;
 *   4. sort each node's incident half-edges by angle;
 *   5. trace faces by always taking the "next clockwise" half-edge after the
 *      reverse of the arriving edge — this walks each bounded face exactly once;
 *   6. keep clockwise-oriented faces (the interior rooms) and drop the single
 *      counter-clockwise outer boundary and any degenerate slivers.
 *
 * PURE: no fs, no network, no globals, no Zod. Deterministic for a given input.
 */

import type { Point, Wall } from './building-model.js';
import { BUILDING_TOLERANCES } from './building-tolerances.js';

export interface DetectedRoom {
  /** Face polygon, CCW-normalised, first point NOT repeated at the end. */
  polygon: Point[];
  areaM2: number;
}

interface Node {
  point: Point;
}

function key(p: Point, tol: number): string {
  const q = tol > 0 ? tol : 1e-6;
  return `${Math.round(p.x / q)}:${Math.round(p.y / q)}`;
}

function shoelace(polygon: Point[]): number {
  let sum = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i] as Point;
    const b = polygon[(i + 1) % polygon.length] as Point;
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2; // signed: >0 CCW, <0 CW
}

/**
 * Detect enclosed rooms from a set of walls. `toleranceM` unifies endpoints
 * that are within that distance (default 5 cm).
 */
export function detectRooms(walls: Wall[], toleranceM = BUILDING_TOLERANCES.roomSnapM): DetectedRoom[] {
  // 1+2: nodes (snapped) and 3: undirected edges.
  const nodes: Node[] = [];
  const nodeIndex = new Map<string, number>();
  const nodeId = (p: Point): number => {
    const k = key(p, toleranceM);
    const existing = nodeIndex.get(k);
    if (existing !== undefined) return existing;
    const id = nodes.length;
    nodes.push({ point: p });
    nodeIndex.set(k, id);
    return id;
  };

  const edgeSet = new Set<string>();
  const adjacency = new Map<number, Set<number>>();
  const addEdge = (a: number, b: number): void => {
    if (a === b) return;
    const ek = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (edgeSet.has(ek)) return;
    edgeSet.add(ek);
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    if (!adjacency.has(b)) adjacency.set(b, new Set());
    adjacency.get(a)!.add(b);
    adjacency.get(b)!.add(a);
  };

  for (const wall of walls) {
    for (let i = 1; i < wall.axis.length; i += 1) {
      addEdge(nodeId(wall.axis[i - 1] as Point), nodeId(wall.axis[i] as Point));
    }
  }

  // 4: per-node neighbours sorted by angle (ascending).
  const angle = (from: number, to: number): number =>
    Math.atan2(nodes[to]!.point.y - nodes[from]!.point.y, nodes[to]!.point.x - nodes[from]!.point.x);
  const sortedNeighbours = new Map<number, number[]>();
  for (const [n, neigh] of adjacency) {
    sortedNeighbours.set(n, [...neigh].sort((x, y) => angle(n, x) - angle(n, y)));
  }

  // 5: trace faces via half-edges. `next(u,v)`: arriving at v from u, take the
  // neighbour of v that comes clockwise-next after u in v's angular order
  // (i.e. the previous entry, wrapping) — this hugs one face.
  const visited = new Set<string>();
  const heKey = (u: number, v: number): string => `${u}>${v}`;
  const nextHalfEdge = (u: number, v: number): [number, number] | null => {
    const around = sortedNeighbours.get(v);
    if (around === undefined || around.length === 0) return null;
    const idx = around.indexOf(u);
    if (idx === -1) return null;
    const prev = around[(idx - 1 + around.length) % around.length] as number;
    return [v, prev];
  };

  const faces: DetectedRoom[] = [];
  for (const [a, neigh] of adjacency) {
    for (const b of neigh) {
      if (visited.has(heKey(a, b))) continue;
      // Walk the face starting with half-edge a→b.
      const poly: number[] = [];
      let cu = a;
      let cv = b;
      let guard = 0;
      const limit = edgeSet.size * 2 + 4;
      while (guard < limit) {
        guard += 1;
        visited.add(heKey(cu, cv));
        poly.push(cu);
        const nxt = nextHalfEdge(cu, cv);
        if (nxt === null) break;
        [cu, cv] = nxt;
        if (cu === a && cv === b) break;
      }
      if (poly.length < 3) continue;
      const polygon = poly.map((id) => nodes[id]!.point);
      const signed = shoelace(polygon);
      // With the clockwise-next rule, the bounded interior faces trace CCW
      // (signed > 0); the single unbounded outer boundary traces CW (signed
      // < 0). Keep the CCW interiors, drop the outer and tiny slivers.
      if (signed > 1e-6) {
        faces.push({ polygon, areaM2: signed });
      }
    }
  }

  // Sort largest-first for stable, useful ordering.
  return faces.sort((x, y) => y.areaM2 - x.areaM2);
}

/** Ray-cast point-in-polygon (polygon as ordered vertices). */
export function pointInPolygon(p: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i] as Point;
    const b = polygon[j] as Point;
    const intersect =
      a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Centroid of a polygon's vertices (simple average — adequate for dedupe). */
export function centroid(polygon: Point[]): Point {
  const n = polygon.length || 1;
  let x = 0;
  let y = 0;
  for (const pt of polygon) {
    x += pt.x;
    y += pt.y;
  }
  return { x: x / n, y: y / n };
}
