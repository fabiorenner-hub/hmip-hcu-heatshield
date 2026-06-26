/**
 * Heat Shield — Connect API WebSocket client (Task 6.1).
 *
 * Thin, fully dependency-injected WebSocket client around the
 * Homematic IP Connect API (Spec 1.0.1, §6.1). The client owns:
 *
 *   - the WebSocket lifecycle (connect, reconnect, close),
 *   - exponential-backoff reconnect with optional jitter,
 *   - JSON encoding for outbound envelopes,
 *   - JSON decoding for inbound envelopes (`'message'` event),
 *   - clean shutdown semantics for `stop()`.
 *
 * Higher-level concerns — building DiscoverResponse / STATUS_EVENT
 * envelopes, tracking own-device state, manual-override detection —
 * live in sibling modules (`envelope.ts`, `discover.ts`,
 * `ownDevices.ts`, `hmipSystem.ts`) and consume this client purely
 * through its event surface.
 *
 * ─── Connect API spec deviations / interpretations ─────────────────
 *
 * The task brief and Spec 1.0.1 §6.1 disagree on three small but
 * material points. Where the spec is definitive we follow the spec;
 * where the brief is definitive we follow the brief. Both sources are
 * cited so the choice is auditable.
 *
 *   1. **Authorization header.** The brief proposes
 *      `Authorization: Bearer <token>`. The spec (§6.1, "Connection
 *      request headers") names the header `authtoken` and ships the
 *      raw token as the value, with no `Bearer ` prefix. The HCU's
 *      Java backend rejects unknown headers silently, so we follow
 *      the spec verbatim. The brief's "or as documented in §1077–
 *      §1370 of the spec" clause explicitly delegates to the spec
 *      when the two disagree.
 *
 *   2. **plugin-id header.** §6.1 also requires a `plugin-id` header
 *      carrying the same plugin identifier used to obtain the auth
 *      token. The brief's "the handshake URL adds the pluginId as a
 *      query / header per the spec" sentence delegates here too. We
 *      send `plugin-id`, not a query parameter — the spec does not
 *      mention any query string component.
 *
 *   3. **`category` field on envelopes.** The brief defines
 *      {@link ConnectEnvelope} with a `category` field. §6.2.1
 *      ("PluginMessage" envelope) lists exactly four fields: `id`,
 *      `pluginId`, `type`, `body`. There is no `category` on the
 *      message envelope (`MessageCategory` is a separate enum used
 *      inside `UserMessage` payloads, §6.6.7). To stay
 *      spec-conformant while honouring the brief's typed surface, we
 *      keep `category` as an *optional* field on the envelope: when
 *      present it round-trips through the JSON codec verbatim, when
 *      absent it is omitted from the wire payload entirely. Tests
 *      cover both cases.
 *
 * ─── Strict-mode notes ─────────────────────────────────────────────
 *
 *   - `WebSocketLike` is a structural subset of the `ws` library's
 *     surface (`send`, `close`, `on`, `readyState`). Tests pass a
 *     fake; production wires the real `ws` constructor through
 *     `wsFactory`. The factory pattern (rather than `new WebSocket()`
 *     in this file) is what keeps the unit tests fully offline.
 *
 *   - `EventEmitter<EventMap>` is used for typed event payloads,
 *     consistent with `FusionSolarAdapter`. The map is an exhaustive
 *     enumeration of the public event surface; consumers that want a
 *     different signature must subscribe via `on('open', …)` etc.,
 *     not by inheriting.
 *
 *   - No `console.*` calls. Logging is opt-in via the injected
 *     `logger` callback (steering: `heat-shield-context.md`,
 *     "Logger is opt-in").
 */

import { EventEmitter } from 'node:events';

import WebSocket from 'ws';

// ---------------------------------------------------------------------------
// WebSocket interface — the minimal surface our client (and tests) need.
// ---------------------------------------------------------------------------

/**
 * Structural subset of the `ws` package's WebSocket class. We only
 * depend on the four members we actually invoke; everything else (e.g.
 * `ping`, `terminate`, `bufferedAmount`) is intentionally omitted so
 * tests can supply a tiny fake.
 *
 * `readyState` follows the standard WebSocket constants:
 *
 *   - 0 = CONNECTING
 *   - 1 = OPEN
 *   - 2 = CLOSING
 *   - 3 = CLOSED
 */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(
    event: 'open' | 'close' | 'error' | 'message',
    listener: (...args: unknown[]) => void,
  ): unknown;
  readyState: number;
}

/** Standard WebSocket readyState constants. */
export const WS_CONNECTING = 0;
export const WS_OPEN = 1;
export const WS_CLOSING = 2;
export const WS_CLOSED = 3;

// ---------------------------------------------------------------------------
// Public types.
// ---------------------------------------------------------------------------

