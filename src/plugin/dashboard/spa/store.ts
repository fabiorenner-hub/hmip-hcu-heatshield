/**
 * SPA state store powered by `@preact/signals`.
 *
 * The store holds the latest {@link DashboardSnapshot} plus a tiny
 * connection-status field. Components subscribe by reading any of
 * the exported signals; updates from `useApiState` (polling) and
 * `useStream` (SSE) write into the same signals so the rendering
 * code does not need to know which transport produced the value.
 *
 * Why signals and not Context?
 *   - The dashboard is a small SPA with one global, fast-changing
 *     payload. Threading it through Context would force every leaf
 *     component to re-render on each tick.
 *   - `@preact/signals` lets us scope re-renders to the component
 *     that actually reads `snapshot.value`.
 */

import { signal } from '@preact/signals';

import type {
  DashboardSnapshot,
  Message,
  WindowRiskBreakdown,
} from './types.js';

export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed';

/**
 * Latest snapshot from the dashboard server, or `null` while the
 * very first request is in flight.
 */
export const snapshot = signal<DashboardSnapshot | null>(null);

/**
 * Last error from either transport. Components display this in a
 * top banner; the polling hook clears it on the next successful
 * fetch.
 */
export const lastError = signal<string | null>(null);

/**
 * SSE connection state. The connection-state pill in the mode
 * header reads this directly.
 */
export const connectionState = signal<ConnectionState>('connecting');

/**
 * Optional risk breakdown per window. The dashboard backend exposes
 * this through the SSE stream as a `cycle.completed` event; absent
 * data falls back to a flat bar so the SPA still renders.
 */
export const riskBreakdowns = signal<Record<string, WindowRiskBreakdown>>({});

/**
 * Replace the entire risk breakdown map. Used when a fresh
 * `cycle.completed` event arrives.
 */
export function setRiskBreakdowns(rows: WindowRiskBreakdown[]): void {
  const next: Record<string, WindowRiskBreakdown> = {};
  for (const row of rows) {
    next[row.windowId] = row;
  }
  riskBreakdowns.value = next;
}

/**
 * In-app notifications (Messages tab + envelope badge). Populated by
 * `useMessages`; the bell badge reads `unreadMessages` for the count and the
 * Messages tab reads `messages` for the list.
 */
export const messages = signal<Message[]>([]);
export const unreadMessages = signal<number>(0);
