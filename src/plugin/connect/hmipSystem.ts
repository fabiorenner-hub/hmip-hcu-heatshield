/**
 * Heat Shield — Connect API HmipSystem adapter (Task 6.5).
 *
 * Owns the request/response and event flows for the HCU's
 * `HMIP_SYSTEM_*` message family (Spec 1.0.1 §6.3 plus the routing
 * layer §HmipSystemRequest). The adapter is the single chokepoint
 * through which Heat Shield steers native `WINDOW_COVERING` devices
 * and through which `HMIP_SYSTEM_EVENT` push transactions reach the
 * source cache.
 *
 * Responsibilities:
 *
 *   - Send `HMIP_SYSTEM_REQUEST` envelopes (`getSystemState`,
 *     `setShutterLevel`) and correlate the matching
 *     `HMIP_SYSTEM_RESPONSE` by envelope id.
 *   - Forward incoming `HMIP_SYSTEM_EVENT` bodies to
 *     {@link HcuSourceCache} so the cache stays current.
 *   - Track `lastCommandedLevel[deviceId]` + `lastCommandedAt[deviceId]`
 *     and detect manual operation on shutter channels: any observed
 *     `shutterLevel` that arrives **outside** the manual-override
 *     grace window AND **outside** the snap tolerance from the last
 *     commanded value (or for a device that was never commanded) is
 *     surfaced as `'manualOverride'`. The orchestrator then sets
 *     `manualOverrideUntil` per design.md §"Manuelle-Bedienung-
 *     Detektion".
 *
 * ─── Steering compliance (`hmip-connect-api.md`, `heat-shield-context.md`) ─
 *
 *   - Native HCU shutters are steered EXCLUSIVELY via
 *     `HmipSystemRequest /hmip/device/control/setShutterLevel`. This
 *     module is the only place that sends `HMIP_SYSTEM_REQUEST` for
 *     shutter control. It never emits `STATUS_EVENT` (steering: only
 *     plugin-OWNED switches receive STATUS_EVENT, see
 *     `ownDevices.ts`).
 *   - The adapter does not touch the WebSocket transport directly —
 *     it consumes a {@link ConnectClient} via the `'message'` event
 *     and `send()`. Tests therefore wire a structural fake without
 *     ever opening a socket.
 *
 * ─── Spec wire shapes (orchestrator-verified, Spec 1.0.1) ──────────
 *
 *   - `HMIP_SYSTEM_REQUEST.body` = `{ path: string, body: object }`.
 *   - `setShutterLevel` path = `/hmip/device/control/setShutterLevel`.
 *     Inner body = `{ shutterLevel: number, channelIndex: number,
 *     deviceId: string }`. `shutterLevel` is on the §6.7.29 scale
 *     (0..1, 1 = fully closed).
 *   - `getSystemState` path = `/hmip/home/getSystemState`. Inner body
 *     = `{}`.
 *   - `HMIP_SYSTEM_RESPONSE.body` = `{ code: number, body?: any }`.
 *     `code === 200` means success; any other value is treated as
 *     failure and rejects the pending promise.
 *   - `HMIP_SYSTEM_EVENT.body` = `{ eventTransaction: { events:
 *     { '0': { pushEventType, device, ... }, ... } } }`. The same
 *     shape `HcuSourceCache.applyEvent` already accepts.
 *
 * ─── Strict-mode notes ─────────────────────────────────────────────
 *
 *   - Optional injections (`now`, `logger`, `snapTolerance`,
 *     `manualOverrideGraceMs`) are normalised in the constructor so
 *     the rest of the class operates on concrete values.
 *   - Pending requests are stored in a `Map<string, PendingRequest>`
 *     keyed by envelope id. The `timer` field is captured so a
 *     resolved/rejected request always clears its timeout — no
 *     stragglers fire after the fact.
 *   - The "never-commanded" branch of manual-override detection
 *     fires at most once per device until the next
 *     {@link setShutterLevel} call resets it. Without this guard, an
 *     idle shutter that broadcasts its current level on every
 *     transaction would spam the orchestrator on every cycle.
 */

import { EventEmitter } from 'node:events';

import type { HcuSourceCache } from '../sources/hcu.js';

import type { ConnectClient, ConnectEnvelope } from './client.js';
import { PluginMessageType, buildEnvelope } from './envelope.js';

