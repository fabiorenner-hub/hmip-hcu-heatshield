// @vitest-environment jsdom
/**
 * Tests for the manual control panel (scenes + per-window slider).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, fireEvent, waitFor } from '@testing-library/preact';
import { h } from 'preact';

import { ControlPanel } from '../../src/plugin/dashboard/spa/components/controlPanel.js';
import type { DashboardSnapshotWindow } from '../../src/plugin/dashboard/spa/types.js';

function win(id: string, level01 = 0): DashboardSnapshotWindow {
  return { id, currentLevel01: level01, manualOverrideUntil: null, lastDecisionMode: null };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ControlPanel', () => {
  it('applies a scene to every window (POST per window)', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { body?: string }) => {
        calls.push({ url, body: JSON.parse(init?.body ?? '{}') });
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response;
      }),
    );

    const { getByTestId } = render(
      <ControlPanel windows={[win('a'), win('b')]} />,
    );
    fireEvent.click(getByTestId('scene-close'));

    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[0]!.url).toContain('/api/control/shutter/a');
    expect(calls[1]!.url).toContain('/api/control/shutter/b');
    expect((calls[0]!.body as { level01: number }).level01).toBe(1);
  });

  it('drives a single window from its slider', async () => {
    const calls: Array<{ url: string; body: { level01: number } }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { body?: string }) => {
        calls.push({ url, body: JSON.parse(init?.body ?? '{}') });
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response;
      }),
    );

    const { getByTestId } = render(<ControlPanel windows={[win('a')]} />);
    fireEvent.input(getByTestId('control-slider-a'), { target: { value: '70' } });
    fireEvent.click(getByTestId('control-apply-a'));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.url).toContain('/api/control/shutter/a');
    expect(calls[0]!.body.level01).toBeCloseTo(0.7, 6);
  });

  it('shows an empty state with no windows', () => {
    const { container } = render(<ControlPanel windows={[]} />);
    expect(container.textContent).toContain('Keine Fenster konfiguriert');
  });
});
