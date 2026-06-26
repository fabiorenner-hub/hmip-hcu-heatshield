/**
 * Heat Shield — rich weather forecast charts (Wetter tab).
 *
 * One client-side Open-Meteo fetch (CORS, no key) feeds a grid of expandable
 * line charts so the user can dive deep into the forecast: temperature +
 * apparent temperature, precipitation + probability, cloud cover, wind +
 * gusts, pressure, humidity, UV index, global radiation (next 48 h) plus a
 * 7-day daily min/max temperature range. Every chart opens a large modal via
 * `ExpandableChart`. A range switch toggles the hourly horizon (24 h / 48 h).
 */

import { h, type JSX } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';

import { ExpandableChart, type ChartSeries } from '../lineChart.js';
import { t } from '../../i18n.js';

interface HourRow {
  t: number;
  temp: number | null;
  apparent: number | null;
  precip: number | null;
  prob: number | null;
  cloud: number | null;
  wind: number | null;
  gust: number | null;
  pressure: number | null;
  humidity: number | null;
  uv: number | null;
  radiation: number | null;
}

interface DayRow {
  t: number;
  tMax: number | null;
  tMin: number | null;
}

interface WeatherChartData {
  hourly: HourRow[];
  daily: DayRow[];
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

type NumArr = Array<number | null> | undefined;

const HOUR_RANGES = [
  { label: '24 h', hours: 24 },
  { label: '48 h', hours: 48 },
] as const;

export function WeatherCharts(props: {
  latitude: number;
  longitude: number;
  fetchFn?: typeof globalThis.fetch;
}): JSX.Element {
  const [data, setData] = useState<WeatherChartData | null>(null);
  const [error, setError] = useState<boolean>(false);
  const [hours, setHours] = useState<number>(48);
  const now = Date.now();

  useEffect(() => {
    const fetchFn = props.fetchFn ?? globalThis.fetch.bind(globalThis);
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const url =
          'https://api.open-meteo.com/v1/forecast?latitude=' +
          encodeURIComponent(String(props.latitude)) +
          '&longitude=' +
          encodeURIComponent(String(props.longitude)) +
          '&hourly=temperature_2m,apparent_temperature,precipitation,precipitation_probability,' +
          'cloud_cover,wind_speed_10m,wind_gusts_10m,surface_pressure,relative_humidity_2m,' +
          'uv_index,shortwave_radiation' +
          '&daily=temperature_2m_max,temperature_2m_min' +
          '&wind_speed_unit=kmh&timezone=auto&forecast_days=7';
        const res = await fetchFn(url, { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = (await res.json()) as {
          hourly?: {
            time?: string[];
            temperature_2m?: NumArr;
            apparent_temperature?: NumArr;
            precipitation?: NumArr;
            precipitation_probability?: NumArr;
            cloud_cover?: NumArr;
            wind_speed_10m?: NumArr;
            wind_gusts_10m?: NumArr;
            surface_pressure?: NumArr;
            relative_humidity_2m?: NumArr;
            uv_index?: NumArr;
            shortwave_radiation?: NumArr;
          };
          daily?: {
            time?: string[];
            temperature_2m_max?: NumArr;
            temperature_2m_min?: NumArr;
          };
        };
        if (cancelled) return;
        const ht = j.hourly?.time ?? [];
        const hh = j.hourly;
        const hourly: HourRow[] = ht.map((ts, i) => ({
          t: Date.parse(ts),
          temp: num(hh?.temperature_2m?.[i]),
          apparent: num(hh?.apparent_temperature?.[i]),
          precip: num(hh?.precipitation?.[i]),
          prob: num(hh?.precipitation_probability?.[i]),
          cloud: num(hh?.cloud_cover?.[i]),
          wind: num(hh?.wind_speed_10m?.[i]),
          gust: num(hh?.wind_gusts_10m?.[i]),
          pressure: num(hh?.surface_pressure?.[i]),
          humidity: num(hh?.relative_humidity_2m?.[i]),
          uv: num(hh?.uv_index?.[i]),
          radiation: num(hh?.shortwave_radiation?.[i]),
        }));
        const dt = j.daily?.time ?? [];
        const daily: DayRow[] = dt.map((ts, i) => ({
          t: Date.parse(ts),
          tMax: num(j.daily?.temperature_2m_max?.[i]),
          tMin: num(j.daily?.temperature_2m_min?.[i]),
        }));
        setData({ hourly, daily });
        setError(false);
      } catch {
        if (!cancelled) setError(true);
      }
    };
    void load();
    const id = setInterval(() => void load(), 15 * 60_000);
    return (): void => {
      cancelled = true;
      clearInterval(id);
    };
  }, [props.latitude, props.longitude, props.fetchFn]);

  const window = useMemo(
    () =>
      (data?.hourly ?? []).filter(
        (p) => Number.isFinite(p.t) && p.t >= now - 3600_000 && p.t <= now + hours * 3600_000,
      ),
    [data, hours, now],
  );

  const lineSeries = (
    label: string,
    color: string,
    pick: (r: HourRow) => number | null,
  ): ChartSeries[] => {
    const pts = window
      .filter((r) => pick(r) !== null)
      .map((r) => ({ t: r.t, v: pick(r) as number }));
    return pts.length >= 2 ? [{ label, color, points: pts }] : [];
  };

  const tempSeries: ChartSeries[] = useMemo(() => {
    const out: ChartSeries[] = [];
    out.push(...lineSeries(t('Temperatur', 'Temperature'), '#f59e0b', (r) => r.temp));
    out.push(...lineSeries(t('Gefühlt', 'Apparent'), '#fb7185', (r) => r.apparent));
    return out;
  }, [window]);

  const windSeries: ChartSeries[] = useMemo(() => {
    const out: ChartSeries[] = [];
    out.push(...lineSeries(t('Wind', 'Wind'), '#38bdf8', (r) => r.wind));
    out.push(...lineSeries(t('Böen', 'Gusts'), '#818cf8', (r) => r.gust));
    return out;
  }, [window]);

  const precipSeries = useMemo(() => lineSeries(t('Niederschlag', 'Precipitation'), '#0ea5e9', (r) => r.precip), [window]);
  const probSeries = useMemo(() => lineSeries(t('Wahrscheinlichkeit', 'Probability'), '#6366f1', (r) => r.prob), [window]);
  const cloudSeries = useMemo(() => lineSeries(t('Bewölkung', 'Cloud cover'), '#94a3b8', (r) => r.cloud), [window]);
  const pressureSeries = useMemo(() => lineSeries(t('Luftdruck', 'Air pressure'), '#a78bfa', (r) => r.pressure), [window]);
  const humiditySeries = useMemo(() => lineSeries(t('Luftfeuchte', 'Humidity'), '#22d3ee', (r) => r.humidity), [window]);
  const uvSeries = useMemo(() => lineSeries(t('UV-Index', 'UV index'), '#f97316', (r) => r.uv), [window]);
  const radiationSeries = useMemo(() => lineSeries(t('Globalstrahlung', 'Global radiation'), '#facc15', (r) => r.radiation), [window]);

  const dailyTempSeries: ChartSeries[] = useMemo(() => {
    const days = data?.daily ?? [];
    const max = days.filter((d) => d.tMax !== null).map((d) => ({ t: d.t, v: d.tMax as number }));
    const min = days.filter((d) => d.tMin !== null).map((d) => ({ t: d.t, v: d.tMin as number }));
    const out: ChartSeries[] = [];
    if (max.length >= 2) out.push({ label: t('Max', 'Max'), color: '#f59e0b', points: max });
    if (min.length >= 2) out.push({ label: t('Min', 'Min'), color: '#38bdf8', points: min });
    return out;
  }, [data]);

  const chart = (
    title: string,
    series: ChartSeries[],
    unit: string,
    testId: string,
    withNow = true,
  ): JSX.Element => (
    <article class="module-panel__card weather-charts__card" data-testid={testId}>
      <h3>{title}</h3>
      {series.length > 0 ? (
        <ExpandableChart
          title={title}
          series={series}
          unit={unit}
          {...(withNow ? { nowT: now } : {})}
        />
      ) : (
        <p class="module-panel__hint">{t('Keine Daten.', 'No data.')}</p>
      )}
    </article>
  );

  return (
    <div class="weather-charts" data-testid="weather-charts">
      <header class="weather-charts__head">
        <h2 class="forecast-section__title">{t('Wettervorhersage · Diagramme', 'Weather forecast · charts')}</h2>
        <div class="weather-charts__ranges" role="tablist">
          {HOUR_RANGES.map((r) => (
            <button
              key={r.hours}
              type="button"
              role="tab"
              aria-selected={hours === r.hours}
              class={hours === r.hours ? 'weather-charts__range--active' : ''}
              data-testid={`weather-charts-range-${r.hours}`}
              onClick={(): void => setHours(r.hours)}
            >
              {r.label}
            </button>
          ))}
        </div>
      </header>

      {error && data === null && (
        <p class="module-panel__hint">{t('Vorhersagedaten konnten nicht geladen werden.', 'Forecast data could not be loaded.')}</p>
      )}

      <div class="weather-charts__grid">
        {chart(t('Temperatur & gefühlt', 'Temperature & apparent'), tempSeries, '°C', 'wchart-temp')}
        {chart(t('Niederschlag', 'Precipitation'), precipSeries, 'mm', 'wchart-precip')}
        {chart(t('Regenwahrscheinlichkeit', 'Rain probability'), probSeries, '%', 'wchart-prob')}
        {chart(t('Bewölkung', 'Cloud cover'), cloudSeries, '%', 'wchart-cloud')}
        {chart(t('Wind & Böen', 'Wind & gusts'), windSeries, 'km/h', 'wchart-wind')}
        {chart(t('Globalstrahlung', 'Global radiation'), radiationSeries, 'W/m²', 'wchart-radiation')}
        {chart(t('UV-Index', 'UV index'), uvSeries, '', 'wchart-uv')}
        {chart(t('Luftdruck', 'Air pressure'), pressureSeries, 'hPa', 'wchart-pressure')}
        {chart(t('Luftfeuchte', 'Humidity'), humiditySeries, '%', 'wchart-humidity')}
        {chart(t('Temperatur · 7 Tage (Min/Max)', 'Temperature · 7 days (min/max)'), dailyTempSeries, '°C', 'wchart-daily-temp', false)}
      </div>
    </div>
  );
}
