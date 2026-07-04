/**
 * Data-quality scoring + uncertainty band for the thermal estimate. Pure.
 * The score reflects how much of the required input was actually provided vs.
 * defaulted; the relative uncertainty widens the reported band accordingly.
 */

import type { RoomThermalInput, DataQuality } from './types.js';

/**
 * Score a set of room inputs. Missing/zero geometry and U-values dominate the
 * penalty; missing air-change / bridge / gains are lighter (defaulted).
 */
export function assessDataQuality(rooms: RoomThermalInput[]): DataQuality {
  const missing: string[] = [];
  let checks = 0;
  let ok = 0;

  const add = (present: boolean, label: string): void => {
    checks += 1;
    if (present) ok += 1;
    else if (!missing.includes(label)) missing.push(label);
  };

  if (rooms.length === 0) {
    return { score: 0, relativeUncertainty: 0.5, missingInputs: ['rooms'] };
  }

  for (const r of rooms) {
    add(r.floorAreaM2 > 0, 'floorArea');
    add(r.volumeM3 > 0, 'volume');
    add(r.surfaces.length > 0, 'surfaces');
    add(r.surfaces.every((s) => s.uValue > 0), 'uValues');
    add(r.airChangeRate !== undefined, 'airChangeRate');
    add(r.thermalBridgeSurchargeU !== undefined, 'thermalBridge');
  }

  const score = checks === 0 ? 0 : ok / checks;
  // Map score→uncertainty: full data ≈ ±15 %, empty ≈ ±50 %.
  const relativeUncertainty = Math.round((0.15 + (1 - score) * 0.35) * 100) / 100;
  return { score: Math.round(score * 100) / 100, relativeUncertainty, missingInputs: missing };
}
