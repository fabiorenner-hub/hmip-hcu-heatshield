/**
 * Heat Shield — "Liquid Glass V2" Räume page (DEMO route `/liquid-glass-raeume`).
 *
 * Master-detail room view in the V2 design, matching the approved mock:
 *   - left: a selectable list of room cards (icon · name · risk · temp · next action),
 *   - right: the selected room's detail — header, 3 KPI cards, a temperature
 *     chart (real /api/trends data) and a strip of six status tiles.
 *
 * It reuses the shared `Lg2Shell` (sidebar + global Appearance configurator +
 * frame chrome) so the "Darstellung" setup from Übersicht applies here too.
 * Every tile is backed by a real snapshot value — no dead UI, no invented
 * numbers (honest `–` fallbacks where a source is missing).
 */

import { h, Fragment, type JSX } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { route } from 'preact-router';

import { t, fmtNum, fmtTime } from '../../i18n.js';
import { snapshot, riskBreakdowns } from '../../store.js';
import { expertMode } from '../../expertMode.js';
import { setShutter } from '../../hooks/useControl.js';
import { Icon, type IconName } from '../icons.js';
import { LineChart, type ChartSeries } from '../lineChart.js';
import { ExpertSection, RiskBreakdownDetail } from './shell/lg2Expert.js';
import type { DashboardSnapshot, RoomDetail } from '../../types.js';
import {
  avoidedWarmingC,
  dataAgeMinutes,
  expectedPeakC,
  forecastAccuracyC,
} from '../uebersicht/uebersichtModel.js';

interface RoutableProps {
  path?: string;
}
interface TrendSample {
  ts: string;
  key: string;
  value: number;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

type Tone = 'high' | 'mid' | 'low' | 'vlow';
const TONE_LABEL: Record<Tone, [string, string]> = {
  high: ['Hoch', 'High'],
  mid: ['Mittel', 'Medium'],
  low: ['Niedrig', 'Low'],
  vlow: ['Sehr niedrig', 'Very low'],
};
/** Overheating risk tone from the room's normalised heat load [0,1]. */
function roomTone(r: RoomDetail): Tone {
  const h = r.heatLoad01 ?? 0;
  if (h >= 0.7) return 'high';
  if (h >= 0.45) return 'mid';
  if (h >= 0.2) return 'low';
  return 'vlow';
}
type RoomKind = 'living' | 'kitchen' | 'bed' | 'office' | 'bath' | 'wardrobe' | 'cellar' | 'dining' | 'generic';
/** Classify a room by its (German/English) name for a matching glyph. */
function roomKind(name: string): RoomKind {
  const n = name.toLowerCase();
  if (/wohn|living|salon|lounge/.test(n)) return 'living';
  if (/küche|kuche|kitchen|koch/.test(n)) return 'kitchen';
  if (/bad|dusche|\bwc\b|bath|toilet/.test(n)) return 'bath';
  if (/büro|buro|arbeit|office|studio|work/.test(n)) return 'office';
  if (/schlaf|kinder|gäste|gaste|guest|bett|bed/.test(n)) return 'bed';
  if (/garderobe|flur|diele|eingang|entree|\bhall\b|wardrobe|ankleide/.test(n)) return 'wardrobe';
  if (/keller|cellar|basement|lager|abstell|technik|heizung|utility/.test(n)) return 'cellar';
  if (/ess|dining|speise/.test(n)) return 'dining';
  return 'generic';
}
/** Inline SVG room-type glyph (line style, matches the icon set). */
function RoomGlyph(props: { name: string; size?: number }): JSX.Element {
  const s = props.size ?? 20;
  const paths: Record<RoomKind, JSX.Element> = {
    living: <Fragment><path d="M4 11V9a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2" /><path d="M3 12a2 2 0 0 1 2 2v2h14v-2a2 2 0 0 1 2-2v4a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" /><path d="M6 17v2M18 17v2" /></Fragment>,
    kitchen: <Fragment><path d="M5 10h14v3a5 5 0 0 1-5 5h-4a5 5 0 0 1-5-5z" /><path d="M3 11h2M19 11h2" /><path d="M9 7c0-1 1-1 1-2M13 7c0-1 1-1 1-2" /></Fragment>,
    bed: <Fragment><path d="M3 18v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4" /><path d="M3 15h18" /><path d="M7 12v-1a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1" /><path d="M3 18v2M21 18v2" /></Fragment>,
    office: <Fragment><rect x="3" y="4" width="18" height="11" rx="1.5" /><path d="M12 15v3M9 18h6" /></Fragment>,
    bath: <Fragment><path d="M4 12h16v3a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z" /><path d="M4 12V7a2 2 0 0 1 2-2 1.5 1.5 0 0 1 1.5 1.5" /><path d="M7 19l-1 2M17 19l1 2" /></Fragment>,
    wardrobe: <Fragment><path d="M12 5.5a1.5 1.5 0 1 1 1.3 2.2c-.8.4-1.3.8-1.3 1.6" /><path d="M4 16l8-6 8 6" /><path d="M3 16h18" /></Fragment>,
    cellar: <Fragment><path d="M4 20v-3h4v-3h4v-3h4v-3h4" /><path d="M4 20h16" /></Fragment>,
    dining: <Fragment><path d="M7 4v16M5 4v4a2 2 0 0 0 2 2M9 4v4a2 2 0 0 1-2 2" /><path d="M16 4c-1.5 0-2.5 1.5-2.5 3.5S15 11 16 11v9" /></Fragment>,
    generic: <Fragment><path d="M6 3h12v18H6z" /><path d="M14 12h.6" /></Fragment>,
  };
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      {paths[roomKind(props.name)]}
    </svg>
  );
}
function num1(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v)
    ? '–'
    : fmtNum(Math.round(v * 10) / 10, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}
