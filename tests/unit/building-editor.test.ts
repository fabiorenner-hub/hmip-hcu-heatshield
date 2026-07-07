/**
 * Pure Building Studio editor core (building-model-editor Phase 1). Verifies
 * geometry helpers, the command reducer, and undo/redo — all deterministic.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  addStorey,
  duplicateStorey,
  addWall,
  addSpace,
  addOpening,
  updateOpening,
  updateSpace,
  deleteWallVertex,
  moveSpaceVertex,
  deleteSpaceVertex,
  nearestVertex,
  addRoof,
  addRoofWindow,
  updateRoof,
  removeRoof,
  roofSectionProfile,
  deleteWall,
  updateWall,
  moveWallVertex,
  setActiveStorey,
  removeStorey,
  splitWall,
  mergeWalls,
  alignWalls,
  extendWallToWall,
  offsetWall,
  suggestRooms,
  newBuildingModel,
  newEditorState,
  initHistory,
  pushHistory,
  undo,
  redo,
  canUndo,
  canRedo,
  constrainAngle,
  snapToGrid,
  segmentLength,
  polygonArea,
  headingDeg,
  validateState,
  type EditorContext,
  type EditorState,
} from '../../src/shared/building-editor.js';
import { parseBuildingModel, validateBuildingModel } from '../../src/shared/building-model.js';

// Deterministic id generator producing valid uuids.
function testContext(): EditorContext {
  let n = 0;
  return {
    newId: (): string => {
      n += 1;
      const hex = n.toString(16).padStart(12, '0');
      return `00000000-0000-4000-8000-${hex}`;
    },
  };
}

function freshState(): { ctx: EditorContext; state: EditorState } {
  const ctx = testContext();
  const model = newBuildingModel(ctx, { latitude: 52.5, longitude: 13.4, timezone: 'Europe/Berlin' });
  return { ctx, state: newEditorState(model) };
}

describe('geometry helpers', () => {
  it('snapToGrid rounds to the nearest step', () => {
    expect(snapToGrid({ x: 1.2, y: 2.7 }, 0.5)).toEqual({ x: 1, y: 2.5 });
  });

  it('constrainAngle ortho snaps to axis and preserves length', () => {
    const from = { x: 0, y: 0 };
    const out = constrainAngle(from, { x: 3, y: 0.4 }, 'ortho');
    expect(out.y).toBeCloseTo(0, 6);
    expect(Math.hypot(out.x, out.y)).toBeCloseTo(Math.hypot(3, 0.4), 6);
  });

  it('constrainAngle free is identity', () => {
    expect(constrainAngle({ x: 0, y: 0 }, { x: 1, y: 2 }, 'free')).toEqual({ x: 1, y: 2 });
  });

  it('segmentLength sums polyline segments', () => {
    expect(segmentLength([{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 4 }])).toBeCloseTo(7, 6);
  });

  it('polygonArea computes a unit square', () => {
    expect(polygonArea([{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }])).toBeCloseTo(4, 6);
  });

  it('headingDeg is 0 east, 90 north', () => {
    expect(headingDeg({ x: 0, y: 0 }, { x: 1, y: 0 })).toBeCloseTo(0, 6);
    expect(headingDeg({ x: 0, y: 0 }, { x: 0, y: 1 })).toBeCloseTo(90, 6);
  });

  it('nearestVertex snaps to the closest candidate within tolerance', () => {
    const verts = [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 3 }];
    // Within tolerance → snaps to (5,3).
    expect(nearestVertex(verts, { x: 4.9, y: 3.1 }, 0.3)).toEqual({ x: 5, y: 3 });
    // Outside tolerance → null (no snap).
    expect(nearestVertex(verts, { x: 2.5, y: 1.5 }, 0.3)).toBeNull();
    // Empty candidate set → null.
    expect(nearestVertex([], { x: 0, y: 0 }, 1)).toBeNull();
  });
});

describe('command reducer', () => {
  it('seeds a schema-valid model with one storey', () => {
    const { state } = freshState();
    expect(state.model.storeys).toHaveLength(1);
    expect(() => parseBuildingModel(state.model)).not.toThrow();
  });

  it('adds a wall to the active storey', () => {
    const { ctx, state } = freshState();
    const next = addWall(ctx, state, { axis: [{ x: 0, y: 0 }, { x: 4, y: 0 }] });
    expect(next.model.storeys[0]?.walls).toHaveLength(1);
    expect(next.selection).toHaveLength(1);
    expect(() => parseBuildingModel(next.model)).not.toThrow();
  });

  it('rejects a degenerate (zero-length) wall', () => {
    const { ctx, state } = freshState();
    const next = addWall(ctx, state, { axis: [{ x: 1, y: 1 }, { x: 1, y: 1 }] });
    expect(next.model.storeys[0]?.walls ?? []).toHaveLength(0);
  });

  it('deleteWall cascades to hosted openings', () => {
    const { ctx, state } = freshState();
    const s1 = addWall(ctx, state, { axis: [{ x: 0, y: 0 }, { x: 4, y: 0 }] });
    const wallId = s1.model.storeys[0]!.walls[0]!.id;
    const s2 = addOpening(ctx, s1, { type: 'window', hostWallId: wallId, offsetM: 1, widthM: 1, heightM: 1.2 });
    expect(s2.model.storeys[0]?.openings).toHaveLength(1);
    const s3 = deleteWall(s2, wallId);
    expect(s3.model.storeys[0]?.walls).toHaveLength(0);
    expect(s3.model.storeys[0]?.openings).toHaveLength(0);
  });

  it('updateOpening edits width/height/offset/sill (clamped) and is a no-op for unknown ids', () => {
    const { ctx, state } = freshState();
    const s1 = addWall(ctx, state, { axis: [{ x: 0, y: 0 }, { x: 4, y: 0 }] });
    const wallId = s1.model.storeys[0]!.walls[0]!.id;
    const s2 = addOpening(ctx, s1, { type: 'window', hostWallId: wallId, offsetM: 1, widthM: 1, heightM: 1.2 });
    const openingId = s2.model.storeys[0]!.openings[0]!.id;
    const s3 = updateOpening(s2, openingId, { widthM: 1.4, heightM: 1.6, offsetM: 0.5, sillM: 0.8 });
    const o = s3.model.storeys[0]!.openings[0]!;
    expect([o.widthM, o.heightM, o.offsetM, o.sillM]).toEqual([1.4, 1.6, 0.5, 0.8]);
    // Clamp: width/height floor at 0.1, offset/sill floor at 0.
    const s4 = updateOpening(s3, openingId, { widthM: -5, heightM: 0, offsetM: -1, sillM: -2 });
    const o2 = s4.model.storeys[0]!.openings[0]!;
    expect([o2.widthM, o2.heightM, o2.offsetM, o2.sillM]).toEqual([0.1, 0.1, 0, 0]);
    // Unknown id → unchanged model reference for openings.
    expect(updateOpening(s4, 'nope', { widthM: 2 }).model.storeys[0]?.openings[0]?.widthM).toBe(0.1);
  });

  it('windows default to double glazing; glazing + roofWindow are editable', () => {
    const { ctx, state } = freshState();
    const s1 = addWall(ctx, state, { axis: [{ x: 0, y: 0 }, { x: 4, y: 0 }] });
    const wallId = s1.model.storeys[0]!.walls[0]!.id;
    const s2 = addOpening(ctx, s1, { type: 'window', hostWallId: wallId, offsetM: 1, widthM: 1, heightM: 1.2 });
    const win = s2.model.storeys[0]!.openings[0]!;
    expect(win.glazing).toBe('double');
    expect(win.roofWindow).toBeUndefined();
    const s3 = updateOpening(s2, win.id, { glazing: 'triple', roofWindow: true });
    const win2 = s3.model.storeys[0]!.openings[0]!;
    expect(win2.glazing).toBe('triple');
    expect(win2.roofWindow).toBe(true);
    // Doors carry no glazing.
    const s4 = addOpening(ctx, s3, { type: 'door', hostWallId: wallId, offsetM: 2, widthM: 1, heightM: 2 });
    expect(s4.model.storeys[0]!.openings.find((o) => o.type === 'door')!.glazing).toBeUndefined();
  });

  it('passage (Durchgang) is a door-height opening without glazing, sill on the floor', () => {
    const { ctx, state } = freshState();
    const s1 = addWall(ctx, state, { axis: [{ x: 0, y: 0 }, { x: 4, y: 0 }] });
    const wallId = s1.model.storeys[0]!.walls[0]!.id;
    const s2 = addOpening(ctx, s1, { type: 'passage', hostWallId: wallId, offsetM: 1, widthM: 1, heightM: 2 });
    const p = s2.model.storeys[0]!.openings[0]!;
    expect(p.type).toBe('passage');
    expect(p.glazing).toBeUndefined();
    expect(p.sillM).toBe(0);
  });

  it('deleteWallVertex removes a point, and collapses to deleteWall below 2', () => {
    const { ctx, state } = freshState();
    const s1 = addWall(ctx, state, { axis: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }] });
    const id = s1.model.storeys[0]!.walls[0]!.id;
    const s2 = deleteWallVertex(s1, id, 1);
    expect(s2.model.storeys[0]!.walls[0]!.axis).toHaveLength(2);
    // Removing another vertex would drop below 2 → the whole wall is deleted.
    const s3 = deleteWallVertex(s2, id, 0);
    expect(s3.model.storeys[0]!.walls).toHaveLength(0);
  });

  it('moveSpaceVertex + deleteSpaceVertex reshape/shrink a room polygon', () => {
    const { ctx, state } = freshState();
    const s1 = addSpace(ctx, state, { name: 'A', polygon: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }] });
    const id = s1.model.storeys[0]!.spaces[0]!.id;
    const s2 = moveSpaceVertex(s1, id, 2, { x: 5, y: 4 });
    expect(s2.model.storeys[0]!.spaces[0]!.polygon[2]).toEqual({ x: 5, y: 4 });
    const s3 = deleteSpaceVertex(s2, id, 2);
    expect(s3.model.storeys[0]!.spaces[0]!.polygon).toHaveLength(3);
    // Below 3 points → the room is deleted.
    const s4 = deleteSpaceVertex(s3, id, 0);
    expect(s4.model.storeys[0]!.spaces).toHaveLength(0);
  });

  it('duplicateStorey copies walls/openings/spaces upward with fresh, remapped ids', () => {
    const { ctx, state } = freshState();
    const s1 = addWall(ctx, state, { axis: [{ x: 0, y: 0 }, { x: 4, y: 0 }] });
    const wallId = s1.model.storeys[0]!.walls[0]!.id;
    const s2 = addOpening(ctx, s1, { type: 'window', hostWallId: wallId, offsetM: 1, widthM: 1, heightM: 1.2 });
    const s3 = addSpace(ctx, s2, { name: 'Wohnen', polygon: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }] });
    const src = s3.model.storeys[0]!;
    const dup = duplicateStorey(ctx, s3, src.id);
    expect(dup.model.storeys).toHaveLength(2);
    const copy = dup.model.storeys.find((s) => s.id !== src.id)!;
    // Stacked directly above.
    expect(copy.elevationM).toBeCloseTo(src.elevationM + src.heightM, 6);
    // Same geometry, new ids.
    expect(copy.walls).toHaveLength(1);
    expect(copy.walls[0]!.id).not.toBe(wallId);
    expect(copy.walls[0]!.axis).toEqual(src.walls[0]!.axis);
    // Opening re-homed onto the COPIED wall (referential integrity).
    expect(copy.openings).toHaveLength(1);
    expect(copy.openings[0]!.hostWallId).toBe(copy.walls[0]!.id);
    expect(copy.spaces).toHaveLength(1);
    expect(copy.spaces[0]!.id).not.toBe(src.spaces[0]!.id);
    // The copy becomes active and the model stays referentially valid.
    expect(dup.activeStoreyId).toBe(copy.id);
    expect(parseBuildingModel(dup.model)).toBeTruthy();
    // Duplicating downward stacks the copy below (toward the basement).
    const down = duplicateStorey(ctx, s3, src.id, 'down');
    const below = down.model.storeys.find((s) => s.id !== src.id)!;
    expect(below.elevationM).toBeCloseTo(src.elevationM - src.heightM, 6);
  });

  it('links a space to a config room and clears it with null (schema-valid)', () => {
    const { ctx, state } = freshState();
    const s1 = addSpace(ctx, state, { name: 'Wohnen', polygon: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }] });
    const id = s1.model.storeys[0]!.spaces[0]!.id;
    const s2 = updateSpace(s1, id, { linkedRoomId: 'room-wohnzimmer' });
    expect(s2.model.storeys[0]!.spaces[0]!.linkedRoomId).toBe('room-wohnzimmer');
    expect(() => parseBuildingModel(s2.model)).not.toThrow();
    const s3 = updateSpace(s2, id, { linkedRoomId: null });
    expect(s3.model.storeys[0]!.spaces[0]!.linkedRoomId).toBeUndefined();
    expect(() => parseBuildingModel(s3.model)).not.toThrow();
  });

  it('links an opening to a config window and clears it with null (schema-valid)', () => {
    const { ctx, state } = freshState();
    const s1 = addWall(ctx, state, { axis: [{ x: 0, y: 0 }, { x: 4, y: 0 }] });
    const wallId = s1.model.storeys[0]!.walls[0]!.id;
    const s2 = addOpening(ctx, s1, { type: 'window', hostWallId: wallId, offsetM: 1, widthM: 1, heightM: 1.2 });
    const openingId = s2.model.storeys[0]!.openings[0]!.id;
    const s3 = updateOpening(s2, openingId, { linkedWindowId: 'win-so-schlafzimmer' });
    expect(s3.model.storeys[0]!.openings[0]!.linkedWindowId).toBe('win-so-schlafzimmer');
    expect(() => parseBuildingModel(s3.model)).not.toThrow();
    const s4 = updateOpening(s3, openingId, { linkedWindowId: null });
    expect(s4.model.storeys[0]!.openings[0]!.linkedWindowId).toBeUndefined();
  });

  it('updateSpace renames a room', () => {
    const { ctx, state } = freshState();
    const s1 = addSpace(ctx, state, { name: 'Alt', polygon: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }] });
    const id = s1.model.storeys[0]!.spaces[0]!.id;
    const s2 = updateSpace(s1, id, { name: 'Wohnzimmer' });
    expect(s2.model.storeys[0]!.spaces[0]!.name).toBe('Wohnzimmer');
  });

  it('addOpening on a non-existent wall is a no-op', () => {
    const { ctx, state } = freshState();
    const next = addOpening(ctx, state, { type: 'door', hostWallId: 'nope', offsetM: 0, widthM: 1, heightM: 2 });
    expect(next).toBe(state);
  });

  it('updateWall patches thickness', () => {
    const { ctx, state } = freshState();
    const s1 = addWall(ctx, state, { axis: [{ x: 0, y: 0 }, { x: 4, y: 0 }] });
    const wallId = s1.model.storeys[0]!.walls[0]!.id;
    const s2 = updateWall(s1, wallId, { thicknessM: 0.5 });
    expect(s2.model.storeys[0]?.walls[0]?.thicknessM).toBe(0.5);
  });

  it('moveWallVertex moves the endpoint', () => {
    const { ctx, state } = freshState();
    const s1 = addWall(ctx, state, { axis: [{ x: 0, y: 0 }, { x: 4, y: 0 }] });
    const wallId = s1.model.storeys[0]!.walls[0]!.id;
    const s2 = moveWallVertex(s1, wallId, 1, { x: 5, y: 1 });
    expect(s2.model.storeys[0]?.walls[0]?.axis[1]).toEqual({ x: 5, y: 1 });
  });

  it('addStorey keeps at least one and removeStorey never empties', () => {
    const { ctx, state } = freshState();
    const s1 = addStorey(ctx, state, { name: 'OG', elevationM: 2.5, heightM: 2.5 });
    expect(s1.model.storeys).toHaveLength(2);
    const only = removeStorey(removeStorey(s1, s1.model.storeys[0]!.id), s1.model.storeys[1]!.id);
    expect(only.model.storeys.length).toBeGreaterThanOrEqual(1);
  });

  it('addSpace creates a room and validates clean', () => {
    const { ctx, state } = freshState();
    const next = addSpace(ctx, state, { name: 'Wohnen', polygon: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }] });
    expect(next.model.storeys[0]?.spaces).toHaveLength(1);
    expect(validateState(next).valid).toBe(true);
  });
});

describe('advanced wall ops', () => {
  function withWall(): { ctx: EditorContext; state: EditorState; wallId: string } {
    const { ctx, state } = freshState();
    const s1 = addWall(ctx, state, { axis: [{ x: 0, y: 0 }, { x: 6, y: 0 }] });
    return { ctx, state: s1, wallId: s1.model.storeys[0]!.walls[0]!.id };
  }

  it('splitWall creates two walls at the projected point', () => {
    const { ctx, state, wallId } = withWall();
    const next = splitWall(ctx, state, wallId, { x: 3, y: 0.4 });
    const walls = next.model.storeys[0]!.walls;
    expect(walls).toHaveLength(2);
    expect(segmentLength(walls[0]!.axis) + segmentLength(walls[1]!.axis)).toBeCloseTo(6, 6);
    expect(() => parseBuildingModel(next.model)).not.toThrow();
  });

  it('splitWall is a no-op at an endpoint', () => {
    const { ctx, state, wallId } = withWall();
    const next = splitWall(ctx, state, wallId, { x: 0, y: 0 });
    expect(next.model.storeys[0]?.walls).toHaveLength(1);
  });

  it('mergeWalls joins two walls that share an endpoint', () => {
    const { ctx, state } = freshState();
    const s1 = addWall(ctx, state, { axis: [{ x: 0, y: 0 }, { x: 4, y: 0 }] });
    const s2 = addWall(ctx, s1, { axis: [{ x: 4, y: 0 }, { x: 4, y: 3 }] });
    const [a, b] = s2.model.storeys[0]!.walls;
    const merged = mergeWalls(ctx, s2, a!.id, b!.id);
    expect(merged.model.storeys[0]?.walls).toHaveLength(1);
    expect(segmentLength(merged.model.storeys[0]!.walls[0]!.axis)).toBeCloseTo(7, 6);
  });

  it('mergeWalls is a no-op when walls do not touch', () => {
    const { ctx, state } = freshState();
    const s1 = addWall(ctx, state, { axis: [{ x: 0, y: 0 }, { x: 4, y: 0 }] });
    const s2 = addWall(ctx, s1, { axis: [{ x: 10, y: 0 }, { x: 14, y: 0 }] });
    const [a, b] = s2.model.storeys[0]!.walls;
    expect(mergeWalls(ctx, s2, a!.id, b!.id).model.storeys[0]?.walls).toHaveLength(2);
  });

  it('mergeWalls re-homes openings from both walls', () => {
    const { ctx, state } = freshState();
    const s1 = addWall(ctx, state, { axis: [{ x: 0, y: 0 }, { x: 4, y: 0 }] });
    const s2 = addWall(ctx, s1, { axis: [{ x: 4, y: 0 }, { x: 4, y: 3 }] });
    const [a, b] = s2.model.storeys[0]!.walls;
    const s3 = addOpening(ctx, s2, { type: 'window', hostWallId: b!.id, offsetM: 1, widthM: 1, heightM: 1.2 });
    const merged = mergeWalls(ctx, s3, a!.id, b!.id);
    const wallId = merged.model.storeys[0]!.walls[0]!.id;
    expect(merged.model.storeys[0]?.openings[0]?.hostWallId).toBe(wallId);
    expect(validateState(merged).valid).toBe(true);
  });

  it('alignWalls snaps vertices to a common axis', () => {
    const { ctx, state } = freshState();
    const s1 = addWall(ctx, state, { axis: [{ x: 0.0, y: 0 }, { x: 0.1, y: 3 }] });
    const wallId = s1.model.storeys[0]!.walls[0]!.id;
    const aligned = alignWalls(s1, [wallId], 'x');
    const axis = aligned.model.storeys[0]!.walls[0]!.axis;
    expect(axis[0]!.x).toBeCloseTo(0.05, 6);
    expect(axis[1]!.x).toBeCloseTo(0.05, 6);
  });

  it('extendWallToWall moves the nearest endpoint onto the intersection', () => {
    const { ctx, state } = freshState();
    // Horizontal wall A ending short of x=4; vertical wall B along x=4.
    const s1 = addWall(ctx, state, { axis: [{ x: 0, y: 0 }, { x: 3, y: 0 }] });
    const s2 = addWall(ctx, s1, { axis: [{ x: 4, y: -1 }, { x: 4, y: 2 }] });
    const [a, b] = s2.model.storeys[0]!.walls;
    const ext = extendWallToWall(s2, a!.id, b!.id);
    const axisA = ext.model.storeys[0]!.walls[0]!.axis;
    // A's far endpoint should now sit on x=4, y=0 (the line intersection).
    expect(axisA[1]!.x).toBeCloseTo(4, 6);
    expect(axisA[1]!.y).toBeCloseTo(0, 6);
  });

  it('extendWallToWall is a no-op for parallel walls', () => {
    const { ctx, state } = freshState();
    const s1 = addWall(ctx, state, { axis: [{ x: 0, y: 0 }, { x: 3, y: 0 }] });
    const s2 = addWall(ctx, s1, { axis: [{ x: 0, y: 2 }, { x: 3, y: 2 }] });
    const [a, b] = s2.model.storeys[0]!.walls;
    const ext = extendWallToWall(s2, a!.id, b!.id);
    expect(ext.model.storeys[0]!.walls[0]!.axis[1]).toEqual({ x: 3, y: 0 });
  });

  it('offsetWall creates a parallel copy at the given distance', () => {
    const { ctx, state, wallId } = withWall(); // axis [0,0]->[6,0]
    const off = offsetWall(ctx, state, wallId, 0.5);
    const walls = off.model.storeys[0]!.walls;
    expect(walls).toHaveLength(2);
    // Normal of a west→east wall points +y (north); offset by 0.5 → y=0.5.
    const copy = walls[1]!;
    expect(copy.axis[0]!.y).toBeCloseTo(0.5, 6);
    expect(copy.axis[1]!.y).toBeCloseTo(0.5, 6);
    expect(() => parseBuildingModel(off.model)).not.toThrow();
  });
});

describe('suggestRooms', () => {
  it('adds a room for a closed square and dedupes on re-run', () => {
    const { ctx, state } = freshState();
    const s1 = addWall(ctx, state, { axis: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }, { x: 0, y: 0 }] });
    const first = suggestRooms(ctx, s1);
    expect(first.added).toBe(1);
    expect(first.state.model.storeys[0]?.spaces).toHaveLength(1);
    // Re-run: the face is already covered → nothing added.
    const second = suggestRooms(ctx, first.state);
    expect(second.added).toBe(0);
    expect(second.state.model.storeys[0]?.spaces).toHaveLength(1);
  });

  it('adds nothing when there is no closed loop', () => {
    const { ctx, state } = freshState();
    const s1 = addWall(ctx, state, { axis: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }] });
    expect(suggestRooms(ctx, s1).added).toBe(0);
  });
});

describe('undo/redo history', () => {
  it('records and reverts commands', () => {
    const { ctx, state } = freshState();
    let h = initHistory(state);
    expect(canUndo(h)).toBe(false);
    h = pushHistory(h, addWall(ctx, h.present, { axis: [{ x: 0, y: 0 }, { x: 4, y: 0 }] }), true);
    expect(h.present.model.storeys[0]?.walls).toHaveLength(1);
    expect(canUndo(h)).toBe(true);
    h = undo(h);
    expect(h.present.model.storeys[0]?.walls).toHaveLength(0);
    expect(canRedo(h)).toBe(true);
    h = redo(h);
    expect(h.present.model.storeys[0]?.walls).toHaveLength(1);
  });

  it('a transient change does not add an undo step', () => {
    const { ctx, state } = freshState();
    const s1 = addStorey(ctx, state, { name: 'OG', elevationM: 2.5, heightM: 2.5 });
    let h = initHistory(s1);
    h = pushHistory(h, setActiveStorey(h.present, s1.model.storeys[0]!.id), false);
    expect(canUndo(h)).toBe(false);
  });

  it('property: undo after any single command restores the prior model', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.integer({ min: -10, max: 10 }), fc.integer({ min: -10, max: 10 })), { minLength: 2, maxLength: 6 }), (coords) => {
        const { ctx, state } = freshState();
        const before = state.model;
        const axis = coords.map(([x, y]) => ({ x, y }));
        let h = initHistory(state);
        const after = addWall(ctx, h.present, { axis });
        h = pushHistory(h, after, true);
        const undone = undo(h);
        expect(undone.present.model).toEqual(before);
      }),
    );
  });
});

describe('roof commands (BME-13/14)', () => {
  function storeyWithFootprint(): { ctx: EditorContext; state: EditorState; storeyId: string } {
    const { ctx, state } = freshState();
    const s1 = addWall(ctx, state, { axis: [{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 6, y: 4 }, { x: 0, y: 4 }, { x: 0, y: 0 }] });
    return { ctx, state: s1, storeyId: s1.model.storeys[0]!.id };
  }

  it('addRoof attaches a schema-valid roof to the storey', () => {
    const { ctx, state, storeyId } = storeyWithFootprint();
    const next = addRoof(ctx, state, { storeyId, type: 'gable', pitchDeg: 35 });
    expect(next.model.roofs).toHaveLength(1);
    expect(next.model.roofs[0]?.type).toBe('gable');
    expect(next.model.roofs[0]?.pitchDeg).toBe(35);
    expect(() => parseBuildingModel(next.model)).not.toThrow();
  });

  it('addRoof replaces an existing roof on the same storey by default', () => {
    const { ctx, state, storeyId } = storeyWithFootprint();
    const s1 = addRoof(ctx, state, { storeyId, type: 'gable', pitchDeg: 30 });
    const s2 = addRoof(ctx, s1, { storeyId, type: 'hip', pitchDeg: 40 });
    expect(s2.model.roofs).toHaveLength(1);
    expect(s2.model.roofs[0]?.type).toBe('hip');
  });

  it('addRoof with allowMultiple keeps both', () => {
    const { ctx, state, storeyId } = storeyWithFootprint();
    const s1 = addRoof(ctx, state, { storeyId, type: 'gable', pitchDeg: 30 });
    const s2 = addRoof(ctx, s1, { storeyId, type: 'shed', pitchDeg: 15 }, true);
    expect(s2.model.roofs).toHaveLength(2);
  });

  it('flat roof forces pitch 0; other pitches clamp to [0, 80]', () => {
    const { ctx, state, storeyId } = storeyWithFootprint();
    const flat = addRoof(ctx, state, { storeyId, type: 'flat', pitchDeg: 45 });
    expect(flat.model.roofs[0]?.pitchDeg).toBe(0);
    const steep = addRoof(ctx, state, { storeyId, type: 'hip', pitchDeg: 200 });
    expect(steep.model.roofs[0]?.pitchDeg).toBe(80);
  });

  it('addRoof normalises ridgeAzimuthDeg into [0, 360) and clamps overhang ≥ 0', () => {
    const { ctx, state, storeyId } = storeyWithFootprint();
    const next = addRoof(ctx, state, { storeyId, type: 'gable', pitchDeg: 30, ridgeAzimuthDeg: 450, overhangM: -1 });
    expect(next.model.roofs[0]?.ridgeAzimuthDeg).toBeCloseTo(90, 6);
    expect(next.model.roofs[0]?.overhangM).toBe(0);
    expect(() => parseBuildingModel(next.model)).not.toThrow();
  });

  it('updateRoof patches type + pitch and keeps it schema-valid', () => {
    const { ctx, state, storeyId } = storeyWithFootprint();
    const s1 = addRoof(ctx, state, { storeyId, type: 'gable', pitchDeg: 30 });
    const id = s1.model.roofs[0]!.id;
    const s2 = updateRoof(s1, id, { type: 'half_hip', pitchDeg: 38 });
    expect(s2.model.roofs[0]?.type).toBe('half_hip');
    expect(s2.model.roofs[0]?.pitchDeg).toBe(38);
    expect(() => parseBuildingModel(s2.model)).not.toThrow();
  });

  it('updateRoof clears the ridge azimuth with an explicit null (back to auto)', () => {
    const { ctx, state, storeyId } = storeyWithFootprint();
    const s1 = addRoof(ctx, state, { storeyId, type: 'gable', pitchDeg: 30, ridgeAzimuthDeg: 90 });
    const id = s1.model.roofs[0]!.id;
    expect(s1.model.roofs[0]?.ridgeAzimuthDeg).toBe(90);
    const s2 = updateRoof(s1, id, { ridgeAzimuthDeg: null });
    expect(s2.model.roofs[0]?.ridgeAzimuthDeg).toBeUndefined();
    // A bare pitch patch keeps the (now-absent) ridge absent.
    const s3 = updateRoof(s2, id, { pitchDeg: 25 });
    expect(s3.model.roofs[0]?.ridgeAzimuthDeg).toBeUndefined();
  });

  it('addRoof/updateRoof carry the knee wall (Kniestock); null clears it, section reflects it', () => {
    const { ctx, state, storeyId } = storeyWithFootprint();
    const s1 = addRoof(ctx, state, { storeyId, type: 'gable', pitchDeg: 30, kneeHeightM: 0.9 });
    const id = s1.model.roofs[0]!.id;
    expect(s1.model.roofs[0]?.kneeHeightM).toBe(0.9);
    expect(() => parseBuildingModel(s1.model)).not.toThrow();
    // Section eaves rise by the knee above the storey wall top.
    const sec = roofSectionProfile(s1, id);
    expect(sec!.kneeHeightM).toBe(0.9);
    expect(sec!.profile[0]!.y).toBeCloseTo(sec!.wallHeightM + 0.9, 6);
    // Explicit null clears it back to a flush eaves.
    const s2 = updateRoof(s1, id, { kneeHeightM: null });
    expect(s2.model.roofs[0]?.kneeHeightM).toBeUndefined();
  });

  it('addRoofWindow hosts the window on the ROOF (hostRoofId, no wall) and validates', () => {
    const { ctx, state, storeyId } = storeyWithFootprint();
    const s1 = addRoof(ctx, state, { storeyId, type: 'gable', pitchDeg: 35 });
    const roofId = s1.model.roofs[0]!.id;
    const s2 = addRoofWindow(ctx, s1, { roofId });
    const win = s2.model.storeys[0]!.openings.find((o) => o.roofWindow === true)!;
    expect(win.hostRoofId).toBe(roofId);
    expect(win.hostWallId).toBeUndefined();
    expect(() => parseBuildingModel(s2.model)).not.toThrow();
    expect(validateBuildingModel(s2.model).valid).toBe(true);
  });

  it('addRoofWindow is a no-op without a roof on the active storey', () => {
    const { ctx, state } = storeyWithFootprint();
    expect(addRoofWindow(ctx, state, { roofId: 'nope' })).toBe(state);
  });

  it('a roof window pointing at a missing roof flags OPENING_HOST_ROOF_MISSING', () => {
    const { ctx, state, storeyId } = storeyWithFootprint();
    const s1 = addRoof(ctx, state, { storeyId, type: 'gable', pitchDeg: 35 });
    const roofId = s1.model.roofs[0]!.id;
    const s2 = addRoofWindow(ctx, s1, { roofId });
    // Remove the roof but keep the roof window → dangling host.
    const orphaned = { ...s2.model, roofs: [] };
    const issues = validateBuildingModel(orphaned).issues;
    expect(issues.some((i) => i.code === 'OPENING_HOST_ROOF_MISSING')).toBe(true);
  });

  it('removeRoof drops the roof (and any PV arrays hosted by its faces)', () => {
    const { ctx, state, storeyId } = storeyWithFootprint();
    const s1 = addRoof(ctx, state, { storeyId, type: 'hip', pitchDeg: 30 });
    const id = s1.model.roofs[0]!.id;
    const withPv = { ...s1, model: { ...s1.model, pvArrays: [{ id: '00000000-0000-4000-8000-0000000000aa', roofFaceId: `${id}:0`, rows: 2, columns: 3, moduleWidthM: 1, moduleHeightM: 1.6 }] } };
    const s2 = removeRoof(withPv, id);
    expect(s2.model.roofs).toHaveLength(0);
    expect(s2.model.pvArrays).toHaveLength(0);
  });

  it('removeStorey also removes its roof', () => {
    const { ctx, state, storeyId } = storeyWithFootprint();
    const s1 = addStorey(ctx, state, { name: 'OG', elevationM: 2.5, heightM: 2.5 });
    const s2 = addRoof(ctx, s1, { storeyId, type: 'gable', pitchDeg: 30 });
    expect(s2.model.roofs).toHaveLength(1);
    const s3 = removeStorey(s2, storeyId);
    expect(s3.model.roofs).toHaveLength(0);
  });

  it('roofSectionProfile: gable gives a symmetric triangle across the span (⊥ ridge)', () => {
    const { ctx, state, storeyId } = storeyWithFootprint(); // 6×4 footprint
    const s1 = addRoof(ctx, state, { storeyId, type: 'gable', pitchDeg: 45 });
    const sec = roofSectionProfile(s1, s1.model.roofs[0]!.id);
    expect(sec).not.toBeNull();
    // Ridge auto → along the longer (6 m) axis → section spans the 4 m depth.
    expect(sec!.spanM).toBeCloseTo(4, 6);
    // pitch 45° over half-span 2 m → rise 2 m.
    expect(sec!.ridgeHeightM).toBeCloseTo(2, 6);
    expect(sec!.profile).toHaveLength(3);
    expect(sec!.profile[1]!.x).toBeCloseTo(2, 6); // ridge in the middle
    expect(sec!.profile[1]!.y).toBeGreaterThan(sec!.profile[0]!.y);
  });

  it('roofSectionProfile: flat is level, shed is a single slope', () => {
    const { ctx, state, storeyId } = storeyWithFootprint();
    const flatState = addRoof(ctx, state, { storeyId, type: 'flat', pitchDeg: 0 });
    const flatSec = roofSectionProfile(flatState, flatState.model.roofs[0]!.id);
    expect(flatSec!.ridgeHeightM).toBe(0);
    expect(flatSec!.profile).toHaveLength(2);
    expect(flatSec!.profile[0]!.y).toBeCloseTo(flatSec!.profile[1]!.y, 6);
    const shedState = addRoof(ctx, state, { storeyId, type: 'shed', pitchDeg: 30 });
    const shedSec = roofSectionProfile(shedState, shedState.model.roofs[0]!.id);
    expect(shedSec!.profile).toHaveLength(2);
    expect(shedSec!.profile[1]!.y).toBeGreaterThan(shedSec!.profile[0]!.y); // rises across the span
  });
});
