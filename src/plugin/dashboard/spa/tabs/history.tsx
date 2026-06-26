/**
 * Forecast module — "Prognose & Verlauf" (V1.1 premium redesign).
 *
 * Top: the live 12 h forecast — weather timeline, the per-room indoor
 * temperature trajectory (with/without shading) and the heat-load forecast,
 * all derived from the snapshot the Forecast_Planner produced.
 *
 * Bottom: the historical trend charts (temperatures + PV) fetched from
 * `GET /api/trends?seconds=` with a 6 h / 24 h / 3 d range selector.
 */

import { h, type JSX } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';

import { ExpandableChart, type ChartSeries } from '../components/lineChart.js';
import { ForecastTimeline } from '../components/dashboard/forecastTimeline.js';
import { TemperatureChart, HeatLoadChart } from '../components/dashboard/analysisRail.js';
import { DwdWarnings } from '../components/dashboard/dwdWarnings.js';
import { RadarMap } from '../components/dashboard/radarMap.js';
import { WindRose } from '../components/dashboard/windRose.js';
import { WindOutlook } from '../components/dashboard/windOutlook.js';
import { WeatherFacts } from '../components/dashboard/weatherFacts.js';
import { WeatherCharts } from '../components/dashboard/weatherCharts.js';
import { useConfig } from '../hooks/useConfig.js';
import { snapshot } from '../store.js';

interface TrendSample {
  ts: string;
  key: string;
  value: number;
}

interface RangeOption {
  label: string;
  seconds: number;
}

const RANGES: RangeOption[] = [
  { label: '6 Stunden', seconds: 6 * 3600 },
  { label: '24 Stunden', seconds: 24 * 3600 },
  { label: '3 Tage', seconds: 3 * 24 * 3600 },
];

// A small, colour-blind-friendly palette cycled across room series.
const ROOM_COLORS = [
  '#2563eb',
  '#db2777',
  '#16a34a',
  '#d97706',
  '#7c3aed',
  '#0891b2',
  '#dc2626',
  '#4d7c0f',
];

function groupByKey(samples: TrendSample[]): Map<string, Array<{ t: number; v: number }>> {
  const out = new Map<string, Array<{ t: number; v: number }>>();
  for (const s of samples) {
    const t = Date.parse(s.ts);
    if (!Number.isFinite(t)) {
      continue;
    }
    const arr = out.get(s.key) ?? [];
    arr.push({ t, v: s.value });
    out.set(s.key, arr);
  }
  for (const arr of out.values()) {
    arr.sort((a, b) => a.t - b.t);
  }
  return out;
}

