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
import { AlertCenter } from '../components/dashboard/alertCenter.js';
import { RadarMap } from '../components/dashboard/radarMap.js';
import { PrecipOutlook } from '../components/dashboard/precipOutlook.js';
import { WindRose } from '../components/dashboard/windRose.js';
import { WindOutlook } from '../components/dashboard/windOutlook.js';
import { WeatherFacts } from '../components/dashboard/weatherFacts.js';
import { WeatherCharts } from '../components/dashboard/weatherCharts.js';
import { useConfig } from '../hooks/useConfig.js';
import { snapshot } from '../store.js';
import { t } from '../i18n.js';

interface TrendSample {
  ts: string;
  key: string;
  value: number;
}

interface RangeOption {
  labelDe: string;
  labelEn: string;
  seconds: number;
}

const RANGES: RangeOption[] = [
  { labelDe: '6 Stunden', labelEn: '6 hours', seconds: 6 * 3600 },
  { labelDe: '24 Stunden', labelEn: '24 hours', seconds: 24 * 3600 },
  { labelDe: '3 Tage', labelEn: '3 days', seconds: 3 * 24 * 3600 },
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
          setError(err instanceof Error ? err.message : t('Unbekannter Fehler', 'Unknown error'));
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
      series.push({ label: t('Außen', 'Outdoor'), color: '#e2e8f0', points: outdoor });
    }
    const front = grouped.get('outdoorFront');
    if (front !== undefined && front.length > 0) {
      series.push({ label: t('Außen vorne', 'Outdoor front'), color: '#94a3b8', points: front });
    }
    const back = grouped.get('outdoorBack');
    if (back !== undefined && back.length > 0) {
      series.push({ label: t('Außen hinten', 'Outdoor back'), color: '#64748b', points: back });
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
    return [{ label: t('PV-Leistung', 'PV power'), color: '#f59e0b', points: pv }];
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
      out.push({ label: t('Außen gemessen', 'Outdoor measured'), color: '#f59e0b', points: outdoorPast });
    }
    const outdoorFc = fcCards
      .map((c) => ({ t: Date.parse(c.ts), v: c.tempC }))
      .filter((p) => Number.isFinite(p.t) && p.t >= nowMs);
    if (outdoorFc.length > 0) {
      out.push({ label: t('Außen Prognose', 'Outdoor forecast'), color: '#fbbf24', dashed: true, points: outdoorFc });
    }
    return out;
  }, [grouped, fcCards, nowMs, past12Ms]);

  const combinedPvSeries: ChartSeries[] = useMemo(() => {
    const out: ChartSeries[] = [];
    const pvPast = (grouped.get('pv') ?? []).filter((p) => p.t >= past12Ms && p.t <= nowMs);
    if (pvPast.length > 0) {
      out.push({ label: t('PV gemessen', 'PV measured'), color: '#f59e0b', points: pvPast });
    }
    const pvFc = fcCards
      .filter((c) => c.pvForecastKw !== undefined)
      .map((c) => ({ t: Date.parse(c.ts), v: c.pvForecastKw as number }))
      .filter((p) => Number.isFinite(p.t) && p.t >= nowMs);
    if (pvFc.length > 0) {
      out.push({ label: t('PV erwartet', 'PV expected'), color: '#38bdf8', dashed: true, points: pvFc });
    }
    return out;
  }, [grouped, fcCards, nowMs, past12Ms]);

  const hasCombinedTemp = combinedTempSeries.length > 0;
  const hasCombinedPv = combinedPvSeries.length > 0;

  return (
    <section class="module-panel tab-history" data-testid="tab-history">
      <header class="module-panel__head">
        <h1>{t('Wetter', 'Weather')}</h1>
        <span class="module-panel__badge">{t('Aktuell · Vorhersage · Radar · Wind · Verlauf', 'Current · Forecast · Radar · Wind · History')}</span>
      </header>
      <p class="module-panel__intro">
        {t(
          'Aktuelle Werte, die Vorhersage der nächsten 24 Stunden, Regenradar, Wind und amtliche Unwetterwarnungen (DWD) für deinen Standort — darunter der gemessene Verlauf und die Wirkung auf dein Haus.',
          'Current values, the forecast for the next 24 hours, rain radar, wind and official severe-weather warnings (DWD) for your location — plus the measured history and the impact on your house.',
        )}
      </p>

      {/* 0) Alert-Modus zuerst (nur bei aktiver Warnung ≥ Rot) */}
      <AlertCenter latitude={latitude} longitude={longitude} surface="weather" />

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
          titlePrefix={t('Wettervorhersage', 'Weather forecast')}
        />
      )}

      {/* 4) Wind (kompakt, volle Breite) + Regenradar (volle Breite darunter) */}
      <div class="weather-wind" data-testid="weather-wind">
        <WindRose latitude={latitude} longitude={longitude} />
        <WindOutlook latitude={latitude} longitude={longitude} />
      </div>
      <RadarMap latitude={latitude} longitude={longitude} />
      <PrecipOutlook />

      {/* 5) Diagramme (dive deep) */}
      <WeatherCharts latitude={latitude} longitude={longitude} />

      {/* 6) Gemessen + Prognose im Vergleich */}
      {snap !== null && (hasCombinedTemp || hasCombinedPv) && (
        <div class="forecast-section" data-testid="combined-section">
          <h2 class="forecast-section__title">{t('12 h zurück + 12 h voraus', '12 h back + 12 h ahead')}</h2>
          <div class="forecast-section__charts">
            <article class="module-panel__card">
              <h3>{t('Temperatur', 'Temperature')}</h3>
              {hasCombinedTemp ? (
                <ExpandableChart
                  title={t('Temperatur · 12 h zurück + 12 h voraus', 'Temperature · 12 h back + 12 h ahead')}
                  subtitle={t('durchgezogen = gemessen · gestrichelt = Prognose', 'solid = measured · dashed = forecast')}
                  series={combinedTempSeries}
                  unit="°C"
                  nowT={nowMs}
                />
              ) : (
                <p class="module-panel__hint">{t('Noch keine Verlaufsdaten.', 'No history data yet.')}</p>
              )}
            </article>
            <article class="module-panel__card">
              <h3>{t('PV-Leistung', 'PV power')}</h3>
              {hasCombinedPv ? (
                <ExpandableChart
                  title={t('PV-Leistung · 12 h zurück + 12 h voraus', 'PV power · 12 h back + 12 h ahead')}
                  subtitle={t('durchgezogen = gemessen · gestrichelt = erwartet (aus Strahlung)', 'solid = measured · dashed = expected (from radiation)')}
                  series={combinedPvSeries}
                  unit="kW"
                  nowT={nowMs}
                />
              ) : (
                <p class="module-panel__hint">{t('Noch keine Verlaufsdaten.', 'No history data yet.')}</p>
              )}
            </article>
          </div>
        </div>
      )}

      {/* 7) Gemessener Verlauf */}
      <div class="tab-history__verlauf">
        <header class="tab-history__header">
          <h2>{t('Verlauf', 'History')}</h2>
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
                {t(r.labelDe, r.labelEn)}
              </button>
            ))}
          </div>
        </header>

        {error !== null && (
          <p class="tab-history__error" data-testid="history-error">
            {t('Fehler beim Laden:', 'Error loading:')} {error}
          </p>
        )}
        {loading && samples === null && <p>{t('Lade Verlauf…', 'Loading history…')}</p>}

        <article class="tab-history__chart-card module-panel__card">
          <h3>{t('Temperaturen', 'Temperatures')}</h3>
          <ExpandableChart title={t('Temperaturen · Verlauf', 'Temperatures · History')} series={tempSeries} unit="°C" />
        </article>

        <article class="tab-history__chart-card module-panel__card">
          <h3>{t('PV-Leistung', 'PV power')}</h3>
          <ExpandableChart title={t('PV-Leistung · Verlauf', 'PV power · History')} series={pvSeries} unit="kW" />
        </article>
      </div>

      {/* 8) Haus-Bezug: Innenraum-Prognose + Wirkung (klar abgetrennt) */}
      {snap !== null && (
        <div class="forecast-section" data-testid="forecast-section">
          <h2 class="forecast-section__title">{t('Innenraum-Prognose', 'Indoor forecast')}</h2>
          <div class="forecast-section__charts">
            <article class="module-panel__card">
              <h3>{t('Innentemperatur-Prognose', 'Indoor temperature forecast')}</h3>
              <TemperatureChart snapshot={snap} now={now} />
            </article>
            <article class="module-panel__card">
              <h3>{t('Wärmelast-Prognose', 'Heat-load forecast')}</h3>
              <HeatLoadChart snapshot={snap} now={now} />
            </article>
          </div>
        </div>
      )}

      {snap !== null && snap.impact !== undefined && (
        <div class="forecast-section" data-testid="impact-section">
          <h2 class="forecast-section__title">{t('Wirkung', 'Impact')}</h2>
          <div class="forecast-section__charts">
            <article class="module-panel__card">
              <h3>{t('Komfort gehalten (heute)', 'Comfort held (today)')}</h3>
              <p class="module-panel__metric">
                {snap.impact.comfortShareToday01 === null
                  ? '–'
                  : `${Math.round(snap.impact.comfortShareToday01 * 100)} %`}
              </p>
              <p class="module-panel__hint">
                {t(
                  'Anteil der Regelzyklen heute, in denen kein Raum über seiner Warnschwelle lag.',
                  'Share of control cycles today in which no room was above its warning threshold.',
                )}
              </p>
            </article>
            <article class="module-panel__card">
              <h3>{t('Ø Rollladenfahrten / Tag', 'Avg. shutter moves / day')}</h3>
              <p class="module-panel__metric">
                {snap.impact.avgMovesPerDay === null ? '–' : snap.impact.avgMovesPerDay}
              </p>
              <p class="module-panel__hint">
                {t(
                  `Gelernt über ${snap.impact.learnDays} Tag(e). Ziel: so wenige Bewegungen wie nötig.`,
                  `Learned over ${snap.impact.learnDays} day(s). Goal: as few moves as necessary.`,
                )}
              </p>
            </article>
            <article class="module-panel__card">
              <h3>{t('PV-Eigenverbrauch', 'PV self-consumption')}</h3>
              <p class="module-panel__metric">
                {snap.impact.pvSelfUse01 === undefined
                  ? '–'
                  : `${Math.round(snap.impact.pvSelfUse01 * 100)} %`}
              </p>
              <p class="module-panel__hint">
                {t(
                  'Anteil der PV-Erzeugung, der im Haus genutzt statt eingespeist wird.',
                  'Share of PV generation used in the house instead of being fed into the grid.',
                )}
              </p>
            </article>
            <article class="module-panel__card">
              <h3>{t('Selbstlernend', 'Self-learning')}</h3>
              <p class="module-panel__metric">
                {snap.impact.tunedRooms + snap.impact.calibratedRooms}
              </p>
              <p class="module-panel__hint">
                {t(
                  `${snap.impact.tunedRooms} Komfort- und ${snap.impact.calibratedRooms} Trägheits-Anpassung(en) aktiv.`,
                  `${snap.impact.tunedRooms} comfort and ${snap.impact.calibratedRooms} inertia adjustment(s) active.`,
                )}
              </p>
            </article>
            <article class="module-panel__card">
              <h3>{t('Prognosegüte', 'Forecast accuracy')}</h3>
              <p class="module-panel__metric">
                {snap.impact.forecastAccuracyC === undefined
                  ? '–'
                  : `± ${snap.impact.forecastAccuracyC} °C`}
              </p>
              <p class="module-panel__hint">
                {t(
                  'Mittlerer Fehler zwischen vorhergesagtem und tatsächlichem Innen-Peak (kleiner = besser).',
                  'Mean error between the predicted and actual indoor peak (smaller = better).',
                )}
              </p>
            </article>
          </div>
        </div>
      )}
    </section>
  );
}
