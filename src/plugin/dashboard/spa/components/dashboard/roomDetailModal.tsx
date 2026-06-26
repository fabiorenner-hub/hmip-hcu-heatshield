/**
 * Heat Shield — per-room detail view (V1.5).
 *
 * A full-screen modal opened from a room badge / mobile row. It gathers
 * everything known about one room into a single premium view:
 *   - Kennzahlen (live shutter, indoor temp + trend, heat load, facade).
 *   - Verlauf: measured indoor + outdoor temperature over the last 12 h
 *     (fetched from `/api/trends`).
 *   - Rollo-Prognose: the next 12 h planned shutter percent.
 *   - Wärmerisiko-Faktoren: the weighted risk factor bars.
 *   - Lern- / Kalibrier-Status: what the plugin has learned for this room.
 *
 * Purely client-side; closes on backdrop click or ×.
 */

import { h, type JSX } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';

import { ExpandableChart, type ChartSeries } from '../lineChart.js';
import { Portal } from '../portal.js';
import type {
  LearnedRoomInfo,
  RiskFactorName,
  RoomDetail,
  WindowRiskBreakdown,
} from '../../types.js';

const RISK_FACTOR_LABELS: Record<RiskFactorName, string> = {
  sunFactor: 'Sonne',
  roomTempFactor: 'Raumtemp.',
  windowTypeFactor: 'Fenstertyp',
  forecastTempFactor: 'Prognose',
  pvFactor: 'PV',
  radiationFactor: 'Strahlung',
  outdoorTempFactor: 'Außentemp.',
  priorityFactor: 'Priorität',
};

const STATUS_LABELS: Record<string, string> = {
  recommended: 'Empfohlen',
  scheduled: 'Geplant',
  executing: 'Fährt',
  completed: 'Erledigt',
  blocked: 'Blockiert',
  manuallyOverridden: 'Manuell übersteuert',
};

function clampPct(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, Math.round(v)));
}

interface TrendSample {
  ts: string;
  key: string;
  value: number;
}

