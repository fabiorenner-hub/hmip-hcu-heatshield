/**
 * Heat Shield — DWD severe-weather warnings (Wetter tab).
 *
 * Polls the server proxy `GET /api/dwd-warnings` (which reads the official DWD
 * feed for the configured region) and renders the active warnings as severity-
 * coloured cards. Empty state = "keine Warnungen".
 */

import { h, type JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';

interface DwdWarning {
  level: number;
  event: string;
  headline: string;
  description: string;
  instruction: string;
  start: number | null;
  end: number | null;
  regionName: string;
  preliminary: boolean;
}

interface DwdResponse {
  enabled: boolean;
  cellId: string | null;
  regionName: string;
  time: number | null;
  warnings: DwdWarning[];
}

const LEVEL_LABEL: Record<number, string> = {
  1: 'Wetterwarnung',
  2: 'Markante Wetterwarnung',
  3: 'Unwetterwarnung',
  4: 'Extremes Unwetter',
};

function fmtTime(ms: number | null): string {
  if (ms === null) return '';
  return new Date(ms).toLocaleString('de-DE', {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function DwdWarnings(props: {
  /** Test seam. */
  fetchFn?: typeof globalThis.fetch;
}): JSX.Element | null {
  const [data, setData] = useState<DwdResponse | null>(null);

  useEffect(() => {
    const fetchFn = props.fetchFn ?? globalThis.fetch.bind(globalThis);
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const res = await fetchFn('/api/dwd-warnings', {
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as DwdResponse;
        if (!cancelled) {
          setData(json);
        }
      } catch {
        /* keep last data; the panel simply stays hidden when empty */
      }
    };
    void load();
    const id = setInterval(() => void load(), 5 * 60_000);
    return (): void => {
      cancelled = true;
      clearInterval(id);
    };
  }, [props.fetchFn]);

  if (data !== null && data.enabled === false) return null;

  const warnings = data?.warnings ?? [];
  const sorted = [...warnings].sort((a, b) => b.level - a.level);

  // Only show the panel when there is actually something to warn about.
  if (sorted.length === 0) return null;

  return (
    <section class="dwd-warnings" data-testid="dwd-warnings">
      <header class="dwd-warnings__head">
        <h2>Unwetterwarnungen (DWD)</h2>
        {data !== null && (
          <span class="dwd-warnings__region">
            {data.regionName}
            {data.time !== null ? ` · Stand ${fmtTime(data.time)}` : ''}
          </span>
        )}
      </header>
      <ul class="dwd-warnings__list">
        {sorted.map((w, i) => (
          <li
            key={`${w.event}-${w.start}-${i}`}
            class={`dwd-warning dwd-warning--l${Math.max(1, Math.min(4, w.level))}${
              w.preliminary ? ' dwd-warning--pre' : ''
            }`}
            data-testid="dwd-warning"
          >
            <div class="dwd-warning__top">
              <span class="dwd-warning__badge">
                {w.preliminary ? 'Vorabinfo' : LEVEL_LABEL[w.level] ?? 'Warnung'}
              </span>
              <span class="dwd-warning__event">{w.event}</span>
            </div>
            <p class="dwd-warning__headline">{w.headline}</p>
            {(w.start !== null || w.end !== null) && (
              <p class="dwd-warning__when">
                {w.start !== null ? `ab ${fmtTime(w.start)}` : ''}
                {w.end !== null ? ` bis ${fmtTime(w.end)}` : ''}
              </p>
            )}
            {w.instruction.length > 0 && (
              <p class="dwd-warning__instruction">{w.instruction}</p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
