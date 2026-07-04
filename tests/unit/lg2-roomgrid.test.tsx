// @vitest-environment jsdom
/**
 * RoomGrid — classic "1.20" tile form.
 *
 * The overview room grid renders one fixed-size tile per room (name + tone
 * dot/label, big temperature with a trend arrow, shutter footer) in a simple
 * responsive `auto-fill` grid. These tests pin the tile markup so the layout
 * stays a plain, robust grid (no measured/auto-shrinking logic, which had
 * caused clipped names and — via a ResizeObserver ref loop — a white screen).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import { h } from 'preact';

import { RoomGrid } from '../../src/plugin/dashboard/spa/components/liquidglass2/shell/lg2Primitives.js';
import type { RoomDetail } from '../../src/plugin/dashboard/spa/types.js';

function rooms(n: number): RoomDetail[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `r${i}`,
    name: `Raum ${i}`,
    facade: 'S',
    shutterPercent: 50,
    indoorTempC: 23 + (i % 4),
    trend: i % 3 === 0 ? 'up' : 'flat',
    nextAction: null,
    status: 'idle',
    windowId: `w${i}`,
  })) as unknown as RoomDetail[];
}

describe('RoomGrid — 1.20 tile form', () => {
  afterEach(() => cleanup());

  it('renders one tile per room', () => {
    const { container } = render(<RoomGrid rooms={rooms(7)} onSelect={(): void => {}} />);
    expect(container.querySelector('[data-testid="lg2-rooms"]')).not.toBeNull();
    expect(container.querySelectorAll('.lg2-roomcard')).toHaveLength(7);
  });

  it('shows name, temperature and a shutter footer per tile', () => {
    const { container } = render(<RoomGrid rooms={rooms(1)} onSelect={(): void => {}} />);
    const card = container.querySelector('.lg2-roomcard')!;
    expect(card.querySelector('.lg2-roomcard__name')?.textContent).toBe('Raum 0');
    expect(card.querySelector('.lg2-roomcard__temp')?.textContent).toContain('°');
    expect(card.querySelector('.lg2-roomcard__meta')?.textContent).toContain('Rollladen');
    // Trend arrow present.
    expect(card.querySelector('.lg2-roomcard__trend')).not.toBeNull();
  });

  it('applies a tone modifier class for the left status bar', () => {
    const { container } = render(<RoomGrid rooms={rooms(4)} onSelect={(): void => {}} />);
    const toned = container.querySelectorAll(
      '.lg2-roomcard--ok, .lg2-roomcard--mid, .lg2-roomcard--hot, .lg2-roomcard--unknown',
    );
    expect(toned.length).toBe(4);
  });
});
