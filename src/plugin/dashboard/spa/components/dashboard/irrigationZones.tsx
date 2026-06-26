/**
 * Heat Shield — irrigation zones panel (Bewässerung / Irrigation tab).
 *
 * Global KPIs, an editable day-ahead plan (drag-to-move timeline + list) and
 * per-zone cards (gauge, water balance, forecast, learned calibration, the
 * decision "why", a duration picker and a soil calibration control). Fully
 * bilingual via `t` / `tServer`.
 */

import { Fragment, h, type JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

import type {
  IrrigationInfo,
  IrrigationPlanEntryView,
  IrrigationZoneView,
} from '../../types.js';
import {
  addPlanEntry,
  calibrateIrrigationZone,
  deletePlanEntry,
  runIrrigationZone,
  skipIrrigationZone,
  stopIrrigationZone,
  updatePlanEntry,
} from '../../hooks/useControl.js';
import { t, tServer, fmtNum, fmtTime, locale } from '../../i18n.js';

function modeLabel(mode: string): string {
  switch (mode) {
    case 'off': return t('Aus', 'Off');
    case 'eco': return 'Eco';
    case 'normal': return t('Normal', 'Normal');
    case 'heat': return t('Hitze', 'Heat');
    case 'vacation': return t('Urlaub', 'Vacation');
    case 'establishment': return t('Anwuchs', 'Establishment');
    default: return mode;
  }
}

/** Localized plant-type label for the zone badge (mirrors the settings tab). */
function plantLabel(plant: string): string {
  switch (plant) {
    case 'lawn': return t('Rasen', 'Lawn');
    case 'bed': return t('Beet', 'Bed');
    case 'hedge': return t('Hecke', 'Hedge');
    case 'vegetable': return t('Gemüse', 'Vegetables');
    case 'pot': return t('Topf', 'Pot');
    case 'tree': return t('Baum/Strauch', 'Tree/shrub');
    default: return plant;
  }
}

/** Manual watering durations offered by the picker (minutes). */
const DURATIONS_MIN = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60] as const;

