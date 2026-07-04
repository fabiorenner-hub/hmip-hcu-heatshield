/**
 * Heat Shield — Übersicht OutlookStrip (uebersicht-rework, Task 8).
 *
 * Compact ~12 h forecast: hourly cards (time · weather · temp · radiation ·
 * cloud/rain) with the temperature peak marked. Horizontal scroll-snap on
 * narrow screens. "Full forecast" deep-links to /vorhersage. Pure.
 */

import { h, type JSX } from 'preact';
import { route } from 'preact-router';

import { t, fmtTime } from '../../i18n.js';
import { formatSignal } from '../../format.js';
import type { DashboardSnapshot } from '../../types.js';
import { outlookCards, outlookPeakIndex } from './uebersichtModel.js';

const OUTLOOK_HOURS = 12;

export function OutlookStrip(props: { snapshot: DashboardSnapshot; hours?: number }): JSX.Element {
  const cards = outlookCards(props.snapshot, props.hours ?? OUTLOOK_HOURS);
  const peakIndex = outlookPeakIndex(cards);

  return (
    <section class="hs-outlook" data-testid="outlook-strip">
      <header class="hs-outlook__head">
        <h2 class="hs-outlook__title">{t('Ausblick · 12 h', 'Outlook · 12 h')}</h2>
        <button
          type="button"
          class="hs-outlook__link"
          data-testid="outlook-expand"
          onClick={(): void => {
            route('/vorhersage');
          }}
        >
          {t('Volle Vorhersage', 'Full forecast')}
        </button>
      </header>

      {cards.length === 0 ? (
        <p class="hs-outlook__empty" data-testid="outlook-empty">
          {t('Noch keine Vorhersage.', 'No forecast yet.')}
        </p>
      ) : (
        <ol class="hs-outlook__cards" data-testid="outlook-cards">
          {cards.map((c, i) => (
            <li
              key={c.ts}
              class={`hs-outlook__card${i === peakIndex ? ' hs-outlook__card--peak' : ''}`}
              data-testid={i === peakIndex ? 'outlook-card-peak' : 'outlook-card'}
            >
              <span class="hs-outlook__time">{fmtTime(c.ts)}</span>
              <span class="hs-outlook__icon" aria-hidden="true">
                {c.weatherIcon}
              </span>
              <span class="hs-outlook__temp">{formatSignal(c.tempC, '°C', 0)}</span>
              <span class="hs-outlook__sub">{formatSignal(c.radiationWm2, 'W', 0)}</span>
              {i === peakIndex && <span class="hs-outlook__peak-tag">{t('Peak', 'Peak')}</span>}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
