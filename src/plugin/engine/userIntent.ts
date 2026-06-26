/**
 * Heat Shield — user-intent reducer (Task 9.1).
 *
 * The plugin owns five virtual SWITCH devices (see
 * `connect/ownDevices.ts`). Three of them (`heatshield-state-active`,
 * `heatshield-state-forecast`, `heatshield-state-night-cooling`) are
 * status switches: the engine drives their value, the user can read
 * them. Two (`heatshield-control-pause`, `heatshield-control-vacation`)
 * are control switches: the user toggles them in the HmIP app to
 * influence engine behaviour.
 *
 * Before this module the orchestrator only consumed the boolean
 * `switches.pauseControl` / `switches.vacation` derived directly from
 * the `OwnDeviceManager` cache. That worked for the simple "is this
 * switch on right now?" check, but it could not capture the more
 * nuanced semantics this task adds:
 *
 *   - **Pause until midnight**: when the user engages
 *     `heatshield-control-pause`, the pause should stick *until the
 *     next local midnight* unless the user toggles it back early.
 *     A persisted `pauseUntil` timestamp lets a plugin restart still
 *     honour the original pause window.
 *
 *   - **Vacation profile**: when the user engages
 *     `heatshield-control-vacation`, every room's `target_c` /
 *     `warning_c` / `strong_shade_c` is shifted down by
 *     `rules.comfort.vacationOffsetC`. `critical_c` stays as-is — it
 *     is the absolute hard ceiling.
 *
 *   - **State-active force-open**: the *status* switch
 *     `heatshield-state-active` is normally engine-driven, but when
 *     the user toggles it to `false` they are saying "stop, leave the
 *     shutters alone". The reducer translates that into a per-window
 *     manual override (`now + manualOverrideMinutes * 60_000`) that
 *     plugs straight into the orchestrator's existing
 *     `manualOverrideUntil` machinery in `engine/safety.ts`.
 *
 *   - **Other status-switch toggles**: `heatshield-state-forecast` and
 *     `heatshield-state-night-cooling` are read-only signals from the
 *     engine's perspective. A user toggle on either is *idempotent* —
 *     it does not produce a sticky override, but it does request a
 *     single forced re-evaluation on the next cycle so the engine
 *     re-runs its lookahead / mode FSM with fresh inputs and can
 *     re-confirm the value. Setting either to a value the engine
 *     disagrees with therefore lasts at most one cycle before the
 *     engine reasserts its own decision via `OwnDeviceManager.confirmFromEngine`.
 *
 * This module is **pure**: same inputs → same outputs, no fs, no
 * Connect API plumbing, no globals. The orchestrator hooks the
 * resulting effects into its persistent state and the
 * `OwnDeviceManager.userInput` callback.
 *
 * Module rules (mirrored from sibling engine modules):
 *   - Strict TS, ESM, `.js` import suffixes.
 *   - The reducer never mutates its inputs. The returned `next`
 *     UserIntent is always a fresh object.
 *   - `forceOpenUntil` lives only on the {@link UserIntent} reducer
 *     surface (per-window `Map<string, Date>`); the persisted shape
 *     in `state-schema.ts::UserIntentStateSchema` deliberately omits
 *     it because the safety layer already owns that machinery via
 *     `WindowRuntimeState.manualOverrideUntil`.
 */

import { dayBoundsLocal } from './sun.js';
import type {
  Location,
  OwnSwitchId,
  UserIntentState,
} from '../../shared/types.js';

// ---------------------------------------------------------------------------
// Public types.
// ---------------------------------------------------------------------------

/**
 * In-memory representation of the user's high-level intent. The
 * persisted subset (`paused`, `pauseUntil`, `vacation`) is mirrored
 * onto `RuntimeState.userIntent` via {@link toPersistedUserIntent} /
 * {@link fromPersistedUserIntent}. `forceOpenUntil` is *not*
 * persisted here — its contents are reflected onto each affected
 * window's `WindowRuntimeState.manualOverrideUntil` so the safety
 * layer's existing manual-override branch does the suppression.
 */
export interface UserIntent {
  /** Mirror of `heatshield-control-pause` switch. */
  paused: boolean;
  /** Mirror of `heatshield-control-vacation` switch. */
  vacation: boolean;
  /**
   * Wall-clock instant at which the pause expires automatically. Set
   * to the next local midnight when pause is engaged; cleared back to
   * `null` when pause is disengaged.
   */
  pauseUntil: Date | null;
  /**
   * Per-window force-open intent. The reducer populates this map for
   * every window in `allWindowIds` whenever the user toggles
   * `heatshield-state-active` to `false`. The orchestrator reads each
   * entry, propagates it onto the matching window's
   * `manualOverrideUntil`, and clears the map afterwards (the
   * persisted manual override is the source of truth from then on).
   */
  forceOpenUntil: Map<string, Date>;
}

