/**
 * Heat Shield — Building mesh → binary glTF (GLB) exporter (BME-20).
 *
 * Dependency-free: emits a valid GLB 2.0 container (JSON chunk + BIN chunk) by
 * hand from the deterministic {@link BuildingMesh}. Faces are fan-triangulated
 * (all our faces are convex), grouped by {@link FaceKind} into one primitive
 * per material so the export is coloured (walls/roof/pv/…). Coordinates are
 * converted from the model's Z-up frame to glTF's Y-up right-handed frame via
 * (x, y, z) → (x, z, −y).
 *
 * PURE: no fs, no Buffer, no globals — returns a `Uint8Array` usable on both
 * Node (server route) and the browser.
 */

import { buildMesh, type BuildingMesh, type FaceKind, type Vec3 } from './building-mesh.js';
import type { BuildingModel } from './building-model.js';

const KIND_ORDER: readonly FaceKind[] = ['wall', 'floor', 'ceiling', 'roof', 'pv'];

const KIND_COLOR: Record<FaceKind, [number, number, number, number]> = {
  wall: [0.9, 0.93, 0.96, 1],
  floor: [0.23, 0.51, 0.96, 1],
  ceiling: [0.6, 0.65, 0.72, 1],
  roof: [0.96, 0.62, 0.04, 1],
  pv: [0.23, 0.51, 1, 1],
};

interface Primitive {
  kind: FaceKind;
  positions: Float32Array;
  indices: Uint32Array;
  min: [number, number, number];
  max: [number, number, number];
}

function toGltf(v: Vec3): [number, number, number] {
  return [v.x, v.z, -v.y];
}

function align4(n: number): number {
  return (n + 3) & ~3;
}

function buildPrimitives(mesh: BuildingMesh): Primitive[] {
  const prims: Primitive[] = [];
  for (const kind of KIND_ORDER) {
    const faces = mesh.faces.filter((f) => f.kind === kind);
    if (faces.length === 0) continue;
    const pos: number[] = [];
    const idx: number[] = [];
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    let base = 0;
    for (const f of faces) {
      const verts = f.vertices.map(toGltf);
      for (const p of verts) {
        pos.push(p[0], p[1], p[2]);
        if (p[0] < min[0]) min[0] = p[0];
        if (p[1] < min[1]) min[1] = p[1];
        if (p[2] < min[2]) min[2] = p[2];
        if (p[0] > max[0]) max[0] = p[0];
        if (p[1] > max[1]) max[1] = p[1];
        if (p[2] > max[2]) max[2] = p[2];
      }
      // Fan-triangulate the convex polygon.
      for (let i = 1; i + 1 < verts.length; i += 1) {
        idx.push(base, base + i, base + i + 1);
      }
      base += verts.length;
    }
    prims.push({ kind, positions: new Float32Array(pos), indices: new Uint32Array(idx), min, max });
  }
  return prims;
}

/** Serialise a building mesh into a GLB (binary glTF) byte array. */
export function meshToGlb(mesh: BuildingMesh): Uint8Array {
  const prims = buildPrimitives(mesh);

  // ---- assemble the binary buffer + bufferViews/accessors ----------------
  const bufferViews: Array<Record<string, number>> = [];
  const accessors: Array<Record<string, unknown>> = [];
  const chunks: Uint8Array[] = [];
  let byteOffset = 0;

  const meshPrimitives: Array<Record<string, unknown>> = [];
  const materials: Array<Record<string, unknown>> = [];

  prims.forEach((prim, i) => {
    // POSITION bufferView.
    const posBytes = new Uint8Array(prim.positions.buffer, prim.positions.byteOffset, prim.positions.byteLength);
    const posView = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset, byteLength: posBytes.byteLength });
    chunks.push(posBytes);
    byteOffset += posBytes.byteLength;
    const posPad = align4(byteOffset) - byteOffset;
    if (posPad > 0) { chunks.push(new Uint8Array(posPad)); byteOffset += posPad; }
    const posAccessor = accessors.length;
    accessors.push({
      bufferView: posView,
      componentType: 5126, // FLOAT
      count: prim.positions.length / 3,
      type: 'VEC3',
      min: prim.min,
      max: prim.max,
    });

    // Indices bufferView.
    const idxBytes = new Uint8Array(prim.indices.buffer, prim.indices.byteOffset, prim.indices.byteLength);
    const idxView = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset, byteLength: idxBytes.byteLength });
    chunks.push(idxBytes);
    byteOffset += idxBytes.byteLength;
    const idxPad = align4(byteOffset) - byteOffset;
    if (idxPad > 0) { chunks.push(new Uint8Array(idxPad)); byteOffset += idxPad; }
    const idxAccessor = accessors.length;
    accessors.push({
      bufferView: idxView,
      componentType: 5125, // UNSIGNED_INT
      count: prim.indices.length,
      type: 'SCALAR',
    });

    const color = KIND_COLOR[prim.kind];
    materials.push({
      name: prim.kind,
      pbrMetallicRoughness: { baseColorFactor: color, metallicFactor: prim.kind === 'pv' ? 0.6 : 0.0, roughnessFactor: 0.8 },
      doubleSided: true,
    });
    meshPrimitives.push({ attributes: { POSITION: posAccessor }, indices: idxAccessor, material: i });
  });

  const binLength = byteOffset;
  const gltf = {
    asset: { version: '2.0', generator: 'HeatShield Building Studio' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'building' }],
    meshes: [{ primitives: meshPrimitives }],
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: binLength }],
  };

  // ---- GLB container -----------------------------------------------------
  const enc = new TextEncoder();
  let jsonBytes = enc.encode(JSON.stringify(gltf));
  const jsonPad = align4(jsonBytes.length) - jsonBytes.length;
  if (jsonPad > 0) {
    const padded = new Uint8Array(jsonBytes.length + jsonPad);
    padded.set(jsonBytes);
    padded.fill(0x20, jsonBytes.length); // pad JSON with spaces
    jsonBytes = padded;
  }

  const bin = new Uint8Array(binLength);
  {
    let o = 0;
    for (const ch of chunks) {
      bin.set(ch, o);
      o += ch.byteLength;
    }
  }

  const total = 12 + 8 + jsonBytes.length + 8 + bin.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  let p = 0;
  dv.setUint32(p, 0x46546c67, true); p += 4; // "glTF"
  dv.setUint32(p, 2, true); p += 4; // version
  dv.setUint32(p, total, true); p += 4; // total length
  dv.setUint32(p, jsonBytes.length, true); p += 4;
  dv.setUint32(p, 0x4e4f534a, true); p += 4; // "JSON"
  out.set(jsonBytes, p); p += jsonBytes.length;
  dv.setUint32(p, bin.length, true); p += 4;
  dv.setUint32(p, 0x004e4942, true); p += 4; // "BIN\0"
  out.set(bin, p);
  return out;
}

/** Convenience: build the mesh for a model and export it as GLB. */
export function modelToGlb(model: BuildingModel): Uint8Array {
  return meshToGlb(buildMesh(model));
}
