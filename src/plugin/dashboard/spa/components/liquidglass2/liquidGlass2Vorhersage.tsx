/**
 * Heat Shield — "Liquid Glass V2" Vorhersage page (DEMO `/liquid-glass-vorhersage`).
 *
 * A dense forecast timeline matching the approved mock: a risk banner plus a
 * "Prognoseverlauf" grid whose rows are metrics (weather/outdoor temp, solar
 * radiation, PV yield, room temp, shutters, ventilation, precipitation) and
 * whose columns are time slots grouped by day, with the overheating-risk window
 * highlighted and amber/green/blue trend curves over the relevant rows.
 *
 * All values come from the live snapshot (forecastTimeline, trajectories, per
 * room shutterForecast, precipNowcast, ventilation) — honest `–` where a source
 * is missing; ventilation mode is a transparent heuristic label, not a claim of
 * measured data.
 */

import { h, Fragment, type JSX } from 'preact';
import { useState } from 'preact/hooks';
import { route } from 'preact-router';

import { t, fmtNum, fmtTime } from '../../i18n.js';
import { snapshot } from '../../store.js';
import { expertMode } from '../../expertMode.js';
import { useConfig } from '../../hooks/useConfig.js';
import { Icon } from '../icons.js';
import { SunPolarPlot, getSunPosition } from '../sunPolarPlot.js';
import { RadarMap } from '../dashboard/radarMap.js';
import { WeatherCharts } from '../dashboard/weatherCharts.js';
import { WindRose } from '../dashboard/windRose.js';
import { WindOutlook } from '../dashboard/windOutlook.js';
import { ExpertSection, hms, fx } from './shell/lg2Expert.js';
import { RoomPlan24h } from './roomPlan24h.js';
import type { DashboardSnapshot, ForecastTimelineCard, RoomDetail } from '../../types.js';

interface RoutableProps { path?: string }
type Horizon = 12 | 24 | 48;

function n1(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v)
    ? '–'
    : fmtNum(Math.round(v * 10) / 10, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}
function ms(ts: string): number { return Date.parse(ts); }
/** Coarse 8-point compass label (DE uses O for East). */
function compass8(deg: number): string {
  const dirs = ['N', 'NO', 'O', 'SO', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round((((deg % 360) + 360) % 360) / 45) % 8]!;
}
/** Which facade the sun is on at `tsMs` (compass label), or null when it is down/low. */
function sunFacade(tsMs: number, lat: number, lon: number): string | null {
  const s = getSunPosition(new Date(tsMs), lat, lon);
  if (!Number.isFinite(s.elevationDeg) || s.elevationDeg < 5) return null;
  return compass8(s.azimuthDeg);
}
/** Nearest sample value to a target timestamp within a tolerance (±90 min). */
function nearest<T extends { ts: string }>(arr: T[] | undefined, target: number): T | null {
  if (arr === undefined || arr.length === 0) return null;
  let best: T | null = null; let bestD = Infinity;
  for (const s of arr) {
    const d = Math.abs(ms(s.ts) - target);
    if (d < bestD) { bestD = d; best = s; }
  }
  return best !== null && bestD <= 90 * 60000 ? best : null;
}

/* -------------------------------------------------------------------------- */
/* Weather glyph                                                              */
/* -------------------------------------------------------------------------- */

function WeatherGlyph(props: { code: string; size?: number }): JSX.Element {
  const s = props.size ?? 22;
  const c = props.code.toLowerCase();
  const kind =
    /storm|thunder|gewitter/.test(c) ? 'storm'
      : /snow|schnee/.test(c) ? 'rain'
        : /rain|drizzle|shower|regen/.test(c) ? 'rain'
          : /overcast|cloud|bedeckt|bewölk/.test(c) ? 'cloud'
            : /part|few|wolk/.test(c) ? 'partly'
              : 'sun';
  const cloud = <path d="M7 18h9a3.5 3.5 0 0 0 .2-7A5 5 0 0 0 7 10a4 4 0 0 0 0 8z" />;
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      {kind === 'sun' && <Fragment><circle cx="12" cy="12" r="4.2" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4" /></Fragment>}
      {kind === 'partly' && <Fragment><circle cx="8" cy="8" r="3.2" /><path d="M8 2.5v1.6M2.5 8h1.6M4.4 4.4l1.1 1.1" />{cloud}</Fragment>}
      {kind === 'cloud' && cloud}
      {kind === 'rain' && <Fragment>{cloud}<path d="M9 20l-1 2M13 20l-1 2M17 20l-1 2" /></Fragment>}
      {kind === 'storm' && <Fragment>{cloud}<path d="M12 19l-2 3h3l-2 3" /></Fragment>}
    </svg>
  );
}