/**
 * Parameters for {@link applyUserSwitchToggle}. `id` and
 * `requestedValue` come straight from the `OwnDeviceManager`'s
 * `userInput` event; `now`, `manualOverrideMinutes`, `allWindowIds`
 * and `location` are pulled from the orchestrator's surrounding
 * context.
 */
export interface ApplyUserSwitchToggleParams {
  /** Switch id the user toggled. */
  id: OwnSwitchId;
  /** Boolean value requested by the user. */
  requestedValue: boolean;
  /** Current wall-clock instant. Used as the anchor for `pauseUntil` and `forceOpenUntil`. */
  now: Date;
  /**
   * Per-window manual-override duration in minutes (from
   * `Config.rules.manualOverrideMinutes`, default 60).
   */
  manualOverrideMinutes: number;
  /**
   * Ids of every window currently flagged as auto-shaded. The reducer
   * uses this list to populate `forceOpenUntil` when
   * `heatshield-state-active` flips to `false`.
   */
  allWindowIds: ReadonlyArray<string>;
  /**
   * IANA timezone-aware location (lat/lon/timezone). Required for the
   * "next local midnight" pause-until calculation. Reusing the
   * `Location` type rather than narrowing to just `timezone` keeps the
   * orchestrator's existing config plumbing trivially compatible.
   */
  location: Pick<Location, 'timezone'>;
}

/**
 * Side-effects produced by one reducer step. The orchestrator acts on
 * this struct after persisting the new {@link UserIntent}:
 *
 *   - `reevaluate` is `true` when the engine should run a forced
 *     re-evaluation on the next cycle. Set when the user toggles a
 *     status switch (`heatshield-state-forecast` /
 *     `heatshield-state-night-cooling`) to a value the engine has not
 *     yet confirmed. The reducer never produces a sticky override
 *     for those switches — the engine's next cycle will reassert its
 *     own decision via `OwnDeviceManager.confirmFromEngine`.
 *
 *   - `forceOpenWindowIds` enumerates the windows for which the
 *     orchestrator should set `manualOverrideUntil = now +
 *     manualOverrideMinutes * 60_000`. Empty for every reducer step
 *     except the `heatshield-state-active = false` toggle.
 */
export interface UserIntentEffects {
  reevaluate: boolean;
  forceOpenWindowIds: string[];
}

/**
 * Result of one reducer step.
 */
export interface ApplyUserSwitchToggleResult {
  /** New {@link UserIntent}. Always a fresh object. */
  next: UserIntent;
  /** Side-effects the orchestrator must act on. */
  effects: UserIntentEffects;
}

// ---------------------------------------------------------------------------
// Re-exported manual-override-key for orchestrator/safety wiring.
//
// The orchestrator uses this constant when it propagates
// `forceOpenUntil` entries onto the per-window
// `WindowRuntimeState.manualOverrideUntil` field. Re-exporting it from
// this module (rather than hard-coding the string at the call sites)
// keeps the connection between the user-intent reducer and the
// existing safety-layer machinery explicit.
// ---------------------------------------------------------------------------

/**
 * The {@link import('../../shared/state-schema.js').WindowRuntimeState}
 * field that carries per-window pause-from-automation timestamps. The
 * safety layer's manual-override branch consults this exact field, so
 * the user-intent → safety bridge writes here.
 */
export const MANUAL_OVERRIDE_FIELD = 'manualOverrideUntil' as const;

// ---------------------------------------------------------------------------
// Factories / converters.
// ---------------------------------------------------------------------------

/**
 * Build a fresh {@link UserIntent} with no active intents. Used by the
 * orchestrator's first-cycle path and by tests.
 */
export function emptyUserIntent(): UserIntent {
  return {
    paused: false,
    vacation: false,
    pauseUntil: null,
    forceOpenUntil: new Map<string, Date>(),
  };
}

/**
 * Reduce a {@link UserIntent} to its persisted shape
 * ({@link UserIntentState}). `forceOpenUntil` is intentionally
 * dropped — it lives on the per-window
 * `WindowRuntimeState.manualOverrideUntil` field instead.
 */
export function toPersistedUserIntent(intent: UserIntent): UserIntentState {
  return {
    paused: intent.paused,
    pauseUntil: intent.pauseUntil === null ? null : intent.pauseUntil.toISOString(),
    vacation: intent.vacation,
  };
}

/**
 * Inflate a persisted {@link UserIntentState} into the in-memory
 * {@link UserIntent} shape. The `forceOpenUntil` map starts empty —
 * the reducer is the only producer for it, and any prior force-open
 * intent has already been forwarded into the persisted
 * `manualOverrideUntil` field by the orchestrator.
 */
