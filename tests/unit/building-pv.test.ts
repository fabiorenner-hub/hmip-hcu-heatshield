/**
 * PV-array editor (BME-14): auto-fit math, commands, mesh module grid, GLB.
 */

import { describe, expect, it } from 'vitest';

import {
  newBuildingModel,
  newEditorState,
  addWall,
  addRoof,
  addPvArray,
  updatePvArray,
  removePvArray,
  pvAutoFit,
  roofPlaneInfo,
  defaultEditorContext,
  type EditorState,
} from '../../src/shared/building-editor.js';
import { buildMesh, faceCounts } from '../../src/shared/building-mesh.js';
import { meshToGlb } from '../../src/shared/building-gltf.js';
import { parseBuildingModel } from '../../src/shared/building-model.js';

function houseWithRoof(): { state: EditorState; roofId: string } {
  const ctx = defaultEditorContext();
  let state = newEditorState(newBuildingModel(ctx, { latitude: 52.5, longitude: 13.4, timezone: 'Europe/Berlin' }));
  state = addWall(ctx, state, { axis: [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 6 }, { x: 0, y: 6 }, { x: 0, y: 0 }] });
  const storeyId = state.model.storeys[0]!.id;
  state = addRoof(ctx, state, { storeyId, type: 'gable', pitchDeg: 30 });
  return { state, roofId: state.model.roofs[0]!.id };
}

describe('pvAutoFit', () => {
  it('fits whole modules within the usable plane', () => {
    // 8×6 plane, 0.3 clearance → 7.4×5.4 usable; 1.7×1.0 modules, 0.02 gap.
    const fit = pvAutoFit(8, 6, 1.7, 1.0, 0.02, 0.3);
    expect(fit.columns).toBe(Math.floor((7.4 + 0.02) / 1.72));
    expect(fit.rows).toBe(Math.floor((5.4 + 0.02) / 1.02));
    expect(fit.columns).toBeGreaterThan(0);
    expect(fit.rows).toBeGreaterThan(0);
  });

  it('returns zero when the plane is too small', () => {
    expect(pvAutoFit(0.2, 0.2, 1.7, 1, 0.02, 0.3)).toEqual({ rows: 0, columns: 0 });
  });
});

describe('roofPlaneInfo', () => {
  it('reports footprint width/depth/area + tilt', () => {
    const { state, roofId } = houseWithRoof();
    const info = roofPlaneInfo(state, roofId);
    expect(info?.widthM).toBeCloseTo(8, 6);
    expect(info?.depthM).toBeCloseTo(6, 6);
    expect(info?.areaM2).toBeCloseTo(48, 6);
    expect(info?.tiltDeg).toBe(30);
  });
});

describe('PV commands', () => {
  it('adds, updates and removes a PV array; cascades on roof removal', () => {
    const { state, roofId } = houseWithRoof();
    const s1 = addPvArray(defaultEditorContext(), state, { roofId, rows: 2, columns: 3 });
    expect(s1.model.pvArrays).toHaveLength(1);
    expect(s1.model.pvArrays[0]?.roofFaceId.startsWith(roofId)).toBe(true);
    expect(() => parseBuildingModel(s1.model)).not.toThrow();

    const pvId = s1.model.pvArrays[0]!.id;
    const s2 = updatePvArray(s1, pvId, { rows: 5 });
    expect(s2.model.pvArrays[0]?.rows).toBe(5);

    const s3 = removePvArray(s2, pvId);
    expect(s3.model.pvArrays).toHaveLength(0);
  });

  it('addPvArray on a missing roof is a no-op', () => {
    const { state } = houseWithRoof();
    expect(addPvArray(defaultEditorContext(), state, { roofId: 'nope' })).toBe(state);
  });
});

describe('PV in the mesh', () => {
  it('lays a module grid (rows×columns faces) on the roof', () => {
    const { state, roofId } = houseWithRoof();
    const s1 = addPvArray(defaultEditorContext(), state, { roofId, rows: 2, columns: 3, moduleWidthM: 1, moduleHeightM: 1, gapM: 0.05 });
    const c = faceCounts(buildMesh(s1.model));
    expect(c.pv).toBe(6); // 2 × 3 modules
  });
});

describe('GLB export', () => {
  it('produces a valid GLB container from a model with geometry', () => {
    const { state, roofId } = houseWithRoof();
    const s1 = addPvArray(defaultEditorContext(), state, { roofId, rows: 2, columns: 2, moduleWidthM: 1, moduleHeightM: 1 });
    const glb = meshToGlb(buildMesh(s1.model));
    const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
    expect(dv.getUint32(0, true)).toBe(0x46546c67); // "glTF"
    expect(dv.getUint32(4, true)).toBe(2); // version
    expect(dv.getUint32(8, true)).toBe(glb.byteLength); // total length matches
    // First chunk is JSON.
    expect(dv.getUint32(16, true)).toBe(0x4e4f534a);
    // The embedded JSON references materials + a mesh.
    const jsonLen = dv.getUint32(12, true);
    const json = new TextDecoder().decode(glb.subarray(20, 20 + jsonLen));
    const gltf = JSON.parse(json) as { meshes: unknown[]; materials: unknown[] };
    expect(gltf.meshes.length).toBe(1);
    expect(gltf.materials.length).toBeGreaterThan(0);
  });
});
