// @vitest-environment jsdom
/**
 * Räume master/detail (Blueprint Phase 5): clicking a room opens the detail.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, fireEvent } from '@testing-library/preact';
import { h } from 'preact';

import { RaeumeView } from '../../src/plugin/dashboard/spa/tabs/raeume.js';
import { snapshot, setRiskBreakdowns } from '../../src/plugin/dashboard/spa/store.js';
import type { DashboardSnapshot, RoomDetail } from '../../src/plugin/dashboard/spa/types.js';

const room: RoomDetail = {
  id: 'schlafzimmer',
  name: 'Schlafzimmer',
  facade: 'S',
  shutterPercent: 60,
  indoorTempC: 24.5,
  trend: 'up',
  nextAction: null,
  status: 'recommended',
  windowId: 'w1',
};

function snap(): DashboardSnapshot {
  const now = new Date().toISOString();
  return {
    ts: now,
    mode: 'ACTIVE_HEAT_PROTECTION',
    rooms: [],
    windows: [],
    sources: { fusionSolar: { sourceOk: true, lastSuccess: now, consecutiveFailures: 0 }, hcu: { connected: true } },
    userIntent: { paused: false, pauseUntil: null, vacation: false },
    storm: { holdUntil: null },
    pluginReadiness: 'READY',
    facades: { N: 10, E: 20, S: 70, W: 15 },
    roomsDetail: [room],
  } as DashboardSnapshot;
}

afterEach(() => {
  cleanup();
  snapshot.value = null;
  setRiskBreakdowns([]);
});

describe('RaeumeView master/detail', () => {
  it('opens the room detail when a room row is clicked', () => {
    snapshot.value = snap();
    const { container } = render(<RaeumeView />);
    expect(container.querySelector('[data-testid="module-raeume"]')).not.toBeNull();
    const row = container.querySelector('[data-testid="room-row-schlafzimmer"]') as HTMLElement;
    expect(row).not.toBeNull();
    fireEvent.click(row);
    // RoomDetailModal renders via a Portal into document.body.
    expect(document.querySelector('[data-testid="room-detail-schlafzimmer"]')).not.toBeNull();
  });
});
