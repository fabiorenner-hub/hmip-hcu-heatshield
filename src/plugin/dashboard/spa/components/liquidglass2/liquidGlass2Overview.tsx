/**
 * Heat Shield — "Liquid Glass V2" overview page (route `/liquid-glass2`).
 *
 * Content-only page: the shared shell, theme system, appearance configurator
 * and reusable primitives now live under `./shell/*` (ui-v2-release, Task 2),
 * so this file holds ONLY the overview body (hero + weather strip + next
 * actions + house grid + KPIs + expert values) plus its page-specific helpers.
 *
 * All data is read from the live snapshot signal and the shipped pure
 * view-model derivations, so it shows real values and degrades honestly to `–`
 * / a skeleton when a source is missing (family honesty rule: never an invented
 * number).
 */

import { h, Fragment, type JSX } from 'preact';
import { route } from 'preact-router';

import { t, fmtTime, locale } from '../../i18n.js';
import { snapshot, riskBreakdowns } from '../../store.js';
import { expertMode } from '../../expertMode.js';
import { setShutter } from '../../hooks/useControl.js';
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
import { num1, Sparkline, Donut, RefreshGlyph } from './shell/lg2Primitives.js';
import { Lg2AutoLever } from './shell/lg2Shell.js';
import { HouseDigitalTwin } from '../dashboard/houseDigitalTwin.js';
import { useConfig } from '../../hooks/useConfig.js';
import {
  ExpertSection, ExpertMetrics, M, SignalTable, ProvenanceChip, ExpBar,
  RiskBreakdownDetail, fx, pct01, relAge, type SignalRow,
} from './shell/lg2Expert.js';

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
/* Page-specific helpers                                                      */
/* -------------------------------------------------------------------------- */

function ageText(snap: DashboardSnapshot): string {
  const age = dataAgeMinutes(snap.ts);
  if (age === null) return '–';
  if (age < 1) return t('gerade eben', 'just now');
  return t(`vor ${age} min`, `${age} min ago`);
}

/**
 * Room with the HIGHEST expected peak (task 11.1) — consistent with the peak
 * value shown in the hero strip. Uses the normalized heat load (`heatLoad01`,
 * the forecast overheating driver) as the primary ranking, falling back to the
 * current indoor temperature when no load is available. `null` when no room has
 * any usable signal (hero then shows a neutral "heute" hint).
 */
function peakRoom(snap: DashboardSnapshot): { name: string; tempC: number | null } | null {
  const rooms = snap.roomsDetail ?? [];
  if (rooms.length === 0) return null;
  let best: RoomDetail | null = null;
  let bestScore = -Infinity;
  for (const r of rooms) {
    const load = r.heatLoad01;
    const score =
      load !== undefined && Number.isFinite(load)
        ? load * 100
        : (r.indoorTempC ?? -Infinity);
    if (score > bestScore) { bestScore = score; best = r; }
  }
  if (best === null || bestScore === -Infinity) return null;
  return { name: best.name, tempC: best.indoorTempC };
}

/**
 * Forecast reliability (task 11.3) — a computed level, never a fixed text.
 * Primary source is the measured forecast error (± °C); until that exists we
 * derive a provisional confidence from the learning progress (learn days +
 * calibrated rooms) so the badge reflects real state instead of a static
 * placeholder. Honest fallback only when there is truly no signal at all.
 */
