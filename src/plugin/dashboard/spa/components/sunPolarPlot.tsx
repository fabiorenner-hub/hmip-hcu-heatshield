/**
 * Sun polar plot (Task 11.3).
 *
 * Renders today's sun trajectory in a 320×320 SVG with North up
 * and East right. Azimuth maps to angle, elevation to radius
 * (0° = horizon at the outer ring, 90° = zenith at the centre).
 * Concentric guide circles sit at 30°, 60°, and the horizon (90°
 * from zenith).
 *
 * Decision (documented per task brief): we **inline** a minimal
 * `getSunPosition(now, lat, lon)` helper rather than spinning up
 * a backend `/api/sun` endpoint. Reasons:
 *   - The trajectory is a pure function of `(date, lat, lon)`. The
 *     dashboard already pulls latitude / longitude through the
 *     existing `/api/config` route, so the SPA has everything it
 *     needs without another round-trip.
 *   - Inlining keeps the SPA self-contained — no extra endpoint to
 *     test, no extra coupling to engine internals.
 *   - The implementation below (~30 LOC) is accurate to ≈0.5° for
 *     plotting use, well within the chart's ≈3° pixel resolution.
 *     We deliberately avoid bundling `suncalc` itself: the package
 *     would inflate the SPA bundle and adds a CommonJS edge case
 *     the esbuild step handles, but is unnecessary for plotting.
 *
 * Window markers: each priority window receives a coloured dot at
 * the sun position computed for its `sunOnWindow` time. The marker
 * list is fed in via props so the parent (`<Live/>` tab) can
 * derive it from the snapshot however it wants.
 */

import { h, type JSX } from 'preact';

import { t } from '../i18n.js';

const SIZE = 320;
const CENTER = SIZE / 2;
const RADIUS = SIZE / 2 - 16;

export interface SunMarker {
  windowId: string;
  /** Local clock time the sun is on this window. */
  at: Date;
  color: string;
  label?: string;
}

export interface SunPolarPlotProps {
  latitude: number;
  longitude: number;
  /** "Now" reference clock; defaults to `new Date()`. */
  now?: Date;
  /** Optional per-window markers. */
  markers?: SunMarker[];
  /** Number of trajectory samples between sunrise and sunset. */
  trajectorySamples?: number;
}

