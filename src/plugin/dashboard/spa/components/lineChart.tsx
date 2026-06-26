/**
 * Heat Shield — dependency-free SVG line chart.
 *
 * A self-contained multi-series time-series chart rendered as inline SVG.
 * We avoid Chart.js to keep the offline bundle small and fully themed.
 *
 * Crisp, non-distorted rendering: the SVG measures its own rendered width and
 * uses it as the viewBox width so one SVG unit equals one CSS pixel on both
 * axes (no `preserveAspectRatio` stretching of text or strokes).
 *
 * Interactive: hovering (or touching) the plot shows a crosshair, per-series
 * dots and a value tooltip at the nearest sample — in the inline chart and in
 * the deep-dive modal alike.
 */

import { h, type JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

import { Portal } from './portal.js';

export interface ChartPoint {
  t: number;
  v: number | null;
}

export interface ChartSeries {
  label: string;
  color: string;
  points: ChartPoint[];
  /** Render this series with a dashed stroke (e.g. forecast). */
  dashed?: boolean;
}

export interface LineChartProps {
  series: ChartSeries[];
  /** Y-axis unit suffix, e.g. "°C" or "kW". */
  unit?: string;
  /** Pixel height of the plot (width is responsive, measured at runtime). */
  height?: number;
  /** Number of horizontal grid lines / y-ticks. */
  yTicks?: number;
  /** Optional epoch-millis position for a vertical "now" line. */
  nowT?: number;
  /** Optional shaded comfort band drawn behind the series. */
  comfortBand?: { lo: number; hi: number };
  /** Number of x-axis time labels. Default 3 (start/mid/end). */
  xTicks?: number;
}

const PAD_L = 44;
const PAD_R = 14;
const PAD_T = 12;
const PAD_B = 24;

function niceBounds(min: number, max: number): { lo: number; hi: number } {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { lo: 0, hi: 1 };
  if (min === max) {
    const pad = Math.abs(min) > 1e-9 ? Math.abs(min) * 0.1 : 1;
    return { lo: min - pad, hi: max + pad };
  }
  const span = max - min;
  const pad = span * 0.08;
  return { lo: min - pad, hi: max + pad };
}

function fmtTime(t: number): string {
  return new Date(t).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

function fmtVal(v: number, unit: string): string {
  const dp = unit === 'kW' || unit === 'mm' ? 1 : Math.abs(v) < 10 ? 1 : 0;
  return `${v.toFixed(dp)}${unit !== '' ? ` ${unit}` : ''}`;
}

/** Hook: track an element's rendered width (ResizeObserver, jsdom-safe). */
function useWidth(): { ref: { current: HTMLDivElement | null }; width: number } {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(600);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return undefined;
    const measure = (): void => {
      const w = el.getBoundingClientRect().width;
      if (w > 0) setWidth(w);
    };
    measure();
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      return (): void => ro.disconnect();
    }
    return undefined;
  }, []);
  return { ref, width };
}

