/**
 * Building model → thermal inputs adapter (Quick Estimate v1). Verifies that a
 * simple square room yields plausible analytical surfaces (floor/volume/walls/
 * roof/ground) that feed a non-negative estimate.
 */

import { describe, expect, it } from 'vitest';

import { newBuildingModel, newEditorState, addWall, addSpace, defaultEditorContext } from '../../src/shared/building-editor.js';
import { buildRoomThermalInputs, totalFloorArea, computeThermalEstimate } from '../../src/shared/thermal/index.js';

function squareRoomModel(): ReturnType<typeof newBuildingModel> {
  const ctx = defaultEditorContext();
  let state = newEditorState(newBuildingModel(ctx, { latitude: 52.5, longitude: 13.4, timezone: 'Europe/Berlin' }));
  state = addWall(ctx, state, { axis: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 4 }, { x: 0, y: 4 }, { x: 0, y: 0 }] });
  state = addSpace(ctx, state, { name: 'Wohnen', polygon: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 4 }, { x: 0, y: 4 }] });
  return state.model;
}

describe('building thermal adapter', () => {
  it('derives floor area, volume and envelope surfaces from a room polygon', () => {
    const model = squareRoomModel();
    const rooms = buildRoomThermalInputs(model);
    expect(rooms).toHaveLength(1);
    const r = rooms[0]!;
    expect(r.floorAreaM2).toBeCloseTo(20, 6); // 5×4
    expect(r.volumeM3).toBeCloseTo(20 * 2.5, 6); // default storey height 2.5
    // Single storey → base + top → ground floor + roof + walls + window.
    const boundaries = r.surfaces.map((s) => `${s.boundary}${s.glazing ? ':glass' : ''}`);
    expect(boundaries).toContain('ground');
    expect(boundaries).toContain('exterior:glass');
    expect(r.surfaces.some((s) => s.id.endsWith(':roof'))).toBe(true);
    expect(totalFloorArea(model)).toBeCloseTo(20, 6);
  });

  it('feeds a non-negative estimate with defaulted-U data-quality penalty', () => {
    const model = squareRoomModel();
    const rooms = buildRoomThermalInputs(model);
    const est = computeThermalEstimate(rooms, { designOutdoorTempC: -12, defaultIndoorTempC: 20 }, { modelRevision: model.revision, now: new Date(0) });
    expect(est.heating.rooms[0]!.totalW).toBeGreaterThan(0);
    expect(est.heating.buildingTotalW).toBeGreaterThan(0);
    // U-values are profile defaults (present) but the adapter marks bridges present too;
    // score is high yet uncertainty band remains meaningful (>10%).
    expect(est.dataQuality.relativeUncertainty).toBeGreaterThan(0.1);
  });
});
