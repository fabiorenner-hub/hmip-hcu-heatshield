/**
 * Heat Shield — sun-arc scrubbing / simulation property tests
 * (predictive-control-dashboard Task 16.1).
 */

import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';

import {
  runScrubSession,
  computeScrubFrame,
  isControlEndpoint,
  type ScrubInputs,
} from '../../src/plugin/dashboard/spa/components/dashboard/simulation.js';
import type { PlannedAction } from '../../src/plugin/dashboard/spa/types.js';

const plannedActionArb: fc.Arbitrary<PlannedAction> = fc.record({
  windowId: fc.string({ minLength: 1, maxLength: 8 }),
  scheduledTs: fc
    .integer({ min: Date.UTC(2026, 0, 1), max: Date.UTC(2026, 11, 31) })
    .map((ms) => new Date(ms).toISOString()),
  targetPercent: fc.integer({ min: 0, max: 100 }),
  reason: fc.string({ minLength: 1, maxLength: 20 }),
  state: fc.constantFrom('scheduled', 'recommended', 'completed') as fc.Arbitrary<
    PlannedAction['state']
  >,
});

const inputsArb: fc.Arbitrary<ScrubInputs> = fc.record({
  latitude: fc.double({ min: -65, max: 65, noNaN: true }),
  longitude: fc.double({ min: -180, max: 180, noNaN: true }),
  cloud01: fc.double({ min: 0, max: 1, noNaN: true }),
  pvSonnenindex01: fc.double({ min: 0, max: 1, noNaN: true }),
  plannedActions: fc.array(plannedActionArb, { maxLength: 6 }),
});

const scrubTimesArb: fc.Arbitrary<Date[]> = fc.array(
  fc
    .integer({ min: Date.UTC(2026, 5, 21, 0), max: Date.UTC(2026, 5, 21, 23, 59) })
    .map((ms) => new Date(ms)),
  { minLength: 1, maxLength: 12 },
);

describe('simulation mode (Property 18)', () => {
  // Feature: predictive-control-dashboard, Property 18: Für beliebige Folge von
  // Scrub-Zeitpunkten im Simulationsmodus wird kein Steuer-Request
  // (setShutter/control) an die Engine ausgelöst; es werden ausschließlich
  // lesende, client-seitige Neuberechnungen durchgeführt.
  it('never issues a control request while scrubbing', () => {
    fc.assert(
      fc.property(scrubTimesArb, inputsArb, (times, inputs) => {
        const control = vi.fn((_url: string) => undefined);
        const frames = runScrubSession(times, { inputs, control });
        // No control endpoint was ever invoked during scrubbing.
        expect(control).not.toHaveBeenCalled();
        // A read-only frame was produced for each scrub instant.
        expect(frames).toHaveLength(times.length);
        for (const f of frames) {
          for (const k of ['N', 'E', 'S', 'W'] as const) {
            expect(f.facades[k]).toBeGreaterThanOrEqual(0);
            expect(f.facades[k]).toBeLessThanOrEqual(100);
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it('computeScrubFrame is pure and only surfaces already-loaded planned actions', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: Date.UTC(2026, 5, 21, 0), max: Date.UTC(2026, 5, 21, 23) }),
        inputsArb,
        (ms, inputs) => {
          const t = new Date(ms);
          const frame = computeScrubFrame(t, inputs);
          // Every surfaced action was already in the loaded plan (no new ones).
          for (const a of frame.activePlanned) {
            expect(inputs.plannedActions).toContainEqual(a);
            expect(Date.parse(a.scheduledTs)).toBeLessThanOrEqual(ms);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('classifies control endpoints', () => {
    expect(isControlEndpoint('/api/control/shutter/w1')).toBe(true);
    expect(isControlEndpoint('/api/setShutterLevel')).toBe(true);
    expect(isControlEndpoint('/api/forecast?roomId=x')).toBe(false);
    expect(isControlEndpoint('/api/plan')).toBe(false);
  });
});
