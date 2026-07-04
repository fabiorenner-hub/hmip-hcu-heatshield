/**
 * Heat Shield — "Liquid Glass V2" shared EXPERT primitives (ui-v2-release,
 * Runde 2 deep-dive).
 *
 * Reusable, presentational building blocks for the technical expert layer that
 * every v2 page renders when `expertMode` is on. The goal is a professional,
 * high-density "engineer's view": every value carries its provenance, freshness
 * and — where the engine provides it — its confidence, so nothing is a black
 * box. All components are pure/presentational: they take already-derived data
 * and render it; no fetching, no signals, no maths beyond formatting.
 *
 * Bilingual by construction: callers pass `[de, en]` tuples for labels and
 * translate at the render edge via `t(...)`.
 */

import { h, Fragment, type JSX, type ComponentChildren } from 'preact';

import { t, fmtNum } from '../../../i18n.js';
import type { SignalValue, ValueWithQuality, WindowRiskBreakdown } from '../../../types.js';

/* -------------------------------------------------------------------------- */
/* Formatting helpers                                                         */
/* -------------------------------------------------------------------------- */

/** One-decimal number, honest `–` for null/NaN. */
export function fx(v: number | null | undefined, digits = 1): string {
  return v === null || v === undefined || !Number.isFinite(v)
    ? '–'
    : fmtNum(Math.round(v * 10 ** digits) / 10 ** digits, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
/** Integer percent from a 0..1 fraction. */
export function pct01(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '–' : `${Math.round(v * 100)} %`;
}
/** Short absolute time `HH:MM:SS`, or `–`. */
export function hms(ts: string | null | undefined): string {
  if (ts === null || ts === undefined) return '–';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '–';
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}
/** Relative age like "vor 3 min" / "12 s" from a timestamp. */
export function relAge(ts: string | null | undefined): string {
  if (ts === null || ts === undefined) return '–';
  const ms = Date.parse(ts);
  if (!Number.isFinite(ms)) return '–';
  const sec = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (sec < 60) return t(`${sec} s`, `${sec} s`);
  const min = Math.round(sec / 60);
  if (min < 90) return t(`${min} min`, `${min} min`);
  const hrs = Math.round(min / 60);
  return t(`${hrs} h`, `${hrs} h`);
}

/* -------------------------------------------------------------------------- */
/* Layout primitives                                                          */
/* -------------------------------------------------------------------------- */

/** A titled expert card (dark glass), the standard container for expert data. */
export function ExpertSection(props: {
  title: [string, string];
  testId?: string;
  hint?: [string, string];
  children: ComponentChildren;
}): JSX.Element {
  return (
    <div class="lg2-card lg2-expert" {...(props.testId !== undefined ? { 'data-testid': props.testId } : {})}>
      <span class="lg2-expert__title">{t(...props.title)}</span>
      {props.children}
      {props.hint !== undefined && <p class="lg2-settings__hint">{t(...props.hint)}</p>}
    </div>
  );
}

/** The label/value metric grid used across expert cards. */
export function ExpertMetrics(props: { children: ComponentChildren }): JSX.Element {
  return <div class="lg2-expert__grid">{props.children}</div>;
}

/** One metric cell: big value + small label (matches `.lg2-expert__grid span`). */
export function M(props: { v: string | number; label: [string, string]; title?: string }): JSX.Element {
  return (
    <span {...(props.title !== undefined ? { title: props.title } : {})}>
      <b>{props.v}</b>{t(...props.label)}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Freshness + provenance                                                     */
/* -------------------------------------------------------------------------- */

const SIGNAL_STATE_TONE: Record<SignalValue['state'], 'ok' | 'warn' | 'bad' | 'faint'> = {
  fresh: 'ok',
  soon: 'warn',
  stale: 'bad',
  unknown: 'faint',
};
const SIGNAL_STATE_LABEL: Record<SignalValue['state'], [string, string]> = {
  fresh: ['frisch', 'fresh'],
  soon: ['bald veraltet', 'ageing'],
  stale: ['veraltet', 'stale'],
  unknown: ['unbekannt', 'unknown'],
};

/** Coloured freshness dot for a signal state. */
export function FreshDot(props: { state: SignalValue['state'] }): JSX.Element {
  return <span class={`lg2-exp-dot lg2-exp-dot--${SIGNAL_STATE_TONE[props.state]}`} aria-hidden="true" />;
}

/** Provenance chip: origin (measured/forecast/estimated) + source + confidence. */
const ORIGIN_LABEL: Record<ValueWithQuality['origin'], [string, string]> = {
  measured: ['gemessen', 'measured'],
  forecast: ['Prognose', 'forecast'],
  estimated: ['geschätzt', 'estimated'],
};
export function ProvenanceChip(props: { q: ValueWithQuality }): JSX.Element {
  const { q } = props;
  return (
    <span class={`lg2-exp-prov lg2-exp-prov--${q.origin}`} title={q.source}>
      {t(...ORIGIN_LABEL[q.origin])} · {Math.round(q.confidence01 * 100)} %
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Signal table (360° telemetry)                                              */
/* -------------------------------------------------------------------------- */

export interface SignalRow {
  label: [string, string];
  sig: SignalValue;
  unit: string;
  digits?: number;
}

/** Dense telemetry table: value · unit · freshness · age · binding per signal. */
export function SignalTable(props: { rows: SignalRow[]; testId?: string }): JSX.Element {
  return (
    <div class="lg2-exp-sigtable" {...(props.testId !== undefined ? { 'data-testid': props.testId } : {})}>
      <div class="lg2-exp-sigtable__head">
        <span>{t('Signal', 'Signal')}</span>
        <span>{t('Wert', 'Value')}</span>
        <span>{t('Status', 'State')}</span>
        <span>{t('Alter', 'Age')}</span>
        <span>{t('Quelle', 'Bound')}</span>
      </div>
      {props.rows.map((r) => (
        <div class="lg2-exp-sigtable__row" key={r.label[0]}>
          <span class="lg2-exp-sigtable__name">{t(...r.label)}</span>
          <span class="lg2-exp-sigtable__val">{fx(r.sig.value, r.digits ?? 1)}{r.sig.value !== null ? ` ${r.unit}` : ''}</span>
          <span class="lg2-exp-sigtable__state"><FreshDot state={r.sig.state} />{t(...SIGNAL_STATE_LABEL[r.sig.state])}</span>
          <span class="lg2-exp-sigtable__age">{relAge(r.sig.ts)}</span>
          <span class="lg2-exp-sigtable__bound">{r.sig.bound === false ? t('nicht belegt', 'unbound') : t('belegt', 'bound')}</span>
        </div>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Normalised bar (weights / factors / loads)                                 */
/* -------------------------------------------------------------------------- */

/** A labelled 0..1 bar with a trailing percent, colour-coded by the caller. */
export function ExpBar(props: { label: string; frac: number; color?: string; value?: string }): JSX.Element {
  const w = Math.round(Math.max(0, Math.min(1, props.frac)) * 100);
  return (
    <div class="lg2-exp-bar">
      <span class="lg2-exp-bar__lbl">{props.label}</span>
      <span class="lg2-exp-bar__track">
        <span class="lg2-exp-bar__fill" style={{ width: `${w}%`, ...(props.color !== undefined ? { background: props.color } : {}) }} />
      </span>
      <span class="lg2-exp-bar__val">{props.value ?? `${w} %`}</span>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Full per-window risk breakdown (factors × weights → contribution)          */
/* -------------------------------------------------------------------------- */

const RISK_FACTOR_LABEL: Record<string, [string, string]> = {
  sunFactor: ['Sonne', 'Sun'],
  roomTempFactor: ['Raumtemp.', 'Room temp.'],
  windowTypeFactor: ['Fenstertyp', 'Window type'],
  forecastTempFactor: ['Prognosetemp.', 'Forecast temp.'],
  pvFactor: ['PV', 'PV'],
  radiationFactor: ['Strahlung', 'Radiation'],
  outdoorTempFactor: ['Außentemp.', 'Outdoor temp.'],
  priorityFactor: ['Priorität', 'Priority'],
};
const RISK_FACTOR_ORDER: string[] = [
  'sunFactor', 'radiationFactor', 'roomTempFactor', 'forecastTempFactor',
  'outdoorTempFactor', 'windowTypeFactor', 'pvFactor', 'priorityFactor',
];

/**
 * Full transparency for one window's risk score: every factor with its raw
 * value, weight and resulting contribution (factor × weight), plus the raw vs
 * final target and the deciding mode. This is the heart of "no black box".
 */
export function RiskBreakdownDetail(props: { b: WindowRiskBreakdown; name: string }): JSX.Element {
  const { b, name } = props;
  const rows = RISK_FACTOR_ORDER
    .map((key) => {
      const factor = b.factors[key as keyof typeof b.factors];
      const weight = b.weights[key as keyof typeof b.weights];
      if (factor === undefined && weight === undefined) return null;
      const contribution = (factor ?? 0) * (weight ?? 1);
      return { key, factor: factor ?? null, weight: weight ?? null, contribution };
    })
    .filter((r): r is { key: string; factor: number | null; weight: number | null; contribution: number } => r !== null)
    .sort((a, b2) => b2.contribution - a.contribution);
  const maxContribution = rows.reduce((m, r) => Math.max(m, r.contribution), 0) || 1;

  return (
    <div class="lg2-exp-risk" data-testid={`lg2-exp-risk-${b.windowId}`}>
      <div class="lg2-exp-risk__head">
        <span class="lg2-exp-risk__name">{name}</span>
        <span class="lg2-exp-risk__stat">{t('Risiko', 'Risk')} <b>{Math.round(b.risk * 100)} %</b></span>
        <span class="lg2-exp-risk__stat">{t('Ziel', 'Target')} <b>{Math.round(b.rawTarget * 100)}→{Math.round(b.finalTarget * 100)} %</b></span>
        <span class="lg2-exp-risk__stat">{t('Modus', 'Mode')} <b>{b.mode ?? '–'}</b></span>
      </div>
      <div class="lg2-exp-risk__bars">
        {rows.map((r) => (
          <ExpBar
            key={r.key}
            label={t(...(RISK_FACTOR_LABEL[r.key] ?? [r.key, r.key]))}
            frac={r.contribution / maxContribution}
            value={`${fx(r.factor === null ? null : r.factor * 100, 0)}% × ${fx(r.weight, 2)} = ${fx(r.contribution * 100, 0)}%`}
          />
        ))}
      </div>
    </div>
  );
}