export function fromPersistedUserIntent(persisted: UserIntentState): UserIntent {
  return {
    paused: persisted.paused,
    vacation: persisted.vacation,
    pauseUntil: persisted.pauseUntil === null ? null : new Date(persisted.pauseUntil),
    forceOpenUntil: new Map<string, Date>(),
  };
}

// ---------------------------------------------------------------------------
// Reducer.
// ---------------------------------------------------------------------------

/**
 * Reduce a single user-toggle event onto a {@link UserIntent}. Pure
 * with respect to its inputs.
 *
 * Branches (one per supported switch id):
 *
 *   - `heatshield-control-pause` →
 *       - `requestedValue = true`: set `paused = true`, `pauseUntil =
 *         next-local-midnight(now, location.timezone)`. No effects.
 *       - `requestedValue = false`: clear `paused = false`,
 *         `pauseUntil = null`. No effects.
 *
 *   - `heatshield-control-vacation` →
 *       - flip `vacation` to `requestedValue`. No effects.
 *
 *   - `heatshield-state-active` →
 *       - `requestedValue = false`: populate `forceOpenUntil` with
 *         `now + manualOverrideMinutes * 60_000` for every id in
 *         `allWindowIds`. Emit `effects.forceOpenWindowIds`. The
 *         {@link UserIntent.paused} flag is unaffected — force-open
 *         is per-window only.
 *       - `requestedValue = true`: drop the in-memory force-open
 *         entries (the persisted per-window manualOverrideUntil
 *         remains in effect until it expires naturally — see steering
 *         note in the module header). No `effects.forceOpenWindowIds`.
 *
 *   - `heatshield-state-forecast`, `heatshield-state-night-cooling` →
 *       - intent is unchanged. `effects.reevaluate = true` so the
 *         orchestrator runs a single forced re-evaluation on its next
 *         cycle (see module header for the idempotency rationale).
 */
export function applyUserSwitchToggle(
  intent: UserIntent,
  params: ApplyUserSwitchToggleParams,
): ApplyUserSwitchToggleResult {
  const next: UserIntent = {
    paused: intent.paused,
    vacation: intent.vacation,
    pauseUntil: intent.pauseUntil,
    // Copy by reference baseline; replaced below for branches that
    // produce a new map. We deliberately do NOT mutate the input map
    // — that keeps the reducer pure and makes test assertions on the
    // input intent stable.
    forceOpenUntil: new Map(intent.forceOpenUntil),
  };
  const effects: UserIntentEffects = {
    reevaluate: false,
    forceOpenWindowIds: [],
  };

  switch (params.id) {
    case 'heatshield-control-pause': {
      if (params.requestedValue) {
        next.paused = true;
        next.pauseUntil = nextLocalMidnight(params.now, params.location.timezone);
      } else {
        next.paused = false;
        next.pauseUntil = null;
      }
      return { next, effects };
    }

    case 'heatshield-control-vacation': {
      next.vacation = params.requestedValue;
      return { next, effects };
    }

    case 'heatshield-state-active': {
      if (params.requestedValue === false) {
        // User says "stop, leave them alone" — promote a per-window
        // manual override for every currently auto-shaded window.
        const expiresAt = new Date(
          params.now.getTime() + params.manualOverrideMinutes * 60 * 1000,
        );
        const updated = new Map(next.forceOpenUntil);
        const ids: string[] = [];
        for (const id of params.allWindowIds) {
          updated.set(id, expiresAt);
          ids.push(id);
        }
        next.forceOpenUntil = updated;
        effects.forceOpenWindowIds = ids;
        return { next, effects };
      }
      // requestedValue === true: user reasserted "active". Drop any
      // in-memory force-open entries so the orchestrator does not
      // re-broadcast them on the next cycle. The persisted per-window
      // manualOverrideUntil values keep their natural expiry.
      next.forceOpenUntil = new Map<string, Date>();
      return { next, effects };
    }

    case 'heatshield-state-forecast':
    case 'heatshield-state-night-cooling': {
      // Idempotent: no state change, just request one forced
      // re-evaluation on the next cycle.
      effects.reevaluate = true;
      return { next, effects };
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers.
// ---------------------------------------------------------------------------

/**
 * Compute the UTC instant of the next local midnight following `now`
 * in the given IANA timezone. Wraps `engine/sun.ts::dayBoundsLocal`
 * which already implements the DST-aware math.
 *
 * Edge case: `now` happens to land *exactly* on local midnight. In
 * that case `dayBoundsLocal(now, tz).endUtc` returns the *next* local
 * midnight (24h later) by construction, which is the behaviour we
 * want — a pause engaged at 00:00 should not auto-clear immediately.
 */
function nextLocalMidnight(now: Date, timezone: string): Date {
  return dayBoundsLocal(now, timezone).endUtc;
}
