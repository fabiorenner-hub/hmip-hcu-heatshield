// @vitest-environment jsdom
/**
 * ui-v2-release Task 9.5 — expert safety/spec guardrails (property-based).
 *
 * - Property 9: Expert ⊇ Basic (Basic surface is a subset of Expert).
 * - Property 10 / R6.7: STORM precedence — manual control is locked whenever a
 *   storm (mode or hold) is active; manual shutter commands are always a
 *   spec-valid level01 ∈ [0,1].
 */

import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, fireEvent } from '@testing-library/preact';
import { h } from 'preact';

import { LiquidGlass2Overview } from '../../src/plugin/dashboard/spa/components/liquidglass2/liquidGlass2Overview.js';
import { snapshot } from '../../src/plugin/dashboard/spa/store.js';
import { setExpertMode } from '../../src/plugin/dashboard/spa/expertMode.js';
import type { DashboardSnapshot } from '../../src/plugin/dashboard/spa/types.js';

function full(over: Record<string, unknown> = {}): DashboardSnapshot {
  const now = new Date().toISOString();
  return {
    ts: now, mode: 'ACTIVE_HEAT_PROTECTION', rooms: [],
    windows: [{ id: 'w1', name: 'Schlafzimmer', currentLevel01: 0.6, manualOverrideUntil: null, lastDecisionMode: 'ACTIVE_HEAT_PROTECTION' }],
    sources: { fusionSolar: { sourceOk: true, lastSuccess: now, consecutiveFailures: 0 }, hcu: { connected: true } },
    userIntent: { paused: false, pauseUntil: null, vacation: false },
    storm: { holdUntil: null }, pluginReadiness: 'READY',
    modeInfo: { id: 'active', label: 'Aktiv', goal: '', reasons: [] },
    plannedActions: [{ windowId: 'w1', scheduledTs: now, targetPercent: 60, reason: 'x', state: 'scheduled' }],
    roomsDetail: [{ id: 'r1', name: 'Schlafzimmer', facade: 'S', shutterPercent: 60, indoorTempC: 24, trend: 'up', nextAction: null, status: 'scheduled', windowId: 'w1', heatLoad01: 0.5 }],
    ...over,
  } as unknown as DashboardSnapshot;
}

function testIds(root: Element | null): Set<string> {
  const out = new Set<string>();
  root?.querySelectorAll('[data-testid]').forEach((el) => {
    const id = el.getAttribute('data-testid');
    if (id !== null) out.add(id);
  });
  return out;
}

afterEach(() => {
  cleanup();
  snapshot.value = null;
  setExpertMode(false);
  vi.restoreAllMocks();
});

describe('Property 9 — Expert ⊇ Basic (overview)', () => {
  it('every testid shown in basic is also shown in expert', () => {
    snapshot.value = full();
    setExpertMode(false);
    const basic = render(<LiquidGlass2Overview />);
    const basicIds = testIds(basic.container);
    cleanup();
    setExpertMode(true);
    const expert = render(<LiquidGlass2Overview />);
    const expertIds = testIds(expert.container);
    for (const id of basicIds) expect(expertIds.has(id)).toBe(true);
    // Expert strictly adds panels.
    expect(expertIds.size).toBeGreaterThan(basicIds.size);
  });
});

describe('Property 10 / R6.7 — STORM precedence locks manual control', () => {
  it('locks manual control whenever a storm is active, else offers it', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<DashboardSnapshot['mode']>('NORMAL', 'SUMMER_WATCH', 'ACTIVE_HEAT_PROTECTION', 'HEATWAVE', 'NIGHT_COOLING', 'STORM'),
        fc.boolean(),
        (mode, hold) => {
          const stormActive = mode === 'STORM' || hold;
          snapshot.value = full({ mode, storm: { holdUntil: hold ? new Date(Date.now() + 3600_000).toISOString() : null } });
          setExpertMode(true);
          const { container } = render(<LiquidGlass2Overview />);
          const control = container.querySelector('[data-testid="lg2-expert-control"]');
          const locked = container.querySelector('[data-testid="lg2-expert-control-locked"]') !== null;
          const buttons = control?.querySelectorAll('button').length ?? 0;
          if (stormActive) {
            expect(locked).toBe(true);
            expect(buttons).toBe(0);
          } else {
            expect(locked).toBe(false);
            expect(buttons).toBeGreaterThan(0);
          }
          cleanup();
        },
      ),
      { numRuns: 30 },
    );
  });
});

describe('R6.7 — manual shutter commands are spec-valid level01 ∈ [0,1]', () => {
  it('only ever POSTs a level01 within [0,1]', () => {
    const levels: number[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { level01?: number };
      if (typeof body.level01 === 'number') levels.push(body.level01);
      return { ok: true, status: 200 } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    snapshot.value = full();
    setExpertMode(true);
    const { container } = render(<LiquidGlass2Overview />);
    const control = container.querySelector('[data-testid="lg2-expert-control"]');
    control?.querySelectorAll('button').forEach((b) => fireEvent.click(b));

    expect(levels.length).toBeGreaterThan(0);
    for (const l of levels) {
      expect(l).toBeGreaterThanOrEqual(0);
      expect(l).toBeLessThanOrEqual(1);
    }
  });
});
