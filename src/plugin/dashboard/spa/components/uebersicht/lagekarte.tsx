/**
 * Heat Shield — Übersicht Lagekarte / hero (uebersicht-rework, Task 5).
 *
 * The top decision card: active mode, the deciding factor (`decidedBy`),
 * reason chips, the one benefit number (avoided warming) with a confidence
 * badge, and a compact meta row. A decorative, mode-tinted glow sits behind
 * the text (aria-hidden) so the illustration never lowers text contrast.
 * Expert mode reveals extra live-signal chips.
 */

import { h, Fragment, type JSX } from 'preact';

import { t, tServer } from '../../i18n.js';
import { fmtNum } from '../../i18n.js';
import { formatSignal, formatWindKmh } from '../../format.js';
import type { DashboardSnapshot } from '../../types.js';
import { expertMode } from '../../expertMode.js';
import { ConfidenceBadge, FreshnessDot } from './primitives.js';
import {
  avoidedWarmingC,
  dataAgeMinutes,
  expectedPeakC,
  forecastAccuracyC,
  primaryHeadline,
} from './uebersichtModel.js';

function num1(v: number | null): string {
  return v === null || !Number.isFinite(v) ? '–' : fmtNum(Math.round(v * 10) / 10, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function ageText(snap: DashboardSnapshot): string {
  const age = dataAgeMinutes(snap.ts);
  if (age === null) return '–';
  if (age < 1) return t('aktuell', 'live');
  return t(`vor ${age} min`, `${age} min ago`);
}

export function Lagekarte(props: { snapshot: DashboardSnapshot }): JSX.Element {
  const snap = props.snapshot;
  const head = primaryHeadline(snap);
  const modeId = snap.mode ?? 'NORMAL';
  const modeLabel = snap.modeInfo?.label !== undefined ? tServer(snap.modeInfo.label) : modeId;
  const decidedBy = snap.modeInfo?.decidedBy;
  const reasons = (snap.modeInfo?.reasons ?? []).slice(0, 3);
  const avoided = avoidedWarmingC(snap);
  const peak = expectedPeakC(snap);
  const accuracy = forecastAccuracyC(snap);
  const expert = expertMode.value;

  return (
    <section
      class={`hs-hero hs-hero--${head.tone}`}
      data-testid="lagekarte"
      data-tone={head.tone}
      data-mode={modeId}
    >
      <div class={`hs-hero__glow hs-hero__glow--${modeId.toLowerCase()}`} aria-hidden="true" />
      <div class="hs-hero__body">
        <span class="hs-hero__mode" data-testid="hero-mode">
          {t('Modus', 'Mode')}: <strong>{modeLabel}</strong>
        </span>

        {decidedBy !== undefined && (
          <p class="hs-hero__decided" data-testid="hero-decided">
            {tServer(decidedBy)}
          </p>
        )}

        <p class="hs-hero__benefit" data-testid="hero-benefit">
          {avoided === null ? (
            t('Nutzen wird berechnet, sobald eine Prognose vorliegt.', 'Benefit is computed once a forecast is available.')
          ) : (
            <Fragment>
              <strong>{num1(avoided)} °C</strong> {t('vermiedene Erwärmung heute', 'avoided warming today')}
            </Fragment>
          )}
          <ConfidenceBadge accuracyC={accuracy} />
        </p>

        {reasons.length > 0 && (
          <ul class="hs-hero__chips" data-testid="hero-chips">
            {reasons.map((r, i) => (
              <li key={i} class="hs-chip">
                {tServer(r)}
              </li>
            ))}
          </ul>
        )}

        {expert && (
          <ul class="hs-hero__chips hs-hero__chips--expert" data-testid="hero-expert-chips">
            <li class="hs-chip hs-chip--expert">
              {t('Einstrahlung', 'Radiation')}: {formatSignal(snap.signals?.radiation?.value ?? null, 'W/m²', 0)}
              <FreshnessDot state={snap.signals?.radiation?.state} />
            </li>
            <li class="hs-chip hs-chip--expert">
              {t('Prognose-Max', 'Forecast max')}: {formatSignal(snap.signals?.forecastMaxTemp?.value ?? null, '°C')}
              <FreshnessDot state={snap.signals?.forecastMaxTemp?.state} />
            </li>
            <li class="hs-chip hs-chip--expert">
              {t('Wind', 'Wind')}: {formatWindKmh(snap.signals?.windSpeed?.value ?? null)}
              <FreshnessDot state={snap.signals?.windSpeed?.state} />
            </li>
          </ul>
        )}

        <dl class="hs-hero__meta">
          <div class="hs-hero__meta-item">
            <dt>{t('Erwartetes Maximum', 'Expected peak')}</dt>
            <dd>{peak === null ? '–' : `${num1(peak)} °C`}</dd>
          </div>
          <div class="hs-hero__meta-item">
            <dt>{t('Prognosegüte', 'Forecast quality')}</dt>
            <dd>{accuracy === null ? t('lernt noch', 'learning') : `± ${num1(accuracy)} °C`}</dd>
          </div>
          <div class="hs-hero__meta-item">
            <dt>{t('Datenstand', 'Data age')}</dt>
            <dd>{ageText(snap)}</dd>
          </div>
        </dl>
      </div>
    </section>
  );
}
