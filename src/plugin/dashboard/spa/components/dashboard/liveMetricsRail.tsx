/**
 * Heat Shield — left KPI rail (predictive-control-dashboard Task 14).
 *
 * Five live-metric cards rendered as compact, dark-theme tiles:
 *   - PvPowerCard          — PV power kW, self-use %, sparkline, PV-Sonnenindex
 *   - IndoorTemperatureCard
 *   - OutdoorTemperatureCard (local primary, internet in tooltip)
 *   - SunPositionCard      — reuses the existing SunPolarPlot
 *   - HeatIndexCard        — 0..10 on a 240° SVG ring (blue→green→…→red)
 *
 * All values are read defensively from the snapshot; missing values show
 * "–" / "warte auf Daten" so the rail renders before the first cycle.
 */

import { h, type JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import { SunPolarPlot } from '../sunPolarPlot.js';
import { LineChart } from '../lineChart.js';
import { Portal } from '../portal.js';
import { Icon } from '../icons.js';
import { formatSignal } from '../../format.js';
import { t } from '../../i18n.js';
import type { DashboardSnapshot } from '../../types.js';

const DASH = '–';

function num(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? DASH : String(v);
}

/** Sparkline colours per metric (v2 palette). */
const PV_COLOR = '#ff9d2e'; // amber (accent)
const INDOOR_COLOR = '#4a8cff'; // blue (info)
const OUTDOOR_COLOR = '#ffc45b'; // amber-soft

interface TrendSparklines {
  pv: number[];
  indoor: number[];
  outdoor: number[];
}

/**
 * Fetch the rolling trend samples (`GET /api/trends?seconds=`) and reduce
 * them to three plain number series for the KPI sparklines — exactly the
 * source the Verlauf tab reads. Defensive: a missing `fetch`, a non-OK
 * response, or a malformed body all leave the series empty (sparkline is
 * then omitted, never rendered as noise).
 */
function useTrendSparklines(seconds = 21600): TrendSparklines {
  const [data, setData] = useState<TrendSparklines>({ pv: [], indoor: [], outdoor: [] });
  useEffect(() => {
    if (typeof fetch !== 'function') {
      return undefined;
    }
    let cancelled = false;
    void (async (): Promise<void> => {
      try {
        const res = await fetch(`/api/trends?seconds=${seconds}`, {
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) {
          return;
        }
        const json = (await res.json()) as {
          samples?: Array<{ ts: string; key: string; value: number }>;
        };
        if (cancelled || !Array.isArray(json.samples)) {
          return;
        }
        const byKey = new Map<string, Array<{ t: number; v: number }>>();
        for (const s of json.samples) {
          const t = Date.parse(s.ts);
          if (!Number.isFinite(t) || !Number.isFinite(s.value)) {
            continue;
          }
          const arr = byKey.get(s.key) ?? [];
          arr.push({ t, v: s.value });
          byKey.set(s.key, arr);
        }
        for (const arr of byKey.values()) {
          arr.sort((a, b) => a.t - b.t);
        }
        const pv = (byKey.get('pv') ?? []).map((p) => p.v);
        const outdoor = (byKey.get('outdoor') ?? []).map((p) => p.v);
        // Indoor: average every `room:<id>` series per timestamp; fall back
        // to the outdoor series when no room trends exist yet.
        const roomByT = new Map<number, number[]>();
        for (const [key, arr] of byKey) {
          if (!key.startsWith('room:')) {
            continue;
          }
          for (const p of arr) {
            const list = roomByT.get(p.t) ?? [];
            list.push(p.v);
            roomByT.set(p.t, list);
          }
        }
        const indoor =
          roomByT.size > 0
            ? [...roomByT.entries()]
                .sort((a, b) => a[0] - b[0])
                .map(([, vs]) => vs.reduce((x, y) => x + y, 0) / vs.length)
            : outdoor;
        setData({ pv, indoor, outdoor });
      } catch {
        // Network/parse errors are non-fatal — keep the rail rendering.
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, [seconds]);
  return data;
}

/** Comfort label for an indoor average temperature. */
function comfortLabel(avg: number | null): string {
  if (avg === null) {
    return t('warte auf Daten', 'waiting for data');
  }
  if (avg < 20) {
    return t('kühl', 'cool');
  }
  if (avg <= 24) {
    return t('komfortabel', 'comfortable');
  }
  if (avg <= 26) {
    return t('leicht warm', 'slightly warm');
  }
  return t('zu warm', 'too warm');
}

/** PV power card with self-use %, a sparkline and the PV-Sonnenindex ring. */
export function PvPowerCard(props: {
  snapshot: DashboardSnapshot;
  history?: number[];
}): JSX.Element {
  const { snapshot, history = [] } = props;
  const pv = snapshot.signals?.pvPower;
  const pvKw = pv?.value ?? null;
  const idx = snapshot.pvSonnenindex01;
  const selfUse = snapshot.pvSelfUse01;
  const todayKwh = snapshot.pvTodayKwh;
  const showSelfUse = selfUse !== undefined && Number.isFinite(selfUse);
  return (
    <section class="kpi-card kpi-card--pv" data-testid="card-pv">
      <header class="kpi-card__head">
        <span class="kpi-card__title">{t('PV-Leistung', 'PV power')}</span>
        <Icon name="pv" size={18} class="kpi-card__icon" />
      </header>
      <div class="kpi-card__value" data-testid="card-pv-value">
        {pvKw === null ? DASH : `${formatSignal(pvKw, 'kW')}`}
      </div>
      {showSelfUse && (
        <p class="kpi-card__selfuse" data-testid="card-pv-selfuse">
          {Math.round((selfUse as number) * 100)} % {t('Eigenverbrauch', 'self-use')}
        </p>
      )}
      {history.length >= 2 && (
        <Sparkline values={history} color={PV_COLOR} testId="pv-sparkline" label={t('PV-Leistung', 'PV power')} unit="kW" />
      )}
      <dl class="kpi-card__meta">
        <div>
          <dt>{t('PV-Sonnenindex', 'PV sun index')}</dt>
          <dd data-testid="card-pv-index">
            {idx === undefined ? DASH : `${Math.round(idx * 100)} %`}
          </dd>
        </div>
        {todayKwh !== undefined && Number.isFinite(todayKwh) && (
          <div>
            <dt>{t('Heute', 'Today')}</dt>
            <dd data-testid="card-pv-today">{Math.round(todayKwh * 10) / 10} kWh</dd>
          </div>
        )}
      </dl>
    </section>
  );
}

/** Tiny dependency-free sparkline with a configurable stroke colour. When
 * `label` is given, the sparkline becomes a button that opens a deep-dive
 * modal with a full time-series chart (synthetic timestamps over `seconds`). */
function Sparkline(props: {
  values: number[];
  color?: string;
  testId?: string;
  label?: string;
  unit?: string;
  seconds?: number;
}): JSX.Element {
  const testId = props.testId ?? 'pv-sparkline';
  const color = props.color ?? 'var(--color-accent)';
  const [open, setOpen] = useState(false);
  const vals = props.values.filter((v) => Number.isFinite(v));
  if (vals.length < 2) {
    return <div class="sparkline sparkline--empty" data-testid={testId} />;
  }
  const w = 120;
  const hgt = 28;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const d = vals
    .map((v, i) => {
      const x = (i / (vals.length - 1)) * w;
      const y = hgt - ((v - min) / span) * hgt;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');
  const svg = (
    <svg
      class="sparkline"
      viewBox={`0 0 ${w} ${hgt}`}
      preserveAspectRatio="none"
      data-testid={testId}
    >
      <path d={d} fill="none" stroke={color} stroke-width={2} />
    </svg>
  );
  if (props.label === undefined) {
    return svg;
  }
  // Deep-dive: map the plain values onto evenly-spaced timestamps over the
  // trend window so the modal shows a proper time axis.
  const seconds = props.seconds ?? 21600;
  const now = Date.now();
  const step = (seconds * 1000) / (vals.length - 1);
  const points = vals.map((v, i) => ({ t: now - (vals.length - 1 - i) * step, v }));
  return (
    <div class="sparkline-wrap">
      <button
        type="button"
        class="sparkline-expand"
        title={`${props.label} ${t('vergrößern', 'enlarge')}`}
        aria-label={`${props.label} ${t('vergrößern', 'enlarge')}`}
        onClick={(): void => setOpen(true)}
      >
        {svg}
        <span class="sparkline-expand__icon" aria-hidden="true">⤢</span>
      </button>
      {open && (
        <Portal>
          <div
            class="chart-modal"
            role="dialog"
            aria-label={props.label}
            onClick={(): void => setOpen(false)}
          >
            <div
              class="chart-modal__panel"
              onClick={(e: JSX.TargetedMouseEvent<HTMLDivElement>): void => e.stopPropagation()}
            >
              <header class="chart-modal__head">
                <span class="chart-modal__title">
                  {props.label}
                  <span class="chart-modal__subtitle">{t('Verlauf (zuletzt)', 'History (recent)')}</span>
                </span>
                <button
                  type="button"
                  class="chart-modal__close"
                  aria-label={t('Schließen', 'Close')}
                  onClick={(): void => setOpen(false)}
                >
                  ×
                </button>
              </header>
              <div class="chart-modal__body">
                <LineChart
                  series={[{ label: props.label, color, points }]}
                  unit={props.unit ?? ''}
                  height={420}
                  yTicks={6}
                  xTicks={6}
                />
              </div>
            </div>
          </div>
        </Portal>
      )}
    </div>
  );
}

export function IndoorTemperatureCard(props: {
  snapshot: DashboardSnapshot;
  history?: number[];
}): JSX.Element {
  const { history = [] } = props;
  const rooms = props.snapshot.rooms ?? [];
  const temps = rooms
    .map((r) => r.tempC)
    .filter((t): t is number => t !== null && Number.isFinite(t));
  const avg =
    temps.length > 0
      ? Math.round((temps.reduce((a, b) => a + b, 0) / temps.length) * 10) / 10
      : null;
  const peak = props.snapshot.indoorPeakTempC ?? null;
  const peakText =
    peak !== null && Number.isFinite(peak) ? ` (${t('Peak', 'Peak')}: ${Math.round(peak)} °C)` : '';
  return (
    <section class="kpi-card" data-testid="card-indoor">
      <header class="kpi-card__head">
        <span class="kpi-card__title">{t('Innentemperatur', 'Indoor temperature')}</span>
        <Icon name="haus" size={18} class="kpi-card__icon" />
      </header>
      <div class="kpi-card__value" data-testid="card-indoor-value">
        {avg === null ? DASH : `${avg} °C`}
      </div>
      {history.length >= 2 && (
        <Sparkline values={history} color={INDOOR_COLOR} testId="indoor-sparkline" label={t('Innentemperatur', 'Indoor temperature')} unit="°C" />
      )}
      <p class="kpi-card__hint" data-testid="card-indoor-comfort">
        {comfortLabel(avg)}
        {peakText}
      </p>
    </section>
  );
}

export function OutdoorTemperatureCard(props: {
  snapshot: DashboardSnapshot;
  history?: number[];
}): JSX.Element {
  const { history = [] } = props;
  const out = props.snapshot.signals?.outdoorTemp;
  const v = out?.value ?? null;
  const internet = props.snapshot.outdoorTempInternetC ?? null;
  const forecastMax = props.snapshot.signals?.forecastMaxTemp?.value ?? null;
  const forecastText =
    forecastMax !== null && Number.isFinite(forecastMax)
      ? `${t('Prognose', 'Forecast')}: ${Math.round(forecastMax)} °C`
      : null;
  const hasCompare =
    v !== null && Number.isFinite(v) && internet !== null && Number.isFinite(internet);
  const compareText = hasCompare
    ? `${t('Lokaler Sensor', 'Local sensor')} ${Math.round((v as number) * 10) / 10} °C · ${t('Wetterdienst', 'Weather service')} ${
        Math.round((internet as number) * 10) / 10
      } °C`
    : null;
  return (
    <section
      class="kpi-card"
      data-testid="card-outdoor"
      title={compareText ?? t('Lokaler Sensor bevorzugt; Internet-Wert im Vergleich', 'Local sensor preferred; internet value for comparison')}
    >
      <header class="kpi-card__head">
        <span class="kpi-card__title">{t('Außentemperatur', 'Outdoor temperature')}</span>
        <Icon name="thermometer" size={18} class="kpi-card__icon" />
      </header>
      <div class="kpi-card__value" data-testid="card-outdoor-value">
        {v === null ? DASH : `${formatSignal(v, '°C')}`}
      </div>
      {history.length >= 2 && (
        <Sparkline values={history} color={OUTDOOR_COLOR} testId="outdoor-sparkline" label={t('Außentemperatur', 'Outdoor temperature')} unit="°C" />
      )}
      <p class="kpi-card__hint" data-testid="card-outdoor-compare">
        {compareText !== null
          ? compareText
          : out?.state === 'fresh'
            ? t('aktuell', 'current')
            : t('warte auf Daten', 'waiting for data')}
        {forecastText !== null ? ` (${forecastText})` : ''}
      </p>
    </section>
  );
}

export function SunPositionCard(props: {
  latitude: number;
  longitude: number;
  now?: Date;
}): JSX.Element {
  return (
    <section class="kpi-card kpi-card--sun" data-testid="card-sun">
      <header class="kpi-card__head">
        <span class="kpi-card__title">{t('Sonnenstand', 'Sun position')}</span>
        <Icon name="sonne" size={18} class="kpi-card__icon" />
      </header>
      <div class="kpi-card__sunplot">
        <SunPolarPlot
          latitude={props.latitude}
          longitude={props.longitude}
          {...(props.now !== undefined ? { now: props.now } : {})}
          trajectorySamples={48}
        />
      </div>
    </section>
  );
}

/**
 * Heat-index ring: a 240° arc gauge from 0..10, coloured along a
 * blue→green→yellow→orange→red ramp (Requirement 8.5).
 */
export function HeatIndexCard(props: { value0to10: number | null }): JSX.Element {
  const v = props.value0to10;
  const clamped = v === null ? 0 : Math.max(0, Math.min(10, v));
  // 240° sweep, starting at 150° (lower-left) going clockwise to 30°.
  const startDeg = 150;
  const sweepDeg = 240;
  const frac = clamped / 10;
  const size = 120;
  const cx = size / 2;
  const cy = size / 2;
  const r = 48;
  const polar = (deg: number): { x: number; y: number } => {
    const a = (deg * Math.PI) / 180;
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
  };
  const arcPath = (fromFrac: number, toFrac: number): string => {
    const a0 = startDeg + sweepDeg * fromFrac;
    const a1 = startDeg + sweepDeg * toFrac;
    const p0 = polar(a0);
    const p1 = polar(a1);
    const large = a1 - a0 > 180 ? 1 : 0;
    return `M ${p0.x.toFixed(1)} ${p0.y.toFixed(1)} A ${r} ${r} 0 ${large} 1 ${p1.x.toFixed(1)} ${p1.y.toFixed(1)}`;
  };
  const color = heatColor(frac);
  return (
    <section class="kpi-card kpi-card--heatindex" data-testid="card-heatindex">
      <header class="kpi-card__head">
        <span class="kpi-card__title">{t('Hitze-Index', 'Heat index')}</span>
        <Icon name="flamme" size={18} class="kpi-card__icon" />
      </header>
      <svg
        class="heatindex-ring"
        viewBox={`0 0 ${size} ${size}`}
        data-testid="heatindex-ring"
        role="img"
        aria-label={`${t('Hitze-Index', 'Heat index')} ${v === null ? t('unbekannt', 'unknown') : clamped}`}
      >
        <path
          d={arcPath(0, 1)}
          fill="none"
          stroke="var(--color-card-border)"
          stroke-width={10}
          stroke-linecap="round"
        />
        {v !== null && (
          <path
            d={arcPath(0, frac)}
            fill="none"
            stroke={color}
            stroke-width={10}
            stroke-linecap="round"
            data-testid="heatindex-fill"
          />
        )}
        <text
          x={cx}
          y={cy + 6}
          text-anchor="middle"
          class="heatindex-ring__label"
        >
          {v === null ? DASH : num(Math.round(clamped * 10) / 10)}
        </text>
      </svg>
    </section>
  );
}

/** Blue→green→yellow→orange→red ramp for a fraction in [0,1]. */
function heatColor(frac: number): string {
  const stops = ['#4a8cff', '#66d66b', '#ffd45a', '#ff9d2e', '#ff5d57'];
  const idx = Math.min(stops.length - 1, Math.floor(frac * (stops.length - 1)));
  return stops[idx] ?? '#ff5d57';
}

/** The assembled left rail. */
export function LiveMetricsRail(props: {
  snapshot: DashboardSnapshot;
  latitude: number;
  longitude: number;
  pvHistory?: number[];
  now?: Date;
}): JSX.Element {
  const trends = useTrendSparklines();
  const pvHist = props.pvHistory ?? trends.pv;
  const heatIndex =
    props.snapshot.feelsLike?.effectiveLoad01 !== undefined
      ? Math.round(props.snapshot.feelsLike.effectiveLoad01 * 100) / 10
      : null;
  return (
    <aside class="metrics-rail" data-testid="metrics-rail">
      <SunPositionCard
        latitude={props.latitude}
        longitude={props.longitude}
        {...(props.now !== undefined ? { now: props.now } : {})}
      />
      <PvPowerCard snapshot={props.snapshot} history={pvHist} />
      <IndoorTemperatureCard snapshot={props.snapshot} history={trends.indoor} />
      <OutdoorTemperatureCard snapshot={props.snapshot} history={trends.outdoor} />
      <HeatIndexCard value0to10={heatIndex} />
    </aside>
  );
}
