/**
 * Heat Shield — Übersicht presentational primitives (uebersicht-rework, Task 3).
 *
 * Small, dependency-light building blocks styled purely through `--hs-*`
 * tokens. All of them follow the honesty + a11y rules: missing values render
 * `–`, and status is never conveyed by colour alone (dot + text always).
 */

import { h, type JSX } from 'preact';

import { t } from '../../i18n.js';

/** Em-dash used everywhere a value is unknown. */
export const DASH = '–';

/** Freshness state shared with the snapshot `SignalValue.state`. */
export type Freshness = 'fresh' | 'soon' | 'stale' | 'unknown';

const FRESHNESS_LABEL: Record<Freshness, [string, string]> = {
  fresh: ['aktuell', 'live'],
  soon: ['bald veraltet', 'soon stale'],
  stale: ['veraltet', 'stale'],
  unknown: ['unbekannt', 'unknown'],
};

/**
 * A tiny status dot with an always-present text label (visually-hidden by
 * default) so meaning never rides on colour alone.
 */
export function StatusDot(props: {
  state: string;
  /** Accessible label; when `inline` it is also shown as text. */
  label: string;
  inline?: boolean;
}): JSX.Element {
  return (
    <span class={`hs-dot hs-dot--${props.state}`} data-testid="hs-dot" data-state={props.state}>
      <span class="hs-dot__mark" aria-hidden="true" />
      <span class={props.inline === true ? 'hs-dot__label' : 'hs-visually-hidden'}>
        {props.label}
      </span>
    </span>
  );
}

/** Freshness dot bound to a snapshot `SignalValue.state`. */
export function FreshnessDot(props: { state: Freshness | undefined; inline?: boolean }): JSX.Element {
  const state = props.state ?? 'unknown';
  const [de, en] = FRESHNESS_LABEL[state];
  return <StatusDot state={state} label={t(de, en)} {...(props.inline === true ? { inline: true } : {})} />;
}

/**
 * Confidence / forecast-quality badge. Shows `± X °C` when an accuracy value is
 * present, else the honest "learning" state. Never fabricates precision.
 */
export function ConfidenceBadge(props: {
  accuracyC: number | null;
  /** Extra hint appended to the tooltip (e.g. data age / basis). */
  hint?: string;
}): JSX.Element {
  const learning = props.accuracyC === null;
  const label = learning
    ? t('lernt noch', 'learning')
    : `± ${(props.accuracyC ?? 0).toFixed(1)} °C`;
  const title = learning
    ? t('Prognosegüte wird noch gelernt', 'Forecast quality is still being learned')
    : t(
        `Mittlerer Prognosefehler ${label}`,
        `Mean forecast error ${label}`,
      );
  return (
    <span
      class={`hs-confidence${learning ? ' hs-confidence--learning' : ''}`}
      data-testid="confidence-badge"
      title={props.hint !== undefined ? `${title} · ${props.hint}` : title}
    >
      <span class="hs-confidence__icon" aria-hidden="true" />
      <span class="hs-confidence__label">{label}</span>
    </span>
  );
}

/**
 * Compact KPI tile: label + big value + optional hint + optional freshness dot.
 * The value is passed pre-formatted (the caller applies the honesty `–`).
 */
export function MetricTile(props: {
  label: string;
  value: string;
  hint?: string;
  freshness?: Freshness;
  testId: string;
  /** Semantic tint token name suffix, e.g. 'amber' | 'cyan' | 'blue'. */
  tint?: string;
}): JSX.Element {
  return (
    <article
      class={`hs-metric${props.tint !== undefined ? ` hs-metric--${props.tint}` : ''}`}
      data-testid={props.testId}
    >
      <span class="hs-metric__label">
        {props.label}
        {props.freshness !== undefined && <FreshnessDot state={props.freshness} />}
      </span>
      <span class="hs-metric__value">{props.value}</span>
      {props.hint !== undefined && <span class="hs-metric__hint">{props.hint}</span>}
    </article>
  );
}