/* -------------------------------------------------------------------------- */
/* Root                                                                       */
/* -------------------------------------------------------------------------- */

export function LiquidGlass2Vorhersage(_props: RoutableProps): JSX.Element {
  const snap = snapshot.value;
  return (
    <main class="lg2-main lg2-fc" data-testid="liquid-glass2-vorhersage">
      {snap === null ? <FcSkeleton /> : <FcBody snap={snap} />}
    </main>
  );
}

interface Col {
  ts: string; hour: number; label: string; day: number; dayLabel: [string, string];
  card: ForecastTimelineCard; indoor: number | null; indoorNoShade: number | null; heatLoad: number | null;
  shutter: number | null; risk: boolean;
}

function FcBody(props: { snap: DashboardSnapshot }): JSX.Element {
  const { snap } = props;
  const { config } = useConfig();
  const lat = config.value?.location?.latitude ?? 52.52;
  const lon = config.value?.location?.longitude ?? 13.41;
  const [horizon, setHorizon] = useState<Horizon>(24);
  const [compact, setCompact] = useState(false);
  const rooms = snap.roomsDetail ?? [];
  const [roomId, setRoomId] = useState<string>('all');

  const cols = buildColumns(snap, horizon, roomId);
  const riskWin = riskWindow(cols);

  // Honest coverage: how many hours the forecast timeline actually reaches.
  const tl = (snap.forecastTimeline ?? []).slice().sort((a, b) => ms(a.ts) - ms(b.ts));
  const lastTs = tl.length > 0 ? ms(tl[tl.length - 1]!.ts) : null;
  const coverageH = lastTs === null ? 0 : Math.max(0, Math.round((lastTs - Date.now()) / 3600_000));
  const shortCoverage = coverageH > 0 && coverageH < horizon - 1;

  const dayGroups: Array<{ label: [string, string]; span: number }> = [];
  for (const col of cols) {
    const last = dayGroups[dayGroups.length - 1];
    if (last !== undefined && last.label[0] === col.dayLabel[0]) last.span += 1;
    else dayGroups.push({ label: col.dayLabel, span: 1 });
  }

  return (
    <Fragment>
      <header class="lg2-header">
        <div>
          <h1 class="lg2-header__title">{t('Vorhersage', 'Forecast')}</h1>
          <p class="lg2-header__sub">{t('Prognose für Haus & Garten', 'Forecast for home & garden')}</p>
        </div>
        <div class="lg2-fc__controls">
          <label class="lg2-fc__ctl">
            <span>{t('Zeithorizont', 'Time horizon')}</span>
            <div class="lg2-seg" role="tablist">
              {([12, 24, 48] as Horizon[]).map((hz) => (
                <button key={hz} type="button" role="tab" aria-selected={horizon === hz}
                  class={`lg2-seg__btn${horizon === hz ? ' lg2-seg__btn--on' : ''}`}
                  onClick={(): void => setHorizon(hz)}>{hz}h</button>
              ))}
            </div>
          </label>
          <label class="lg2-fc__ctl">
            <span>{t('Darstellung', 'View')}</span>
            <select class="lg2-cfg__select" value={compact ? 'compact' : 'standard'}
              onChange={(e): void => setCompact((e.currentTarget as HTMLSelectElement).value === 'compact')}>
              <option value="standard">{t('Standard', 'Standard')}</option>
              <option value="compact">{t('Kompakt', 'Compact')}</option>
            </select>
          </label>
          <label class="lg2-fc__ctl">
            <span>{t('Raum', 'Room')}</span>
            <select class="lg2-cfg__select" value={roomId}
              onChange={(e): void => setRoomId((e.currentTarget as HTMLSelectElement).value)}>
              <option value="all">{t('Alle Räume', 'All rooms')}</option>
              {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </label>
        </div>
      </header>

      <RiskBanner snap={snap} riskWin={riskWin} cols={cols} />

      <RoomPlan24h snap={snap} />

      {shortCoverage && (
        <p class="lg2-fc__coverage" data-testid="lg2-fc-coverage">
          {t(`Prognose reicht aktuell ${coverageH} h voraus — der ${horizon}-h-Horizont zeigt alle verfügbaren Daten.`,
            `Forecast currently reaches ${coverageH} h ahead — the ${horizon} h horizon shows all available data.`)}
        </p>
      )}

      {cols.length === 0 ? (
        <div class="lg2-card lg2-fc__empty">{t('Noch keine Prognosedaten verfügbar.', 'No forecast data yet.')}</div>
      ) : (
        <div class={`lg2-card lg2-fc__grid${compact ? ' lg2-fc__grid--compact' : ''}`}
          style={{ '--fc-cols': cols.length } as JSX.CSSProperties} data-testid="lg2-forecast-grid">
          {/* Day group + hour header */}
          <div class="lg2-fc__rowhead lg2-fc__rowhead--top">{t('Prognoseverlauf', 'Forecast timeline')}</div>
          <div class="lg2-fc__days">
            {dayGroups.map((g, i) => (
              <div key={i} class="lg2-fc__day" style={{ gridColumn: `span ${g.span}` }}>{t(...g.label)}</div>
            ))}
          </div>
          <div class="lg2-fc__rowhead" />
          <div class="lg2-fc__hours">
            {cols.map((c) => (
              <div key={c.ts} class={`lg2-fc__hour${c.risk ? ' lg2-fc__hour--risk' : ''}`}>
                {c.risk && <span class="lg2-fc__riskflag">{t('Erhöhtes Risiko', 'Elevated risk')} ⚠</span>}
                {c.label}
              </div>
            ))}
          </div>

          <Row icon={<WeatherGlyph code="sun" size={20} />} name={['Wetter', 'Weather']} sub={['Außentemperatur °C', 'Outdoor temp °C']}
            cols={cols}
            cell={(c) => <Fragment><WeatherGlyph code={c.card.weatherIcon} size={20} /><b>{n1(c.card.tempC)}°</b></Fragment>} />

          <Row icon={<Icon name="sonne" size={18} />} name={['Solarstrahlung', 'Solar radiation']} sub={['W/m²', 'W/m²']}
            cols={cols} curve={{ pick: (c) => c.card.radiationWm2, color: '#ff9f0a' }}
            cell={(c) => <b>{Math.round(c.card.radiationWm2)}</b>} />

          <Row icon={<Icon name="sonne" size={18} />} name={['Sonne auf Fassade', 'Sun on facade']} sub={['Himmelsrichtung', 'Direction']}
            cols={cols}
            cell={(c) => { const f = sunFacade(ms(c.ts), lat, lon); return f === null ? <b class="lg2-fc__facade lg2-fc__facade--none">–</b> : <b class="lg2-fc__facade">{f}</b>; }} />

          <Row icon={<Icon name="automation" size={18} />} name={['PV-Erzeugung', 'PV yield']} sub={['Nowcast · kW', 'Nowcast · kW']}
            cols={cols} curve={{ pick: (c) => c.card.pvForecastKw ?? null, color: '#30d158' }}
            cell={(c) => <b>{n1(c.card.pvForecastKw)}</b>} />

          <Row icon={<Icon name="thermometer" size={18} />} name={['Raumtemperatur', 'Room temp']} sub={['°C · Wohnen', '°C · living']}
            cols={cols} curve={{ pick: (c) => c.indoor, color: '#4a8cff' }}
            cell={(c) => <b class={c.risk ? 'lg2-fc__hot' : ''}>{n1(c.indoor)}°</b>} />

          <Row icon={<Icon name="beschattung" size={18} />} name={['Rollläden', 'Shutters']} sub={['Position', 'Position']}
            cols={cols}
            cell={(c) => <ShutterCell pct={c.shutter} risk={c.risk} />} />

          <Row icon={<Icon name="tropfen" size={18} />} name={['Lüftung', 'Ventilation']} sub={['Betriebsmodus', 'Mode']}
            cols={cols}
            cell={(c) => { const m = ventMode(c); return <span class="lg2-fc__vent" style={{ color: m.color }}><Icon name="tropfen" size={16} /><em>{t(...m.label)}</em></span>; }} />

          <Row icon={<Icon name="forecast" size={18} />} name={['Regen', 'Rain']} sub={['Niederschlag / Bewölkung', 'Precip / cloud']}
            cols={cols}
            cell={(c) => { const p = Math.round(c.card.precipitationOrCloud01 * 100); return <Fragment><WeatherGlyph code={p >= 55 ? 'rain' : 'cloud'} size={18} /><b>{p} %</b></Fragment>; }} />

          {/* Expert-only rows: shade benefit + heat load. */}
          {expertMode.value && (
            <Fragment>
              <Row icon={<Icon name="thermometer" size={18} />} name={['Ohne Beschattung', 'Without shading']} sub={['°C · Prognose', '°C · forecast']}
                cols={cols} curve={{ pick: (c) => c.indoorNoShade, color: '#ff5d57' }}
                cell={(c) => <b>{n1(c.indoorNoShade)}°</b>} />
              <Row icon={<Icon name="beschattung" size={18} />} name={['Wärmelast', 'Heat load']} sub={['%', '%']}
                cols={cols} curve={{ pick: (c) => (c.heatLoad === null ? null : c.heatLoad * 100), color: '#ff9f0a' }}
                cell={(c) => <b>{c.heatLoad === null ? '–' : `${Math.round(c.heatLoad * 100)} %`}</b>} />
            </Fragment>
          )}
        </div>
      )}

      {expertMode.value && <FcExpert snap={snap} />}

      <div class="lg2-fc__foot">
        <div class="lg2-fc__legend">
          <span><WeatherGlyph code="sun" size={15} /> {t('Wetter', 'Weather')}</span>
          <span><i class="lg2-fc__swatch" style={{ background: '#ff9f0a' }} /> {t('Solar', 'Solar')}</span>
          <span><i class="lg2-fc__swatch" style={{ background: '#30d158' }} /> {t('PV', 'PV')}</span>
          <span><i class="lg2-fc__swatch" style={{ background: '#4a8cff' }} /> {t('Raumtemp.', 'Room temp')}</span>
          <span><i class="lg2-fc__swatch lg2-fc__swatch--risk" /> {t('Risiko-Fenster', 'Risk window')}</span>
        </div>
        <span class="lg2-fc__updated">{t('Letzte Aktualisierung', 'Last update')}: {fmtTime(new Date())}</span>
      </div>
    </Fragment>
  );
}

/* -------------------------------------------------------------------------- */
/* Expert panel: forecast quality + sun path                                  */
/* -------------------------------------------------------------------------- */

function FcExpert(props: { snap: DashboardSnapshot }): JSX.Element {
  const { snap } = props;
  const { config } = useConfig();
  const loc = config.value?.location;
  const lat = loc?.latitude ?? 52.52;
  const lon = loc?.longitude ?? 13.41;
  const im = snap.impact;
  const acc = im?.forecastAccuracyC ?? null;
  return (
    <Fragment>
      <div class="lg2-card lg2-expert" data-testid="lg2-expert-forecast-quality">
        <span class="lg2-expert__title">{t('Prognosegüte & Kalibrierung', 'Forecast quality & calibration')}</span>
        <div class="lg2-expert__grid">
          <span><b>{acc === null ? '–' : `± ${n1(acc)} °C`}</b>{t('Prognose-Fehler', 'Forecast error')}</span>
          <span><b>{im?.learnDays ?? '–'}</b>{t('Lerntage', 'Learn days')}</span>
          <span><b>{im?.calibratedRooms ?? '–'}</b>{t('Kalibrierte Räume', 'Calibrated rooms')}</span>
          <span><b>{im?.tunedRooms ?? '–'}</b>{t('Getunte Räume', 'Tuned rooms')}</span>
          <span><b>{im?.comfortShareToday01 == null ? '–' : `${Math.round(im.comfortShareToday01 * 100)} %`}</b>{t('Komfortanteil heute', 'Comfort share today')}</span>
          <span><b>{im?.avgMovesPerDay == null ? '–' : n1(im.avgMovesPerDay)}</b>{t('Ø Fahrten/Tag', 'Avg moves/day')}</span>
        </div>
        <p class="lg2-settings__hint">
          {t('PV-Lobe-Faktor (Azimut 90–200°, 8.8 kWp SO) — geplant.', 'PV-lobe factor (azimuth 90–200°, 8.8 kWp SE) — planned.')}
        </p>
      </div>

      <div class="lg2-card lg2-expert" data-testid="lg2-expert-sunpath">
        <span class="lg2-expert__title">{t('Sonnenlauf (heute)', 'Sun path (today)')}</span>
        <div class="lg2-expert__sun">
          <SunPolarPlot latitude={lat} longitude={lon} />
        </div>
      </div>

      {/* Task 11.11 — proven high-resolution rain radar (reused v1 component). */}
      <div class="lg2-card lg2-expert" data-testid="lg2-expert-radar">
        <span class="lg2-expert__title">{t('Regenradar', 'Rain radar')}</span>
        <div class="lg2-expert__radar">
          <RadarMap latitude={lat} longitude={lon} />
        </div>
      </div>

      {/* Wind rose + outlook (v1 parity). */}
      <div class="lg2-card lg2-expert" data-testid="lg2-expert-wind">
        <span class="lg2-expert__title">{t('Wind', 'Wind')}</span>
        <div class="lg2-expert__wind">
          <WindRose latitude={lat} longitude={lon} />
          <WindOutlook latitude={lat} longitude={lon} />
        </div>
      </div>

      {/* Task 11.20 — full "Wettervorhersage · Diagramme" chart grid (reused). */}
      <div class="lg2-card lg2-expert" data-testid="lg2-expert-weathercharts">
        <WeatherCharts latitude={lat} longitude={lon} />
      </div>

      <TrajectoryTable snap={snap} />
      <NowcastTable snap={snap} />
    </Fragment>
  );
}

/** Numeric indoor-trajectory table: with/without shading, Δ and heat load. */
function TrajectoryTable(props: { snap: DashboardSnapshot }): JSX.Element | null {
  const tr = props.snap.trajectories;
  if (tr === undefined || tr.indoorForecastWithShade.length === 0) return null;
  const withArr = tr.indoorForecastWithShade;
  const noArr = tr.indoorForecastNoShade;
  const heatArr = tr.heatLoadForecast;
  const rows = withArr.slice(0, 14).map((p, i) => {
    const no = noArr[i]?.tempC ?? null;
    const heat = heatArr[i]?.load01 ?? null;
    const delta = no !== null ? Math.max(0, no - p.tempC) : null;
    return { ts: p.ts, withC: p.tempC, noC: no, delta, heat };
  });
  return (
    <ExpertSection title={['Innenraum-Trajektorien (numerisch)', 'Indoor trajectories (numeric)']} testId="lg2-expert-trajectory"
      hint={['Prognose mit vs. ohne Beschattung, Schutzwirkung (Δ) und Wärmelast je Stunde.',
        'Forecast with vs. without shading, protective effect (Δ) and heat load per hour.']}>
      <div class="lg2-exp-sigtable">
        <div class="lg2-exp-sigtable__head lg2-exp-traj__head">
          <span>{t('Zeit', 'Time')}</span><span>{t('mit', 'with')}</span><span>{t('ohne', 'without')}</span><span>Δ</span><span>{t('Last', 'Load')}</span>
        </div>
        {rows.map((r) => (
          <div class="lg2-exp-sigtable__row lg2-exp-traj__row" key={r.ts}>
            <span class="lg2-exp-sigtable__name">{hms(r.ts)}</span>
            <span class="lg2-exp-sigtable__val">{fx(r.withC)} °C</span>
            <span class="lg2-exp-sigtable__val">{fx(r.noC)} °C</span>
            <span class="lg2-exp-sigtable__val" style={{ color: r.delta !== null && r.delta > 0 ? 'var(--lg2-green)' : 'inherit' }}>{r.delta === null ? '–' : `−${fx(r.delta)}`}</span>
            <span class="lg2-exp-sigtable__val">{r.heat === null ? '–' : `${Math.round(r.heat * 100)} %`}</span>
          </div>
        ))}
      </div>
    </ExpertSection>
  );
}

/** 15-minute precipitation nowcast (next ~2 h). */
function NowcastTable(props: { snap: DashboardSnapshot }): JSX.Element | null {
  const nc = props.snap.precipNowcast;
  if (nc === undefined || nc.length === 0) return null;
  const total = Math.round(nc.reduce((s, p) => s + p.precipMm, 0) * 10) / 10;
  return (
    <ExpertSection title={['Niederschlags-Nowcast (15 min)', 'Precipitation nowcast (15 min)']} testId="lg2-expert-nowcast"
      hint={[`Summe der nächsten ~2 h: ${fx(total)} mm.`, `Sum over the next ~2 h: ${fx(total)} mm.`]}>
      <div class="lg2-exp-nowcast">
        {nc.slice(0, 12).map((p) => {
          const barH = Math.min(100, Math.round(p.precipMm * 40));
          return (
            <div class="lg2-exp-nowcast__col" key={p.ts} title={`${hms(p.ts)} · ${fx(p.precipMm)} mm`}>
              <span class="lg2-exp-nowcast__bar" style={{ height: `${Math.max(2, barH)}%` }} />
              <span class="lg2-exp-nowcast__lbl">{new Date(p.ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })}</span>
            </div>
          );
        })}
      </div>
    </ExpertSection>
  );
}