function actionTime(r: RoomDetail): string | null {
  const ts = r.nextAction?.scheduledTs;
  if (ts === undefined) return null;
  const d = new Date(ts);
  return Number.isFinite(d.getTime()) ? fmtTime(d) : null;
}

/* -------------------------------------------------------------------------- */
/* Root                                                                       */
/* -------------------------------------------------------------------------- */

export function LiquidGlass2Raeume(_props: RoutableProps): JSX.Element {
  const snap = snapshot.value;
  return (
    <main class="lg2-main lg2-raeume" data-testid="liquid-glass2-raeume">
      {snap === null ? <RaeumeSkeleton /> : <RaeumeBody snap={snap} />}
    </main>
  );
}

function RaeumeBody(props: { snap: DashboardSnapshot }): JSX.Element {
  const { snap } = props;
  const rooms = snap.roomsDetail ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = rooms.find((r) => r.id === selectedId) ?? rooms[0] ?? null;

  return (
    <Fragment>
      <header class="lg2-header">
        <div>
          <h1 class="lg2-header__title">{t('Räume', 'Rooms')}</h1>
          <p class="lg2-header__sub">{t('Alle Räume im Überblick', 'All rooms at a glance')}</p>
        </div>
        <button type="button" class="lg2-btn" onClick={(): void => { route('/rooms'); }}>
          <Icon name="einstellungen" size={16} /> {t('Raum hinzufügen', 'Add room')}
        </button>
      </header>

      <div class="lg2-raeume__split">
        <RoomList rooms={rooms} selectedId={selected?.id ?? null} onSelect={setSelectedId} />
        {selected !== null
          ? <RoomDetailPanel snap={snap} room={selected} />
          : <div class="lg2-card lg2-raeume__empty">{t('Noch keine Räume eingerichtet.', 'No rooms configured yet.')}</div>}
      </div>
    </Fragment>
  );
}

/* -------------------------------------------------------------------------- */
/* Left: room list                                                            */
/* -------------------------------------------------------------------------- */

