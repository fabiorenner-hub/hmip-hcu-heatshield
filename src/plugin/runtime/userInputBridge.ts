/**
 * Heat Shield — user-input bridge (Tasks 9.2 + 9.3).
 *
 * Wires the {@link OwnDeviceManager}'s `'userInput'` event into the
 * pure {@link applyUserSwitchToggle} reducer (Task 9.1) and
 * persists the resulting {@link UserIntent} + per-window
 * `manualOverrideUntil` mutations onto the runtime state.
 *
 * The bridge sits between two surfaces that intentionally do not
 * know about each other:
 *
 *   - {@link OwnDeviceManager} owns the in-memory `SwitchState`
 *     cache for the five plugin-owned SWITCH devices and emits
 *     `'userInput'` whenever the HCU forwards a CONTROL_REQUEST
 *     for one of them. It also exposes
 *     {@link OwnDeviceManager.confirmFromEngine}, which is the
 *     single chokepoint for the steering rule "STATUS_EVENT only on
 *     effective change".
 *   - {@link applyUserSwitchToggle} is a pure reducer — it has no
 *     fs, no Connect API plumbing, no globals.
 *
 * This module is the boot-time glue:
 *
 *   1. Subscribe to `ownDevices.on('userInput', ...)`.
 *   2. On each event:
 *        a. read the persisted {@link RuntimeState} (or fall back
 *           to `emptyState()` on first cycle),
 *        b. inflate `userIntent` via
 *           {@link fromPersistedUserIntent},
 *        c. run {@link applyUserSwitchToggle} with the boot-supplied
 *           `now` / `manualOverrideMinutes` / `location` / window
 *           list,
 *        d. persist the new intent ({@link toPersistedUserIntent})
 *           and propagate every entry from
 *           `result.effects.forceOpenWindowIds` onto the matching
 *           `state.windows[*].manualOverrideUntil` (creating a fresh
 *           {@link WindowRuntimeState} via
 *           {@link createWindowRuntimeState} if the window has no
 *           runtime row yet),
 *        e. call `ownDevices.confirmFromEngine(id, effectiveValue)`
 *           so a STATUS_EVENT is emitted **only** when the
 *           engine-confirmed value actually changes (steering:
 *           `hmip-connect-api.md` §"STATUS_EVENT semantics"). The
 *           effective-value rules are spelled out at the call
 *           site below.
 *
 * The listener wraps the whole pipeline in a try/catch: a single
 * malformed user toggle (e.g. a `writeState` rejection) must NOT
 * silently break the subscription. Failures are forwarded to the
 * optional {@link UserInputBridgeDeps.logger} and the bridge keeps
 * running.
 *
 * ─── Steering compliance ──────────────────────────────────────────
 *
 *   - `heatshield-state-active` is a status switch. The engine
 *     reasserts ownership of it on the next cycle. When the user
 *     forces it `false` we promote per-window manual overrides AND
 *     immediately confirm the new value back to the HCU so the
 *     iOS app sees `false` until the override expires.
 *   - `heatshield-state-forecast` and
 *     `heatshield-state-night-cooling` are read-only signals from
 *     the engine's perspective. We deliberately do NOT call
 *     `confirmFromEngine` for those here; the orchestrator
 *     idempotently re-confirms them on its next cycle. The bridge
 *     simply requests one re-evaluation via {@link onReevaluate}.
 *
 * Module rules (mirrored from sibling modules):
 *   - Strict TS, ESM, `.js` import suffixes.
 *   - Self-contained — unit-testable without a running ConnectClient.
 *   - The bridge module never instantiates the Connect transport;
 *     wiring with a live `OwnDeviceManager` happens in the boot
 *     module (Task 15 / 10.1).
 */

import { createWindowRuntimeState } from '../persistence/state.js';
import {
  applyUserSwitchToggle,
  fromPersistedUserIntent,
  toPersistedUserIntent,
  type UserIntent,
} from '../engine/userIntent.js';
import type {
  Location,
  OwnSwitchId,
  RuntimeState,
  WindowRuntimeState,
} from '../../shared/types.js';
import type { OwnDeviceManager, OwnDeviceUserInput } from '../connect/ownDevices.js';
import type { ConnectLogger } from '../connect/client.js';

// ---------------------------------------------------------------------------
// Public types.
// ---------------------------------------------------------------------------

