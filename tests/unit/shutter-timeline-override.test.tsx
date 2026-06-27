// @vitest-environment jsdom
/**
 * ShutterTimeline — an active manual override must HOLD the room's position
 * across the 12 h timeline (no phantom planned move) and show a "Manuell" tag.
 * Regression for: "two active overrides, yet the rooms are shown opening".
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import { h } from 'preact';

import { ShutterTimeline } from '../../src/plugin/dashboard/spa/components/dashboard/analysisRail.js';
import type { RoomDetail } from '../../src/plugin/dashboard/spa/types.js';

const NOW = new Date('2026-06-21T20:00:00.000Z');

function room(partial: Partial<RoomDetail> & Pick<RoomDetail, 'id' | 'name'>): RoomDetail {
  return {
    facade: 'S',
    shutterPercent: 64,
    indoorTempC: 24,
    trend: 'flat',
    nextAction: null,
    status: 'completed',
    ...partial,
  } as RoomDetail;
}

afterEach(() => cleanup());

describe('ShutterTimeline — manual override', () => {
  it('holds the position and tags the row when an override is active', () => {
    // Override active for the next 6 h; the planner still wants to open (0 %)
    // "now" — that move must NOT show while the override holds.
    const overrideUntil = new Date(NOW.getTime() + 6 * 3_600_000).toISOString();
    const rooms: RoomDetail[] = [
      room({
        id: 'gästezimmer',
        name: 'Gästezimmer',
        shutterPercent: 64,
        manualOverrideUntil: overrideUntil,
        nextAction: {
          windowId: 'w-guest',
          scheduledTs: overrideUntil, // deferred to expiry by the producer
          targetPercent: 0,
          reason: 'x',
          state: 'manuallyOverridden',
        },
      }),
    ];
    const { container } = render(h(ShutterTimeline, { rooms, now: NOW }));

    // The "Manuell" tag is present.
    expect(
      container.querySelector('[data-testid="heatmap-override-gästezimmer"]'),
    ).not.toBeNull();

    // Every cell within the override window holds 64 % (no 0 % open cell).
    const cells = Array.from(
      container.querySelectorAll('[data-testid="heatmap-row-gästezimmer"] .heatmap-cell'),
    );
    expect(cells.length).toBe(7);
    // Buckets strictly inside the 6 h override (20:00, 22:00, 00:00) hold 64 %.
    for (let i = 0; i < 3; i += 1) {
      expect(cells[i]!.getAttribute('title')).toContain('64 %');
    }
    // After the override expires the deferred plan resumes (opens to 0 %).
    expect(cells[6]!.getAttribute('title')).toContain('0 %');
  });

  it('shows no override tag and follows the plan when no override is set', () => {
    const rooms: RoomDetail[] = [
      room({
        id: 'wohnzimmer',
        name: 'Wohnzimmer',
        shutterPercent: 64,
        nextAction: {
          windowId: 'w-living',
          scheduledTs: NOW.toISOString(),
          targetPercent: 0,
          reason: 'x',
          state: 'scheduled',
        },
      }),
    ];
    const { container } = render(h(ShutterTimeline, { rooms, now: NOW }));
    expect(
      container.querySelector('[data-testid="heatmap-override-wohnzimmer"]'),
    ).toBeNull();
    // Future buckets follow the plan → 0 % open.
    const cells = Array.from(
      container.querySelectorAll('[data-testid="heatmap-row-wohnzimmer"] .heatmap-cell'),
    );
    expect(cells[6]!.getAttribute('title')).toContain('0 %');
  });
});
