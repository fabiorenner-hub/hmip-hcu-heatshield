/**
 * Live tab (composes Tasks 11.2 / 11.3 / 11.4 / 14.2).
 *
 * Lays out the mode header, the per-window cards, the sun
 * polar plot, and the learning recommendation panel + banner.
 * Reads everything from the signals store so the tab stays a
 * thin shell.
 */

import { h, type JSX } from 'preact';

import { ModeHeader } from '../components/modeHeader.js';
import { OverviewPanel } from '../components/overviewPanel.js';
import { ControlPanel } from '../components/controlPanel.js';
import { RecommendationBanner } from '../components/recommendationBanner.js';
import { RecommendationPanel } from '../components/recommendationPanel.js';
import { SunPolarPlot, type SunMarker } from '../components/sunPolarPlot.js';
import { WindowCard } from '../components/windowCard.js';
import { WindowSunCard } from '../components/windowSunCard.js';
import { windowDisplayName } from '../format.js';
import { useConfig } from '../hooks/useConfig.js';
import { useLearning } from '../hooks/useLearning.js';
import { connectionState, riskBreakdowns, snapshot } from '../store.js';
import { t } from '../i18n.js';

const WINDOW_PALETTE = [
  '#ef5350',
  '#42a5f5',
  '#66bb6a',
  '#ab47bc',
  '#ffa726',
  '#26a69a',
];

// Beispielstadt defaults — used as the polar-plot fallback when the
// `/api/config` round-trip has not landed yet. The Live tab pulls
// the real lat/lon from props once the parent wires it through.
const DEFAULT_LAT = 52.52;
const DEFAULT_LON = 13.41;

export interface LiveTabProps {
  /** Latitude pulled from `/api/config`. Falls back to Beispielstadt. */
  latitude?: number;
  /** Longitude pulled from `/api/config`. Falls back to Beispielstadt. */
  longitude?: number;
}

export function LiveTab(props: LiveTabProps = {}): JSX.Element {
  const snap = snapshot.value;
  const conn = connectionState.value;
  const breakdowns = riskBreakdowns.value;
  const cfg = useConfig();
  const config = cfg.config.value;
  const learning = useLearning();
  const learnSnap = learning.snapshot.value;
  const dismissedIds = learning.dismissedIds.value;
  const recs = learnSnap?.recommendations ?? [];
  const visibleRecs = recs.filter((r) => !dismissedIds.has(r.id));

  const stormHoldActive =
    snap?.storm.holdUntil !== null && snap?.storm.holdUntil !== undefined;
  const stormSubtitleProp = stormHoldActive
    ? { stormSubtitle: t('Sturmschutz aktiv', 'Storm protection active') }
    : {};

  const lat = config?.location.latitude ?? props.latitude ?? DEFAULT_LAT;
  const lon = config?.location.longitude ?? props.longitude ?? DEFAULT_LON;
  const sunRules = config?.rules.sun;

  // Build polar-plot markers from the priority windows. Each
  // window gets a stable colour from the palette so the legend
  // does not jump on re-render.
  const markers: SunMarker[] = (snap?.windows ?? []).slice(0, WINDOW_PALETTE.length).map(
    (w, i) => ({
      windowId: w.id,
      at: new Date(),
      color: WINDOW_PALETTE[i] ?? '#999',
      label: windowDisplayName(w),
    }),
  );

  return (
    <section class="tab-live" data-testid="tab-live">
      <RecommendationBanner recommendations={visibleRecs} />
      <ModeHeader
        mode={snap?.mode ?? null}
        connection={conn}
        nextCycleInSeconds={null}
        {...stormSubtitleProp}
      />

      <OverviewPanel />

      <ControlPanel windows={snap?.windows ?? []} />

      <div class="tab-live__grid">
        <div class="tab-live__windows">
          {(snap?.windows ?? []).map((w) => (
            <WindowCard
              key={w.id}
              window={w}
              risk={breakdowns[w.id] ?? null}
            />
          ))}
          {(snap?.windows ?? []).length === 0 && (
            <p class="tab-live__empty">{t('Noch keine Fenster konfiguriert.', 'No windows configured yet.')}</p>
          )}
        </div>

        <aside class="tab-live__sun">
          <h3>{t('Sonnenstand', 'Sun position')}</h3>
          <SunPolarPlot
            latitude={lat}
            longitude={lon}
            markers={markers}
          />
        </aside>
      </div>

      {config !== null && sunRules !== undefined && config.windows.length > 0 && (
        <section class="tab-live__window-sun" data-testid="live-window-sun">
          <h3>{t('Fenster & Sonne', 'Windows & Sun')}</h3>
          <div class="window-sun-grid">
            {config.windows.map((w) => (
              <WindowSunCard
                key={w.id}
                window={w}
                latitude={lat}
                longitude={lon}
                minElevationDeg={sunRules.minElevationDeg}
                maxIncidenceAngleFacadeDeg={sunRules.maxIncidenceAngleFacadeDeg}
                maxIncidenceAngleRoofDeg={sunRules.maxIncidenceAngleRoofDeg}
              />
            ))}
          </div>
        </section>
      )}

      <RecommendationPanel
        recommendations={recs}
        dismissedIds={dismissedIds}
        onApply={learning.apply}
        onDismiss={learning.dismiss}
      />
    </section>
  );
}
