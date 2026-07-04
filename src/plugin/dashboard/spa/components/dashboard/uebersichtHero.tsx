/**
 * Heat Shield — Übersicht hero + KPI row (Blueprint Phase 4).
 *
 * The Übersicht is a DECISION surface, not a metric grid: a hero that answers
 * "is the house protected, what's coming, what will HeatShield do?" in one
 * glance, plus four compact KPI cards. Everything is derived from the live
 * snapshot with honest fallbacks (no invented precision); each value degrades
 * to "–" when its source is missing.
 *
 * Pure/presentational — reads the passed snapshot only.
 */

import { h, type JSX } from 'preact';

import { t } from '../../i18n.js';
import type { DashboardSnapshot, FacadeKey } from '../../types.js';

const FACADE_LABEL_DE: Record<FacadeKey, string> = { N: 'Nord', E: 'Ost', S: 'Süd', W: 'West' };
const FACADE_LABEL_EN: Record<FacadeKey, string> = { N: 'North', E: 'East', S: 'South', W: 'West' };

function num1(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '–' : v.toFixed(1);
}

/** Max temperature in a forecast trajectory, or null when empty. */
function trajectoryPeak(pts?: Array<{ tempC: number }>): number | null {
  if (pts === undefined || pts.length === 0) return null;
  return pts.reduce((m, p) => (p.tempC > m ? p.tempC : m), -Infinity);
}

/** Avoided warming (°C) = no-shade peak − with-shade peak, clamped ≥ 0. */
function avoidedWarmingC(snap: DashboardSnapshot): number | null {
  const withShade = trajectoryPeak(snap.trajectories?.indoorForecastWithShade);
  const noShade = trajectoryPeak(snap.trajectories?.indoorForecastNoShade);
  if (withShade === null || noShade === null) return null;
  return Math.max(0, noShade - withShade);
}

/** Strongest facade (max solar load %) with a localized direction label. */
function strongestFacade(snap: DashboardSnapshot): { label: string; pct: number } | null {
  const f = snap.facades;
  if (f === undefined) return null;
  const keys: FacadeKey[] = ['N', 'E', 'S', 'W'];
  let best: FacadeKey = 'N';
  for (const k of keys) if (f[k] > f[best]) best = k;
  return { label: t(FACADE_LABEL_DE[best], FACADE_LABEL_EN[best]), pct: Math.round(f[best]) };
}

/** 2 h precipitation sum (mm) from the nowcast, or null. */
function precip2hMm(snap: DashboardSnapshot): number | null {
  const pc = snap.precipNowcast;
  if (pc === undefined || pc.length === 0) return null;
  return Math.round(pc.reduce((s, p) => s + p.precipMm, 0) * 10) / 10;
}

interface Headline {
  tone: 'calm' | 'active' | 'alert';
  title: string;
}

function primaryHeadline(snap: DashboardSnapshot): Headline {
  const stormHold = snap.storm.holdUntil !== null && snap.storm.holdUntil !== undefined;
  if (snap.mode === 'STORM' || stormHold) {
    return { tone: 'alert', title: t('Sturmschutz aktiv — Rollläden in Sicherheit', 'Storm protection active — shutters moved to safety') };
  }
  if (snap.weatherAlert?.active === true) {
    return { tone: 'alert', title: t('Unwetterwarnung aktiv', 'Severe-weather warning active') };
  }
  if (snap.mode === 'HEATWAVE' || snap.mode === 'ACTIVE_HEAT_PROTECTION') {
    return { tone: 'active', title: t('Hitzeschutz aktiv — Räume werden vorausschauend beschattet', 'Heat protection active — rooms are shaded predictively') };
  }
  if (snap.mode === 'NIGHT_COOLING') {
    return { tone: 'active', title: t('Nachtkühlung läuft', 'Night cooling in progress') };
  }
  if (snap.mode === 'SUMMER_WATCH') {
    return { tone: 'calm', title: t('Sommer im Blick — noch kein Hitzestress', 'Watching summer — no heat stress yet') };
  }
  return { tone: 'calm', title: t('Alles im grünen Bereich', 'All clear') };
}

/** Snapshot age in whole minutes, or null. */
function ageMinutes(ts: string): number | null {
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? Math.max(0, Math.round((Date.now() - ms) / 60000)) : null;
}

