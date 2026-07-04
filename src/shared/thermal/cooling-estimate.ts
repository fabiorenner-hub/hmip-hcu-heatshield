/**
 * Cooling load — Quick Estimate v1 (non-normative), VDI 2078 STRUCTURE but a
 * STATIC PEAK estimate (NOT the dynamic hourly VDI 6007 RC method). Simplified,
 * technically-equivalent physics for a plausibility/scenario estimate:
 *
 *   solar (glazing)  Q̇_sol = Σ A_gl·I·g_tot·F_sh
 *   opaque (sol-air) Q̇_tr  = Σ U·A·(θ_sol-air − θ_i),  θ_sol-air = θ_e + α·I/h_e
 *   internal         persons (sensible+latent), lighting, equipment × usage
 *   ventilation      sensible 0.34·V̇·(θ_e−θ_i);  latent ρ·V̇·(x_e−x_i)·r_v
 *   Q̇_cool = max(0, Q̇_sol + Q̇_tr + Q̇_int + Q̇_vent)
 *
 * A dynamic RC storage term (why peak ≠ peak-irradiance) is intentionally NOT
 * modelled here — that requires the VDI 6007 dynamic core. This is flagged in
 * the estimate warnings. Pure; no proprietary tables reproduced.
 */

import { AIR } from './types.js';
import type { RoomThermalInput, ThermalParams, RoomCoolingResult } from './types.js';

/** Exterior surface film coefficient h_e [W/(m²·K)] and absorptance α (typical). */
const H_E = 25;
const ABSORPTANCE = 0.6;

/** Sol-air temperature θ_sol-air = θ_e + α·I/h_e (long-wave term omitted). */
export function solAirTempC(outdoorC: number, solarWm2: number): number {
  return outdoorC + (ABSORPTANCE * Math.max(0, solarWm2)) / H_E;
}

/** Per-room static peak cooling estimate. */
export function roomCoolingEstimate(room: RoomThermalInput, params: ThermalParams): RoomCoolingResult {
  const indoor = room.indoorTempC;
  const outdoor = params.summerOutdoorTempC ?? 32;

  let solarW = 0;
  let opaqueW = 0;
  for (const s of room.surfaces) {
    if (s.glazing === true) {
      const g = s.gTotal ?? 0.5;
      const fsh = s.shadingFactor ?? 1;
      const irr = s.solarWm2 ?? 0;
      solarW += s.areaM2 * Math.max(0, irr) * g * Math.max(0, Math.min(1, fsh));
    } else if (s.boundary === 'exterior') {
      const tSolAir = solAirTempC(outdoor, s.solarWm2 ?? 0);
      opaqueW += s.uValue * s.areaM2 * (tSolAir - indoor);
    }
  }

  const g = room.gains ?? {};
  const persons = Math.max(0, g.persons ?? 0);
  const internalSensibleW =
    persons * (g.personSensibleW ?? 70) +
    (g.lightingW ?? 0) * (g.usageFactor ?? 1) +
    (g.equipmentW ?? 0) * (g.usageFactor ?? 1);
  const internalLatentW = persons * (g.personLatentW ?? 40);

  // Ventilation: in summer, outdoor warmer than indoor → a gain.
  const n = Math.max(room.airChangeRate ?? 0.5, 0);
  const flow = n * room.volumeM3; // [m³/h]
  const ventilationSensibleW = AIR.cV * flow * (outdoor - indoor);
  // Latent: ρ [kg/m³] · V̇ [m³/h]/3600 · Δx [kg/kg] · r_v [J/kg].
  const dx = Math.max(0, (params.outdoorHumidityRatio ?? 0) - (params.indoorHumidityRatio ?? 0));
  const ventilationLatentW = AIR.rho * (flow / 3600) * dx * (AIR.rv * 1e6);

  const sensibleRaw = solarW + opaqueW + internalSensibleW + ventilationSensibleW;
  const sensibleW = Math.max(0, sensibleRaw);
  const latentW = Math.max(0, internalLatentW + ventilationLatentW);

  return {
    roomId: room.roomId,
    name: room.name,
    solarW,
    opaqueW,
    internalSensibleW,
    internalLatentW,
    ventilationSensibleW,
    ventilationLatentW,
    sensibleW,
    latentW,
    totalW: sensibleW + latentW,
  };
}

/**
 * Operative temperature θ_op = (h_c·θ_a + h_r·θ_mrt)/(h_c+h_r).
 * With equal coefficients this collapses to the arithmetic mean.
 */
export function operativeTempC(airC: number, meanRadiantC: number, hc = 3.1, hr = 4.5): number {
  const denom = hc + hr;
  if (denom <= 0) return (airC + meanRadiantC) / 2;
  return (hc * airC + hr * meanRadiantC) / denom;
}
