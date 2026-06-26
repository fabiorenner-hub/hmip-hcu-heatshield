/**
 * Heat Shield — current weather facts (Wetter tab).
 *
 * A compact grid of "right now / today" values fetched client-side from the
 * public Open-Meteo API (CORS, no key): UV index, precipitation (now + today),
 * air pressure, humidity, plus sunrise/sunset times. No backend plumbing.
 */

import { h, type JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import { t, fmtNum, locale } from '../../i18n.js';

interface Facts {
  uv: number | null;
  humidity: number | null;
  pressure: number | null;
  precipNow: number | null;
  precipToday: number | null;
  sunrise: string | null;
  sunset: string | null;
}

function hhmm(iso: string | null): string {
  if (iso === null) return '–';
  const m = /T(\d\d:\d\d)/.exec(iso);
  if (m !== null) return m[1]!;
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '–'
    : d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', hour12: false });
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function mm(v: number): string {
  return `${fmtNum(v, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} mm`;
}

export function WeatherFacts(props: {
  latitude: number;
  longitude: number;
  fetchFn?: typeof globalThis.fetch;
}): JSX.Element {
  const [f, setF] = useState<Facts | null>(null);

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
          '&current=relative_humidity_2m,surface_pressure,precipitation' +
          '&hourly=uv_index' +
          '&daily=sunrise,sunset,precipitation_sum,uv_index_max' +
          '&timezone=auto&forecast_days=1';
        const res = await fetchFn(url, { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = (await res.json()) as {
          current?: Record<string, number>;
          hourly?: { time?: string[]; uv_index?: Array<number | null> };
          daily?: Record<string, Array<number | string | null>>;
        };
        if (cancelled) return;
        // UV "now": nearest hourly sample, else today's max.
        let uv: number | null = null;
        const times = j.hourly?.time ?? [];
        const uvArr = j.hourly?.uv_index ?? [];
        if (times.length > 0) {
          const nowMs = Date.now();
          let best = 0;
          let bestDiff = Infinity;
          for (let i = 0; i < times.length; i += 1) {
            const t = Date.parse(times[i]!);
            const diff = Math.abs(t - nowMs);
            if (Number.isFinite(t) && diff < bestDiff) {
              bestDiff = diff;
              best = i;
            }
          }
          uv = num(uvArr[best]);
        }
        if (uv === null) uv = num(j.daily?.['uv_index_max']?.[0]);
        const c = j.current ?? {};
        const daily = j.daily ?? {};
        setF({
          uv,
          humidity: num(c['relative_humidity_2m']),
          pressure: num(c['surface_pressure']),
          precipNow: num(c['precipitation']),
          precipToday: num(daily['precipitation_sum']?.[0]),
          sunrise: typeof daily['sunrise']?.[0] === 'string' ? (daily['sunrise'][0] as string) : null,
          sunset: typeof daily['sunset']?.[0] === 'string' ? (daily['sunset'][0] as string) : null,
        });
      } catch {
        /* leave facts null → tiles show em-dash */
      }
    };
    void load();
    const id = setInterval(() => void load(), 10 * 60_000);
    return (): void => {
      cancelled = true;
      clearInterval(id);
    };
  }, [props.latitude, props.longitude, props.fetchFn]);

  const fact = (label: string, value: string, testId: string): JSX.Element => (
    <div class="wfact" data-testid={testId}>
      <span class="wfact__label">{label}</span>
      <span class="wfact__value">{value}</span>
    </div>
  );

  return (
    <article class="weather-facts module-panel__card" data-testid="weather-facts">
      <h3>{t('Aktuelle Werte', 'Current values')}</h3>
      <div class="weather-facts__grid">
        {fact(t('UV-Index', 'UV index'), f?.uv === null || f?.uv === undefined ? '–' : `${Math.round(f.uv)}`, 'wfact-uv')}
        {fact(
          t('Niederschlag jetzt', 'Precipitation now'),
          f?.precipNow === null || f?.precipNow === undefined ? '–' : mm(f.precipNow),
          'wfact-precip-now',
        )}
        {fact(
          t('Niederschlag heute', 'Precipitation today'),
          f?.precipToday === null || f?.precipToday === undefined ? '–' : mm(f.precipToday),
          'wfact-precip-today',
        )}
        {fact(
          t('Luftdruck', 'Air pressure'),
          f?.pressure === null || f?.pressure === undefined ? '–' : `${Math.round(f.pressure)} hPa`,
          'wfact-pressure',
        )}
        {fact(
          t('Luftfeuchte', 'Humidity'),
          f?.humidity === null || f?.humidity === undefined ? '–' : `${Math.round(f.humidity)} %`,
          'wfact-humidity',
        )}
        {fact(t('Sonnenaufgang', 'Sunrise'), hhmm(f?.sunrise ?? null), 'wfact-sunrise')}
        {fact(t('Sonnenuntergang', 'Sunset'), hhmm(f?.sunset ?? null), 'wfact-sunset')}
      </div>
    </article>
  );
}
