/**
 * Heat Shield — runtime state schema (Task 3.2).
 *
 * The runtime state lives at `/data/state.json`. It is the engine's
 * **persistent memory between restarts** and is intentionally separate
 * from `schema.ts` (which validates user-edited config) for two reasons:
 *
 *   1. State is not user-facing. The wizard never edits it; it is written
 *      exclusively by the engine. Mixing it into the config schema would
 *      blur the boundary and tempt callers to round-trip live engine
 *      memory through the dashboard PUT `/api/config` endpoint.
 *   2. State is rebuildable. If `/data/state.json` is deleted or corrupt,
 *      the next cycle will regenerate it from observed device state plus
 *      a fresh `manualOverrideUntil = null` per window. We therefore
 *      treat state corruption as "lose memory" rather than "fail open" —
 *      see `readState` in `src/plugin/persistence/state.ts`.
 *
 * Field naming follows the same English-identifier convention as
 * `schema.ts`. Timestamps are ISO-8601 strings (UTC) — the engine
 * produces them via `new Date().toISOString()`.
 */

import { z } from 'zod';

import type { Mode } from './types.js';

// ---------------------------------------------------------------------------
// ModeSchema — runtime FSM mode discriminator.
// Source of truth for the literal union is `Mode` in `./types.js`. The
// `satisfies z.ZodType<Mode>` clause makes TypeScript reject any divergence
// where this enum gains a value `Mode` does not have. Removing a value
// here is caught at runtime by the persistence-state tests.
// ---------------------------------------------------------------------------

export const ModeSchema = z.enum([
  'NORMAL',
  'SUMMER_WATCH',
  'ACTIVE_HEAT_PROTECTION',
  'HEATWAVE',
  'NIGHT_COOLING',
  'STORM',
  'VACATION',
  'MAINTENANCE',
]) satisfies z.ZodType<Mode>;

/**
 * ISO-8601 timestamp as produced by `Date.prototype.toISOString()`. We
 * accept only the UTC-`Z` form — every writer in the codebase emits it.
 */
const IsoTimestampSchema = z.iso.datetime();

// ---------------------------------------------------------------------------
// Per-window shading FSM runtime (smart-shading-notifications Task 3.2).
// Mirrors `WindowShadeRuntime` in `engine/shadingState.ts`. Kept here as the
// persistence source of truth; the engine module owns the transition logic.
// ---------------------------------------------------------------------------

export const ShadeRuntimeSchema = z.object({
  state: z.enum(['open', 'shaded']),
  shadedSince: IsoTimestampSchema.nullable(),
  belowReleaseSince: IsoTimestampSchema.nullable(),
});

// ---------------------------------------------------------------------------
// Per-window runtime state.
// ---------------------------------------------------------------------------

/**
 * Per-window memory the engine carries across restarts.
 *
 *   - `lastCommandedLevel01` mirrors the last shutter level the engine
 *     told the HCU to drive towards, in the Connect API range `[0..1]`
 *     (1 = fully closed). It is `null` until the engine has issued at
 *     least one move for this window.
 *   - `lastCommandedAt` is the ISO timestamp of that command. Together
 *     with `lastCommandedLevel01` it powers the manual-override
 *     detection in `connect/hmipSystem.ts`: if a `HMIP_SYSTEM_EVENT`
 *     reports a level outside snap tolerance from
 *     `lastCommandedLevel01` AND arrives more than 30 s after
 *     `lastCommandedAt`, the engine considers the move manual.
 *   - `manualOverrideUntil` pauses automation for this window until the
 *     given timestamp (set when manual operation is detected, or when
 *     the user toggles `heatshield-state-active` off — see Requirement
 *     7.4 / 3.4).
 *   - `lastDecisionMode` is the mode the engine was in the last time it
 *     produced a decision for this window. It is purely diagnostic and
 *     is surfaced in the dashboard's per-window card.
 */
export const WindowRuntimeStateSchema = z.object({
  windowId: z.string().min(1),
  lastCommandedLevel01: z.number().min(0).max(1).nullable(),
  lastCommandedAt: IsoTimestampSchema.nullable(),
  manualOverrideUntil: IsoTimestampSchema.nullable(),
  lastDecisionMode: ModeSchema.nullable(),
  // Per-window shading FSM memory (smart-shading-notifications Task 3.2).
  // Optional on disk for forward-compatibility with pre-feature state
  // files: a missing entry loads as a fresh `open` runtime, so existing
  // deployments need no schema-version bump.
  shade: ShadeRuntimeSchema.default({
    state: 'open',
    shadedSince: null,
    belowReleaseSince: null,
  }),
});

// ---------------------------------------------------------------------------
// Own-switch runtime state.
// ---------------------------------------------------------------------------

/**
 * Stable ids of the five plugin-owned SWITCH devices (design.md
 * §Connect-API-Integration / Eigene Geräte). Listing them as a closed
 * `z.enum` is what enforces the steering rule "STATUS_EVENT only on
 * effective change for our own devices" at the schema boundary — the
 * Connect layer cannot accidentally cache a state for a switch id we do
 * not actually expose.
 */
export const OwnSwitchIdSchema = z.enum([
  'heatshield-state-active',
  'heatshield-state-forecast',
  'heatshield-state-night-cooling',
  'heatshield-control-pause',
  'heatshield-control-vacation',
]);

/**
 * Cached state of one of the five plugin-owned SWITCH devices.
 *
 *   - `value` is the boolean SwitchState we last surfaced to the HCU.
 *   - `engineConfirmed` is `true` iff `value` reflects an
 *     engine-bestätigtem Zustand. It is the gate for the steering rule
 *     "send STATUS_EVENT only on effective change": the Connect layer
 *     only emits STATUS_EVENT when the *engine-confirmed* value
 *     transitions, never on optimistic UI writes.
 *   - `updatedAt` is the timestamp of the last write to this row,
 *     regardless of whether it was engine-confirmed.
 */
