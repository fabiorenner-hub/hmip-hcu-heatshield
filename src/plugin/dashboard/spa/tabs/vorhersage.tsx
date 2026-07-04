/**
 * Heat Shield — "Vorhersage" primary view (Blueprint Phase 6).
 *
 * Wraps the existing weather/forecast content (`HistoryTab`) with a semantic
 * SITUATION card at the top: "Erhöhtes Überhitzungsrisiko heute 15–18 Uhr" —
 * derived from the with-shade indoor trajectory crossing the comfort ceiling,
 * plus affected rooms, max outdoor temp, strongest solar facade and the
 * protective effect (avoided warming). No new forecast maths — it summarizes
 * data already in the snapshot; uncertainty stays qualitative/heuristic.
 */

import { h, Fragment, type JSX } from 'preact';

import { HistoryTab } from './history.js';
import { snapshot } from '../store.js';
import { t } from '../i18n.js';
import type { DashboardSnapshot, FacadeKey } from '../types.js';

interface RoutableProps {
  path?: string;
  default?: boolean;
}

const COMFORT_HI = 26; // blueprint comfort band 20–26 °C

const FACADE_DE: Record<FacadeKey, string> = { N: 'Nord', E: 'Ost', S: 'Süd', W: 'West' };
const FACADE_EN: Record<FacadeKey, string> = { N: 'North', E: 'East', S: 'South', W: 'West' };

function hourLabel(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '–' : `${String(d.getHours()).padStart(2, '0')}:00`;
}

/** First contiguous span where the with-shade indoor forecast exceeds comfort. */
function riskWindow(snap: DashboardSnapshot): { start: string; end: string; peak: number } | null {
  const pts = snap.trajectories?.indoorForecastWithShade ?? [];
  let start: string | null = null;
  let end: string | null = null;
  let peak = -Infinity;
  for (const p of pts) {
    if (p.tempC >= COMFORT_HI) {
      if (start === null) start = p.ts;
      end = p.ts;
      if (p.tempC > peak) peak = p.tempC;
    } else if (start !== null) {
      break;
    }
  }
  return start !== null && end !== null ? { start, end, peak } : null;
}

function strongestFacade(snap: DashboardSnapshot): { label: string; pct: number } | null {
  const f = snap.facades;
  if (f === undefined) return null;
  const keys: FacadeKey[] = ['N', 'E', 'S', 'W'];
  let best: FacadeKey = 'N';
  for (const k of keys) if (f[k] > f[best]) best = k;
  return { label: t(FACADE_DE[best], FACADE_EN[best]), pct: Math.round(f[best]) };
}

function trajectoryPeak(pts?: Array<{ tempC: number }>): number | null {
  if (pts === undefined || pts.length === 0) return null;
  return pts.reduce((m, p) => (p.tempC > m ? p.tempC : m), -Infinity);
}

/**
 * Forecast Quality Center (Blueprint Phase 10.2 — UI only, no new maths).
 * Surfaces the accuracy/learning metrics ALREADY in the snapshot. Honest by
 * design: a room is never rated "good" when its sample is too small; real
 * calibrated quantiles (P10/P50/P90) are a separate gated algorithm change.
 */
