// @vitest-environment jsdom
/**
 * Systemzustand (Blueprint Phase 9): friendly health overview derived from the
 * live snapshot. Verifies the traffic-light headline for the healthy/degraded/
 * down cases and the connection cards.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import { h } from 'preact';

import { SystemView } from '../../src/plugin/dashboard/spa/tabs/system.js';
import { snapshot } from '../../src/plugin/dashboard/spa/store.js';
import type { DashboardSnapshot } from '../../src/plugin/dashboard/spa/types.js';

function baseSnap(overrides: Partial<DashboardSnapshot> = {}): DashboardSnapshot {
  const now = new Date().toISOString();
  return {
    ts: now,
    mode: 'SUMMER_WATCH',
    rooms: [{ id: 'r1', currentLevel01: 0.5, manualOverrideUntil: null, lastDecisionMode: null }],
    windows: [
      { id: 'w1', currentLevel01: 0.5, manualOverrideUntil: null, lastDecisionMode: null },
      { id: 'w2', currentLevel01: 0.5, manualOverrideUntil: null, lastDecisionMode: null },
    ],
    sources: {
      fusionSolar: { sourceOk: true, lastSuccess: now, consecutiveFailures: 0 },
      hcu: { connected: true },
    },
    userIntent: { paused: false, pauseUntil: null, vacation: false },
    storm: { holdUntil: null },
    pluginReadiness: 'READY',
    automationEnabled: true,
    ...overrides,
  } as DashboardSnapshot;
}

afterEach(() => {
  cleanup();
  snapshot.value = null;
});

describe('SystemView', () => {
  it('shows an OK health headline when connected, ready and fresh', () => {
    snapshot.value = baseSnap();
    const { container } = render(<SystemView />);
    const health = container.querySelector('[data-testid="sys-health"]') as HTMLElement;
    expect(health).not.toBeNull();
    expect(health.getAttribute('data-health')).toBe('ok');
    expect(container.querySelector('[data-testid="sys-card-inventory"]')?.textContent).toContain('2');
  });

  it('reports down when the HCU is disconnected', () => {
    snapshot.value = baseSnap({ sources: { fusionSolar: { sourceOk: false, lastSuccess: null, consecutiveFailures: 9 }, hcu: { connected: false } } });
    const { container } = render(<SystemView />);
    expect(container.querySelector('[data-testid="sys-health"]')?.getAttribute('data-health')).toBe('down');
  });

  it('reports warn when configuration is required', () => {
    snapshot.value = baseSnap({ pluginReadiness: 'CONFIG_REQUIRED' });
    const { container } = render(<SystemView />);
    expect(container.querySelector('[data-testid="sys-health"]')?.getAttribute('data-health')).toBe('warn');
  });

  it('renders a loading hint when no snapshot is present', () => {
    snapshot.value = null;
    const { container } = render(<SystemView />);
    expect(container.querySelector('[data-testid="tab-system"]')).not.toBeNull();
  });
});
