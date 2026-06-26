/**
 * Learning-loop hook used by the live tab and the recommendation
 * banner (Task 14.2).
 *
 * Wraps the dashboard server's `GET /api/learn/snapshot` plus the
 * `POST /api/learn/recommendations/:id/apply` and
 * `POST /api/learn/recommendations/:id/dismiss` round-trips.
 *
 *   - The snapshot is fetched on mount and re-fetched after a
 *     successful `apply` so the SPA reflects the new state without
 *     a manual refresh.
 *   - When the snapshot endpoint returns 503
 *     (`learning_unavailable`), the hook reports `learningAvailable
 *     = false` and stops emitting fetch errors so the live tab can
 *     hide the recommendation panel cleanly.
 *   - `dismiss` is SPA-local in v1: a dismissed id is stored in
 *     `dismissedIds` (a `Set` re-rendered as a signal) and the
 *     banner / panel filter against it. The hook still POSTs to
 *     the dismiss endpoint when wired so future server-side
 *     persistence can hook in transparently.
 */

import { signal, type Signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';

// ---------------------------------------------------------------------------
// Public types — duplicated from `engine/learn.ts` because the SPA
// bundle does not import engine modules.
// ---------------------------------------------------------------------------

export interface LearningRecommendation {
  id: string;
  roomId: string;
  severity: 'info' | 'warn';
  title: string;
  message: string;
  createdAt: string;
  suggestedConfigPatch?: {
    path: (string | number)[];
    from: unknown;
    to: unknown;
  };
}

export interface DailyShadeMetrics {
  date: string;
  roomId: string;
  preShadeRiseCph: number | null;
  postShadeRiseCph: number | null;
  effectiveShadeGain: number | null;
  firstShadeTimeIso: string | null;
  samplesPre: number;
  samplesPost: number;
}

export interface LearningSnapshot {
  metrics: DailyShadeMetrics[];
  recommendations: LearningRecommendation[];
  computedAt: string;
}

export interface UseLearningResult {
  snapshot: Signal<LearningSnapshot | null>;
  loading: Signal<boolean>;
  loadError: Signal<string | null>;
  learningAvailable: Signal<boolean>;
  dismissedIds: Signal<ReadonlySet<string>>;
  refresh: () => Promise<void>;
  apply: (id: string) => Promise<boolean>;
  dismiss: (id: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Module-level signals.
// ---------------------------------------------------------------------------

const snapshotSig = signal<LearningSnapshot | null>(null);
const loadingSig = signal<boolean>(false);
const loadErrorSig = signal<string | null>(null);
const learningAvailableSig = signal<boolean>(true);
const dismissedSig = signal<ReadonlySet<string>>(new Set());

let inFlightLoad: Promise<void> | null = null;

// ---------------------------------------------------------------------------
// Public functions.
// ---------------------------------------------------------------------------

export async function refreshLearningSnapshot(): Promise<void> {
  if (inFlightLoad !== null) {
    return inFlightLoad;
  }
  loadingSig.value = true;
  inFlightLoad = (async (): Promise<void> => {
    try {
      const res = await fetch('/api/learn/snapshot', {
        headers: { Accept: 'application/json' },
      });
      if (res.status === 503) {
        learningAvailableSig.value = false;
        snapshotSig.value = null;
        loadErrorSig.value = null;
        return;
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const json = (await res.json()) as LearningSnapshot;
      learningAvailableSig.value = true;
      snapshotSig.value = json;
      loadErrorSig.value = null;
    } catch (err) {
      loadErrorSig.value =
        err instanceof Error
          ? err.message
          : 'unknown error fetching /api/learn/snapshot';
    } finally {
      loadingSig.value = false;
      inFlightLoad = null;
    }
  })();
  return inFlightLoad;
}

export async function applyLearningRecommendation(
  id: string,
): Promise<boolean> {
  try {
    const res = await fetch(
      `/api/learn/recommendations/${encodeURIComponent(id)}/apply`,
      { method: 'POST' },
    );
    if (!res.ok) {
      return false;
    }
    // Refresh snapshot so the just-applied recommendation drops
    // off (or its `from` value updates).
    await refreshLearningSnapshot();
    return true;
  } catch {
    return false;
  }
}

export async function dismissLearningRecommendation(
  id: string,
): Promise<void> {
  // SPA-local dismiss first so the UI updates synchronously.
  const next = new Set(dismissedSig.value);
  next.add(id);
  dismissedSig.value = next;
  // Best-effort server round-trip; ignore failures (the
  // dismiss endpoint is 503 by default in v1).
  try {
    await fetch(
      `/api/learn/recommendations/${encodeURIComponent(id)}/dismiss`,
      { method: 'POST' },
    );
  } catch {
    // Ignore — the local dismiss has already taken effect.
  }
}

export function useLearning(): UseLearningResult {
  useEffect(() => {
    if (snapshotSig.value === null && learningAvailableSig.value) {
      void refreshLearningSnapshot();
    }
  }, []);
  return {
    snapshot: snapshotSig,
    loading: loadingSig,
    loadError: loadErrorSig,
    learningAvailable: learningAvailableSig,
    dismissedIds: dismissedSig,
    refresh: refreshLearningSnapshot,
    apply: applyLearningRecommendation,
    dismiss: dismissLearningRecommendation,
  };
}

/** Test-only helper: reset the module-level signals between cases. */
export function __resetLearningStateForTests(): void {
  snapshotSig.value = null;
  loadingSig.value = false;
  loadErrorSig.value = null;
  learningAvailableSig.value = true;
  dismissedSig.value = new Set();
  inFlightLoad = null;
}
