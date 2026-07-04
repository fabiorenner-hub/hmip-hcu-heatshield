/**
 * Deterministic building mesh builder (digital-twin-renderer T-01).
 */

import { describe, expect, it } from 'vitest';

import { buildMesh, faceCounts, clipPolygonBelowZ, type BuildingMesh } from '../../src/shared/building-mesh.js';
import { newBuildingModel, newEditorState, addWall, addSpace, addOpening, defaultEditorContext } from '../../src/shared/building-editor.js';
import type { BuildingModel, Roof } from '../../src/shared/building-model.js';

function squareModel(): BuildingModel {
  const ctx = defaultEditorContext();
  let state = newEditorState(newBuildingModel(ctx, { latitude: 52.5, longitude: 13.4, timezone: 'Europe/Berlin' }));
  // Closed square wall (4 segments) + one room polygon.
  state = addWall(ctx, state, { axis: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }, { x: 0, y: 0 }] });
  state = addSpace(ctx, state, { name: 'Raum', polygon: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }] });
  return state.model;
}

function withRoof(model: BuildingModel, type: Roof['type'], pitchDeg = 30): BuildingModel {
  const storeyId = model.storeys[0]!.id;
  const roof: Roof = {
    id: '00000000-0000-4000-8000-000000000f00',
    type,
    storeyId,
    pitchDeg,
  };
  return { ...model, roofs: [roof] };
}

