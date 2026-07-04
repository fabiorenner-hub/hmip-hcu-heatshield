/**
 * Heat Shield — Übersicht view-model (uebersicht-rework, Task 2).
 *
 * PURE, deterministic derivations from a {@link DashboardSnapshot}. No I/O, no
 * signals, no `t()` (language-independent): every function returns plain data
 * or a small enum key that the presentational components localize at the render
 * edge. This keeps the whole overview logic unit- and property-testable
 * (fast-check) — the family standard "pure engine/logic, I/O at the rim".
 *
 * Design reference: `.kiro/specs/uebersicht-rework/design.md` §5 (Components)
 * and §Data-Models. Honesty rule: missing/stale sources degrade to `null`
 * here; components render `–` — never an invented number.
 */

import type {
  DashboardSnapshot,
  FacadeKey,
  ForecastTimelineCard,
  PlannedAction,
  VentAdviceLevel,
} from '../../types.js';

/** Overall decision tone for the hero / status banner. */
export type Tone = 'calm' | 'active' | 'alert';

/**
 * Language-independent headline key. Components map it to a localized title so
 * this module never depends on the reactive `lang` signal.
 */
export type HeadlineKey = 'storm' | 'alert' | 'heat' | 'night' | 'summer' | 'calm';

export interface HeadlineVM {
  tone: Tone;
  key: HeadlineKey;
}

/** Room ampel tone derived from the normalised heat load. */
export type RoomTone = 'ok' | 'warm' | 'hot' | 'unknown';

export interface RoomStatusVM {
  id: string;
  name: string;
  tone: RoomTone;
  tempC: number | null;
  trend: 'up' | 'down' | 'flat';
  /** 0 = open … 100 = closed. */
  shutterPercent: number;
  windowOpen: boolean;
  roof: boolean;
  facade: FacadeKey;
  /** Primary window id for manual control from the twin popover, if any. */
  windowId: string | undefined;
  /** True when the indoor-temperature signal is stale. */
  stale: boolean;
  /** True when the room has no bound indoor-temperature sensor. */
  unbound: boolean;
}

// ---------------------------------------------------------------------------
// Headline / tone
// ---------------------------------------------------------------------------

/** True while a storm hold is in effect (mode STORM or a future holdUntil). */
export function isStormActive(snap: DashboardSnapshot): boolean {
  if (snap.mode === 'STORM') return true;
  const hold = snap.storm?.holdUntil;
  if (hold === null || hold === undefined) return false;
  const ms = Date.parse(hold);
  return Number.isFinite(ms) && ms > Date.now();
}

/**
 * Primary headline for the hero / banner. Safety precedence is absolute:
 * STORM/hold → alert, then an active severe-weather alert → alert, then the
 * heat-protection modes → active, then calm. (design.md Property 3.)
 */
export function primaryHeadline(snap: DashboardSnapshot): HeadlineVM {
  if (isStormActive(snap)) return { tone: 'alert', key: 'storm' };
  if (snap.weatherAlert?.active === true) return { tone: 'alert', key: 'alert' };
  if (snap.mode === 'HEATWAVE' || snap.mode === 'ACTIVE_HEAT_PROTECTION') {
    return { tone: 'active', key: 'heat' };
  }
  if (snap.mode === 'NIGHT_COOLING') return { tone: 'active', key: 'night' };
  if (snap.mode === 'SUMMER_WATCH') return { tone: 'calm', key: 'summer' };
  return { tone: 'calm', key: 'calm' };
}

// ---------------------------------------------------------------------------
// Avoided warming (benefit)
// ---------------------------------------------------------------------------

/** Peak temperature of a trajectory, or null when empty/absent. */
export function trajectoryPeak(pts?: Array<{ tempC: number }>): number | null {
  if (pts === undefined || pts.length === 0) return null;
  let peak = -Infinity;
  for (const p of pts) if (p.tempC > peak) peak = p.tempC;
  return Number.isFinite(peak) ? peak : null;
}

/**
 * Avoided warming (°C) = no-shade peak − with-shade peak, clamped to ≥ 0.
 * `null` iff either trajectory is missing/empty. (design.md Property 2.)
 */
export function avoidedWarmingC(snap: DashboardSnapshot): number | null {
  const withShade = trajectoryPeak(snap.trajectories?.indoorForecastWithShade);
  const noShade = trajectoryPeak(snap.trajectories?.indoorForecastNoShade);
  if (withShade === null || noShade === null) return null;
  return Math.max(0, noShade - withShade);
}

/** Expected indoor peak for the hero meta — with-shade forecast else today's peak. */
export function expectedPeakC(snap: DashboardSnapshot): number | null {
  return (
    trajectoryPeak(snap.trajectories?.indoorForecastWithShade) ??
    snap.indoorPeakTempC ??
    null
  );
}

// ---------------------------------------------------------------------------
// Planned actions
// ---------------------------------------------------------------------------

