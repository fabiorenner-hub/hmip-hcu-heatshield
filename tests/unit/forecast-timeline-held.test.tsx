// @vitest-environment jsdom
/**
 * "Nächste Aktionen": a planned action for a window that will NOT move
 * (manual override or automation off) must render as held — "keine Fahrt",
 * no "auf X %" — not as a real scheduled move.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import { h } from 'preact';

import { ForecastTimeline } from '../../src/plugin/dashboard/spa/components/dashboard/forecastTimeline.js';
import type { DashboardSnapshot } from '../../src/plugin/dashboard/spa/types.js';

const NOW = new Date('2026-06-21T18:00:00.000Z');

function snap(state: 'manuallyOverridden' | 'blocked' | 'scheduled'): DashboardSnapshot {
  return {
    ts: NOW.toISOString(),
    mode: 'HEATWAVE',
    forecastTimeline: [
      { ts: NOW.toISOString(), weatherIcon: '☀️', tempC: 30, radiationWm2: 600, precipitationOrCloud01: 0.1 },
    ],
    plannedActions: [
      {
        windowId: 'w-f97e',
        scheduledTs: new Date(NOW.getTime() + 27 * 60_000).toISOString(),
        targetPercent: 0,
        reason: 'x',
        state,
      },
    ],
    windows: [{ id: 'w-f97e', name: 'Schlafzimmer – Rollo (…F97E)', currentLevel01: 0.64, manualOverrideUntil: null, lastDecisionMode: null }],
  } as unknown as DashboardSnapshot;
}

afterEach(() => cleanup());

describe('ForecastTimeline — held actions', () => {
  it('renders a manual-override action as held (no move, no target %)', () => {
    const { container } = render(h(ForecastTimeline, { snapshot: snap('manuallyOverridden'), now: NOW }));
    const chip = container.querySelector('[data-testid="action-chip"]')!;
    expect(chip).not.toBeNull();
    expect(chip.className).toContain('action--held');
    const txt = chip.textContent ?? '';
    expect(txt).toContain('manuell übersteuert');
    expect(txt).toContain('keine Fahrt');
    expect(txt).not.toContain('auf 0 %');
  });

  it('renders an automation-off action as held', () => {
    const { container } = render(h(ForecastTimeline, { snapshot: snap('blocked'), now: NOW }));
    const chip = container.querySelector('[data-testid="action-chip"]')!;
    expect(chip.className).toContain('action--held');
    expect(chip.textContent ?? '').toContain('keine Fahrt');
  });

  it('renders a normal scheduled action with target % and ETA', () => {
    const { container } = render(h(ForecastTimeline, { snapshot: snap('scheduled'), now: NOW }));
    const chip = container.querySelector('[data-testid="action-chip"]')!;
    expect(chip.className).not.toContain('action--held');
    const txt = chip.textContent ?? '';
    expect(txt).toContain('0 %');
    expect(txt).toContain('27 min');
  });
});