export function HistoryTab(): JSX.Element {
  const [seconds, setSeconds] = useState<number>(RANGES[1]!.seconds);
  const [samples, setSamples] = useState<TrendSample[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const now = new Date();
  const snap = snapshot.value;
  const { config } = useConfig();
  const latitude = config.value?.location?.latitude ?? 52.52;
  const longitude = config.value?.location?.longitude ?? 13.41;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async (): Promise<void> => {
      try {
        const res = await fetch(`/api/trends?seconds=${seconds}`, {
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const json = (await res.json()) as { samples: TrendSample[] };
        if (!cancelled) {
          setSamples(json.samples);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Unbekannter Fehler');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, [seconds]);

  const grouped = useMemo(
    () => (samples === null ? new Map<string, Array<{ t: number; v: number }>>() : groupByKey(samples)),
    [samples],
  );

  const roomName = (roomId: string): string => {
    const room = snapshot.value?.rooms?.find((r) => r.id === roomId);
    return room?.name ?? roomId;
  };

  const tempSeries: ChartSeries[] = useMemo(() => {
    const series: ChartSeries[] = [];
    const outdoor = grouped.get('outdoor');
    if (outdoor !== undefined && outdoor.length > 0) {
      series.push({ label: 'Außen', color: '#e2e8f0', points: outdoor });
    }
    const front = grouped.get('outdoorFront');
    if (front !== undefined && front.length > 0) {
      series.push({ label: 'Außen vorne', color: '#94a3b8', points: front });
    }
    const back = grouped.get('outdoorBack');
    if (back !== undefined && back.length > 0) {
      series.push({ label: 'Außen hinten', color: '#64748b', points: back });
    }
    let ci = 0;
    for (const [key, pts] of grouped) {
      if (!key.startsWith('room:') || pts.length === 0) {
        continue;
      }
      const roomId = key.slice('room:'.length);
      series.push({
        label: roomName(roomId),
        color: ROOM_COLORS[ci % ROOM_COLORS.length]!,
        points: pts,
      });
      ci += 1;
    }
    return series;
  }, [grouped]);

  const pvSeries: ChartSeries[] = useMemo(() => {
    const pv = grouped.get('pv');
    if (pv === undefined || pv.length === 0) {
      return [];
    }
    return [{ label: 'PV-Leistung', color: '#f59e0b', points: pv }];
  }, [grouped]);

  // Combined "12 h zurück + 12 h voraus" series: measured history (solid)
  // stitched to the forecast (dashed) at the live "now" line.
  const nowMs = now.getTime();
  const past12Ms = nowMs - 12 * 3600_000;
  const fcCards = snap?.forecastTimeline ?? [];

  const combinedTempSeries: ChartSeries[] = useMemo(() => {
    const out: ChartSeries[] = [];
    const outdoorPast = (grouped.get('outdoor') ?? []).filter(
      (p) => p.t >= past12Ms && p.t <= nowMs,
    );
    if (outdoorPast.length > 0) {
      out.push({ label: 'Außen gemessen', color: '#f59e0b', points: outdoorPast });
    }
    const outdoorFc = fcCards
      .map((c) => ({ t: Date.parse(c.ts), v: c.tempC }))
      .filter((p) => Number.isFinite(p.t) && p.t >= nowMs);
    if (outdoorFc.length > 0) {
      out.push({ label: 'Außen Prognose', color: '#fbbf24', dashed: true, points: outdoorFc });
    }
    return out;
  }, [grouped, fcCards, nowMs, past12Ms]);

  const combinedPvSeries: ChartSeries[] = useMemo(() => {
    const out: ChartSeries[] = [];
    const pvPast = (grouped.get('pv') ?? []).filter((p) => p.t >= past12Ms && p.t <= nowMs);
    if (pvPast.length > 0) {
      out.push({ label: 'PV gemessen', color: '#f59e0b', points: pvPast });
    }
    const pvFc = fcCards
      .filter((c) => c.pvForecastKw !== undefined)
      .map((c) => ({ t: Date.parse(c.ts), v: c.pvForecastKw as number }))
      .filter((p) => Number.isFinite(p.t) && p.t >= nowMs);
    if (pvFc.length > 0) {
      out.push({ label: 'PV erwartet', color: '#38bdf8', dashed: true, points: pvFc });
    }
    return out;
  }, [grouped, fcCards, nowMs, past12Ms]);

  const hasCombinedTemp = combinedTempSeries.length > 0;
  const hasCombinedPv = combinedPvSeries.length > 0;

  return (
    <section class="module-panel tab-history" data-testid="tab-history">
      <header class="module-panel__head">
        <h1>Wetter</h1>
        <span class="module-panel__badge">Aktuell · Vorhersage · Radar · Wind · Verlauf</span>
      </header>
      <p class="module-panel__intro">
        Aktuelle Werte, die Vorhersage der nächsten 24 Stunden, Regenradar, Wind und
        amtliche Unwetterwarnungen (DWD) für deinen Standort — darunter der gemessene
        Verlauf und die Wirkung auf dein Haus.
      </p>

      {/* 1) Warnungen zuerst */}
      <DwdWarnings />

      {/* 2) Aktuelle Werte */}
      <WeatherFacts latitude={latitude} longitude={longitude} />

      {/* 3) Vorhersage – nächste 24 Stunden */}
      {snap !== null && (
        <ForecastTimeline
          snapshot={snap}
          now={now}
          hours={24}
          showActions={false}
          titlePrefix="Wettervorhersage"
        />
      )}

      {/* 4) Regenradar + Wind */}
      <div class="weather-grid" data-testid="weather-grid">
        <RadarMap latitude={latitude} longitude={longitude} />
        <div class="weather-grid__side">
          <WindRose latitude={latitude} longitude={longitude} />
          <WindOutlook latitude={latitude} longitude={longitude} />
        </div>
      </div>

      {/* 5) Diagramme (dive deep) */}
      <WeatherCharts latitude={latitude} longitude={longitude} />

      {/* 6) Gemessen + Prognose im Vergleich */}
      {snap !== null && (hasCombinedTemp || hasCombinedPv) && (
        <div class="forecast-section" data-testid="combined-section">
          <h2 class="forecast-section__title">12 h zurück + 12 h voraus</h2>
          <div class="forecast-section__charts">
            <article class="module-panel__card">
              <h3>Temperatur</h3>
              {hasCombinedTemp ? (
                <ExpandableChart
                  title="Temperatur · 12 h zurück + 12 h voraus"
                  subtitle="durchgezogen = gemessen · gestrichelt = Prognose"
                  series={combinedTempSeries}
                  unit="°C"
                  nowT={nowMs}
                />
              ) : (
                <p class="module-panel__hint">Noch keine Verlaufsdaten.</p>
              )}
            </article>
            <article class="module-panel__card">
              <h3>PV-Leistung</h3>
              {hasCombinedPv ? (
                <ExpandableChart
                  title="PV-Leistung · 12 h zurück + 12 h voraus"
                  subtitle="durchgezogen = gemessen · gestrichelt = erwartet (aus Strahlung)"
                  series={combinedPvSeries}
                  unit="kW"
                  nowT={nowMs}
                />
              ) : (
                <p class="module-panel__hint">Noch keine Verlaufsdaten.</p>
              )}
            </article>
          </div>
        </div>
      )}

      {/* 7) Gemessener Verlauf */}
      <div class="tab-history__verlauf">
        <header class="tab-history__header">
          <h2>Verlauf</h2>
          <div class="tab-history__ranges" role="tablist">
            {RANGES.map((r) => (
              <button
                key={r.seconds}
                type="button"
                role="tab"
                aria-selected={seconds === r.seconds}
                class={seconds === r.seconds ? 'tab-history__range--active' : ''}
                data-testid={`history-range-${r.seconds}`}
                onClick={(): void => setSeconds(r.seconds)}
              >
                {r.label}
              </button>
            ))}
          </div>
        </header>

        {error !== null && (
          <p class="tab-history__error" data-testid="history-error">
            Fehler beim Laden: {error}
          </p>
        )}
        {loading && samples === null && <p>Lade Verlauf…</p>}

        <article class="tab-history__chart-card module-panel__card">
          <h3>Temperaturen</h3>
          <ExpandableChart title="Temperaturen · Verlauf" series={tempSeries} unit="°C" />
        </article>

        <article class="tab-history__chart-card module-panel__card">
          <h3>PV-Leistung</h3>
          <ExpandableChart title="PV-Leistung · Verlauf" series={pvSeries} unit="kW" />
        </article>
      </div>

      {/* 8) Haus-Bezug: Innenraum-Prognose + Wirkung (klar abgetrennt) */}
      {snap !== null && (
        <div class="forecast-section" data-testid="forecast-section">
          <h2 class="forecast-section__title">Innenraum-Prognose</h2>
          <div class="forecast-section__charts">
            <article class="module-panel__card">
              <h3>Innentemperatur-Prognose</h3>
              <TemperatureChart snapshot={snap} now={now} />
            </article>
            <article class="module-panel__card">
              <h3>Wärmelast-Prognose</h3>
              <HeatLoadChart snapshot={snap} now={now} />
            </article>
          </div>
        </div>
      )}

      {snap !== null && snap.impact !== undefined && (
        <div class="forecast-section" data-testid="impact-section">
          <h2 class="forecast-section__title">Wirkung</h2>
          <div class="forecast-section__charts">
            <article class="module-panel__card">
              <h3>Komfort gehalten (heute)</h3>
              <p class="module-panel__metric">
                {snap.impact.comfortShareToday01 === null
                  ? '–'
                  : `${Math.round(snap.impact.comfortShareToday01 * 100)} %`}
              </p>
              <p class="module-panel__hint">
                Anteil der Regelzyklen heute, in denen kein Raum über seiner
                Warnschwelle lag.
              </p>
            </article>
            <article class="module-panel__card">
              <h3>Ø Rollladenfahrten / Tag</h3>
              <p class="module-panel__metric">
                {snap.impact.avgMovesPerDay === null ? '–' : snap.impact.avgMovesPerDay}
              </p>
              <p class="module-panel__hint">
                Gelernt über {snap.impact.learnDays} Tag(e). Ziel: so wenige
                Bewegungen wie nötig.
              </p>
            </article>
            <article class="module-panel__card">
              <h3>PV-Eigenverbrauch</h3>
              <p class="module-panel__metric">
                {snap.impact.pvSelfUse01 === undefined
                  ? '–'
                  : `${Math.round(snap.impact.pvSelfUse01 * 100)} %`}
              </p>
              <p class="module-panel__hint">
                Anteil der PV-Erzeugung, der im Haus genutzt statt eingespeist
                wird.
              </p>
            </article>
            <article class="module-panel__card">
              <h3>Selbstlernend</h3>
              <p class="module-panel__metric">
                {snap.impact.tunedRooms + snap.impact.calibratedRooms}
              </p>
              <p class="module-panel__hint">
                {snap.impact.tunedRooms} Komfort- und {snap.impact.calibratedRooms}{' '}
                Trägheits-Anpassung(en) aktiv.
              </p>
            </article>
            <article class="module-panel__card">
              <h3>Prognosegüte</h3>
              <p class="module-panel__metric">
                {snap.impact.forecastAccuracyC === undefined
                  ? '–'
                  : `± ${snap.impact.forecastAccuracyC} °C`}
              </p>
              <p class="module-panel__hint">
                Mittlerer Fehler zwischen vorhergesagtem und tatsächlichem
                Innen-Peak (kleiner = besser).
              </p>
            </article>
          </div>
        </div>
      )}
    </section>
  );
}