/**
 * Dependency bag for {@link UserInputBridge}.
 *
 *   - `ownDevices` — the live {@link OwnDeviceManager}. The bridge
 *     subscribes to its `'userInput'` event and calls
 *     `confirmFromEngine` on it. Tests pass a tiny fake (see
 *     `tests/unit/runtime-userInputBridge.test.ts`).
 *   - `readState` / `writeState` / `emptyState` — pluggable
 *     persistence. Production wires these to
 *     `persistence/state.ts::{readState, writeState,
 *     emptyRuntimeState}`; tests use an in-memory implementation.
 *   - `manualOverrideMinutes` — pulled from
 *     `Config.rules.manualOverrideMinutes`. The reducer multiplies
 *     by 60_000 to derive the per-window `manualOverrideUntil`.
 *   - `location` — only the IANA `timezone` is required; we accept
 *     a `Pick<Location, 'timezone'>` so the boot module can pass
 *     `config.location` directly without a narrowing step.
 *   - `now` — opt-in deterministic clock for tests. Defaults to
 *     `() => new Date()`.
 *   - `logger` — opt-in structured logger; absent by default so
 *     unit tests stay silent.
 *   - `onReevaluate` — opt-in hook the bridge calls when the
 *     reducer requests a forced re-evaluation
 *     (`heatshield-state-forecast` /
 *     `heatshield-state-night-cooling` toggles). The orchestrator
 *     wires this to its scheduler so the next cycle runs ASAP.
 */
export interface UserInputBridgeDeps {
  readonly ownDevices: OwnDeviceManager;
  readonly readState: () => Promise<RuntimeState | null>;
  readonly writeState: (state: RuntimeState) => Promise<void>;
  readonly emptyState: () => RuntimeState;
  readonly manualOverrideMinutes: number;
  readonly location: Pick<Location, 'timezone'>;
  readonly now?: () => Date;
  readonly logger?: ConnectLogger;
  readonly onReevaluate?: () => void;
  /**
   * Master automation toggle from the `heatshield-control-automation` HCU
   * switch. Maps to `config.automationEnabled` (config lives outside the
   * runtime state, so the orchestrator supplies this setter). The orchestrator
   * reasserts the switch value from the config each cycle.
   */
  readonly onSetAutomation?: (on: boolean) => void;
}

// ---------------------------------------------------------------------------
// Bridge.
// ---------------------------------------------------------------------------

/**
 * Glue between {@link OwnDeviceManager}'s user-input events and the
 * pure {@link applyUserSwitchToggle} reducer. See module header for
 * the high-level flow and steering rationale.
 */
export class UserInputBridge {
  private readonly deps: UserInputBridgeDeps;
  private readonly listener: (input: OwnDeviceUserInput) => void;
  private stopped: boolean = false;

  public constructor(deps: UserInputBridgeDeps) {
    this.deps = deps;
    // Capture the bound listener so {@link stop} can pass the same
    // reference to `removeListener` and successfully detach.
    this.listener = (input: OwnDeviceUserInput): void => {
      // The listener returns a promise; the emitter does not await
      // it, but our try/catch wraps the whole body so an unhandled
      // rejection cannot silently break the subscription. We also
      // forward errors through the optional logger.
      void this.handle(input).catch((err: unknown) => {
        this.log('error', 'userInput bridge crashed', {
          deviceId: input.deviceId,
          err: err instanceof Error ? err.message : String(err),
        });
      });
    };
    deps.ownDevices.on('userInput', this.listener);
  }

