/**
 * Heat Shield — right analysis rail (predictive-control-dashboard Task 19,
 * Requirement 13).
 *
 *   - AutomationStatusCard — mode, goal, reasoning chips + a Details
 *     reasoning chain (no black box, Requirement 14.1)
 *   - TemperatureChart     — past solid / forecast dashed + now line +
 *     indoor forecast mit/ohne Beschattung
 *   - PvHistoryChart       — PV day chart
 *   - HeatLoadChart        — heat-load forecast (purple)
 *   - ShutterTimeline      — per-room heatmap (0%blue→50%cyan→100%yellow,
 *     future hatched)
 */

import { h, type JSX } from 'preact';
import { useState } from 'preact/hooks';

import { HEAT_INDEX_BUCKETS, MODE_LEGEND_DE, MODE_ORDER } from './legend.js';
import { ExpandableChart, type ChartSeries } from '../lineChart.js';
import { MODE_LABELS_DE, formatSignal, formatWindKmh } from '../../format.js';
import type { DashboardSnapshot, Mode, RoomDetail } from '../../types.js';

export function AnalysisRail(props: {
  snapshot: DashboardSnapshot;
  pvHistory?: Array<{ t: number; v: number | null }>;
  now: Date;
}): JSX.Element {
  return (
    <aside class="analysis-rail" data-testid="analysis-rail">
      <AutomationStatusCard snapshot={props.snapshot} />
      <TemperatureChart snapshot={props.snapshot} now={props.now} />
      <PvHistoryChart history={props.pvHistory ?? []} />
      <HeatLoadChart snapshot={props.snapshot} now={props.now} />
      <ShutterTimeline rooms={props.snapshot.roomsDetail ?? []} now={props.now} />
      <LearningCard snapshot={props.snapshot} />
    </aside>
  );
}

/**
 * Day-to-day learning card: shows what the plugin has learned per room about
 * shading effectiveness and the recommendation it derived (catalog C5).
 */