/**
 * Connect API message envelope. §6.2.1 of the Connect API spec
 * defines the canonical fields (`id`, `pluginId`, `type`, `body`);
 * `category` is an optional pass-through for the brief's typed
 * surface (see module header for the deviation note).
 */
export interface ConnectEnvelope {
  /**
   * Optional message-category passthrough. Absent in
   * spec-§6.2.1 envelopes; included here so higher-level code that
   * needs to attach a category can do so without a separate
   * codec.
   */
  category?: string;
  /** Message identifier (UUID for unsolicited messages, echoed for replies). */
  id: string;
  /** Unique plugin identifier (e.g. `de.fr.renner.plugin.heatshield`). */
  pluginId: string;
  /** PluginMessageType (e.g. `PLUGIN_STATE_RESPONSE`, `DISCOVER_RESPONSE`). */
  type: string;
  /** Type-specific payload. Shape is enforced by callers, not by this client. */
  body?: unknown;
}

/**
 * Backoff configuration for the auto-reconnect loop. All fields are
 * optional; defaults match the brief (1 s → 30 s, factor 2, ±25%
 * jitter on).
 */
export interface BackoffOptions {
  readonly initialMs?: number;
  readonly maxMs?: number;
  readonly factor?: number;
  readonly jitter?: boolean;
}

/**
 * Logger callback. Levels are deliberately limited to the three the
 * client actually emits; any structured context goes in `ctx`. The
 * orchestrator wires this to its log sink; tests typically pass
 * `undefined` so silence is the default.
 */
export type ConnectLogger = (
  level: 'info' | 'warn' | 'error',
  msg: string,
  ctx?: Record<string, unknown>,
) => void;

/**
 * WebSocket factory. Receives the resolved URL plus the headers we
 * want on the upgrade request and must return any object satisfying
 * {@link WebSocketLike}. In production this wraps the `ws` package
 * (`new WebSocket(url, { headers })`); in tests it returns the
 * in-memory fake.
 */
export type WebSocketFactory = (
  url: string,
  options: { headers: Record<string, string> },
) => WebSocketLike;

/**
 * Constructor options for {@link ConnectClient}.
 *
 *   - `url` — `wss://host.containers.internal:9001` for installed
 *     plugins (§4.2), `wss://hcu1-XXXX.local:9001` for remote
 *     development (§2.5).
 *   - `pluginId` — must match the plugin identifier used to obtain
 *     `authToken`.
 *   - `authToken` — raw token from `/TOKEN` (§6.1). Sent verbatim in
 *     the `authtoken` header; no `Bearer ` prefix.
 *   - `receiveSystemEvents` — sets the `hmip-system-events: true`
 *     header (§6.1, optional). Defaults to `true` because the engine
 *     relies on system events for native sensors and OpenMeteo.
 *   - `wsFactory` — defaults to a `ws` package wrapper. Tests
 *     override this to keep the unit suite offline.
 *   - `backoff` / `logger` / `now` — all optional, sensible defaults.
 */
export interface ConnectClientOptions {
  readonly url: string;
  readonly pluginId: string;
  readonly authToken: string;
  readonly receiveSystemEvents?: boolean;
  readonly wsFactory?: WebSocketFactory;
  readonly backoff?: BackoffOptions;
  readonly logger?: ConnectLogger;
  readonly now?: () => Date;
}

/**
 * Typed event map. Mirrors the brief; the payload shapes are precise
 * (no `unknown[]` tail) so consumers don't need to widen.
 */
type ConnectClientEvents = {
  open: [];
  message: [envelope: ConnectEnvelope];
  close: [info: { code: number; reason: string }];
  reconnect: [info: { attempt: number; delayMs: number }];
  error: [err: Error];
};

// ---------------------------------------------------------------------------
// Defaults.
// ---------------------------------------------------------------------------

const DEFAULT_BACKOFF: Required<BackoffOptions> = {
  initialMs: 1_000,
  maxMs: 30_000,
  factor: 2,
  jitter: true,
};

// ---------------------------------------------------------------------------
// Client.
// ---------------------------------------------------------------------------

/**
 * WebSocket client with auto-reconnect and JSON codec. See module
 * header for the spec/brief reconciliation notes.
 *
 * Lifecycle:
 *
 *   - {@link start} opens the first WebSocket and arms the reconnect
 *     loop. Idempotent.
 *   - {@link stop} disables further reconnects and closes the active
 *     socket if any. Resolves once the close handshake (or its
 *     timeout) is complete.
 *
 * Reconnect timing:
 *
 *   - `delayMs(attempt) = min(initialMs * factor^(attempt-1), maxMs)`
 *     where `attempt = 1` for the first reconnect.
 *   - Jitter (when on) multiplies the delay by a uniform random
 *     factor in `[0.75, 1.25]`. The jitter is applied **after**
 *     capping, so the reported delay can briefly exceed `maxMs` by up
 *     to 25% — that is the standard interpretation and tests pin to
 *     it via deterministic RNG.
 *   - The attempt counter resets on every successful `'open'`.
 */