export const OwnSwitchStateSchema = z.object({
  id: OwnSwitchIdSchema,
  value: z.boolean(),
  engineConfirmed: z.boolean(),
  updatedAt: IsoTimestampSchema,
});

// ---------------------------------------------------------------------------
// User-intent (Task 9.1).
// ---------------------------------------------------------------------------

/**
 * Persisted shape of the user's high-level intent toggles, as derived
 * from `CONTROL_REQUEST` events on the two plugin-owned control
 * switches:
 *
 *   - `paused` mirrors `heatshield-control-pause`. While `true` and
 *     `pauseUntil` is in the future, the orchestrator suppresses every
 *     `setShutterLevel` call (storm safety still fires — see
 *     `engine/safety.ts`).
 *   - `pauseUntil` is the wall-clock at which the pause expires
 *     automatically. The reducer sets it to the **next local
 *     midnight** when pause is engaged, so a user toggle "right now"
 *     does not leave the engine paused for a full 24 h after the
 *     plugin is restarted in a different timezone session.
 *   - `vacation` mirrors `heatshield-control-vacation`. While `true`,
 *     each room's `target_c` / `warning_c` / `strong_shade_c` are
 *     shifted down by `rules.comfort.vacationOffsetC`. `critical_c`
 *     remains the absolute hard ceiling.
 *
 * `forceOpenUntil` is *not* part of the persisted shape — per-window
 * "force open" intent is folded into the existing
 * {@link WindowRuntimeStateSchema.manualOverrideUntil} machinery so
 * the safety layer's existing manual-override branch does the
 * suppression. See `engine/userIntent.ts`.
 */
export const UserIntentStateSchema = z.object({
  paused: z.boolean(),
  pauseUntil: IsoTimestampSchema.nullable(),
  vacation: z.boolean(),
});

// ---------------------------------------------------------------------------
// Top-level runtime state.
// ---------------------------------------------------------------------------

/**
 * Top-level shape of `/data/state.json`.
 *
 *   - `schemaVersion` is a `z.literal(1)` so a future state migration can
 *     pivot on it. State is rebuildable, so the migration story is much
 *     simpler than for `config.ts`: an unknown version just causes
 *     `readState` to discard the file and start clean.
 *   - `currentMode` is the FSM mode the engine ended its last cycle in.
 *   - `lastCycleAt` is the timestamp of that cycle.
 *   - `windows` carries per-window memory; entries are added when the
 *     orchestrator first sees a window via `createWindowRuntimeState`.
 *   - `ownSwitches` is enforced to length 5 — one row per
 *     `OwnSwitchIdSchema` member. Tests check the `.length(5)` boundary.
 *   - `stormHoldUntil` powers the Requirement 7.3 release-hold timing:
 *     "wind 10 min unter `storm_release_threshold`". The engine sets
 *     this to `now + releaseHoldMin` once wind crosses below the
 *     release threshold, and only releases the storm hold after the
 *     wall clock is past it.
 *   - `userIntent` is the persisted high-level pause/vacation intent
 *     derived from the two `heatshield-control-*` switches (Task 9.1).
 *     The field is optional on disk for forward-compatibility with
 *     pre-Task-9.1 state files: a missing entry is filled in with the
 *     "no intent" default so existing deployments load cleanly without
 *     a schema-version bump.
 */
export const RuntimeStateSchema = z.object({
  schemaVersion: z.literal(1),
  currentMode: ModeSchema.nullable(),
  lastCycleAt: IsoTimestampSchema.nullable(),
  windows: z.array(WindowRuntimeStateSchema),
  ownSwitches: z.array(OwnSwitchStateSchema).length(5),
  stormHoldUntil: IsoTimestampSchema.nullable(),
  userIntent: UserIntentStateSchema.default({
    paused: false,
    pauseUntil: null,
    vacation: false,
  }),
  /**
   * Highest average indoor temperature observed during the current local day
   * (the "Peak heute" KPI). Optional on disk for forward-compatibility; a
   * missing entry simply re-seeds from the first reading after restart.
   */
  indoorPeak: z
    .object({ day: z.string().min(1), peakC: z.number() })
    .nullable()
    .default(null),
});

// ---------------------------------------------------------------------------
// Inferred types and parse helpers.
// ---------------------------------------------------------------------------

export type WindowRuntimeState = z.infer<typeof WindowRuntimeStateSchema>;
export type ShadeRuntime = z.infer<typeof ShadeRuntimeSchema>;
export type OwnSwitchId = z.infer<typeof OwnSwitchIdSchema>;
export type OwnSwitchState = z.infer<typeof OwnSwitchStateSchema>;
export type UserIntentState = z.infer<typeof UserIntentStateSchema>;
export type RuntimeState = z.infer<typeof RuntimeStateSchema>;

/**
 * Parse an unknown value as a `RuntimeState`, throwing a `ZodError` on
 * failure. Persistence calls this from `readState` and `writeState` so
 * the file boundary is always validated.
 */
export function parseState(input: unknown): RuntimeState {
  return RuntimeStateSchema.parse(input);
}

/**
 * Non-throwing variant of {@link parseState}. Useful in `readState`
 * where a schema-invalid file is *expected* to be discarded rather than
 * to propagate an exception.
 */
export function safeParseState(
  input: unknown,
): z.ZodSafeParseResult<RuntimeState> {
  return RuntimeStateSchema.safeParse(input);
}
