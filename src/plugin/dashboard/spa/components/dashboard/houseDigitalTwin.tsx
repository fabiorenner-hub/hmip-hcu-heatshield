/**
 * Heat Shield — house digital twin (predictive-control-dashboard
 * Task 15, Requirement 9) — premium redesign (V3).
 *
 * Layers (back → front):
 *   - twin-sky        — live day/night gradient driven by sun elevation.
 *   - twin-shadow     — soft ground shadow cast opposite the sun.
 *   - house bg PNG    — the transparent house render.
 *   - SunArc          — sun trajectory, glow, rays, draggable "now" handle.
 *   - Facade cards    — N/O/S/W exposure %, with a live sun-incidence arrow.
 *   - RoomBadges      — rich, draggable per-room cards: live shutter glyph,
 *                       count-up temperature + trend, status dot, open-window
 *                       and freshness markers; running-shutter animation while
 *                       a move is in flight; click opens a detail popover with
 *                       a 12 h shutter-forecast sparkline and per-room risk
 *                       factor bars. Optional heat-map veil.
 *   - Environment     — W/m², UV, wind, humidity.
 *   - Toolbar         — Schutz-Score ring, 12 h weather sparkline, live
 *                       insights, and layout controls (Wärme, Legende,
 *                       Zurücksetzen, Sperre).
 *   - Legend          — collapsible key.
 *
 * Shutter convention (steering): 0 % = offen, 95 % = stärkste automatische
 * Schließung (Stauschutz), 100 % = nur manuell / Dachfenster.
 *
 * All interactions are client-side only (Requirement 10.4). Motion respects
 * `prefers-reduced-motion`.
 */

import { h, type JSX, type ComponentChildren } from 'preact';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'preact/hooks';

import { houseAssetUrl } from './house.js';
import { RoomDetailModal } from './roomDetailModal.js';
import { Portal } from '../portal.js';
import { getSunPosition } from '../sunPolarPlot.js';
import { Icon, type IconName } from '../icons.js';
import { formatSignal, formatWindKmh } from '../../format.js';
import { t, tServer } from '../../i18n.js';
import type {
  DashboardSnapshot,
  FacadeKey,
  PlannedActionState,
  RoomDetail,
  RiskFactorName,
  WindowRiskBreakdown,
} from '../../types.js';

export interface HouseDigitalTwinProps {
  snapshot: DashboardSnapshot;
  latitude: number;
  longitude: number;
  now: Date;
  /** Called with a simulated instant while the user scrubs the sun arc. */
  onScrub?: (tSim: Date) => void;
  /** Simulated instant when scrubbing; null = live "now". */
  scrubAt?: Date | null;
  /** Per-window risk breakdown (from the SSE store) for the detail popover. */
  riskByWindow?: Record<string, WindowRiskBreakdown>;
  /**
   * Layout variant:
   *   - `'full'` (default): the complete digital twin (house, sun arc,
   *     facades, draggable badges).
   *   - `'chips'`: just the room chips in a responsive grid (no house /
   *     sun / facades) plus the same rich click popover with manual control.
   *     Used by the Liquid Glass V2 overview "Hausübersicht".
   */
  variant?: 'full' | 'chips';
}

/** Absolute badge position as percentages of the twin container. */
interface BadgePos {
  left: number;
  top: number;
}

const POS_KEY = 'heatshield.twin.badgePositions.v1';
const LOCK_KEY = 'heatshield.twin.badgeLock.v1';
const SNAP_PCT = 2.5;

// ---------------------------------------------------------------------------
// Small utilities.
// ---------------------------------------------------------------------------

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

function clampPct(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return clamp(Math.round(v), 0, 100);
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  } catch {
    return false;
  }
}

/**
 * `true` while the viewport is phone-width. The spatial house twin relies on
 * absolutely-positioned badges over a fixed-aspect house render, which does
 * not survive narrow screens — on mobile we fall back to a compact room table
 * instead. Guarded for jsdom (no `matchMedia`) so tests keep the desktop path.
 */
function useIsMobile(maxWidth = 640): boolean {
  const [mobile, setMobile] = useState<boolean>(() => {
    try {
      return window.matchMedia?.(`(max-width:${maxWidth}px)`).matches === true;
    } catch {
      return false;
    }
  });
  useEffect(() => {
    let mq: MediaQueryList;
    try {
      mq = window.matchMedia(`(max-width:${maxWidth}px)`);
    } catch {
      return;
    }
    const update = (): void => setMobile(mq.matches);
    update();
    try {
      mq.addEventListener('change', update);
      return (): void => mq.removeEventListener('change', update);
    } catch {
      mq.addListener?.(update);
      return (): void => mq.removeListener?.(update);
    }
  }, [maxWidth]);
  return mobile;
}

function haptic(ms = 8): void {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* unsupported */
  }
}

/**
 * Animated count-up: eases `display` toward `value` with a cubic-out curve.
 * Honours reduced-motion (snaps instantly) and is safe under jsdom (no
 * matchMedia / rAF assumptions beyond optional chaining).
 */
