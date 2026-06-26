/**
 * Heat Shield — per-window shading state machine with asymmetric hysteresis
 * (smart-shading-notifications Task 3.1).
 *
 * The shading logic must activate quickly when the solar/heat load spikes but
 * release lazily so the shutter does not pump up and down on passing clouds
 * (Requirement 3). This module is the small FSM that enforces that asymmetry,
 * one instance per window, over a persisted `WindowShadeRuntime`.
 *
 * ## States
 *
 *   - `open`   — the window is not in heat-protection shading.
 *   - `shaded` — the window is being actively shaded against heat.
 *
 * ## Transitions (pure, deterministic)
 *
 *   open → shaded:
 *     `load01 ≥ activateThreshold` AND there is direct sun on the window
 *     (now or within the pre-look horizon). Activation is immediate — no
 *     hold time on the way in.
 *
 *   shaded → open (either condition releases):
 *     (a) no direct sun on the window anymore → release immediately
 *         (Requirement 4.2 — when the sun has moved off, the shutter may
 *         open again), OR
 *     (b) `load01 ≤ releaseThreshold` *and* that has held continuously for
 *         at least `releaseHoldMinutes` (Requirement 3.2, default 60 min).
 *
 * The two thresholds are separate (`activateThreshold > releaseThreshold` in
 * any sane config) so this is a genuine hysteresis band, not a single
 * trip point (Requirement 3.4).
 *
 * ## Correctness Property 2 (design.md)
 *
 * While direct sun persists and the load is below `releaseThreshold`, the
 * window stays `shaded` for at least `releaseHoldMinutes` before releasing.
 * The `belowReleaseSince` timestamp is the anchor for that hold; it is reset
 * to `null` whenever the load climbs back above the release threshold.
 *
 * ## Module rules
 *
 *   - Pure: no fs, no logging, no globals. Persistence is the orchestrator's
 *     job (state.json round-trip, Task 3.2).
 *   - Strict TS, ESM, `.js` import suffixes.
 *   - Clock injected via `now`. Timestamps are ISO-8601 UTC strings to match
 *     the rest of the runtime state.
 */

export type ShadeState = 'open' | 'shaded';

/** Persisted per-window shading memory. */
export interface WindowShadeRuntime {
  state: ShadeState;
  /** When the window entered `shaded`; `null` while `open`. */
  shadedSince: string | null;
  /** When the load first dropped to/below the release threshold; `null` otherwise. */
  belowReleaseSince: string | null;
}

/** Inputs for one FSM step. */
export interface ShadeTransitionInputs {
  prev: WindowShadeRuntime;
  now: Date;
  /** Effective heat load in `[0, 1]` from `effectiveHeatLoad01`. */
  load01: number;
  /** True when direct sun is on the window now (or within the pre-look). */
  hasDirectSun: boolean;
  /** Load at/above which shading activates. */
  activateThreshold: number;
  /** Load at/below which the release hold timer runs. */
  releaseThreshold: number;
  /** Minimum minutes the release condition must hold before opening. */
  releaseHoldMinutes: number;
}

/** A fresh `open` runtime — the default for a window the engine has not seen. */
export function initialShadeRuntime(): WindowShadeRuntime {
  return { state: 'open', shadedSince: null, belowReleaseSince: null };
}

function minutesBetween(fromIso: string, now: Date): number | null {
  const fromMs = Date.parse(fromIso);
  if (!Number.isFinite(fromMs)) {
    return null;
  }
  return (now.getTime() - fromMs) / 60_000;
}

/**
 * Compute the next shading runtime from the previous one and the current
 * inputs. Returns a fresh object; never mutates `prev`.
 */
export function nextShadeState(
  inputs: ShadeTransitionInputs,
): WindowShadeRuntime {
  const {
    prev,
    now,
    load01,
    hasDirectSun,
    activateThreshold,
    releaseThreshold,
    releaseHoldMinutes,
  } = inputs;
  const nowIso = now.toISOString();

  if (prev.state === 'open') {
    // Immediate activation when load is high enough and the sun is on us.
    if (hasDirectSun && load01 >= activateThreshold) {
      return { state: 'shaded', shadedSince: nowIso, belowReleaseSince: null };
    }
    // Stay open; no release timer runs while open.
    return { state: 'open', shadedSince: null, belowReleaseSince: null };
  }

  // prev.state === 'shaded'
  // (a) Sun moved off the window → open immediately.
  if (!hasDirectSun) {
    return { state: 'open', shadedSince: null, belowReleaseSince: null };
  }

  // (b) Release-hold timer while the load sits at/below the release threshold.
  if (load01 <= releaseThreshold) {
    const belowSince = prev.belowReleaseSince ?? nowIso;
    const held = minutesBetween(belowSince, now);
    if (held !== null && held >= releaseHoldMinutes) {
      return { state: 'open', shadedSince: null, belowReleaseSince: null };
    }
    // Keep shading; remember (or carry) when we first dropped below.
    return {
      state: 'shaded',
      shadedSince: prev.shadedSince ?? nowIso,
      belowReleaseSince: belowSince,
    };
  }

  // Load climbed back above the release threshold → cancel the hold timer.
  return {
    state: 'shaded',
    shadedSince: prev.shadedSince ?? nowIso,
    belowReleaseSince: null,
  };
}
