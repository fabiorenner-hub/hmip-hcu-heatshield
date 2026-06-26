// @vitest-environment jsdom
/**
 * Unit tests for the message bell badge, the Messages tab, and the
 * feels-like / trend tiles in the overview (smart-shading Task 10.2/10.3/10.4).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, fireEvent, waitFor } from '@testing-library/preact';
import { h } from 'preact';

import { MessageBell } from '../../src/plugin/dashboard/spa/components/messageBell.js';
import { OverviewPanel } from '../../src/plugin/dashboard/spa/components/overviewPanel.js';
import { MessagesTab } from '../../src/plugin/dashboard/spa/tabs/messages.js';
import {
  __resetMessagesStateForTests,
} from '../../src/plugin/dashboard/spa/hooks/useMessages.js';
import { snapshot } from '../../src/plugin/dashboard/spa/store.js';
import type { DashboardSnapshot, Message } from '../../src/plugin/dashboard/spa/types.js';

function baseSnapshot(): DashboardSnapshot {
  return {
    ts: '2026-06-21T10:00:00.000Z',
    mode: 'NORMAL',
    rooms: [],
    windows: [],
    sources: {
      fusionSolar: { sourceOk: true, lastSuccess: null, consecutiveFailures: 0 },
      hcu: { connected: true },
    },
    userIntent: { paused: false, pauseUntil: null, vacation: false },
    storm: { holdUntil: null },
    pluginReadiness: 'READY',
    automationEnabled: true,
  };
}

afterEach(() => {
  cleanup();
  __resetMessagesStateForTests();
  snapshot.value = null;
  vi.restoreAllMocks();
});

describe('MessageBell', () => {
  it('hides the badge when there are no unread messages', () => {
    const { queryByTestId } = render(
      <MessageBell unread={0} onActivate={(): void => {}} />,
    );
    expect(queryByTestId('message-bell-badge')).toBeNull();
  });

  it('shows the unread count in the badge', () => {
    const { getByTestId } = render(
      <MessageBell unread={3} onActivate={(): void => {}} />,
    );
    expect(getByTestId('message-bell-badge').textContent).toBe('3');
  });

  it('caps the badge at 99+', () => {
    const { getByTestId } = render(
      <MessageBell unread={150} onActivate={(): void => {}} />,
    );
    expect(getByTestId('message-bell-badge').textContent).toBe('99+');
  });

  it('calls onActivate when clicked', () => {
    const onActivate = vi.fn();
    const { getByTestId } = render(
      <MessageBell unread={1} onActivate={onActivate} />,
    );
    fireEvent.click(getByTestId('message-bell'));
    expect(onActivate).toHaveBeenCalledTimes(1);
  });
});

describe('MessagesTab', () => {
  function mockFetchWith(messages: Message[]): void {
    const unread = messages.filter((m) => !m.read).length;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { method?: string }) => {
        if (url === '/api/messages' && (init?.method ?? 'GET') === 'GET') {
          return {
            ok: true,
            status: 200,
            json: async () => ({ messages, unread }),
          } as unknown as Response;
        }
        if (url === '/api/messages/read') {
          return {
            ok: true,
            status: 200,
            json: async () => ({ ok: true, unread: 0 }),
          } as unknown as Response;
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
  }

  it('renders messages newest-first and marks them read on open', async () => {
    mockFetchWith([
      {
        id: 'a',
        ts: '2026-06-22T08:00:00.000Z',
        kind: 'close',
        title: 'Hitzeschutz aktiv',
        body: 'Rollladen fährt herunter.',
        read: false,
      },
      {
        id: 'b',
        ts: '2026-06-22T09:00:00.000Z',
        kind: 'ventilate',
        title: 'Lüften empfohlen',
        body: 'Jetzt lüften.',
        read: false,
      },
    ]);

    const { findAllByTestId, getByTestId } = render(<MessagesTab />);

    const items = await findAllByTestId('message-item');
    expect(items).toHaveLength(2);
    // Newest first: 'b' (09:00) before 'a' (08:00).
    expect(items[0]!.textContent).toContain('Lüften empfohlen');
    expect(items[1]!.textContent).toContain('Hitzeschutz aktiv');

    // markRead() POST happened → unread count reconciles to 0.
    await waitFor(() => {
      expect(getByTestId('messages-unread-count').textContent).toBe('Alle gelesen');
    });
  });

  it('shows an empty state when there are no messages', async () => {
    mockFetchWith([]);
    const { findByTestId } = render(<MessagesTab />);
    expect(await findByTestId('messages-empty')).toBeTruthy();
  });
});

describe('OverviewPanel — feels-like + trends', () => {
  it('renders the feels-like tile and trend arrows from the snapshot', () => {
    snapshot.value = {
      ...baseSnapshot(),
      signals: {
        outdoorTemp: { value: 25, ts: null, state: 'fresh' },
        pvPower: { value: 5, ts: null, state: 'fresh' },
        windSpeed: { value: 1, ts: null, state: 'fresh' },
        radiation: { value: 600, ts: null, state: 'fresh' },
        forecastMaxTemp: { value: 30, ts: null, state: 'fresh' },
        forecastCloudCover: { value: 20, ts: null, state: 'fresh' },
      },
      feelsLike: { effectiveLoad01: 0.6, feelsLikeC: 28.4 },
      trends: { outdoorCph: 1.5, pvKwph: -0.5 },
    };

    const { getByTestId } = render(<OverviewPanel />);
    expect(getByTestId('overview-feelslike-value').textContent).toContain('28.4');
    expect(getByTestId('overview-feelslike-value').textContent).toContain('60 %');
    // Rising outdoor temp → up arrow; falling PV → down arrow.
    expect(getByTestId('overview-tile-outdoor-trend').textContent).toContain('↑');
    expect(getByTestId('overview-tile-pv-trend').textContent).toContain('↓');
  });

  it('omits feels-like gracefully when absent', () => {
    snapshot.value = baseSnapshot();
    const { getByTestId } = render(<OverviewPanel />);
    expect(getByTestId('overview-tile-feelslike').textContent).toContain('–');
  });
});