function useCountUp(value: number, duration = 450): number {
  const [disp, setDisp] = useState(value);
  const dispRef = useRef(value);
  dispRef.current = disp;
  useEffect(() => {
    const from = dispRef.current;
    if (prefersReducedMotion() || from === value || !Number.isFinite(from)) {
      setDisp(value);
      return;
    }
    const t0 = performance.now();
    let raf = 0;
    const tick = (t: number): void => {
      const k = Math.min(1, (t - t0) / duration);
      const eased = 1 - Math.pow(1 - k, 3);
      setDisp(from + (value - from) * eased);
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return (): void => cancelAnimationFrame(raf);
  }, [value, duration]);
  return disp;
}

function loadPositions(): Record<string, BadgePos> {
  try {
    const raw = window.localStorage.getItem(POS_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return {};
    const out: Record<string, BadgePos> = {};
    for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (v !== null && typeof v === 'object') {
        const rec = v as Record<string, unknown>;
        const left = rec['left'];
        const top = rec['top'];
        if (typeof left === 'number' && typeof top === 'number') {
          out[id] = { left, top };
        }
      }
    }
    return out;
  } catch {
    return {};
  }
}

function savePositions(p: Record<string, BadgePos>): void {
  try {
    window.localStorage.setItem(POS_KEY, JSON.stringify(p));
  } catch {
    /* ignore quota / privacy-mode errors */
  }
}

function loadLocked(): boolean {
  try {
    return window.localStorage.getItem(LOCK_KEY) !== 'false';
  } catch {
    return true;
  }
}

function saveLocked(b: boolean): void {
  try {
    window.localStorage.setItem(LOCK_KEY, b ? 'true' : 'false');
  } catch {
    /* ignore */
  }
}

/** Live day/night sky gradient from the sun's elevation. */
function skyGradient(elevationDeg: number): string {
  if (elevationDeg >= 10) {
    return 'linear-gradient(180deg,#16335b 0%,#2f5d8c 50%,#7aa6c8 100%)';
  }
  if (elevationDeg >= 2) {
    return 'linear-gradient(180deg,#1c3a5e 0%,#5a6f9c 45%,#d0a06a 100%)';
  }
  if (elevationDeg >= -4) {
    return 'linear-gradient(180deg,#1a2244 0%,#6a4a7e 55%,#e0855a 100%)';
  }
  if (elevationDeg >= -10) {
    return 'linear-gradient(180deg,#0d1430 0%,#2a2452 60%,#5a3560 100%)';
  }
  return 'linear-gradient(180deg,#060a16 0%,#0c1330 70%,#121a3a 100%)';
}

export function HouseDigitalTwin(props: HouseDigitalTwinProps): JSX.Element {
  const { snapshot, latitude, longitude, now } = props;
  const effectiveAt = props.scrubAt ?? now;
  const scrubbing = props.scrubAt !== null && props.scrubAt !== undefined;
  const rooms = snapshot.roomsDetail ?? [];
  const bg = houseAssetUrl();
  const sun = getSunPosition(effectiveAt, latitude, longitude);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const selectedElRef = useRef<HTMLDivElement | null>(null);
  const isMobile = useIsMobile();
  const [positions, setPositions] = useState<Record<string, BadgePos>>(loadPositions);
  const [locked, setLocked] = useState<boolean>(loadLocked);
  const [showLegend, setShowLegend] = useState<boolean>(false);
  const [heatmapOn, setHeatmapOn] = useState<boolean>(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [guide, setGuide] = useState<BadgePos | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

  const detailRoom = detailId !== null ? rooms.find((r) => r.id === detailId) ?? null : null;
  const detailRisk =
    detailRoom?.nextAction != null
      ? props.riskByWindow?.[detailRoom.nextAction.windowId]
      : undefined;
  const detailLearn =
    detailRoom !== null
      ? snapshot.learning?.rooms.find((r) => r.id === detailRoom.id)
      : undefined;
  const detailModal =
    detailRoom !== null ? (
      <RoomDetailModal
        room={detailRoom}
        {...(detailRisk !== undefined ? { risk: detailRisk } : {})}
        {...(detailLearn !== undefined ? { learning: detailLearn } : {})}
        onClose={(): void => setDetailId(null)}
      />
    ) : null;

  const onMovePos = useCallback((id: string, pos: BadgePos): void => {
    setPositions((prev) => ({ ...prev, [id]: pos }));
  }, []);
  const onCommit = useCallback((next: Record<string, BadgePos>): void => {
    savePositions(next);
  }, []);
  const toggleLock = useCallback((): void => {
    haptic(12);
    setLocked((prev) => {
      const next = !prev;
      saveLocked(next);
      return next;
    });
    setGuide(null);
  }, []);
  const resetLayout = useCallback((): void => {
    // Full "Haus auf Standard zurücksetzen": auto badge layout, default lock,
    // heat veil off, legend closed, nothing selected.
    setPositions({});
    savePositions({});
    setLocked(true);
    saveLocked(true);
    setHeatmapOn(false);
    setShowLegend(false);
    setSelected(null);
    setGuide(null);
  }, []);

  const selectedRoom = selected !== null ? rooms.find((r) => r.id === selected) ?? null : null;
  const riskForSelected =
    selectedRoom?.nextAction != null
      ? props.riskByWindow?.[selectedRoom.nextAction.windowId]
      : undefined;

  // Soft ground shadow cast opposite the sun; longer/softer when the sun is low.
  const shadowStyle = ((): h.JSX.CSSProperties => {
    if (sun.elevationDeg <= 0) return { display: 'none' };
    const azRad = (sun.azimuthDeg * Math.PI) / 180;
    const offsetX = -Math.sin(azRad) * 16; // percent
    const lowFactor = clamp(1 - sun.elevationDeg / 55, 0.15, 1);
    return {
      transform: `translateX(${offsetX.toFixed(1)}%) scaleX(${(1 + lowFactor).toFixed(2)})`,
      opacity: (0.5 + lowFactor * 0.4).toFixed(2),
    };
  })();

  // Chips variant: the classic room chips + rich popover (with manual
  // control), laid out in a responsive grid WITHOUT the house / sun / facades.
  if (props.variant === 'chips') {
    return (
      <div class="twin-chips" data-testid="twin-chips" ref={containerRef}>
        {rooms.map((room) => (
          <RoomBadge
            key={room.id}
            room={room}
            left={0}
            top={0}
            locked
            heatmapOn={false}
            previewPercent={null}
            selected={selected === room.id}
            isStatic
            onSelect={(el): void => {
              selectedElRef.current = el;
              setSelected((cur) => (cur === room.id ? null : room.id));
            }}
          />
        ))}
        {selectedRoom !== null && (
          <RoomPopover
            room={selectedRoom}
            risk={riskForSelected}
            pos={{ left: 50, top: 50 }}
            containerRef={containerRef}
            scrubbing={scrubbing}
            effectiveAt={effectiveAt}
            anchorRect={(): DOMRect | null =>
              selectedElRef.current?.getBoundingClientRect() ?? null
            }
            onClose={(): void => setSelected(null)}
            onOpenDetail={(): void => setDetailId(selectedRoom.id)}
          />
        )}
        {detailModal}
      </div>
    );
  }

  if (isMobile) {
    return (
      <div class="twin-wrap twin-wrap--mobile" data-testid="twin-wrap">
        <MobileRoomList rooms={rooms} onOpenDetail={(id): void => setDetailId(id)} />
        {detailModal}
      </div>
    );
  }

  return (
    <div class="twin-wrap" data-testid="twin-wrap">
      <TwinToolbar
        snapshot={snapshot}
        rooms={rooms}
        locked={locked}
        showLegend={showLegend}
        heatmapOn={heatmapOn}
        onToggleLock={toggleLock}
        onToggleLegend={(): void => setShowLegend((s) => !s)}
        onToggleHeatmap={(): void => setHeatmapOn((s) => !s)}
        onReset={resetLayout}
      />
      <div
        class={`house-twin${locked ? '' : ' house-twin--editing'}${heatmapOn ? ' house-twin--heatmap' : ''}`}
        data-testid="house-twin"
        data-asset={bg}
        ref={containerRef}
      >
        <div class="twin-sky" style={{ backgroundImage: skyGradient(sun.elevationDeg) }} aria-hidden="true" />
        <div class="twin-shadow" style={shadowStyle} aria-hidden="true" />
        <img class="house-twin__bg" src={bg} alt={t('Hausansicht', 'House view')} aria-hidden="true" />

        <SunArc
        latitude={latitude}
        longitude={longitude}
        now={now}
        effectiveAt={effectiveAt}
        {...(props.onScrub !== undefined ? { onScrub: props.onScrub } : {})}
      />
      <FacadeExposureLabels facades={snapshot.facades} sun={sun} />

      {guide !== null && !locked && (
        <div class="twin-overlay twin-guides" data-testid="twin-guides" aria-hidden="true">
          <span class="twin-guide twin-guide--v" style={{ left: `${guide.left}%` }} />
          <span class="twin-guide twin-guide--h" style={{ top: `${guide.top}%` }} />
        </div>
      )}

      <RoomBadges
        rooms={rooms}
        positions={positions}
        committed={positions}
        locked={locked}
        heatmapOn={heatmapOn}
        scrubbing={scrubbing}
        effectiveAt={effectiveAt}
        selected={selected}
        containerRef={containerRef}
        onMovePos={onMovePos}
        onCommit={onCommit}
        onSelect={(id): void => setSelected((cur) => (cur === id ? null : id))}
        onGuide={setGuide}
      />
      <EnvironmentOverlay snapshot={snapshot} />

      {selectedRoom !== null && (
        <RoomPopover
          room={selectedRoom}
          risk={riskForSelected}
          pos={positions[selectedRoom.id] ?? autoLayout(rooms)[selectedRoom.id] ?? { left: 50, top: 50 }}
          containerRef={containerRef}
          scrubbing={scrubbing}
          effectiveAt={effectiveAt}
          onClose={(): void => setSelected(null)}
          onOpenDetail={(): void => setDetailId(selectedRoom.id)}
        />
      )}

      {showLegend && <TwinLegend onClose={(): void => setShowLegend(false)} />}
      </div>
      {detailModal}
    </div>
  );
}

/** Sun trajectory arc with glow, rays and a draggable "now" handle. */
function SunArc(props: {
  latitude: number;
  longitude: number;
  now: Date;
  effectiveAt: Date;
  onScrub?: (tSim: Date) => void;
}): JSX.Element {
  const dayStart = new Date(props.now);
  dayStart.setHours(4, 0, 0, 0);
  const dayEnd = new Date(props.now);
  dayEnd.setHours(22, 0, 0, 0);
  const span = dayEnd.getTime() - dayStart.getTime();
  const W = 720;
  const H = 220;
  const PAD_TOP = 34;
  const PAD_BOTTOM = 26;
  const PLOT_H = H - PAD_TOP - PAD_BOTTOM;
  const elevToY = (elevDeg: number): number =>
    H - PAD_BOTTOM - (Math.max(0, Math.min(60, elevDeg)) / 60) * PLOT_H;
  const pts: string[] = [];
  const N = 48;
  for (let i = 0; i <= N; i += 1) {
    const t = dayStart.getTime() + (i / N) * span;
    const sun = getSunPosition(new Date(t), props.latitude, props.longitude);
    const x = (i / N) * W;
    const y = elevToY(sun.elevationDeg);
    pts.push(`${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`);
  }
  const handleFrac = Math.max(
    0,
    Math.min(1, (props.effectiveAt.getTime() - dayStart.getTime()) / span),
  );
  const handleX = handleFrac * W;
  const handleSun = getSunPosition(props.effectiveAt, props.latitude, props.longitude);
  const handleY = elevToY(handleSun.elevationDeg);
  const isDay = handleSun.elevationDeg > 0;

  // Faint sun rays radiating from the handle (only by day).
  const rays: JSX.Element[] = [];
  if (isDay) {
    const RAY_N = 10;
    for (let i = 0; i < RAY_N; i += 1) {
      const ang = (i / RAY_N) * Math.PI * 2;
      const r1 = 12;
      const r2 = 26 + (i % 2) * 8;
      rays.push(
        <line
          key={i}
          x1={(handleX + Math.cos(ang) * r1).toFixed(1)}
          y1={(handleY + Math.sin(ang) * r1).toFixed(1)}
          x2={(handleX + Math.cos(ang) * r2).toFixed(1)}
          y2={(handleY + Math.sin(ang) * r2).toFixed(1)}
          stroke="#fde68a"
          stroke-width={1.4}
          stroke-linecap="round"
          opacity={0.45}
        />,
      );
    }
  }

  const onPointer = (ev: JSX.TargetedPointerEvent<SVGSVGElement>): void => {
    if (props.onScrub === undefined) return;
    const svg = ev.currentTarget;
    const rect = svg.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
    props.onScrub(new Date(dayStart.getTime() + frac * span));
  };

  return (
    <svg
      class="twin-overlay twin-overlay--sunarc"
      data-testid="overlay-sunarc"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMid meet"
      onPointerDown={onPointer}
      onPointerMove={(ev): void => {
        if (ev.buttons === 1) onPointer(ev);
      }}
    >
      <defs>
        <linearGradient id="sunArcStroke" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="var(--color-accent)" stop-opacity="0.35" />
          <stop offset="50%" stop-color="var(--color-accent-strong)" stop-opacity="0.95" />
          <stop offset="100%" stop-color="var(--color-accent)" stop-opacity="0.35" />
        </linearGradient>
        <radialGradient id="sunGlow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="var(--color-accent-soft)" stop-opacity="0.9" />
          <stop offset="100%" stop-color="var(--color-accent)" stop-opacity="0" />
        </radialGradient>
      </defs>
      <path
        d={pts.join(' ')}
        fill="none"
        stroke="url(#sunArcStroke)"
        stroke-width={2.5}
        stroke-linecap="round"
      />
      <line
        x1={handleX}
        y1={0}
        x2={handleX}
        y2={H}
        stroke="color-mix(in srgb, var(--color-text) 27%, transparent)"
        stroke-dasharray="4 4"
        data-testid="sunarc-nowline"
      />
      {isDay && <circle cx={handleX} cy={handleY} r={22} fill="url(#sunGlow)" />}
      <g class="twin-sun-rays">{rays}</g>
      <circle
        cx={handleX}
        cy={handleY}
        r={7}
        fill={isDay ? 'var(--color-accent-strong)' : 'var(--color-muted)'}
        stroke="var(--color-accent-soft)"
        stroke-width={1.5}
        data-testid="sunarc-handle"
      />
    </svg>
  );
}

const FACADE_POS: Record<FacadeKey, { left: string; top: string; label: string; normalDeg: number }> = {
  N: { left: '50%', top: '6%', label: 'NORD', normalDeg: 0 },
  E: { left: '91%', top: '40%', label: 'OST', normalDeg: 90 },
  S: { left: '50%', top: '80%', label: 'SÜD', normalDeg: 180 },
  W: { left: '9%', top: '40%', label: 'WEST', normalDeg: 270 },
};

const FACADE_KEYS: FacadeKey[] = ['N', 'E', 'S', 'W'];

const FACADE_LABEL_EN: Record<FacadeKey, string> = { N: 'NORTH', E: 'EAST', S: 'SOUTH', W: 'WEST' };

/** Bilingual facade name (NORD/OST/SÜD/WEST → NORTH/EAST/SOUTH/WEST). */
function facadeLabel(k: FacadeKey): string {
  return t(FACADE_POS[k].label, FACADE_LABEL_EN[k]);
}

/** Direct-sun incidence on a vertical facade in [0,1]. */
function facadeIncidence01(normalDeg: number, sun: { azimuthDeg: number; elevationDeg: number }): number {
  if (sun.elevationDeg <= 0) return 0;
  const diff = (((sun.azimuthDeg - normalDeg) % 360) + 360) % 360;
  const az = diff > 180 ? 360 - diff : diff;
  const azRad = (az * Math.PI) / 180;
  const elRad = (sun.elevationDeg * Math.PI) / 180;
  return Math.max(0, Math.cos(azRad)) * Math.cos(elRad);
}

function FacadeExposureLabels(props: {
  facades: { N: number; E: number; S: number; W: number } | undefined;
  sun: { azimuthDeg: number; elevationDeg: number };
}): JSX.Element {
  const f = props.facades;
  const strongest =
    f !== undefined
      ? FACADE_KEYS.reduce((best, k) => (f[k] > f[best] ? k : best), 'N' as FacadeKey)
      : null;
  return (
    <div class="twin-overlay twin-overlay--facades" data-testid="overlay-facades">
      {FACADE_KEYS.map((k) => {
        const pos = FACADE_POS[k];
        const pct = f ? clampPct(f[k]) : null;
        const hot = strongest === k && pct !== null && pct > 0;
        const inc = facadeIncidence01(pos.normalDeg, props.sun);
        return (
          <span
            key={k}
            class={`facade-card${hot ? ' facade-card--strongest' : ''}`}
            style={{ left: pos.left, top: pos.top }}
            data-facade={k}
          >
            <span class="facade-card__dir">{facadeLabel(k)}</span>
            <span class="facade-card__pct">{pct === null ? '–' : `${pct} %`}</span>
            {inc > 0.05 && (
              <span
                class="facade-card__inc"
                style={{ opacity: (0.25 + inc * 0.75).toFixed(2) }}
                title={`${t('Direkte Sonne', 'Direct sun')} ${Math.round(inc * 100)} %`}
                aria-hidden="true"
              >
                ☀
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
}

/** Vertical tier for a floor label: lower number = higher up on the house. */
function floorTier(floor: string | undefined): number {
  const f = (floor ?? '').trim().toUpperCase();
  if (f === 'DG' || f.startsWith('DACH')) return 0;
  if (f === 'OG' || f.startsWith('OG') || f.startsWith('OBER')) return 1;
  if (f === 'EG' || f.startsWith('ERD') || f === '') return 2;
  if (f === 'KG' || f.startsWith('KELLER') || f.startsWith('UG')) return 3;
  return 2;
}

/**
 * Left→right compass sequence: W, SW, S, SO, O, NO, N, NW. Returns a 0..7
 * index for an orientation in degrees, snapping to the nearest 45° sector.
 */
const COMPASS_SEQUENCE_DEG = [270, 225, 180, 135, 90, 45, 0, 315];
function compassSequenceIndex(orientationDeg: number | undefined, facade: FacadeKey): number {
  const deg =
    orientationDeg !== undefined ? orientationDeg : { N: 0, E: 90, S: 180, W: 270 }[facade];
  const norm = ((deg % 360) + 360) % 360;
  const snapped = (Math.round(norm / 45) * 45) % 360;
  const idx = COMPASS_SEQUENCE_DEG.indexOf(snapped);
  return idx === -1 ? 3 : idx;
}

const TIER_TOP_PCT = [26, 42, 58, 72];

function autoLayout(rooms: RoomDetail[]): Record<string, BadgePos> {
  const byTier = new Map<number, RoomDetail[]>();
  for (const r of rooms) {
    const tier = floorTier(r.floor);
    const list = byTier.get(tier) ?? [];
    list.push(r);
    byTier.set(tier, list);
  }
  const seqIdx = (r: RoomDetail): number => compassSequenceIndex(r.orientationDeg, r.facade);
  for (const list of byTier.values()) {
    list.sort((a, b) => seqIdx(a) - seqIdx(b) || a.name.localeCompare(b.name));
  }
  const out: Record<string, BadgePos> = {};
  for (const [tier, list] of byTier) {
    const top = TIER_TOP_PCT[Math.min(3, tier)] ?? 58;
    const usedCols = new Map<number, number>();
    list.forEach((room) => {
      const col = seqIdx(room);
      const dupes = usedCols.get(col) ?? 0;
      usedCols.set(col, dupes + 1);
      const baseFrac = col / (COMPASS_SEQUENCE_DEG.length - 1);
      const nudge = dupes * 0.05;
      // Keep badges in a central band (20..80 %) so they never collide with
      // the W/E facade cards (at 9 % / 91 %) or the N/S cards (top/bottom).
      const left = Math.round(20 + Math.min(0.98, baseFrac + nudge) * 60);
      out[room.id] = { left, top: top + dupes * 7 };
    });
  }
  return out;
}

/** Nearest forecast shutter percent to `at`, or null if no forecast. */
function forecastPercentAt(room: RoomDetail, at: Date): number | null {
  const fc = room.shutterForecast;
  if (fc === undefined || fc.length === 0) return null;
  const t = at.getTime();
  let best = fc[0]!;
  let bestDiff = Math.abs(Date.parse(best.ts) - t);
  for (const p of fc) {
    const d = Math.abs(Date.parse(p.ts) - t);
    if (d < bestDiff) {
      best = p;
      bestDiff = d;
    }
  }
  return clampPct(best.percent);
}

function RoomBadges(props: {
  rooms: RoomDetail[];
  positions: Record<string, BadgePos>;
  committed: Record<string, BadgePos>;
  locked: boolean;
  heatmapOn: boolean;
  scrubbing: boolean;
  effectiveAt: Date;
  selected: string | null;
  containerRef: { current: HTMLDivElement | null };
  onMovePos: (id: string, pos: BadgePos) => void;
  onCommit: (next: Record<string, BadgePos>) => void;
  onSelect: (id: string) => void;
  onGuide: (pos: BadgePos | null) => void;
}): JSX.Element {
  const auto = useMemo(() => autoLayout(props.rooms), [props.rooms]);
  const gesture = useRef<{ id: string; startX: number; startY: number; moved: boolean } | null>(
    null,
  );

  const posFor = (id: string): BadgePos =>
    props.positions[id] ?? auto[id] ?? { left: 50, top: 50 };

  const onPointerDown = (ev: JSX.TargetedPointerEvent<HTMLDivElement>, id: string): void => {
    ev.stopPropagation();
    const el = ev.currentTarget;
    try {
      el.setPointerCapture(ev.pointerId);
    } catch {
      /* ignore */
    }
    gesture.current = { id, startX: ev.clientX, startY: ev.clientY, moved: false };
  };
  const onPointerMove = (ev: JSX.TargetedPointerEvent<HTMLDivElement>): void => {
    const g = gesture.current;
    if (g === null) return;
    const dx = ev.clientX - g.startX;
    const dy = ev.clientY - g.startY;
    if (!g.moved && Math.hypot(dx, dy) > 4) {
      g.moved = true;
      haptic(6);
    }
    if (props.locked || !g.moved) return;
    const container = props.containerRef.current;
    if (container === null) return;
    const rect = container.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const rawLeft = ((ev.clientX - rect.left) / rect.width) * 100;
    const rawTop = ((ev.clientY - rect.top) / rect.height) * 100;
    const left = clamp(Math.round(rawLeft / SNAP_PCT) * SNAP_PCT, 3, 97);
    const top = clamp(Math.round(rawTop / SNAP_PCT) * SNAP_PCT, 6, 94);
    props.onMovePos(g.id, { left, top });
    props.onGuide({ left, top });
  };
  const onPointerUp = (ev: JSX.TargetedPointerEvent<HTMLDivElement>): void => {
    const g = gesture.current;
    gesture.current = null;
    props.onGuide(null);
    if (g === null) return;
    try {
      ev.currentTarget.releasePointerCapture(ev.pointerId);
    } catch {
      /* ignore */
    }
    if (g.moved && !props.locked) {
      const moved = props.positions[g.id];
      if (moved !== undefined) {
        props.onCommit({ ...props.committed, ...props.positions, [g.id]: moved });
        haptic(10);
      }
    } else {
      props.onSelect(g.id);
    }
  };

  return (
    <div class="twin-overlay twin-overlay--rooms" data-testid="overlay-rooms">
      {props.rooms.map((room) => {
        const pos = posFor(room.id);
        const previewPct = props.scrubbing ? forecastPercentAt(room, props.effectiveAt) : null;
        return (
          <RoomBadge
            key={room.id}
            room={room}
            left={pos.left}
            top={pos.top}
            locked={props.locked}
            heatmapOn={props.heatmapOn}
            previewPercent={previewPct}
            selected={props.selected === room.id}
            onPointerDown={(ev): void => onPointerDown(ev, room.id)}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          />
        );
      })}
    </div>
  );
}

/** Coarse heat band for the heatmap veil. */
function heatBand(load01: number | undefined): 'low' | 'mid' | 'high' | null {
  if (load01 === undefined || !Number.isFinite(load01)) return null;
  if (load01 >= 0.55) return 'high';
  if (load01 >= 0.25) return 'mid';
  return 'low';
}

function RoomBadge(props: {
  room: RoomDetail;
  left: number;
  top: number;
  locked: boolean;
  heatmapOn: boolean;
  previewPercent: number | null;
  selected: boolean;
  /** Static grid mode (chips overview): no absolute position, no drag. */
  isStatic?: boolean;
  onSelect?: (el: HTMLDivElement) => void;
  onPointerDown?: (ev: JSX.TargetedPointerEvent<HTMLDivElement>) => void;
  onPointerMove?: (ev: JSX.TargetedPointerEvent<HTMLDivElement>) => void;
  onPointerUp?: (ev: JSX.TargetedPointerEvent<HTMLDivElement>) => void;
}): JSX.Element {
  const { room } = props;
  const livePct = clampPct(room.shutterPercent);
  const preview = props.previewPercent !== null;
  const pct = preview ? (props.previewPercent as number) : livePct;
  const animTemp = useCountUp(room.indoorTempC ?? NaN);
  const animPct = useCountUp(pct);
  const status = room.status;
  const next = room.nextAction;
  const band = props.heatmapOn ? heatBand(room.heatLoad01) : null;
  const fresh = room.indoorTempState ?? 'fresh';
  const title = next !== null ? `${tServer(next.reason)} (${statusLabel(status)})` : statusLabel(status);
  const tempStr = room.indoorTempC === null || !Number.isFinite(animTemp) ? '–' : `${animTemp.toFixed(1)}°`;
  const pctStr = `${Math.round(animPct)} %`;

  const isStatic = props.isStatic === true;
  return (
    <div
      class={[
        'room-badge',
        `room-badge--${status}`,
        isStatic ? 'room-badge--static' : props.locked ? '' : 'room-badge--draggable',
        props.selected ? 'room-badge--selected' : '',
        preview ? 'room-badge--preview' : '',
        band !== null ? `room-badge--heat-${band}` : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={isStatic ? undefined : { left: `${props.left}%`, top: `${props.top}%` }}
      data-room={room.id}
      data-testid={`room-badge-${room.id}`}
      {...(isStatic
        ? {
            role: 'button',
            tabIndex: 0,
            onClick: (ev: JSX.TargetedMouseEvent<HTMLDivElement>): void =>
              props.onSelect?.(ev.currentTarget),
            onKeyDown: (ev: JSX.TargetedKeyboardEvent<HTMLDivElement>): void => {
              if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault();
                props.onSelect?.(ev.currentTarget);
              }
            },
          }
        : {
            onPointerDown: props.onPointerDown,
            onPointerMove: props.onPointerMove,
            onPointerUp: props.onPointerUp,
          })}
      title={title}
    >
      <ShutterGlyph percent={pct} roof={room.roof === true} running={status === 'executing'} />
      <span class="room-badge__body">
        <span class="room-badge__name">
          {room.floor !== undefined && room.floor !== '' && (
            <span class="room-badge__floor">{room.floor}</span>
          )}
          <span class="room-badge__roomname">{room.name}</span>
        </span>
        <span class="room-badge__metrics">
          <span class="room-badge__pct" data-shutter={shutterBand(pct)}>
            {pctStr}
            {preview && <span class="room-badge__preview-tag">≈P</span>}
          </span>
          <span class="room-badge__sep" aria-hidden="true">
            ·
          </span>
          <span class="room-badge__temp">
            {tempStr}
            <TrendArrow trend={room.trend} />
            {fresh !== 'fresh' && (
              <span
                class={`room-badge__fresh room-badge__fresh--${fresh}`}
                title={fresh === 'stale' ? t('Messwert veraltet', 'Reading outdated') : t('Kein Sensor zugewiesen', 'No sensor assigned')}
                aria-label={fresh === 'stale' ? t('Messwert veraltet', 'Reading outdated') : t('Kein Sensor zugewiesen', 'No sensor assigned')}
              />
            )}
          </span>
        </span>
      </span>
      {room.windowOpen === true && (
        <Icon name="fenster" size={15} class="room-badge__window" title={t('Fenster offen', 'Window open')} />
      )}
      <span
        class="room-badge__status"
        data-state={status}
        title={statusLabel(status)}
        aria-label={statusLabel(status)}
      />
    </div>
  );
}

/**
 * Live shutter glyph. Open part shows warm sun colour, closed part the shade
 * colour. `running` adds an animated slat sweep while a move is in flight.
 */
function ShutterGlyph(props: { percent: number; roof?: boolean; running?: boolean }): JSX.Element {
  const W = 22;
  const H = 22;
  const innerTop = 3;
  const innerH = H - 6;
  const frac = clamp(props.percent / 100, 0, 1);
  const closedH = innerH * frac;
  const slats: number[] = [];
  const SLAT_STEP = 2.4;
  for (let y = innerTop + SLAT_STEP; y < innerTop + closedH - 0.5; y += SLAT_STEP) {
    slats.push(y);
  }
  return (
    <svg
      class={`room-badge__glyph${props.running === true ? ' room-badge__glyph--running' : ''}`}
      viewBox={`0 0 ${W} ${H}`}
      width={18}
      height={18}
      role="img"
      aria-label={`${t('Rollo', 'Shutter')} ${Math.round(props.percent)} %${props.roof === true ? ` (${t('Dachfenster', 'Roof window')})` : ''}`}
    >
      <rect x={3} y={innerTop} width={W - 6} height={innerH} rx={1.5} fill="#fcd9866b" />
      {closedH > 0.4 && (
        <rect x={3} y={innerTop} width={W - 6} height={closedH} rx={1.5} fill="var(--action-shade)" />
      )}
      {slats.map((y) => (
        <line key={y} x1={3.6} y1={y} x2={W - 3.6} y2={y} stroke="#1a120566" stroke-width={0.6} />
      ))}
      {props.roof === true && (
        <path d={`M${W - 6.5} 4.2 l2.3 1.4 -2.3 1.4`} fill="none" stroke="#e5e7eb" stroke-width={0.9} />
      )}
      <rect
        x={3}
        y={innerTop}
        width={W - 6}
        height={innerH}
        rx={1.5}
        fill="none"
        stroke="#e5e7eb"
        stroke-width={1.2}
      />
    </svg>
  );
}

function TrendArrow(props: { trend: 'up' | 'down' | 'flat' }): JSX.Element {
  const glyph = props.trend === 'up' ? '▲' : props.trend === 'down' ? '▼' : '▬';
  return (
    <span class={`room-badge__trend trend--${props.trend}`} aria-hidden="true">
      {glyph}
    </span>
  );
}

function shutterBand(pct: number): 'open' | 'mid' | 'closed' {
  if (pct <= 5) return 'open';
  if (pct >= 80) return 'closed';
  return 'mid';
}

function statusLabel(s: PlannedActionState): string {
  switch (s) {
    case 'recommended':
      return t('Empfohlen', 'Recommended');
    case 'scheduled':
      return t('Geplant', 'Scheduled');
    case 'executing':
      return t('Fährt', 'Moving');
    case 'completed':
      return t('Erledigt', 'Done');
    case 'blocked':
      return t('Blockiert', 'Blocked');
    case 'manuallyOverridden':
      return t('Manuell übersteuert', 'Manually overridden');
  }
}

const RISK_FACTOR_LABELS_DE: Record<RiskFactorName, string> = {
  sunFactor: 'Sonne',
  roomTempFactor: 'Raumtemp.',
  windowTypeFactor: 'Fenstertyp',
  forecastTempFactor: 'Prognose',
  pvFactor: 'PV',
  radiationFactor: 'Strahlung',
  outdoorTempFactor: 'Außentemp.',
  priorityFactor: 'Priorität',
};

const RISK_FACTOR_LABELS_EN: Record<RiskFactorName, string> = {
  sunFactor: 'Sun',
  roomTempFactor: 'Room temp.',
  windowTypeFactor: 'Window type',
  forecastTempFactor: 'Forecast',
  pvFactor: 'PV',
  radiationFactor: 'Radiation',
  outdoorTempFactor: 'Outdoor temp.',
  priorityFactor: 'Priority',
};

/** Bilingual risk-factor label. */
function riskFactorLabel(name: RiskFactorName): string {
  return t(RISK_FACTOR_LABELS_DE[name], RISK_FACTOR_LABELS_EN[name]);
}

/** Tiny sparkline from a numeric series, scaled to [min,max]. */
function Sparkline(props: {
  values: number[];
  width?: number;
  height?: number;
  stroke?: string;
  fill?: string;
  min?: number;
  max?: number;
}): JSX.Element | null {
  const vals = props.values.filter((v) => Number.isFinite(v));
  if (vals.length < 2) return null;
  const w = props.width ?? 120;
  const hgt = props.height ?? 28;
  const lo = props.min ?? Math.min(...vals);
  const hi = props.max ?? Math.max(...vals);
  const span = hi - lo || 1;
  const step = w / (vals.length - 1);
  const pts = vals.map((v, i) => {
    const x = i * step;
    const y = hgt - ((v - lo) / span) * (hgt - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const line = `M${pts.join(' L')}`;
  const area = `${line} L${w.toFixed(1)},${hgt} L0,${hgt} Z`;
  return (
    <svg class="twin-spark" viewBox={`0 0 ${w} ${hgt}`} width={w} height={hgt} aria-hidden="true">
      {props.fill !== undefined && <path d={area} fill={props.fill} stroke="none" />}
      <path d={line} fill="none" stroke={props.stroke ?? 'var(--action-shade)'} stroke-width={1.6} stroke-linejoin="round" stroke-linecap="round" />
    </svg>
  );
}

function RoomPopover(props: {
  room: RoomDetail;
  risk: WindowRiskBreakdown | undefined;
  pos: BadgePos;
  containerRef: { current: HTMLDivElement | null };
  scrubbing: boolean;
  effectiveAt: Date;
  /** Chips mode: anchor to the clicked chip's live rect instead of pos%. */
  anchorRect?: () => DOMRect | null;
  onClose: () => void;
  onOpenDetail: () => void;
}): JSX.Element {
  const { room } = props;
  // Portalled to document.body and positioned `fixed` against the viewport so
  // the popover is never clipped by the twin card's `overflow: hidden`. We
  // anchor it to the badge's real on-screen rectangle (container rect + the
  // badge's percentage position) and clamp it fully into the viewport. A
  // max-height + scroll keeps even a tall popover entirely visible.
  const popRef = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState<{
    left: number;
    top: number;
    maxHeight: number;
    placement: 'above' | 'below';
  } | null>(null);

  useLayoutEffect(() => {
    const reposition = (): void => {
      const container = props.containerRef.current;
      const pop = popRef.current;
      if (container === null || pop === null) return;
      const cr = container.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const margin = 12;
      const gap = 14;
      // Anchor to the clicked chip's real rect (chips mode) when provided,
      // otherwise to the badge's percentage position within the container
      // (full twin mode — unchanged). A zero-height anchor (pos% point)
      // behaves exactly as before.
      const ar = props.anchorRect?.() ?? null;
      const anchorX = ar !== null ? ar.left + ar.width / 2 : cr.left + (props.pos.left / 100) * cr.width;
      const anchorTop = ar !== null ? ar.top : cr.top + (props.pos.top / 100) * cr.height;
      const anchorBottom = ar !== null ? ar.bottom : anchorTop;
      const pw = pop.offsetWidth;
      const ph = pop.offsetHeight;
      const spaceBelow = vh - anchorBottom - gap - margin;
      const spaceAbove = anchorTop - gap - margin;
      // Prefer opening on the side with more room; bias by the anchor half.
      const preferBelow = ar !== null ? anchorTop < vh / 2 : props.pos.top < 50;
      let placement: 'above' | 'below';
      if (preferBelow) {
        placement = ph <= spaceBelow || spaceBelow >= spaceAbove ? 'below' : 'above';
      } else {
        placement = ph <= spaceAbove || spaceAbove >= spaceBelow ? 'above' : 'below';
      }
      const maxHeight = Math.max(160, vh - 2 * margin);
      let top =
        placement === 'below' ? anchorBottom + gap : anchorTop - gap - Math.min(ph, maxHeight);
      top = clamp(top, margin, Math.max(margin, vh - Math.min(ph, maxHeight) - margin));
      let left = anchorX - pw / 2;
      left = clamp(left, margin, Math.max(margin, vw - pw - margin));
      setBox({ left, top, maxHeight, placement });
    };
    reposition();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return (): void => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [props.pos.left, props.pos.top, props.containerRef, room.id]);

  const previewPct = props.scrubbing ? forecastPercentAt(room, props.effectiveAt) : null;
  const heatPct = room.heatLoad01 !== undefined ? Math.round(room.heatLoad01 * 100) : null;
  const orient = room.orientationDeg !== undefined ? `${Math.round(room.orientationDeg)}°` : '–';
  const fcVals = (room.shutterForecast ?? []).map((p) => p.percent);

  // Top weighted risk factors (factor × weight), descending.
  const riskRows: Array<{ name: RiskFactorName; weighted: number }> = [];
  if (props.risk !== undefined) {
    for (const key of Object.keys(props.risk.factors) as RiskFactorName[]) {
      const f = props.risk.factors[key] ?? 0;
      const w = props.risk.weights[key] ?? 0;
      const weighted = f * w;
      if (weighted > 0.001) riskRows.push({ name: key, weighted });
    }
    riskRows.sort((a, b) => b.weighted - a.weighted);
  }
  const topRisk = riskRows.slice(0, 4);
  const riskMax = topRisk.length > 0 ? topRisk[0]!.weighted : 1;

  return (
    <Portal>
      <div
        ref={popRef}
        class={`twin-popover twin-popover--portal twin-popover--${box?.placement ?? 'below'}`}
        data-testid={`room-popover-${room.id}`}
        style={{
          position: 'fixed',
          left: box !== null ? `${box.left}px` : '0',
          top: box !== null ? `${box.top}px` : '0',
          maxHeight: box !== null ? `${box.maxHeight}px` : undefined,
          overflowY: 'auto',
          transform: 'none',
          visibility: box !== null ? 'visible' : 'hidden',
        }}
        role="dialog"
        aria-label={`${t('Details', 'Details')} ${room.name}`}
      >
      <div class="twin-popover__head">
        <span class="twin-popover__title">
          {room.floor !== undefined && room.floor !== '' && (
            <span class="room-badge__floor">{room.floor}</span>
          )}
          {room.name}
        </span>
        <button type="button" class="twin-popover__close" onClick={props.onClose} aria-label={t('Schließen', 'Close')}>
          ×
        </button>
      </div>
      <dl class="twin-popover__grid">
        <PopRow label={t('Innen', 'Indoor')}>
          {room.indoorTempC === null ? '–' : `${room.indoorTempC.toFixed(1)} °C`}
          <TrendArrow trend={room.trend} />
          {room.indoorTempState === 'stale' && <span class="twin-popover__warn"> · {t('veraltet', 'outdated')}</span>}
          {room.indoorTempState === 'unbound' && <span class="twin-popover__warn"> · {t('kein Sensor', 'no sensor')}</span>}
        </PopRow>
        <PopRow label={t('Rollo', 'Shutter')}>
          {clampPct(room.shutterPercent)} %{' '}
          <span class="twin-popover__muted">
            (max {room.roof === true ? '100' : '95'} %{room.roof === true ? `, ${t('Dachfenster', 'roof window')}` : ''})
          </span>
          {previewPct !== null && <span class="twin-popover__preview"> → {t('Prognose', 'Forecast')} {previewPct} %</span>}
        </PopRow>
        {heatPct !== null && (
          <PopRow label={t('Wärmelast', 'Heat load')}>
            <span class={`twin-popover__heat twin-popover__heat--${heatBand(room.heatLoad01) ?? 'low'}`}>
              {heatPct} %
            </span>
          </PopRow>
        )}
        <PopRow label={t('Fassade', 'Facade')}>
          {room.facade} · {orient}
        </PopRow>
        <PopRow label={t('Fenster', 'Window')}>{room.windowOpen === true ? t('offen', 'open') : t('geschlossen', 'closed')}</PopRow>
        <PopRow label={t('Status', 'Status')}>{statusLabel(room.status)}</PopRow>
      </dl>

      {fcVals.length >= 2 && (
        <div class="twin-popover__chart">
          <span class="twin-popover__chart-label">{t('Rollo-Prognose 12 h', 'Shutter forecast 12 h')}</span>
          <Sparkline values={fcVals} width={208} height={30} min={0} max={100} fill="rgba(245,179,1,0.18)" />
        </div>
      )}

      {topRisk.length > 0 && (
        <div class="twin-popover__risk">
          <span class="twin-popover__chart-label">{t('Wärmerisiko-Faktoren', 'Heat-risk factors')}</span>
          {topRisk.map((r) => (
            <div class="twin-popover__riskrow" key={r.name}>
              <span class="twin-popover__riskname">{riskFactorLabel(r.name)}</span>
              <span class="twin-popover__riskbar">
                <span
                  class="twin-popover__riskfill"
                  style={{ width: `${Math.round((r.weighted / riskMax) * 100)}%` }}
                />
              </span>
            </div>
          ))}
        </div>
      )}

      {room.nextAction !== null && (
        <p class="twin-popover__action">
          <b>{t('Nächste Aktion:', 'Next action:')}</b> {tServer(room.nextAction.reason)} ({t('Ziel', 'Target')} {clampPct(room.nextAction.targetPercent)} %)
        </p>
      )}

      {room.windowId !== undefined && (
        <ManualShutterControl
          windowId={room.windowId}
          current={clampPct(room.shutterPercent)}
          roof={room.roof === true}
        />
      )}

      <button
        type="button"
        class="twin-popover__detail"
        data-testid={`room-detail-open-${room.id}`}
        onClick={props.onOpenDetail}
      >
        {t('Detailansicht öffnen →', 'Open detail view →')}
      </button>
      </div>
    </Portal>
  );
}

/**
 * Manual shutter override from the twin popover. Posts to the existing
 * `/api/control/shutter/:windowId` endpoint (which routes through the safety
 * layer). Roof windows may close to 100 %, facades cap at 95 % (Stauschutz).
 */
function ManualShutterControl(props: {
  windowId: string;
  current: number;
  roof: boolean;
}): JSX.Element {
  const max = props.roof ? 100 : 95;
  const [val, setVal] = useState<number>(Math.min(props.current, max));
  const [status, setStatus] = useState<'idle' | 'sending' | 'ok' | 'err'>('idle');
  const send = async (pct: number): Promise<void> => {
    setStatus('sending');
    try {
      const res = await fetch(`/api/control/shutter/${encodeURIComponent(props.windowId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ level01: Math.max(0, Math.min(1, pct / 100)) }),
      });
      setStatus(res.ok ? 'ok' : 'err');
    } catch {
      setStatus('err');
    }
  };
  return (
    <div class="twin-control" data-testid={`twin-control-${props.windowId}`}>
      <span class="twin-popover__chart-label">{t('Manuell steuern', 'Manual control')}</span>
      <div class="twin-control__row">
        <input
          type="range"
          min={0}
          max={max}
          step={5}
          value={val}
          aria-label={t('Rollo-Position', 'Shutter position')}
          onInput={(e): void => setVal(Number((e.currentTarget as HTMLInputElement).value))}
        />
        <span class="twin-control__val">{val}%</span>
        <button
          type="button"
          class="twin-iconbtn"
          title={t('Auf diese Position fahren', 'Move to this position')}
          onClick={(): void => {
            haptic(10);
            void send(val);
          }}
        >
          ▶
        </button>
      </div>
      <div class="twin-control__quick">
        <button type="button" onClick={(): void => { setVal(0); void send(0); }}>
          {t('Auf', 'Open')}
        </button>
        <button type="button" onClick={(): void => { setVal(50); void send(50); }}>
          50 %
        </button>
        <button type="button" onClick={(): void => { setVal(max); void send(max); }}>
          {t('Zu', 'Closed')}
        </button>
      </div>
      {status === 'ok' && <span class="twin-control__status">{t('Befehl gesendet ✓', 'Command sent ✓')}</span>}
      {status === 'err' && (
        <span class="twin-control__status twin-control__status--err">{t('Fehler beim Senden', 'Error sending')}</span>
      )}
    </div>
  );
}

function PopRow(props: { label: string; children: ComponentChildren }): JSX.Element {
  return (
    <div class="twin-popover__row">
      <dt>{props.label}</dt>
      <dd>{props.children}</dd>
    </div>
  );
}

/** Compact circular Schutz-Score gauge. */
function ScoreRing(props: { score: number }): JSX.Element {
  const animated = useCountUp(props.score, 600);
  const r = 13;
  const c = 2 * Math.PI * r;
  const frac = clamp(animated / 100, 0, 1);
  const color = props.score >= 70 ? 'var(--color-success)' : props.score >= 45 ? 'var(--color-warn)' : 'var(--color-danger)';
  return (
    <span class="twin-score" title={t('Schutz-Score: wie gut die Räume aktuell vor Wärmelast geschützt sind', 'Protection score: how well the rooms are currently protected against heat load')}>
      <svg viewBox="0 0 32 32" width={30} height={30} aria-hidden="true">
        <circle cx={16} cy={16} r={r} fill="none" stroke="rgba(255,255,255,0.15)" stroke-width={4} />
        <circle
          cx={16}
          cy={16}
          r={r}
          fill="none"
          stroke={color}
          stroke-width={4}
          stroke-linecap="round"
          stroke-dasharray={`${(frac * c).toFixed(1)} ${c.toFixed(1)}`}
          transform="rotate(-90 16 16)"
        />
      </svg>
      <span class="twin-score__body">
        <span class="twin-score__label">{t('Schutz', 'Protection')}</span>
        <span class="twin-score__value">{Math.round(animated)}</span>
      </span>
    </span>
  );
}

function TwinToolbar(props: {
  snapshot: DashboardSnapshot;
  rooms: RoomDetail[];
  locked: boolean;
  showLegend: boolean;
  heatmapOn: boolean;
  onToggleLock: () => void;
  onToggleLegend: () => void;
  onToggleHeatmap: () => void;
  onReset: () => void;
}): JSX.Element {
  const insights = useMemo(() => computeInsights(props.rooms), [props.rooms]);
  const tempSeries = (props.snapshot.forecastTimeline ?? []).map((c) => c.tempC);
  const max12 = tempSeries.length >= 2 ? Math.round(Math.max(...tempSeries)) : null;
  return (
    <div class="twin-toolbar" data-testid="twin-toolbar">
      <div class="twin-toolbar__insights">
        {insights.score !== null && <ScoreRing score={insights.score} />}
        {max12 !== null && (
          <span class="twin-insight twin-insight--wide" title={t('Außentemperatur-Prognose der nächsten 12 h', 'Outdoor temperature forecast for the next 12 h')}>
            <Sparkline values={tempSeries} width={72} height={20} stroke="var(--color-accent)" />
            <span class="twin-insight__value">{max12}°</span>
          </span>
        )}
        <span class="twin-insight" title={t('Durchschnittlicher Rollo-Stand', 'Average shutter position')}>
          <span class="twin-insight__label">Ø</span>
          <span class="twin-insight__value">{insights.avgShutter}%</span>
        </span>
        {insights.openWindows > 0 && (
          <span class="twin-insight twin-insight--secondary" title={t('Räume mit offenem Fenster', 'Rooms with an open window')}>
            <Icon name="fenster" size={13} class="twin-insight__icon" />
            <span class="twin-insight__value">{insights.openWindows}</span>
          </span>
        )}
      </div>
      <div class="twin-toolbar__actions">
        <button
          type="button"
          class={`twin-iconbtn${props.heatmapOn ? ' twin-iconbtn--active' : ''}`}
          data-testid="twin-heatmap-toggle"
          aria-pressed={props.heatmapOn}
          onClick={props.onToggleHeatmap}
          title={t('Wärme-Heatmap ein-/ausblenden', 'Toggle heat map')}
        >
          🌡
        </button>
        <button
          type="button"
          class={`twin-iconbtn${props.showLegend ? ' twin-iconbtn--active' : ''}`}
          data-testid="twin-legend-toggle"
          aria-pressed={props.showLegend}
          onClick={props.onToggleLegend}
          title={t('Legende ein-/ausblenden', 'Toggle legend')}
        >
          ⓘ
        </button>
        <button
          type="button"
          class="twin-iconbtn twin-iconbtn--reset"
          data-testid="twin-reset"
          onClick={props.onReset}
          title={t('Haus auf Standard zurücksetzen (Anordnung, Sperre, Wärme, Legende)', 'Reset house to defaults (layout, lock, heat, legend)')}
        >
          ↺
        </button>
        <button
          type="button"
          class={`twin-iconbtn${props.locked ? '' : ' twin-iconbtn--active'}`}
          data-testid="twin-lock-toggle"
          aria-pressed={!props.locked}
          onClick={props.onToggleLock}
          title={
            props.locked
              ? t('Badges sind gesperrt – zum Verschieben entsperren', 'Badges are locked – unlock to move them')
              : t('Badges verschiebbar – zum Sperren klicken', 'Badges movable – click to lock')
          }
        >
          {props.locked ? (
            <Icon name="schloss" size={17} class="twin-iconbtn__glyph" title={t('Gesperrt', 'Locked')} />
          ) : (
            <Icon name="schloss-auf" size={17} class="twin-iconbtn__glyph" title={t('Entsperrt', 'Unlocked')} />
          )}
        </button>
      </div>
    </div>
  );
}

function computeInsights(rooms: RoomDetail[]): {
  avgShutter: number;
  openWindows: number;
  warmest: { name: string; tempC: number } | null;
  score: number | null;
} {
  if (rooms.length === 0) {
    return { avgShutter: 0, openWindows: 0, warmest: null, score: null };
  }
  let sum = 0;
  let openWindows = 0;
  let warmest: { name: string; tempC: number } | null = null;
  let loadSum = 0;
  let loadN = 0;
  for (const r of rooms) {
    sum += clampPct(r.shutterPercent);
    if (r.windowOpen === true) openWindows += 1;
    if (r.indoorTempC !== null && (warmest === null || r.indoorTempC > warmest.tempC)) {
      warmest = { name: r.name, tempC: r.indoorTempC };
    }
    if (r.heatLoad01 !== undefined && Number.isFinite(r.heatLoad01)) {
      loadSum += clamp(r.heatLoad01, 0, 1);
      loadN += 1;
    }
  }
  const score = loadN > 0 ? Math.round(100 - (loadSum / loadN) * 100) : null;
  return { avgShutter: Math.round(sum / rooms.length), openWindows, warmest, score };
}

function TwinLegend(props: { onClose: () => void }): JSX.Element {
  return (
    <div class="twin-legend" data-testid="twin-legend" role="dialog" aria-label={t('Legende', 'Legend')}>
      <div class="twin-legend__head">
        <span class="twin-legend__title">{t('Legende', 'Legend')}</span>
        <button type="button" class="twin-legend__close" onClick={props.onClose} aria-label={t('Legende schließen', 'Close legend')}>
          ×
        </button>
      </div>
      <ul class="twin-legend__list">
        <li class="twin-legend__row">
          <ShutterGlyph percent={70} />
          <span>
            {t(
              'Rollo-Stand: 0 % offen → 95 % geschlossen. Goldener Teil = zu, heller Teil = Tageslicht. Klick auf ein Badge zeigt Details.',
              'Shutter position: 0 % open → 95 % closed. Golden part = closed, lighter part = daylight. Click a badge for details.',
            )}
          </span>
        </li>
        <li class="twin-legend__row">
          <Icon name="fenster" size={16} class="twin-legend__icon" />
          <span>{t('Fenster im Raum ist offen oder gekippt.', 'A window in the room is open or tilted.')}</span>
        </li>
        <li class="twin-legend__row">
          <span class="twin-legend__dots">
            <span class="room-badge__status" data-state="scheduled" />
            <span class="room-badge__status" data-state="executing" />
            <span class="room-badge__status" data-state="blocked" />
            <span class="room-badge__status" data-state="manuallyOverridden" />
          </span>
          <span>{t('Status: Geplant · Fährt · Blockiert · Manuell übersteuert.', 'Status: Scheduled · Moving · Blocked · Manually overridden.')}</span>
        </li>
        <li class="twin-legend__row">
          <span class="twin-legend__heat">
            <span class="twin-legend__heat-dot twin-legend__heat-dot--low" />
            <span class="twin-legend__heat-dot twin-legend__heat-dot--mid" />
            <span class="twin-legend__heat-dot twin-legend__heat-dot--high" />
          </span>
          <span>
            {t(
              '„Wärme" tönt Badges nach Wärmelast. Sonnenbogen scrubben zeigt die Rollo-Prognose der nächsten 12 h (Markierung „≈P").',
              '“Heat” tints badges by heat load. Scrubbing the sun arc shows the shutter forecast for the next 12 h (marked “≈P”).',
            )}
          </span>
        </li>
        <li class="twin-legend__row twin-legend__row--note">
          <span>
            {t(
              '95 % ist die stärkste automatische Schließung – ein kleiner Spalt verhindert Hitzestau hinter dem Rollladen. 100 % nur manuell oder bei Dachfenstern.',
              '95 % is the strongest automatic closing – a small gap prevents heat build-up behind the shutter. 100 % only manually or for roof windows.',
            )}
          </span>
        </li>
      </ul>
    </div>
  );
}

function EnvironmentOverlay(props: { snapshot: DashboardSnapshot }): JSX.Element {
  const env = props.snapshot.environment;
  const humidityPct =
    env?.humidity01.value !== undefined && env?.humidity01.value !== null
      ? Math.round(env.humidity01.value * 100)
      : null;
  return (
    <div class="twin-overlay twin-overlay--env" data-testid="overlay-environment">
      <EnvChip icon="sonne" label={t('Sonnenintensität', 'Sun intensity')} text={formatSignal(env?.radiationWm2.value ?? null, 'W/m²', 0)} />
      <EnvChip icon="uv" label={t('UV-Index', 'UV index')} text={formatSignal(env?.uvIndex.value ?? null, '', 1)} />
      <EnvChip icon="wind" label={t('Wind', 'Wind')} text={formatWindKmh(env?.windMs.value ?? null)} />
      <EnvChip icon="feuchte" label={t('Luftfeuchte', 'Humidity')} text={humidityPct === null ? '–' : `${humidityPct} %`} />
    </div>
  );
}

function EnvChip(props: { icon: IconName; label: string; text: string }): JSX.Element {
  return (
    <span class="env-chip" title={props.label}>
      <Icon name={props.icon} size={20} class="env-chip__icon" />
      <span class="env-chip__body">
        <span class="env-chip__label">{props.label}</span>
        <span class="env-chip__value">{props.text}</span>
      </span>
    </span>
  );
}

/**
 * Phone fallback for the spatial twin: a compact, tappable room table. Each
 * row shows the live shutter glyph + percent, indoor temperature with trend,
 * status and an open-window marker; tapping a row expands an inline detail
 * panel with the same facts as the desktop popover plus manual override.
 */
function MobileRoomList(props: {
  rooms: RoomDetail[];
  onOpenDetail: (id: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState<string | null>(null);
  const insights = useMemo(() => computeInsights(props.rooms), [props.rooms]);
  const sorted = useMemo(
    () =>
      [...props.rooms].sort(
        (a, b) => floorTier(a.floor) - floorTier(b.floor) || a.name.localeCompare(b.name),
      ),
    [props.rooms],
  );
  return (
    <div class="twin-mobile" data-testid="twin-mobile">
      <div class="twin-mobile__head">
        {insights.score !== null && <ScoreRing score={insights.score} />}
        <span class="twin-insight" title={t('Durchschnittlicher Rollo-Stand', 'Average shutter position')}>
          <span class="twin-insight__label">{t('Ø Rollo', 'Ø shutter')}</span>
          <span class="twin-insight__value">{insights.avgShutter}%</span>
        </span>
        {insights.openWindows > 0 && (
          <span class="twin-insight twin-insight--secondary" title={t('Räume mit offenem Fenster', 'Rooms with an open window')}>
            <Icon name="fenster" size={13} class="twin-insight__icon" />
            <span class="twin-insight__value">{insights.openWindows}</span>
          </span>
        )}
      </div>
      {sorted.length === 0 ? (
        <p class="twin-mobile__empty">{t('Noch keine Räume erkannt.', 'No rooms detected yet.')}</p>
      ) : (
        <ul class="twin-mobile__list">
          {sorted.map((room) => (
            <MobileRoomRow
              key={room.id}
              room={room}
              expanded={open === room.id}
              onToggle={(): void => setOpen((c) => (c === room.id ? null : room.id))}
              onOpenDetail={(): void => props.onOpenDetail(room.id)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function MobileRoomRow(props: {
  room: RoomDetail;
  expanded: boolean;
  onToggle: () => void;
  onOpenDetail: () => void;
}): JSX.Element {
  const { room } = props;
  const pct = clampPct(room.shutterPercent);
  const tempStr = room.indoorTempC === null ? '–' : `${room.indoorTempC.toFixed(1)}°`;
  const heatPct = room.heatLoad01 !== undefined ? Math.round(room.heatLoad01 * 100) : null;
  return (
    <li
      class={`twin-row twin-row--${room.status}${props.expanded ? ' twin-row--open' : ''}`}
      data-testid={`twin-row-${room.id}`}
    >
      <button
        type="button"
        class="twin-row__main"
        onClick={props.onToggle}
        aria-expanded={props.expanded}
        title={statusLabel(room.status)}
      >
        <ShutterGlyph percent={pct} roof={room.roof === true} running={room.status === 'executing'} />
        <span class="twin-row__name">
          {room.floor !== undefined && room.floor !== '' && (
            <span class="room-badge__floor">{room.floor}</span>
          )}
          <span class="twin-row__roomname">{room.name}</span>
        </span>
        <span class="twin-row__pct" data-shutter={shutterBand(pct)}>
          {pct}%
        </span>
        <span class="twin-row__temp">
          {tempStr}
          <TrendArrow trend={room.trend} />
        </span>
        {room.windowOpen === true && (
          <Icon name="fenster" size={14} class="twin-row__win" title={t('Fenster offen', 'Window open')} />
        )}
        <span class="room-badge__status" data-state={room.status} aria-hidden="true" />
        <span class="twin-row__chev" aria-hidden="true">
          {props.expanded ? '▾' : '▸'}
        </span>
      </button>
      {props.expanded && (
        <div class="twin-row__detail">
          <dl class="twin-row__grid">
            <div class="twin-row__cell">
              <dt>{t('Innen', 'Indoor')}</dt>
              <dd>
                {room.indoorTempC === null ? '–' : `${room.indoorTempC.toFixed(1)} °C`}
                {room.indoorTempState === 'stale' && <span class="twin-popover__warn"> · {t('veraltet', 'outdated')}</span>}
                {room.indoorTempState === 'unbound' && <span class="twin-popover__warn"> · {t('kein Sensor', 'no sensor')}</span>}
              </dd>
            </div>
            <div class="twin-row__cell">
              <dt>{t('Rollo', 'Shutter')}</dt>
              <dd>
                {pct} %{' '}
                <span class="twin-popover__muted">(max {room.roof === true ? '100' : '95'} %)</span>
              </dd>
            </div>
            {heatPct !== null && (
              <div class="twin-row__cell">
                <dt>{t('Wärmelast', 'Heat load')}</dt>
                <dd>
                  <span class={`twin-popover__heat twin-popover__heat--${heatBand(room.heatLoad01) ?? 'low'}`}>
                    {heatPct} %
                  </span>
                </dd>
              </div>
            )}
            <div class="twin-row__cell">
              <dt>{t('Fassade', 'Facade')}</dt>
              <dd>
                {room.facade}
                {room.orientationDeg !== undefined ? ` · ${Math.round(room.orientationDeg)}°` : ''}
              </dd>
            </div>
            <div class="twin-row__cell">
              <dt>{t('Fenster', 'Window')}</dt>
              <dd>{room.windowOpen === true ? t('offen', 'open') : t('geschlossen', 'closed')}</dd>
            </div>
            <div class="twin-row__cell">
              <dt>{t('Status', 'Status')}</dt>
              <dd>{statusLabel(room.status)}</dd>
            </div>
          </dl>
          {room.nextAction !== null && (
            <p class="twin-row__action">
              <b>{t('Nächste Aktion:', 'Next action:')}</b> {tServer(room.nextAction.reason)} ({t('Ziel', 'Target')}{' '}
              {clampPct(room.nextAction.targetPercent)} %)
            </p>
          )}
          {room.windowId !== undefined && (
            <ManualShutterControl windowId={room.windowId} current={pct} roof={room.roof === true} />
          )}
          <button
            type="button"
            class="twin-popover__detail"
            data-testid={`room-detail-open-${room.id}`}
            onClick={props.onOpenDetail}
          >
            {t('Detailansicht öffnen →', 'Open detail view →')}
          </button>
        </div>
      )}
    </li>
  );
}

