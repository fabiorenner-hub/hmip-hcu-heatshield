/**
 * Heat Shield — Own-device SwitchState manager (Task 6.4).
 *
 * The plugin owns five virtual SWITCH devices (the three
 * `heatshield-state-*` read-only signals and the two
 * `heatshield-control-*` user toggles, see design.md §"Eigene
 * Geräte"). This module is the in-memory bookkeeper for those
 * devices: it caches the engine-confirmed `SwitchState` per id,
 * accepts `CONTROL_REQUEST` envelopes from the HCU as **user
 * inputs** (which the engine then evaluates), and emits a
 * `STATUS_EVENT` envelope **only when the engine-confirmed value
 * actually changes**.
 *
 * ─── Steering compliance (`hmip-connect-api.md`) ───────────────────
 *
 *   - STATUS_EVENT is emitted **only** for plugin-OWNED switches.
 *     Native HCU `WINDOW_COVERING` devices are never touched here.
 *   - STATUS_EVENT is emitted **only on effective change**: a
 *     `confirmFromEngine` call that re-asserts the previously
 *     confirmed value emits nothing.
 *   - Optimistic emission on inbound `CONTROL_REQUEST` is
 *     deliberately disabled. The eq3 example plugins ack a
 *     CONTROL_REQUEST with a `CONTROL_RESPONSE { success: true }`
 *     and do *not* echo a STATUS_EVENT for that flow until the
 *     engine produces a definitive value (`confirmFromEngine`). The
 *     iOS app derives the new state from the CONTROL_RESPONSE; an
 *     extra STATUS_EVENT at this point can confuse it into a
 *     "still moving" UI.
 *
 * ─── Design choices ────────────────────────────────────────────────
 *
 *   - The manager extends {@link EventEmitter} (typed event map),
 *     mirroring `FusionSolarAdapter` and `ConnectClient`. Tests can
 *     therefore subscribe to `'statusEvent'` / `'controlResponse'`
 *     and capture the exact envelope the client would send, with
 *     no real WebSocket in the loop.
 *   - `confirmFromEngine` is the single chokepoint that enforces
 *     "effective change only": it compares the **previous
 *     engine-confirmed value** (not the cached `value`, which may
 *     reflect an unconfirmed user input) against the new value and
 *     emits at most one envelope.
 *   - `handleControlRequest` is intentionally permissive: a
 *     malformed body or an unknown `deviceId` produces an error
 *     `CONTROL_RESPONSE`, and a request without a `switchState`
 *     feature still echoes `success: true` (we accept the input
 *     even if there is no relevant feature to apply — the user
 *     might be probing the device, and the spec lets us accept any
 *     well-formed request).
 *   - The manager carries no Connect transport. Envelopes are
 *     emitted via `'statusEvent'` / `'controlResponse'`; the
 *     orchestrator wires those events to `ConnectClient.send`. This
 *     keeps unit tests fully offline.
 */

import { EventEmitter } from 'node:events';

import { OwnSwitchIdSchema } from '../../shared/state-schema.js';
import type { OwnSwitchId, OwnSwitchState } from '../../shared/types.js';

import type { ConnectEnvelope } from './client.js';
import type { OwnDeviceFeature, SwitchStateFeature } from './discover.js';
import { PluginMessageType, buildEnvelope, buildReply } from './envelope.js';

// ---------------------------------------------------------------------------
// Public types.
// ---------------------------------------------------------------------------

/**
 * Payload delivered to `'userInput'` listeners. The engine subscribes
 * to this event and runs its mapping logic (Task 9):
 *
 *   - `deviceId` — one of the five {@link OwnSwitchId} values.
 *   - `requestedValue` — the boolean the user toggled to in the HmIP
 *     app. Always different from the previously engine-confirmed
 *     value (the manager filters out no-op toggles before emitting).
 *   - `rawRequest` — the full inbound envelope, retained so the
 *     engine has access to the request id and can correlate a
 *     follow-up `confirmFromEngine` call back to the originating
 *     CONTROL_REQUEST if it cares to.
 */
export interface OwnDeviceUserInput {
  readonly deviceId: OwnSwitchId;
  readonly requestedValue: boolean;
  readonly rawRequest: ConnectEnvelope;
}

/**
 * Options for {@link OwnDeviceManager}. `pluginId` is required so
 * STATUS_EVENT envelopes carry the correct issuer; `now` and
 * `logger` are optional injections used by tests (deterministic
 * clock, silent logger).
 */
export interface OwnDeviceManagerOptions {
  readonly pluginId: string;
  readonly now?: () => Date;
  readonly logger?: (
    level: 'info' | 'warn' | 'error',
    msg: string,
    ctx?: Record<string, unknown>,
  ) => void;
}