// ---------------------------------------------------------------------------
// Public types.
// ---------------------------------------------------------------------------

/**
 * Payload of the `'shutterCommanded'` event. Emitted from
 * {@link HmipSystemAdapter.setShutterLevel} **before** the request is
 * sent on the wire so the orchestrator can log the intent regardless
 * of whether the HCU eventually accepts the command.
 */
export interface ShutterCommand {
  readonly deviceId: string;
  readonly channelIndex: number;
  readonly level01: number;
}

/**
 * Payload of the `'manualOverride'` event. `lastCommandedLevel` and
 * `lastCommandedAt` are `null` for shutters the plugin has never
 * commanded — i.e. the user moved the device before the orchestrator
 * ever issued an automation pulse for it.
 */
export interface ManualOverrideDetection {
  readonly deviceId: string;
  readonly observedLevel: number;
  readonly lastCommandedLevel: number | null;
  readonly lastCommandedAt: Date | null;
}

/**
 * Constructor options for {@link HmipSystemAdapter}.
 *
 *   - `client` — the live {@link ConnectClient}; the adapter
 *     subscribes to its `'message'` event in {@link start} and
 *     calls `send()` for every outbound request.
 *   - `pluginId` — used as the `pluginId` field on every outbound
 *     envelope. Must match the value the plugin presents in its
 *     auth handshake.
 *   - `cache` — receives `applySystemState` and `applyEvent` calls
 *     so the rest of the engine sees fresh data.
 *   - `snapTolerance` — defaults to `0.05` (5 percentage points). An
 *     observed level within tolerance of the last commanded value is
 *     considered the device's response, not manual operation.
 *   - `manualOverrideGraceMs` — defaults to `30_000` (30 s). Events
 *     arriving within this window after a command are not treated
 *     as manual operation.
 *   - `now` — clock injection (tests pass a deterministic clock).
 *   - `logger` — opt-in structured logger; absent by default so unit
 *     tests stay silent.
 */
export interface HmipSystemAdapterOptions {
  readonly client: ConnectClient;
  readonly pluginId: string;
  readonly cache: HcuSourceCache;
  readonly snapTolerance?: number;
  readonly manualOverrideGraceMs?: number;
  readonly now?: () => Date;
  readonly logger?: (
    level: 'info' | 'warn' | 'error',
    msg: string,
    ctx?: Record<string, unknown>,
  ) => void;
}

/**
 * Typed event map. `'systemEvent'` carries the raw `HMIP_SYSTEM_EVENT`
 * body (post-cache application) so listeners that want to do their
 * own walking — e.g. the engine reacting to a contact-channel toggle
 * — receive a stable shape.
 */
type HmipSystemAdapterEvents = {
  systemStateLoaded: [];
  systemEvent: [body: unknown];
  manualOverride: [detection: ManualOverrideDetection];
  shutterCommanded: [cmd: ShutterCommand];
};

// ---------------------------------------------------------------------------
// Defaults.
// ---------------------------------------------------------------------------

/**
 * Snap tolerance default, in `shutterLevel` units (0..1). Matches
 * design.md §"Manuelle-Bedienung-Detektion": within 5 percentage
 * points of the commanded value is "the device acknowledged our
 * command", outside is "someone moved it".
 */
const DEFAULT_SNAP_TOLERANCE = 0.05;

/**
 * Grace window after a `setShutterLevel` during which incoming
 * shutter events are attributed to the engine, not the user. 30 s
 * matches design.md.
 */
const DEFAULT_MANUAL_OVERRIDE_GRACE_MS = 30_000;

/**
 * Request timeout for `HMIP_SYSTEM_REQUEST`. The HCU normally
 * answers within milliseconds; a 5 s ceiling is generous and keeps
 * the orchestrator's cycle from blocking on a stalled connection.
 */
const REQUEST_TIMEOUT_MS = 5_000;

/** Spec path for `setShutterLevel`. */
const SET_SHUTTER_LEVEL_PATH = '/hmip/device/control/setShutterLevel';

/**
 * Spec path for `setSwitchState` (Connect API §6.8.1.31). Turns a
 * Homematic IP switching device (or a plugin-external SWITCH such as
 * a Gardena valve bridged by the Gardena Connect plugin) on or off.
 * Inner body shape (spec example): `{ on: boolean, channelIndex:
 * number, deviceId: string }`.
 */
