/**
 * Heat Shield — "Liquid Glass" overview (DEMO route `/liquid-glass`).
 *
 * A full-screen, from-scratch reproduction of the approved reference mock in
 * Apple's design language (see `public/liquid-glass.css` for the `.lg-*` token
 * layer). It replicates the reference 1:1 — sidebar · header + weather · hero
 * with photo + metric strip · "next actions" + house twin · 4 KPI cards — only
 * re-skinned in the Apple palette. It does NOT replace the production
 * `/uebersicht`; it is a parallel design-evaluation surface.
 *
 * All data is read from the live snapshot signal and the shipped pure
 * view-model derivations, so the demo shows real values and degrades honestly
 * to `–` / a skeleton when a source is missing (family honesty rule: never an
 * invented number).
 */

import { h, Fragment, type JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { route } from 'preact-router';

import { t, fmtNum, fmtTime, locale } from '../../i18n.js';
import { snapshot } from '../../store.js';
import { Icon, type IconName } from '../icons.js';
import type { DashboardSnapshot, FacadeKey, PlannedAction, RoomDetail, VentAdviceLevel } from '../../types.js';
import {
  avoidedWarmingC,
  cloudPercent,
  dataAgeMinutes,
  expectedPeakC,
  forecastAccuracyC,
  futurePlannedActions,
  precip2hMm,
  primaryHeadline,
  strongestFacade,
  ventilationLevel,
  type HeadlineKey,
} from '../uebersicht/uebersichtModel.js';

interface RoutableProps {
  path?: string;
}

/* -------------------------------------------------------------------------- */
/* Text tables                                                                */
/* -------------------------------------------------------------------------- */

const HEADLINE: Record<HeadlineKey, [string, string]> = {
  storm: ['Dein Zuhause ist im Sturmschutz.', 'Your home is in storm protection.'],
  alert: ['Aktive Unwetterwarnung für dein Zuhause.', 'Active severe-weather warning for your home.'],
  heat: ['Dein Zuhause bleibt heute im Wohlfühlbereich.', 'Your home stays comfortable today.'],
  night: ['Dein Zuhause kühlt mit der Nachtluft aus.', 'Your home is cooling with the night air.'],
  summer: ['Dein Zuhause im Blick — noch kein Hitzestress.', 'Watching your home — no heat stress yet.'],
  calm: ['Dein Zuhause bleibt heute im Wohlfühlbereich.', 'Your home stays comfortable today.'],
};

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

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

function num1(v: number | null): string {
  return v === null || !Number.isFinite(v)
    ? '–'
    : fmtNum(Math.round(v * 10) / 10, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function ageText(snap: DashboardSnapshot): string {
  const age = dataAgeMinutes(snap.ts);
  if (age === null) return '–';
  if (age < 1) return t('gerade eben', 'just now');
  return t(`vor ${age} min`, `${age} min ago`);
}

/** Warmest room by indoor temperature (for the hero peak hint). */
function warmestRoom(snap: DashboardSnapshot): { name: string; tempC: number | null } | null {
  const rooms = snap.roomsDetail ?? [];
  if (rooms.length === 0) return null;
  let best = rooms[0]!;
  for (const r of rooms) {
    if ((r.indoorTempC ?? -Infinity) > (best.indoorTempC ?? -Infinity)) best = r;
  }
  return { name: best.name, tempC: best.indoorTempC };
}

/** Forecast reliability → a level label + donut fraction + colour var. */
function reliability(accuracyC: number | null): { label: [string, string]; frac: number; color: string } {
  if (accuracyC === null) return { label: ['lernt noch', 'learning'], frac: 0.3, color: 'var(--lg-label-3)' };
  if (accuracyC <= 1.0) return { label: ['Hoch', 'High'], frac: 0.9, color: 'var(--lg-green)' };
  if (accuracyC <= 2.0) return { label: ['Mittel', 'Medium'], frac: 0.62, color: 'var(--lg-orange)' };
  return { label: ['Niedrig', 'Low'], frac: 0.34, color: 'var(--lg-red)' };
}

/** Day prefix for a planned-action timestamp. */
function dayLabel(ts: string, now: Date): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayMs = 86400000;
  const diff = Math.floor((d.getTime() - startOfToday) / dayMs);
  if (diff <= 0) return t('Heute', 'Today');
  if (diff === 1) return t('Morgen', 'Tomorrow');
  return d.toLocaleDateString(locale(), { weekday: 'short' });
}

/** Icon + verb for a planned action. */
function actionMeta(a: PlannedAction): { icon: IconName; verb: [string, string] } {
  const closing = a.targetPercent >= 50;
  const hour = new Date(a.scheduledTs).getHours();
  if (!closing && (hour >= 21 || hour < 6)) return { icon: 'klima', verb: ['Nachtkühlung', 'Night cooling'] };
  if (!closing) return { icon: 'lueftung', verb: ['Öffnen / Lüften', 'Open / air'] };
  return { icon: 'sonne', verb: ['Beschatten', 'Shade'] };
}

function roomNameForWindow(snap: DashboardSnapshot, windowId: string): string {
  const rd = (snap.roomsDetail ?? []).find((r) => r.windowId === windowId);
  if (rd !== undefined) return rd.name;
  const w = (snap.windows ?? []).find((x) => x.id === windowId);
  return w?.name ?? t('Fenster', 'Window');
}

/* -------------------------------------------------------------------------- */
/* Inline SVG primitives                                                      */
/* -------------------------------------------------------------------------- */

/** Dependency-free sparkline (line + optional area fill). */
function Sparkline(props: { values: number[]; color: string; area?: boolean; id: string }): JSX.Element | null {
  const vals = props.values.filter((v) => Number.isFinite(v));
  if (vals.length < 2) return null;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const n = vals.length;
  const x = (i: number): number => (i / (n - 1)) * 100;
  const y = (v: number): number => 34 - ((v - min) / span) * 30 - 2;
  let line = '';
  vals.forEach((v, i) => {
    line += `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(v).toFixed(1)} `;
  });
  const areaPath = `${line}L100 36 L0 36 Z`;
  return (
    <svg class="lg-spark" viewBox="0 0 100 36" preserveAspectRatio="none" aria-hidden="true">
      {props.area === true && (
        <Fragment>
          <defs>
            <linearGradient id={`sp-${props.id}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color={props.color} stop-opacity="0.34" />
              <stop offset="100%" stop-color={props.color} stop-opacity="0" />
            </linearGradient>
          </defs>
          <path d={areaPath} fill={`url(#sp-${props.id})`} stroke="none" />
        </Fragment>
      )}
      <path
        d={line.trim()}
        fill="none"
        stroke={props.color}
        stroke-width={2}
        stroke-linejoin="round"
        stroke-linecap="round"
        vector-effect="non-scaling-stroke"
      />
    </svg>
  );
}

/** Small progress donut for the reliability metric. */
function Donut(props: { frac: number; color: string; size?: number }): JSX.Element {
  const size = props.size ?? 40;
  const r = size / 2 - 4;
  const c = 2 * Math.PI * r;
  const dash = Math.max(0, Math.min(1, props.frac)) * c;
  return (
    <svg class="lg-donut" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.12)" stroke-width={4} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={props.color}
        stroke-width={4}
        stroke-linecap="round"
        stroke-dasharray={`${dash.toFixed(1)} ${c.toFixed(1)}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}

/** Refresh glyph (Apple-like circular arrow) — no matching entry in Icon set. */
function RefreshGlyph(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M20 11a8 8 0 1 0-.7 3.3" />
      <path d="M20 5v6h-6" />
    </svg>
  );
}

/** Help glyph — no matching entry in the Icon set. */
function HelpGlyph(): JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9.2a2.5 2.5 0 0 1 4.4 1.6c0 1.7-2.4 2-2.4 3.4" />
      <path d="M12 17.2v.01" />
    </svg>
  );
}

/* -------------------------------------------------------------------------- */
/* House stage — self-contained isometric house + floating room chips         */
/* -------------------------------------------------------------------------- */

/** Heat tone from indoor temperature (matches the legend thresholds). */
function tempTone(tempC: number | null): 'ok' | 'mid' | 'hot' | 'unknown' {
  if (tempC === null || !Number.isFinite(tempC)) return 'unknown';
  if (tempC > 26) return 'hot';
  if (tempC >= 24) return 'mid';
  return 'ok';
}
const TONE_LABEL: Record<'ok' | 'mid' | 'hot' | 'unknown', [string, string]> = {
  ok: ['Gering', 'Low'],
  mid: ['Mittel', 'Medium'],
  hot: ['Hoch', 'High'],
  unknown: ['—', '—'],
};

/** Preset anchor points (%) for floating room chips around the house. */
const ANCHORS: Array<{ left: number; top: number }> = [
  { left: 20, top: 20 },
  { left: 82, top: 15 },
  { left: 10, top: 60 },
  { left: 90, top: 58 },
  { left: 36, top: 84 },
  { left: 68, top: 86 },
];

function HouseStage(props: { rooms: RoomDetail[] }): JSX.Element {
  const rooms = props.rooms.slice(0, ANCHORS.length);
  return (
    <div class="lg-stage" data-testid="lg-house-stage">
      <img class="lg-stage__img" src="/assets/house/house.png" alt="" aria-hidden="true" loading="lazy" />
      <span class="lg-stage__sun" aria-hidden="true"><Icon name="sonne" size={26} /></span>
      {rooms.map((r, i) => {
        const anchor = ANCHORS[i]!;
        const tone = tempTone(r.indoorTempC);
        return (
          <div
            key={r.id}
            class="lg-room-chip"
            style={{ left: `${anchor.left}%`, top: `${anchor.top}%` }}
          >
            <span class="lg-room-chip__temp">{r.indoorTempC === null ? '–' : `${num1(r.indoorTempC)} °C`}</span>
            <span class="lg-room-chip__name">{r.name}</span>
            <span class="lg-room-chip__tone">
              <span class={`lg-dot lg-dot--${tone === 'unknown' ? 'ok' : tone}`} /> {t(...TONE_LABEL[tone])}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Root                                                                       */
/* -------------------------------------------------------------------------- */

export function LiquidGlassOverview(_props: RoutableProps): JSX.Element {
  const [clock, setClock] = useState<Date>(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setClock(new Date()), 20000);
    return (): void => clearInterval(id);
  }, []);

  // Full-bleed: hide the surrounding app chrome while this demo is mounted.
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    document.body.classList.add('lg-demo-open');
    return (): void => document.body.classList.remove('lg-demo-open');
  }, []);

  const snap = snapshot.value;

  return (
    <div class="lg-demo" data-testid="liquid-glass-overview">
      <Sidebar clock={clock} />
      <main class="lg-main">
        {snap === null ? <DemoSkeleton /> : <Body snap={snap} />}
      </main>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Sidebar                                                                    */
/* -------------------------------------------------------------------------- */

function Sidebar(props: { clock: Date }): JSX.Element {
  const nav: Array<{ key: string; icon: IconName; label: [string, string]; href: string; active?: boolean }> = [
    { key: 'home', icon: 'haus', label: ['Übersicht', 'Overview'], href: '/liquid-glass', active: true },
    { key: 'rooms', icon: 'thermometer', label: ['Räume', 'Rooms'], href: '/raeume' },
    { key: 'forecast', icon: 'forecast', label: ['Vorhersage', 'Forecast'], href: '/vorhersage' },
    { key: 'garden', icon: 'tropfen', label: ['Garten', 'Garden'], href: '/garten' },
    { key: 'automation', icon: 'automation', label: ['Automatik', 'Automation'], href: '/automatik' },
  ];
  return (
    <aside class="lg-side" data-testid="lg-sidebar">
      <div class="lg-side__brand">
        <span class="lg-side__logo"><Icon name="logo" size={22} /></span>
        <span>
          <span class="lg-side__brand-name">HeatShield</span>
          <span class="lg-side__brand-sub">{t('HCU Plugin', 'HCU plugin')}</span>
        </span>
      </div>
      <nav class="lg-nav" aria-label={t('Navigation', 'Navigation')}>
        {nav.map((n) => (
          <button
            key={n.key}
            type="button"
            class={`lg-nav__item${n.active ? ' lg-nav__item--active' : ''}`}
            aria-current={n.active ? 'page' : undefined}
            onClick={(): void => {
              if (!n.active) route(n.href);
            }}
          >
            <Icon name={n.icon} size={18} />
            <span>{t(...n.label)}</span>
          </button>
        ))}
      </nav>
      <span class="lg-side__spacer" />
      <div class="lg-side__foot">
        <button type="button" class="lg-nav__item" onClick={(): void => { route('/system'); }}>
          <Icon name="einstellungen" size={18} />
          <span>
            {t('Systemstatus', 'System status')}
            <span style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11.5px', color: 'var(--lg-green)' }}>
              <span class="lg-side__status-dot" /> {t('Online', 'Online')}
            </span>
          </span>
        </button>
        <button type="button" class="lg-nav__item" onClick={(): void => { route('/einstellungen'); }}>
          <Icon name="einstellungen" size={18} />
          <span>{t('Einstellungen', 'Settings')}</span>
        </button>
        <button type="button" class="lg-nav__item" onClick={(): void => { route('/hilfe'); }}>
          <HelpGlyph />
          <span>{t('Hilfe', 'Help')}</span>
        </button>
      </div>
      <div class="lg-side__clock">
        <div class="lg-side__time">{fmtTime(props.clock)}</div>
        <div class="lg-side__date">
          {props.clock.toLocaleDateString(locale(), { day: 'numeric', month: 'long', year: 'numeric' })}
        </div>
      </div>
    </aside>
  );
}

/* -------------------------------------------------------------------------- */
/* Body                                                                       */
/* -------------------------------------------------------------------------- */

function Body(props: { snap: DashboardSnapshot }): JSX.Element {
  const { snap } = props;
  const head = primaryHeadline(snap);
  const avoided = avoidedWarmingC(snap);
  const peak = expectedPeakC(snap);
  const warm = warmestRoom(snap);
  const accuracy = forecastAccuracyC(snap);
  const rel = reliability(accuracy);
  const modeLabel = snap.modeInfo?.label ?? t('Normal', 'Normal');
  const now = new Date();

  const outdoor = snap.signals?.outdoorTemp?.value ?? null;
  const humidity01 = snap.environment?.humidity01?.value ?? null;
  const cloud = cloudPercent(snap);
  const condition: [string, string] =
    cloud === null ? ['–', '–'] : cloud < 25 ? ['Klarer Himmel', 'Clear sky'] : cloud < 70 ? ['Leicht bewölkt', 'Partly cloudy'] : ['Bewölkt', 'Cloudy'];

  const indoorTrend = (snap.trajectories?.indoorForecastWithShade ?? []).map((p) => p.tempC);
  const radiationTrend = (snap.forecastTimeline ?? []).map((c) => c.radiationWm2);

  const solar = strongestFacade(snap);
  const radiationVal = snap.signals?.radiation?.value ?? null;
  const vent = ventilationLevel(snap);
  const precip = precip2hMm(snap);

  const actions = futurePlannedActions(snap, now).slice(0, 3);

  return (
    <Fragment>
      {/* Header + weather */}
      <header class="lg-header">
        <div>
          <h1 class="lg-header__title">{t('Übersicht', 'Overview')}</h1>
          <p class="lg-header__sub">{t('Dein Zuhause im Blick', 'Your home at a glance')}</p>
        </div>
        <div class="lg-weather" data-testid="lg-weather">
          <Icon name="sonne" size={26} class="lg-weather__icon" />
          <div>
            <div class="lg-weather__cond">{t(...condition)}</div>
            <div class="lg-weather__vals">
              {outdoor === null ? '–' : `${num1(outdoor)} °C`}
              {humidity01 !== null && ` · ${Math.round(humidity01 * 100)} % r.F.`}
            </div>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section class="lg-card lg-hero" data-testid="lg-hero">
        <div class="lg-hero__top">
          <div class="lg-hero__photo" aria-hidden="true" />
          <div class="lg-hero__body">
            <span class="lg-hero__badge"><Icon name="logo" size={22} /></span>
            <h2 class="lg-hero__headline">{t(...HEADLINE[head.key])}</h2>
            {avoided !== null ? (
              <p class="lg-hero__benefit">
                {t('HeatShield verhindert voraussichtlich', 'HeatShield is expected to prevent')}
                <b>{num1(avoided)} °C</b>
                {t('zusätzliche Erwärmung.', 'additional warming.')}
              </p>
            ) : (
              <p class="lg-hero__lead">
                {t('Der Nutzen wird berechnet, sobald eine Prognose vorliegt.', 'The benefit is computed once a forecast is available.')}
              </p>
            )}
          </div>
        </div>
        <div class="lg-strip" data-testid="lg-strip">
          <div class="lg-strip__cell">
            <span class="lg-strip__label">{t('Höchste erwartete Raumtemp.', 'Highest expected room temp.')}</span>
            <div class="lg-strip__main">
              <span class="lg-strip__value">{peak === null ? '–' : `${num1(peak)} °C`}</span>
              <span style={{ width: '54px', height: '26px' }}>
                <Sparkline values={indoorTrend} color="var(--lg-blue)" id="peak" />
              </span>
            </div>
            <span class="lg-strip__hint">{warm !== null ? t(`im ${warm.name}`, `in ${warm.name}`) : t('heute', 'today')}</span>
          </div>
          <div class="lg-strip__cell">
            <span class="lg-strip__label">{t('Aktiver Modus', 'Active mode')}</span>
            <span class="lg-strip__value lg-strip__value--sm lg-strip__mode">
              <Icon name="logo" size={16} /> {modeLabel}
            </span>
            <span class="lg-strip__hint">{snap.modeInfo?.goal ?? '\u00a0'}</span>
          </div>
          <div class="lg-strip__cell">
            <span class="lg-strip__label">{t('Prognosezuverlässigkeit', 'Forecast reliability')}</span>
            <div class="lg-strip__main">
              <span class="lg-strip__value lg-strip__value--sm">{t(...rel.label)}</span>
              <Donut frac={rel.frac} color={rel.color} />
            </div>
            <span class="lg-strip__hint">{accuracy === null ? '\u00a0' : `± ${num1(accuracy)} °C`}</span>
          </div>
          <div class="lg-strip__cell">
            <span class="lg-strip__label">{t('Datenstand', 'Data age')}</span>
            <div class="lg-strip__main">
              <span class="lg-strip__value lg-strip__value--sm">{ageText(snap)}</span>
              <span style={{ color: 'var(--lg-label-3)' }}><RefreshGlyph /></span>
            </div>
            <span class="lg-strip__hint">
              {snap.sources?.hcu?.connected === false ? t('HCU getrennt', 'HCU offline') : t('HCU verbunden', 'HCU connected')}
            </span>
          </div>
        </div>
      </section>

      {/* Two columns */}
      <div class="lg-two">
        <section class="lg-card" data-testid="lg-actions-card">
          <h3 class="lg-card__title">{t('Nächste Aktionen', 'Next actions')}</h3>
          {actions.length === 0 ? (
            <p class="lg-hero__lead">{t('Keine Fahrt geplant.', 'No move planned.')}</p>
          ) : (
            <div class="lg-actions">
              {actions.map((a) => {
                const meta = actionMeta(a);
                const room = roomNameForWindow(snap, a.windowId);
                const closing = a.targetPercent >= 50;
                return (
                  <div class="lg-action" key={`${a.windowId}-${a.scheduledTs}`}>
                    <span class="lg-action__time">
                      {dayLabel(a.scheduledTs, now)}
                      <b>{fmtTime(a.scheduledTs)}</b>
                    </span>
                    <span class="lg-action__icon"><Icon name={meta.icon} size={18} /></span>
                    <span class="lg-action__body">
                      <span class="lg-action__name">{t(...meta.verb)} · {room}</span>
                      <span class="lg-action__detail">→ {Math.round(a.targetPercent)} %</span>
                    </span>
                    <span class={`lg-badge${closing ? '' : ' lg-badge--prep'}`}>
                      {closing ? t('Schutz', 'Protect') : t('Vorbereitet', 'Prepared')}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
          <button type="button" class="lg-linkrow" onClick={(): void => { route('/automatik'); }} data-testid="lg-all-actions">
            {t('Alle Aktionen anzeigen', 'Show all actions')}
            <Icon name="forecast" size={16} />
          </button>
        </section>

        <section class="lg-card" data-testid="lg-house-card">
          <h3 class="lg-card__title">{t('Hausübersicht', 'House overview')}</h3>
          {(snap.roomsDetail ?? []).length > 0 ? (
            <HouseStage rooms={snap.roomsDetail ?? []} />
          ) : (
            <p class="lg-hero__lead">{t('Noch keine Räume eingerichtet.', 'No rooms configured yet.')}</p>
          )}
          <div class="lg-legend">
            <span><span class="lg-dot lg-dot--ok" /> {t('Gering', 'Low')} &lt; 24 °C</span>
            <span><span class="lg-dot lg-dot--mid" /> {t('Mittel', 'Medium')} 24–26 °C</span>
            <span><span class="lg-dot lg-dot--hot" /> {t('Hoch', 'High')} &gt; 26 °C</span>
          </div>
        </section>
      </div>

      {/* KPI cards */}
      <div class="lg-kpis" data-testid="lg-kpis">
        <div class="lg-card lg-kpi lg-card--interactive">
          <div class="lg-kpi__head">
            <span class="lg-kpi__label">{t('Vermiedene Erwärmung', 'Avoided warming')}</span>
            <Icon name="forecast" size={18} class="lg-kpi__icon" />
          </div>
          <span class="lg-kpi__value lg-kpi__value--accent">{avoided === null ? '–' : `${num1(avoided)} °C`}</span>
          <span class="lg-kpi__hint">{t('heute', 'today')}</span>
          <div class="lg-kpi__spark"><Sparkline values={indoorTrend} color="var(--lg-blue)" area id="kpi-avoid" /></div>
        </div>

        <div class="lg-card lg-kpi lg-card--interactive">
          <div class="lg-kpi__head">
            <span class="lg-kpi__label">{t('Stärkste solare Last', 'Strongest solar load')}</span>
            <Icon name="sonne" size={18} class="lg-kpi__icon" />
          </div>
          <span class="lg-kpi__value">{radiationVal === null ? '–' : `${Math.round(radiationVal)} W/m²`}</span>
          <span class="lg-kpi__hint">
            {solar === null ? t('heute', 'today') : `${t(...FACADE_LABEL[solar.key])}-${t('Fassade', 'facade')} · ${solar.pct} %`}
          </span>
          <div class="lg-kpi__spark"><Sparkline values={radiationTrend} color="var(--lg-orange)" area id="kpi-solar" /></div>
        </div>

        <div class="lg-card lg-kpi lg-card--interactive">
          <div class="lg-kpi__head">
            <span class="lg-kpi__label">{t('Lüftungsempfehlung', 'Ventilation advice')}</span>
            <Icon name="lueftung" size={18} class="lg-kpi__icon" />
          </div>
          <span class="lg-kpi__value lg-kpi__value--sm">{vent === null ? '–' : t(...VENT_LABEL[vent])}</span>
          <span class="lg-kpi__hint">{t('für dein Zuhause', 'for your home')}</span>
        </div>

        <div class="lg-card lg-kpi lg-card--interactive">
          <div class="lg-kpi__head">
            <span class="lg-kpi__label">{precip !== null ? t('Regen · 2 h', 'Rain · 2 h') : t('Bewölkung', 'Cloud cover')}</span>
            <Icon name="tropfen" size={18} class="lg-kpi__icon" />
          </div>
          <span class="lg-kpi__value">
            {precip !== null ? `${num1(precip)} mm` : cloud !== null ? `${cloud} %` : '–'}
          </span>
          <span class="lg-kpi__hint">{t('Ausblick', 'Outlook')}</span>
        </div>
      </div>
    </Fragment>
  );
}

/* -------------------------------------------------------------------------- */
/* Skeleton                                                                   */
/* -------------------------------------------------------------------------- */

function DemoSkeleton(): JSX.Element {
  return (
    <div data-testid="lg-skeleton" aria-hidden="true" style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div class="lg-sk" style={{ height: '48px', width: '260px' }} />
      <div class="lg-sk" style={{ height: '300px' }} />
      <div class="lg-sk" style={{ height: '260px' }} />
      <div class="lg-sk" style={{ height: '120px' }} />
    </div>
  );
}
