/**
 * Heating load — Quick Estimate v1 (non-normative), DIN EN 12831-1 /
 * DIN·TS 12831-1 STRUCTURE. Simplified, technically-equivalent physics:
 *
 *   Φ_HL,i = Φ_stand,i + max(ΔΦ_comf,i, Φ_hu,i)
 *   Φ_stand,i = Φ_T,i + Φ_V,i
 *   Φ_T,i = Σ_j A_j·(U_j + ΔU_WB)·f_Δθ,j·(θ_int − θ_e)
 *   Φ_V,i = 0.34·V̇·(θ_int − θ_supply)      [with min-flow + heat recovery]
 *   ΔΦ_comf,i = (H_T + H_V)·Δθ_comf
 *   Φ_hu,i = A_i·f_hu
 *
 * The temperature-correction factor f_Δθ = (θ_int − θ_adj)/(θ_int − θ_e) reduces
 * the driving ΔT for surfaces bordering ground / unheated / adjacent-heated
 * spaces. Pure; no tables from the paid standards are reproduced.
 */

import { AIR } from './types.js';
import type { RoomThermalInput, ThermalParams, RoomHeatingResult } from './types.js';

/** Temperature-correction factor f_Δθ for a surface, clamped to [0, 1]. */
export function tempCorrectionFactor(
  surface: { boundary: RoomThermalInput['surfaces'][number]['boundary']; adjacentTempC?: number },
  indoorC: number,
  outdoorC: number,
): number {
  const fullDelta = indoorC - outdoorC;
  if (fullDelta <= 0) return 0;
  if (surface.boundary === 'exterior' || surface.boundary === 'ground') {
    // Ground is approximated here via its (equivalent) U; f≈1 for the driving
    // ΔT. A licensed profile would use the DIN·TS equivalent-U/periodic method.
    return 1;
  }
  const adj = surface.adjacentTempC ?? outdoorC;
  const f = (indoorC - adj) / fullDelta;
  return Math.max(0, Math.min(1, f));
}

/** Transmission heat-transfer coefficient H_T [W/K] for a room. */
export function transmissionHT(room: RoomThermalInput, params: ThermalParams): number {
  const indoor = room.indoorTempC;
  const outdoor = params.designOutdoorTempC;
  const dUwb = room.thermalBridgeSurchargeU ?? 0;
  let ht = 0;
  for (const s of room.surfaces) {
    const f = tempCorrectionFactor(s, indoor, outdoor);
    ht += s.areaM2 * (s.uValue + dUwb) * f;
  }
  return ht;
}

/** Ventilation heat-transfer coefficient H_V [W/K] for a room (min-flow + HRV). */
export function ventilationHV(room: RoomThermalInput): number {
  // Envelope/min air flow from the air-change rate; never below a minimum.
  const nMin = 0.5; // conservative hygienic minimum [1/h] when unspecified
  const n = Math.max(room.airChangeRate ?? nMin, 0);
  const envFlow = n * room.volumeM3; // [m³/h]
  const supply = Math.max(room.supplyFlowM3h ?? 0, 0);
  const eta = Math.max(0, Math.min(1, room.heatRecovery ?? 0));
  // Effective flow that must be heated from outdoor to indoor. Supply air is
  // pre-heated by the recovery unit → only (1−η) of it counts.
  const effectiveFlow = Math.max(envFlow, supply) - supply * eta;
  return AIR.cV * Math.max(0, effectiveFlow);
}

/** Full per-room heating-load result with the DIN·TS breakdown. */
export function roomHeatingLoad(room: RoomThermalInput, params: ThermalParams): RoomHeatingResult {
  const indoor = room.indoorTempC;
  const outdoor = params.designOutdoorTempC;
  const deltaT = Math.max(0, indoor - outdoor);

  const ht = transmissionHT(room, params);
  const hv = ventilationHV(room);

  const transmissionW = ht * deltaT;
  const ventilationW = hv * deltaT;

  // Per-boundary transmission breakdown.
  const dUwb = room.thermalBridgeSurchargeU ?? 0;
  const byBoundary: Record<string, number> = {};
  for (const s of room.surfaces) {
    const f = tempCorrectionFactor(s, indoor, outdoor);
    const w = s.areaM2 * (s.uValue + dUwb) * f * deltaT;
    byBoundary[s.boundary] = (byBoundary[s.boundary] ?? 0) + w;
  }

  const comfortW = (ht + hv) * Math.max(0, room.comfortUpliftK ?? 0);
  const reheatW = room.floorAreaM2 * Math.max(0, room.reheatFactorWm2 ?? 0);

  const standW = transmissionW + ventilationW;
  const totalW = standW + Math.max(comfortW, reheatW);
  const specificWm2 = room.floorAreaM2 > 0 ? totalW / room.floorAreaM2 : 0;

  return {
    roomId: room.roomId,
    name: room.name,
    transmissionW,
    ventilationW,
    reheatW,
    comfortW,
    totalW,
    specificWm2,
    transmissionByBoundary: byBoundary,
  };
}

/**
 * Building heating load. NOTE: this is NOT Σ room loads — transmission between
 * differently-tempered rooms is an internal transfer that nets out of the
 * whole-building envelope balance. We therefore recompute the building total
 * from ENVELOPE surfaces only (exterior + ground), plus ventilation, while
 * still reporting the sum of room loads for comparison.
 */
export function buildingHeatingLoad(
  rooms: RoomThermalInput[],
  params: ThermalParams,
): { buildingTotalW: number; sumOfRoomsW: number; rooms: RoomHeatingResult[] } {
  const roomResults = rooms.map((r) => roomHeatingLoad(r, params));
  const sumOfRoomsW = roomResults.reduce((s, r) => s + r.totalW, 0);

  const outdoor = params.designOutdoorTempC;
  let envTransmissionW = 0;
  let ventilationW = 0;
  let reheatW = 0;
  let comfortW = 0;
  for (const r of rooms) {
    const deltaT = Math.max(0, r.indoorTempC - outdoor);
    const dUwb = r.thermalBridgeSurchargeU ?? 0;
    for (const s of r.surfaces) {
      if (s.boundary === 'exterior' || s.boundary === 'ground') {
        envTransmissionW += s.areaM2 * (s.uValue + dUwb) * deltaT;
      }
    }
    ventilationW += ventilationHV(r) * deltaT;
    reheatW += r.floorAreaM2 * Math.max(0, r.reheatFactorWm2 ?? 0);
    comfortW += (transmissionHT(r, params) + ventilationHV(r)) * Math.max(0, r.comfortUpliftK ?? 0);
  }
  const buildingTotalW = envTransmissionW + ventilationW + Math.max(comfortW, reheatW);
  return { buildingTotalW, sumOfRoomsW, rooms: roomResults };
}
