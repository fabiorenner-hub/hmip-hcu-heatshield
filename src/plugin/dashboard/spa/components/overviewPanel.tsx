/**
 * 360°-Live-Übersicht (Task 3).
 *
 * Kachel-Raster oben im Live-Tab: zeigt die wichtigsten Umweltgrößen
 * (Sonne, Außentemperatur, PV-Leistung, Wind, Strahlung, Bewölkung,
 * Vorhersage-Max) aus dem erweiterten `DashboardSnapshot`.
 *
 * Defensiv gegen einen Snapshot ohne `signals`/`sun`-Block (ältere
 * Server): jede Kachel rendert dann im „–"-Zustand statt zu crashen.
 * Fehlt ein einzelner Signalwert (`null`), zeigt die Kachel „–" plus
 * einen Hinweis mit Deep-Link auf den Quellen-Tab.
 */

import { h, type JSX } from 'preact';

import { navigate } from '../app.js';
import {
  compassLabel,
  formatSignal,
  stalenessDot,
  type StalenessState,
} from '../format.js';
import { t } from '../i18n.js';
import { snapshot } from '../store.js';
import type { SignalValue } from '../types.js';

interface TileProps {
  label: string;
  signal: SignalValue | undefined;
  unit: string;
  digits?: number;
  /** Multiply the raw value before formatting (e.g. m/s → km/h). Default 1. */
  scale?: number;
  testId: string;
  /** Optional trend slope (per hour) → renders an ↑/→/↓ arrow. */
  trendPerHour?: number | null;
}

/** ↑ / → / ↓ arrow for a slope, with a small dead-band around zero. */
function trendArrow(slope: number | null | undefined): { glyph: string; cls: string } {
  if (slope === null || slope === undefined || Number.isNaN(slope)) {
    return { glyph: '', cls: 'overview-tile__trend--none' };
  }
  if (slope > 0.2) {
    return { glyph: '↑', cls: 'overview-tile__trend--up' };
  }
  if (slope < -0.2) {
    return { glyph: '↓', cls: 'overview-tile__trend--down' };
  }
  return { glyph: '→', cls: 'overview-tile__trend--flat' };
}

/** One signal tile: value + unit + freshness dot, or "–" + Deep-Link. */
function SignalTile(props: TileProps): JSX.Element {
  const sig = props.signal;
  const hasValue = sig !== undefined && sig.value !== null;
  const dot = stalenessDot(sig?.state as StalenessState | undefined);
  const hasTrend = props.trendPerHour !== undefined;
  const arrow = trendArrow(props.trendPerHour);
  return (
    <div class="overview-tile" data-testid={props.testId}>
      <span class="overview-tile__label">{props.label}</span>
      {hasValue ? (
        <span class="overview-tile__value">
          {formatSignal(
            sig?.value === null || sig?.value === undefined
              ? sig?.value
              : sig.value * (props.scale ?? 1),
            props.unit,
            props.digits,
          )}
          {hasTrend && arrow.glyph !== '' && (
            <span
              class={`overview-tile__trend ${arrow.cls}`}
              data-testid={`${props.testId}-trend`}
              aria-hidden="true"
            >
              {' '}
              {arrow.glyph}
            </span>
          )}
        </span>
      ) : sig?.bound === true ? (
        <span
          class="overview-tile__waiting"
          data-testid={`${props.testId}-waiting`}
          title={t('Quelle zugewiesen — warte auf Daten von der HCU/Solaranlage', 'Source assigned — waiting for data from the HCU/solar system')}
        >
          {sig.state === 'stale' ? t('⚠ Daten veraltet', '⚠ Data stale') : t('… warte auf Daten', '… waiting for data')}
        </span>
      ) : (
        <button
          type="button"
          class="overview-tile__missing"
          data-testid={`${props.testId}-missing`}
          title={t('Quelle im Tab Quellen zuweisen', 'Assign a source in the Sources tab')}
          onClick={(): void => navigate('/sources')}
        >
          {t('– Quelle zuweisen', '– Assign source')}
        </button>
      )}
      <span
        class={dot.cssClass}
        data-testid={`${props.testId}-dot`}
        data-state={sig?.state ?? 'unknown'}
        title={dot.label}
      />
    </div>
  );
}

export function OverviewPanel(): JSX.Element {
  const snap = snapshot.value;
  const signals = snap?.signals;
  const sun = snap?.sun;
  const feelsLike = snap?.feelsLike;
  const trends = snap?.trends;

  return (
    <section class="overview-panel" data-testid="overview-panel">
      {/* Sun tile — computed, no staleness dot. */}
      <div class="overview-tile" data-testid="overview-tile-sun">
        <span class="overview-tile__label">{t('Sonne', 'Sun')}</span>
        {sun !== undefined ? (
          <span class="overview-tile__value">
            {compassLabel(sun.azimuthDeg)} {Math.round(sun.azimuthDeg)}° · {t('Höhe', 'Elevation')}{' '}
            {Math.round(sun.elevationDeg)}°
          </span>
        ) : (
          <span class="overview-tile__value">–</span>
        )}
      </div>

      {/* Feels-like tile — PV-led effective heat load. */}
      <div class="overview-tile overview-tile--accent" data-testid="overview-tile-feelslike">
        <span class="overview-tile__label">{t('Gefühlte Wärme', 'Feels like')}</span>
        {feelsLike !== undefined ? (
          <span class="overview-tile__value" data-testid="overview-feelslike-value">
            {feelsLike.feelsLikeC !== null
              ? `${Math.round(feelsLike.feelsLikeC * 10) / 10} °C`
              : '–'}
            <span class="overview-tile__sub">
              {' '}
              · {t('Last', 'Load')} {Math.round(feelsLike.effectiveLoad01 * 100)} %
            </span>
          </span>
        ) : (
          <span class="overview-tile__value">–</span>
        )}
      </div>

      <SignalTile
        label={t('Außentemperatur', 'Outdoor temperature')}
        signal={signals?.outdoorTemp}
        unit="°C"
        testId="overview-tile-outdoor"
        trendPerHour={trends?.outdoorCph ?? null}
      />
      <SignalTile
        label={t('PV-Leistung (Sonne)', 'PV power (sun)')}
        signal={signals?.pvPower}
        unit="kW"
        digits={2}
        testId="overview-tile-pv"
        trendPerHour={trends?.pvKwph ?? null}
      />
      <SignalTile
        label={t('Wind', 'Wind')}
        signal={signals?.windSpeed}
        unit="km/h"
        scale={3.6}
        digits={0}
        testId="overview-tile-wind"
      />
      <SignalTile
        label={t('Bewölkung', 'Cloud cover')}
        signal={signals?.forecastCloudCover}
        unit="%"
        digits={0}
        testId="overview-tile-cloud"
      />
      <SignalTile
        label={t('Vorhersage Max', 'Forecast max')}
        signal={signals?.forecastMaxTemp}
        unit="°C"
        testId="overview-tile-forecast"
      />
    </section>
  );
}
