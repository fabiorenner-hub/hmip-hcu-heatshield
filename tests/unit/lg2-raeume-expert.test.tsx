// @vitest-environment jsdom
/**
 * Liquid Glass V2 Räume — expert expansion (ui-v2-release, Task 9.3).
 * Learned-model panel + manual per-room control with the STORM safety lock.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import { h } from 'preact';

import { LiquidGlass2Raeume } from '../../src/plugin/dashboard/spa/components/liquidglass2/liquidGlass2Raeume.js';
import { snapshot } from '../../src/plugin/dashboard/spa/store.js';
import { setExpertMode } from '../../src/plugin/dashboard/spa/expertMode.js';
import type { DashboardSnapshot, RoomDetail } from '../../src/plugin/dashboard/spa/types.js';

function room(): RoomDetail {
  return {
    id: 'schlafzimmer', name: 'Schlafzimmer', facade: 'S', shutterPercent: 60,
    indoorTempC: 24.5, trend: 'up', nextAction: null, status: 'scheduled',
    windowId: 'w1', heatLoad01: 0.6,
  } as RoomDetail;
}

function snap(over: Partial<DashboardSnapshot> = {}): DashboardSnapshot {
  return {
    ts: new Date().toISOString(),
    mode: 'ACTIVE_HEAT_PROTECTION',
    rooms: [],
    windows: [{ id: 'w1', name: 'Schlafzimmer', currentLevel01: 0.6, manualOverrideUntil: null, lastDecisionMode: 'ACTIVE_HEAT_PROTECTION' }],
    sources: { fusionSolar: { sourceOk: true, lastSuccess: '', consecutiveFailures: 0 }, hcu: { connected: true } },
    userIntent: { paused: false, pauseUntil: null, vacation: false },
    storm: { holdUntil: null },
    pluginReadiness: 'READY',
    roomsDetail: [room()],
    learning: {
      days: 5,
      rooms: [{
        id: 'schlafzimmer', name: 'Schlafzimmer', sampleDays: 5, avgIndoorPeakC: 26.2,
        avgOvershootC: 1.2, avgMovesPerDay: 2.4, comfortBiasC: -0.3,
        recommendationLevel: 'balanced', recommendation: 'Ausgewogen.',
      }],
    },
    ...over,
  } as DashboardSnapshot;
}

afterEach(() => {
  cleanup();
  snapshot.value = null;
  setExpertMode(false);
});

describe('LiquidGlass2Raeume expert', () => {
  it('shows the learned-model panel and manual control in expert mode', () => {
    snapshot.value = snap();
    setExpertMode(true);
    const { container } = render(<LiquidGlass2Raeume />);
    expect(container.querySelector('[data-testid="lg2-expert-room-learning"]')).not.toBeNull();
    const control = container.querySelector('[data-testid="lg2-expert-room-control"]');
    expect(control?.querySelectorAll('button').length).toBe(3);
  });

  it('hides expert panels in basic mode', () => {
    snapshot.value = snap();
    setExpertMode(false);
    const { container } = render(<LiquidGlass2Raeume />);
    expect(container.querySelector('[data-testid="lg2-expert-room-learning"]')).toBeNull();
    expect(container.querySelector('[data-testid="lg2-expert-room-control"]')).toBeNull();
  });

  it('locks manual control during storm protection', () => {
    snapshot.value = snap({ mode: 'STORM' });
    setExpertMode(true);
    const { container } = render(<LiquidGlass2Raeume />);
    expect(container.querySelector('[data-testid="lg2-expert-room-control-locked"]')).not.toBeNull();
    const control = container.querySelector('[data-testid="lg2-expert-room-control"]');
    expect(control?.querySelectorAll('button').length).toBe(0);
  });
});
