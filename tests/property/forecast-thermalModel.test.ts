/**
 * Property-based tests for the thermal forecast model
 * (predictive-control-dashboard). Properties 2–6.
 */

import fc from 'fast-check';
import { describe, it, expect } from 'vitest';

import {
  forecastRoom,
  type ThermalForecastInputs,
} from '../../src/plugin/engine/forecast/thermalModel.js';

const NOW = new Date('2026-06-21T08:00:00.000Z');
const LOC = { latitude: 52.52, longitude: 13.41 };
const TARGETS = { target_c: 23, warning_c: 24.5, strong_shade_c: 25, critical_c: 26 };

function inputArb(overrides: Partial<ThermalForecastInputs> = {}): fc.Arbitrary<ThermalForecastInputs> {
  return fc
    .record({
      horizonHours: fc.integer({ min: 1, max: 48 }),
      timeStepMinutes: fc.integer({ min: 5, max: 60 }),
      indoorTempC: fc.double({ min: 10, max: 35, noNaN: true }),
      outdoorTempC: fc.double({ min: -5, max: 40, noNaN: true }),
      radiationWm2: fc.double({ min: 0, max: 1000, noNaN: true }),
      cloudCover01: fc.double({ min: 0, max: 1, noNaN: true }),
      pvPowerKw: fc.double({ min: 0, max: 9, noNaN: true }),
    })
    .map((r) => ({
      now: NOW,
      horizonHours: r.horizonHours,
      timeStepMinutes: r.timeStepMinutes,
      location: LOC,
      room: {
        id: 'r1',
        thermalInertiaMinutes: 120,
        indoorTempC: r.indoorTempC,
        targets: TARGETS,
      },
      windows: [
        { orientationDeg: 135, areaM2: 2, type: 'roof_window' as const, currentLevel01: 0 },
      ],
      outdoorTempC: r.outdoorTempC,
      forecastMaxTempC: r.outdoorTempC + 3,
      cloudCover01: r.cloudCover01,
      radiationWm2: r.radiationWm2,
      pvPowerKw: r.pvPowerKw,
      pvPeakKwp: 8.8,
      staleInputs: new Set<string>(),
      ...overrides,
    }));
}

