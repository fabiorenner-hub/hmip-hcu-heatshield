/**
 * Heat Shield — wind rose (Wetter tab).
 *
 * A compact SVG compass showing the current wind: a needle pointing FROM the
 * direction the wind blows (meteorological convention), the cardinal label,
 * the mean speed and the gust speed. Wind data is fetched client-side directly
 * from the public Open-Meteo API (CORS-enabled, no key) so this widget needs
 * no backend plumbing.
 */

import { h, type JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import { t } from '../../i18n.js';

interface WindState {
  speedMs: number | null;
  gustMs: number | null;
  dirDeg: number | null;
  cloudPct: number | null;
}

const CARDINALS = ['N', 'NO', 'O', 'SO', 'S', 'SW', 'W', 'NW'] as const;
const CARDINALS_EN = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

function cardinalIdx(deg: number): number {
  return Math.round((((deg % 360) + 360) % 360) / 45) % 8;
}

/** Localized cardinal abbreviation for a degree value (DE: N/NO/O/SO, EN: N/NE/E/SE). */
function cardinal(deg: number): string {
  const idx = cardinalIdx(deg);
  return t(CARDINALS[idx]!, CARDINALS_EN[idx]!);
}

function beaufort(ms: number): number {
  // Approximate Beaufort scale from m/s.
  const t = [0.3, 1.6, 3.4, 5.5, 8, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7];
  let b = 0;
  for (const x of t) {
    if (ms >= x) b += 1;
    else break;
  }
  return b;
}

export function WindRose(props: {
  latitude: number;
  longitude: number;
  /** Test seam: inject a fetch implementation. */
  fetchFn?: typeof globalThis.fetch;
}): JSX.Element {
  const [wind, setWind] = useState<WindState | null>(null);
  const [error, setError] = useState<boolean>(false);

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
          '&current=wind_speed_10m,wind_gusts_10m,wind_direction_10m,cloud_cover&wind_speed_unit=kmh&timezone=GMT';
        const res = await fetchFn(url, { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { current?: Record<string, number> };
        const c = json.current ?? {};
        if (cancelled) return;
        setWind({
          speedMs: typeof c['wind_speed_10m'] === 'number' ? c['wind_speed_10m'] : null,
          gustMs: typeof c['wind_gusts_10m'] === 'number' ? c['wind_gusts_10m'] : null,
          dirDeg: typeof c['wind_direction_10m'] === 'number' ? c['wind_direction_10m'] : null,
          cloudPct: typeof c['cloud_cover'] === 'number' ? c['cloud_cover'] : null,
        });
        setError(false);
      } catch {
        if (!cancelled) setError(true);
      }
    };
    void load();
    const id = setInterval(() => void load(), 10 * 60_000);
    return (): void => {
      cancelled = true;
      clearInterval(id);
    };
  }, [props.latitude, props.longitude, props.fetchFn]);

  const dir = wind?.dirDeg ?? null;
  const speed = wind?.speedMs ?? null;
  const gust = wind?.gustMs ?? null;
  const cloud = wind?.cloudPct ?? null;

  // Compass geometry (viewBox 0..100). The needle points toward the source
  // of the wind (FROM direction): a vector at `dir` degrees from North.
  const cx = 50;
  const cy = 50;
  const r = 38;
  const rad = ((dir ?? 0) - 90) * (Math.PI / 180); // 0°=N at top
  const fromX = cx + Math.cos(rad) * r;
  const fromY = cy + Math.sin(rad) * r;
  const toX = cx - Math.cos(rad) * r * 0.62;
  const toY = cy - Math.sin(rad) * r * 0.62;

  return (
    <article class="windrose-card module-panel__card" data-testid="windrose">
      <h3>{t('Wind & Windrichtung', 'Wind & wind direction')}</h3>
      <div class="windrose__body">
        <svg class="windrose__dial" viewBox="0 0 100 100" role="img" aria-label={t('Windrose', 'Wind rose')}>
          <circle class="windrose__ring" cx={cx} cy={cy} r={r} />
          <circle class="windrose__ring windrose__ring--inner" cx={cx} cy={cy} r={r * 0.66} />
          {CARDINALS.map((c, i) => {
            const a = (i * 45 - 90) * (Math.PI / 180);
            const lx = cx + Math.cos(a) * (r + 7);
            const ly = cy + Math.sin(a) * (r + 7) + 3;
            return (
              <text
                key={c}
                class={`windrose__card-label${c === 'N' ? ' windrose__card-label--n' : ''}`}
                x={lx}
                y={ly}
                text-anchor="middle"
              >
                {t(c, CARDINALS_EN[i]!)}
              </text>
            );
          })}
          {/* tick marks every 45° */}
          {CARDINALS.map((_c, i) => {
            const a = (i * 45 - 90) * (Math.PI / 180);
            const x1 = cx + Math.cos(a) * r;
            const y1 = cy + Math.sin(a) * r;
            const x2 = cx + Math.cos(a) * (r - 5);
            const y2 = cy + Math.sin(a) * (r - 5);
            return <line key={i} class="windrose__tick" x1={x1} y1={y1} x2={x2} y2={y2} />;
          })}
          {dir !== null && (
            <g class="windrose__needle" data-testid="windrose-needle">
              <line x1={toX} y1={toY} x2={fromX} y2={fromY} class="windrose__needle-line" />
              <circle cx={fromX} cy={fromY} r={4} class="windrose__needle-head" />
            </g>
          )}
          <circle cx={cx} cy={cy} r={3} class="windrose__hub" />
        </svg>
        <dl class="windrose__readout">
          <div>
            <dt>{t('Richtung', 'Direction')}</dt>
            <dd data-testid="windrose-dir">
              {dir === null ? '–' : `${cardinal(dir)} (${Math.round(dir)}°)`}
            </dd>
          </div>
          <div>
            <dt>{t('Geschwindigkeit', 'Speed')}</dt>
            <dd>
              {speed === null ? '–' : `${Math.round(speed)} km/h`}
              {speed !== null && <span class="windrose__bft"> · {beaufort(speed / 3.6)} Bft</span>}
            </dd>
          </div>
          <div>
            <dt>{t('Böen', 'Gusts')}</dt>
            <dd>{gust === null ? '–' : `${Math.round(gust)} km/h`}</dd>
          </div>
          <div>
            <dt>{t('Bewölkung', 'Cloud cover')}</dt>
            <dd data-testid="windrose-cloud">{cloud === null ? '–' : `${Math.round(cloud)} %`}</dd>
          </div>
        </dl>
      </div>
      {error && <p class="windrose__error">{t('Winddaten konnten nicht geladen werden.', 'Wind data could not be loaded.')}</p>}
    </article>
  );
}
