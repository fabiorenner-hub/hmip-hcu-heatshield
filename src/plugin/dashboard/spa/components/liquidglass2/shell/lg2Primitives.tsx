/**
 * Heat Shield — "Liquid Glass V2" shared primitives (ui-v2-release, Task 2).
 *
 * Dependency-free SVG primitives, the number formatter, the segmented control
 * and the room grid + room-detail modal wiring — extracted verbatim from
 * `liquidGlass2Overview.tsx` so every v2 page (and the shell) can reuse them
 * without duplicating markup. Presentational only: reads the shared snapshot
 * signals and degrades honestly to `–`.
 */

import { h, Fragment, type JSX } from 'preact';
import { useState } from 'preact/hooks';

import { t, fmtNum } from '../../../i18n.js';
import { snapshot, riskBreakdowns } from '../../../store.js';
import { RoomDetailModal } from '../../dashboard/roomDetailModal.js';
import type { RoomDetail } from '../../../types.js';

/** One-decimal number with an honest `–` fallback. */
export function num1(v: number | null): string {
  return v === null || !Number.isFinite(v)
    ? '–'
    : fmtNum(Math.round(v * 10) / 10, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

/** Dependency-free sparkline (line + optional area fill). */
export function Sparkline(props: { values: number[]; color: string; area?: boolean; id: string }): JSX.Element | null {
  const vals = props.values.filter((v) => Number.isFinite(v));
  if (vals.length < 2) return null;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const n = vals.length;
  const x = (i: number): number => (i / (n - 1)) * 100;
  const y = (v: number): number => 34 - ((v - min) / span) * 30 - 2;
  let line = '';
  vals.forEach((v, i) => {
    line += `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(v).toFixed(1)} `;
  });
  const areaPath = `${line}L100 36 L0 36 Z`;
  return (
    <svg class="lg2-spark" viewBox="0 0 100 36" preserveAspectRatio="none" aria-hidden="true">
      {props.area === true && (
        <Fragment>
          <defs>
            <linearGradient id={`sp-${props.id}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color={props.color} stop-opacity="0.34" />
              <stop offset="100%" stop-color={props.color} stop-opacity="0" />
            </linearGradient>
          </defs>
          <path d={areaPath} fill={`url(#sp-${props.id})`} stroke="none" />
        </Fragment>
      )}
      <path
        d={line.trim()}
        fill="none"
        stroke={props.color}
        stroke-width={2}
        stroke-linejoin="round"
        stroke-linecap="round"
        vector-effect="non-scaling-stroke"
      />
    </svg>
  );
}

/** Small progress donut for the reliability metric. */
export function Donut(props: { frac: number; color: string; size?: number }): JSX.Element {
  const size = props.size ?? 40;
  const r = size / 2 - 4;
  const c = 2 * Math.PI * r;
  const dash = Math.max(0, Math.min(1, props.frac)) * c;
  return (
    <svg class="lg2-donut" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.12)" stroke-width={4} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={props.color}
        stroke-width={4}
        stroke-linecap="round"
        stroke-dasharray={`${dash.toFixed(1)} ${c.toFixed(1)}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}

/** Refresh glyph (Apple-like circular arrow) — no matching entry in Icon set. */
export function RefreshGlyph(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M20 11a8 8 0 1 0-.7 3.3" />
      <path d="M20 5v6h-6" />
    </svg>
  );
}

/** Help glyph — no matching entry in the Icon set. */
export function HelpGlyph(): JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9.2a2.5 2.5 0 0 1 4.4 1.6c0 1.7-2.4 2-2.4 3.4" />
      <path d="M12 17.2v.01" />
    </svg>
  );
}

/** Generic segmented control (2–3 options) used by the appearance editors. */
export function Seg<T extends string>(props: {
  value: T;
  options: Array<[T, string]>;
  onChange: (v: T) => void;
}): JSX.Element {
  return (
    <div class="lg2-seg" role="tablist">
      {props.options.map(([v, lbl]) => (
        <button key={v} type="button" role="tab" aria-selected={props.value === v}
          class={`lg2-seg__btn${props.value === v ? ' lg2-seg__btn--on' : ''}`}
          onClick={(): void => props.onChange(v)}>{lbl}</button>
      ))}
    </div>
  );
}

/** Heat tone from indoor temperature (matches the legend thresholds). */
function tempTone(tempC: number | null): 'ok' | 'mid' | 'hot' | 'unknown' {
  if (tempC === null || !Number.isFinite(tempC)) return 'unknown';
  if (tempC > 26) return 'hot';
  if (tempC >= 24) return 'mid';
  return 'ok';
}
const TONE_LABEL: Record<'ok' | 'mid' | 'hot' | 'unknown', [string, string]> = {
  ok: ['Gering', 'Low'],
  mid: ['Mittel', 'Medium'],
  hot: ['Hoch', 'High'],
  unknown: ['—', '—'],
};

/** Trend arrow glyph, matching the classic 1.20 room tile. */
const TREND_GLYPH: Record<'up' | 'down' | 'flat', string> = { up: '↑', down: '↓', flat: '→' };

/**
 * Room overview — classic "1.20" tile form. A simple, robust responsive grid
 * of fixed-size cards (`repeat(auto-fill, minmax(…))`): each tile has a left
 * status bar (tone), the room name + tone dot/label, the big temperature with
 * a trend arrow, and a footer with the shutter position (and "open" when a
 * window is open). All rooms are shown; if there are more tiles than fit the
 * card height, the card scrolls internally (a single, contained scrollbar —
 * never the whole page). Deliberately NOT measured/auto-shrinking: the tiles
 * keep a constant, legible size instead of being squeezed to fit.
 */
export function RoomGrid(props: { rooms: RoomDetail[]; onSelect: (id: string) => void }): JSX.Element {
  return (
    <div class="lg2-rooms" data-testid="lg2-rooms">
      {props.rooms.map((r) => {
        const tone = r.indoorTempState === 'unbound' ? 'unknown' : tempTone(r.indoorTempC);
        const trend: 'up' | 'down' | 'flat' =
          r.trend === 'up' || r.trend === 'down' ? r.trend : 'flat';
        return (
          <button type="button" class={`lg2-roomcard lg2-roomcard--${tone}`} key={r.id}
            onClick={(): void => props.onSelect(r.id)}
            title={t('Details anzeigen', 'Show details')}>
            <span class="lg2-roomcard__top">
              <span class="lg2-roomcard__name">{r.name}</span>
              <span class="lg2-roomcard__tone">
                <span class={`lg2-dot lg2-dot--${tone === 'unknown' ? 'ok' : tone}`} />{' '}
                <span class="lg2-roomcard__tone-label">{t(...TONE_LABEL[tone])}</span>
              </span>
            </span>
            <span class="lg2-roomcard__temp">
              {r.indoorTempC === null ? '–' : `${num1(r.indoorTempC)}°`}
              <span class={`lg2-roomcard__trend lg2-roomcard__trend--${trend}`} aria-hidden="true">
                {TREND_GLYPH[trend]}
              </span>
            </span>
            <span class="lg2-roomcard__meta">
              {t('Rollladen', 'Shutter')} {Math.round(r.shutterPercent)} %
              {r.windowOpen === true ? ` · ${t('offen', 'open')}` : ''}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Room-detail popup wiring shared by the V2 pages (same modal as v1.20). */
export function useRoomModal(): { open: (id: string) => void; node: JSX.Element | null } {
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const snap = snapshot.value;
  const rooms = snap?.roomsDetail ?? [];
  const selected = rooms.find((r) => r.id === selectedRoomId) ?? null;
  const risk = selected?.windowId !== undefined ? riskBreakdowns.value[selected.windowId] : undefined;
  const learning = snap?.learning?.rooms.find((r) => r.id === selectedRoomId);
  const node = selected !== null
    ? (
      <RoomDetailModal
        room={selected}
        {...(risk !== undefined ? { risk } : {})}
        {...(learning !== undefined ? { learning } : {})}
        onClose={(): void => setSelectedRoomId(null)}
      />
    )
    : null;
  return { open: (id: string): void => setSelectedRoomId(id), node };
}
