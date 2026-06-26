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

import { buildHeatIndexBuckets, buildModeLegend, MODE_ORDER } from './legend.js';
import { ExpandableChart, type ChartSeries } from '../lineChart.js';
import { MODE_LABELS_DE, formatSignal, formatWindKmh } from '../../format.js';
import { t, tServer, fmtTime } from '../../i18n.js';
import type { DashboardSnapshot, Mode, RoomDetail } from '../../types.js';

/** English counterparts to {@link MODE_LABELS_DE} (German lives in format.ts). */
const MODE_LABELS_EN: Record<string, string> = {
  NORMAL: 'Normal',
  SUMMER_WATCH: 'Summer watch',
  ACTIVE_HEAT_PROTECTION: 'Active heat protection',
  HEATWAVE: 'Heatwave',
  NIGHT_COOLING: 'Night cooling',
  STORM: 'Storm',
  VACATION: 'Vacation',
  MAINTENANCE: 'Maintenance',
};

/** Bilingual engine-mode label by mode id. */
function modeLabel(m: string): string {
  return t(MODE_LABELS_DE[m] ?? m, MODE_LABELS_EN[m] ?? m);
}

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
        <span class="analysis-card__title">{t('Lernen · Beschattungs-Effekt', 'Learning · shading effect')}</span>
        {learning !== undefined && (
          <span class="learning-card__days" data-testid="learning-days">
            {learning.days} {learning.days === 1 ? t('Tag', 'day') : t('Tage', 'days')}
          </span>
        )}
      </header>
      {rooms.length === 0 ? (
        <p class="analysis-card__empty">{t('warte auf Daten', 'waiting for data')}</p>
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
                  : `${r.avgOvershootC > 0 ? '+' : ''}${r.avgOvershootC} K ${t('ggü. Komfort', 'vs. comfort')}`}
                {' · '}
                {r.avgMovesPerDay} {t('Fahrten/Tag', 'moves/day')}
                {r.comfortBiasC !== 0 && (
                  <span class="learning-row__bias">
                    {' · '}
                    {r.comfortBiasC > 0 ? '+' : ''}
                    {r.comfortBiasC} K
                  </span>
                )}
              </span>
              <span class="learning-row__rec">{tServer(r.recommendation)}</span>
              {r.calibrationNote !== undefined && (
                <span class="learning-row__calib" data-testid={`learning-calib-${r.id}`}>
                  🌡 {tServer(r.calibrationNote)}
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
        <span class="analysis-card__title">{t('Automatik-Logik', 'Automation logic')}</span>
        <button
          type="button"
          class="automation-status__info"
          data-testid="automation-info-toggle"
          aria-expanded={open}
          aria-label={t('Detaillierte Erklärung anzeigen', 'Show detailed explanation')}
          title={t(
            'Warum entscheidet das Plugin so? — ausführliche Erklärung',
            'Why does the plugin decide this way? — detailed explanation',
          )}
          onClick={(): void => setOpen((v) => !v)}
        >
          ⓘ
        </button>
      </header>
      <p class="automation-status__mode-line">
        <span class="automation-status__mode" data-testid="automation-mode">
          {mode?.label !== undefined ? tServer(mode.label) : '–'}
        </span>
      </p>
      <p class="automation-status__goal" data-testid="automation-goal">
        {mode?.goal !== undefined ? tServer(mode.goal) : t('warte auf Daten', 'waiting for data')}
      </p>
      {mode?.decidedBy !== undefined && (
        <p class="automation-status__decided" data-testid="automation-decided">
          <span class="automation-status__decided-label">{t('Ausschlaggebend', 'Decisive')}</span>
          <span class="automation-status__decided-text">{tServer(mode.decidedBy)}</span>
        </p>
      )}
      {/* Reason chips only when there is no single "Ausschlaggebend" line —
          otherwise they just repeat it (the full breakdown lives behind ⓘ). */}
      {mode?.decidedBy === undefined && (
        <div class="automation-status__chips" data-testid="automation-reasons">
          {reasons.length === 0 ? (
            <span class="reason-chip reason-chip--muted">{t('keine Begründung', 'no reasoning')}</span>
          ) : (
            reasons.map((r) => (
              <span key={r} class="reason-chip" data-testid="reason-chip">
                {tServer(r)}
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
    return r?.name ?? `${t('Fenster', 'Window')} …${windowId.slice(-4)}`;
  };

  const overrides: string[] = [];
  if (snap.automationEnabled === false) {
    overrides.push(
      t(
        'Automatik ist AUS — alle Positionen werden gehalten.',
        'Automation is OFF — all positions are held.',
      ),
    );
  }
  if (snap.userIntent?.paused === true) {
    overrides.push(
      t('Manuell pausiert — keine automatischen Fahrten.', 'Manually paused — no automatic moves.'),
    );
  }
  if (snap.userIntent?.vacation === true) {
    overrides.push(
      t(
        'Urlaubsmodus aktiv — Komfortschwellen abgesenkt.',
        'Vacation mode active — comfort thresholds lowered.',
      ),
    );
  }
  if (snap.storm?.holdUntil != null) {
    overrides.push(
      t(
        'STURM-Halt aktiv — Sicherheitsposition hat Vorrang vor allem.',
        'STORM hold active — the safe position takes precedence over everything.',
      ),
    );
  }

  const modeLegend = buildModeLegend();
  const buckets = buildHeatIndexBuckets();

  return (
    <div class="automation-explain" data-testid="automation-explain">
      <section class="automation-explain__block">
        <h4>{t('1 · Aktuelle Messlage', '1 · Current readings')}</h4>
        <dl class="automation-explain__grid">
          <ExplainRow label={t('Außentemperatur', 'Outdoor temperature')} value={formatSignal(sig?.outdoorTemp.value ?? null, '°C', 1)} />
          <ExplainRow label={t('Tagesprognose (max)', 'Daily forecast (max)')} value={formatSignal(sig?.forecastMaxTemp.value ?? null, '°C', 1)} />
          <ExplainRow label={t('PV-Leistung', 'PV power')} value={formatSignal(sig?.pvPower.value ?? null, 'kW', 1)} />
          <ExplainRow label={t('Wind', 'Wind')} value={formatWindKmh(sig?.windSpeed.value ?? null)} />
          <ExplainRow label={t('Strahlung', 'Radiation')} value={formatSignal(sig?.radiation.value ?? null, 'W/m²', 0)} />
          <ExplainRow
            label={t('Wärmster Raum', 'Warmest room')}
            value={
              warmest === null || warmest.indoorTempC === null
                ? '–'
                : `${warmest.name} ${warmest.indoorTempC.toFixed(1)} °C`
            }
          />
        </dl>
      </section>

      <section class="automation-explain__block">
        <h4>{t('2 · Entscheidung', '2 · Decision')}</h4>
        <p class="automation-explain__lead">
          {t('Modus', 'Mode')} <b>{mode?.label !== undefined ? tServer(mode.label) : '–'}</b>
          {mode?.decidedBy !== undefined ? ` — ${tServer(mode.decidedBy)}.` : '.'}
        </p>
        {mode?.id !== undefined && modeLegend[mode.id as Mode] !== undefined && (
          <p class="automation-explain__text">{modeLegend[mode.id as Mode]}</p>
        )}
      </section>

      <section class="automation-explain__block">
        <h4>{t('3 · Was jetzt passiert', '3 · What happens now')}</h4>
        <p class="automation-explain__text">{mode?.goal !== undefined ? tServer(mode.goal) : t('warte auf Daten', 'waiting for data')}</p>
        {actions.length === 0 ? (
          <p class="automation-explain__muted">{t('Aktuell sind keine Rollladenfahrten geplant.', 'No shutter moves are currently planned.')}</p>
        ) : (
          <ul class="automation-explain__actions">
            {actions.slice(0, 8).map((a) => (
              <li key={`${a.windowId}-${a.scheduledTs}`}>
                <b>{roomName(a.windowId)}</b> → {actionPct(a.targetPercent)} %
                <span class="automation-explain__reason"> · {tServer(a.reason)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {overrides.length > 0 && (
        <section class="automation-explain__block">
          <h4>{t('4 · Aktive Übersteuerungen', '4 · Active overrides')}</h4>
          <ul class="automation-explain__overrides">
            {overrides.map((o) => (
              <li key={o}>{o}</li>
            ))}
          </ul>
        </section>
      )}

      <details class="automation-explain__glossary">
        <summary>{t('Modus-Glossar & Komfortindex', 'Mode glossary & comfort index')}</summary>
        <dl class="automation-explain__modes">
          {MODE_ORDER.map((m: Mode) => (
            <div
              key={m}
              class={`automation-explain__mode ${mode?.id === m ? 'automation-explain__mode--active' : ''}`}
            >
              <dt>{modeLabel(m)}</dt>
              <dd>{modeLegend[m]}</dd>
            </div>
          ))}
        </dl>
        <ul class="automation-explain__buckets">
          {buckets.map((b) => (
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
    series.push({ label: t('Außen', 'Outdoor'), color: '#f59e0b', points: outdoorPts });
  }
  // Measured indoor average as a short solid anchor at "now".
  if (indoorAvg !== null) {
    series.push({
      label: t('Innen gemessen', 'Indoor measured'),
      color: '#e8edf6',
      points: [{ t: nowMs, v: indoorAvg }],
    });
  }
  if (withShadePts.length > 0) {
    series.push({
      label: t('Innen mit Beschattung', 'Indoor with shading'),
      color: '#22c55e',
      dashed: true,
      points: withShadePts,
    });
  }
  if (noShadePts.length > 0) {
    series.push({
      label: t('Innen ohne Beschattung', 'Indoor without shading'),
      color: '#ef4444',
      dashed: true,
      points: noShadePts,
    });
  }

  return (
    <section class="analysis-card" data-testid="temperature-chart">
      <header class="analysis-card__head">
        <span class="analysis-card__title">{t('Temperatur – Prognose mit/ohne Beschattung', 'Temperature – forecast with/without shading')}</span>
      </header>
      {hasForecast ? (
        <ExpandableChart
          title={t('Temperatur – Prognose mit/ohne Beschattung', 'Temperature – forecast with/without shading')}
          series={series}
          unit="°C"
          nowT={nowMs}
          comfortBand={{ lo: 20, hi: 26 }}
        />
      ) : (
        <p class="analysis-card__empty" data-testid="temperature-chart-empty">
          {t('warte auf Prognosedaten', 'waiting for forecast data')}
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
        <span class="analysis-card__title">{t('PV-Tagesverlauf', 'PV day curve')}</span>
      </header>
      <ExpandableChart title={t('PV-Tagesverlauf', 'PV day curve')} series={[series]} unit="kW" />
    </section>
  );
}

export function HeatLoadChart(props: {
  snapshot: DashboardSnapshot;
  now: Date;
}): JSX.Element {
  const traj = props.snapshot.trajectories;
  const series: ChartSeries = {
    label: t('Wärmelast', 'Heat load'),
    color: '#a855f7',
    points: (traj?.heatLoadForecast ?? []).map((p) => ({
      t: Date.parse(p.ts),
      v: Math.round(p.load01 * 100),
    })),
  };
  return (
    <section class="analysis-card" data-testid="heat-load-chart">
      <header class="analysis-card__head">
        <span class="analysis-card__title">{t('Wärmelast-Prognose', 'Heat-load forecast')}</span>
      </header>
      <ExpandableChart title={t('Wärmelast-Prognose', 'Heat-load forecast')} series={[series]} unit="%" nowT={props.now.getTime()} />
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
    i === 0 ? t('Jetzt', 'Now') : fmtTime(ms);
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
        <span class="analysis-card__title">{t('Rollladen-Steuerung · nächste 12 h', 'Shutter control · next 12 h')}</span>
      </header>
      {props.rooms.length === 0 ? (
        <p class="analysis-card__empty">{t('warte auf Daten', 'waiting for data')}</p>
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
                      title={`${hourLabel(ms, i)}: ${pct} % ${t('geschlossen', 'closed')}`}
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