function reliability(
  accuracyC: number | null,
  impact: DashboardSnapshot['impact'],
): { label: [string, string]; frac: number; color: string; hint: [string, string] } {
  if (accuracyC !== null) {
    if (accuracyC <= 1.0) return { label: ['Hoch', 'High'], frac: 0.9, color: 'var(--lg2-green)', hint: [`± ${num1(accuracyC)} °C`, `± ${num1(accuracyC)} °C`] };
    if (accuracyC <= 2.0) return { label: ['Mittel', 'Medium'], frac: 0.62, color: 'var(--lg2-orange)', hint: [`± ${num1(accuracyC)} °C`, `± ${num1(accuracyC)} °C`] };
    return { label: ['Niedrig', 'Low'], frac: 0.34, color: 'var(--lg2-red)', hint: [`± ${num1(accuracyC)} °C`, `± ${num1(accuracyC)} °C`] };
  }
  const learnDays = impact?.learnDays ?? 0;
  const calibrated = impact?.calibratedRooms ?? 0;
  if (learnDays > 0 || calibrated > 0) {
    // Provisional confidence ramps with learning progress (target ≈ 10 days).
    const frac = Math.min(0.55, 0.15 + (learnDays / 10) * 0.4 + calibrated * 0.03);
    return {
      label: ['baut auf', 'building'],
      frac,
      color: 'var(--lg2-orange)',
      hint: [`${learnDays} Lerntag(e)`, `${learnDays} learn day(s)`],
    };
  }
  return { label: ['lernt noch', 'learning'], frac: 0.12, color: 'var(--lg2-label-3)', hint: ['Datensammlung', 'collecting data'] };
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

/** Weather-/mode-dependent hero illustration. */
function heroImageFor(snap: DashboardSnapshot): string {
  switch (primaryHeadline(snap).key) {
    case 'storm':
    case 'alert':
      return '/assets/hero/severe-thunderstorm-city.png';
    case 'heat':
      return '/assets/hero/overview-house-heat.png';
    case 'summer':
      return '/assets/hero/overview-house-sun.png';
    case 'night':
      return '/assets/hero/overview-house-normal.png';
    default:
      return '/assets/hero/overview-house-apple.png';
  }
}
function isNightNow(snap: DashboardSnapshot): boolean {
  const el = snap.sun?.elevationDeg;
  if (typeof el === 'number' && Number.isFinite(el)) return el < 0;
  const hr = new Date().getHours();
  return hr < 7 || hr >= 21;
}

/** STORM (or an active storm hold) suspends manual control (safety precedence). */
function isStormActive(snap: DashboardSnapshot): boolean {
  return snap.mode === 'STORM' || snap.storm?.holdUntil != null;
}

/* -------------------------------------------------------------------------- */
/* Body                                                                       */
/* -------------------------------------------------------------------------- */

function Body(props: { snap: DashboardSnapshot }): JSX.Element {
  const { snap } = props;
  const { config } = useConfig();
  const loc = config.value?.location;
  const latitude = loc?.latitude ?? 52.52;
  const longitude = loc?.longitude ?? 13.41;
  const head = primaryHeadline(snap);
  const avoided = avoidedWarmingC(snap);
  const peak = expectedPeakC(snap);
  const warm = peakRoom(snap);
  const accuracy = forecastAccuracyC(snap);
  const rel = reliability(accuracy, snap.impact);
  // Active-mode cell (task 11.2): when the master automation lever is OFF, show
  // a distinct state instead of the (now inactive) automation mode label.
  const automationOff = snap.automationEnabled === false;
  const stormActive = isStormActive(snap);
  // STORM keeps precedence over the master lever (safety); otherwise an OFF
  // lever shows a dedicated state, else the active automation mode.
  const modeLabel = stormActive
    ? (snap.modeInfo?.label ?? t('Sturmschutz', 'Storm protection'))
    : automationOff
      ? t('Automatik aus', 'Automation off')
      : (snap.modeInfo?.label ?? t('Normal', 'Normal'));
  const modeGoal = stormActive
    ? (snap.modeInfo?.goal ?? t('Sicherheitsvorrang', 'Safety precedence'))
    : automationOff
      ? t('Konfigurationsmodus — keine automatischen Fahrten', 'Configuration mode — no automatic moves')
      : (snap.modeInfo?.goal ?? '\u00a0');
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

  const sig = snap.signals;
  const signalRows: SignalRow[] = sig === undefined ? [] : [
    { label: ['Außentemperatur', 'Outdoor temp.'], sig: sig.outdoorTemp, unit: '°C' },
    { label: ['PV-Leistung', 'PV power'], sig: sig.pvPower, unit: 'kW', digits: 2 },
    { label: ['Windgeschwindigkeit', 'Wind speed'], sig: sig.windSpeed, unit: 'm/s' },
    { label: ['Strahlung', 'Radiation'], sig: sig.radiation, unit: 'W/m²', digits: 0 },
    { label: ['Prognose Max', 'Forecast max'], sig: sig.forecastMaxTemp, unit: '°C' },
    { label: ['Bewölkung (Prognose)', 'Cloud (forecast)'], sig: sig.forecastCloudCover, unit: '%', digits: 0 },
  ];

  return (
    <Fragment>
      {/* Header + weather */}
      <header class="lg2-header">
        <div>
          <h1 class="lg2-header__title">{t('Übersicht', 'Overview')}</h1>
          <p class="lg2-header__sub">{t('Dein Zuhause im Blick', 'Your home at a glance')}</p>
        </div>
        <div class="lg2-header__right">
          <Lg2AutoLever />
          <div class="lg2-weather" data-testid="lg2-weather">
            <Icon name="sonne" size={26} class="lg2-weather__icon" />
            <div>
              <div class="lg2-weather__cond">{t(...condition)}</div>
              <div class="lg2-weather__vals">
                {outdoor === null ? '–' : `${num1(outdoor)} °C`}
                {humidity01 !== null && ` · ${Math.round(humidity01 * 100)} % r.F.`}
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* Hero — illustration depends on weather + time of day */}
      <section
        class="lg2-card lg2-hero"
        data-testid="lg2-hero"
        data-tod={isNightNow(snap) ? 'night' : 'day'}
        style={{ '--lg2-hero-img': `url("${heroImageFor(snap)}")` } as JSX.CSSProperties}
      >
        <div class="lg2-hero__top">
          <div class="lg2-hero__photo" aria-hidden="true" />
          <div class="lg2-hero__body">
            <span class="lg2-hero__badge"><Icon name="logo" size={22} /></span>
            <h2 class="lg2-hero__headline">{t(...HEADLINE[head.key])}</h2>
            {avoided !== null ? (
              <p class="lg2-hero__benefit">
                {t('HeatShield verhindert voraussichtlich', 'HeatShield is expected to prevent')}
                <b>{num1(avoided)} °C</b>
                {t('zusätzliche Erwärmung.', 'additional warming.')}
              </p>
            ) : (
              <p class="lg2-hero__lead">
                {t('Der Nutzen wird berechnet, sobald eine Prognose vorliegt.', 'The benefit is computed once a forecast is available.')}
              </p>
            )}
          </div>
        </div>
        <div class="lg2-strip" data-testid="lg2-strip">
          <div class="lg2-strip__cell">
            <span class="lg2-strip__label">{t('Höchste erwartete Raumtemp.', 'Highest expected room temp.')}</span>
            <div class="lg2-strip__main">
              <span class="lg2-strip__value">{peak === null ? '–' : `${num1(peak)} °C`}</span>
              <span style={{ width: '54px', height: '26px' }}>
                <Sparkline values={indoorTrend} color="var(--lg2-blue)" id="peak" />
              </span>
            </div>
            <span class="lg2-strip__hint">{warm !== null ? t(`im ${warm.name}`, `in ${warm.name}`) : t('heute', 'today')}</span>
          </div>
          <div class="lg2-strip__cell">
            <span class="lg2-strip__label">{t('Aktiver Modus', 'Active mode')}</span>
            <span class="lg2-strip__value lg2-strip__value--sm lg2-strip__mode">
              <Icon name={stormActive ? 'warnung' : automationOff ? 'einstellungen' : 'logo'} size={16} /> {modeLabel}
            </span>
            <span class="lg2-strip__hint">{modeGoal}</span>
          </div>
          <div class="lg2-strip__cell">
            <span class="lg2-strip__label">{t('Prognosezuverlässigkeit', 'Forecast reliability')}</span>
            <div class="lg2-strip__main">
              <span class="lg2-strip__value lg2-strip__value--sm">{t(...rel.label)}</span>
              <Donut frac={rel.frac} color={rel.color} />
            </div>
            <span class="lg2-strip__hint">{t(...rel.hint)}</span>
          </div>
          <div class="lg2-strip__cell">
            <span class="lg2-strip__label">{t('Datenstand', 'Data age')}</span>
            <div class="lg2-strip__main">
              <span class="lg2-strip__value lg2-strip__value--sm">{ageText(snap)}</span>
              <span style={{ color: 'var(--lg2-label-3)' }}><RefreshGlyph /></span>
            </div>
            <span class="lg2-strip__hint">
              {snap.sources?.hcu?.connected === false ? t('HCU getrennt', 'HCU offline') : t('HCU verbunden', 'HCU connected')}
            </span>
          </div>
        </div>
      </section>

      {/* Two columns */}
      <div class="lg2-two">
        <section class="lg2-card" data-testid="lg2-actions-card">
          <h3 class="lg2-card__title">{t('Nächste Aktionen', 'Next actions')}</h3>
          {actions.length === 0 ? (
            <p class="lg2-hero__lead">{t('Keine Fahrt geplant.', 'No move planned.')}</p>
          ) : (
            <div class="lg2-actions">
              {actions.map((a) => {
                const meta = actionMeta(a);
                const room = roomNameForWindow(snap, a.windowId);
                const closing = a.targetPercent >= 50;
                return (
                  <div class="lg2-action" key={`${a.windowId}-${a.scheduledTs}`}>
                    <span class="lg2-action__time">
                      {dayLabel(a.scheduledTs, now)}
                      <b>{fmtTime(a.scheduledTs)}</b>
                    </span>
                    <span class="lg2-action__icon"><Icon name={meta.icon} size={18} /></span>
                    <span class="lg2-action__body">
                      <span class="lg2-action__name">{t(...meta.verb)} · {room}</span>
                      <span class="lg2-action__detail">→ {Math.round(a.targetPercent)} %</span>
                    </span>
                    <span class={`lg2-badge${closing ? '' : ' lg2-badge--prep'}`}>
                      {closing ? t('Schutz', 'Protect') : t('Vorbereitet', 'Prepared')}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
          <button type="button" class="lg2-linkrow" onClick={(): void => { route('/automatik'); }} data-testid="lg2-all-actions">
            {t('Alle Aktionen anzeigen', 'Show all actions')}
            <Icon name="forecast" size={16} />
          </button>
        </section>

        <section class="lg2-card" data-testid="lg2-house-card">
          <h3 class="lg2-card__title">{t('Hausübersicht', 'House overview')}</h3>
          {(snap.roomsDetail ?? []).length > 0 ? (
            <HouseDigitalTwin
              variant="chips"
              snapshot={snap}
              latitude={latitude}
              longitude={longitude}
              now={now}
              riskByWindow={riskBreakdowns.value}
            />
          ) : (
            <p class="lg2-rooms-empty">{t('Keine Räume konfiguriert', 'No rooms configured')}</p>
          )}
          <div class="lg2-legend">
            <span><span class="lg2-dot lg2-dot--ok" /> {t('Gering', 'Low')} &lt; 24 °C</span>
            <span><span class="lg2-dot lg2-dot--mid" /> {t('Mittel', 'Medium')} 24–26 °C</span>
            <span><span class="lg2-dot lg2-dot--hot" /> {t('Hoch', 'High')} &gt; 26 °C</span>
          </div>
        </section>
      </div>

      {/* KPI cards */}
      <div class="lg2-kpis" data-testid="lg2-kpis">
        <div class="lg2-card lg2-kpi lg2-card--interactive">
          <div class="lg2-kpi__head">
            <span class="lg2-kpi__label">{t('Vermiedene Erwärmung', 'Avoided warming')}</span>
            <Icon name="forecast" size={18} class="lg2-kpi__icon" />
          </div>
          <span class="lg2-kpi__value lg2-kpi__value--accent">{avoided === null ? '–' : `${num1(avoided)} °C`}</span>
          <span class="lg2-kpi__hint">{t('heute', 'today')}</span>
          <div class="lg2-kpi__spark"><Sparkline values={indoorTrend} color="var(--lg2-blue)" area id="kpi-avoid" /></div>
        </div>

        <div class="lg2-card lg2-kpi lg2-card--interactive">
          <div class="lg2-kpi__head">
            <span class="lg2-kpi__label">{t('Stärkste solare Last', 'Strongest solar load')}</span>
            <Icon name="sonne" size={18} class="lg2-kpi__icon" />
          </div>
          <span class="lg2-kpi__value">{radiationVal === null ? '–' : `${Math.round(radiationVal)} W/m²`}</span>
          <span class="lg2-kpi__hint">
            {solar === null ? t('heute', 'today') : `${t(...FACADE_LABEL[solar.key])}-${t('Fassade', 'facade')} · ${solar.pct} %`}
          </span>
          <div class="lg2-kpi__spark"><Sparkline values={radiationTrend} color="var(--lg2-orange)" area id="kpi-solar" /></div>
        </div>

        <div class="lg2-card lg2-kpi lg2-card--interactive">
          <div class="lg2-kpi__head">
            <span class="lg2-kpi__label">{t('Lüftungsempfehlung', 'Ventilation advice')}</span>
            <Icon name="lueftung" size={18} class="lg2-kpi__icon" />
          </div>
          <span class="lg2-kpi__value lg2-kpi__value--sm">{vent === null ? '–' : t(...VENT_LABEL[vent])}</span>
          <span class="lg2-kpi__hint">{t('für dein Zuhause', 'for your home')}</span>
        </div>

        <div class="lg2-card lg2-kpi lg2-card--interactive">
          <div class="lg2-kpi__head">
            <span class="lg2-kpi__label">{precip !== null ? t('Regen · 2 h', 'Rain · 2 h') : t('Bewölkung', 'Cloud cover')}</span>
            <Icon name="tropfen" size={18} class="lg2-kpi__icon" />
          </div>
          <span class="lg2-kpi__value">
            {precip !== null ? `${num1(precip)} mm` : cloud !== null ? `${cloud} %` : '–'}
          </span>
          <span class="lg2-kpi__hint">{t('Ausblick', 'Outlook')}</span>
        </div>
      </div>

      {/* Expert view: a professional, high-density technical layer — raw values,
          full telemetry with freshness + provenance, energy/PV, façade solar
          loads, the complete per-window risk decomposition and manual control.
          Everything the snapshot carries, surfaced and processed. Expert ⊇ Basic. */}
      {expertMode.value && (
        <Fragment>
          <div class="lg2-card lg2-expert" data-testid="lg2-expert-overview">
            <span class="lg2-expert__title">{t('Expertenwerte', 'Expert values')}</span>
            <div class="lg2-expert__grid">
              <span><b>{outdoor === null ? '–' : `${num1(outdoor)} °C`}</b>{t('Außentemperatur', 'Outdoor temp.')}</span>
              <span title={t('Wetterdienst (OpenMeteo)', 'Weather service (OpenMeteo)')}><b>{snap.outdoorTempInternetC === null || snap.outdoorTempInternetC === undefined ? '–' : `${num1(snap.outdoorTempInternetC)} °C`}</b>{t('Außen (Wetterdienst)', 'Outdoor (service)')}</span>
              <span><b>{humidity01 === null ? '–' : `${Math.round(humidity01 * 100)} %`}</b>{t('Luftfeuchte', 'Humidity')}</span>
              <span><b>{cloud === null ? '–' : `${cloud} %`}</b>{t('Bewölkung', 'Cloud cover')}</span>
              <span><b>{radiationVal === null ? '–' : `${Math.round(radiationVal)} W/m²`}</b>{t('Strahlung', 'Radiation')}</span>
              <span><b>{precip === null ? '–' : `${num1(precip)} mm`}</b>{t('Regen · 2 h', 'Rain · 2 h')}</span>
              <span><b>{peak === null ? '–' : `${num1(peak)} °C`}</b>{t('Peak erwartet', 'Peak expected')}</span>
              <span><b>{accuracy === null ? '–' : `± ${num1(accuracy)} °C`}</b>{t('Prognose-Fehler', 'Forecast error')}</span>
              <span><b>{snap.sun?.elevationDeg === undefined ? '–' : `${Math.round(snap.sun.elevationDeg)}°`}</b>{t('Sonnenhöhe', 'Sun elevation')}</span>
              <span><b>{snap.sun?.azimuthDeg === undefined ? '–' : `${Math.round(snap.sun.azimuthDeg)}°`}</b>{t('Sonnen-Azimut', 'Sun azimuth')}</span>
              <span><b>{snap.feelsLike?.feelsLikeC === null || snap.feelsLike?.feelsLikeC === undefined ? '–' : `${num1(snap.feelsLike.feelsLikeC)} °C`}</b>{t('Gefühlt (PV-geführt)', 'Feels-like (PV-led)')}</span>
              <span><b>{snap.indoorPeakTempC === null || snap.indoorPeakTempC === undefined ? '–' : `${num1(snap.indoorPeakTempC)} °C`}</b>{t('Peak innen heute', 'Indoor peak today')}</span>
            </div>
          </div>

          {/* System health + data sources. */}
          <ExpertSection title={['Systemzustand & Quellen', 'System state & sources']} testId="lg2-expert-system">
            <ExpertMetrics>
              <M v={snap.pluginReadiness ?? '–'} label={['Plugin-Status', 'Plugin status']} />
              <M v={snap.automationEnabled === false ? t('aus', 'off') : t('aktiv', 'active')} label={['Automatik', 'Automation']} />
              <M v={snap.sources?.hcu?.connected ? t('verbunden', 'connected') : t('getrennt', 'offline')} label={['HCU', 'HCU']} />
              <M v={snap.mode ?? '–'} label={['Modus (FSM)', 'Mode (FSM)']} />
              <M v={snap.sources?.fusionSolar?.sourceOk ? t('ok', 'ok') : t('Fehler', 'error')} label={['FusionSolar', 'FusionSolar']} />
              <M v={relAge(snap.sources?.fusionSolar?.lastSuccess)} label={['PV letzter Erfolg', 'PV last success']} />
              <M v={snap.sources?.fusionSolar?.consecutiveFailures ?? 0} label={['PV Fehler in Folge', 'PV consec. failures']} />
              <M v={snap.unreadMessages ?? 0} label={['Ungelesen', 'Unread']} />
              <M v={relAge(snap.ts)} label={['Snapshot-Alter', 'Snapshot age']} />
            </ExpertMetrics>
          </ExpertSection>

          {/* 360° signal telemetry with freshness + age + binding. */}
          {signalRows.length > 0 && (
            <ExpertSection title={['Signale (360°-Telemetrie)', 'Signals (360° telemetry)']} testId="lg2-expert-signals"
              hint={['Werte, Frische und Alter aller global aufgelösten Signale. Rot = veraltet, grau = keine Quelle belegt.',
                'Values, freshness and age of every globally resolved signal. Red = stale, grey = no source bound.']}>
              <SignalTable rows={signalRows} />
            </ExpertSection>
          )}

          {/* Environment with per-value provenance + confidence. */}
          {snap.environment !== undefined && (
            <ExpertSection title={['Umwelt & Herkunft', 'Environment & provenance']} testId="lg2-expert-environment"
              hint={['Jeder Messwert mit Herkunft (gemessen/Prognose/geschätzt) und Konfidenz.',
                'Each value with its origin (measured/forecast/estimated) and confidence.']}>
              <div class="lg2-exp-provlist">
                <div class="lg2-exp-provrow"><span>{t('Strahlung', 'Radiation')}</span><b>{fx(snap.environment.radiationWm2.value, 0)} W/m²</b><ProvenanceChip q={snap.environment.radiationWm2} /></div>
                <div class="lg2-exp-provrow"><span>{t('UV-Index', 'UV index')}</span><b>{fx(snap.environment.uvIndex.value, 1)}</b><ProvenanceChip q={snap.environment.uvIndex} /></div>
                <div class="lg2-exp-provrow"><span>{t('Wind', 'Wind')}</span><b>{fx(snap.environment.windMs.value, 1)} m/s</b><ProvenanceChip q={snap.environment.windMs} /></div>
                <div class="lg2-exp-provrow"><span>{t('Luftfeuchte', 'Humidity')}</span><b>{pct01(snap.environment.humidity01.value)}</b><ProvenanceChip q={snap.environment.humidity01} /></div>
              </div>
            </ExpertSection>
          )}

          {/* Energy / PV. */}
          <ExpertSection title={['Energie & PV', 'Energy & PV']} testId="lg2-expert-energy">
            <ExpertMetrics>
              <M v={pct01(snap.pvSonnenindex01)} label={['Sonnenindex', 'Sun index']} />
              <M v={pct01(snap.pvSelfUse01 ?? snap.impact?.pvSelfUse01)} label={['PV-Eigenverbrauch', 'PV self-use']} />
              <M v={snap.pvTodayKwh === undefined ? '–' : `${fx(snap.pvTodayKwh, 1)} kWh`} label={['PV heute', 'PV today']} />
              <M v={snap.signals?.pvPower?.value == null ? '–' : `${fx(snap.signals.pvPower.value, 2)} kW`} label={['PV-Leistung', 'PV power']} />
              <M v={pct01(snap.feelsLike?.effectiveLoad01)} label={['Effektive Last', 'Effective load']} />
              <M v={snap.trends?.outdoorCph == null ? '–' : `${fx(snap.trends.outdoorCph, 1)} °C/h`} label={['Trend außen', 'Outdoor trend']} />
              <M v={snap.trends?.pvKwph == null ? '–' : `${fx(snap.trends.pvKwph, 2)} kW/h`} label={['Trend PV', 'PV trend']} />
            </ExpertMetrics>
          </ExpertSection>

          {/* Façade solar loads. */}
          {snap.facades !== undefined && (
            <ExpertSection title={['Fassaden-Solarlast', 'Façade solar load']} testId="lg2-expert-facades">
              <div class="lg2-exp-risk__bars">
                <ExpBar label={t('Nord', 'North')} frac={snap.facades.N / 100} value={`${Math.round(snap.facades.N)} %`} />
                <ExpBar label={t('Ost', 'East')} frac={snap.facades.E / 100} value={`${Math.round(snap.facades.E)} %`} />
                <ExpBar label={t('Süd', 'South')} frac={snap.facades.S / 100} value={`${Math.round(snap.facades.S)} %`} />
                <ExpBar label={t('West', 'West')} frac={snap.facades.W / 100} value={`${Math.round(snap.facades.W)} %`} />
              </div>
            </ExpertSection>
          )}

          {/* Complete per-window risk decomposition (factors × weights). */}
          {Object.keys(riskBreakdowns.value).length > 0 && (
            <ExpertSection title={['Risiko je Fenster — vollständige Zerlegung', 'Risk per window — full decomposition']} testId="lg2-expert-risk"
              hint={['Jeder Faktor × Gewicht = Beitrag zum normalisierten Risiko [0,1]; Rohziel → Endziel nach Leitplanken. STORM hat stets Vorrang.',
                'Each factor × weight = contribution to the normalised risk [0,1]; raw → final target after guardrails. STORM always takes precedence.']}>
              <Fragment>
                {Object.values(riskBreakdowns.value).map((b) => (
                  <RiskBreakdownDetail key={b.windowId} b={b} name={roomNameForWindow(snap, b.windowId)} />
                ))}
              </Fragment>
            </ExpertSection>
          )}

          <div class="lg2-card lg2-expert" data-testid="lg2-expert-control">
            <span class="lg2-expert__title">{t('Manuelle Steuerung', 'Manual control')}</span>
            {isStormActive(snap) ? (
              <p class="lg2-hero__lead" data-testid="lg2-expert-control-locked">
                {t('Sturmschutz aktiv — manuelle Steuerung gesperrt (Sicherheitsvorrang).',
                  'Storm protection active — manual control locked (safety precedence).')}
              </p>
            ) : (snap.windows ?? []).length === 0 ? (
              <p class="lg2-hero__lead">{t('Keine Rollläden gefunden.', 'No shutters found.')}</p>
            ) : (
              <div class="lg2-exp-ctl lg2-exp-ctl--compact">
                {(snap.windows ?? []).map((w) => (
                  <div class="lg2-exp-ctl__row" key={w.id}>
                    <span class="lg2-exp-ctl__name">
                      {roomNameForWindow(snap, w.id)}
                      <small>{w.currentLevel01 === null ? '–' : `${Math.round(w.currentLevel01 * 100)} %`}</small>
                    </span>
                    <span class="lg2-exp-ctl__btns">
                      <button type="button" onClick={(): void => { void setShutter(w.id, 0); }}>{t('Auf', 'Open')}</button>
                      <button type="button" onClick={(): void => { void setShutter(w.id, 0.5); }}>50 %</button>
                      <button type="button" onClick={(): void => { void setShutter(w.id, 1); }}>{t('Zu', 'Close')}</button>
                      <button type="button" class="lg2-exp-ctl__cfg" title={t('Gerät konfigurieren (Fensterkontakt zuordnen …)', 'Configure device (assign window contact …)')}
                        aria-label={t('Gerät konfigurieren', 'Configure device')}
                        onClick={(): void => { route('/rooms'); }}>
                        <Icon name="einstellungen" size={15} />
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Fragment>
      )}
    </Fragment>
  );
}

/* -------------------------------------------------------------------------- */
/* Skeleton                                                                   */
/* -------------------------------------------------------------------------- */

function DemoSkeleton(): JSX.Element {
  return (
    <div data-testid="lg2-skeleton" aria-hidden="true" style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div class="lg2-sk" style={{ height: '48px', width: '260px' }} />
      <div class="lg2-sk" style={{ height: '300px' }} />
      <div class="lg2-sk" style={{ height: '260px' }} />
      <div class="lg2-sk" style={{ height: '120px' }} />
    </div>
  );
}

export function LiquidGlass2Overview(_props: RoutableProps): JSX.Element {
  const snap = snapshot.value;
  return (
    <main class="lg2-main" data-testid="liquid-glass2-overview">
      {snap === null ? <DemoSkeleton /> : <Body snap={snap} />}
    </main>
  );
}