/**
 * Typed event map. Listeners receive precise payload tuples — no
 * `unknown[]` tail.
 */
type OwnDeviceManagerEvents = {
  /**
   * A user toggled one of our switches in the HmIP app and the
   * requested value differs from the engine-confirmed cache.
   */
  userInput: [input: OwnDeviceUserInput];
  /**
   * The manager built a `STATUS_EVENT` envelope (engine-confirmed
   * change). The orchestrator forwards it to `ConnectClient.send`.
   */
  statusEvent: [envelope: ConnectEnvelope];
  /**
   * The manager built a `CONTROL_RESPONSE` envelope for an inbound
   * `CONTROL_REQUEST`. The orchestrator forwards it to the client.
   */
  controlResponse: [envelope: ConnectEnvelope];
};

// ---------------------------------------------------------------------------
// Internal helpers.
// ---------------------------------------------------------------------------

/**
 * Closed set of valid own-switch ids, derived from the schema so a
 * future addition to `OwnSwitchIdSchema.options` is automatically
 * accepted here.
 */
const KNOWN_IDS: ReadonlySet<string> = new Set(OwnSwitchIdSchema.options);

/**
 * Type guard for a candidate id string. Narrows to {@link OwnSwitchId}.
 */
function isOwnSwitchId(value: unknown): value is OwnSwitchId {
  return typeof value === 'string' && KNOWN_IDS.has(value);
}

/**
 * Locate the `switchState` feature in a feature array. Returns
 * `undefined` if absent.
 */
function findSwitchState(
  features: ReadonlyArray<unknown>,
): SwitchStateFeature | undefined {
  for (const f of features) {
    if (
      typeof f === 'object' &&
      f !== null &&
      (f as { type?: unknown }).type === 'switchState'
    ) {
      const candidate = f as { type: 'switchState'; on?: unknown };
      if (typeof candidate.on === 'boolean') {
        return { type: 'switchState', on: candidate.on };
      }
      // Feature is present but `on` is missing/wrong type: treat as
      // a feature without a meaningful boolean — caller decides what
      // to do (we currently treat this as "no SwitchState input").
      return { type: 'switchState' };
    }
  }
  return undefined;
}

/**
 * Shape check for an inbound `CONTROL_REQUEST` body. Returns the
 * narrowed `{ deviceId, features }` tuple on success, `null` on
 * failure. Both fields must be present and of the right shape; we
 * do not coerce.
 */
function parseControlRequestBody(
  body: unknown,
): { deviceId: unknown; features: ReadonlyArray<unknown> } | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const obj = body as Record<string, unknown>;
  const deviceId = obj['deviceId'];
  const features = obj['features'];
  if (deviceId === undefined || !Array.isArray(features)) {
    return null;
  }
  return { deviceId, features };
}

// ---------------------------------------------------------------------------
// Manager.
// ---------------------------------------------------------------------------

/**
 * Owns the in-memory `SwitchState` cache for the five plugin SWITCH
 * devices. Pure logic — no I/O, no transport. See module header for
 * the steering rationale.
 */
export class OwnDeviceManager extends EventEmitter<OwnDeviceManagerEvents> {
  private readonly pluginId: string;
  private readonly now: () => Date;
  private readonly logger:
    | ((
        level: 'info' | 'warn' | 'error',
        msg: string,
        ctx?: Record<string, unknown>,
      ) => void)
    | null;

  /**
   * Cache of own-switch state, keyed by id. The cache is the single
   * source of truth for "what value did we last surface". The
   * `engineConfirmed` flag distinguishes "user clicked, engine
   * hasn't reacted yet" from "engine has applied its decision".
   */
  private readonly cache: Map<OwnSwitchId, OwnSwitchState> = new Map();

  /**
   * Last value the engine actually confirmed for each id, kept
   * **separately** from {@link cache} so a `markUnconfirmed` call
   * (triggered by a user CONTROL_REQUEST) cannot disturb the
   * baseline against which {@link confirmFromEngine} compares.
   *
   * Without this map a sequence like
   *
   *   loadCache({ value: false, engineConfirmed: true })
   *   handleControlRequest(on: true)         // cache becomes value=true, engineConfirmed=false
   *   confirmFromEngine(false)               // engine declines the toggle
   *
   * would erroneously emit a STATUS_EVENT: the cache row's
   * `engineConfirmed` flag is `false` after the user input, so the
   * comparison would have nothing to compare against. With this
   * map, the previously-confirmed `false` is preserved across the
   * unconfirmed user input, and the engine's "stay false" decision
   * is correctly recognised as a no-op (steering rule).
   */
  private readonly lastEngineConfirmedValue: Map<OwnSwitchId, boolean> =
    new Map();