export function UebersichtHero(props: { snapshot: DashboardSnapshot }): JSX.Element {
  const snap = props.snapshot;
  const head = primaryHeadline(snap);
  const avoided = avoidedWarmingC(snap);
  const peak = trajectoryPeak(snap.trajectories?.indoorForecastWithShade) ?? snap.indoorPeakTempC ?? null;
  const mode = snap.modeInfo?.label;
  const accuracy = snap.impact?.forecastAccuracyC;
  const age = ageMinutes(snap.ts);

  return (
    <section class={`uebersicht-hero uebersicht-hero--${head.tone}`} data-testid="uebersicht-hero" data-tone={head.tone}>
      <div class="uebersicht-hero__body">
        <h1 class="uebersicht-hero__title">{head.title}</h1>
        <p class="uebersicht-hero__benefit" data-testid="hero-benefit">
          {avoided === null
            ? t('Nutzen wird berechnet, sobald eine Prognose vorliegt.', 'Benefit is computed once a forecast is available.')
            : t(`${num1(avoided)} °C vermiedene Erwärmung heute`, `${num1(avoided)} °C avoided warming today`)}
        </p>
        <dl class="uebersicht-hero__meta">
          <div class="uebersicht-hero__meta-item">
            <dt>{t('Erwartetes Maximum', 'Expected peak')}</dt>
            <dd>{peak === null ? '–' : `${num1(peak)} °C`}</dd>
          </div>
          <div class="uebersicht-hero__meta-item">
            <dt>{t('Modus', 'Mode')}</dt>
            <dd>{mode ?? '–'}</dd>
          </div>
          <div class="uebersicht-hero__meta-item">
            <dt>{t('Prognosegüte', 'Forecast quality')}</dt>
            <dd>{accuracy === undefined ? t('lernt noch', 'learning') : t(`± ${num1(accuracy)} °C`, `± ${num1(accuracy)} °C`)}</dd>
          </div>
          <div class="uebersicht-hero__meta-item">
            <dt>{t('Datenstand', 'Data age')}</dt>
            <dd>{age === null ? '–' : age < 1 ? t('aktuell', 'live') : t(`vor ${age} min`, `${age} min ago`)}</dd>
          </div>
        </dl>
      </div>
    </section>
  );
}

export function UebersichtKpis(props: { snapshot: DashboardSnapshot }): JSX.Element {
  const snap = props.snapshot;
  const avoided = avoidedWarmingC(snap);
  const solar = strongestFacade(snap);
  const vent = snap.ventilation?.overall.level;
  const ventLabel: Record<string, string> = {
    air_now: t('Jetzt lüften', 'Air now'),
    air_possible: t('Lüften möglich', 'Airing possible'),
    close_window: t('Fenster schließen', 'Close windows'),
    keep_closed: t('Geschlossen halten', 'Keep closed'),
    neutral: '–',
  };
  const precip = precip2hMm(snap);
  const cloud = snap.signals?.forecastCloudCover?.value ?? null;

  return (
    <div class="uebersicht-kpis" data-testid="uebersicht-kpis">
      <Kpi label={t('Vermiedene Wärme', 'Avoided warming')} value={avoided === null ? '–' : `${num1(avoided)} °C`} testId="kpi-avoided" />
      <Kpi
        label={t('Stärkste Sonnenlast', 'Strongest solar load')}
        value={solar === null ? '–' : `${solar.pct} %`}
        {...(solar !== null ? { hint: solar.label } : {})}
        testId="kpi-solar"
      />
      <Kpi
        label={t('Lüftung', 'Ventilation')}
        value={vent === undefined ? '–' : (ventLabel[vent] ?? '–')}
        testId="kpi-vent"
      />
      <Kpi
        label={t('Regen · 2 h', 'Rain · 2 h')}
        value={
          precip !== null
            ? `${num1(precip)} mm`
            : cloud !== null
              ? `${Math.round(cloud > 1 ? cloud : cloud * 100)} % ${t('Wolken', 'cloud')}`
              : '–'
        }
        testId="kpi-rain"
      />
    </div>
  );
}

function Kpi(props: { label: string; value: string; hint?: string; testId: string }): JSX.Element {
  return (
    <article class="uebersicht-kpi" data-testid={props.testId}>
      <span class="uebersicht-kpi__label">{props.label}</span>
      <span class="uebersicht-kpi__value">{props.value}</span>
      {props.hint !== undefined && <span class="uebersicht-kpi__hint">{props.hint}</span>}
    </article>
  );
}
