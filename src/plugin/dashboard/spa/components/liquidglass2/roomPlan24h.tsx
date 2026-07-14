/**
 * Heat Shield — "24-Stunden-Plan" per room (bug report item 6).
 *
 * A transparent, explainable day-ahead plan for a single room: the predicted
 * indoor-temperature curve (from the live per-room forecast trajectory), the
 * comfort ceiling, the outdoor-temperature context, and — as annotated points
 * on the time axis — every planned shutter move with its target position and
 * reason. The horizon (12 / 24 / 48 h) is user-selectable and writes
 * `config.rules.planning.horizonHours`, so the engine actually plans that far
 * ahead; nothing here invents data the planner did not produce.
 *
 * All values are honest: `–` / empty states where a source is missing, and a
 * note when the planner's computed horizon is shorter than the requested one.
 */

import { h, Fragment, type JSX } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';

import { t, tServer, fmtNum, fmtTime } from '../../i18n.js';
import { useConfig, scheduleSave } from '../../hooks/useConfig.js';
import { expertMode } from '../../expertMode.js';
import { Icon } from '../icons.js';
import type { Config } from '../../../../../shared/types.js';
import type { DashboardSnapshot, PlannedAction } from '../../types.js';

interface ForecastPoint { ts: string; indoorTempC: number; heatLoad01: number }
type Horizon = 12 | 24 | 48;

interface PlanDecision {
  ts: string;
  ms: number;
  targetPercent: number;
  reason: string;
  state: PlannedAction['state'];
  windowName: string;
  /** Movement direction relative to the previous decision / current position. */
  dir: 'down' | 'up' | 'same';
}

const COMFORT_FALLBACK = 26;

function ms(ts: string): number { return Date.parse(ts); }

/** Coarse 8-point compass label (DE uses O for East). */
function compass8(deg: number): string {
  const dirs = ['N', 'NO', 'O', 'SO', 'S', 'SW', 'W', 'NW'];
  const i = Math.round(((deg % 360) + 360) % 360 / 45) % 8;
  return dirs[i]!;
}

/** Windows that belong to a room (config mapping); falls back to the room's primary window. */
function windowsForRoom(config: Config | null, roomId: string): Set<string> {
  const out = new Set<string>();
  if (config === null) return out;
  for (const w of config.windows) {
    if (w.roomId === roomId) out.add(w.id);
  }
  return out;
}

