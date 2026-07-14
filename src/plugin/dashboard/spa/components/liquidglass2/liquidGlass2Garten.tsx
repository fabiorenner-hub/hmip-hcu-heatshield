/**
 * Heat Shield — "Liquid Glass V2" Garten/Bewässerung page (DEMO
 * `/liquid-glass-garten`).
 *
 * Matches the approved mock: a water-balance hero banner, a zone overview with
 * soil-moisture gauges, a 7-day water-balance chart and a care tip.
 *
 * All current values come from the live `snap.irrigation` snapshot. The 7-day
 * balance chart is fed by a REAL rolling daily accumulator persisted per device
 * in localStorage (rain, ET₀, balance = rain − ET₀) — no invented numbers, and
 * it stays LOCAL (no telemetry). It fills up over a week of use.
 */

import { h, Fragment, type JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { route } from 'preact-router';

import { t, fmtNum, fmtTime, locale } from '../../i18n.js';
import { snapshot } from '../../store.js';
import { expertMode } from '../../expertMode.js';
import {
  runIrrigationZone, stopIrrigationZone, skipIrrigationZone,
  addPlanEntry, updatePlanEntry, deletePlanEntry, resetPlanToAuto,
} from '../../hooks/useControl.js';
import { useConfig } from '../../hooks/useConfig.js';
import { Icon } from '../icons.js';
import { ExpertSection, ExpertMetrics, M, hms } from './shell/lg2Expert.js';
import type { DashboardSnapshot, IrrigationInfo, IrrigationZoneView } from '../../types.js';

interface RoutableProps { path?: string }

/** Healthy-plant leaf glyph — signals "garden fine / no watering needed". */
function LeafGlyph(props: { size?: number }): JSX.Element {
  const s = props.size ?? 24;
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M4 20c0-9 6.5-15 16-15 0 9-6.5 15-16 15z" />
      <path d="M4.5 19.5C8 13 12.5 9.5 18 8" />
    </svg>
  );
}

function n1(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v)
    ? '–'
    : fmtNum(Math.round(v * 10) / 10, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}
function signed(v: number): string {
  return (v >= 0 ? '+' : '') + n1(v);
}
type Tone = 'dry' | 'low' | 'ok' | 'wet';
function moistTone(pct: number | null): Tone {
  if (pct === null) return 'ok';
  if (pct < 25) return 'dry';
  if (pct < 45) return 'low';
  if (pct < 88) return 'ok';
  return 'wet';
}
const TONE_COLOR: Record<Tone, string> = { dry: '#ff5d57', low: '#ff9f0a', ok: '#30d158', wet: '#35d6e7' };
const TONE_LABEL: Record<Tone, [string, string]> = {
  dry: ['Niedrig', 'Low'], low: ['Mittel', 'Medium'], ok: ['Gut', 'Good'], wet: ['Nass', 'Wet'],
};

/* ---- 7-day rolling water-balance history (localStorage, real values) ------ */
interface DayBal { date: string; rainMm: number; et0Mm: number; balanceMm: number }
const HIST_KEY = 'heatshield.lg2.garden.balance.v1';
function loadHist(): DayBal[] {
  try {
    const raw = localStorage.getItem(HIST_KEY);
    if (raw !== null) return (JSON.parse(raw) as DayBal[]).slice(-7);
  } catch { /* ignore */ }
  return [];
}
function recordToday(irr: IrrigationInfo): DayBal[] {
  const today = new Date().toISOString().slice(0, 10);
  const rain = irr.rainTodayMm ?? 0;
  const et0 = irr.et0TodayMm ?? 0;
  const entry: DayBal = { date: today, rainMm: rain, et0Mm: et0, balanceMm: Math.round((rain - et0) * 10) / 10 };
  const hist = loadHist().filter((d) => d.date !== today);
  hist.push(entry);
  const trimmed = hist.slice(-7);
  try { localStorage.setItem(HIST_KEY, JSON.stringify(trimmed)); } catch { /* ignore */ }
  return trimmed;
}

/* -------------------------------------------------------------------------- */

export function LiquidGlass2Garten(_props: RoutableProps): JSX.Element {
  const snap = snapshot.value;
  return (
    <main class="lg2-main lg2-garden" data-testid="liquid-glass2-garten">
      {snap === null ? <GardenSkeleton /> : <GardenBody snap={snap} />}
    </main>
  );
}

