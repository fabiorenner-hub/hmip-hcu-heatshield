// @vitest-environment jsdom
/**
 * Heat Shield — lg2-native "Regeln & Grenzwerte" + Simulation (ui-v2-release
 * Runde 12, Requirement 14). Verifies the page is reachable/renders, exposes
 * the v1 slider set + profile switch, and runs a real dry-run simulation
 * (POST /api/probe/run) that reports a result.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, fireEvent } from '@testing-library/preact';
import { h } from 'preact';

import { LiquidGlass2Rules } from '../../src/plugin/dashboard/spa/components/liquidglass2/liquidGlass2Rules.js';
import { __resetConfigStateForTests } from '../../src/plugin/dashboard/spa/hooks/useConfig.js';
import { setExpertMode } from '../../src/plugin/dashboard/spa/expertMode.js';

function config(): Record<string, unknown> {
  return {
    windows: [{ id: 'w1', roomId: 'r1' }],
    rooms: [{ id: 'r1', name: 'Schlafzimmer' }],
    learning: { autoApply: false },
    rules: {
      profile: 'standard',
      comfort: { maxIndoorTempC: 25, preShadeTempC: 23.5, vacationOffsetC: 0.5 },
      automation: { controlIntervalSeconds: 180, minSecondsBetweenMoves: 900, minPositionDeltaPct: 15, quietHours: { enabled: false, startHour: 22, endHour: 6 } },
      sun: { minElevationDeg: 5 },
      storm: { enabled: true, thresholdMs: 13.9 },
      nightCooling: { enabled: true, deltaC: 1.5 },
      heatLoad: { pvWeight: 0.5, tempWeight: 0.3, trendWeight: 0.2, activateThreshold: 0.45, releaseThreshold: 0.3, releaseHoldMinutes: 60, trendWindowHours: 3 },
      insulation: { enabled: false, maxOutdoorTempC: 5, level01: 1 },
      hotDay: { enabled: true, outdoorThresholdC: 35, maxOpenPercent: 50 },
      floorShading: { enabled: true, leadByFloor: {} },
    },
  };
}

function installFetch(): ReturnType<typeof vi.fn> {
  const impl = async (input: unknown, init?: unknown): Promise<unknown> => {
    const url = typeof input === 'string' ? input : String(input);
    const method = ((init ?? {}) as { method?: string }).method ?? 'GET';
    if (url.includes('/api/config') && method === 'GET') {
      return { ok: true, status: 200, json: async (): Promise<unknown> => config() };
    }
    if (url.includes('/api/config/probe')) {
      return { ok: true, status: 200, json: async (): Promise<unknown> => ({ mode: 'ACTIVE_HEAT_PROTECTION', windowDecisions: [{ windowId: 'w1', finalTarget: 0.5 }] }) };
    }
    if (url.includes('/api/probe/run')) {
      return { ok: true, status: 200, json: async (): Promise<unknown> => ({ mode: 'SUMMER_WATCH', windowDecisions: [{ windowId: 'w1', finalTarget: 0.3 }] }) };
    }
    if (url.includes('/api/config') && method === 'PUT') {
      return { ok: true, status: 200, json: async (): Promise<unknown> => config() };
    }
    throw new Error(`unmatched fetch: ${method} ${url}`);
  };
  const fn = vi.fn(impl);
  (globalThis as unknown as { fetch: typeof fetch }).fetch = fn as unknown as typeof fetch;
  return fn;
}

beforeEach(() => {
  __resetConfigStateForTests();
  installFetch();
  // Live preview + Simulation are expert-only (hidden in Basis); enable expert
  // mode so these tests exercise them.
  setExpertMode(true);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setExpertMode(false);
});

describe('LiquidGlass2Rules', () => {
  it('renders the reachable lg2-native rules editor with the v1 slider set + profiles', async () => {
    const { container, findByTestId } = render(<LiquidGlass2Rules />);
    // Editor renders (not empty, no redirect).
    expect(container.querySelector('[data-testid="liquid-glass2-rules"]')).not.toBeNull();
    // Config loads → sliders appear.
    await findByTestId('lg2-rules-slider-comfort.maxIndoorTempC');
    // Profile switch + a representative subset of the v1 slider set present.
    expect(container.querySelector('[data-testid="lg2-rules-profile-standard"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="lg2-rules-slider-storm.thresholdMs"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="lg2-rules-slider-heatLoad.trendWindowHours"]')).not.toBeNull();
    // Extensions + simulation panel present.
    expect(container.querySelector('[data-testid="lg2-rules-storm"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="lg2-rules-simulation"]')).not.toBeNull();
  });

  it('runs a real simulation and shows the result with a persistent no-move hint', async () => {
    const { findByTestId } = render(<LiquidGlass2Rules />);
    await findByTestId('lg2-rules-slider-comfort.maxIndoorTempC');
    const btn = await findByTestId('lg2-rules-sim-run');
    fireEvent.click(btn);
    const result = await findByTestId('lg2-rules-sim-result');
    expect(result.textContent).toContain('30 %'); // finalTarget 0.3 → 30 %
    // The "no shutter is moved" note stays visible alongside the result.
    expect((await findByTestId('lg2-rules-sim-note')).textContent).toMatch(/KEIN|NO/);
  });

  it('exposes all 17 threshold sliders (v1 set + indoor target temperature)', async () => {
    const { container, findByTestId } = render(<LiquidGlass2Rules />);
    await findByTestId('lg2-rules-slider-comfort.maxIndoorTempC');
    // Count only the threshold sliders (testid prefix), not other range inputs
    // like the evening-open control that share the range styling class.
    const sliders = container.querySelectorAll('input[data-testid^="lg2-rules-slider-"]');
    expect(sliders.length).toBe(17);
  });
});