export function RoomDetailModal(props: {
  room: RoomDetail;
  risk?: WindowRiskBreakdown;
  learning?: LearnedRoomInfo;
  onClose: () => void;
}): JSX.Element {
  const { room } = props;
  const [samples, setSamples] = useState<TrendSample[] | null>(null);
  const nowMs = Date.now();
  const past12 = nowMs - 12 * 3600_000;

  useEffect(() => {
    let cancelled = false;
    void (async (): Promise<void> => {
      try {
        const res = await fetch('/api/trends?seconds=43200', {
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) return;
        const json = (await res.json()) as { samples: TrendSample[] };
        if (!cancelled) setSamples(json.samples);
      } catch {
        /* leave samples null → chart shows empty state */
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, []);

  const tempSeries: ChartSeries[] = useMemo(() => {
    const out: ChartSeries[] = [];
    const all = samples ?? [];
    const roomPts = all
      .filter((s) => s.key === `room:${room.id}`)
      .map((s) => ({ t: Date.parse(s.ts), v: s.value }))
      .filter((p) => Number.isFinite(p.t) && p.t >= past12);
    if (roomPts.length > 0) {
      out.push({ label: room.name, color: '#22c55e', points: roomPts });
    }
    const outdoor = all
      .filter((s) => s.key === 'outdoor')
      .map((s) => ({ t: Date.parse(s.ts), v: s.value }))
      .filter((p) => Number.isFinite(p.t) && p.t >= past12);
    if (outdoor.length > 0) {
      out.push({ label: 'Außen', color: '#f59e0b', points: outdoor });
    }
    return out;
  }, [samples, room.id, room.name, past12]);

  const shutterSeries: ChartSeries[] = useMemo(() => {
    const fc = room.shutterForecast ?? [];
    const pts = fc
      .map((p) => ({ t: Date.parse(p.ts), v: clampPct(p.percent) }))
      .filter((p) => Number.isFinite(p.t));
    return pts.length >= 2 ? [{ label: 'Rollo', color: '#38bdf8', points: pts }] : [];
  }, [room.shutterForecast]);

  // Weighted risk factors, descending.
  const riskRows: Array<{ name: RiskFactorName; weighted: number }> = [];
  if (props.risk !== undefined) {
    for (const key of Object.keys(props.risk.factors) as RiskFactorName[]) {
      const f = props.risk.factors[key] ?? 0;
      const w = props.risk.weights[key] ?? 0;
      const weighted = f * w;
      if (weighted > 0.001) riskRows.push({ name: key, weighted });
    }
    riskRows.sort((a, b) => b.weighted - a.weighted);
  }
  const riskMax = riskRows.length > 0 ? riskRows[0]!.weighted : 1;

  const orient =
    room.orientationDeg !== undefined ? `${Math.round(room.orientationDeg)}°` : '–';
  const heatPct = room.heatLoad01 !== undefined ? Math.round(room.heatLoad01 * 100) : null;
  const lr = props.learning;

  return (
    <Portal>
      <div
        class="room-detail"
        data-testid={`room-detail-${room.id}`}
        role="dialog"
        aria-label={`Detail ${room.name}`}
        onClick={props.onClose}
      >
      <div
        class="room-detail__panel"
        onClick={(e: JSX.TargetedMouseEvent<HTMLDivElement>): void => e.stopPropagation()}
      >
        <header class="room-detail__head">
          <span class="room-detail__title">
            {room.floor !== undefined && room.floor !== '' && (
              <span class="room-badge__floor">{room.floor}</span>
            )}
            {room.name}
          </span>
          <button
            type="button"
            class="room-detail__close"
            aria-label="Schließen"
            onClick={props.onClose}
          >
            ×
          </button>
        </header>

        <div class="room-detail__metrics">
          <Metric label="Rollo" value={`${clampPct(room.shutterPercent)} %`} />
          <Metric
            label="Innen"
            value={room.indoorTempC === null ? '–' : `${room.indoorTempC.toFixed(1)} °C`}
          />
          <Metric label="Wärmelast" value={heatPct === null ? '–' : `${heatPct} %`} />
          <Metric label="Fassade" value={`${room.facade} · ${orient}`} />
          <Metric label="Fenster" value={room.windowOpen === true ? 'offen' : 'zu'} />
          <Metric label="Status" value={STATUS_LABELS[room.status] ?? room.status} />
        </div>

        <section class="room-detail__section">
          <h4>Verlauf · letzte 12 h</h4>
          <ExpandableChart
            title={`${room.name} · Temperaturverlauf`}
            series={tempSeries}
            unit="°C"
            nowT={nowMs}
          />
        </section>

        {shutterSeries.length > 0 && (
          <section class="room-detail__section">
            <h4>Rollo-Prognose · nächste 12 h</h4>
            <ExpandableChart
              title={`${room.name} · Rollo-Prognose`}
              series={shutterSeries}
              unit="%"
              nowT={nowMs}
            />
          </section>
        )}

        {riskRows.length > 0 && (
          <section class="room-detail__section">
            <h4>Wärmerisiko-Faktoren</h4>
            <div class="room-detail__risk">
              {riskRows.slice(0, 6).map((r) => (
                <div class="room-detail__riskrow" key={r.name}>
                  <span class="room-detail__riskname">{RISK_FACTOR_LABELS[r.name]}</span>
                  <span class="room-detail__riskbar">
                    <span
                      class="room-detail__riskfill"
                      style={{ width: `${Math.round((r.weighted / riskMax) * 100)}%` }}
                    />
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        <section class="room-detail__section">
          <h4>Lern- / Kalibrier-Status</h4>
          {lr === undefined ? (
            <p class="room-detail__empty">Noch keine Lerndaten für diesen Raum.</p>
          ) : (
            <ul class="room-detail__learn">
              <li>
                Ø Abweichung ggü. Komfort:{' '}
                <b>
                  {lr.avgOvershootC === null
                    ? '—'
                    : `${lr.avgOvershootC > 0 ? '+' : ''}${lr.avgOvershootC} K`}
                </b>
              </li>
              <li>
                Ø Fahrten/Tag: <b>{lr.avgMovesPerDay}</b>
              </li>
              {lr.comfortBiasC !== 0 && (
                <li>
                  Komfort-Bias: <b>{lr.comfortBiasC > 0 ? '+' : ''}{lr.comfortBiasC} K</b>
                </li>
              )}
              <li class="room-detail__rec">{lr.recommendation}</li>
              {lr.calibrationNote !== undefined && (
                <li class="room-detail__calib">🌡 {lr.calibrationNote}</li>
              )}
            </ul>
          )}
        </section>
      </div>
      </div>
    </Portal>
  );
}

function Metric(props: { label: string; value: string }): JSX.Element {
  return (
    <div class="room-detail__metric">
      <span class="room-detail__metric-label">{props.label}</span>
      <span class="room-detail__metric-value">{props.value}</span>
    </div>
  );
}
