/**
 * Thermal estimate orchestration (thermal-load-engine, Quick Estimate v1).
 * Pure entry point: assembles heating + ventilation + cooling results with the
 * mandatory provenance record (profile/version/model-revision/input-hash/
 * data-quality/uncertainty/warnings/disclaimer). NON-NORMATIVE — see types.ts.
 *
 * Non-actuating by construction: this module has no I/O and no access to any
 * device-control path (control-boundary: design calc must never reach an
 * actuator).
 */

import {
  THERMAL_PROFILE_VERSION,
  NON_NORMATIVE_DISCLAIMER,
  type RoomThermalInput,
  type ThermalParams,
  type ThermalEstimate,
  type Warning,
} from './types.js';
import { buildingHeatingLoad } from './heating-load.js';
import { roomCoolingEstimate } from './cooling-estimate.js';
import { assessDataQuality } from './data-quality.js';
import { quickEstimateConformity, methodRefIds } from './knowledge-model.js';

/** FNV-1a/32 hex over a string — small, dependency-free, reproducible. */
function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Stable stringify (sorted keys) for hashing. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export interface ComputeOptions {
  modelRevision: number;
  /** Override the computation timestamp (tests). */
  now?: Date;
}

/**
 * Compute the full non-normative thermal estimate for a set of rooms.
 */
export function computeThermalEstimate(
  rooms: RoomThermalInput[],
  params: ThermalParams,
  options: ComputeOptions,
): ThermalEstimate {
  const warnings: Warning[] = [];

  if (params.designOutdoorTempC >= params.defaultIndoorTempC) {
    warnings.push({ code: 'DESIGN_DELTA_NONPOSITIVE', message: 'Design outdoor ≥ indoor: heating load will be zero.' });
  }
  if ((params.summerOutdoorTempC ?? 32) <= params.defaultIndoorTempC) {
    warnings.push({ code: 'COOLING_DELTA_LOW', message: 'Summer outdoor ≤ indoor: cooling gains from ventilation are non-positive.' });
  }
  warnings.push({
    code: 'COOLING_STATIC_ESTIMATE',
    message: 'Cooling is a static peak estimate; dynamic storage (VDI 6007 RC) is not modelled.',
  });

  const heating = buildingHeatingLoad(rooms, params);
  const coolingRooms = rooms.map((r) => roomCoolingEstimate(r, params));
  const buildingPeakW = coolingRooms.reduce((s, r) => s + r.totalW, 0);

  const dataQuality = assessDataQuality(rooms);
  const inputHash = fnv1a(stableStringify({ rooms, params, profile: THERMAL_PROFILE_VERSION }));

  return {
    profile: 'quick-estimate-v1',
    profileVersion: THERMAL_PROFILE_VERSION,
    computedAt: (options.now ?? new Date()).toISOString(),
    modelRevision: options.modelRevision,
    inputHash,
    params,
    heating: {
      rooms: heating.rooms,
      buildingTotalW: heating.buildingTotalW,
      sumOfRoomsW: heating.sumOfRoomsW,
    },
    cooling: {
      rooms: coolingRooms,
      buildingPeakW,
    },
    dataQuality,
    warnings,
    conformity: quickEstimateConformity(),
    methodRefs: methodRefIds(),
    disclaimer: NON_NORMATIVE_DISCLAIMER,
  };
}

export * from './types.js';
export * from './heating-load.js';
export * from './ventilation-1946-6.js';
export * from './cooling-estimate.js';
export * from './data-quality.js';
export * from './building-thermal-adapter.js';
export * from './knowledge-model.js';
export * from './standards-parameters.js';
export * from './dynamic-cooling.js';
export * from './pdf-report.js';
export * from './evidence-register.js';
export * from './validation-harness.js';