export class ConnectClient extends EventEmitter<ConnectClientEvents> {
  private readonly url: string;
  private readonly pluginId: string;
  private readonly authToken: string;
  private readonly receiveSystemEvents: boolean;
  private readonly wsFactory: WebSocketFactory;
  private readonly backoff: Required<BackoffOptions>;
  private readonly logger: ConnectLogger | null;
  private readonly now: () => Date;

  private ws: WebSocketLike | null = null;
  private started: boolean = false;
  private stopping: boolean = false;
  private attempt: number = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closeAwait: Promise<void> | null = null;
  private resolveCloseAwait: (() => void) | null = null;

  public constructor(options: ConnectClientOptions) {
    super();
    this.url = options.url;
    this.pluginId = options.pluginId;
    this.authToken = options.authToken;
    this.receiveSystemEvents = options.receiveSystemEvents ?? true;
    this.wsFactory = options.wsFactory ?? defaultWsFactory;
    this.backoff = {
      initialMs: options.backoff?.initialMs ?? DEFAULT_BACKOFF.initialMs,
      maxMs: options.backoff?.maxMs ?? DEFAULT_BACKOFF.maxMs,
      factor: options.backoff?.factor ?? DEFAULT_BACKOFF.factor,
      jitter: options.backoff?.jitter ?? DEFAULT_BACKOFF.jitter,
    };
    this.logger = options.logger ?? null;
    this.now = options.now ?? ((): Date => new Date());
  }

