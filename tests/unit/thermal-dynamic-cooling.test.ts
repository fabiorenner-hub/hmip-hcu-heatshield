/**
 * Dynamic cooling RC core (reduced 2-node model, VDI 2078/6007 structure,
 * non-normative). Verifies stability + physically-correct behaviour: cooling
 * caps the air node, higher thermal mass damps the peak, no gains → no cooling,
 * and the peak lags the solar peak (storage).
 */

import { describe, expect, it } from 'vitest';

import {
  simulateDesignDay,
  buildDesignDay,
  rcInputsFromRoom,
  type RcRoomParams,
} from '../../src/shared/thermal/dynamic-cooling.js';

function room(): RcRoomParams {
  return { caJ: 60 * 1.2 * 1005, cmJ: 20 * 150000, hVeW: 8.5, hWinW: 6, hMsW: 9 * 2.5 * 20, hEmW: 20, coolingSetpointC: 26 };
}

describe('dynamic cooling RC core', () => {
  it('caps the air temperature at the cooling setpoint', () => {
    const series = buildDesignDay({ peakOutdoorC: 34, minOutdoorC: 20, peakSolarW: 1500 });
    const r = simulateDesignDay(room(), series, { days: 4 });
    expect(Math.max(...r.airC)).toBeLessThanOrEqual(26 + 1e-6);
    expect(r.peakCoolingW).toBeGreaterThan(0);
  });

  it('no gains and outdoor == setpoint → no cooling', () => {
    const flat = buildDesignDay({ peakOutdoorC: 26, minOutdoorC: 26, peakSolarW: 0 });
    const r = simulateDesignDay(room(), flat, { days: 3, initialC: 26 });
    expect(r.peakCoolingW).toBeCloseTo(0, 3);
  });

  it('higher thermal mass damps the peak cooling load (storage)', () => {
    const series = buildDesignDay({ peakOutdoorC: 34, minOutdoorC: 20, peakSolarW: 1500 });
    const light = simulateDesignDay({ ...room(), cmJ: 20 * 50000 }, series, { days: 4 });
    const heavy = simulateDesignDay({ ...room(), cmJ: 20 * 400000 }, series, { days: 4 });
    expect(heavy.peakCoolingW).toBeLessThan(light.peakCoolingW);
  });

  it('is stable with a coarse step (implicit Euler): finite temperatures', () => {
    const series = buildDesignDay({ peakOutdoorC: 38, minOutdoorC: 18, peakSolarW: 3000 });
    const r = simulateDesignDay(room(), series, { days: 3, subStepsPerHour: 1 });
    expect(r.airC.every((v) => Number.isFinite(v))).toBe(true);
    expect(r.massC.every((v) => Number.isFinite(v))).toBe(true);
  });

  it('free-float peak lags the solar peak (12:00) due to storage', () => {
    const series = buildDesignDay({ peakOutdoorC: 30, minOutdoorC: 22, peakSolarW: 1500 });
    // Free float: raise the setpoint so no cooling caps the air node.
    const r = simulateDesignDay({ ...room(), coolingSetpointC: 100 }, series, { days: 5 });
    let peakOpHour = 0;
    let peak = -Infinity;
    r.operativeC.forEach((v, h) => { if (v > peak) { peak = v; peakOpHour = h; } });
    expect(peakOpHour).toBeGreaterThanOrEqual(12);
  });

  it('rcInputsFromRoom derives sane parameters + solar aperture', () => {
    const built = rcInputsFromRoom({
      floorAreaM2: 20,
      volumeM3: 50,
      airChangeRate: 0.5,
      surfaces: [
        { areaM2: 10, uValue: 0.3, boundary: 'exterior' },
        { areaM2: 2, uValue: 1.3, boundary: 'exterior', glazing: true, gTotal: 0.5, shadingFactor: 0.7 },
      ],
    });
    expect(built.params.cmJ).toBeGreaterThan(0);
    expect(built.params.hWinW).toBeCloseTo(2 * 1.3, 6);
    expect(built.params.hEmW).toBeCloseTo(10 * 0.3, 6);
    expect(built.solarApertureM2).toBeCloseTo(2 * 0.5 * 0.7, 6);
  });
});
