/**
 * Heat Shield — recommendation banner (Task 14.2 part 3).
 *
 * Renders above the Live tab whenever the learning snapshot exposes
 * at least one `'warn'`-severity recommendation. Stays out of the
 * way (no patch buttons, no extra interactivity) so the live view
 * keeps its focus on the per-window cards. The detailed
 * "Vorschläge" panel inside the Live tab is the one that actually
 * runs the apply round-trip.
 */

import { h, type JSX } from 'preact';

import { t, tServer } from '../i18n.js';
import type { LearningRecommendation } from '../hooks/useLearning.js';

export interface RecommendationBannerProps {
  recommendations: LearningRecommendation[];
}

export function RecommendationBanner(
  props: RecommendationBannerProps,
): JSX.Element | null {
  const warnRecs = props.recommendations.filter(
    (r) => r.severity === 'warn',
  );
  if (warnRecs.length === 0) {
    return null;
  }
  return (
    <div
      class="recommendation-banner"
      role="status"
      data-testid="recommendation-banner"
    >
      <span class="recommendation-banner__icon" aria-hidden="true">
        💡
      </span>
      <div class="recommendation-banner__body">
        <strong>{tServer(warnRecs[0]?.title) || t('Empfehlung', 'Recommendation')}</strong>
        <span> — </span>
        <span>{tServer(warnRecs[0]?.message)}</span>
        {warnRecs.length > 1 && (
          <span class="recommendation-banner__more">
            {' '}
            (+{warnRecs.length - 1} {t('weitere', 'more')})
          </span>
        )}
      </div>
    </div>
  );
}
