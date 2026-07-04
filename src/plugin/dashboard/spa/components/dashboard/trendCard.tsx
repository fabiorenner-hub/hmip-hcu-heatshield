/**
 * Heat Shield — reusable trend card with deep-dive (V1.7).
 *
 * Fetches the rolling trend samples (`GET /api/trends?seconds=`) and renders
 * an {@link ExpandableChart} so any tab can offer a "Verlauf" with the same
 * click-to-enlarge deep-dive as the Forecast tab. Two variants:
 *   - `temps`: outdoor + every room temperature line.
 *   - `pv`:    PV power.
 *
 * Defensive: a missing/failed fetch leaves the chart in its empty state.
 */

import { h, type JSX } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';

import { ExpandableChart, type ChartSeries } from '../lineChart.js';
import { snapshot } from '../../store.js';
import { t } from '../../i18n.js';

interface TrendSample {
  ts: string;
  key: string;
  value: number;
}

const ROOM_COLORS = [
  '#4a8cff',
  '#ff5d57',
  '#66d66b',
  '#ff9d2e',
  '#9b7cff',
  '#35d6e7',
  '#ffd45a',
  '#ffc45b',
];

export function TrendCard(props: {
  title: string;
  variant: 'temps' | 'pv';
  seconds?: number;
}): JSX.Element {
  const seconds = props.seconds ?? 43200;
  const [samples, setSamples] = useState<TrendSample[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async (): Promise<void> => {
      try {
        const res = await fetch(`/api/trends?seconds=${seconds}`, {
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) return;
        const json = (await res.json()) as { samples: TrendSample[] };
        if (!cancelled) setSamples(json.samples);
      } catch {
        /* empty state */
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, [seconds]);

  const series: ChartSeries[] = useMemo(() => {
    const all = samples ?? [];
    const grouped = new Map<string, Array<{ t: number; v: number }>>();
    for (const s of all) {
      const t = Date.parse(s.ts);
      if (!Number.isFinite(t)) continue;
      const arr = grouped.get(s.key) ?? [];
      arr.push({ t, v: s.value });
      grouped.set(s.key, arr);
    }
    for (const arr of grouped.values()) arr.sort((a, b) => a.t - b.t);

    const roomName = (roomId: string): string =>
      snapshot.value?.rooms?.find((r) => r.id === roomId)?.name ?? roomId;

    const out: ChartSeries[] = [];
    if (props.variant === 'pv') {
      const pv = grouped.get('pv');
      if (pv !== undefined && pv.length > 0) {
        out.push({ label: t('PV-Leistung', 'PV power'), color: '#f59e0b', points: pv });
      }
      return out;
    }
    const outdoor = grouped.get('outdoor');
    if (outdoor !== undefined && outdoor.length > 0) {
      out.push({ label: t('Außen', 'Outdoor'), color: '#e2e8f0', points: outdoor });
    }
    let ci = 0;
    for (const [key, pts] of grouped) {
      if (!key.startsWith('room:') || pts.length === 0) continue;
      out.push({
        label: roomName(key.slice('room:'.length)),
        color: ROOM_COLORS[ci % ROOM_COLORS.length]!,
        points: pts,
      });
      ci += 1;
    }
    return out;
  }, [samples, props.variant]);

  return (
    <article class="module-panel__card trend-card" data-testid={`trend-card-${props.variant}`}>
      <h2>{props.title}</h2>
      {series.length > 0 ? (
        <ExpandableChart
          title={props.title}
          series={series}
          unit={props.variant === 'pv' ? 'kW' : '°C'}
        />
      ) : (
        <p class="module-panel__hint">{t('Noch keine Verlaufsdaten.', 'No trend data yet.')}</p>
      )}
    </article>
  );
}