/** Actions that still lie in the future and are not blocked/overridden/done. */
export function futurePlannedActions(
  snap: DashboardSnapshot,
  now: Date = new Date(),
): PlannedAction[] {
  const nowMs = now.getTime();
  return (snap.plannedActions ?? [])
    .filter((a) => {
      if (a.state === 'blocked' || a.state === 'manuallyOverridden' || a.state === 'completed') {
        return false;
      }
      const ms = Date.parse(a.scheduledTs);
      return Number.isFinite(ms) && ms >= nowMs;
    })
    .sort((a, b) => Date.parse(a.scheduledTs) - Date.parse(b.scheduledTs));
}

/** The single next planned action, or null. (design.md Property 6.) */
export function nextPlannedAction(
  snap: DashboardSnapshot,
  now: Date = new Date(),
): PlannedAction | null {
  return futurePlannedActions(snap, now)[0] ?? null;
}

// ---------------------------------------------------------------------------
// Facades / environment KPIs
// ---------------------------------------------------------------------------

/** Strongest solar-load facade (max %) as a key + rounded percent, or null. */
export function strongestFacade(
  snap: DashboardSnapshot,
): { key: FacadeKey; pct: number } | null {
  const f = snap.facades;
  if (f === undefined) return null;
  const keys: FacadeKey[] = ['N', 'E', 'S', 'W'];
  let best: FacadeKey = 'N';
  for (const k of keys) if (f[k] > f[best]) best = k;
  return { key: best, pct: Math.round(f[best]) };
}

/** Overall ventilation advice level for the KPI tile, or null. */
export function ventilationLevel(snap: DashboardSnapshot): VentAdviceLevel | null {
  return snap.ventilation?.overall.level ?? null;
}

/** 2 h precipitation sum (mm) from the nowcast, rounded to 0.1, or null. */
export function precip2hMm(snap: DashboardSnapshot): number | null {
  const pc = snap.precipNowcast;
  if (pc === undefined || pc.length === 0) return null;
  const sum = pc.reduce((s, p) => s + p.precipMm, 0);
  return Math.round(sum * 10) / 10;
}

/** Cloud cover as a 0..100 percent for the rain/cloud KPI fallback, or null. */
export function cloudPercent(snap: DashboardSnapshot): number | null {
  const c = snap.signals?.forecastCloudCover?.value ?? null;
  if (c === null) return null;
  return Math.round(c > 1 ? c : c * 100);
}

// ---------------------------------------------------------------------------
// Outlook
// ---------------------------------------------------------------------------

/** The first `hours` forecast cards (defensive slice; empty when absent). */
export function outlookCards(
  snap: DashboardSnapshot,
  hours: number,
): ForecastTimelineCard[] {
  const cards = snap.forecastTimeline ?? [];
  return cards.slice(0, Math.max(0, hours));
}

/** Index of the hottest card in a list, or null when empty. */
export function outlookPeakIndex(
  cards: ReadonlyArray<{ tempC: number }>,
): number | null {
  if (cards.length === 0) return null;
  let idx = 0;
  let peak = -Infinity;
  for (let i = 0; i < cards.length; i += 1) {
    const c = cards[i];
    if (c !== undefined && c.tempC > peak) {
      peak = c.tempC;
      idx = i;
    }
  }
  return idx;
}

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

/** Map a heat load in [0,1] to an ampel tone. */
export function roomToneFromLoad(load01: number | undefined): RoomTone {
  if (load01 === undefined || !Number.isFinite(load01)) return 'unknown';
  if (load01 >= 0.7) return 'hot';
  if (load01 >= 0.4) return 'warm';
  return 'ok';
}

/**
 * One view-model per room detail (preserves order + count — Property 7). An
 * `unbound` sensor forces tone `unknown` so the card shows a sensor hint
 * instead of a fabricated temperature.
 */
export function roomStatuses(snap: DashboardSnapshot): RoomStatusVM[] {
  return (snap.roomsDetail ?? []).map((r) => {
    const unbound = r.indoorTempState === 'unbound';
    const stale = r.indoorTempState === 'stale';
    const tone: RoomTone = unbound ? 'unknown' : roomToneFromLoad(r.heatLoad01);
    return {
      id: r.id,
      name: r.name,
      tone,
      tempC: unbound ? null : r.indoorTempC,
      trend: r.trend,
      shutterPercent: r.shutterPercent,
      windowOpen: r.windowOpen === true,
      roof: r.roof === true,
      facade: r.facade,
      windowId: r.windowId,
      stale,
      unbound,
    };
  });
}

// ---------------------------------------------------------------------------
// Freshness / age
// ---------------------------------------------------------------------------

/** Snapshot age in whole minutes (≥ 0), or null when the ts is unparseable. */
export function dataAgeMinutes(ts: string, now: Date = new Date()): number | null {
  const ms = Date.parse(ts);
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.round((now.getTime() - ms) / 60000));
}

/** Forecast quality (± °C) for the confidence badge, or null while learning. */
export function forecastAccuracyC(snap: DashboardSnapshot): number | null {
  const v = snap.impact?.forecastAccuracyC;
  return v === undefined || !Number.isFinite(v) ? null : v;
}