export function RoomPlan24h(props: { snap: DashboardSnapshot }): JSX.Element {
  const { snap } = props;
  const { config } = useConfig();
  const rooms = snap.roomsDetail ?? [];

  const [roomId, setRoomId] = useState<string>(() => {
    // Prefer a room that is currently warming up (the interesting one).
    const warming = rooms.find((r) => r.trend === 'up');
    return warming?.id ?? rooms[0]?.id ?? '';
  });
  const horizon: Horizon = ((): Horizon => {
    const h4 = config.value?.rules?.planning?.horizonHours ?? 12;
    return h4 >= 48 ? 48 : h4 >= 24 ? 24 : 12;
  })();

  const [points, setPoints] = useState<ForecastPoint[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confidence, setConfidence] = useState<number | null>(null);

  // Keep the room selection valid as rooms load in.
  useEffect(() => {
    if (roomId === '' && rooms.length > 0) setRoomId(rooms[0]!.id);
  }, [rooms, roomId]);

  useEffect(() => {
    if (roomId === '') { setPoints(null); return; }
    let cancelled = false;
    setLoading(true);
    void (async (): Promise<void> => {
      try {
        const res = await fetch(`/api/forecast?roomId=${encodeURIComponent(roomId)}&hours=${horizon}`, {
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        type ForecastRow = { roomId: string; points: ForecastPoint[]; confidence01: number };
        const json = (await res.json()) as unknown;
        if (cancelled) return;
        // The server responds with `{ forecasts: [...] }`; be defensive and also
        // accept a bare array in case the contract ever changes.
        const rows: ForecastRow[] = Array.isArray(json)
          ? (json as ForecastRow[])
          : Array.isArray((json as { forecasts?: unknown })?.forecasts)
            ? ((json as { forecasts: ForecastRow[] }).forecasts)
            : [];
        const mine = rows.find((r) => r.roomId === roomId) ?? rows[0];
        setPoints(mine?.points ?? []);
        setConfidence(mine?.confidence01 ?? null);
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : t('Unbekannter Fehler', 'Unknown error'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return (): void => { cancelled = true; };
  }, [roomId, horizon, snap.ts]);

  const setHorizon = (hz: Horizon): void => {
    const cfg = config.value;
    if (cfg === null) return;
    const cur = cfg.rules.planning;
    const planning = cur !== undefined
      ? { ...cur, horizonHours: hz }
      : {
          horizonHours: hz, timeStepMinutes: 15, deviationToleranceC: 1.5,
          deviationToleranceLoad01: 0.15, plannedMinSecondsBetweenMoves: 10800,
          movementBudgetPerInterval: 1, maxMovesPerDay: 4,
          candidateLevels01: [0, 0.25, 0.5, 0.75, 0.95, 1],
        };
    const next: Config = { ...cfg, rules: { ...cfg.rules, planning } };
    scheduleSave(next, 300);
  };

  const comfortHi = config.value?.rules?.comfort?.maxIndoorTempC ?? COMFORT_FALLBACK;
  const roomWindows = useMemo(() => windowsForRoom(config.value, roomId), [config.value, roomId]);

  const decisions: PlanDecision[] = useMemo(() => {
    const actions = (snap.plannedActions ?? []).filter((a) => roomWindows.has(a.windowId));
    const sorted = actions.slice().sort((a, b) => ms(a.scheduledTs) - ms(b.scheduledTs));
    const winName = (id: string): string => {
      const w = config.value?.windows.find((x) => x.id === id);
      if (w === undefined) return id;
      // Prefer the configured shutter NAME; fall back to type/orientation.
      if (typeof w.name === 'string' && w.name.trim().length > 0) return w.name;
      if (w.type === 'roof_window') return t('Dachfenster', 'Roof window');
      return t(`Fenster ${compass8(w.orientationDeg)}`, `Window ${compass8(w.orientationDeg)}`);
    };
    const out: PlanDecision[] = [];
    const seen = new Set<string>();
    let prev: number | null = null;
    for (const a of sorted) {
      const name = winName(a.windowId);
      // Collapse identical rows from several equally-oriented shutters (same
      // name + time-to-the-minute + target) into one — no confusing duplicates.
      const key = `${new Date(a.scheduledTs).toISOString().slice(0, 16)}|${name}|${a.targetPercent}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const dir: PlanDecision['dir'] = prev === null ? 'same' : a.targetPercent > prev ? 'down' : a.targetPercent < prev ? 'up' : 'same';
      prev = a.targetPercent;
      out.push({
        ts: a.scheduledTs, ms: ms(a.scheduledTs), targetPercent: a.targetPercent,
        reason: a.reason, state: a.state, windowName: name, dir,
      });
    }
    return out;
  }, [snap.plannedActions, roomWindows, config.value]);

  const outdoor = useMemo(() => {
    const tl = (snap.forecastTimeline ?? []).slice().sort((a, b) => ms(a.ts) - ms(b.ts));
    return tl.map((c) => ({ ms: ms(c.ts), tempC: c.tempC })).filter((p) => Number.isFinite(p.ms));
  }, [snap.forecastTimeline]);

  const roomName = rooms.find((r) => r.id === roomId)?.name ?? t('Raum', 'Room');

  return (
    <section class="lg2-card lg2-plan" data-testid="lg2-room-plan">
      <header class="lg2-plan__head">
        <div class="lg2-plan__title">
          <span class="lg2-plan__icon"><Icon name="forecast" size={18} /></span>
          <div>
            <h2>{t('Tagesplan', 'Day-ahead plan')}</h2>
            <p>{t('Erwartete Raumtemperatur und geplante Rollladen-Fahrten mit Begründung.',
              'Expected room temperature and planned shutter moves with reasoning.')}</p>
          </div>
        </div>
        <div class="lg2-plan__controls">
          <label class="lg2-fc__ctl">
            <span>{t('Raum', 'Room')}</span>
            <select class="lg2-cfg__select" value={roomId} data-testid="lg2-plan-room"
              onChange={(e): void => setRoomId((e.currentTarget as HTMLSelectElement).value)}>
              {rooms.length === 0 && <option value="">{t('Keine Räume', 'No rooms')}</option>}
              {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </label>
          <label class="lg2-fc__ctl">
            <span>{t('Horizont', 'Horizon')}</span>
            <div class="lg2-seg" role="tablist">
              {([12, 24, 48] as Horizon[]).map((hz) => (
                <button key={hz} type="button" role="tab" aria-selected={horizon === hz}
                  class={`lg2-seg__btn${horizon === hz ? ' lg2-seg__btn--on' : ''}`}
                  data-testid={`lg2-plan-horizon-${hz}`}
                  onClick={(): void => setHorizon(hz)}>{hz}h</button>
              ))}
            </div>
          </label>
        </div>
      </header>

      {roomId === '' ? (
        <p class="lg2-plan__empty">{t('Noch keine Raumdaten verfügbar. Suche zuerst deine Geräte.', 'No room data yet. Discover your devices first.')}</p>
      ) : loading && points === null ? (
        <p class="lg2-plan__empty">{t('Lade Plan…', 'Loading plan…')}</p>
      ) : error !== null ? (
        <p class="lg2-plan__empty" data-testid="lg2-plan-error">{t('Fehler beim Laden:', 'Error loading:')} {error}</p>
      ) : points === null || points.length < 2 ? (
        <p class="lg2-plan__empty">{t('Für diesen Raum liegt noch kein Prognose-Plan vor (die Engine lernt oder es fehlen Messwerte).',
          'No forecast plan for this room yet (the engine is still learning or measurements are missing).')}</p>
      ) : expertMode.value ? (
        // Basis view stays compact/no-scroll: the temperature/shutter chart is
        // shown only in the Expert view. The planned moves (DecisionList) below
        // remain visible in both.
        <PlanChart points={points} decisions={decisions} outdoor={outdoor} comfortHi={comfortHi} horizon={horizon} roomName={roomName} confidence={confidence} />
      ) : null}

      <DecisionList decisions={decisions} />
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* SVG chart                                                                  */
/* -------------------------------------------------------------------------- */

function PlanChart(props: {
  points: ForecastPoint[];
  decisions: PlanDecision[];
  outdoor: Array<{ ms: number; tempC: number }>;
  comfortHi: number;
  horizon: Horizon;
  roomName: string;
  confidence: number | null;
}): JSX.Element {
  const { points, decisions, outdoor, comfortHi, horizon, confidence } = props;
  const W = 900, H = 300;
  const padL = 40, padR = 16, padT = 18, padB = 34;
  // Interactivity: hover crosshair (nearest forecast point) + selected marker.
  const [hoverMs, setHoverMs] = useState<number | null>(null);
  const [selected, setSelected] = useState<PlanDecision | null>(null);

  const t0 = ms(points[0]!.ts);
  const tPlanEnd = ms(points[points.length - 1]!.ts);
  const tEnd = t0 + horizon * 3600_000;
  const domainEnd = Math.max(tEnd, tPlanEnd);

  const indoorVals = points.map((p) => p.indoorTempC);
  const outdoorIn = outdoor.filter((p) => p.ms >= t0 && p.ms <= domainEnd).map((p) => p.tempC);
  const allTemps = [...indoorVals, ...outdoorIn, comfortHi];
  const tMin = Math.floor(Math.min(...allTemps) - 1);
  const tMax = Math.ceil(Math.max(...allTemps) + 1);
  const tSpan = tMax - tMin || 1;

  const x = (m: number): number => padL + ((m - t0) / (domainEnd - t0)) * (W - padL - padR);
  const y = (c: number): number => padT + (1 - (c - tMin) / tSpan) * (H - padT - padB);

  const indoorPath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(ms(p.ts)).toFixed(1)} ${y(p.indoorTempC).toFixed(1)}`).join(' ');
  const outdoorPath = outdoor.filter((p) => p.ms >= t0 && p.ms <= domainEnd)
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(p.ms).toFixed(1)} ${y(p.tempC).toFixed(1)}`).join(' ');

  // Hour grid ticks aligned to FULL clock hours (not the :20 plan-start minute):
  // start at the next full hour and step every 3 h (12 h view) / 6 h otherwise.
  const stepH = horizon <= 12 ? 3 : 6;
  const stepMs = stepH * 3600_000;
  const ticks: number[] = [];
  for (let m = Math.ceil(t0 / 3600_000) * 3600_000; m <= domainEnd; m += stepMs) ticks.push(m);

  const nearestTemp = (m: number): number => {
    let best = points[0]!; let bd = Infinity;
    for (const p of points) { const d = Math.abs(ms(p.ts) - m); if (d < bd) { bd = d; best = p; } }
    return best.indoorTempC;
  };

  const yComfort = y(comfortHi);
  const shortPlan = tPlanEnd < tEnd - 60 * 60000;

  return (
    <Fragment>
      <div class="lg2-plan__chartwrap">
        <svg class="lg2-plan__svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img"
          aria-label={t(`Temperatur- und Rollladen-Plan für ${props.roomName}`, `Temperature and shutter plan for ${props.roomName}`)}
          onMouseMove={(e): void => {
            const svg = e.currentTarget as unknown as SVGSVGElement;
            const rect = svg.getBoundingClientRect();
            if (rect.width <= 0) return;
            const vbX = ((e.clientX - rect.left) / rect.width) * W;
            const frac = (vbX - padL) / (W - padL - padR);
            const m = t0 + frac * (domainEnd - t0);
            setHoverMs(m >= t0 && m <= domainEnd ? m : null);
          }}
          onMouseLeave={(): void => setHoverMs(null)}>
          {/* danger band above comfort ceiling */}
          <rect x={padL} y={padT} width={W - padL - padR} height={Math.max(0, yComfort - padT)} fill="rgba(255,93,87,0.08)" />
          {/* comfort ceiling */}
          <line x1={padL} y1={yComfort} x2={W - padR} y2={yComfort} stroke="rgba(255,93,87,0.55)" stroke-width="1" stroke-dasharray="5 4" />
          <text x={padL + 4} y={yComfort - 4} class="lg2-plan__axislbl" fill="rgba(255,93,87,0.8)">{t('Komfort', 'Comfort')} {fmtNum(comfortHi, { maximumFractionDigits: 0 })}°</text>

          {/* y grid + labels */}
          {[tMin, Math.round((tMin + tMax) / 2), tMax].map((c) => (
            <g key={c}>
              <line x1={padL} y1={y(c)} x2={W - padR} y2={y(c)} stroke="var(--lg2-hairline)" stroke-width="0.5" />
              <text x={4} y={y(c) + 3} class="lg2-plan__axislbl">{c}°</text>
            </g>
          ))}

          {/* x hour ticks */}
          {ticks.map((m) => (
            <g key={m}>
              <line x1={x(m)} y1={padT} x2={x(m)} y2={H - padB} stroke="var(--lg2-hairline)" stroke-width="0.5" />
              <text x={x(m)} y={H - padB + 14} text-anchor="middle" class="lg2-plan__axislbl">{fmtTime(m)}</text>
            </g>
          ))}

          {/* outdoor context */}
          {outdoorPath !== '' && (
            <path d={outdoorPath} fill="none" stroke="var(--lg2-label-3)" stroke-width="1.2" stroke-dasharray="3 3" opacity="0.7" vector-effect="non-scaling-stroke" />
          )}
          {/* indoor forecast curve */}
          <path d={indoorPath} fill="none" stroke="#4a8cff" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round" />

          {/* decision markers — hover for a native tooltip, click to pin details */}
          {decisions.filter((d) => d.ms >= t0 && d.ms <= domainEnd).map((d) => {
            const cx = x(d.ms); const cy = y(nearestTemp(d.ms));
            const color = d.dir === 'up' ? '#66d66b' : d.dir === 'down' ? '#ff9d2e' : '#9b7cff';
            const on = selected !== null && selected.ts === d.ts && selected.windowName === d.windowName;
            return (
              <g key={`${d.ts}-${d.windowName}`} class="lg2-plan__marker"
                onClick={(): void => setSelected(on ? null : d)}>
                <title>{`${fmtTime(d.ts)} · ${d.windowName} · ${Math.round(d.targetPercent)}% — ${tServer(d.reason)}`}</title>
                <line x1={cx} y1={padT} x2={cx} y2={H - padB} stroke={color} stroke-width={on ? 1.6 : 1} stroke-dasharray="2 3" opacity={on ? 0.9 : 0.55} />
                {/* enlarged transparent hit area for easy clicking/hovering */}
                <circle cx={cx} cy={cy} r="11" fill="transparent" style={{ cursor: 'pointer' }} />
                <circle cx={cx} cy={cy} r={on ? 6 : 4.5} fill={color} stroke="#0b1725" stroke-width="1.5" />
                <text x={cx} y={padT + 12} text-anchor="middle" class="lg2-plan__marklbl" fill={color}>{Math.round(d.targetPercent)}%</text>
              </g>
            );
          })}

          {/* hover crosshair + nearest-value readout */}
          {hoverMs !== null && (() => {
            const cx = x(hoverMs); const tc = nearestTemp(hoverMs); const cy = y(tc);
            const anchor = cx > W - 120 ? 'end' : 'start';
            const tx = anchor === 'end' ? cx - 6 : cx + 6;
            return (
              <g class="lg2-plan__crosshair" pointer-events="none">
                <line x1={cx} y1={padT} x2={cx} y2={H - padB} stroke="var(--lg2-label-2)" stroke-width="0.8" stroke-dasharray="3 3" opacity="0.7" />
                <circle cx={cx} cy={cy} r="3.5" fill="#4a8cff" stroke="#0b1725" stroke-width="1.5" />
                <text x={tx} y={padT + 10} text-anchor={anchor} class="lg2-plan__marklbl" fill="var(--lg2-label-1)">
                  {fmtTime(hoverMs)} · {fmtNum(Math.round(tc * 10) / 10, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}°
                </text>
              </g>
            );
          })()}
        </svg>
      </div>
      <div class="lg2-plan__legend">
        <span><i class="lg2-plan__sw" style={{ background: '#4a8cff' }} /> {t('Raumtemperatur (Prognose)', 'Room temp (forecast)')}</span>
        <span><i class="lg2-plan__sw lg2-plan__sw--dash" /> {t('Außentemperatur', 'Outdoor temp')}</span>
        <span><i class="lg2-plan__sw" style={{ background: '#ff9d2e' }} /> {t('Schließen', 'Close')}</span>
        <span><i class="lg2-plan__sw" style={{ background: '#66d66b' }} /> {t('Öffnen', 'Open')}</span>
        {confidence !== null && <span class="lg2-plan__conf">{t('Konfidenz', 'Confidence')}: {Math.round(confidence * 100)} %</span>}
      </div>
      {shortPlan && (
        <p class="lg2-plan__note" data-testid="lg2-plan-shortnote">
          {t(`Der Planungshorizont der Engine endet um ${fmtTime(tPlanEnd)} Uhr — für einen längeren Plan den Horizont oben höher stellen.`,
            `The engine's planning horizon ends at ${fmtTime(tPlanEnd)} — pick a longer horizon above for a longer plan.`)}
        </p>
      )}
    </Fragment>
  );
}

/* -------------------------------------------------------------------------- */
/* Decision list (explainable "when + why")                                   */
/* -------------------------------------------------------------------------- */

function DecisionList(props: { decisions: PlanDecision[] }): JSX.Element {
  const { decisions } = props;
  if (decisions.length === 0) {
    return (
      <p class="lg2-plan__nodec" data-testid="lg2-plan-nodecisions">
        {t('Für diesen Raum ist im gewählten Zeitraum keine Rollladen-Fahrt geplant.',
          'No shutter move is planned for this room in the selected period.')}
      </p>
    );
  }
  return (
    <ol class="lg2-plan__decisions" data-testid="lg2-plan-decisions">
      {decisions.map((d) => {
        const color = d.dir === 'up' ? '#66d66b' : d.dir === 'down' ? '#ff9d2e' : '#9b7cff';
        return (
          <li key={`${d.ts}-${d.windowName}`} class="lg2-plan__decision">
            <span class="lg2-plan__dtime">{fmtTime(d.ts)}</span>
            <span class="lg2-plan__dbadge" style={{ color, borderColor: color }}>
              <Icon name="beschattung" size={13} /> {Math.round(d.targetPercent)}%
            </span>
            <span class="lg2-plan__dbody">
              <b>{d.windowName}</b>
              <em>{tServer(d.reason) || t('Vorausschauende Position', 'Predictive position')}</em>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
