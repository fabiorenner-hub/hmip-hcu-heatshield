/**
 * Heat Shield — recommendation panel inside the Live tab (Task 14.2).
 *
 * Lists each non-dismissed recommendation as a card with title,
 * message, and (when a `suggestedConfigPatch` is attached) an
 * "Anwenden" button. Clicking the button calls
 * `POST /api/learn/recommendations/:id/apply` via
 * `useLearning().apply` and triggers a snapshot refresh.
 *
 * The "Verwerfen" button is SPA-local in v1: the server-side
 * dismiss endpoint returns 503 by default, the hook still POSTs
 * (best-effort) but always updates the local dismissed-set so the
 * card disappears immediately.
 */

import { h, type JSX } from 'preact';
import { useState } from 'preact/hooks';

import type { LearningRecommendation } from '../hooks/useLearning.js';

export interface RecommendationPanelProps {
  recommendations: LearningRecommendation[];
  dismissedIds: ReadonlySet<string>;
  onApply: (id: string) => Promise<boolean>;
  onDismiss: (id: string) => Promise<void>;
}

export function RecommendationPanel(
  props: RecommendationPanelProps,
): JSX.Element | null {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [errorId, setErrorId] = useState<string | null>(null);

  const visible = props.recommendations.filter(
    (r) => !props.dismissedIds.has(r.id),
  );
  if (visible.length === 0) {
    return null;
  }
  return (
    <section
      class="recommendation-panel"
      data-testid="recommendation-panel"
      aria-label="Lern-Vorschläge"
    >
      <h3>Vorschläge</h3>
      <ul class="recommendation-panel__list">
        {visible.map((r) => {
          const patch = r.suggestedConfigPatch;
          const pending = pendingId === r.id;
          const failed = errorId === r.id;
          return (
            <li
              key={r.id}
              class={`recommendation-panel__item recommendation-panel__item--${r.severity}`}
              data-testid={`recommendation-${r.id}`}
              data-severity={r.severity}
            >
              <div class="recommendation-panel__title">
                <strong>{r.title}</strong>
                <span class="recommendation-panel__room"> · {r.roomId}</span>
              </div>
              <p class="recommendation-panel__message">{r.message}</p>
              {patch !== undefined && (
                <p class="recommendation-panel__patch" data-testid="patch-summary">
                  <code>{patch.path.join('.')}</code>:{' '}
                  <span data-testid="patch-from">{String(patch.from)}</span>{' '}
                  →{' '}
                  <span data-testid="patch-to">{String(patch.to)}</span>
                </p>
              )}
              {failed && (
                <p class="recommendation-panel__error" role="alert">
                  Anwenden fehlgeschlagen — bitte erneut versuchen.
                </p>
              )}
              <div class="recommendation-panel__actions">
                {patch !== undefined && (
                  <button
                    type="button"
                    data-testid={`apply-${r.id}`}
                    disabled={pending}
                    onClick={async (): Promise<void> => {
                      setPendingId(r.id);
                      setErrorId(null);
                      const ok = await props.onApply(r.id);
                      setPendingId(null);
                      if (!ok) {
                        setErrorId(r.id);
                      }
                    }}
                  >
                    {pending ? 'Wird angewendet …' : 'Anwenden'}
                  </button>
                )}
                <button
                  type="button"
                  data-testid={`dismiss-${r.id}`}
                  disabled={pending}
                  onClick={async (): Promise<void> => {
                    await props.onDismiss(r.id);
                  }}
                >
                  Verwerfen
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
