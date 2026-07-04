/**
 * Building model → thermal inputs adapter (Quick Estimate v1, non-normative).
 *
 * Derives per-room analytical surfaces from the shared building geometry:
 *   - floor area + volume from the room polygon × storey height,
 *   - exterior wall area ≈ polygon perimeter × height (with a window share),
 *   - roof (top storey) / ground (base storey) surfaces, else adjacent-heated
 *     (which nets out of the envelope balance),
 *   - glazing derived from a window-to-wall ratio.
 *
 * This is a deliberately transparent approximation for an early estimate: exact
 * wall-to-room adjacency and per-opening attribution are not modelled, so the
 * data-quality score reflects the defaulted U-values. Pure; type-only import of
 * the model (no zod at runtime).
 */

import type { BuildingModel, Point, Storey } from '../building-model.js';
import type { RoomThermalInput, ThermalSurface } from './types.js';

/** Non-normative default constructions + operating assumptions. */
export interface ThermalProfileDefaults {
  wallU: number;
  roofU: number;
  floorU: number;
  windowU: number;
  windowGtotal: number;
  windowShading: number;
  windowToWallRatio: number;
  airChangeRate: number;
  thermalBridgeSurchargeU: number;
  indoorTempC: number;
}

export const DEFAULT_THERMAL_PROFILE: ThermalProfileDefaults = {
  wallU: 0.28,
  roofU: 0.2,
  floorU: 0.35,
  windowU: 1.3,
  windowGtotal: 0.5,
  windowShading: 0.7,
  windowToWallRatio: 0.2,
  airChangeRate: 0.5,
  thermalBridgeSurchargeU: 0.05,
  indoorTempC: 20,
};

function polygonAreaAbs(poly: Point[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i += 1) {
    const p = poly[i] as Point;
    const q = poly[(i + 1) % poly.length] as Point;
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

function polygonPerimeter(poly: Point[]): number {
  let per = 0;
  for (let i = 0; i < poly.length; i += 1) {
    const p = poly[i] as Point;
    const q = poly[(i + 1) % poly.length] as Point;
    per += Math.hypot(q.x - p.x, q.y - p.y);
  }
  return per;
}

/** Build per-room thermal inputs from the model + a (non-normative) profile. */
export function buildRoomThermalInputs(
  model: BuildingModel,
  defaults: ThermalProfileDefaults = DEFAULT_THERMAL_PROFILE,
  solarWm2 = 0,
): RoomThermalInput[] {
  const storeys = model.storeys;
  const minElev = Math.min(...storeys.map((s) => s.elevationM), 0);
  const maxTop = Math.max(...storeys.map((s) => s.elevationM + s.heightM), 0);
  const out: RoomThermalInput[] = [];

  for (const storey of storeys) {
    const isBase = storey.elevationM <= minElev + 1e-6;
    const isTop = storey.elevationM + storey.heightM >= maxTop - 1e-6;
    const height = storey.heightM > 0 ? storey.heightM : 2.5;
    for (const space of storey.spaces) {
      const floorArea = polygonAreaAbs(space.polygon);
      const perimeter = polygonPerimeter(space.polygon);
      const grossWall = perimeter * height;
      const windowArea = grossWall * defaults.windowToWallRatio;
      const opaqueWall = Math.max(0, grossWall - windowArea);

      const surfaces: ThermalSurface[] = [
        { id: `${space.id}:wall`, areaM2: opaqueWall, uValue: defaults.wallU, boundary: 'exterior', solarWm2 },
        {
          id: `${space.id}:window`,
          areaM2: windowArea,
          uValue: defaults.windowU,
          boundary: 'exterior',
          glazing: true,
          gTotal: defaults.windowGtotal,
          shadingFactor: defaults.windowShading,
          solarWm2,
        },
      ];
      if (isTop) {
        surfaces.push({ id: `${space.id}:roof`, areaM2: floorArea, uValue: defaults.roofU, boundary: 'exterior', solarWm2 });
      } else {
        surfaces.push({ id: `${space.id}:ceiling`, areaM2: floorArea, uValue: defaults.roofU, boundary: 'adjacent-heated', adjacentTempC: defaults.indoorTempC });
      }
      if (isBase) {
        surfaces.push({ id: `${space.id}:floor`, areaM2: floorArea, uValue: defaults.floorU, boundary: 'ground' });
      } else {
        surfaces.push({ id: `${space.id}:floor`, areaM2: floorArea, uValue: defaults.floorU, boundary: 'adjacent-heated', adjacentTempC: defaults.indoorTempC });
      }

      out.push({
        roomId: space.id,
        name: space.name,
        floorAreaM2: floorArea,
        volumeM3: floorArea * height,
        indoorTempC: defaults.indoorTempC,
        surfaces,
        airChangeRate: defaults.airChangeRate,
        thermalBridgeSurchargeU: defaults.thermalBridgeSurchargeU,
      });
    }
  }
  return out;
}

/** Convenience: total usage-unit floor area for the ventilation concept. */
export function totalFloorArea(model: BuildingModel): number {
  let a = 0;
  for (const s of model.storeys as Storey[]) for (const sp of s.spaces) a += polygonAreaAbs(sp.polygon);
  return a;
}
