/**
 * Heat Shield — Übersicht view (uebersicht-rework, Task 12).
 *
 * The from-scratch overview: a DECISION surface, not a metric dump. Composes
 * the new blocks in the design's hierarchy and owns only the local scrub state
 * (which never triggers a control call). Deep analysis, raw metrics and manual
 * control live on the specialist tabs; expert mode reveals the manual controls
 * + learning management here without losing any function.
 *
 *   StatusBanner → (Recommendations) → ViewModeToggle → Lagekarte
 *   → [NextActionStrip | HouseTwinCompact] → KpiRow → OutlookStrip
 *   → RoomStatusGrid → OverviewDeepLinks → (expert: controls + learning)
 *
 * States: loading skeleton (snapshot null) · onboarding (no rooms) · full.
 */

import { h, Fragment, type JSX } from 'preact';
import { useState } from 'preact/hooks';

import { t } from '../../i18n.js';
import { snapshot } from '../../store.js';
import { expertMode } from '../../expertMode.js';
import { useConfig } from '../../hooks/useConfig.js';
import { useLearning } from '../../hooks/useLearning.js';
import { ControlPanel } from '../controlPanel.js';
import { RecommendationBanner } from '../recommendationBanner.js';
import { RecommendationPanel } from '../recommendationPanel.js';
import { StatusBanner } from './statusBanner.js';
import { Lagekarte } from './lagekarte.js';
import { NextActionStrip } from './nextActionStrip.js';
import { HouseTwinCompact } from './houseTwinCompact.js';
import { KpiRow } from './kpiRow.js';
import { OutlookStrip } from './outlookStrip.js';
import { RoomStatusGrid } from './roomStatusGrid.js';
import { OverviewDeepLinks } from './deepLinks.js';
import { ViewModeToggle } from './viewModeToggle.js';
import { OverviewOnboarding } from './overviewOnboarding.js';

interface RoutableProps {
  path?: string;
  default?: boolean;
}

/** Loading skeleton shown until the first snapshot arrives. */
function OverviewSkeleton(): JSX.Element {
  return (
    <div class="hs-skeleton" data-testid="overview-skeleton" aria-hidden="true">
      <div class="hs-skeleton__bar skeleton" />
      <div class="hs-skeleton__hero skeleton" />
      <div class="hs-skeleton__cols">
        <div class="hs-skeleton__block skeleton" />
        <div class="hs-skeleton__block skeleton" />
      </div>
      <div class="hs-skeleton__row skeleton" />
      <p class="hs-skeleton__status" role="status">
        {t('warte auf Daten …', 'waiting for data …')}
      </p>
    </div>
  );
}

export function UebersichtView(_props: RoutableProps): JSX.Element {
  const { config } = useConfig();
  const loc = config.value?.location;
  const latitude = loc?.latitude ?? 52.52;
  const longitude = loc?.longitude ?? 13.41;

  const learning = useLearning();
  const dismissedIds = learning.dismissedIds.value;
  const recs = learning.snapshot.value?.recommendations ?? [];
  const visibleRecs = recs.filter((r) => !dismissedIds.has(r.id));

  const [scrubAt, setScrubAt] = useState<Date | null>(null);

  const snap = snapshot.value;
  const expert = expertMode.value;

  if (snap === null) {
    return (
      <section class="hs-overview" data-testid="uebersicht-view">
        <OverviewSkeleton />
      </section>
    );
  }

  const hasRooms = (snap.roomsDetail ?? []).length > 0;

  return (
    <section class="hs-overview" data-testid="uebersicht-view">
      <StatusBanner snapshot={snap} />
      <RecommendationBanner recommendations={visibleRecs} />

      {!hasRooms ? (
        <OverviewOnboarding />
      ) : (
        <Fragment>
          <div class="hs-overview__toolbar">
            <ViewModeToggle />
          </div>

          <Lagekarte snapshot={snap} />

          <div class="hs-overview__split">
            <NextActionStrip snapshot={snap} />
            <HouseTwinCompact
              snapshot={snap}
              latitude={latitude}
              longitude={longitude}
              scrubAt={scrubAt}
              onScrub={(tSim): void => setScrubAt(tSim)}
            />
          </div>

          <KpiRow snapshot={snap} />
          <OutlookStrip snapshot={snap} />
          <RoomStatusGrid snapshot={snap} />
          <OverviewDeepLinks showWarnings={snap.weatherAlert?.active === true} />

          {expert && (
            <div class="hs-overview__expert" data-testid="overview-expert">
              <ControlPanel windows={snap.windows ?? []} />
              <RecommendationPanel
                recommendations={recs}
                dismissedIds={dismissedIds}
                onApply={learning.apply}
                onDismiss={learning.dismiss}
              />
            </div>
          )}
        </Fragment>
      )}
    </section>
  );
}