function GardenBody(props: { snap: DashboardSnapshot }): JSX.Element {
  const irr = props.snap.irrigation;
  const [hist, setHist] = useState<DayBal[]>(() => loadHist());
  useEffect(() => {
    if (irr !== undefined) setHist(recordToday(irr));
  }, [irr?.rainTodayMm, irr?.et0TodayMm]);

  if (irr === undefined) {
    return (
      <Fragment>
        <GardenHeader />
        <div class="lg2-card lg2-garden__empty">
          <Icon name="tropfen" size={28} />
          <p>{t('Keine Bewässerung eingerichtet. Verbinde ein Gardena-System, um Zonen zu steuern.',
            'No irrigation configured. Connect a Gardena system to control zones.')}</p>
        </div>
      </Fragment>
    );
  }

  const zones = irr.zones ?? [];
  const moistVals = zones.map((z) => z.soilMoisturePct ?? z.availablePct).filter((x): x is number => x !== null && Number.isFinite(x));
  const moistAvg = moistVals.length > 0 ? Math.round(moistVals.reduce((s, x) => s + x, 0) / moistVals.length) : null;
  const rain = irr.rainTodayMm ?? 0;
  const et0 = irr.et0TodayMm ?? 0;
  const balance = Math.round((rain - et0) * 10) / 10;
  const deficit = Math.max(0, et0 - rain);
  const forecast = irr.rainForecastMm ?? 0;
  const coverage = deficit > 0 ? Math.min(100, Math.round((forecast / deficit) * 100)) : 100;
  const noWaterNeeded = balance >= 0 || coverage >= 100;
  const nextCheck = nextCheckTime(zones);
  const usedMin = Math.round((irr.totalSecondsUsedToday ?? 0) / 60);

  return (
    <Fragment>
      <GardenHeader lever onManage={(): void => { route('/bewaesserung-einstellungen'); }} />

      {/* Hero water-balance banner */}
      <section class="lg2-card lg2-garden__hero" data-testid="lg2-garden-hero"
        style={{ '--lg2-hero-img': "url('/assets/hero/garden-irrigation-dusk.png')" } as JSX.CSSProperties}>
        <div class="lg2-garden__hero-main">
          <div class="lg2-garden__hero-head">
            <span class={`lg2-garden__hero-icon lg2-garden__hero-icon--${noWaterNeeded ? 'ok' : 'due'}`}>
              {noWaterNeeded ? <LeafGlyph size={26} /> : <Icon name="tropfen" size={26} />}
            </span>
            <div>
              <h2>{noWaterNeeded ? t('Heute keine Bewässerung erforderlich', 'No watering needed today') : t('Bewässerung heute empfohlen', 'Watering recommended today')}</h2>
              <p>
                {deficit > 0
                  ? t(`Der erwartete Regen deckt ${coverage} % des aktuellen Defizits ab.`, `Expected rain covers ${coverage} % of the current deficit.`)
                  : t('Die Wasserbilanz ist ausgeglichen.', 'The water balance is even.')}
              </p>
            </div>
          </div>
          <div class="lg2-garden__hero-stats">
            <HeroStat value={`${signed(balance)} mm`} label={t('Wasserbilanz', 'Water balance')} sub={balance >= 0 ? t('Überschuss', 'Surplus') : t('Defizit', 'Deficit')} tone={balance >= 0 ? '#30d158' : '#ff9f0a'} />
            <HeroStat value={moistAvg === null ? '–' : `${moistAvg} %`} label={t('Bodenfeuchte (Ø)', 'Soil moisture (avg)')} sub={t(...TONE_LABEL[moistTone(moistAvg)])} tone={TONE_COLOR[moistTone(moistAvg)]} />
            <HeroStat value={`${usedMin} min`} label={t('Heute bewässert', 'Watered today')} sub={t('alle Zonen', 'all zones')} />
            <HeroStat value={nextCheck.value} label={t('Nächster Prüfzeitpunkt', 'Next check')} sub={nextCheck.sub} />
          </div>
        </div>
        <div class="lg2-garden__hero-side" aria-hidden="true">
          <span class="lg2-garden__hero-rain"><Icon name="tropfen" size={44} /></span>
          <div class="lg2-garden__hero-rainval">{t('Regen heute erwartet', 'Rain expected today')}</div>
          <div class="lg2-garden__hero-rainmm">{forecast > 0 ? `~ ${n1(forecast)} mm` : t('kein Regen', 'no rain')}</div>
          <div class="lg2-garden__hero-cover">{coverage} % {t('Defizitabdeckung', 'deficit coverage')}</div>
        </div>
      </section>

      <div class="lg2-garden__split">
        {/* Zone overview */}
        <div class="lg2-card lg2-garden__zones2">
          <div class="lg2-garden__zones-head">
            <h3 class="lg2-card__title">{t('Zonenübersicht', 'Zone overview')}</h3>
            <div class="lg2-garden__zcols"><span>{t('Bodenfeuchte', 'Moisture')}</span><span>{t('Status', 'Status')}</span><span>{t('Nächste Fahrt', 'Next run')}</span></div>
          </div>
          <div class="lg2-garden__zonelist">
            {zones.length === 0
              ? <div class="lg2-garden__empty">{t('Noch keine Zonen konfiguriert.', 'No zones configured yet.')}</div>
              : zones.map((z) => <ZoneRow key={z.id} zone={z} />)}
          </div>
          <button type="button" class="lg2-garden__manage" onClick={(): void => { route('/bewaesserung-einstellungen'); }}>
            {t('Alle Zonen verwalten', 'Manage all zones')} <Icon name="forecast" size={15} />
          </button>
        </div>

        <div class="lg2-garden__rightcol">
          <div class="lg2-card lg2-garden__chartcard">
            <div class="lg2-garden__chart-head">
              <h3 class="lg2-card__title">{t('Wasserbilanz (7 Tage)', 'Water balance (7 days)')}</h3>
              <span class="lg2-garden__chart-unit">mm</span>
            </div>
            <BalanceChart hist={hist} />
            <div class="lg2-garden__chart-legend">
              <span><i class="lg2-fc__swatch" style={{ background: '#35d6e7' }} /> {t('Regen', 'Rain')}</span>
              <span><i class="lg2-fc__swatch" style={{ background: '#4a8cff' }} /> {t('Verdunstung (ET₀)', 'Evapotranspiration')}</span>
              <span><i class="lg2-fc__swatch" style={{ background: '#ff9f0a' }} /> {t('Bilanz', 'Balance')}</span>
            </div>
          </div>

          <div class="lg2-card lg2-garden__tip">
            <span class="lg2-garden__tip-icon"><Icon name="beschattung" size={20} /></span>
            <div class="lg2-garden__tip-body">
              <strong>{t('Tipp', 'Tip')}</strong>
              <span>{t('Mulche Beetflächen regelmäßig — so bleibt die Feuchtigkeit länger im Boden und du sparst bis zu 20 % Wasser.',
                'Mulch beds regularly — moisture stays in the soil longer and you save up to 20 % water.')}</span>
            </div>
            <span class="lg2-garden__tip-drop"><Icon name="tropfen" size={22} /></span>
          </div>
        </div>
      </div>

      {expertMode.value && zones.length > 0 && (
        <div class="lg2-card lg2-garden__expert">
          <h3 class="lg2-card__title">{t('Expertenwerte je Zone (FAO-56-Wasserbilanz & Lernstatus)', 'Expert values per zone (FAO-56 balance & learning)')}</h3>
          <div class="lg2-garden__exptable">
            <div class="lg2-garden__exphead">
              <span>{t('Zone', 'Zone')}</span><span>{t('Defizit', 'Depletion')}</span><span>RAW / TAW</span>
              <span>{t('Tagesbedarf', 'Daily need')}</span><span>Kc</span><span>{t('Lern-Tage', 'Learn days')}</span>
            </div>
            {zones.map((z) => (
              <div key={z.id} class="lg2-garden__exprow">
                <span class="lg2-garden__expname">{z.name}{z.learned.emitterFault ? <em class="lg2-garden__expfault">{t('Emitter-Fehler', 'emitter fault')}</em> : null}</span>
                <span>{n1(z.depletionMm)} mm</span>
                <span>{n1(z.rawMm)} / {n1(z.tawMm)} mm</span>
                <span>{n1(z.dailyNeedMm)} mm</span>
                <span>{n1(z.learned.kcFactor)}</span>
                <span>{z.learned.sampleDays}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <PlanEditor irr={irr} />

      {expertMode.value && zones.length > 0 && (
        <ValveControl zones={zones} />
      )}

      {expertMode.value && <GardenExpert irr={irr} />}
    </Fragment>
  );
}

/* -------------------------------------------------------------------------- */
/* Watering-plan editor (day-ahead entries: add / enable / delete / reset)    */
/* -------------------------------------------------------------------------- */

/** Collapsed-state persistence for the watering plan (default: collapsed). */
const PLAN_COLLAPSE_KEY = 'hs.garden.plan.collapsed';

function PlanEditor(props: { irr: IrrigationInfo }): JSX.Element {
  const { irr } = props;
  const zones = irr.zones ?? [];
  const plan = irr.plan ?? [];
  const [zoneId, setZoneId] = useState<string>(zones[0]?.id ?? '');
  const [time, setTime] = useState<string>('06:00');
  const [dur, setDur] = useState<number>(10);
  // Collapsible; remembers the last state per device. Default = collapsed (only
  // 'false' — an explicit "open" — keeps it open).
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return globalThis.localStorage?.getItem(PLAN_COLLAPSE_KEY) !== 'false'; } catch { return true; }
  });
  const toggle = (): void => {
    setCollapsed((c) => {
      const next = !c;
      try { globalThis.localStorage?.setItem(PLAN_COLLAPSE_KEY, next ? 'true' : 'false'); } catch { /* ignore */ }
      return next;
    });
  };

  const add = (): void => {
    if (zoneId === '') return;
    const parts = time.split(':');
    const h = Number(parts[0]); const m = Number(parts[1]);
    const d = new Date();
    d.setHours(Number.isFinite(h) ? h : 6, Number.isFinite(m) ? m : 0, 0, 0);
    // If the time already passed today, schedule for tomorrow.
    if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1);
    void addPlanEntry(zoneId, d.toISOString(), dur);
  };

  return (
    <section class={`lg2-card lg2-garden__planeditor${collapsed ? ' lg2-garden__planeditor--collapsed' : ''}`} data-testid="lg2-garden-plan-editor">
      <div class="lg2-garden__plan-head">
        <button type="button" class="lg2-garden__plan-toggle" aria-expanded={!collapsed}
          data-testid="lg2-garden-plan-toggle" onClick={toggle}>
          <Icon name="mehr" size={16} class={`lg2-garden__plan-chevron${collapsed ? '' : ' lg2-garden__plan-chevron--open'}`} />
          <h3 class="lg2-card__title">{t('Bewässerungsplan', 'Watering plan')}</h3>
          {collapsed && plan.length > 0 && (
            <span class="lg2-garden__plan-count">{plan.length}</span>
          )}
        </button>
        {!collapsed && (
          <button type="button" class="lg2-garden__manage" onClick={(): void => { void resetPlanToAuto(); }}>
            {t('Auf Automatik zurücksetzen', 'Reset to auto')} <Icon name="automation" size={15} />
          </button>
        )}
      </div>

      {!collapsed && (
      <Fragment>
      <p class="lg2-settings__hint">
        {t('Feste Fahrten planen (Zone, Uhrzeit, Dauer). Einträge lassen sich deaktivieren oder löschen; „Automatik" leitet den Plan wieder aus der Prognose ab.',
          'Schedule fixed runs (zone, time, duration). Entries can be disabled or deleted; “Auto” re-derives the plan from the forecast.')}
      </p>

      {plan.length === 0 ? (
        <p class="lg2-garden__planempty">{t('Noch keine geplanten Fahrten.', 'No scheduled runs yet.')}</p>
      ) : (
        <div class="lg2-garden__planlist">
          {plan.map((p) => (
            <div class={`lg2-garden__planrow${p.enabled ? '' : ' lg2-garden__planrow--off'}`} key={p.id}>
              <span class="lg2-garden__plantime">{hms(p.startTs)}</span>
              <span class="lg2-garden__planzone">{p.zoneName}</span>
              <span class="lg2-garden__plandur">{p.durationMin} min</span>
              <span class="lg2-garden__plansrc">{p.source === 'manual' ? t('manuell', 'manual') : t('auto', 'auto')}{p.done ? ` · ${t('erledigt', 'done')}` : ''}</span>
              <button type="button" role="switch" aria-checked={p.enabled}
                class={`lg2-toggle${p.enabled ? ' lg2-toggle--on' : ''}`}
                title={p.enabled ? t('Aktiv', 'Enabled') : t('Deaktiviert', 'Disabled')}
                onClick={(): void => { void updatePlanEntry(p.id, { enabled: !p.enabled }); }} />
              <button type="button" class="lg2-garden__plandel" aria-label={t('Löschen', 'Delete')}
                onClick={(): void => { void deletePlanEntry(p.id); }}>×</button>
            </div>
          ))}
        </div>
      )}

      <div class="lg2-garden__planadd">
        <label class="lg2-garden__planfield">
          <span>{t('Zone', 'Zone')}</span>
          <select class="lg2-cfg__select" value={zoneId} onChange={(e): void => setZoneId((e.currentTarget as HTMLSelectElement).value)}>
            {zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
          </select>
        </label>
        <label class="lg2-garden__planfield">
          <span>{t('Uhrzeit', 'Time')}</span>
          <input type="time" class="lg2-field__input" value={time} onInput={(e): void => setTime((e.currentTarget as HTMLInputElement).value)} />
        </label>
        <label class="lg2-garden__planfield">
          <span>{t('Dauer', 'Duration')}</span>
          <select class="lg2-cfg__select" value={String(dur)} onChange={(e): void => setDur(Number((e.currentTarget as HTMLSelectElement).value))}>
            {DURATION_MINUTES.map((m) => <option key={m} value={String(m)}>{m} min</option>)}
          </select>
        </label>
        <button type="button" class="lg2-btn" data-testid="lg2-garden-plan-add" disabled={zoneId === ''} onClick={add}>
          {t('Hinzufügen', 'Add')}
        </button>
      </div>
      </Fragment>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Garden expert deep-dive: controller telemetry + per-zone + day-ahead plan  */
/* -------------------------------------------------------------------------- */

function GardenExpert(props: { irr: IrrigationInfo }): JSX.Element {
  const { irr } = props;
  return (
    <Fragment>
      <ExpertSection title={['Bewässerungs-Controller', 'Irrigation controller']} testId="lg2-expert-irr-controller">
        <ExpertMetrics>
          <M v={irr.mode} label={['Modus', 'Mode']} />
          <M v={irr.autoMode ? t('auto', 'auto') : t('manuell', 'manual')} label={['Automatik', 'Automation']} />
          <M v={irr.connected ? t('verbunden', 'connected') : t('getrennt', 'offline')} label={['Verbindung', 'Connection']} />
          <M v={irr.cloud ? t('Cloud', 'Cloud') : t('lokal', 'local')} label={['Quelle', 'Source']} />
          <M v={irr.et0TodayMm == null ? '–' : `${n1(irr.et0TodayMm)} mm`} label={['ET₀ heute', 'ET₀ today']} />
          <M v={irr.rainTodayMm == null ? '–' : `${n1(irr.rainTodayMm)} mm`} label={['Regen heute', 'Rain today']} />
          <M v={irr.rainForecastMm == null ? '–' : `${n1(irr.rainForecastMm)} mm`} label={['Regen-Prognose', 'Rain forecast']} />
          <M v={irr.pvSurplusKw == null ? '–' : `${n1(irr.pvSurplusKw)} kW`} label={['PV-Überschuss', 'PV surplus']} />
          <M v={irr.mowerActive ? t('aktiv', 'active') : t('inaktiv', 'idle')} label={['Mäher', 'Mower']} />
          <M v={`${Math.round(irr.totalSecondsUsedToday / 60)} min`} label={['Heute bewässert', 'Watered today']} />
        </ExpertMetrics>
        {irr.error != null && irr.error !== '' && <p class="lg2-settings__hint" style={{ color: 'var(--lg2-red)' }}>{irr.error}</p>}
      </ExpertSection>

      <ExpertSection title={['Zonen-Telemetrie (vollständig)', 'Zone telemetry (full)']} testId="lg2-expert-irr-zones"
        hint={['Bodenfeuchte/-temp, Aktivität, Zeitfenster, nächste Fahrt, gelernte Kc-/Niederschlagsfaktoren und Priorität je Zone.',
          'Soil moisture/temp, activity, window, next run, learned Kc/precip factors and priority per zone.']}>
        <div class="lg2-exp-table">
          {irr.zones.map((z) => (
            <div class="lg2-exp-zone" key={z.id}>
              <div class="lg2-exp-risk__head">
                <span class="lg2-exp-risk__name">{z.name}{z.plant !== '' ? ` · ${z.plant}` : ''}</span>
                <span class="lg2-exp-risk__stat">{t('Ventil', 'Valve')} <b>{z.valveOn === true ? t('an', 'on') : z.valveOn === false ? t('aus', 'off') : '–'}</b></span>
                <span class="lg2-exp-risk__stat">{t('Priorität', 'Priority')} <b>{z.priority}</b></span>
                <span class="lg2-exp-risk__stat">{z.enabled ? t('aktiv', 'enabled') : t('deaktiviert', 'disabled')}</span>
              </div>
              <div class="lg2-exp-zone__grid">
                <span><b>{z.soilMoisturePct == null ? '–' : `${Math.round(z.soilMoisturePct)} %`}</b>{t('Bodenfeuchte', 'Soil moisture')}</span>
                <span><b>{z.soilTempC == null ? '–' : `${n1(z.soilTempC)} °C`}</b>{t('Bodentemp.', 'Soil temp.')}</span>
                <span><b>{n1(z.depletionMm)} mm</b>{t('Defizit', 'Depletion')}</span>
                <span><b>{n1(z.rawMm)}/{n1(z.tawMm)} mm</b>RAW/TAW</span>
                <span><b>{n1(z.dailyNeedMm)} mm</b>{t('Tagesbedarf', 'Daily need')}</span>
                <span><b>{Math.round(z.availablePct)} %</b>{t('verfügbar', 'available')}</span>
                <span><b>{z.windowStartHour}–{z.windowEndHour} {t('Uhr', 'h')}</b>{t('Zeitfenster', 'Window')}</span>
                <span><b>{z.nextWateringTs != null ? hms(z.nextWateringTs) : (z.hoursUntilNext == null ? '–' : `+${Math.round(z.hoursUntilNext)} h`)}</b>{t('Nächste Fahrt', 'Next run')}</span>
                <span><b>{z.plannedNextSeconds == null ? '–' : `${Math.round(z.plannedNextSeconds / 60)} min`}</b>{t('geplante Dauer', 'planned duration')}</span>
                <span><b>{n1(z.learned.kcFactor)}</b>Kc</span>
                <span><b>{n1(z.learned.precipRateFactor)}</b>{t('Niederschlagsfaktor', 'Precip factor')}</span>
                <span><b>{z.learned.sampleDays}</b>{t('Lerntage', 'Learn days')}</span>
              </div>
              {(z.blockedBy != null || z.learned.emitterFault || (z.learned.note ?? '') !== '') && (
                <p class="lg2-settings__hint">
                  {z.blockedBy != null ? `${t('Blockiert', 'Blocked')}: ${z.blockedBy}. ` : ''}
                  {z.learned.emitterFault ? `${t('Emitter-Fehler erkannt', 'Emitter fault detected')}. ` : ''}
                  {z.learned.note ?? ''}
                </p>
              )}
            </div>
          ))}
        </div>
      </ExpertSection>

      {(irr.plan ?? []).length > 0 && (
        <ExpertSection title={['Tagesplan (day-ahead)', 'Day-ahead plan']} testId="lg2-expert-irr-plan">
          <div class="lg2-exp-table">
            {(irr.plan ?? []).map((p) => (
              <div class="lg2-exp-row" key={p.id}>
                <span class="lg2-exp-row__time">{hms(p.startTs)}</span>
                <span class="lg2-exp-row__name">{p.zoneName}</span>
                <span class="lg2-exp-row__val">{p.durationMin} min</span>
                <span class="lg2-exp-row__state">{p.source}{p.done ? ` · ${t('erledigt', 'done')}` : ''}</span>
                <span class="lg2-exp-row__reason">{p.enabled ? t('aktiv', 'enabled') : t('deaktiviert', 'disabled')}</span>
              </div>
            ))}
          </div>
        </ExpertSection>
      )}
    </Fragment>
  );
}

/* -------------------------------------------------------------------------- */
/* Manual valve control (Tasks 11.12 duration dropdown + 11.13 single-valve)  */
/* -------------------------------------------------------------------------- */

/** Duration options: 5-minute steps up to 90 minutes (task 11.12). */
const DURATION_MINUTES: number[] = Array.from({ length: 18 }, (_, i) => (i + 1) * 5);

function ValveControl(props: { zones: IrrigationZoneView[] }): JSX.Element {
  const { zones } = props;
  // Per-zone selected run duration (minutes); default 5 min.
  const [durations, setDurations] = useState<Record<string, number>>({});
  const durationOf = (id: string): number => durations[id] ?? 5;
  const setDuration = (id: string, min: number): void =>
    setDurations((prev) => ({ ...prev, [id]: min }));

  /**
   * Task 11.13 — only ONE valve may be open at a time (shared water supply).
   * Opening a zone first stops every OTHER currently-running zone, then starts
   * the selected zone for the chosen duration.
   */
  const openExclusively = (zoneId: string): void => {
    for (const other of zones) {
      if (other.id !== zoneId && other.valveOn === true) {
        void stopIrrigationZone(other.id);
      }
    }
    void runIrrigationZone(zoneId, durationOf(zoneId) * 60);
  };

  const anyOtherRunning = (zoneId: string): boolean =>
    zones.some((z) => z.id !== zoneId && z.valveOn === true);

  return (
    <div class="lg2-card lg2-garden__expert" data-testid="lg2-expert-garden-control">
      <h3 class="lg2-card__title">{t('Manuelle Ventilsteuerung', 'Manual valve control')}</h3>
      <p class="lg2-settings__hint">
        {t('Es kann immer nur ein Ventil gleichzeitig geöffnet sein — beim Öffnen eines Ventils werden alle anderen automatisch geschlossen.',
          'Only one valve can be open at a time — opening a valve automatically closes all others.')}
      </p>
      <div class="lg2-garden__valvectl">
        {zones.map((z) => (
          <div class="lg2-garden__valverow" key={z.id}>
            <span class="lg2-garden__valvename">
              {z.name}
              <small>{z.valveOn === true ? t('läuft', 'running') : t('aus', 'off')}</small>
            </span>
            <label class="lg2-garden__valvedur">
              <span class="lg2-garden__valvedur-lbl">{t('Dauer', 'Duration')}</span>
              <select class="lg2-cfg__select" value={String(durationOf(z.id))}
                onChange={(e): void => setDuration(z.id, Number((e.currentTarget as HTMLSelectElement).value))}>
                {DURATION_MINUTES.map((m) => (
                  <option key={m} value={String(m)}>{m} min</option>
                ))}
              </select>
            </label>
            <span class="lg2-garden__valvebtns">
              <button type="button" class="lg2-btn" onClick={(): void => { openExclusively(z.id); }}>
                {t('Bewässern', 'Water')}
                {anyOtherRunning(z.id) ? ` (${t('schließt andere', 'closes others')})` : ''}
              </button>
              <button type="button" onClick={(): void => { void stopIrrigationZone(z.id); }}>{t('Stopp', 'Stop')}</button>
              <button type="button" onClick={(): void => { void skipIrrigationZone(z.id); }}>{t('Heute überspringen', 'Skip today')}</button>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function GardenHeader(props: { onManage?: () => void; lever?: boolean }): JSX.Element {
  return (
    <header class="lg2-header">
      <div>
        <h1 class="lg2-header__title">{t('Garten', 'Garden')}</h1>
        <p class="lg2-header__sub">{t('Bewässerung im Blick', 'Irrigation at a glance')}</p>
      </div>
      <div class="lg2-header__right">
        {props.lever === true && <Lg2IrrigationLever />}
        {props.onManage !== undefined && (
          <button type="button" class="lg2-btn" onClick={props.onManage}>
            <Icon name="einstellungen" size={16} /> {t('Bewässerungsplan & Regelung', 'Watering plan & rules')}
          </button>
        )}
      </div>
    </header>
  );
}

/**
 * Compact automatic-irrigation lever for the Garten header — mirrors the
 * automation lever on Übersicht/Automatik, labelled "Bewässerung". Toggles
 * `config.irrigation.enabled` via `/api/config`.
 */
function Lg2IrrigationLever(): JSX.Element {
  const { config, save } = useConfig();
  const cfg = config.value;
  const on = cfg?.irrigation?.enabled ?? false;
  const toggle = (): void => {
    if (cfg === null) return;
    void save({ ...cfg, irrigation: { ...cfg.irrigation, enabled: !on } });
  };
  return (
    <button type="button" role="switch" aria-checked={on}
      class={`lg2-autolever${on ? ' lg2-autolever--on' : ''}`}
      data-testid="lg2-garden-auto" disabled={cfg === null}
      title={on
        ? t('Automatische Bewässerung aktiv — tippen zum Ausschalten', 'Automatic irrigation active — tap to turn off')
        : t('Automatische Bewässerung aus — tippen zum Einschalten', 'Automatic irrigation off — tap to turn on')}
      onClick={toggle}>
      <span class="lg2-autolever__text">
        <span class="lg2-autolever__lbl">{t('Bewässerung', 'Irrigation')}</span>
        <span class="lg2-autolever__state">{on ? t('Aktiv', 'Active') : t('Aus', 'Off')}</span>
      </span>
      <span class="lg2-autolever__track"><span class="lg2-autolever__knob" /></span>
    </button>
  );
}

function HeroStat(props: { value: string; label: string; sub: string; tone?: string }): JSX.Element {
  return (
    <div class="lg2-garden__hstat">
      <span class="lg2-garden__hstat-val">{props.value}</span>
      <span class="lg2-garden__hstat-lbl">{props.label}</span>
      <span class="lg2-garden__hstat-sub" style={props.tone !== undefined ? { color: props.tone } : undefined}>{props.sub}</span>
    </div>
  );
}

function ZoneRow(props: { zone: IrrigationZoneView }): JSX.Element {
  const z = props.zone;
  const moist = z.soilMoisturePct ?? z.availablePct;
  const tone = moistTone(moist);
  const running = z.valveOn === true;
  const next = z.nextWateringTs !== null ? whenLabel(z.nextWateringTs) : (z.nextActionLabel || t('—', '—'));
  return (
    <div class="lg2-garden__zrow" data-testid={`lg2-zrow-${z.id}`}>
      <div class="lg2-garden__zname">
        <span class="lg2-garden__zicon" style={{ color: TONE_COLOR[tone] }}><Icon name="tropfen" size={18} /></span>
        <div><b>{z.name}</b><em>{z.plant !== '' ? z.plant : t('Zone', 'Zone')}</em></div>
      </div>
      <div class="lg2-garden__zmoist">
        <span class="lg2-garden__zgauge"><span class="lg2-garden__zgauge-fill" style={{ width: `${moist === null ? 0 : Math.max(4, Math.min(100, moist))}%`, background: TONE_COLOR[tone] }} /></span>
        <span class="lg2-garden__zpct">{moist === null ? '–' : `${Math.round(moist)} %`}<em style={{ color: TONE_COLOR[tone] }}>{t(...TONE_LABEL[tone])}</em></span>
      </div>
      <div class="lg2-garden__zstatus">
        {running
          ? <Fragment><span class="lg2-dot lg2-dot--ok" /> {t('läuft', 'running')}</Fragment>
          : z.blockedBy !== null
            ? <Fragment><span class="lg2-dot lg2-dot--mid" /> {z.blockedBy}</Fragment>
            : <Fragment><span class="lg2-garden__zok" style={{ color: TONE_COLOR[tone] }}><Icon name="tropfen" size={13} /></span> {t('OK', 'OK')}</Fragment>}
      </div>
      <div class="lg2-garden__znext">{next}</div>
    </div>
  );
}

/** SVG bar (rain + ET₀) + balance line chart over the collected days. */
function BalanceChart(props: { hist: DayBal[] }): JSX.Element {
  const days = props.hist;
  if (days.length === 0) {
    return <div class="lg2-garden__chart-empty">{t('Sammelt Verlaufsdaten … die Wasserbilanz baut sich über die nächsten Tage auf.', 'Collecting history … the water balance builds up over the coming days.')}</div>;
  }
  const W = 100;
  const maxV = Math.max(5, ...days.map((d) => Math.max(d.rainMm, d.et0Mm, Math.abs(d.balanceMm))));
  const y0 = 55; // zero line (%)
  const scale = 42 / maxV; // px per mm within band
  const bw = (W / days.length) * 0.28;
  const cx = (i: number): number => (i + 0.5) / days.length * W;
  const balPts = days.map((d, i) => `${i === 0 ? 'M' : 'L'} ${cx(i).toFixed(1)} ${(y0 - d.balanceMm * scale).toFixed(1)}`).join(' ');
  return (
    <div class="lg2-garden__chart">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" class="lg2-garden__chartsvg" aria-hidden="true">
        <line x1="0" y1={y0} x2="100" y2={y0} stroke="var(--lg2-hairline-2)" stroke-width="0.5" vector-effect="non-scaling-stroke" />
        {days.map((d, i) => (
          <Fragment key={d.date}>
            <rect x={cx(i) - bw - 0.6} y={y0 - d.rainMm * scale} width={bw} height={Math.max(0.5, d.rainMm * scale)} rx="0.6" fill="#35d6e7" opacity="0.9" />
            <rect x={cx(i) + 0.6} y={y0 - d.et0Mm * scale} width={bw} height={Math.max(0.5, d.et0Mm * scale)} rx="0.6" fill="#4a8cff" opacity="0.85" />
          </Fragment>
        ))}
        <path d={balPts} fill="none" stroke="#ff9f0a" stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <div class="lg2-garden__chart-x">
        {days.map((d) => <span key={d.date}>{new Date(d.date).toLocaleDateString(locale(), { day: 'numeric', month: 'short' })}</span>)}
      </div>
    </div>
  );
}

function nextCheckTime(zones: IrrigationZoneView[]): { value: string; sub: string } {
  const times = zones.map((z) => z.nextWateringTs).filter((x): x is string => x !== null).map((s) => Date.parse(s)).filter((n) => Number.isFinite(n));
  if (times.length === 0) return { value: '–', sub: t('kein Termin', 'no schedule') };
  const soonest = Math.min(...times);
  const d = new Date(soonest);
  return { value: `${dayWord(soonest)} ${fmtTime(d)}`, sub: t('geplante Prüfung', 'scheduled check') };
}
function dayWord(tsMs: number): string {
  const a = new Date(tsMs); a.setHours(0, 0, 0, 0);
  const b = new Date(); b.setHours(0, 0, 0, 0);
  const di = Math.round((a.getTime() - b.getTime()) / 86400000);
  if (di <= 0) return t('Heute', 'Today');
  if (di === 1) return t('Morgen', 'Tomorrow');
  return new Date(tsMs).toLocaleDateString(locale(), { weekday: 'short' });
}
function whenLabel(ts: string): string {
  const ms = Date.parse(ts);
  if (!Number.isFinite(ms)) return '—';
  return `${dayWord(ms)} ${fmtTime(new Date(ms))}`;
}

function GardenSkeleton(): JSX.Element {
  return (
    <div data-testid="lg2-garden-skeleton" aria-hidden="true" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div class="lg2-sk" style={{ height: '44px', width: '240px' }} />
      <div class="lg2-sk" style={{ height: '150px', borderRadius: '20px' }} />
      <div class="lg2-sk" style={{ height: '46vh', borderRadius: '20px' }} />
    </div>
  );
}