  public constructor(options: OwnDeviceManagerOptions) {
    super();
    this.pluginId = options.pluginId;
    this.now = options.now ?? ((): Date => new Date());
    this.logger = options.logger ?? null;
  }

  // -------------------------------------------------------------------------
  // Cache lifecycle.
  // -------------------------------------------------------------------------

  /**
   * Replace the internal cache with `switchStates`. Called once at
   * startup with the persisted state, and again after every cycle
   * so fresh state from `state.json` reaches the manager.
   *
   * Does **not** emit any events: this is a load, not an
   * engine-confirmed transition. The caller is responsible for
   * driving any STATUS_EVENT it wants from the loaded baseline via
   * subsequent `confirmFromEngine` calls.
   *
   * Seeds {@link lastEngineConfirmedValue} from each row whose
   * `engineConfirmed` is `true`, so the very first
   * `confirmFromEngine` call after a load can correctly compare
   * against the persisted baseline.
   */
  public loadCache(switchStates: ReadonlyArray<OwnSwitchState>): void {
    this.cache.clear();
    this.lastEngineConfirmedValue.clear();
    for (const state of switchStates) {
      this.cache.set(state.id, { ...state });
      if (state.engineConfirmed) {
        this.lastEngineConfirmedValue.set(state.id, state.value);
      }
    }
  }

  /**
   * Return a snapshot of the current cache, in
   * `OwnSwitchIdSchema.options` order so the discover/persistence
   * layers see a stable shape regardless of insertion order.
   * Entries that are not yet cached are skipped.
   */
  public getCache(): ReadonlyArray<OwnSwitchState> {
    const out: OwnSwitchState[] = [];
    for (const id of OwnSwitchIdSchema.options) {
      const state = this.cache.get(id);
      if (state !== undefined) {
        out.push({ ...state });
      }
    }
    return out;
  }

  /**
   * Look up a single cached entry by id. Returns `undefined` if the
   * cache has not been populated for this id yet.
   */
  public getSwitch(id: OwnSwitchId): OwnSwitchState | undefined {
    const state = this.cache.get(id);
    return state === undefined ? undefined : { ...state };
  }

  // -------------------------------------------------------------------------
  // Engine entry points.
  // -------------------------------------------------------------------------

  /**
   * Engine signals that its decision is final for `id`. The cache is
   * updated with `value`, `engineConfirmed: true`, and a fresh
   * `updatedAt` timestamp. A `STATUS_EVENT` envelope is emitted via
   * `'statusEvent'` **iff** the new value differs from the previous
   * engine-confirmed value (steering: only on effective change).
   *
   * The comparison is against {@link lastEngineConfirmedValue}, **not**
   * the cached `value`. The cache may carry an unconfirmed user
   * input (set by {@link markUnconfirmed} / a prior CONTROL_REQUEST)
   * that has not been ratified by the engine; using the cache
   * directly would make the engine's "decline this toggle" decision
   * look like a transition.
   *
   * Cases:
   *
   *   - First-ever confirmation (no prior engine-confirmed value
   *     for this id): emits, because the HCU has never been told
   *     anything by us.
   *   - Re-confirming the same already-confirmed value: cache is
   *     refreshed (timestamp moves) but no event is emitted.
   *   - Confirming a different value than was previously confirmed:
   *     a single STATUS_EVENT is emitted.
   */
  public confirmFromEngine(id: OwnSwitchId, value: boolean): void {
    const previousEngineValue = this.lastEngineConfirmedValue.has(id)
      ? this.lastEngineConfirmedValue.get(id) ?? null
      : null;

    const updatedAt = this.now().toISOString();
    this.cache.set(id, {
      id,
      value,
      engineConfirmed: true,
      updatedAt,
    });
    this.lastEngineConfirmedValue.set(id, value);

    // Effective change rule: emit only if the engine-confirmed value
    // actually transitioned. Re-asserting the same already-confirmed
    // value is a no-op (steering compliance).
    if (previousEngineValue === value) {
      return;
    }

    const envelope = this.buildStatusEventEnvelope(id, value);
    this.emit('statusEvent', envelope);
  }

  /**
   * Mark a switch as "user requested but engine hasn't confirmed
   * yet". Called from {@link handleControlRequest}; exposed publicly
   * because the engine may want to drive the unconfirmed marker
   * directly (e.g. when applying a programmatic toggle that should
   * still wait for engine confirmation).
   *
   * Never emits `'statusEvent'` — that channel is reserved for the
   * engine-confirmed transition.
   */
  public markUnconfirmed(id: OwnSwitchId, requestedValue: boolean): void {
    const updatedAt = this.now().toISOString();
    this.cache.set(id, {
      id,
      value: requestedValue,
      engineConfirmed: false,
      updatedAt,
    });
  }