describe('buildMesh', () => {
  it('extrudes a 4-segment square into 24 wall faces + floor + ceiling', () => {
    const mesh = buildMesh(squareModel());
    const c = faceCounts(mesh);
    expect(c.wall).toBe(24); // 4 segments × 6 box faces
    expect(c.floor).toBe(1);
    expect(c.ceiling).toBe(1);
    expect(c.roof).toBe(0);
  });

  it('computes bounds spanning the footprint and storey height', () => {
    const mesh = buildMesh(squareModel());
    expect(mesh.bounds.min.x).toBeCloseTo(-0.12, 2); // half wall thickness (0.24/2)
    expect(mesh.bounds.max.x).toBeCloseTo(4.12, 2);
    expect(mesh.bounds.min.z).toBeCloseTo(0, 6);
    expect(mesh.bounds.max.z).toBeCloseTo(2.5, 6); // default storey height
  });

  it('is deterministic (same model → identical mesh)', () => {
    const m = squareModel();
    expect(JSON.stringify(buildMesh(m))).toBe(JSON.stringify(buildMesh(m)));
  });

  it('flat roof adds one cap face', () => {
    const mesh = buildMesh(withRoof(squareModel(), 'flat'));
    expect(faceCounts(mesh).roof).toBe(1);
  });

  it('gable roof adds two slopes + two gable ends (4 faces) with a raised ridge', () => {
    const mesh = buildMesh(withRoof(squareModel(), 'gable', 45));
    expect(faceCounts(mesh).roof).toBe(4);
    // Ridge higher than the eaves: mesh top z above the storey top (2.5).
    expect(mesh.bounds.max.z).toBeGreaterThan(2.5);
  });

  it('shed roof adds one sloped face', () => {
    const mesh = buildMesh(withRoof(squareModel(), 'shed', 20));
    expect(faceCounts(mesh).roof).toBe(1);
    expect(mesh.bounds.max.z).toBeGreaterThan(2.5);
  });

  it('hip roof builds 4 slopes (2 trapezoids + 2 hip triangles), no diagnostic', () => {
    const mesh: BuildingMesh = buildMesh(withRoof(squareModel(), 'hip', 35));
    expect(faceCounts(mesh).roof).toBe(4);
    expect(mesh.diagnostics.some((d) => d.code === 'ROOF_TYPE_UNSUPPORTED')).toBe(false);
    // Ridge raised above the eaves.
    expect(mesh.bounds.max.z).toBeGreaterThan(2.5);
  });

  it('half-hip (Krüppelwalm) is a distinct generator: 6 faces incl. vertical gablets', () => {
    const mesh: BuildingMesh = buildMesh(withRoof(squareModel(), 'half_hip', 35));
    expect(faceCounts(mesh).roof).toBe(6); // 2 slopes + 2 hip triangles + 2 gablets
    expect(mesh.diagnostics.some((d) => d.code === 'ROOF_TYPE_UNSUPPORTED')).toBe(false);
    expect(mesh.bounds.max.z).toBeGreaterThan(2.5);
    // The gablet knee sits below the ridge → a distinct silhouette from a full hip.
    const hip = buildMesh(withRoof(squareModel(), 'hip', 35));
    expect(faceCounts(hip).roof).not.toBe(faceCounts(mesh).roof);
  });

  it('hip/half-hip honour ridgeAzimuthDeg for the ridge axis (deterministic)', () => {
    const ctx = defaultEditorContext();
    let state = newEditorState(newBuildingModel(ctx, { latitude: 52.5, longitude: 13.4, timezone: 'Europe/Berlin' }));
    // Rectangular 6×4 footprint so the ridge orientation genuinely changes shape.
    state = addWall(ctx, state, { axis: [{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 6, y: 4 }, { x: 0, y: 4 }, { x: 0, y: 0 }] });
    const base = state.model;
    const storeyId = base.storeys[0]!.id;
    const ew: Roof = { id: '00000000-0000-4000-8000-000000000f01', type: 'hip', storeyId, pitchDeg: 30, ridgeAzimuthDeg: 90 };
    const ns: Roof = { id: '00000000-0000-4000-8000-000000000f01', type: 'hip', storeyId, pitchDeg: 30, ridgeAzimuthDeg: 0 };
    const meshEw = buildMesh({ ...base, roofs: [ew] });
    const meshNs = buildMesh({ ...base, roofs: [ns] });
    // Ridge along the 6 m axis reaches a different peak height than along the 4 m axis.
    expect(meshEw.bounds.max.z).not.toBeCloseTo(meshNs.bounds.max.z, 3);
    // Determinism per orientation.
    expect(JSON.stringify(buildMesh({ ...base, roofs: [ew] }))).toBe(JSON.stringify(meshEw));
  });

  it('an empty model yields no faces and zero bounds', () => {
    const ctx = defaultEditorContext();
    const model = newBuildingModel(ctx, { latitude: 52.5, longitude: 13.4, timezone: 'Europe/Berlin' });
    const mesh = buildMesh(model);
    expect(mesh.faces).toHaveLength(0);
    expect(mesh.bounds.max.z).toBe(0);
  });

  it('cuts a window opening as a hole (more wall faces than the plain box)', () => {
    const ctx = defaultEditorContext();
    let state = newEditorState(newBuildingModel(ctx, { latitude: 52.5, longitude: 13.4, timezone: 'Europe/Berlin' }));
    // Single straight wall (1 segment) → plain box = 6 faces.
    state = addWall(ctx, state, { axis: [{ x: 0, y: 0 }, { x: 4, y: 0 }] });
    const plain = faceCounts(buildMesh(state.model)).wall;
    expect(plain).toBe(6);
    // Add a window on that wall → the segment is tiled around the hole + reveals.
    const wallId = state.model.storeys[0]!.walls[0]!.id;
    state = addOpening(ctx, state, { type: 'window', hostWallId: wallId, offsetM: 1.5, widthM: 1, heightM: 1.2, sillM: 0.9 });
    const withHole = faceCounts(buildMesh(state.model)).wall;
    expect(withHole).toBeGreaterThan(plain);
  });
});

describe('clipPolygonBelowZ (section/clipping plane)', () => {
  const square = [
    { x: 0, y: 0, z: 0 },
    { x: 2, y: 0, z: 4 },
    { x: 2, y: 2, z: 4 },
    { x: 0, y: 2, z: 0 },
  ];

  it('returns the polygon unchanged when it is entirely below the plane', () => {
    const out = clipPolygonBelowZ(square, 10);
    expect(out).not.toBeNull();
    expect(out).toHaveLength(4);
  });

  it('returns null when the polygon is entirely above the plane', () => {
    const high = square.map((v) => ({ ...v, z: v.z + 20 }));
    expect(clipPolygonBelowZ(high, 5)).toBeNull();
  });

  it('clips a spanning polygon and inserts vertices exactly on the plane', () => {
    const out = clipPolygonBelowZ(square, 2);
    expect(out).not.toBeNull();
    // No surviving vertex is above the cut; at least one lies on the plane.
    expect(out!.every((v) => v.z <= 2 + 1e-9)).toBe(true);
    expect(out!.some((v) => Math.abs(v.z - 2) < 1e-9)).toBe(true);
  });

  it('rejects degenerate input (fewer than 3 vertices)', () => {
    expect(clipPolygonBelowZ([{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }], 1)).toBeNull();
  });
});