describe('thermalModel — Properties 2–6', () => {
  // Feature: predictive-control-dashboard, Property 2: Trajektorien-Struktur (count, start, monotone ts).
  it('Property 2: correct point count, starts at now, strictly increasing ts', () => {
    fc.assert(
      fc.property(inputArb(), (inp) => {
        const t = forecastRoom(inp);
        expect(t).not.toBeNull();
        const pts = t!.points;
        const step = Math.min(60, Math.max(5, inp.timeStepMinutes));
        const h = Math.min(48, Math.max(1, inp.horizonHours));
        expect(pts.length).toBe(Math.floor((h * 60) / step) + 1);
        expect(pts[0]!.ts).toBe(NOW.toISOString());
        for (let i = 1; i < pts.length; i += 1) {
          expect(Date.parse(pts[i]!.ts)).toBeGreaterThan(Date.parse(pts[i - 1]!.ts));
        }
      }),
      { numRuns: 100 },
    );
  });

  // Feature: predictive-control-dashboard, Property 3: Determinismus.
  it('Property 3: identical inputs → identical output', () => {
    fc.assert(
      fc.property(inputArb(), (inp) => {
        expect(forecastRoom(inp)).toEqual(forecastRoom(inp));
      }),
      { numRuns: 100 },
    );
  });

  // Feature: predictive-control-dashboard, Property 4: Wärmelast normalisiert/geklemmt.
  it('Property 4: heatLoad01 ∈ [0,1] at every point', () => {
    fc.assert(
      fc.property(inputArb(), (inp) => {
        for (const p of forecastRoom(inp)!.points) {
          expect(p.heatLoad01).toBeGreaterThanOrEqual(0);
          expect(p.heatLoad01).toBeLessThanOrEqual(1);
        }
      }),
      { numRuns: 100 },
    );
  });

  // Feature: predictive-control-dashboard, Property 5: Monotonie der Wärmelast in Strahlung.
  it('Property 5: heatLoad non-decreasing in radiation, all else equal', () => {
    fc.assert(
      fc.property(
        inputArb(),
        fc.double({ min: 0, max: 1000, noNaN: true }),
        fc.double({ min: 0, max: 1000, noNaN: true }),
        (inp, a, b) => {
          const lo = Math.min(a, b);
          const hi = Math.max(a, b);
          const loT = forecastRoom({ ...inp, radiationWm2: lo })!.points;
          const hiT = forecastRoom({ ...inp, radiationWm2: hi })!.points;
          for (let i = 0; i < loT.length; i += 1) {
            expect(hiT[i]!.heatLoad01).toBeGreaterThanOrEqual(loT[i]!.heatLoad01 - 1e-9);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: predictive-control-dashboard, Property 6: Unsicherheitskennzeichnung.
  it('Property 6: stale input → uncertain and confidence ≤ 0.5', () => {
    fc.assert(
      fc.property(inputArb({ staleInputs: new Set(['outdoorTemp']) }), (inp) => {
        const t = forecastRoom(inp)!;
        expect(t.uncertain).toBe(true);
        expect(t.confidence01).toBeLessThanOrEqual(0.5);
      }),
      { numRuns: 50 },
    );
  });

  it('returns null when all required inputs are missing (2.7)', () => {
    const t = forecastRoom({
      ...({} as ThermalForecastInputs),
      now: NOW,
      horizonHours: 12,
      timeStepMinutes: 15,
      location: LOC,
      room: { id: 'r1', thermalInertiaMinutes: 120, indoorTempC: null, targets: TARGETS },
      windows: [],
      outdoorTempC: null,
      forecastMaxTempC: null,
      cloudCover01: null,
      radiationWm2: null,
      pvPowerKw: null,
      pvPeakKwp: 8.8,
      staleInputs: new Set(['outdoorTemp', 'radiation']),
    });
    expect(t).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A1/A2: per-timestamp forecast sampler (predictive-control-dashboard catalog).
// ---------------------------------------------------------------------------

describe('thermalModel — sampleForecast (A1/A2)', () => {
  const base = (): ThermalForecastInputs => ({
    now: NOW,
    horizonHours: 6,
    timeStepMinutes: 60,
    location: LOC,
    room: { id: 'r1', thermalInertiaMinutes: 120, indoorTempC: 22, targets: TARGETS },
    windows: [
      { orientationDeg: 135, areaM2: 2, type: 'roof_window' as const, currentLevel01: 0 },
    ],
    outdoorTempC: 20,
    forecastMaxTempC: 28,
    cloudCover01: 0,
    radiationWm2: 0, // current (e.g. nighttime) value
    pvPowerKw: 5,
    pvPeakKwp: 8.8,
    staleInputs: new Set<string>(),
  });

  it('uses the radiation curve from the sampler instead of the constant now value', () => {
    // Without a sampler, radiation is the constant 0 → daytime heat load 0.
    const flat = forecastRoom(base());
    expect(flat).not.toBeNull();
    const flatMax = Math.max(...flat!.points.map((p) => p.heatLoad01));
    expect(flatMax).toBe(0);

    // With a sampler returning strong midday radiation, daytime load rises.
    const withCurve = forecastRoom({
      ...base(),
      sampleForecast: () => ({ radiationWm2: 800, cloudCover01: 0, outdoorTempC: 26 }),
    });
    expect(withCurve).not.toBeNull();
    const curveMax = Math.max(...withCurve!.points.map((p) => p.heatLoad01));
    expect(curveMax).toBeGreaterThan(0);
  });

  it('is monotone non-increasing in cloud cover (more cloud → ≤ heat load)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 0.5, noNaN: true }),
        fc.double({ min: 0.5, max: 1, noNaN: true }),
        (clear, cloudy) => {
          const clearTraj = forecastRoom({
            ...base(),
            sampleForecast: () => ({ radiationWm2: 700, cloudCover01: clear, outdoorTempC: 25 }),
          });
          const cloudyTraj = forecastRoom({
            ...base(),
            sampleForecast: () => ({ radiationWm2: 700, cloudCover01: cloudy, outdoorTempC: 25 }),
          });
          const clearMax = Math.max(...clearTraj!.points.map((p) => p.heatLoad01));
          const cloudyMax = Math.max(...cloudyTraj!.points.map((p) => p.heatLoad01));
          expect(cloudyMax).toBeLessThanOrEqual(clearMax + 1e-9);
        },
      ),
      { numRuns: 50 },
    );
  });
});
