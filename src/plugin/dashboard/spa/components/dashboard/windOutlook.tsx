/**
 * Heat Shield — compact wind outlook (Wetter tab, below the wind rose).
 *
 * A small companion card to the wind rose: today's and tomorrow's maximum
 * gusts and the dominant wind direction, fetched client-side from Open-Meteo
 * (CORS, no key). Keeps the rose itself small while still surfacing useful
 * "other" wind information directly underneath it.
 */

import { h, type JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import { t } from '../../i18n.js';

interface Outlook {
  gustTodayMax: number | null;
  gustTomorrowMax: number | null;
  domDirToday: number | null;
}

const CARDINALS = ['N', 'NO', 'O', 'SO', 'S', 'SW', 'W', 'NW'] as const;
const CARDINALS_EN = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

/** Localized cardinal abbreviation for a degree value (DE: N/NO/O/SO, EN: N/NE/E/SE). */
function cardinal(deg: number): string {
  const idx = Math.round((((deg % 360) + 360) % 360) / 45) % 8;
  return t(CARDINALS[idx]!, CARDINALS_EN[idx]!);
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function WindOutlook(props: {
  latitude: number;
  longitude: number;
  fetchFn?: typeof globalThis.fetch;
}): JSX.Element {
  const [o, setO] = useState<Outlook | null>(null);

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
          '&daily=wind_gusts_10m_max,wind_direction_10m_dominant' +
          '&wind_speed_unit=kmh&timezone=auto&forecast_days=2';
        const res = await fetchFn(url, { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = (await res.json()) as {
          daily?: {
            wind_gusts_10m_max?: Array<number | null>;
            wind_direction_10m_dominant?: Array<number | null>;
          };
        };
        if (cancelled) return;
        const gusts = j.daily?.wind_gusts_10m_max ?? [];
        const dirs = j.daily?.wind_direction_10m_dominant ?? [];
        setO({
          gustTodayMax: num(gusts[0]),
          gustTomorrowMax: num(gusts[1]),
          domDirToday: num(dirs[0]),
        });
      } catch {
        /* leave null → em-dash */
      }
    };
    void load();
    const id = setInterval(() => void load(), 15 * 60_000);
    return (): void => {
      cancelled = true;
      clearInterval(id);
    };
  }, [props.latitude, props.longitude, props.fetchFn]);

  const row = (label: string, value: string, testId: string): JSX.Element => (
    <div class="wind-outlook__row" data-testid={testId}>
      <span class="wind-outlook__label">{label}</span>
      <span class="wind-outlook__value">{value}</span>
    </div>
  );

  return (
    <article class="module-panel__card wind-outlook" data-testid="wind-outlook">
      <h3>{t('Wind-Ausblick', 'Wind outlook')}</h3>
      {row(
        t('Böen heute (max)', 'Gusts today (max)'),
        o?.gustTodayMax === null || o?.gustTodayMax === undefined
          ? '–'
          : `${Math.round(o.gustTodayMax)} km/h`,
        'wind-outlook-gust-today',
      )}
      {row(
        t('Böen morgen (max)', 'Gusts tomorrow (max)'),
        o?.gustTomorrowMax === null || o?.gustTomorrowMax === undefined
          ? '–'
          : `${Math.round(o.gustTomorrowMax)} km/h`,
        'wind-outlook-gust-tomorrow',
      )}
      {row(
        t('Hauptrichtung heute', 'Dominant direction today'),
        o?.domDirToday === null || o?.domDirToday === undefined
          ? '–'
          : `${cardinal(o.domDirToday)} (${Math.round(o.domDirToday)}°)`,
        'wind-outlook-dom-dir',
      )}
    </article>
  );
}
