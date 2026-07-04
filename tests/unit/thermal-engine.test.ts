/**
 * Thermal load engine — Quick Estimate v1 (non-normative). Verifies the
 * simplified DIN EN 12831-1 / DIN 1946-6 / VDI 2078 physics against hand
 * calculations, plus provenance/data-quality/disclaimer invariants.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  computeThermalEstimate,
  roomHeatingLoad,
  transmissionHT,
  ventilationHV,
  tempCorrectionFactor,
  areaBaseFlow,
  stageFlow,
  ventilationConcept,
  convertFlowAtPressure,
  moistureProtectionFactor,
  operativeTempC,
  AIR,
  NON_NORMATIVE_DISCLAIMER,
  type RoomThermalInput,
  type ThermalParams,
} from '../../src/shared/thermal/index.js';

const params: ThermalParams = { designOutdoorTempC: -12, defaultIndoorTempC: 20, summerOutdoorTempC: 32 };

function simpleRoom(): RoomThermalInput {
  return {
    roomId: 'r1',
    name: 'Wohnen',
    floorAreaM2: 20,
    volumeM3: 50,
    indoorTempC: 20,
    surfaces: [
      { id: 'w', areaM2: 10, uValue: 0.3, boundary: 'exterior' },
      { id: 'win', areaM2: 2, uValue: 1.3, boundary: 'exterior', glazing: true, gTotal: 0.5, shadingFactor: 0.7, solarWm2: 500 },
    ],
    airChangeRate: 0.5,
  };
}

describe('heating load (DIN EN 12831-1 structure)', () => {
  it('transmission H_T = Σ A·U and Φ_T = H_T·ΔT', () => {
    const room = simpleRoom();
    const ht = transmissionHT(room, params);
    // 10·0.3 + 2·1.3 = 3 + 2.6 = 5.6 W/K
    expect(ht).toBeCloseTo(5.6, 6);
    const res = roomHeatingLoad(room, params);
    // ΔT = 32 K → Φ_T = 5.6·32 = 179.2 W
    expect(res.transmissionW).toBeCloseTo(179.2, 4);
  });

  it('ventilation H_V ≈ 0.34·n·V and applies heat recovery', () => {
    const room = simpleRoom();
    const hv = ventilationHV(room);
    // 0.34 · (0.5·50) = 0.34·25 = 8.5 W/K
    expect(hv).toBeCloseTo(AIR.cV * 25, 6);
    // With recovery on a mechanical supply, effective flow drops.
    const withHrv: RoomThermalInput = { ...room, supplyFlowM3h: 25, heatRecovery: 0.8 };
    expect(ventilationHV(withHrv)).toBeLessThan(hv);
  });

  it('temperature-correction factor reduces ΔT for adjacent/unheated', () => {
    // exterior → 1
    expect(tempCorrectionFactor({ boundary: 'exterior' }, 20, -12)).toBeCloseTo(1, 6);
    // adjacent heated at 18 °C: (20−18)/(20−(−12)) = 2/32 = 0.0625
    expect(tempCorrectionFactor({ boundary: 'unheated', adjacentTempC: 18 }, 20, -12)).toBeCloseTo(0.0625, 6);
  });

  it('Φ_HL = Φ_stand + max(comfort, reheat)', () => {
    const room: RoomThermalInput = { ...simpleRoom(), reheatFactorWm2: 10, comfortUpliftK: 0 };
    const res = roomHeatingLoad(room, params);
    const stand = res.transmissionW + res.ventilationW;
    expect(res.reheatW).toBeCloseTo(200, 6); // 20 m² · 10 W/m²
    expect(res.totalW).toBeCloseTo(stand + 200, 4);
  });

  it('zero ΔT (outdoor ≥ indoor) yields zero heating load', () => {
    const res = roomHeatingLoad(simpleRoom(), { ...params, designOutdoorTempC: 21 });
    expect(res.transmissionW).toBe(0);
    expect(res.totalW).toBe(0);
  });
});

describe('ventilation concept (DIN 1946-6 area method)', () => {
  it('area base flow matches the quadratic at 100 m²', () => {
    // −0.002·100² + 1.15·100 + 11 = −20 + 115 + 11 = 106
    expect(areaBaseFlow(100)).toBeCloseTo(106, 6);
  });

  it('stage factors 0.7 / 1.0 / 1.3', () => {
    expect(stageFlow(100, 'reduced')).toBeCloseTo(74.2, 4);
    expect(stageFlow(100, 'nominal')).toBeCloseTo(106, 4);
    expect(stageFlow(100, 'intensive')).toBeCloseTo(137.8, 4);
  });

  it('above 210 m²: +4 m³/h per 10 m² (no unbounded quadratic)', () => {
    const at210 = areaBaseFlow(210);
    expect(areaBaseFlow(220)).toBeCloseTo(at210 + 4, 6);
  });

  it('moisture-protection factor matrix', () => {
    expect(moistureProtectionFactor('high', 'low')).toBe(0.2);
    expect(moistureProtectionFactor('low', 'high')).toBe(0.4);
  });

  it('measure required ⇔ q_inf < q_FL', () => {
    const tight = ventilationConcept({ areaM2: 100, volumeM3: 250, n50: 1, waermeschutz: 'high', occupancy: 'low' });
    expect(tight.measureRequired).toBe(true); // low leakage → measure needed
    const leaky = ventilationConcept({ areaM2: 100, volumeM3: 250, n50: 6, waermeschutz: 'high', occupancy: 'low' });
    expect(leaky.measureRequired).toBe(false);
  });

  it('pressure/flow law q2 = q1·(Δp2/Δp1)^n', () => {
    // n=2/3: from 10 Pa to 4 Pa
    expect(convertFlowAtPressure(30, 10, 4)).toBeCloseTo(30 * Math.pow(0.4, 2 / 3), 6);
  });
});

describe('cooling estimate (VDI 2078 static peak) + operative temp', () => {
  it('operative temperature is the coefficient-weighted mean', () => {
    expect(operativeTempC(26, 30, 3, 3)).toBeCloseTo(28, 6);
  });

  it('solar gain enters the cooling estimate', () => {
    const est = computeThermalEstimate([simpleRoom()], params, { modelRevision: 1, now: new Date('2026-07-01T12:00:00Z') });
    const c = est.cooling.rooms[0]!;
    // window 2 m² · 500 · 0.5 · 0.7 = 350 W
    expect(c.solarW).toBeCloseTo(350, 4);
    expect(c.sensibleW).toBeGreaterThan(0);
  });
});

describe('orchestration + provenance', () => {
  it('carries profile/version/hash/disclaimer and building ≠ Σ rooms note', () => {
    const est = computeThermalEstimate([simpleRoom()], params, { modelRevision: 7, now: new Date('2026-07-01T00:00:00Z') });
    expect(est.profile).toBe('quick-estimate-v1');
    expect(est.modelRevision).toBe(7);
    expect(est.inputHash).toMatch(/^[0-9a-f]{8}$/u);
    expect(est.disclaimer).toBe(NON_NORMATIVE_DISCLAIMER);
    expect(est.warnings.some((w) => w.code === 'COOLING_STATIC_ESTIMATE')).toBe(true);
    // Envelope building total ≤ Σ room loads (inter-room transfer nets out).
    expect(est.heating.buildingTotalW).toBeLessThanOrEqual(est.heating.sumOfRoomsW + 1e-6);
  });

  it('carries a non-normative conformity status with blocked license/validation/approval gates', () => {
    const est = computeThermalEstimate([simpleRoom()], params, { modelRevision: 1, now: new Date(0) });
    expect(est.conformity.claim).toBe('none');
    const byId = new Map(est.conformity.gates.map((g) => [g.id, g.state]));
    expect(byId.get('G1')).toBe('met'); // licence held (DEC-008)
    expect(byId.get('G6')).toBe('blocked'); // validation still open
    expect(byId.get('G8')).toBe('blocked'); // approval still open
    expect(est.conformity.openGates).toContain('G6');
    // Method references trace back to the formula registry.
    expect(est.methodRefs.length).toBeGreaterThan(5);
    expect(est.methodRefs).toContain('HL-001');
  });

  it('same input → same hash (reproducible); data quality in [0,1]', () => {
    const a = computeThermalEstimate([simpleRoom()], params, { modelRevision: 1, now: new Date(0) });
    const b = computeThermalEstimate([simpleRoom()], params, { modelRevision: 1, now: new Date(0) });
    expect(a.inputHash).toBe(b.inputHash);
    expect(a.dataQuality.score).toBeGreaterThanOrEqual(0);
    expect(a.dataQuality.score).toBeLessThanOrEqual(1);
  });

  it('property: heating load is monotincreasing in ΔT and never negative', () => {
    fc.assert(
      fc.property(fc.integer({ min: -25, max: 15 }), fc.integer({ min: 16, max: 26 }), (outC, inC) => {
        const p: ThermalParams = { designOutdoorTempC: outC, defaultIndoorTempC: inC };
        const room: RoomThermalInput = { ...simpleRoom(), indoorTempC: inC };
        const res = roomHeatingLoad(room, p);
        expect(res.totalW).toBeGreaterThanOrEqual(0);
        if (inC > outC) {
          const colder = roomHeatingLoad(room, { ...p, designOutdoorTempC: outC - 5 });
          expect(colder.totalW).toBeGreaterThanOrEqual(res.totalW - 1e-6);
        }
      }),
      { numRuns: 60 },
    );
  });
});
