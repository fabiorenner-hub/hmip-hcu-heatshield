/**
 * Heat Shield — precipitation outlook strip (Wetter tab).
 *
 * The rain radar (RainViewer) only nowcasts ~30 min. This strip complements it
 * with a valid +2 h precipitation-intensity outlook at the location, from
 * Open-Meteo `minutely_15` (15-minute steps), surfaced in the snapshot as
 * `precipNowcast`. Pure presentational; reads the shared snapshot signal.
 */

import { h, type JSX } from 'preact';

import { snapshot } from '../../store.js';
import { t, fmtTime } from '../../i18n.js';

/** mm/15min → a 0..1 intensity for the bar height (≈ light…heavy rain). */
function intensity01(precipMm: number): number {
  // 2.5 mm in 15 min ≈ heavy rain; clamp to 1.
  return Math.max(0, Math.min(1, precipMm / 2.5));
}

export function PrecipOutlook(): JSX.Element | null {
  const points = snapshot.value?.precipNowcast ?? [];
  if (points.length === 0) {
    return null;
  }
  const totalMm = Math.round(points.reduce((s, p) => s + p.precipMm, 0) * 10) / 10;
  const anyRain = points.some((p) => p.precipMm > 0.05);
  const maxMm = Math.max(...points.map((p) => p.precipMm), 0);

  return (
    <section class="precip-outlook" data-testid="precip-outlook">
      <header class="precip-outlook__head">
        <h3>{t('Niederschlag · nächste 2 h', 'Precipitation · next 2 h')}</h3>
        <span class="precip-outlook__sum" data-testid="precip-outlook-sum">
          {anyRain
            ? t(`Σ ${totalMm} mm`, `Σ ${totalMm} mm`)
            : t('kein Regen erwartet', 'no rain expected')}
        </span>
      </header>
      <div class="precip-outlook__bars" data-testid="precip-outlook-bars">
        {points.map((p) => {
          const h01 = intensity01(p.precipMm);
          return (
            <span
              key={p.ts}
              class={`precip-outlook__bar${p.precipMm > 0.05 ? ' precip-outlook__bar--wet' : ''}`}
              style={{ height: `${Math.max(3, Math.round(h01 * 100))}%` }}
              title={`${fmtTime(p.ts)}: ${Math.round(p.precipMm * 10) / 10} mm`}
            />
          );
        })}
      </div>
      <div class="precip-outlook__axis" aria-hidden="true">
        <span>{t('jetzt', 'now')}</span>
        <span>+1 h</span>
        <span>+2 h</span>
      </div>
      <p class="module-panel__hint precip-outlook__hint">
        {t(
          `Quelle: Open-Meteo (15-Minuten-Schritte). Spitze ${Math.round(maxMm * 10) / 10} mm/15 min.`,
          `Source: Open-Meteo (15-minute steps). Peak ${Math.round(maxMm * 10) / 10} mm/15 min.`,
        )}
      </p>
    </section>
  );
}