  /**
   * Detach the `'userInput'` listener. Idempotent — a second call
   * is a no-op so callers can drop the bridge without bookkeeping.
   */
  public stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.deps.ownDevices.removeListener('userInput', this.listener);
  }

  // -------------------------------------------------------------------------
  // Internals.
  // -------------------------------------------------------------------------

  /**
   * Process one inbound user-toggle event. Wrapped in try/catch by
   * the listener stub so a malformed event does not unsubscribe the
   * bridge.
   */
  private async handle(input: OwnDeviceUserInput): Promise<void> {
    try {
      // Master automation switch maps to config, not runtime state. Handle it
      // separately: flip the config via the injected setter and confirm the
      // switch value straight back so the HmIP app reflects the toggle.
      if (input.deviceId === 'heatshield-control-automation') {
        this.deps.onSetAutomation?.(input.requestedValue);
        try {
          this.deps.ownDevices.confirmFromEngine('heatshield-control-automation', input.requestedValue);
        } catch (err) {
          this.log('warn', 'confirmFromEngine threw', { deviceId: input.deviceId, err: err instanceof Error ? err.message : String(err) });
        }
        this.deps.onReevaluate?.();
        return;
      }
      const now = this.now();

      // 1. Snapshot persisted state (or fall back to a fresh empty
      //    state so the bridge works on a freshly provisioned
      //    container with no `state.json` yet).
      const baseline = (await this.deps.readState()) ?? this.deps.emptyState();
      // Defensive shallow clone of the parts we mutate. The reducer
      // is pure, but persistence happens via writeState below and we
      // do not want to leave the in-memory baseline in a partly
      // mutated state if the write rejects.
      const state: RuntimeState = {
        ...baseline,
        windows: baseline.windows.map((w) => ({ ...w })),
        ownSwitches: baseline.ownSwitches.map((s) => ({ ...s })),
      };

      // 2. Inflate persisted UserIntent → in-memory shape.
      const intent: UserIntent = fromPersistedUserIntent(state.userIntent);

      // 3. Run the reducer. `allWindowIds` is sourced from the
      //    persisted `state.windows[*]`; that mirrors the
      //    orchestrator's view of "what windows currently exist".
      const allWindowIds = state.windows.map((w) => w.windowId);
      const result = applyUserSwitchToggle(intent, {
        id: input.deviceId,
        requestedValue: input.requestedValue,
        now,
        manualOverrideMinutes: this.deps.manualOverrideMinutes,
        allWindowIds,
        location: this.deps.location,
      });

      // 4a. Persist the new high-level intent.
      state.userIntent = toPersistedUserIntent(result.next);

      // 4b. Propagate per-window force-open onto
      //     `manualOverrideUntil`. Create a fresh runtime row when
      //     the window has not been seen yet.
      for (const windowId of result.effects.forceOpenWindowIds) {
        const overrideUntil = result.next.forceOpenUntil.get(windowId);
        if (overrideUntil === undefined) {
          // Should not happen — the reducer populates the map for
          // every id in forceOpenWindowIds. Defensive skip.
          continue;
        }
        const iso = overrideUntil.toISOString();
        const existing = state.windows.find((w) => w.windowId === windowId);
        if (existing !== undefined) {
          existing.manualOverrideUntil = iso;
          continue;
        }
        const fresh: WindowRuntimeState = createWindowRuntimeState(windowId);
        fresh.manualOverrideUntil = iso;
        state.windows.push(fresh);
      }

      // 4c. Persist the mutated state. Failures here propagate to
      //     the outer try/catch (logged, but do not unsubscribe).
      await this.deps.writeState(state);

      // 5. Reflect the engine-confirmed effective value back onto
      //    the OwnDeviceManager. The manager's `confirmFromEngine`
      //    is the steering-mandated chokepoint for STATUS_EVENT
      //    emission: it only fires when the previously confirmed
      //    value diverges from the new value.
      this.confirmEffectiveValue(input.deviceId, result.effects.forceOpenWindowIds.length, result.next);

      // 6. Status switches forecast / night-cooling are reasserted
      //    on the next cycle by the orchestrator. We just request a
      //    forced re-evaluation when the reducer asked for one.
      if (result.effects.reevaluate) {
        this.deps.onReevaluate?.();
      }
    } catch (err) {
      // Logger-only — never re-throw. The listener stub already
      // wraps us in a `.catch`, but logging here gives finer
      // context (which deviceId failed).
      this.log('warn', 'userInput bridge step failed', {
        deviceId: input.deviceId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Translate the reducer outcome into the engine-confirmed value
   * for `id` and forward to {@link OwnDeviceManager.confirmFromEngine}.
   *
   * Effective-value rules (from the task brief):
   *
   *   - `heatshield-control-pause` → `next.paused`.
   *   - `heatshield-control-vacation` → `next.vacation`.
   *   - `heatshield-state-active` → `false` while at least one
   *     forceOpen entry exists (i.e. the user just toggled to
   *     `false`), `true` otherwise (engine reasserts ownership).
   *   - `heatshield-state-forecast` /
   *     `heatshield-state-night-cooling` — NOT confirmed here. The
   *     orchestrator's next cycle will reassert via its own
   *     `confirmFromEngine` calls; we just request a re-evaluation
   *     in the caller.
   *
   * Wrapping `confirmFromEngine` in a try/catch is intentional:
   * even though the manager's implementation does not throw, a
   * future change must not silently desync the cache.
   */
  private confirmEffectiveValue(
    id: OwnSwitchId,
    forceOpenCount: number,
    next: UserIntent,
  ): void {
    let effective: boolean;
    switch (id) {
      case 'heatshield-control-pause':
        effective = next.paused;
        break;
      case 'heatshield-control-vacation':
        effective = next.vacation;
        break;
      case 'heatshield-state-active':
        // The engine reasserts ownership: while a force-open is in
        // flight we surface `false`; otherwise we surface `true`.
        effective = forceOpenCount === 0;
        break;
      case 'heatshield-state-forecast':
      case 'heatshield-state-night-cooling':
        // Not driven by the bridge; orchestrator owns these.
        return;
      case 'heatshield-control-automation':
        // Handled early in `handle` (maps to config, not runtime intent).
        return;
    }
    try {
      this.deps.ownDevices.confirmFromEngine(id, effective);
    } catch (err) {
      this.log('warn', 'confirmFromEngine threw', {
        deviceId: id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private log(
    level: 'info' | 'warn' | 'error',
    msg: string,
    ctx?: Record<string, unknown>,
  ): void {
    const logger = this.deps.logger;
    if (logger === undefined) {
      return;
    }
    try {
      logger(level, msg, ctx);
    } catch {
      // Logger errors must not break the bridge.
    }
  }
}