export function LineChart(props: LineChartProps): JSX.Element {
  const { series, unit = '', height = 200, yTicks = 4, nowT, comfortBand, xTicks } = props;
  const viewH = height;
  const { ref, width } = useWidth();
  const [hoverT, setHoverT] = useState<number | null>(null);

  const allPoints = series.flatMap((s) =>
    s.points.filter((p): p is { t: number; v: number } => p.v !== null),
  );
  if (allPoints.length === 0) {
    return (
      <div ref={ref} class="line-chart line-chart--empty" data-testid="line-chart-empty">
        <p>Noch keine Verlaufsdaten.</p>
      </div>
    );
  }

  const VIEW_W = Math.max(240, Math.round(width));

  let tMin = Infinity;
  let tMax = -Infinity;
  let vMin = Infinity;
  let vMax = -Infinity;
  for (const p of allPoints) {
    if (p.t < tMin) tMin = p.t;
    if (p.t > tMax) tMax = p.t;
    if (p.v < vMin) vMin = p.v;
    if (p.v > vMax) vMax = p.v;
  }
  if (tMin === tMax) tMax = tMin + 1;
  if (comfortBand !== undefined) {
    if (comfortBand.lo < vMin) vMin = comfortBand.lo;
    if (comfortBand.hi > vMax) vMax = comfortBand.hi;
  }
  const { lo, hi } = niceBounds(vMin, vMax);

  const plotW = VIEW_W - PAD_L - PAD_R;
  const plotH = viewH - PAD_T - PAD_B;

  const xAt = (t: number): number => PAD_L + ((t - tMin) / (tMax - tMin)) * plotW;
  const yAt = (v: number): number => PAD_T + (1 - (v - lo) / (hi - lo)) * plotH;

  const yTickVals: number[] = [];
  for (let i = 0; i <= yTicks; i += 1) yTickVals.push(lo + ((hi - lo) * i) / yTicks);

  const pathFor = (pts: ChartPoint[]): string => {
    let d = '';
    let pen = false;
    for (const p of pts) {
      if (p.v === null) {
        pen = false;
        continue;
      }
      d += `${pen ? 'L' : 'M'}${xAt(p.t).toFixed(1)} ${yAt(p.v).toFixed(1)} `;
      pen = true;
    }
    return d.trim();
  };

  // Nearest sample time to the cursor, across all series.
  const times = Array.from(new Set(allPoints.map((p) => p.t))).sort((a, b) => a - b);
  const nearestT = (t: number): number => {
    let best = times[0]!;
    let bd = Infinity;
    for (const tt of times) {
      const d = Math.abs(tt - t);
      if (d < bd) {
        bd = d;
        best = tt;
      }
    }
    return best;
  };

  const onMove = (e: JSX.TargetedPointerEvent<SVGSVGElement>): void => {
    const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    if (rect.width <= 0) return;
    const px = ((e.clientX - rect.left) / rect.width) * VIEW_W;
    const tRaw = tMin + ((px - PAD_L) / plotW) * (tMax - tMin);
    setHoverT(nearestT(Math.min(tMax, Math.max(tMin, tRaw))));
  };

  // Hover read-out: nearest value per series at hoverT.
  const hover =
    hoverT === null
      ? null
      : {
          t: hoverT,
          x: xAt(hoverT),
          rows: series
            .map((s) => {
              let pv: number | null = null;
              let bd = Infinity;
              for (const p of s.points) {
                if (p.v === null) continue;
                const d = Math.abs(p.t - hoverT);
                if (d < bd) {
                  bd = d;
                  pv = p.v;
                }
              }
              return pv === null ? null : { label: s.label, color: s.color, v: pv };
            })
            .filter((r): r is { label: string; color: string; v: number } => r !== null),
        };

  const leftPct = hover === null ? 0 : (hover.x / VIEW_W) * 100;

  return (
    <figure ref={ref} class="line-chart" data-testid="line-chart">
      <div class="line-chart__plot">
        <svg
          viewBox={`0 0 ${VIEW_W} ${viewH}`}
          width="100%"
          height={viewH}
          preserveAspectRatio="none"
          role="img"
          class="line-chart__svg"
          onPointerMove={onMove}
          onPointerLeave={(): void => setHoverT(null)}
        >
          {comfortBand !== undefined && (
            <rect
              x={PAD_L}
              y={yAt(comfortBand.hi)}
              width={plotW}
              height={Math.max(0, yAt(comfortBand.lo) - yAt(comfortBand.hi))}
              class="line-chart__comfort"
              data-testid="line-chart-comfort"
            />
          )}
          {yTickVals.map((tv) => {
            const y = yAt(tv);
            return (
              <g key={`y${tv}`}>
                <line x1={PAD_L} y1={y} x2={VIEW_W - PAD_R} y2={y} class="line-chart__grid" />
                <text x={PAD_L - 6} y={y + 3} class="line-chart__ylabel">
                  {tv.toFixed(unit === 'kW' ? 1 : 0)}
                </text>
              </g>
            );
          })}
          {(xTicks !== undefined && xTicks >= 1
            ? Array.from({ length: xTicks + 1 }, (_, i) => tMin + ((tMax - tMin) * i) / xTicks)
            : [tMin, (tMin + tMax) / 2, tMax]
          ).map((tv, i, arr) => (
            <text
              key={`x${i}`}
              x={xAt(tv)}
              y={viewH - 7}
              class="line-chart__xlabel"
              text-anchor={i === 0 ? 'start' : i === arr.length - 1 ? 'end' : 'middle'}
            >
              {fmtTime(tv)}
            </text>
          ))}
          {series.map((s) => (
            <path
              key={s.label}
              d={pathFor(s.points)}
              fill="none"
              stroke={s.color}
              stroke-width={2}
              vector-effect="non-scaling-stroke"
              stroke-linejoin="round"
              stroke-linecap="round"
              {...(s.dashed === true ? { 'stroke-dasharray': '5 4' } : {})}
              data-testid={`line-chart-series-${s.label}`}
            />
          ))}
          {nowT !== undefined && nowT >= tMin && nowT <= tMax && (
            <line
              x1={xAt(nowT)}
              y1={PAD_T}
              x2={xAt(nowT)}
              y2={viewH - PAD_B}
              class="line-chart__nowline"
              stroke="#ffffff88"
              stroke-dasharray="3 3"
              vector-effect="non-scaling-stroke"
              data-testid="line-chart-nowline"
            />
          )}
          {hover !== null && (
            <g data-testid="line-chart-cursor">
              <line
                x1={hover.x}
                y1={PAD_T}
                x2={hover.x}
                y2={viewH - PAD_B}
                class="line-chart__cursor"
                vector-effect="non-scaling-stroke"
              />
              {hover.rows.map((r) => (
                <circle key={r.label} cx={hover.x} cy={yAt(r.v)} r={3.2} fill={r.color} />
              ))}
            </g>
          )}
        </svg>
        {hover !== null && hover.rows.length > 0 && (
          <div
            class={`line-chart__tip${leftPct > 60 ? ' line-chart__tip--left' : ''}`}
            style={{ left: `${leftPct}%` }}
            data-testid="line-chart-tip"
          >
            <span class="line-chart__tip-time">{fmtTime(hover.t)}</span>
            {hover.rows.map((r) => (
              <span key={r.label} class="line-chart__tip-row">
                <span class="line-chart__swatch" style={{ background: r.color }} />
                {r.label}: <strong>{fmtVal(r.v, unit)}</strong>
              </span>
            ))}
          </div>
        )}
      </div>
      <figcaption class="line-chart__legend">
        {series.map((s) => (
          <span key={s.label} class="line-chart__legend-item">
            <span class="line-chart__swatch" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
        {unit !== '' && <span class="line-chart__unit">in {unit}</span>}
      </figcaption>
    </figure>
  );
}

/**
 * A LineChart with a deep-dive affordance: an expand button opens a modal
 * that re-renders the same series larger, with more ticks. The chart inside
 * is fully interactive (hover crosshair + value tooltip). Closes on backdrop
 * click or ×.
 */
export function ExpandableChart(
  props: LineChartProps & { title: string; subtitle?: string },
): JSX.Element {
  const [open, setOpen] = useState(false);
  const { title, subtitle, ...chart } = props;
  return (
    <div class="chart-expand" data-testid="chart-expand">
      <button
        type="button"
        class="chart-expand__btn"
        aria-label={`${title} vergrößern`}
        title="Vergrößern"
        onClick={(): void => setOpen(true)}
      >
        ⤢
      </button>
      <LineChart {...chart} />
      {open && (
        <Portal>
          <div
            class="chart-modal"
            data-testid="chart-modal"
            role="dialog"
            aria-label={title}
            onClick={(): void => setOpen(false)}
          >
            <div
              class="chart-modal__panel"
              onClick={(e: JSX.TargetedMouseEvent<HTMLDivElement>): void => e.stopPropagation()}
            >
              <header class="chart-modal__head">
                <span class="chart-modal__title">
                  {title}
                  {subtitle !== undefined && <span class="chart-modal__subtitle">{subtitle}</span>}
                </span>
                <button
                  type="button"
                  class="chart-modal__close"
                  aria-label="Schließen"
                  onClick={(): void => setOpen(false)}
                >
                  ×
                </button>
              </header>
              <div class="chart-modal__body">
                <LineChart {...chart} height={460} yTicks={6} xTicks={8} />
              </div>
            </div>
          </div>
        </Portal>
      )}
    </div>
  );
}