export function SunPolarPlot(props: SunPolarPlotProps): JSX.Element {
  const now = props.now ?? new Date();
  const samples = props.trajectorySamples ?? 96;
  const dayStart = startOfDay(now);
  const dayEnd = endOfDay(now);

  // Sample the day in 96 steps (15 min). Each sample becomes one
  // trajectory point; below-horizon points are kept so the dashed
  // night portion lines up with the daytime arc.
  const points: Array<{ x: number; y: number; aboveHorizon: boolean }> = [];
  for (let i = 0; i <= samples; i += 1) {
    const t = dayStart.getTime() + (i / samples) * (dayEnd.getTime() - dayStart.getTime());
    const pos = getSunPosition(new Date(t), props.latitude, props.longitude);
    points.push({
      ...polarToCartesian(pos.azimuthDeg, pos.elevationDeg),
      aboveHorizon: pos.elevationDeg > 0,
    });
  }

  const dayPath = pathFromPoints(points.filter((p) => p.aboveHorizon));
  const nightPath = pathFromPoints(points.filter((p) => !p.aboveHorizon));

  const sunNow = getSunPosition(now, props.latitude, props.longitude);
  const sunNowXY = polarToCartesian(sunNow.azimuthDeg, sunNow.elevationDeg);

  // Shadow indicator: a shadow is cast opposite the sun's azimuth. The lower
  // the sun, the longer the shadow. We draw a soft wedge from the centre
  // toward the anti-solar direction, length ∝ cot(elevation) (capped).
  const shadow = sunNow.elevationDeg > 0 ? shadowWedge(sunNow.azimuthDeg, sunNow.elevationDeg) : null;

  return (
    <svg
      class="sun-polar"
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      role="img"
      aria-label={t('Sonnenstand-Polardiagramm', 'Sun polar plot')}
      data-testid="sun-polar"
    >
      {/* Horizon + altitude rings (30°, 60°, 90°-from-zenith). */}
      <circle
        data-testid="sun-horizon"
        cx={CENTER}
        cy={CENTER}
        r={RADIUS}
        fill="var(--color-bg-elev)"
        stroke="var(--color-muted)"
        stroke-width={1}
      />
      <circle cx={CENTER} cy={CENTER} r={RADIUS * (2 / 3)} fill="none" stroke="var(--color-card-border)" stroke-width={0.5} />
      <circle cx={CENTER} cy={CENTER} r={RADIUS * (1 / 3)} fill="none" stroke="var(--color-card-border)" stroke-width={0.5} />

      {/* Cardinal labels. */}
      <text x={CENTER} y={16} text-anchor="middle" fill="var(--color-muted)" font-size="10">{t('N', 'N')}</text>
      <text x={SIZE - 6} y={CENTER + 4} text-anchor="end" fill="var(--color-muted)" font-size="10">{t('O', 'E')}</text>
      <text x={CENTER} y={SIZE - 4} text-anchor="middle" fill="var(--color-muted)" font-size="10">{t('S', 'S')}</text>
      <text x={6} y={CENTER + 4} text-anchor="start" fill="var(--color-muted)" font-size="10">{t('W', 'W')}</text>

      {/* Shadow wedge (cast opposite the sun; longer when the sun is low). */}
      {shadow !== null && (
        <polygon
          points={shadow}
          fill="var(--color-bg)"
          opacity={0.45}
          data-testid="sun-shadow"
        />
      )}

      {/* Below-horizon trajectory (dashed). */}
      {nightPath !== null && (
        <path
          d={nightPath}
          fill="none"
          stroke="var(--color-muted)"
          stroke-width={1}
          stroke-dasharray="4 3"
          data-testid="sun-trajectory-night"
        />
      )}

      {/* Daytime trajectory. */}
      {dayPath !== null && (
        <path
          d={dayPath}
          fill="none"
          stroke="var(--color-accent)"
          stroke-width={1.5}
          data-testid="sun-trajectory-day"
        />
      )}

      {/* Window markers. */}
      {(props.markers ?? []).map((m) => {
        const pos = getSunPosition(m.at, props.latitude, props.longitude);
        if (pos.elevationDeg < 0) {
          return null;
        }
        const xy = polarToCartesian(pos.azimuthDeg, pos.elevationDeg);
        return (
          <circle
            key={m.windowId}
            cx={xy.x}
            cy={xy.y}
            r={4}
            fill={m.color}
            stroke="var(--color-bg-elev)"
            stroke-width={1}
            data-testid={`sun-marker-${m.windowId}`}
          >
            <title>{m.label ?? m.windowId}</title>
          </circle>
        );
      })}

      {/* Current sun position — a small sun glyph (was a plain dot). */}
      {sunNow.elevationDeg > 0 && (
        <g
          transform={`translate(${sunNowXY.x.toFixed(2)} ${sunNowXY.y.toFixed(2)})`}
          data-testid="sun-dot"
          style={{ filter: 'drop-shadow(0 0 4px var(--color-accent))' }}
        >
          <circle r={5.5} fill="var(--color-accent-soft)" stroke="var(--color-accent-strong)" stroke-width={1} />
          <path
            d="M0 -10V-7M0 7V10M10 0H7M-10 0H-7M7.1 -7.1 5 -5M-7.1 7.1 -5 5M7.1 7.1 5 5M-7.1 -7.1 -5 -5"
            stroke="var(--color-accent)"
            stroke-width={1.3}
            stroke-linecap="round"
          />
        </g>
      )}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Inlined sun-position helper (~30 LOC). Accurate to ≈0.5° — good
// enough for plotting at ≈3° pixel resolution.
//
// Algorithm condensed from "Astronomical Algorithms" (Jean Meeus,
// 1998), simplified to the equation-of-time approximation used by
// NOAA's solar position calculator.
// ---------------------------------------------------------------------------

/**
 * Public for re-use by the wizard's step 1 "Verbindung testen"
 * preview. The implementation is intentionally simple (≈30 LOC,
 * accuracy ≈0.5°), good enough for both the polar plot and the
 * wizard's "show me where the sun is right now" preview.
 */
export function getSunPosition(date: Date, latDeg: number, lonDeg: number): { azimuthDeg: number; elevationDeg: number } {
  const rad = Math.PI / 180;
  const phi = latDeg * rad;
  const lon = lonDeg * rad;
  // Days since J2000.0 (2000-01-01T12:00:00Z).
  const jd = date.getTime() / 86_400_000 + 2440587.5;
  const n = jd - 2451545.0;
  // Mean solar longitude / anomaly.
  const L = (280.46 + 0.9856474 * n) * rad;
  const g = (357.528 + 0.9856003 * n) * rad;
  // Ecliptic longitude.
  const lambda = L + (1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
  // Obliquity of the ecliptic (constant enough for plotting).
  const epsilon = 23.439 * rad;
  // Right ascension and declination.
  const ra = Math.atan2(Math.cos(epsilon) * Math.sin(lambda), Math.cos(lambda));
  const dec = Math.asin(Math.sin(epsilon) * Math.sin(lambda));
  // Greenwich mean sidereal time (rough, hour-fraction).
  const gmst = (18.697374558 + 24.06570982441908 * n) % 24;
  const lst = gmst * 15 * rad + lon;
  const ha = lst - ra;
  // Altitude / azimuth.
  const sinAlt = Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(ha);
  const altitude = Math.asin(Math.max(-1, Math.min(1, sinAlt)));
  const cosAz =
    (Math.sin(dec) - Math.sin(altitude) * Math.sin(phi)) / (Math.cos(altitude) * Math.cos(phi));
  let azimuth = Math.acos(Math.max(-1, Math.min(1, cosAz)));
  if (Math.sin(ha) > 0) {
    azimuth = 2 * Math.PI - azimuth;
  }
  return {
    azimuthDeg: ((azimuth / rad) % 360 + 360) % 360,
    elevationDeg: altitude / rad,
  };
}

function polarToCartesian(azimuthDeg: number, elevationDeg: number): { x: number; y: number } {
  // Distance from centre = (90 - elevation) / 90 * RADIUS, clamped
  // to RADIUS so below-horizon points sit on the outer ring rather
  // than being clipped.
  const r = clamp(((90 - elevationDeg) / 90) * RADIUS, 0, RADIUS);
  // Azimuth 0 = North, 90 = East. SVG y grows downward, so North is
  // negative-y from centre.
  const angle = (azimuthDeg - 90) * (Math.PI / 180);
  return {
    x: CENTER + r * Math.cos(angle),
    y: CENTER + r * Math.sin(angle),
  };
}

/**
 * Build a soft triangular shadow wedge cast from the centre toward the
 * anti-solar azimuth. Length grows as the sun gets lower (∝ cot(elevation),
 * capped at the horizon ring). Returns an SVG `points` string.
 */
function shadowWedge(sunAzimuthDeg: number, elevationDeg: number): string {
  const shadowAz = (sunAzimuthDeg + 180) % 360;
  const elev = clamp(elevationDeg, 1, 89);
  const lenFactor = clamp(1 / Math.tan((elev * Math.PI) / 180) / 3, 0.18, 1);
  const len = lenFactor * RADIUS;
  const dir = (shadowAz - 90) * (Math.PI / 180);
  const tipX = CENTER + len * Math.cos(dir);
  const tipY = CENTER + len * Math.sin(dir);
  const halfW = 10;
  const perp = dir + Math.PI / 2;
  const baseAx = CENTER + halfW * Math.cos(perp);
  const baseAy = CENTER + halfW * Math.sin(perp);
  const baseBx = CENTER - halfW * Math.cos(perp);
  const baseBy = CENTER - halfW * Math.sin(perp);
  return [
    `${baseAx.toFixed(1)},${baseAy.toFixed(1)}`,
    `${tipX.toFixed(1)},${tipY.toFixed(1)}`,
    `${baseBx.toFixed(1)},${baseBy.toFixed(1)}`,
  ].join(' ');
}

function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) {
    return lo;
  }
  if (n > hi) {
    return hi;
  }
  return n;
}

function pathFromPoints(points: Array<{ x: number; y: number }>): string | null {
  if (points.length === 0) {
    return null;
  }
  const head = points[0]!;
  const segments = [`M ${head.x.toFixed(2)} ${head.y.toFixed(2)}`];
  for (let i = 1; i < points.length; i += 1) {
    const p = points[i]!;
    segments.push(`L ${p.x.toFixed(2)} ${p.y.toFixed(2)}`);
  }
  return segments.join(' ');
}

function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

function endOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(23, 59, 59, 999);
  return out;
}