  /**
   * Connect and arm the reconnect loop. Calls after the first are
   * no-ops; use {@link stop} first if you need to re-arm with new
   * options.
   */
  public start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.stopping = false;
    this.openSocket();
  }

  /**
   * Halt the reconnect loop and close the active socket. Resolves
   * when the socket reports a close (or immediately if already
   * disconnected). Idempotent.
   */
  public async stop(): Promise<void> {
    this.stopping = true;
    this.started = false;

    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const ws = this.ws;
    if (ws === null) {
      return;
    }

    if (ws.readyState === WS_CLOSED) {
      this.ws = null;
      return;
    }

    // Arm a promise that resolves when our `close` handler fires.
    if (this.closeAwait === null) {
      this.closeAwait = new Promise<void>((resolve) => {
        this.resolveCloseAwait = resolve;
      });
    }
    try {
      ws.close(1000, 'client stop');
    } catch (err) {
      this.log('warn', 'close threw during stop', { err: String(err) });
    }
    await this.closeAwait;
  }

  /**
   * JSON-encode and write `envelope`. Throws if the socket is not in
   * `OPEN` state — callers must guard with {@link isConnected} or
   * await `'open'` first.
   */
  public send(envelope: ConnectEnvelope): void {
    const ws = this.ws;
    if (ws === null || ws.readyState !== WS_OPEN) {
      throw new Error(
        `ConnectClient.send: socket not open (readyState=${
          ws === null ? 'null' : String(ws.readyState)
        })`,
      );
    }
    let payload: string;
    try {
      payload = JSON.stringify(envelope);
    } catch (err) {
      throw new Error(
        `ConnectClient.send: failed to JSON-encode envelope: ${String(err)}`,
      );
    }
    try {
      ws.send(payload);
    } catch (err) {
      // Surface as `'error'` so the orchestrator can decide whether
      // to retry on the next cycle, but also rethrow so the caller is
      // not left thinking the message went out.
      const wrapped =
        err instanceof Error
          ? err
          : new Error(`send threw: ${String(err)}`);
      this.emit('error', wrapped);
      throw wrapped;
    }
  }

  /** True iff the underlying socket is in `OPEN` state. */
  public isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WS_OPEN;
  }

  // -------------------------------------------------------------------------
  // Internals.
  // -------------------------------------------------------------------------

  private openSocket(): void {
    if (this.stopping) {
      return;
    }
    const headers: Record<string, string> = {
      authtoken: this.authToken,
      'plugin-id': this.pluginId,
    };
    if (this.receiveSystemEvents) {
      headers['hmip-system-events'] = 'true';
    }

    let ws: WebSocketLike;
    try {
      ws = this.wsFactory(this.url, { headers });
    } catch (err) {
      const wrapped =
        err instanceof Error
          ? err
          : new Error(`wsFactory threw: ${String(err)}`);
      this.emit('error', wrapped);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on('open', (...args: unknown[]) => {
      void args;
      this.handleOpen();
    });
    ws.on('message', (...args: unknown[]) => {
      this.handleMessage(args[0]);
    });
    ws.on('close', (...args: unknown[]) => {
      const code = typeof args[0] === 'number' ? args[0] : 1006;
      const reason = decodeReason(args[1]);
      this.handleClose(code, reason);
    });
    ws.on('error', (...args: unknown[]) => {
      const err = args[0];
      this.handleError(err);
    });
  }

  private handleOpen(): void {
    this.attempt = 0;
    this.log('info', 'connect-api websocket open', { url: this.url });
    this.emit('open');
  }

  private handleMessage(raw: unknown): void {
    let text: string;
    if (typeof raw === 'string') {
      text = raw;
    } else if (raw instanceof Uint8Array) {
      text = Buffer.from(raw).toString('utf8');
    } else if (Buffer.isBuffer(raw)) {
      text = raw.toString('utf8');
    } else {
      this.emit(
        'error',
        new Error(
          `ConnectClient: unexpected message payload type ${typeof raw}`,
        ),
      );
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      this.emit(
        'error',
        new Error(
          `ConnectClient: malformed JSON envelope: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
      );
      return;
    }

    if (!isPartialEnvelope(parsed)) {
      this.emit(
        'error',
        new Error(
          'ConnectClient: envelope missing required fields (id/pluginId/type)',
        ),
      );
      return;
    }

    this.emit('message', parsed);
  }

  private handleClose(code: number, reason: string): void {
    this.log('warn', 'connect-api websocket closed', {
      code,
      reason,
      stopping: this.stopping,
    });
    this.ws = null;
    this.emit('close', { code, reason });

    if (this.resolveCloseAwait !== null) {
      const resolve = this.resolveCloseAwait;
      this.resolveCloseAwait = null;
      this.closeAwait = null;
      resolve();
    }

    if (!this.stopping && this.started) {
      this.scheduleReconnect();
    }
  }

  private handleError(err: unknown): void {
    const wrapped =
      err instanceof Error
        ? err
        : new Error(
            typeof err === 'string' ? err : `ws error: ${String(err)}`,
          );
    this.emit('error', wrapped);
  }

  private scheduleReconnect(): void {
    if (this.stopping || !this.started) {
      return;
    }
    this.attempt += 1;
    const delayMs = this.computeDelay(this.attempt);
    this.emit('reconnect', { attempt: this.attempt, delayMs });
    this.log('info', 'connect-api websocket reconnect scheduled', {
      attempt: this.attempt,
      delayMs,
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delayMs);
  }

  private computeDelay(attempt: number): number {
    const exp = Math.pow(this.backoff.factor, Math.max(0, attempt - 1));
    const raw = this.backoff.initialMs * exp;
    const capped = Math.min(raw, this.backoff.maxMs);
    if (!this.backoff.jitter) {
      return Math.round(capped);
    }
    // ±25% jitter, applied after capping. Math.random() in [0, 1) →
    // factor in [0.75, 1.25).
    const jitterFactor = 0.75 + Math.random() * 0.5;
    return Math.round(capped * jitterFactor);
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
      // Logger errors must not break the client. The void here is
      // intentional — we have no other channel to surface them on.
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function decodeReason(raw: unknown): string {
  if (typeof raw === 'string') {
    return raw;
  }
  if (Buffer.isBuffer(raw)) {
    return raw.toString('utf8');
  }
  if (raw instanceof Uint8Array) {
    return Buffer.from(raw).toString('utf8');
  }
  return '';
}

function isPartialEnvelope(value: unknown): value is ConnectEnvelope {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj['id'] !== 'string') {
    return false;
  }
  if (typeof obj['pluginId'] !== 'string') {
    return false;
  }
  if (typeof obj['type'] !== 'string') {
    return false;
  }
  return true;
}

/**
 * Default WebSocket factory backed by the `ws` package. The brief
 * pins `ws` as a runtime dependency, so a static `import` is fine
 * here — tests that want to stay offline supply their own
 * `wsFactory` and never reach this code path.
 *
 * `rejectUnauthorized: false` is required by the Connect API: both
 * `host.containers.internal:9001` (installed plugins, §4.2) and
 * `hcu1-XXXX.local:9001` (remote dev, §2.5) terminate TLS with a
 * self-signed HCU certificate. The official Node example in the
 * spec sets the same flag (§5).
 */
function defaultWsFactory(
  url: string,
  options: { headers: Record<string, string> },
): WebSocketLike {
  // `ws.WebSocket` satisfies our structural `WebSocketLike` surface
  // (it has `send`, `close`, `on`, `readyState`); cast at the
  // boundary to keep our public type free of the `ws` package type.
  return new WebSocket(url, {
    headers: options.headers,
    rejectUnauthorized: false,
  }) as unknown as WebSocketLike;
}