const SET_SWITCH_STATE_PATH = '/hmip/device/control/setSwitchState';

/** Spec path for `getSystemState`. */
const GET_SYSTEM_STATE_PATH = '/hmip/home/getSystemState';

// ---------------------------------------------------------------------------
// Internal state.
// ---------------------------------------------------------------------------

/**
 * Bookkeeping for a single in-flight `HMIP_SYSTEM_REQUEST`. The
 * `timer` is the timeout that rejects the promise if the HCU never
 * answers; resolving / rejecting always clears it.
 */
interface PendingRequest {
  readonly resolve: (response: { code: number; body?: unknown }) => void;
  readonly reject: (err: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * Parsed `HMIP_SYSTEM_RESPONSE` body. Returned by {@link parseResponseBody}
 * when the inbound shape is well-formed.
 */
interface ResponseBody {
  readonly code: number;
  readonly body?: unknown;
}

// ---------------------------------------------------------------------------
// Adapter.
// ---------------------------------------------------------------------------

/**
 * Connect-API HmipSystem adapter. See module header for the
 * responsibility split. The adapter is intentionally light on
 * defensive coding: the {@link HcuSourceCache} already tolerates
 * malformed event bodies, and the `pendingRequests` map prevents
 * orphaned promises by always clearing on resolve / reject /
 * timeout.
 */
export class HmipSystemAdapter extends EventEmitter<HmipSystemAdapterEvents> {
  private readonly client: ConnectClient;
  private readonly pluginId: string;
  private readonly cache: HcuSourceCache;
  private readonly snapTolerance: number;
  private readonly manualOverrideGraceMs: number;
  private readonly now: () => Date;
  private readonly logger:
    | ((
        level: 'info' | 'warn' | 'error',
        msg: string,
        ctx?: Record<string, unknown>,
      ) => void)
    | null;

  /** Last commanded shutter level per device (0..1). */
  private readonly lastCommandedLevel: Map<string, number> = new Map();

  /** Wall-clock time of the last `setShutterLevel` per device. */
  private readonly lastCommandedAt: Map<string, Date> = new Map();

  /**
   * Pending in-flight requests, keyed by envelope id. Cleared on
   * resolve, reject, or timeout.
   */
  private readonly pendingRequests: Map<string, PendingRequest> = new Map();

  /**
   * Set of deviceIds for which we have already emitted a
   * never-commanded `'manualOverride'`. Cleared per device when
   * {@link setShutterLevel} fires, so the next observation after a
   * fresh command is evaluated against the grace+tolerance branch
   * instead of the never-commanded branch.
   */
  private readonly nonCommandedFlagged: Set<string> = new Set();

  /**
   * The `'message'` listener bound during {@link start}. We retain
   * it so {@link stop} can detach the same instance from the client.
   * `null` when the adapter is stopped (or has never been started).
   */
  private listener: ((envelope: ConnectEnvelope) => void) | null = null;

  /** Raw body of the most recent successful getSystemState (diagnostics). */
  private lastRawSystemStateBody: unknown = null;

  public constructor(options: HmipSystemAdapterOptions) {
    super();
    this.client = options.client;
    this.pluginId = options.pluginId;
    this.cache = options.cache;
    this.snapTolerance = options.snapTolerance ?? DEFAULT_SNAP_TOLERANCE;
    this.manualOverrideGraceMs =
      options.manualOverrideGraceMs ?? DEFAULT_MANUAL_OVERRIDE_GRACE_MS;
    this.now = options.now ?? ((): Date => new Date());
    this.logger = options.logger ?? null;
  }

  // -------------------------------------------------------------------------
  // Lifecycle.
  // -------------------------------------------------------------------------

  /**
   * Subscribe to `'message'` events on the client. Idempotent: a
   * second call while already started is a no-op (no double
   * registration).
   */
  public start(): void {
    if (this.listener !== null) {
      return;
    }
    const listener = (envelope: ConnectEnvelope): void => {
      this.handleMessage(envelope);
    };
    this.listener = listener;
    this.client.on('message', listener);
  }

  /**
   * Detach the `'message'` listener registered by {@link start}.
   * Idempotent: calling on an already-stopped adapter is a no-op.
   * Pending requests are **not** rejected by `stop()` — the caller
   * decides whether to drain them or let them time out.
   */
  public stop(): void {
    if (this.listener === null) {
      return;
    }
    this.client.off('message', this.listener);
    this.listener = null;
  }

  // -------------------------------------------------------------------------
  // Public API.
  // -------------------------------------------------------------------------

  /**
   * Issue an `HMIP_SYSTEM_REQUEST` to `/hmip/home/getSystemState`
   * with an empty inner body. On a `code === 200` response, the
   * cache is populated via `applySystemState(response.body)` and
   * `'systemStateLoaded'` is emitted. Rejects on non-200 responses
   * and on timeout.
   *
   * The cache receives the inner `body` field of the response (i.e.
   * the spec's `getSystemState` payload — `{ devices, ... }`), not
   * the full envelope; {@link HcuSourceCache.applySystemState}
   * additionally tolerates the wrapped shape, so passing through
   * either form is safe.
   */
  public async getSystemState(): Promise<void> {
    const id = this.sendRequest(GET_SYSTEM_STATE_PATH, {});
    const response = await this.awaitResponse(id);
    if (response.code !== 200) {
      throw new Error(
        `getSystemState failed with code ${response.code}`,
      );
    }
    this.lastRawSystemStateBody = response.body ?? null;
    this.cache.applySystemState(response.body);
    this.emit('systemStateLoaded');
  }

  /**
   * The raw `body` of the most recent successful `getSystemState`
   * response (the spec's `{ devices, groups, … }` payload), or
   * `null` if none has succeeded yet. Exposed for diagnostics so the
   * dashboard can count devices straight off the wire — independent
   * of the cache's schema filtering — and reveal whether the parser
   * is silently dropping device shapes the HCU actually sent.
   */
  public getLastRawSystemStateBody(): unknown {
    return this.lastRawSystemStateBody;
  }

  /**
   * Issue an `HMIP_SYSTEM_REQUEST` to
   * `/hmip/device/control/setShutterLevel` with body
   * `{ shutterLevel: level01, channelIndex, deviceId }`. Records
   * the commanded level + timestamp **before** the request goes
   * out so the manual-override detector evaluates subsequent events
   * against the right baseline. Emits `'shutterCommanded'` with the
   * intent payload; the orchestrator uses this for live logging.
   *
   * Resolves on `code === 200`, rejects on any other code or on
   * timeout. The HCU's behaviour on rejection is opaque — we keep
   * the recorded `lastCommandedLevel` regardless because the device
   * may still have moved partway, and the next observed level is
   * what really matters.
   */
  public async setShutterLevel(
    deviceId: string,
    channelIndex: number,
    level01: number,
  ): Promise<void> {
    const cmd: ShutterCommand = { deviceId, channelIndex, level01 };
    this.lastCommandedLevel.set(deviceId, level01);
    this.lastCommandedAt.set(deviceId, this.now());
    // Reset never-commanded flag — a fresh command means the next
    // observed level is judged against grace+tolerance, not against
    // the "we never moved this thing" branch.
    this.nonCommandedFlagged.delete(deviceId);

    this.emit('shutterCommanded', cmd);

    const id = this.sendRequest(SET_SHUTTER_LEVEL_PATH, {
      shutterLevel: level01,
      channelIndex,
      deviceId,
    });
    const response = await this.awaitResponse(id);
    if (response.code !== 200) {
      throw new Error(
        `setShutterLevel(${deviceId}@${channelIndex}=${level01}) failed with code ${response.code}`,
      );
    }
  }

  /**
   * Issue an `HMIP_SYSTEM_REQUEST` to
   * `/hmip/device/control/setSwitchState` with body
   * `{ on, channelIndex, deviceId }` (Connect API §6.8.1.31). Turns a
   * Homematic IP switching device — or a plugin-external `SWITCH`
   * bridged into the HCU (e.g. a Gardena valve from the Gardena
   * Connect plugin) — on or off.
   *
   * Resolves on `code === 200`, rejects on any other code or on
   * timeout. Unlike {@link setShutterLevel} this does NOT participate
   * in the manual-override detector: the only switches Heat Shield
   * commands here are plugin-external (Gardena), which the engine
   * does not own a "last commanded level" baseline for.
   *
   * `channelIndex` defaults to `1` (the switch actor channel on a
   * standard single HMIP switch); callers that know the precise
   * channel (e.g. from `HmipFeatureValue.channelIndex` on the cached
   * `switchState`) should pass it explicitly.
   */
  public async setSwitchState(
    deviceId: string,
    on: boolean,
    channelIndex = 1,
  ): Promise<void> {
    const id = this.sendRequest(SET_SWITCH_STATE_PATH, {
      on,
      channelIndex,
      deviceId,
    });
    const response = await this.awaitResponse(id);
    if (response.code !== 200) {
      throw new Error(
        `setSwitchState(${deviceId}@${channelIndex}=${on}) failed with code ${response.code}`,
      );
    }
  }

  /**
   * Most recent `setShutterLevel` for `deviceId`, or `null` if the
   * device was never commanded. Returned object is a fresh literal,
   * so callers may not mutate the internal state.
   */
  public getLastCommanded(
    deviceId: string,
  ): { level: number; at: Date } | null {
    const level = this.lastCommandedLevel.get(deviceId);
    const at = this.lastCommandedAt.get(deviceId);
    if (level === undefined || at === undefined) {
      return null;
    }
    return { level, at: new Date(at.getTime()) };
  }

  // -------------------------------------------------------------------------
  // Internals — request/response.
  // -------------------------------------------------------------------------

  /**
   * Build and send an `HMIP_SYSTEM_REQUEST` envelope. Returns the
   * envelope id so the caller can register a pending request before
   * the response could arrive.
   */
  private sendRequest(path: string, innerBody: object): string {
    const envelope = buildEnvelope({
      pluginId: this.pluginId,
      type: PluginMessageType.HMIP_SYSTEM_REQUEST,
      body: { path, body: innerBody },
    });
    this.client.send(envelope);
    return envelope.id;
  }

  /**
   * Register a pending request keyed by `id`. Resolves when the
   * matching `HMIP_SYSTEM_RESPONSE` arrives, or rejects after
   * {@link REQUEST_TIMEOUT_MS}.
   */
  private awaitResponse(id: string): Promise<ResponseBody> {
    return new Promise<ResponseBody>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error('HMIP_SYSTEM_REQUEST timed out'));
      }, REQUEST_TIMEOUT_MS);
      this.pendingRequests.set(id, { resolve, reject, timer });
    });
  }

  // -------------------------------------------------------------------------
  // Internals — inbound dispatch.
  // -------------------------------------------------------------------------

  /**
   * Dispatch a single inbound envelope. Recognises the two types
   * this adapter cares about (`HMIP_SYSTEM_RESPONSE`,
   * `HMIP_SYSTEM_EVENT`); other types are ignored — the orchestrator
   * routes them through other adapters (DiscoverResponse builder,
   * own-device manager).
   */
  private handleMessage(envelope: ConnectEnvelope): void {
    if (envelope.type === PluginMessageType.HMIP_SYSTEM_RESPONSE) {
      this.handleResponse(envelope);
      return;
    }
    if (envelope.type === PluginMessageType.HMIP_SYSTEM_EVENT) {
      this.handleEvent(envelope.body);
    }
  }

  /**
   * Resolve / reject the pending request matching `envelope.id`.
   * Unmatched ids (e.g. a late response after a timeout) are
   * silently dropped. A response without a numeric `code` rejects
   * the pending promise so the caller sees the malformed answer
   * instead of hanging.
   */
  private handleResponse(envelope: ConnectEnvelope): void {
    const pending = this.pendingRequests.get(envelope.id);
    if (pending === undefined) {
      this.log('warn', 'HMIP_SYSTEM_RESPONSE without matching pending request', {
        id: envelope.id,
      });
      return;
    }
    this.pendingRequests.delete(envelope.id);
    clearTimeout(pending.timer);

    const parsed = parseResponseBody(envelope.body);
    if (parsed === null) {
      pending.reject(
        new Error(
          'HMIP_SYSTEM_RESPONSE missing numeric `code` field',
        ),
      );
      return;
    }
    pending.resolve(parsed);
  }

  /**
   * Forward the event body to the cache (so feature lookups stay
   * fresh), emit `'systemEvent'`, then walk the events for shutter
   * channels and run manual-override detection. Cache application
   * happens first so listeners observing the event already see the
   * post-event cache state.
   */
  private handleEvent(body: unknown): void {
    this.cache.applyEvent(body);
    this.emit('systemEvent', body);
    this.detectManualOverrides(body);
  }

  // -------------------------------------------------------------------------
  // Internals — manual-override detection.
  // -------------------------------------------------------------------------

  /**
   * Walk every `eventTransaction.events.*.device.functionalChannels.*`
   * channel in `body` and call {@link evaluateManualOverride} for each
   * channel that carries a numeric `shutterLevel`. Tolerant of
   * malformed input — non-object branches are skipped silently.
   */
  private detectManualOverrides(body: unknown): void {
    if (body === null || typeof body !== 'object') {
      return;
    }

    const root = body as Record<string, unknown>;
    const txn = root['eventTransaction'];
    if (txn === null || typeof txn !== 'object') {
      return;
    }
    const events = (txn as Record<string, unknown>)['events'];
    if (events === null || typeof events !== 'object') {
      return;
    }
    for (const ev of Object.values(events as Record<string, unknown>)) {
      if (ev === null || typeof ev !== 'object') {
        continue;
      }
      const device = (ev as Record<string, unknown>)['device'];
      if (device === null || typeof device !== 'object') {
        continue;
      }
      const dev = device as Record<string, unknown>;
      const deviceId = dev['id'];
      if (typeof deviceId !== 'string' || deviceId.length === 0) {
        continue;
      }
      const channels = dev['functionalChannels'];
      if (channels === null || typeof channels !== 'object') {
        continue;
      }
      for (const channel of Object.values(
        channels as Record<string, unknown>,
      )) {
        if (channel === null || typeof channel !== 'object') {
          continue;
        }
        const observed = (channel as Record<string, unknown>)['shutterLevel'];
        if (typeof observed !== 'number') {
          continue;
        }
        this.evaluateManualOverride(deviceId, observed);
      }
    }
  }

  /**
   * Decide whether `observedLevel` for `deviceId` constitutes a
   * manual override and emit `'manualOverride'` if so.
   *
   * Three branches:
   *
   *   1. Last command exists AND the event is within the grace
   *      window → not manual (the event is the device's own
   *      response). No emit.
   *   2. Last command exists AND the event is outside grace AND the
   *      observed level is within snap tolerance of the commanded
   *      level → also the device's response (lazy ACK). No emit.
   *   3. Last command exists AND the event is outside grace AND
   *      outside snap tolerance → manual override. Emit.
   *
   * Plus the never-commanded fallback: if no command was ever sent
   * for this device, any observed level is manual. We emit at most
   * once per device until {@link setShutterLevel} clears the flag.
   */
  private evaluateManualOverride(
    deviceId: string,
    observedLevel: number,
  ): void {
    const lastLevel = this.lastCommandedLevel.get(deviceId);
    const lastAt = this.lastCommandedAt.get(deviceId);

    if (lastLevel !== undefined && lastAt !== undefined) {
      const ageMs = this.now().getTime() - lastAt.getTime();
      if (ageMs <= this.manualOverrideGraceMs) {
        return;
      }
      if (Math.abs(observedLevel - lastLevel) <= this.snapTolerance) {
        return;
      }
      this.emit('manualOverride', {
        deviceId,
        observedLevel,
        lastCommandedLevel: lastLevel,
        lastCommandedAt: new Date(lastAt.getTime()),
      });
      return;
    }

    // Never commanded — any movement is manual, but rate-limit to
    // one emit per device until a real command resets the flag.
    if (this.nonCommandedFlagged.has(deviceId)) {
      return;
    }
    this.nonCommandedFlagged.add(deviceId);
    this.emit('manualOverride', {
      deviceId,
      observedLevel,
      lastCommandedLevel: null,
      lastCommandedAt: null,
    });
  }

  // -------------------------------------------------------------------------
  // Internals — logging.
  // -------------------------------------------------------------------------

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
      // Logger errors must not break the adapter.
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/**
 * Narrow the `body` of an `HMIP_SYSTEM_RESPONSE` envelope to the
 * `{ code, body? }` shape. Returns `null` when `body` is missing,
 * not an object, or lacks a numeric `code`.
 */
function parseResponseBody(raw: unknown): ResponseBody | null {
  if (raw === null || typeof raw !== 'object') {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const code = obj['code'];
  if (typeof code !== 'number') {
    return null;
  }
  if ('body' in obj) {
    return { code, body: obj['body'] };
  }
  return { code };
}