/* -------------------------------------------------------------------------- */
/* Column + row building                                                      */
/* -------------------------------------------------------------------------- */

function buildColumns(snap: DashboardSnapshot, horizon: Horizon, roomId: string): Col[] {
  const tl = (snap.forecastTimeline ?? []).slice().sort((a, b) => ms(a.ts) - ms(b.ts));
  if (tl.length === 0) return [];
  const now = Date.now();
  const end = now + horizon * 3600_000;
  const within = tl.filter((c) => ms(c.ts) >= now - 60 * 60000 && ms(c.ts) <= end);
  const src = within.length > 0 ? within : tl;
  // Task 11.10: scale the visible column budget with the horizon so 48 h shows
  // more detail instead of collapsing; always keep the last sample so the end
  // of the horizon is represented even when the timeline is short.
  const maxCols = horizon >= 48 ? 16 : horizon >= 24 ? 13 : 9;
  const step = Math.max(1, Math.ceil(src.length / maxCols));
  const picked = src.filter((_, i) => i % step === 0 || i === src.length - 1).slice(0, maxCols);

  const indoorArr = snap.trajectories?.indoorForecastWithShade;
  const noShadeArr = snap.trajectories?.indoorForecastNoShade;
  const heatArr = snap.trajectories?.heatLoadForecast;
  const room: RoomDetail | undefined = roomId === 'all' ? undefined : (snap.roomsDetail ?? []).find((r) => r.id === roomId);
  const peak = snap.indoorPeakTempC ?? null;

  return picked.map((card): Col => {
    const tsMs = ms(card.ts);
    const d = new Date(tsMs);
    const hour = d.getHours();
    const indoor = nearest(indoorArr, tsMs)?.tempC ?? null;
    const indoorNoShade = nearest(noShadeArr, tsMs)?.tempC ?? null;
    const heatLoad = nearest(heatArr, tsMs)?.load01 ?? null;
    let shutter: number | null = null;
    if (room !== undefined) shutter = nearest(room.shutterForecast, tsMs)?.percent ?? null;
    else {
      const vals = (snap.roomsDetail ?? []).map((r) => nearest(r.shutterForecast, tsMs)?.percent).filter((x): x is number => x !== null && x !== undefined);
      shutter = vals.length > 0 ? Math.round(vals.reduce((s, x) => s + x, 0) / vals.length) : null;
    }
    const risk = card.tempC >= 29 || (indoor !== null && indoor >= 26) || (peak !== null && peak >= 27 && card.tempC >= 27);
    return {
      ts: card.ts, hour, day: dayIndex(tsMs, now), label: hourLabel(d), dayLabel: dayName(tsMs, now),
      card, indoor, indoorNoShade, heatLoad, shutter, risk,
    };
  });
}