function RoomList(props: { rooms: RoomDetail[]; selectedId: string | null; onSelect: (id: string) => void }): JSX.Element {
  return (
    <div class="lg2-card lg2-roomlist" data-testid="lg2-roomlist">
      <div class="lg2-roomlist__scroll">
        {props.rooms.map((r) => {
          const tone = roomTone(r);
          const at = actionTime(r);
          const on = r.id === props.selectedId;
          return (
            <button type="button" key={r.id}
              class={`lg2-roomrow${on ? ' lg2-roomrow--on' : ''}`}
              aria-current={on ? 'true' : undefined}
              onClick={(): void => props.onSelect(r.id)}>
              <span class="lg2-roomrow__icon"><RoomGlyph name={r.name} size={20} /></span>
              <span class="lg2-roomrow__body">
                <span class="lg2-roomrow__top">
                  <span class="lg2-roomrow__name">{r.name}</span>
                  {/* Only surface a risk badge when there is actual risk to
                      flag; the lowest ("Sehr niedrig") tone is hidden to keep
                      the list calm and avoid a misleading "temperature" read. */}
                  {tone !== 'vlow' && (
                    <span class={`lg2-risk lg2-risk--${tone}`}
                      title={t('Überhitzungsrisiko dieses Raums', 'This room’s overheating risk')}>
                      {t(...TONE_LABEL[tone])}
                    </span>
                  )}
                </span>
                <span class="lg2-roomrow__temps">
                  <span class="lg2-roomrow__temp">{num1(r.indoorTempC)} <small>°C</small></span>
                  <span class="lg2-roomrow__temp-lbl">{t('aktuell', 'current')}</span>
                  <span class="lg2-roomrow__shutter">{t('Rollladen', 'Shutter')} {Math.round(r.shutterPercent)} %</span>
                </span>
                <span class={`lg2-roomrow__next${at === null ? ' lg2-roomrow__next--none' : ''}`}>
                  {at !== null
                    ? `${t('Nächste Aktion', 'Next action')}: ${at}`
                    : `${t('Nächste Aktion', 'Next action')}: ${t('Keine', 'None')}`}
                </span>
              </span>
              {on && <Icon name="forecast" size={16} />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Right: room detail                                                         */
/* -------------------------------------------------------------------------- */

function RoomDetailPanel(props: { snap: DashboardSnapshot; room: RoomDetail }): JSX.Element {
  const { snap, room } = props;
  const tone = roomTone(room);
  const peak = expectedPeakC(snap);
  const avoided = avoidedWarmingC(snap);
  const accuracy = forecastAccuracyC(snap);
  const ageMin = dataAgeMinutes(snap.ts);
  const at = actionTime(room);

  return (
    <div class="lg2-raeume__detail" data-testid="lg2-room-detail">
      <div class="lg2-card lg2-roomhead">
        <span class="lg2-roomhead__icon"><RoomGlyph name={room.name} size={26} /></span>
        <div class="lg2-roomhead__id">
          <h2>{room.name}</h2>
          <p>
            {[room.floor, room.facade !== undefined ? t('Hauptbereich', 'Main area') : null]
              .filter((x): x is string => x !== null && x !== undefined)
              .join(' · ') || t('Raum', 'Room')}
          </p>
        </div>
        <span class={`lg2-riskpill lg2-riskpill--${tone}`}>
          <Icon name="beschattung" size={15} />
          {tone === 'high' ? t('Hohes Überhitzungsrisiko', 'High overheating risk')
            : tone === 'mid' ? t('Mittleres Überhitzungsrisiko', 'Medium overheating risk')
              : t('Geringes Überhitzungsrisiko', 'Low overheating risk')}
        </span>
      </div>

      <div class="lg2-roomkpis">
        <DetailKpi icon="thermometer" value={`${num1(room.indoorTempC)} °C`} label={t('aktuell', 'current')} hint={t('Innenraumtemperatur', 'Indoor temperature')} />
        <DetailKpi icon="beschattung" value={`${num1(peak)} °C`} label={t('Peak erwartet', 'Peak expected')} hint={t('Heute im Tagesverlauf', 'Later today')} accent />
        <DetailKpi icon="forecast" value={`${num1(avoided)} °C`} label={t('Vermiedene Erwärmung', 'Avoided warming')} hint={t('durch Beschattung', 'via shading')} />
      </div>

      <RoomChart room={room} />

      <RoomStrip snap={snap} room={room} at={at} accuracy={accuracy} ageMin={ageMin} />

      {/* Expert view: raw fields + learned model + manual control (Task 9.3). */}
      {expertMode.value && (
        <Fragment>
          <div class="lg2-card lg2-expert" data-testid="lg2-expert-room">
            <span class="lg2-expert__title">{t('Expertenwerte', 'Expert values')}</span>
            <div class="lg2-expert__grid">
              <span><b>{num1(room.indoorTempC)} °C</b>{t('Innentemperatur', 'Indoor temp.')}</span>
              <span><b>{room.orientationDeg === undefined ? '–' : `${Math.round(room.orientationDeg)}°`}</b>{t('Ausrichtung', 'Orientation')}</span>
              <span><b>{room.heatLoad01 === undefined ? '–' : `${Math.round(room.heatLoad01 * 100)} %`}</b>{t('Wärmelast', 'Heat load')}</span>
              <span><b>{Math.round(room.shutterPercent)} %</b>{t('Rollladen', 'Shutter')}</span>
              <span><b>{room.indoorTempState ?? '–'}</b>{t('Sensor-Status', 'Sensor state')}</span>
              <span><b>{room.roof === true ? t('ja', 'yes') : t('nein', 'no')}</b>{t('Dachfenster', 'Roof window')}</span>
              <span><b>{room.windowOpen === true ? t('offen', 'open') : t('zu', 'closed')}</b>{t('Fensterkontakt', 'Window contact')}</span>
              <span><b>{room.manualOverrideUntil !== undefined && room.manualOverrideUntil !== null ? fmtTime(new Date(room.manualOverrideUntil)) : t('keine', 'none')}</b>{t('Override bis', 'Override until')}</span>
            </div>
          </div>

          <RoomLearning snap={snap} room={room} />

          {/* Full risk decomposition for this room's window. */}
          {(() => {
            const rb = room.windowId !== undefined ? riskBreakdowns.value[room.windowId] : undefined;
            if (rb === undefined) return null;
            return (
              <ExpertSection title={['Risiko-Zerlegung (dieses Fenster)', 'Risk decomposition (this window)']} testId="lg2-expert-room-risk"
                hint={['Faktor × Gewicht = Beitrag; Rohziel → Endziel nach Leitplanken.',
                  'Factor × weight = contribution; raw → final target after guardrails.']}>
                <RiskBreakdownDetail b={rb} name={room.name} />
              </ExpertSection>
            );
          })()}

          {/* Ventilation / cooling advice for this room. */}
          {(() => {
            const vent = snap.ventilation?.rooms.find((r) => r.id === room.id);
            if (vent === undefined) return null;
            return (
              <ExpertSection title={['Lüftungs-Empfehlung', 'Ventilation advice']} testId="lg2-expert-room-vent">
                <div class="lg2-auto__advice"><b>{vent.headline}</b><span>{vent.detail}</span></div>
              </ExpertSection>
            );
          })()}

          <div class="lg2-card lg2-expert" data-testid="lg2-expert-room-control">
            <span class="lg2-expert__title">{t('Manuelle Steuerung', 'Manual control')}</span>
            {snap.mode === 'STORM' || snap.storm?.holdUntil != null ? (
              <p class="lg2-hero__lead" data-testid="lg2-expert-room-control-locked">
                {t('Sturmschutz aktiv — manuelle Steuerung gesperrt (Sicherheitsvorrang).',
                  'Storm protection active — manual control locked (safety precedence).')}
              </p>
            ) : room.windowId === undefined ? (
              <p class="lg2-hero__lead">{t('Kein Rollladen für diesen Raum.', 'No shutter for this room.')}</p>
            ) : (
              <div class="lg2-exp-ctl">
                <div class="lg2-exp-ctl__row">
                  <span class="lg2-exp-ctl__name">
                    {room.name}
                    <small>{Math.round(room.shutterPercent)} %</small>
                  </span>
                  <span class="lg2-exp-ctl__btns">
                    <button type="button" onClick={(): void => { void setShutter(room.windowId as string, 0); }}>{t('Auf', 'Open')}</button>
                    <button type="button" onClick={(): void => { void setShutter(room.windowId as string, 0.5); }}>50 %</button>
                    <button type="button" onClick={(): void => { void setShutter(room.windowId as string, 1); }}>{t('Zu', 'Close')}</button>
                  </span>
                </div>
              </div>
            )}
          </div>
        </Fragment>
      )}
    </div>
  );
}

/** Learned shading model for the selected room (expert). */
function RoomLearning(props: { snap: DashboardSnapshot; room: RoomDetail }): JSX.Element | null {
  const learn = props.snap.learning?.rooms.find((r) => r.id === props.room.id);
  if (learn === undefined) return null;
  return (
    <div class="lg2-card lg2-expert" data-testid="lg2-expert-room-learning">
      <span class="lg2-expert__title">{t('Lernmodell', 'Learned model')}</span>
      <div class="lg2-expert__grid">
        <span><b>{learn.sampleDays}</b>{t('Lerntage', 'Learn days')}</span>
        <span><b>{num1(learn.avgIndoorPeakC)} °C</b>{t('Ø Peak innen', 'Avg indoor peak')}</span>
        <span><b>{num1(learn.avgOvershootC)} °C</b>{t('Ø Überschreitung', 'Avg overshoot')}</span>
        <span><b>{num1(learn.avgMovesPerDay)}</b>{t('Ø Fahrten/Tag', 'Avg moves/day')}</span>
        <span><b>{num1(learn.comfortBiasC)} °C</b>{t('Komfort-Bias', 'Comfort bias')}</span>
        <span><b>{learn.calibratedInertiaMinutes === undefined ? '–' : `${Math.round(learn.calibratedInertiaMinutes)} min`}</b>{t('Kalibr. Trägheit', 'Calibr. inertia')}</span>
      </div>
      <p class="lg2-settings__hint">
        {learn.recommendation}
        {learn.calibrationNote !== undefined ? ` · ${learn.calibrationNote}` : ''}
      </p>
    </div>
  );
}

function DetailKpi(props: { icon: IconName; value: string; label: string; hint: string; accent?: boolean }): JSX.Element {
  return (
    <div class={`lg2-card lg2-roomkpi${props.accent === true ? ' lg2-roomkpi--accent' : ''}`}>
      <div class="lg2-roomkpi__head">
        <span class="lg2-roomkpi__value">{props.value}</span>
        <Icon name={props.icon} size={18} />
      </div>
      <span class="lg2-roomkpi__label">{props.label}</span>
      <span class="lg2-roomkpi__hint">{props.hint}</span>
    </div>
  );
}

/** Real temperature history for the room (last 12 h) from /api/trends. */
function RoomChart(props: { room: RoomDetail }): JSX.Element {
  const { room } = props;
  const [samples, setSamples] = useState<TrendSample[] | null>(null);
  const [range, setRange] = useState<'24h' | '7d' | '30d'>('24h');

  useEffect(() => {
    const seconds = range === '24h' ? 86400 : range === '7d' ? 604800 : 2592000;
    let cancelled = false;
    void (async (): Promise<void> => {
      try {
        const res = await fetch(`/api/trends?seconds=${seconds}`, { headers: { Accept: 'application/json' } });
        if (!res.ok) return;
        const json = (await res.json()) as { samples: TrendSample[] };
        if (!cancelled) setSamples(json.samples);
      } catch { /* leave null → empty state */ }
    })();
    return (): void => { cancelled = true; };
  }, [range, room.id]);

  const series: ChartSeries[] = useMemo(() => {
    const all = samples ?? [];
    const out: ChartSeries[] = [];
    const roomPts = all.filter((s) => s.key === `room:${room.id}`)
      .map((s) => ({ t: Date.parse(s.ts), v: s.value })).filter((p) => Number.isFinite(p.t));
    if (roomPts.length > 0) out.push({ label: t('Gemessen', 'Measured'), color: '#e8edf6', points: roomPts });
    const outPts = all.filter((s) => s.key === 'outdoor')
      .map((s) => ({ t: Date.parse(s.ts), v: s.value })).filter((p) => Number.isFinite(p.t));
    if (outPts.length > 0) out.push({ label: t('Außen', 'Outdoor'), color: '#4a8cff', points: outPts });
    return out;
  }, [samples, room.id]);

  return (
    <div class="lg2-card lg2-roomchart">
      <div class="lg2-roomchart__head">
        <h3>{t('Temperaturverlauf', 'Temperature history')}</h3>
        <div class="lg2-seg" role="tablist">
          {(['24h', '7d', '30d'] as const).map((k) => (
            <button key={k} type="button" role="tab" aria-selected={range === k}
              class={`lg2-seg__btn${range === k ? ' lg2-seg__btn--on' : ''}`}
              onClick={(): void => setRange(k)}>
              {k === '24h' ? '24h' : k === '7d' ? t('7 Tage', '7 days') : t('30 Tage', '30 days')}
            </button>
          ))}
        </div>
      </div>
      {series.length > 0
        ? <LineChart series={series} unit="°C" height={190} nowT={Date.now()} />
        : <div class="lg2-roomchart__empty">{samples === null ? t('Lädt …', 'Loading …') : t('Noch keine Verlaufsdaten.', 'No history yet.')}</div>}
    </div>
  );
}

/** Six status tiles below the chart — all real snapshot values. */
function RoomStrip(props: { snap: DashboardSnapshot; room: RoomDetail; at: string | null; accuracy: number | null; ageMin: number | null }): JSX.Element {
  const { snap, room, at, accuracy, ageMin } = props;
  const rooms = snap.roomsDetail ?? [];
  const shaded = rooms.filter((r) => r.shutterPercent >= 50).length;
  const rel = accuracy === null ? null : Math.max(0, Math.min(100, Math.round((1 - accuracy / 4) * 100)));
  const now = new Date();
  return (
    <div class="lg2-roomstrip">
      <StripCell icon="beschattung" label={t('Rollladen (Raum)', 'Shutter (room)')} value={`${Math.round(room.shutterPercent)} %`} sub={room.shutterPercent >= 50 ? t('beschattet', 'shaded') : t('offen', 'open')} />
      <StripCell icon="automation" label={t('Beschattete Räume', 'Shaded rooms')} value={`${shaded} / ${rooms.length}`} sub={t('im Haus', 'in the home')} />
      <StripCell icon="forecast" label={t('Nächste Aktion', 'Next action')} value={at ?? t('Keine', 'None')} sub={room.nextAction !== null ? t('geplant', 'scheduled') : t('nichts geplant', 'nothing planned')} />
      <StripCell icon="tropfen" label={t('Fenster', 'Window')} value={room.windowOpen === true ? t('Offen', 'Open') : t('Geschlossen', 'Closed')} sub={room.roof === true ? t('Dachfenster', 'Roof window') : t('Fassade', 'Facade')} />
      <StripCell icon="beschattung" label={t('Prognose-Sicherheit', 'Forecast reliability')} value={rel === null ? '–' : `${rel} %`} sub={rel !== null && rel >= 80 ? t('Hoch', 'High') : t('Mittel', 'Medium')} dot={rel !== null && rel >= 80 ? 'ok' : 'warn'} />
      <StripCell icon="einstellungen" label={t('Sensordaten', 'Sensor data')} value={ageMin === null ? '–' : ageMin < 1 ? t('gerade eben', 'just now') : t('vor', 'ago') + ` ${Math.round(ageMin)} min`} sub={fmtTime(now)} dot={room.indoorTempState === 'fresh' ? 'ok' : 'warn'} />
    </div>
  );
}

function StripCell(props: { icon: IconName; label: string; value: string; sub: string; dot?: 'ok' | 'warn' }): JSX.Element {
  return (
    <div class="lg2-card lg2-stripcell">
      <span class="lg2-stripcell__icon"><Icon name={props.icon} size={17} /></span>
      <span class="lg2-stripcell__value">{props.value}</span>
      <span class="lg2-stripcell__label">{props.label}</span>
      <span class="lg2-stripcell__sub">
        {props.dot !== undefined && <span class={`lg2-dot lg2-dot--${props.dot}`} />} {props.sub}
      </span>
    </div>
  );
}

function RaeumeSkeleton(): JSX.Element {
  return (
    <div data-testid="lg2-raeume-skeleton" aria-hidden="true" style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
      <div class="lg2-sk" style={{ height: '46px', width: '240px' }} />
      <div class="lg2-raeume__split">
        <div class="lg2-sk" style={{ height: '70vh', borderRadius: '20px' }} />
        <div class="lg2-sk" style={{ height: '70vh', borderRadius: '20px' }} />
      </div>
    </div>
  );
}