function ForecastQualityCenter(): JSX.Element | null {
  const snap = snapshot.value;
  if (snap === null) return null;
  const impact = snap.impact;
  const rooms = snap.learning?.rooms ?? [];
  const MIN_DAYS = 5;

  function rating(sampleDays: number, overshoot: number | null): { label: string; cls: string } {
    if (sampleDays < MIN_DAYS) return { label: t('zu wenig Daten', 'insufficient data'), cls: 'q--none' };
    if (overshoot === null) return { label: t('—', '—'), cls: 'q--none' };
    const a = Math.abs(overshoot);
    if (a <= 0.5) return { label: t('gut', 'good'), cls: 'q--good' };
    if (a <= 1.5) return { label: t('mittel', 'fair'), cls: 'q--fair' };
    return { label: t('grob', 'coarse'), cls: 'q--coarse' };
  }

  return (
    <section class="rooms-section" data-testid="forecast-quality">
      <h2 class="rooms-section__title">{t('Prognosegüte', 'Forecast quality')}</h2>
      <div class="module-panel__cards">
        <article class="module-panel__card">
          <h3>{t('Ø Prognosefehler', 'Avg. forecast error')}</h3>
          <p class="module-panel__metric">
            {impact?.forecastAccuracyC === undefined ? t('lernt noch', 'learning') : `± ${impact.forecastAccuracyC.toFixed(1)} °C`}
          </p>
          <p class="module-panel__hint">
            {t(`Datenbasis: ${impact?.learnDays ?? 0} Tage.`, `Data basis: ${impact?.learnDays ?? 0} days.`)}{' '}
            {t('Kalibrierte Quantile (P10/P50/P90) folgen separat.', 'Calibrated quantiles (P10/P50/P90) will follow separately.')}
          </p>
        </article>
      </div>
      {rooms.length > 0 && (
        <ul class="vent-rooms__list" data-testid="forecast-quality-rooms">
          {rooms.map((r) => {
            const q = rating(r.sampleDays, r.avgOvershootC);
            return (
              <li key={r.id} class={`vent-room ${q.cls}`} data-testid={`fq-room-${r.id}`}>
                <span class="vent-room__name">{r.name}</span>
                <span class="vent-room__headline">
                  {q.label} · {t(`${r.sampleDays} Tage`, `${r.sampleDays} days`)}
                </span>
                <span class="vent-room__detail">
                  {r.avgOvershootC === null
                    ? t('keine Abweichungsdaten', 'no deviation data')
                    : t(`Ø Abweichung ${r.avgOvershootC > 0 ? '+' : ''}${r.avgOvershootC} K`, `avg. deviation ${r.avgOvershootC > 0 ? '+' : ''}${r.avgOvershootC} K`)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function VorhersageLagekarte(): JSX.Element | null {
  const snap = snapshot.value;
  if (snap === null) return null;
  const win = riskWindow(snap);
  const rooms = (snap.roomsDetail ?? []).filter((r) => r.trend === 'up').map((r) => r.name);
  const outdoorMax = snap.signals?.forecastMaxTemp?.value ?? null;
  const solar = strongestFacade(snap);
  const withPeak = trajectoryPeak(snap.trajectories?.indoorForecastWithShade);
  const noPeak = trajectoryPeak(snap.trajectories?.indoorForecastNoShade);
  const avoided = withPeak !== null && noPeak !== null ? Math.max(0, noPeak - withPeak) : null;

  const tone = win === null ? 'calm' : 'active';
  const headline =
    win === null
      ? t('Kein erhöhtes Überhitzungsrisiko in den nächsten Stunden', 'No elevated overheating risk in the coming hours')
      : t(
          `Erhöhtes Überhitzungsrisiko ${hourLabel(win.start)}–${hourLabel(win.end)} Uhr`,
          `Elevated overheating risk ${hourLabel(win.start)}–${hourLabel(win.end)}`,
        );

  return (
    <section class={`lagekarte lagekarte--${tone}`} data-testid="vorhersage-lagekarte" data-tone={tone}>
      <h2 class="lagekarte__headline">{headline}</h2>
      <div class="lagekarte__facts">
        <Fact label={t('Betroffene Räume', 'Affected rooms')} value={rooms.length > 0 ? rooms.join(', ') : t('keine', 'none')} />
        <Fact label={t('Max. außen', 'Max outdoor')} value={outdoorMax === null ? '–' : `${Math.round(outdoorMax * 10) / 10} °C`} />
        <Fact label={t('Stärkste Sonnenlast', 'Strongest solar load')} value={solar === null ? '–' : `${solar.pct} % ${solar.label}`} />
        <Fact label={t('Schutzwirkung', 'Protective effect')} value={avoided === null ? '–' : `${avoided.toFixed(1)} °C`} />
      </div>
      <p class="lagekarte__note">
        {t(
          'Zeitfenster und Wirkung sind eine heuristische Abschätzung aus der aktuellen Prognose, keine kalibrierten Quantile.',
          'Time window and effect are a heuristic estimate from the current forecast, not calibrated quantiles.',
        )}
      </p>
    </section>
  );
}

function Fact(props: { label: string; value: string }): JSX.Element {
  return (
    <div class="lagekarte__fact">
      <span class="lagekarte__fact-label">{props.label}</span>
      <span class="lagekarte__fact-value">{props.value}</span>
    </div>
  );
}

export function VorhersageView(_props: RoutableProps): JSX.Element {
  return (
    <Fragment>
      <VorhersageLagekarte />
      <ForecastQualityCenter />
      <HistoryTab />
    </Fragment>
  );
}
