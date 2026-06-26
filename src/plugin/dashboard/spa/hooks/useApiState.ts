/**
 * Polling hook: fetches `GET /api/state` on mount and every 30 s.
 *
 * Acts as the polling fallback for the SSE stream so the dashboard
 * is never more than 30 s stale even when the EventSource is
 * disconnected. The hook owns no UI state of its own — it writes
 * straight into the shared `@preact/signals` store.
 */

import { useEffect } from 'preact/hooks';

import { lastError, snapshot } from '../store.js';
import type { DashboardSnapshot } from '../types.js';

const POLL_INTERVAL_MS = 30_000;

export function useApiState(): void {
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async (): Promise<void> => {
      try {
        const res = await fetch('/api/state', { headers: { Accept: 'application/json' } });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const json = (await res.json()) as DashboardSnapshot;
        if (!cancelled) {
          snapshot.value = json;
          lastError.value = null;
        }
      } catch (err) {
        if (!cancelled) {
          lastError.value =
            err instanceof Error ? err.message : 'unknown error fetching /api/state';
        }
      } finally {
        if (!cancelled) {
          timer = setTimeout(() => {
            void tick();
          }, POLL_INTERVAL_MS);
        }
      }
    };

    void tick();

    return (): void => {
      cancelled = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
    };
  }, []);
}