export function LearningCard(props: { snapshot: DashboardSnapshot }): JSX.Element {
  const learning = props.snapshot.learning;
  const rooms = learning?.rooms ?? [];
  return (
    <section class="analysis-card learning-card" data-testid="learning-card">
      <header class="analysis-card__head">
        <span class="analysis-card__title">Lernen · Beschattungs-Effekt</span>
        {learning !== undefined && (
          <span class="learning-card__days" data-testid="learning-days">
            {learning.days} {learning.days === 1 ? 'Tag' : 'Tage'}
          </span>
        )}
      </header>
      {rooms.length === 0 ? (
        <p class="analysis-card__empty">warte auf Daten</p>
      ) : (
        <ul class="learning-list">
          {rooms.map((r) => (
            <li
              key={r.id}
              class={`learning-row learning-row--${r.recommendationLevel}`}
              data-testid={`learning-row-${r.id}`}
              data-level={r.recommendationLevel}
            >
              <span class="learning-row__name">{r.name}</span>
              <span class="learning-row__metrics">
                {r.avgOvershootC === null
                  ? '—'
                  : `${r.avgOvershootC > 0 ? '+' : ''}${r.avgOvershootC} K ggü. Komfort`}
                {' · '}
                {r.avgMovesPerDay} Fahrten/Tag
                {r.comfortBiasC !== 0 && (
                  <span class="learning-row__bias">
                    {' · '}
                    {r.comfortBiasC > 0 ? '+' : ''}
                    {r.comfortBiasC} K
                  </span>
                )}
              </span>
              <span class="learning-row__rec">{r.recommendation}</span>
              {r.calibrationNote !== undefined && (
                <span class="learning-row__calib" data-testid={`learning-calib-${r.id}`}>
                  🌡 {r.calibrationNote}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function AutomationStatusCard(props: {
  snapshot: DashboardSnapshot;
}): JSX.Element {
  const snap = props.snapshot;
  const mode = snap.modeInfo;
  const [open, setOpen] = useState(false);
  const reasons = mode?.reasons ?? [];
  return (
    <section class="analysis-card automation-status" data-testid="automation-status">
      <header class="analysis-card__head">
        <span class="analysis-card__title">Automatik-Logik</span>
        <button
          type="button"
          class="automation-status__info"
          data-testid="automation-info-toggle"
          aria-expanded={open}
          aria-label="Detaillierte Erklärung anzeigen"
          title="Warum entscheidet das Plugin so? — ausführliche Erklärung"
          onClick={(): void => setOpen((v) => !v)}
        >
          ⓘ
        </button>
      </header>
      <p class="automation-status__mode-line">
        <span class="automation-status__mode" data-testid="automation-mode">
          {mode?.label ?? '–'}
        </span>
      </p>
      <p class="automation-status__goal" data-testid="automation-goal">
        {mode?.goal ?? 'warte auf Daten'}
      </p>
      {mode?.decidedBy !== undefined && (
        <p class="automation-status__decided" data-testid="automation-decided">
          <span class="automation-status__decided-label">Ausschlaggebend</span>
          <span class="automation-status__decided-text">{mode.decidedBy}</span>
        </p>
      )}
      {/* Reason chips only when there is no single "Ausschlaggebend" line —
          otherwise they just repeat it (the full breakdown lives behind ⓘ). */}
      {mode?.decidedBy === undefined && (
        <div class="automation-status__chips" data-testid="automation-reasons">
          {reasons.length === 0 ? (
            <span class="reason-chip reason-chip--muted">keine Begründung</span>
          ) : (
            reasons.map((r) => (
              <span key={r} class="reason-chip" data-testid="reason-chip">
                {r}
              </span>
            ))
          )}
        </div>
      )}
      <button
        type="button"
        class="automation-status__details-toggle"
        data-testid="automation-details-toggle"
        aria-expanded={open}
        hidden
        onClick={(): void => setOpen((v) => !v)}
      />
      {open && <AutomationExplanation snapshot={snap} />}
    </section>
  );
}

/** Format a planned-action target as a readable percent (accepts 0–1 or 0–100). */
function actionPct(target01OrPct: number): number {
  const v = target01OrPct <= 1 ? target01OrPct * 100 : target01OrPct;
  return Math.max(0, Math.min(100, Math.round(v)));
}

/**
 * The genuinely detailed "why" panel (Requirement 14.1 transparency). Pulls
 * the live measurements, the deciding factor, what the mode means, what the
 * plugin is doing right now, and any active overrides — no echoing of the
 * headline.
 */
function AutomationExplanation(props: { snapshot: DashboardSnapshot }): JSX.Element {
  const snap = props.snapshot;
  const mode = snap.modeInfo;
  const sig = snap.signals;
  const rooms = snap.roomsDetail ?? [];
  const actions = snap.plannedActions ?? [];

  const warmest = rooms.reduce<RoomDetail | null>((best, r) => {
    if (r.indoorTempC === null) return best;
    if (best === null || (best.indoorTempC ?? -Infinity) < r.indoorTempC) return r;
    return best;
  }, null);

  const roomName = (windowId: string): string => {
    const r = rooms.find((rm) => rm.nextAction?.windowId === windowId);
    return r?.name ?? `Fenster …${windowId.slice(-4)}`;
  };

  const overrides: string[] = [];
  if (snap.automationEnabled === false) {
    overrides.push('Automatik ist AUS — alle Positionen werden gehalten.');
  }
  if (snap.userIntent?.paused === true) {
    overrides.push('Manuell pausiert — keine automatischen Fahrten.');
  }
  if (snap.userIntent?.vacation === true) {
    overrides.push('Urlaubsmodus aktiv — Komfortschwellen abgesenkt.');
  }
  if (snap.storm?.holdUntil != null) {
    overrides.push('STURM-Halt aktiv — Sicherheitsposition hat Vorrang vor allem.');
  }

  return (
    <div class="automation-explain" data-testid="automation-explain">
      <section class="automation-explain__block">
        <h4>1 · Aktuelle Messlage</h4>
        <dl class="automation-explain__grid">
          <ExplainRow label="Außentemperatur" value={formatSignal(sig?.outdoorTemp.value ?? null, '°C', 1)} />
          <ExplainRow label="Tagesprognose (max)" value={formatSignal(sig?.forecastMaxTemp.value ?? null, '°C', 1)} />
          <ExplainRow label="PV-Leistung" value={formatSignal(sig?.pvPower.value ?? null, 'kW', 1)} />
          <ExplainRow label="Wind" value={formatWindKmh(sig?.windSpeed.value ?? null)} />
          <ExplainRow label="Strahlung" value={formatSignal(sig?.radiation.value ?? null, 'W/m²', 0)} />
          <ExplainRow
            label="Wärmster Raum"
            value={
              warmest === null || warmest.indoorTempC === null
                ? '–'
                : `${warmest.name} ${warmest.indoorTempC.toFixed(1)} °C`
            }
          />
        </dl>
      </section>

      <section class="automation-explain__block">
        <h4>2 · Entscheidung</h4>
        <p class="automation-explain__lead">
          Modus <b>{mode?.label ?? '–'}</b>
          {mode?.decidedBy !== undefined ? ` — ${mode.decidedBy}.` : '.'}
        </p>
        {mode?.id !== undefined && MODE_LEGEND_DE[mode.id as Mode] !== undefined && (
          <p class="automation-explain__text">{MODE_LEGEND_DE[mode.id as Mode]}</p>
        )}
      </section>

      <section class="automation-explain__block">
        <h4>3 · Was jetzt passiert</h4>
        <p class="automation-explain__text">{mode?.goal ?? 'warte auf Daten'}</p>
        {actions.length === 0 ? (
          <p class="automation-explain__muted">Aktuell sind keine Rollladenfahrten geplant.</p>
        ) : (
          <ul class="automation-explain__actions">
            {actions.slice(0, 8).map((a) => (
              <li key={`${a.windowId}-${a.scheduledTs}`}>
                <b>{roomName(a.windowId)}</b> → {actionPct(a.targetPercent)} %
                <span class="automation-explain__reason"> · {a.reason}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {overrides.length > 0 && (
        <section class="automation-explain__block">
          <h4>4 · Aktive Übersteuerungen</h4>
          <ul class="automation-explain__overrides">
            {overrides.map((o) => (
              <li key={o}>{o}</li>
            ))}
          </ul>
        </section>
      )}

      <details class="automation-explain__glossary">
        <summary>Modus-Glossar &amp; Komfortindex</summary>
        <dl class="automation-explain__modes">
          {MODE_ORDER.map((m: Mode) => (
            <div
              key={m}
              class={`automation-explain__mode ${mode?.id === m ? 'automation-explain__mode--active' : ''}`}
            >
              <dt>{MODE_LABELS_DE[m] ?? m}</dt>
              <dd>{MODE_LEGEND_DE[m]}</dd>
            </div>
          ))}
        </dl>
        <ul class="automation-explain__buckets">
          {HEAT_INDEX_BUCKETS.map((b) => (
            <li key={b.label}>
              <span class="automation-explain__range">
                {b.from}–{b.to}
              </span>{' '}
              {b.label}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

function ExplainRow(props: { label: string; value: string }): JSX.Element {
  return (
    <div class="automation-explain__row">
      <dt>{props.label}</dt>
      <dd>{props.value}</dd>
    </div>
  );
}

export function TemperatureChart(props: {
  snapshot: DashboardSnapshot;
  now: Date;
}): JSX.Element {
  const snap = props.snapshot;
  const traj = snap.trajectories;
  const nowMs = props.now.getTime();

  // Current measured indoor average (single instant marker series).
  const indoorTemps = (snap.rooms ?? [])
    .map((r) => r.tempC)
    .filter((t): t is number => t !== null && Number.isFinite(t));
  const indoorAvg =
    indoorTemps.length > 0
      ? Math.round((indoorTemps.reduce((a, b) => a + b, 0) / indoorTemps.length) * 10) / 10
      : null;

  const withShadePts = (traj?.indoorForecastWithShade ?? []).map((p) => ({
    t: Date.parse(p.ts),
    v: p.tempC,
  }));
  const noShadePts = (traj?.indoorForecastNoShade ?? []).map((p) => ({
    t: Date.parse(p.ts),
    v: p.tempC,
  }));
  const outdoorPts = (snap.forecastTimeline ?? []).map((c) => ({
    t: Date.parse(c.ts),
    v: c.tempC,
  }));

  const hasForecast =
    withShadePts.length > 0 || noShadePts.length > 0 || outdoorPts.length > 1;

  const series: ChartSeries[] = [];
  if (outdoorPts.length > 0) {
    series.push({ label: 'Außen', color: '#f59e0b', points: outdoorPts });
  }
  // Measured indoor average as a short solid anchor at "now".
  if (indoorAvg !== null) {
    series.push({
      label: 'Innen gemessen',
      color: '#e8edf6',
      points: [{ t: nowMs, v: indoorAvg }],
    });
  }
  if (withShadePts.length > 0) {
    series.push({
      label: 'Innen mit Beschattung',
      color: '#22c55e',
      dashed: true,
      points: withShadePts,
    });
  }
  if (noShadePts.length > 0) {
    series.push({
      label: 'Innen ohne Beschattung',
      color: '#ef4444',
      dashed: true,
      points: noShadePts,
    });
  }

  return (
    <section class="analysis-card" data-testid="temperature-chart">
      <header class="analysis-card__head">
        <span class="analysis-card__title">Temperatur – Prognose mit/ohne Beschattung</span>
      </header>
      {hasForecast ? (
        <ExpandableChart
          title="Temperatur – Prognose mit/ohne Beschattung"
          series={series}
          unit="°C"
          nowT={nowMs}
          comfortBand={{ lo: 20, hi: 26 }}
        />
      ) : (
        <p class="analysis-card__empty" data-testid="temperature-chart-empty">
          warte auf Prognosedaten
        </p>
      )}
    </section>
  );
}

export function PvHistoryChart(props: {
  history: Array<{ t: number; v: number | null }>;
}): JSX.Element {
  const series: ChartSeries = {
    label: 'PV',
    color: '#f59e0b',
    points: props.history,
  };
  return (
    <section class="analysis-card" data-testid="pv-history-chart">
      <header class="analysis-card__head">
        <span class="analysis-card__title">PV-Tagesverlauf</span>
      </header>
      <ExpandableChart title="PV-Tagesverlauf" series={[series]} unit="kW" />
    </section>
  );
}

export function HeatLoadChart(props: {
  snapshot: DashboardSnapshot;
  now: Date;
}): JSX.Element {
  const traj = props.snapshot.trajectories;
  const series: ChartSeries = {
    label: 'Wärmelast',
    color: '#a855f7',
    points: (traj?.heatLoadForecast ?? []).map((p) => ({
      t: Date.parse(p.ts),
      v: Math.round(p.load01 * 100),
    })),
  };
  return (
    <section class="analysis-card" data-testid="heat-load-chart">
      <header class="analysis-card__head">
        <span class="analysis-card__title">Wärmelast-Prognose</span>
      </header>
      <ExpandableChart title="Wärmelast-Prognose" series={[series]} unit="%" nowT={props.now.getTime()} />
    </section>
  );
}

/** Colour for a shutter percent on the heatmap (0 blue → 50 cyan → 100 yellow). */
export function heatmapColor(percent: number): string {
  const p = Math.max(0, Math.min(100, percent)) / 100;
  if (p <= 0.5) {
    // blue → cyan
    return mix('#3b82f6', '#22d3ee', p / 0.5);
  }
  // cyan → yellow
  return mix('#22d3ee', '#eab308', (p - 0.5) / 0.5);
}

function mix(a: string, b: string, t: number): string {
  const pa = hex(a);
  const pb = hex(b);
  const r = Math.round(pa[0] + (pb[0] - pa[0]) * t);
  const g = Math.round(pa[1] + (pb[1] - pa[1]) * t);
  const bl = Math.round(pa[2] + (pb[2] - pa[2]) * t);
  return `rgb(${r}, ${g}, ${bl})`;
}

function hex(c: string): [number, number, number] {
  return [
    parseInt(c.slice(1, 3), 16),
    parseInt(c.slice(3, 5), 16),
    parseInt(c.slice(5, 7), 16),
  ];
}

/**
 * Per-room shutter steering over the next 12 h. Each room is a row of 2-hour
 * buckets; a bucket shows the planned shutter percent at that time — the
 * current position until the planned action's `scheduledTs`, then the action's
 * target afterwards. Colour encodes the percent (0 % blue → 100 % yellow).
 */
export function ShutterTimeline(props: {
  rooms: RoomDetail[];
  now: Date;
}): JSX.Element {
  const STEPS = 7; // now + 6 × 2h buckets = next 12 h
  const STEP_MS = 2 * 3_600_000;
  const nowMs = props.now.getTime();
  const bucketTimes = Array.from({ length: STEPS }, (_, i) => nowMs + i * STEP_MS);
  const hourLabel = (ms: number, i: number): string =>
    i === 0
      ? 'Jetzt'
      : new Date(ms).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  /** Planned shutter percent for a room at a given instant. */
  const percentAt = (r: RoomDetail, ms: number): number => {
    const action = r.nextAction;
    if (action !== null) {
      const at = Date.parse(action.scheduledTs);
      if (Number.isFinite(at) && ms >= at) {
        return action.targetPercent;
      }
    }
    return r.shutterPercent;
  };
  return (
    <section class="analysis-card shutter-timeline" data-testid="shutter-heatmap">
      <header class="analysis-card__head">
        <span class="analysis-card__title">Rollladen-Steuerung · nächste 12 h</span>
      </header>
      {props.rooms.length === 0 ? (
        <p class="analysis-card__empty">warte auf Daten</p>
      ) : (
        <div class="heatmap-grid">
          <div class="heatmap-row heatmap-row--head" data-testid="heatmap-head">
            <span class="heatmap-row__label" />
            <div class="heatmap-row__cells">
              {bucketTimes.map((ms, i) => (
                <span key={ms} class="heatmap-axis">
                  {hourLabel(ms, i)}
                </span>
              ))}
            </div>
          </div>
          {props.rooms.map((r) => (
            <div class="heatmap-row" key={r.id} data-testid={`heatmap-row-${r.id}`}>
              <span class="heatmap-row__label">{r.name}</span>
              <div class="heatmap-row__cells">
                {bucketTimes.map((ms, i) => {
                  const pct = percentAt(r, ms);
                  const future = i > 0;
                  return (
                    <span
                      key={ms}
                      class={`heatmap-cell ${future ? 'heatmap-cell--future' : ''}`}
                      data-future={future ? 'true' : 'false'}
                      style={{ background: heatmapColor(pct) }}
                      title={`${hourLabel(ms, i)}: ${pct} % geschlossen`}
                    />
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