function dayIndex(tsMs: number, now: number): number {
  const a = new Date(tsMs); a.setHours(0, 0, 0, 0);
  const b = new Date(now); b.setHours(0, 0, 0, 0);
  return Math.round((a.getTime() - b.getTime()) / 86400000);
}
function dayName(tsMs: number, now: number): [string, string] {
  const di = dayIndex(tsMs, now);
  if (di <= 0) return ['Heute', 'Today'];
  if (di === 1) return ['Morgen', 'Tomorrow'];
  if (di === 2) return ['Übermorgen', 'Day after'];
  return ['Später', 'Later'];
}
function hourLabel(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:00`;
}
function riskWindow(cols: Col[]): { from: Col; to: Col } | null {
  const risky = cols.filter((c) => c.risk);
  if (risky.length === 0) return null;
  return { from: risky[0]!, to: risky[risky.length - 1]! };
}
function ventMode(c: Col): { label: [string, string]; color: string } {
  if (c.card.precipitationOrCloud01 > 0.6) return { label: ['Geschlossen', 'Closed'], color: 'var(--lg2-label-2)' };
  if (c.risk || (c.indoor !== null && c.indoor >= 26)) return { label: ['Geschlossen', 'Closed'], color: '#ff5d57' };
  const night = c.hour < 7 || c.hour >= 21;
  const out = c.card.tempC;
  if (c.indoor !== null && out < c.indoor - 1) return night ? { label: ['Nachtlüftung', 'Night vent'], color: '#35d6e7' } : { label: ['Frischluft', 'Fresh air'], color: '#30d158' };
  return { label: ['Reduziert', 'Reduced'], color: 'var(--lg2-label-2)' };
}

function ShutterCell(props: { pct: number | null; risk: boolean }): JSX.Element {
  const p = props.pct;
  return (
    <span class={`lg2-fc__shutter${props.risk ? ' lg2-fc__shutter--risk' : ''}`}>
      <span class="lg2-fc__blind" aria-hidden="true">
        <span class="lg2-fc__blind-fill" style={{ height: `${p === null ? 0 : Math.max(6, Math.min(100, p))}%` }} />
      </span>
      <b>{p === null ? '–' : `${Math.round(p)} %`}</b>
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Metric row (label + cells + optional trend curve)                          */
/* -------------------------------------------------------------------------- */

function Row(props: {
  icon: JSX.Element; name: [string, string]; sub: [string, string]; cols: Col[];
  cell: (c: Col) => JSX.Element;
  curve?: { pick: (c: Col) => number | null; color: string };
}): JSX.Element {
  return (
    <Fragment>
      <div class="lg2-fc__rowhead">
        <span class="lg2-fc__rowicon">{props.icon}</span>
        <span class="lg2-fc__rowlabel"><b>{t(...props.name)}</b><em>{t(...props.sub)}</em></span>
      </div>
      <div class="lg2-fc__cells">
        {props.curve !== undefined && <TrendCurve cols={props.cols} pick={props.curve.pick} color={props.curve.color} />}
        {props.cols.map((c) => (
          <div key={c.ts} class={`lg2-fc__cell${c.risk ? ' lg2-fc__cell--risk' : ''}`}>{props.cell(c)}</div>
        ))}
      </div>
    </Fragment>
  );
}

/** SVG trend curve spanning the row's data cells (points at column centres). */
function TrendCurve(props: { cols: Col[]; pick: (c: Col) => number | null; color: string }): JSX.Element | null {
  const pts = props.cols.map((c, i) => ({ i, v: props.pick(c) }));
  const nums = pts.filter((p): p is { i: number; v: number } => p.v !== null && Number.isFinite(p.v));
  if (nums.length < 2) return null;
  const vals = nums.map((p) => p.v);
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = max - min || 1;
  const n = props.cols.length;
  const x = (i: number): number => ((i + 0.5) / n) * 100;
  const y = (v: number): number => 88 - ((v - min) / span) * 76; // 12%..88% band
  const line = nums.map((p, k) => `${k === 0 ? 'M' : 'L'} ${x(p.i).toFixed(2)} ${y(p.v).toFixed(2)}`).join(' ');
  return (
    <svg class="lg2-fc__curve" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <path d={line} fill="none" stroke={props.color} stroke-width="1.4" vector-effect="non-scaling-stroke"
        stroke-linecap="round" stroke-linejoin="round" opacity="0.9" />
    </svg>
  );
}

/* -------------------------------------------------------------------------- */
/* Risk banner                                                                */
/* -------------------------------------------------------------------------- */

function RiskBanner(props: { snap: DashboardSnapshot; riskWin: { from: Col; to: Col } | null; cols: Col[] }): JSX.Element | null {
  const { snap, riskWin } = props;
  const alertActive = snap.weatherAlert?.active === true;

  // Task 11.9: no overheating-risk window AND no active weather alert → hide the
  // whole card (no "no elevated risk" filler banner).
  if (riskWin === null && !alertActive) return null;

  // Alert but no overheating window: show a severe-weather banner (not an
  // invented risk-time-window text).
  if (riskWin === null && alertActive) {
    const al = snap.weatherAlert;
    const region = al?.region;
    return (
      <div class="lg2-card lg2-fc__banner lg2-fc__banner--risk" data-testid="lg2-forecast-banner">
        <span class="lg2-fc__banner-icon"><Icon name="warnung" size={22} /></span>
        <div class="lg2-fc__banner-body">
          <strong>{t('Aktive Unwetterwarnung für deinen Standort', 'Active severe-weather warning for your location')}</strong>
          <span>
            {region != null && region !== '' ? `${region} · ` : ''}
            {t('Details in den Warnungen ansehen.', 'See the warnings for details.')}
          </span>
        </div>
        <button type="button" class="lg2-btn lg2-fc__banner-btn" onClick={(): void => { route('/warnungen'); }}>
          {t('Warnungen ansehen', 'View warnings')} <Icon name="warnung" size={15} />
        </button>
      </div>
    );
  }

  // Overheating-risk window: fully dynamic text from the risk columns.
  const maxTemp = props.cols.reduce((m, c) => Math.max(m, c.card.tempC), -Infinity);
  const from = riskWin?.from.label ?? '';
  const to = riskWin?.to.label ?? '';
  const day = riskWin !== null ? t(...riskWin.from.dayLabel).toLowerCase() : t('heute', 'today');
  return (
    <div class="lg2-card lg2-fc__banner lg2-fc__banner--risk" data-testid="lg2-forecast-banner">
      <span class="lg2-fc__banner-icon"><Icon name="beschattung" size={22} /></span>
      <div class="lg2-fc__banner-body">
        <strong>{t(`Erhöhtes Überhitzungsrisiko ${day} zwischen ${from} und ${to} Uhr`, `Elevated overheating risk ${day} between ${from} and ${to}`)}</strong>
        <span>
          {t('Außentemperatur bis zu', 'Outdoor temp up to')} {n1(maxTemp)} °C · {t('hohe solare Last', 'high solar load')} · {t('geringe Windunterstützung', 'low wind support')}
        </span>
      </div>
      <button type="button" class="lg2-btn lg2-fc__banner-btn" onClick={(): void => { route('/automatik'); }}>
        {t('Empfehlungen anzeigen', 'Show recommendations')} <Icon name="forecast" size={15} />
      </button>
    </div>
  );
}

function FcSkeleton(): JSX.Element {
  return (
    <div data-testid="lg2-forecast-skeleton" aria-hidden="true" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div class="lg2-sk" style={{ height: '44px', width: '260px' }} />
      <div class="lg2-sk" style={{ height: '74px', borderRadius: '18px' }} />
      <div class="lg2-sk" style={{ height: '60vh', borderRadius: '20px' }} />
    </div>
  );
}
