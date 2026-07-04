/**
 * Heat Shield — Übersicht KPI row (uebersicht-rework, Task 9).
 *
 * Four verdichtete decision KPIs: avoided warming · strongest solar load ·
 * ventilation advice · rain (2 h) / cloud. Every value degrades to `–` when
 * its source is missing. Pure/presentational.
 */

import { h, type JSX } from 'preact';

import { t, fmtNum } from '../../i18n.js';
import type { DashboardSnapshot, FacadeKey, VentAdviceLevel } from '../../types.js';
import { MetricTile } from './primitives.js';
import {
  avoidedWarmingC,
  cloudPercent,
  precip2hMm,
  strongestFacade,
  ventilationLevel,
} from './uebersichtModel.js';

const FACADE_LABEL: Record<FacadeKey, [string, string]> = {
  N: ['Nord', 'North'],
  E: ['Ost', 'East'],
  S: ['Süd', 'South'],
  W: ['West', 'West'],
};

const VENT_LABEL: Record<VentAdviceLevel, [string, string]> = {
  air_now: ['Jetzt lüften', 'Air now'],
  air_possible: ['Lüften möglich', 'Airing possible'],
  close_window: ['Fenster schließen', 'Close windows'],
  keep_closed: ['Geschlossen halten', 'Keep closed'],
  neutral: ['–', '–'],
};

function num1(v: number | null): string {
  return v === null || !Number.isFinite(v)
    ? '–'
    : fmtNum(Math.round(v * 10) / 10, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

export function KpiRow(props: { snapshot: DashboardSnapshot }): JSX.Element {
  const snap = props.snapshot;
  const avoided = avoidedWarmingC(snap);
  const solar = strongestFacade(snap);
  const vent = ventilationLevel(snap);
  const precip = precip2hMm(snap);
  const cloud = cloudPercent(snap);

  const solarValue = solar === null ? '–' : `${solar.pct} %`;
  const solarHint = solar === null ? undefined : t(...FACADE_LABEL[solar.key]);
  const ventValue = vent === null ? '–' : t(...VENT_LABEL[vent]);
  const rainValue =
    precip !== null
      ? `${num1(precip)} mm`
      : cloud !== null
        ? `${cloud} % ${t('Wolken', 'cloud')}`
        : '–';

  return (
    <div class="hs-kpis" data-testid="kpi-row">
      <MetricTile
        label={t('Vermiedene Wärme', 'Avoided warming')}
        value={avoided === null ? '–' : `${num1(avoided)} °C`}
        testId="kpi-avoided"
        tint="green"
      />
      <MetricTile
        label={t('Stärkste Sonnenlast', 'Strongest solar load')}
        value={solarValue}
        {...(solarHint !== undefined ? { hint: solarHint } : {})}
        testId="kpi-solar"
        tint="amber"
      />
      <MetricTile
        label={t('Lüftung', 'Ventilation')}
        value={ventValue}
        testId="kpi-vent"
        tint="cyan"
      />
      <MetricTile
        label={t('Regen · 2 h', 'Rain · 2 h')}
        value={rainValue}
        testId="kpi-rain"
        tint="blue"
        {...(snap.signals?.forecastCloudCover?.state !== undefined
          ? { freshness: snap.signals.forecastCloudCover.state }
          : {})}
      />
    </div>
  );
}