function n1(v: number): string {
  return fmtNum(v, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function fmtMinutes(seconds: number): string {
  if (seconds <= 0) return '0 min';
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}

function fmtEta(hours: number | null): string {
  if (hours === null) return t('> 3 Tage', '> 3 days');
  if (hours <= 1) return t('in ≤ 1 h', 'in ≤ 1 h');
  if (hours < 24) return t(`in ${Math.round(hours)} h`, `in ${Math.round(hours)} h`);
  return t(`in ${Math.round(hours / 24)} Tg`, `in ${Math.round(hours / 24)} d`);
}

function gaugeColor(pct: number): string {
  if (pct >= 60) return '#34d399';
  if (pct >= 35) return '#fbbf24';
  return '#f87171';
}

function ZoneCard(props: { zone: IrrigationZoneView }): JSX.Element {
  const z = props.zone;
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [durationMin, setDurationMin] = useState(15);
  const [calibrating, setCalibrating] = useState(false);
  const [calPct, setCalPct] = useState(z.availablePct);
  const moisture = z.soilMoisturePct;
  const gaugePct = moisture ?? z.availablePct;

  const act = async (fn: () => Promise<boolean>): Promise<void> => {
    setBusy(true);
    await fn();
    setBusy(false);
  };

  const startWatering = async (): Promise<void> => {
    setPicking(false);
    await act(() => runIrrigationZone(z.id, durationMin * 60));
  };

  const applyCalibration = async (): Promise<void> => {
    setCalibrating(false);
    await act(() => calibrateIrrigationZone(z.id, calPct));
  };

  return (
    <article class="irr-zone" data-testid={`irr-zone-${z.id}`}>
      <header class="irr-zone__head">
        <h3>{z.name}</h3>
        <span class={`irr-zone__badge irr-zone__badge--${z.priority}`}>{plantLabel(z.plant)}</span>
      </header>

      <div class="irr-zone__body">
        <div class="irr-gauge" style={{ '--g': `${gaugePct}%`, '--gc': gaugeColor(gaugePct) }}>
          <span class="irr-gauge__val">{Math.round(gaugePct)}%</span>
          <span class="irr-gauge__lbl">{moisture !== null ? t('Bodenfeuchte', 'Soil moisture') : t('Verfügbar', 'Available')}</span>
        </div>
        <dl class="irr-zone__facts">
          <div>
            <dt>{t('Defizit', 'Deficit')}</dt>
            <dd>{n1(z.depletionMm)} / {fmtNum(z.rawMm, { maximumFractionDigits: 0 })} mm</dd>
          </div>
          <div>
            <dt>{t('Bedarf heute', 'Demand today')}</dt>
            <dd>{n1(z.dailyNeedMm)} mm</dd>
          </div>
          <div>
            <dt>{t('Nächste Gabe', 'Next watering')}</dt>
            <dd>{fmtEta(z.hoursUntilNext)}</dd>
          </div>
          <div>
            <dt>{t('Heute bewässert', 'Watered today')}</dt>
            <dd>{fmtMinutes(z.dailySecondsUsed)}</dd>
          </div>
          <div>
            <dt>{t('Zeitfenster', 'Window')}</dt>
            <dd>
              {z.windowStartHour === z.windowEndHour
                ? '24 h'
                : `${z.windowStartHour}–${z.windowEndHour} ${t('Uhr', 'h')}`}
            </dd>
          </div>
          <div>
            <dt>{t('Offen bis', 'Open until')}</dt>
            <dd>{z.openUntilTs === null ? '–' : fmtTime(z.openUntilTs)}</dd>
          </div>
        </dl>
      </div>

      <p class={`irr-zone__why${z.blockedBy !== null ? ' irr-zone__why--blocked' : ''}`}>
        {z.valveOn === true ? `💧 ${t('bewässert gerade', 'watering now')} · ` : ''}
        {tServer(z.nextActionLabel)}
      </p>

      {z.learned.emitterFault && (
        <p class="irr-zone__fault">⚠ {tServer(z.learned.note)}</p>
      )}
      {!z.learned.emitterFault && z.learned.sampleDays > 0 && (
        <p class="irr-zone__learn">
          {t('gelernt', 'learned')}: Kc×{z.learned.kcFactor.toFixed(2)} · {t('Abgabe', 'output')}×{z.learned.precipRateFactor.toFixed(2)} ({z.learned.sampleDays} {t('Tg', 'd')})
        </p>
      )}

      {z.forecastPoints.length > 1 && (
        <div class="irr-zone__spark-wrap">
          <span class="irr-zone__sparklbl">{t('Bodenwasser-Prognose · 3 Tage', 'Soil-water forecast · 3 days')}</span>
          <svg class="irr-spark" viewBox="0 0 100 24" preserveAspectRatio="none" role="img"
            aria-label={t('Prognose des verfügbaren Bodenwassers über die nächsten 3 Tage', 'Forecast of available soil water over the next 3 days')}>
            <title>{t('Verfügbares Bodenwasser (Prognose, nächste ~3 Tage)', 'Available soil water (forecast, next ~3 days)')}</title>
            <polyline
              points={z.forecastPoints
                .map((p, i) => {
                  const x = (i / (z.forecastPoints.length - 1)) * 100;
                  const y = 24 - (p.availablePct / 100) * 22 - 1;
                  return `${x.toFixed(1)},${y.toFixed(1)}`;
                })
                .join(' ')}
              fill="none"
              stroke="#38bdf8"
              stroke-width="1.5"
            />
          </svg>
        </div>
      )}

      {picking ? (
        <div class="irr-zone__picker" data-testid={`irr-picker-${z.id}`}>
          <label class="irr-zone__picker-lbl">
            <span>{t('Dauer', 'Duration')}</span>
            <select
              value={String(durationMin)}
              onChange={(e): void =>
                setDurationMin(Number.parseInt((e.currentTarget as HTMLSelectElement).value, 10))
              }
            >
              {DURATIONS_MIN.map((m) => (
                <option key={m} value={String(m)}>{m} min</option>
              ))}
            </select>
          </label>
          <div class="irr-zone__picker-actions">
            <button type="button" class="irr-btn" disabled={busy} onClick={() => void startWatering()}>
              {t('Start', 'Start')}
            </button>
            <button type="button" class="irr-btn irr-btn--ghost" onClick={() => setPicking(false)}>
              {t('Abbrechen', 'Cancel')}
            </button>
          </div>
        </div>
      ) : calibrating ? (
        <div class="irr-zone__picker" data-testid={`irr-calib-${z.id}`}>
          <label class="irr-zone__picker-lbl">
            <span>{t(`Boden jetzt: ${Math.round(calPct)} % verfügbar`, `Soil now: ${Math.round(calPct)} % available`)}</span>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={calPct}
              onInput={(e): void =>
                setCalPct(Number.parseInt((e.currentTarget as HTMLInputElement).value, 10))
              }
            />
          </label>
          <div class="irr-zone__picker-actions">
            <button type="button" class="irr-btn" disabled={busy} onClick={() => void applyCalibration()}>
              {t('Übernehmen', 'Apply')}
            </button>
            <button type="button" class="irr-btn irr-btn--ghost" onClick={() => setCalibrating(false)}>
              {t('Abbrechen', 'Cancel')}
            </button>
          </div>
        </div>
      ) : (
        <div class="irr-zone__actions">
          <button
            type="button"
            class="irr-btn"
            disabled={busy || !z.hasValve || z.valveOn === true}
            onClick={() => {
              setDurationMin(15);
              setPicking(true);
            }}
          >
            {t('Bewässern', 'Water')}
          </button>
          <button
            type="button"
            class="irr-btn irr-btn--stop"
            disabled={busy || !z.hasValve || z.valveOn !== true}
            onClick={() => void act(() => stopIrrigationZone(z.id))}
          >
            {t('Stopp', 'Stop')}
          </button>
          <button
            type="button"
            class="irr-btn irr-btn--ghost"
            disabled={busy}
            onClick={() => void act(() => skipIrrigationZone(z.id))}
          >
            {t('Heute aus', 'Skip today')}
          </button>
          <button
            type="button"
            class="irr-btn irr-btn--ghost"
            disabled={busy}
            title={t('Modellierten Bodenwasser-Stand auf den tatsächlichen Wert setzen', 'Set the modeled soil-water level to the actual value')}
            onClick={() => {
              setCalPct(z.availablePct);
              setCalibrating(true);
            }}
          >
            {t('Kalibrieren', 'Calibrate')}
          </button>
        </div>
      )}
    </article>
  );
}

/** Local minutes-from-midnight for an ISO timestamp. */
function localMinutes(tsIso: string): number {
  const d = new Date(tsIso);
  return d.getHours() * 60 + d.getMinutes();
}

/** Build an ISO ts on the same local day as `baseIso`, at `minutes` of day. */
function tsWithMinutes(baseIso: string, minutes: number): string {
  const b = new Date(baseIso);
  const d = new Date(b.getFullYear(), b.getMonth(), b.getDate(), Math.floor(minutes / 60), minutes % 60, 0, 0);
  return d.toISOString();
}

function dayKeyOf(tsIso: string): string {
  const d = new Date(tsIso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dayLabel(dateKey: string): string {
  const now = new Date();
  const key = (d: Date): string =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const today = key(now);
  const tmrw = key(new Date(now.getTime() + 86_400_000));
  if (dateKey === today) return t('Heute', 'Today');
  if (dateKey === tmrw) return t('Morgen', 'Tomorrow');
  const [y, m, d] = dateKey.split('-').map((s) => Number.parseInt(s, 10));
  const dt = new Date(y as number, (m as number) - 1, d as number);
  return dt.toLocaleDateString(locale(), { weekday: 'long', day: '2-digit', month: '2-digit' });
}

function hhmm(tsIso: string): string {
  return fmtTime(tsIso);
}

/** A single day's draggable timeline track. */
function TimelineDay(props: {
  dateKey: string;
  entries: IrrigationPlanEntryView[];
  onMove: (id: string, minutes: number) => void;
}): JSX.Element {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<
    { id: string; minutes: number; offset: number; left: number; width: number } | null
  >(null);

  const snap = (raw: number): number => Math.round(raw / 5) * 5;

  const onDown = (e: PointerEvent, entry: IrrigationPlanEntryView): void => {
    const el = trackRef.current;
    if (el === null) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const rect = el.getBoundingClientRect();
    const pointerMin = snap(((e.clientX - rect.left) / rect.width) * 1440);
    const cur = localMinutes(entry.startTs);
    setDrag({ id: entry.id, minutes: cur, offset: pointerMin - cur, left: rect.left, width: rect.width });
    e.preventDefault();
  };
  const onMovePtr = (e: PointerEvent, entry: IrrigationPlanEntryView): void => {
    if (drag === null || drag.id !== entry.id || drag.width <= 0) return;
    const raw = snap(((e.clientX - drag.left) / drag.width) * 1440);
    const next = Math.min(1435, Math.max(0, raw - drag.offset));
    if (next !== drag.minutes) setDrag({ ...drag, minutes: next });
  };
  const onUp = (entry: IrrigationPlanEntryView): void => {
    if (drag !== null && drag.id === entry.id) {
      if (drag.minutes !== localMinutes(entry.startTs)) props.onMove(entry.id, drag.minutes);
    }
    setDrag(null);
  };

  return (
    <div class="irr-tl">
      <div class="irr-tl__day">{dayLabel(props.dateKey)}</div>
      <div class="irr-tl__track" ref={trackRef} data-testid={`irr-tl-${props.dateKey}`}>
        {[0, 6, 12, 18].map((hr) => (
          <span key={hr} class="irr-tl__tick" style={{ left: `${(hr / 24) * 100}%` }}>
            {hr}
          </span>
        ))}
        {props.entries.map((e) => {
          const mins = drag !== null && drag.id === e.id ? drag.minutes : localMinutes(e.startTs);
          const leftPct = (mins / 1440) * 100;
          const widthPct = Math.max(4, (e.durationMin / 1440) * 100);
          return (
            <div
              key={e.id}
              class={`irr-tl__block${e.enabled ? '' : ' irr-tl__block--off'}${e.done ? ' irr-tl__block--done' : ''}${e.source === 'auto' ? ' irr-tl__block--auto' : ''}`}
              style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
              title={`${e.zoneName} · ${hhmm(e.startTs)} · ${e.durationMin} min`}
              onPointerDown={(ev): void => onDown(ev as unknown as PointerEvent, e)}
              onPointerMove={(ev): void => onMovePtr(ev as unknown as PointerEvent, e)}
              onPointerUp={(): void => onUp(e)}
            >
              <span class="irr-tl__block-label">
                {e.zoneName} · {drag !== null && drag.id === e.id
                  ? `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`
                  : hhmm(e.startTs)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Editable day-ahead plan (drag timeline + list + add row), optimistic. */
function DayAheadPlan(props: { plan: IrrigationPlanEntryView[]; zones: IrrigationZoneView[] }): JSX.Element {
  const [addZone, setAddZone] = useState('');
  const [addTime, setAddTime] = useState('06:00');
  const [addDur, setAddDur] = useState(15);
  const [err, setErr] = useState<string | null>(null);
  const [local, setLocal] = useState<IrrigationPlanEntryView[] | null>(null);
  const lastEdit = useRef(0);

  useEffect(() => {
    if (Date.now() - lastEdit.current > 2500) setLocal(null);
  }, [props.plan]);

  const plan = local ?? props.plan;

  const applyLocal = (next: IrrigationPlanEntryView[], op: Promise<boolean>): void => {
    lastEdit.current = Date.now();
    setLocal(next);
    void op.then((ok) => {
      if (!ok) {
        setErr(t(
          'Überschneidung – es darf nie mehr als ein Ventil gleichzeitig offen sein.',
          'Overlap – never more than one valve open at a time.',
        ));
        setLocal(null);
      } else {
        setErr(null);
      }
    });
  };

  const durOptions = (cur: number): number[] => {
    const set = new Set<number>(DURATIONS_MIN);
    if (cur > 0) set.add(cur);
    return Array.from(set).sort((a, b) => a - b);
  };

  const move = (id: string, minutes: number): void => {
    const entry = plan.find((e) => e.id === id);
    if (entry === undefined) return;
    const startTs = tsWithMinutes(entry.startTs, minutes);
    const next = plan.map((e) => (e.id === id ? { ...e, startTs, source: 'manual' as const } : e));
    applyLocal(next, updatePlanEntry(id, { startTs }));
  };
  const setTime = (entry: IrrigationPlanEntryView, value: string): void => {
    const [h, m] = value.split(':').map((s) => Number.parseInt(s, 10));
    if (!Number.isFinite(h) || !Number.isFinite(m)) return;
    const startTs = tsWithMinutes(entry.startTs, (h as number) * 60 + (m as number));
    const next = plan.map((e) => (e.id === entry.id ? { ...e, startTs, source: 'manual' as const } : e));
    applyLocal(next, updatePlanEntry(entry.id, { startTs }));
  };
  const setDuration = (entry: IrrigationPlanEntryView, dur: number): void => {
    const next = plan.map((e) => (e.id === entry.id ? { ...e, durationMin: dur, source: 'manual' as const } : e));
    applyLocal(next, updatePlanEntry(entry.id, { durationMin: dur }));
  };
  const toggleEnabled = (entry: IrrigationPlanEntryView, enabled: boolean): void => {
    const next = plan.map((e) => (e.id === entry.id ? { ...e, enabled } : e));
    applyLocal(next, updatePlanEntry(entry.id, { enabled }));
  };
  const del = (id: string): void => {
    applyLocal(plan.filter((e) => e.id !== id), deletePlanEntry(id));
  };

  const doAdd = (): void => {
    const zoneId = addZone !== '' ? addZone : (props.zones[0]?.id ?? '');
    if (zoneId === '') return;
    const [h, m] = addTime.split(':').map((s) => Number.parseInt(s, 10));
    const now = new Date();
    let start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h as number, m as number, 0, 0);
    if (start.getTime() <= now.getTime()) start = new Date(start.getTime() + 86_400_000);
    const startTs = start.toISOString();
    const zoneName = props.zones.find((z) => z.id === zoneId)?.name ?? zoneId;
    const temp: IrrigationPlanEntryView = {
      id: `tmp-${Date.now()}`,
      zoneId,
      zoneName,
      startTs,
      durationMin: addDur,
      enabled: true,
      source: 'manual',
      done: false,
    };
    applyLocal([...plan, temp], addPlanEntry(zoneId, startTs, addDur));
  };

  const byDay = new Map<string, IrrigationPlanEntryView[]>();
  for (const e of [...plan].sort((a, b) => Date.parse(a.startTs) - Date.parse(b.startTs))) {
    const k = dayKeyOf(e.startTs);
    byDay.set(k, [...(byDay.get(k) ?? []), e]);
  }
  const dayKeys = Array.from(byDay.keys());

  return (
    <article class="module-panel__card irr-plan" data-testid="irr-plan">
      <h3>{t('Bewässerungsplan · verschiebbar', 'Irrigation plan · draggable')}</h3>
      {err !== null && (
        <p class="irr-plan__err" data-testid="irr-plan-err">{err}</p>
      )}
      {plan.length === 0 ? (
        <p class="module-panel__hint">
          {t(
            'Keine Bewässerung geplant – der Boden hat genug Reserve. Du kannst unten einen Eintrag manuell hinzufügen.',
            'No watering planned – the soil has enough reserve. You can add an entry manually below.',
          )}
        </p>
      ) : (
        <Fragment>
          {dayKeys.map((k) => (
            <TimelineDay key={k} dateKey={k} entries={byDay.get(k) ?? []} onMove={move} />
          ))}
          <ul class="irr-plan__list">
            {[...plan]
              .sort((a, b) => Date.parse(a.startTs) - Date.parse(b.startTs))
              .map((e) => (
                <li key={e.id} class="irr-plan__item" data-testid={`irr-plan-item-${e.id}`}>
                  <label class="irr-plan__chk" title={t('Aktiv', 'Active')}>
                    <input
                      type="checkbox"
                      checked={e.enabled}
                      onChange={(ev): void => toggleEnabled(e, (ev.currentTarget as HTMLInputElement).checked)}
                    />
                  </label>
                  <span class="irr-plan__zone">
                    {e.zoneName}
                    {e.done ? ' ✓' : ''}
                    {e.source === 'auto' ? t(' · auto', ' · auto') : ''}
                  </span>
                  <input
                    class="irr-plan__time"
                    type="time"
                    value={hhmm(e.startTs)}
                    onChange={(ev): void => setTime(e, (ev.currentTarget as HTMLInputElement).value)}
                  />
                  <select
                    class="irr-plan__dursel"
                    value={String(e.durationMin)}
                    onChange={(ev): void =>
                      setDuration(e, Number.parseInt((ev.currentTarget as HTMLSelectElement).value, 10))
                    }
                  >
                    {durOptions(e.durationMin).map((m) => (
                      <option key={m} value={String(m)}>{m} min</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    class="irr-plan__del"
                    title={t('Eintrag löschen', 'Delete entry')}
                    onClick={(): void => del(e.id)}
                  >
                    ✕
                  </button>
                </li>
              ))}
          </ul>
        </Fragment>
      )}

      <div class="irr-plan__add" data-testid="irr-plan-add">
        <select value={addZone} onChange={(e): void => setAddZone((e.currentTarget as HTMLSelectElement).value)}>
          <option value="">{t('Zone wählen…', 'Choose zone…')}</option>
          {props.zones.map((z) => (
            <option key={z.id} value={z.id}>{z.name}</option>
          ))}
        </select>
        <input type="time" value={addTime} onInput={(e): void => setAddTime((e.currentTarget as HTMLInputElement).value)} />
        <select value={String(addDur)} onChange={(e): void => setAddDur(Number.parseInt((e.currentTarget as HTMLSelectElement).value, 10))}>
          {DURATIONS_MIN.map((m) => (
            <option key={m} value={String(m)}>{m} min</option>
          ))}
        </select>
        <button type="button" class="irr-btn" onClick={doAdd}>{t('+ Eintrag', '+ Entry')}</button>
      </div>

      <p class="module-panel__hint irr-plan__note">
        {t(
          'Blöcke per Drag verschieben oder Zeit/Dauer unten setzen. Auto-Einträge kommen aus dem Forecast; sobald du sie änderst, bleiben sie fix. Es ist immer nur ein Ventil gleichzeitig offen.',
          'Drag blocks to move them, or set time/duration below. Auto entries come from the forecast; once you edit one it stays fixed. Only one valve is ever open at a time.',
        )}
      </p>
    </article>
  );
}

export function IrrigationZones(props: { info: IrrigationInfo }): JSX.Element {
  const i = props.info;
  const kpi = (label: string, value: string, testId: string): JSX.Element => (
    <div class="irr-kpi" data-testid={testId}>
      <span class="irr-kpi__lbl">{label}</span>
      <span class="irr-kpi__val">{value}</span>
    </div>
  );

  return (
    <section class="irrigation-zones" data-testid="irrigation-zones">
      <header class="irrigation-zones__head">
        <h2>{t('Bewässerung · Zonen', 'Irrigation · Zones')}</h2>
        <span class={`irr-mode irr-mode--${i.mode}`}>
          {i.autoMode ? `${t('Auto', 'Auto')} · ` : ''}
          {modeLabel(i.mode)}
        </span>
      </header>

      <div class="irr-kpis">
        {kpi('ET₀ ' + t('heute', 'today'), i.et0TodayMm === null ? '–' : `${n1(i.et0TodayMm)} mm`, 'irr-kpi-et0')}
        {kpi(t('Regen heute', 'Rain today'), i.rainTodayMm === null ? '–' : `${n1(i.rainTodayMm)} mm`, 'irr-kpi-rain')}
        {kpi(t('Regen-Prognose', 'Rain forecast'), i.rainForecastMm === null ? '–' : `${n1(i.rainForecastMm)} mm`, 'irr-kpi-rainfc')}
        {kpi(t('PV-Überschuss', 'PV surplus'), i.pvSurplusKw === null ? '–' : `${n1(i.pvSurplusKw)} kW`, 'irr-kpi-pv')}
        {kpi(t('Heute gesamt', 'Total today'), fmtMinutes(i.totalSecondsUsedToday), 'irr-kpi-total')}
        {kpi(t('Automatik', 'Automatic'), i.enabled ? t('an', 'on') : t('aus', 'off'), 'irr-kpi-auto')}
      </div>

      {!i.enabled && (
        <p class="module-panel__hint">
          {t('Automatische Bewässerung ist aus.', 'Automatic irrigation is off.')}{' '}
          {t(
            'Du kannst Zonen manuell steuern; aktiviere die Automatik mit dem Schalter oben.',
            'You can control zones manually; enable automation with the switch above.',
          )}
        </p>
      )}

      {i.zones.length === 0 ? (
        <p class="module-panel__hint">
          {t(
            'Noch keine Zonen angelegt. Lege unter Einstellungen → Bewässerung Zonen an und ordne ihnen je ein Gardena-Ventil (und optional einen Bodenfeuchte-Sensor) zu.',
            'No zones yet. Create zones under Settings → Irrigation and assign each a Gardena valve (and optionally a soil-moisture sensor).',
          )}
        </p>
      ) : (
        <Fragment>
          <DayAheadPlan plan={i.plan} zones={i.zones} />
          <div class="irr-zone-grid">
            {i.zones.map((z) => (
              <ZoneCard key={z.id} zone={z} />
            ))}
          </div>
        </Fragment>
      )}
    </section>
  );
}