  // -------------------------------------------------------------------------
  // CONTROL_REQUEST handling.
  // -------------------------------------------------------------------------

  /**
   * Process an inbound `CONTROL_REQUEST` envelope. Always emits
   * exactly one `'controlResponse'` envelope, plus a `'userInput'`
   * event when the request is well-formed and targets one of our
   * switches with a value that differs from the engine-confirmed
   * cache.
   *
   * Failure modes (each emits a single `controlResponse` and returns):
   *
   *   - body shape invalid → `success: false`, `error.code: 'BAD_REQUEST'`.
   *   - `deviceId` not one of our five → `success: false`,
   *     `error.code: 'UNKNOWN_DEVICE'`.
   *
   * Success modes:
   *
   *   - request has no `switchState` feature → `success: true` (we
   *     accept the input, no `userInput` emitted because there's
   *     nothing meaningful to act on).
   *   - request has a `switchState` feature with `on: boolean`:
   *     1. cache is updated via `markUnconfirmed`,
   *     2. `userInput` is emitted with the request,
   *     3. `controlResponse` is emitted with `success: true` and the
   *        original deviceId. The id is echoed via {@link buildReply}.
   */
  public handleControlRequest(envelope: ConnectEnvelope): void {
    const parsed = parseControlRequestBody(envelope.body);
    if (parsed === null) {
      this.log('warn', 'CONTROL_REQUEST with malformed body', {
        id: envelope.id,
      });
      this.emit(
        'controlResponse',
        buildReply(envelope, {
          type: PluginMessageType.CONTROL_RESPONSE,
          body: {
            success: false,
            error: {
              code: 'BAD_REQUEST',
              message: 'CONTROL_REQUEST body must include deviceId and features[]',
            },
          },
        }),
      );
      return;
    }

    const { deviceId, features } = parsed;

    if (!isOwnSwitchId(deviceId)) {
      this.log('warn', 'CONTROL_REQUEST for unknown device', {
        id: envelope.id,
        deviceId,
      });
      this.emit(
        'controlResponse',
        buildReply(envelope, {
          type: PluginMessageType.CONTROL_RESPONSE,
          body: {
            success: false,
            deviceId,
            error: {
              code: 'UNKNOWN_DEVICE',
              message: `deviceId '${String(deviceId)}' is not owned by this plugin`,
            },
          },
        }),
      );
      return;
    }

    const switchState = findSwitchState(features);
    if (switchState === undefined || typeof switchState.on !== 'boolean') {
      // No actionable feature — accept the input but skip the
      // userInput event. The HCU still sees a successful response.
      this.emit(
        'controlResponse',
        buildReply(envelope, {
          type: PluginMessageType.CONTROL_RESPONSE,
          body: { success: true, deviceId },
        }),
      );
      return;
    }

    const requestedValue = switchState.on;
    this.markUnconfirmed(deviceId, requestedValue);

    this.log('info', 'CONTROL_REQUEST applied', { deviceId, requestedValue });
    this.emit('userInput', {
      deviceId,
      requestedValue,
      rawRequest: envelope,
    });

    this.emit(
      'controlResponse',
      buildReply(envelope, {
        type: PluginMessageType.CONTROL_RESPONSE,
        body: { success: true, deviceId },
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Internals.
  // -------------------------------------------------------------------------

  /**
   * Build a `STATUS_EVENT` envelope carrying only the switchState
   * feature for `id`. Called from {@link confirmFromEngine}.
   *
   * Body shape mirrors the DiscoverResponse device descriptor's
   * `{ deviceId, features }` core, with `features` containing only
   * the changed feature (steering: STATUS_EVENT carries the deltas,
   * not the full feature set).
   */
  private buildStatusEventEnvelope(
    id: OwnSwitchId,
    value: boolean,
  ): ConnectEnvelope {
    const switchState: SwitchStateFeature = { type: 'switchState', on: value };
    const features: OwnDeviceFeature[] = [switchState];
    return buildEnvelope({
      pluginId: this.pluginId,
      type: PluginMessageType.STATUS_EVENT,
      body: { deviceId: id, features },
    });
  }

  private log(
    level: 'info' | 'warn' | 'error',
    msg: string,
    ctx?: Record<string, unknown>,
  ): void {
    if (this.logger === null) {
      return;
    }
    try {
      this.logger(level, msg, ctx);
    } catch {
      // Logger errors must not break the manager.
    }
  }
}
