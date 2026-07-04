/**
 * SSE hook: subscribes to `GET /api/stream` and routes events into
 * the signals store.
 *
 * Recognised event types:
 *   - `state.snapshot`    → replace the entire snapshot.
 *   - `cycle.completed`   → update snapshot + per-window risk
 *                           breakdowns when the orchestrator
 *                           publishes them.
 *   - `building.revision` → record the latest committed building
 *                           revision so the Studio can offer a
 *                           non-destructive reload.
 *   - any other event     → ignored at the SPA layer, future
 *                           features can branch on the string.
 *
 * Connection state is mirrored into `connectionState` so the mode
 * header pill can show "live" / "reconnecting" / "offline" without
 * each component re-implementing it.
 */

import { useEffect } from 'preact/hooks';

import { connectionState, lastError, latestBuildingRevision, setRiskBreakdowns, snapshot } from '../store.js';
import { refreshMessages } from './useMessages.js';
import type {
  DashboardSnapshot,
  DashboardStreamEvent,
  WindowRiskBreakdown,
} from '../types.js';

interface CycleCompletedPayload {
  snapshot?: DashboardSnapshot;
  windowRisk?: WindowRiskBreakdown[];
}

export function useStream(): void {
  useEffect(() => {
    if (typeof EventSource === 'undefined') {
      // jsdom in unit tests does not provide EventSource. The polling
      // hook covers the data path; we just leave connectionState in
      // its initial 'connecting' state so the mode header still
      // renders.
      return undefined;
    }
    let source: EventSource | null = null;
    let cancelled = false;

    const open = (): void => {
      if (cancelled) {
        return;
      }
      connectionState.value = 'connecting';
      source = new EventSource('/api/stream');

      source.onopen = (): void => {
        if (cancelled) {
          return;
        }
        connectionState.value = 'open';
        lastError.value = null;
      };

      source.onerror = (): void => {
        if (cancelled) {
          return;
        }
        connectionState.value = 'reconnecting';
      };

      source.onmessage = (ev: MessageEvent): void => {
        try {
          const event = JSON.parse(ev.data) as DashboardStreamEvent;
          handleEvent(event);
        } catch (err) {
          lastError.value =
            err instanceof Error ? err.message : 'invalid SSE payload';
        }
      };
    };

    open();

    return (): void => {
      cancelled = true;
      connectionState.value = 'closed';
      if (source !== null) {
        source.close();
      }
    };
  }, []);
}

function handleEvent(event: DashboardStreamEvent): void {
  if (event.type === 'state.snapshot' && isDashboardSnapshot(event.payload)) {
    snapshot.value = event.payload;
    return;
  }
  if (event.type === 'cycle.completed') {
    const payload = event.payload as CycleCompletedPayload;
    if (payload.snapshot && isDashboardSnapshot(payload.snapshot)) {
      snapshot.value = payload.snapshot;
    }
    if (Array.isArray(payload.windowRisk)) {
      setRiskBreakdowns(payload.windowRisk);
    }
    return;
  }
  if (event.type === 'message.created') {
    // A new in-app notification was emitted — refresh the bell + list.
    void refreshMessages();
    return;
  }
  if (event.type === 'building.revision') {
    // The building model was committed elsewhere (another session or a
    // history restore). Record the latest revision so the Studio can offer a
    // non-destructive reload without clobbering local edits.
    const rev = (event.payload as { revision?: unknown }).revision;
    if (typeof rev === 'number' && Number.isFinite(rev)) {
      latestBuildingRevision.value = rev;
    }
  }
}

function isDashboardSnapshot(value: unknown): value is DashboardSnapshot {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const v = value as { ts?: unknown; mode?: unknown; windows?: unknown };
  return typeof v.ts === 'string' && Array.isArray(v.windows);
}
