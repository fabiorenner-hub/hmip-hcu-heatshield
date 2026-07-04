// @vitest-environment jsdom
/**
 * Global freshness/offline chip (Blueprint Phase 3).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import { h } from 'preact';

import { FreshnessChip } from '../../src/plugin/dashboard/spa/components/shell/freshnessChip.js';
import { snapshot } from '../../src/plugin/dashboard/spa/store.js';
import type { DashboardSnapshot } from '../../src/plugin/dashboard/spa/types.js';

function baseSnap(over: Partial<DashboardSnapshot>): DashboardSnapshot {
  return {
    ts: new Date().toISOString(),
    mode: 'NORMAL',
    rooms: [],
    windows: [],
    sources: { fusionSolar: { sourceOk: true, lastSuccess: '', consecutiveFailures: 0 }, hcu: { connected: true } },
    userIntent: { paused: false, pauseUntil: null, vacation: false },
    storm: { holdUntil: null },
    pluginReadiness: 'READY',
    ...over,
  } as DashboardSnapshot;
}

afterEach(() => {
  cleanup();
  snapshot.value = null;
});

describe('FreshnessChip', () => {
  it('renders nothing without a snapshot', () => {
    snapshot.value = null;
    const { container } = render(<FreshnessChip />);
    expect(container.querySelector('[data-testid="freshness-chip"]')).toBeNull();
  });

  it('shows fresh state for a recent snapshot', () => {
    snapshot.value = baseSnap({ ts: new Date().toISOString() });
    const { container } = render(<FreshnessChip />);
    expect(container.querySelector('[data-testid="freshness-chip"]')!.getAttribute('data-state')).toBe('fresh');
  });

  it('shows stale state for an old snapshot', () => {
    snapshot.value = baseSnap({ ts: new Date(Date.now() - 20 * 60000).toISOString() });
    const { container } = render(<FreshnessChip />);
    expect(container.querySelector('[data-testid="freshness-chip"]')!.getAttribute('data-state')).toBe('stale');
  });

  it('shows offline state when the HCU is disconnected', () => {
    snapshot.value = baseSnap({ sources: { fusionSolar: { sourceOk: false, lastSuccess: '', consecutiveFailures: 3 }, hcu: { connected: false } } });
    const { container } = render(<FreshnessChip />);
    expect(container.querySelector('[data-testid="freshness-chip"]')!.getAttribute('data-state')).toBe('offline');
  });
});
