/**
 * Heat Shield — Connect API end-to-end integration (Task 6.6).
 *
 * Wires {@link ConnectClient} (with an in-memory mock
 * {@link WebSocketLike}) to {@link OwnDeviceManager},
 * {@link HmipSystemAdapter}, and {@link HcuSourceCache} and runs the
 * spec-conformant Connect API flow against an in-process "HCU"
 * implementation. No real network. No real WebSocket. The mock plays
 * the role of the HCU's Java backend: it inspects every outbound
 * envelope and would reject malformed ones with `ERROR_RESPONSE` —
 * the tests assert that no such rejection ever happens.
 *
 * The validator inside the mock encodes the steering rules from
 * `hmip-connect-api.md` and `heat-shield-context.md`:
 *
 *   - **No `category` on the wire envelope** (Spec §6.2.1 lists exactly
 *     four fields: `id`, `pluginId`, `type`, `body`).
 *   - **Closed `PluginMessageType` set** (§6.6.8) — unknown values
 *     would be rejected by Jackson.
 *   - **No `shutterDirection: 'STOPPED'`** anywhere in any body.
 *     `ShadingDirection` only carries `DARKER` and `LIGHTER`
 *     (§6.6.12).
 *   - **No `dataType: 'ENUM'`** anywhere — the HCUweb dropdown
 *     renders empty for it (steering: anti-pattern list).
 *   - **DISCOVER_RESPONSE** — every device's `deviceType` is
 *     `'SWITCH'` (the plugin owns switches only) and every feature
 *     `type` is one of `switchState | maintenance`.
 *   - **HMIP_SYSTEM_REQUEST** — the inner `body.path` is one of the
 *     two spec paths the plugin uses (`setShutterLevel`,
 *     `getSystemState`).
 *   - **STATUS_EVENT** — body has a `features` array; every entry's
 *     `type` is one of the closed plugin-feature names. No
 *     `shutterDirection` field.
 *
 * Test layout:
 *
 *   - Test 1 ("DISCOVER produces no ERROR_RESPONSE") opens the
 *     socket, sends `PluginStateResponse: READY` and
 *     `DiscoverResponse` with the five plugin SWITCH devices, and
 *     asserts the mock's validator collected zero errors.
 *   - Test 2 ("setShutterLevel + manual override") drives a single
 *     `setShutterLevel` request, waits for the mock's `code: 200`,
 *     advances the clock by 50 s, fires an `HMIP_SYSTEM_EVENT` with
 *     a divergent `shutterLevel`, and asserts the
 *     `HmipSystemAdapter` emits exactly one `'manualOverride'`
 *     event with the right payload.
 *   - Test 3 ("Spec compliance smoke") wires the same stack, drives
 *     DISCOVER plus a handful of inbound `CONTROL_REQUEST`s against
 *     the plugin's switches, calls `confirmFromEngine` to produce
 *     STATUS_EVENT envelopes, and asserts every captured envelope —
 *     including each STATUS_EVENT — passes the validator with zero
 *     errors.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ConnectClient,
  HmipSystemAdapter,
  OwnDeviceManager,
  PluginMessageType,
  PluginReadinessStatus,
  WS_CLOSED,
  WS_CLOSING,
  WS_CONNECTING,
  WS_OPEN,
  buildDiscoverResponse,
  buildPluginStateResponse,
  isPluginMessageType,
  newMessageId,
  type ConnectEnvelope,
  type ManualOverrideDetection,
  type PluginMessageTypeName,
  type WebSocketFactory,
  type WebSocketLike,
} from '../../src/plugin/connect/index.js';
import { HcuSourceCache } from '../../src/plugin/sources/hcu.js';
import { emptyRuntimeState } from '../../src/plugin/persistence/state.js';

const PLUGIN_ID = 'de.fr.renner.plugin.heatshield';
const URL = 'wss://host.containers.internal:9001';
const AUTH_TOKEN = 'TESTTOKEN-0123456789ABCDEF';

/**
 * Spec paths the plugin is allowed to send in `HMIP_SYSTEM_REQUEST`.
 * Anything else means the plugin invented a path and the HCU would
 * answer `ERROR_RESPONSE`.
 */
const ALLOWED_HMIP_SYSTEM_PATHS: ReadonlySet<string> = new Set([
  '/hmip/device/control/setShutterLevel',
  '/hmip/home/getSystemState',
]);

/**
 * Closed set of feature `type` strings the plugin emits on its own
 * SWITCH devices (DISCOVER_RESPONSE / STATUS_EVENT). Spec §6.6.6
 * enumerates many more, but Heat Shield owns no other device type so
 * any other value here would mean a wiring bug.
 */
const ALLOWED_OWN_FEATURE_TYPES: ReadonlySet<string> = new Set([
  'switchState',
  'maintenance',
]);

/**
 * `ShadingDirection` enum (§6.6.12). Used by the recursive walk to
 * reject any leaked `STOPPED` value (steering: anti-pattern).
 */
const ALLOWED_SHADING_DIRECTIONS: ReadonlySet<string> = new Set([
  'DARKER',
  'LIGHTER',
]);

// ---------------------------------------------------------------------------
// InProcessHcuMock — WebSocketLike fake that plays the HCU.
// ---------------------------------------------------------------------------

type WsListener = (...args: unknown[]) => void;

/**
 * In-process stand-in for the HCU. Implements {@link WebSocketLike}
 * so {@link ConnectClient} consumes it via `wsFactory`.
 *
 * Beyond the WebSocket surface, the mock:
 *
 *   - captures every outbound envelope (parsed back to JS) in
 *     {@link captured},
 *   - feeds every captured envelope through
 *     {@link validateOutboundEnvelope} and stores any error string in
 *     {@link validationErrors},
 *   - exposes {@link triggerOpen}, {@link respondToRequest},
 *     {@link pushEvent}, and {@link pushDiscoverRequest} so tests can
 *     drive the inbound side of the connection deterministically.
 */
class InProcessHcuMock implements WebSocketLike {
  /** Every outbound envelope, in send order, JSON-roundtripped. */
  public readonly captured: ConnectEnvelope[] = [];

  /** Every raw outbound payload, in send order. */
  public readonly capturedRaw: string[] = [];

  /** Validator findings — empty array means every envelope was clean. */
  public readonly validationErrors: Array<{
    index: number;
    error: string;
    envelope: ConnectEnvelope | null;
  }> = [];

  public readyState: number = WS_CONNECTING;

  private readonly listeners: Record<string, WsListener[]> = {
    open: [],
    message: [],
    close: [],
    error: [],
  };

  /**
   * Capture, parse, and validate every outbound envelope. If JSON
   * parsing fails, the validation error array gets a synthetic
   * "malformed JSON" entry — the test would still notice because the
   * `validationErrors` array is non-empty.
   */
  public send(data: string): void {
    this.capturedRaw.push(data);
    let parsed: ConnectEnvelope | null = null;
    try {
      parsed = JSON.parse(data) as ConnectEnvelope;
    } catch (err) {
      this.validationErrors.push({
        index: this.capturedRaw.length - 1,
        error: `outbound JSON parse failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
        envelope: null,
      });
      return;
    }
    this.captured.push(parsed);
    const error = validateOutboundEnvelope(parsed);
    if (error !== null) {
      this.validationErrors.push({
        index: this.captured.length - 1,
        error,
        envelope: parsed,
      });
    }
  }

  public close(_code?: number, _reason?: string): void {
    this.readyState = WS_CLOSING;
    queueMicrotask(() => {
      this.readyState = WS_CLOSED;
      for (const l of this.listeners['close'] ?? []) {
        l(_code ?? 1000, _reason ?? '');
      }
    });
  }

  public on(
    event: 'open' | 'close' | 'error' | 'message',
    listener: (...args: unknown[]) => void,
  ): unknown {
    const bucket = this.listeners[event];
    if (bucket !== undefined) {
      bucket.push(listener);
    }
    return this;
  }

  /** Drive the open transition; lets ConnectClient.start finish. */
  public triggerOpen(): void {
    this.readyState = WS_OPEN;
    for (const l of this.listeners['open'] ?? []) {
      l();
    }
  }

  /**
   * Push an `HMIP_SYSTEM_RESPONSE` envelope as if it came from the
   * HCU. `body` is the inner spec body (e.g. the `getSystemState`
   * payload); the wrapper `{ code, body }` is added here.
   */
  public respondToRequest(
    envelopeId: string,
    code: number,
    body?: unknown,
  ): void {
    const envelope: ConnectEnvelope = {
      id: envelopeId,
      pluginId: PLUGIN_ID,
      type: PluginMessageType.HMIP_SYSTEM_RESPONSE,
      body: body === undefined ? { code } : { code, body },
    };
    this.deliver(envelope);
  }

  /**
   * Push an `HMIP_SYSTEM_EVENT` envelope. `body` is the event
   * transaction payload (the same shape `HcuSourceCache.applyEvent`
   * accepts).
   */
  public pushEvent(body: unknown): void {
    const envelope: ConnectEnvelope = {
      id: newMessageId(),
      pluginId: PLUGIN_ID,
      type: PluginMessageType.HMIP_SYSTEM_EVENT,
      body,
    };
    this.deliver(envelope);
  }

  /**
   * Push a `DISCOVER_REQUEST` envelope. The plugin replies with a
   * `DISCOVER_RESPONSE` whose id echoes the request id (Spec
   * §6.2.1).
   */
  public pushDiscoverRequest(envelopeId = newMessageId()): string {
    const envelope: ConnectEnvelope = {
      id: envelopeId,
      pluginId: PLUGIN_ID,
      type: PluginMessageType.DISCOVER_REQUEST,
    };
    this.deliver(envelope);
    return envelopeId;
  }

  /**
   * Push an arbitrary inbound envelope. Used by Test 3 to drive
   * `CONTROL_REQUEST` flows through `OwnDeviceManager`.
   */
  public deliver(envelope: ConnectEnvelope): void {
    const payload = JSON.stringify(envelope);
    for (const l of this.listeners['message'] ?? []) {
      l(payload);
    }
  }
}

/**
 * WebSocket factory that returns a single shared {@link
 * InProcessHcuMock} instance. The harness function below builds a
 * fresh mock per test.
 */
function makeFactory(mock: InProcessHcuMock): WebSocketFactory {
  return (_url, _options) => mock;
}

// ---------------------------------------------------------------------------
// validateOutboundEnvelope — the steering rules in code form.
// ---------------------------------------------------------------------------

/**
 * Validate one outbound envelope. Returns `null` on success, an
 * error string on failure. The function mirrors the strictness of
 * the HCU's Java backend: any deviation rejects the whole envelope.
 */
function validateOutboundEnvelope(env: ConnectEnvelope): string | null {
  // Spec §6.2.1 — no `category` field on the envelope.
  if ('category' in env) {
    return 'envelope carries forbidden `category` field (Spec §6.2.1)';
  }

  // Required envelope fields.
  if (typeof env.id !== 'string' || env.id.length === 0) {
    return 'envelope missing string `id`';
  }
  if (env.pluginId !== PLUGIN_ID) {
    return `envelope pluginId mismatch: got ${String(env.pluginId)}`;
  }

  // Closed `PluginMessageType` set (§6.6.8).
  if (typeof env.type !== 'string' || !isPluginMessageType(env.type)) {
    return `envelope type ${String(env.type)} is not in PluginMessageType`;
  }
  const type: PluginMessageTypeName = env.type;

  // Recursive checks: never `shutterDirection: 'STOPPED'`, never
  // `dataType: 'ENUM'`, every `shutterDirection` is a valid enum.
  const recursiveError = walkBodyForBannedValues(env.body);
  if (recursiveError !== null) {
    return recursiveError;
  }

  // Type-specific checks.
  switch (type) {
    case PluginMessageType.DISCOVER_RESPONSE:
      return validateDiscoverResponseBody(env.body);
    case PluginMessageType.HMIP_SYSTEM_REQUEST:
      return validateHmipSystemRequestBody(env.body);
    case PluginMessageType.STATUS_EVENT:
      return validateStatusEventBody(env.body);
    case PluginMessageType.PLUGIN_STATE_RESPONSE:
      return validatePluginStateResponseBody(env.body);
    case PluginMessageType.CONTROL_RESPONSE:
      return validateControlResponseBody(env.body);
    default:
      return null;
  }
}

/**
 * Walk an arbitrary value and reject any object node that carries a
 * banned key/value combination:
 *
 *   - `shutterDirection: 'STOPPED'` (steering: never invent an enum
 *     value),
 *   - `dataType: 'ENUM'` (steering: HCUweb renders empty for it),
 *   - any `shutterDirection` whose value is not in
 *     {@link ALLOWED_SHADING_DIRECTIONS}.
 *
 * Tolerant of arbitrary nesting; arrays and objects both descended.
 */
function walkBodyForBannedValues(node: unknown): string | null {
  if (node === null || typeof node !== 'object') {
    return null;
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      const err = walkBodyForBannedValues(child);
      if (err !== null) {
        return err;
      }
    }
    return null;
  }
  const obj = node as Record<string, unknown>;
  if ('shutterDirection' in obj) {
    const v = obj['shutterDirection'];
    if (typeof v !== 'string') {
      return 'shutterDirection must be a string';
    }
    if (v === 'STOPPED') {
      return 'shutterDirection: "STOPPED" is forbidden (steering)';
    }
    if (!ALLOWED_SHADING_DIRECTIONS.has(v)) {
      return `shutterDirection: "${v}" is not in ShadingDirection enum`;
    }
  }
  if ('dataType' in obj && obj['dataType'] === 'ENUM') {
    return 'dataType: "ENUM" is forbidden (steering)';
  }
  for (const value of Object.values(obj)) {
    const err = walkBodyForBannedValues(value);
    if (err !== null) {
      return err;
    }
  }
  return null;
}

function validateDiscoverResponseBody(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) {
    return 'DISCOVER_RESPONSE body must be an object';
  }
  const obj = body as Record<string, unknown>;
  if (obj['success'] !== true) {
    return 'DISCOVER_RESPONSE.body.success must be true';
  }
  const devices = obj['devices'];
  if (!Array.isArray(devices)) {
    return 'DISCOVER_RESPONSE.body.devices must be an array';
  }
  for (const d of devices) {
    if (typeof d !== 'object' || d === null) {
      return 'DISCOVER_RESPONSE device entry must be an object';
    }
    const dev = d as Record<string, unknown>;
    if (dev['deviceType'] !== 'SWITCH') {
      return `DISCOVER_RESPONSE device deviceType must be SWITCH, got ${String(
        dev['deviceType'],
      )}`;
    }
    const features = dev['features'];
    if (!Array.isArray(features)) {
      return 'DISCOVER_RESPONSE device.features must be an array';
    }
    for (const f of features) {
      if (typeof f !== 'object' || f === null) {
        return 'DISCOVER_RESPONSE feature entry must be an object';
      }
      const t = (f as Record<string, unknown>)['type'];
      if (typeof t !== 'string' || !ALLOWED_OWN_FEATURE_TYPES.has(t)) {
        return `DISCOVER_RESPONSE feature.type ${String(t)} is not allowed`;
      }
    }
  }
  return null;
}

function validateHmipSystemRequestBody(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) {
    return 'HMIP_SYSTEM_REQUEST body must be an object';
  }
  const obj = body as Record<string, unknown>;
  const path = obj['path'];
  if (typeof path !== 'string') {
    return 'HMIP_SYSTEM_REQUEST.body.path must be a string';
  }
  if (!ALLOWED_HMIP_SYSTEM_PATHS.has(path)) {
    return `HMIP_SYSTEM_REQUEST.body.path ${path} is not in the allowed set`;
  }
  if (typeof obj['body'] !== 'object' || obj['body'] === null) {
    return 'HMIP_SYSTEM_REQUEST.body.body must be an object';
  }
  return null;
}

function validateStatusEventBody(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) {
    return 'STATUS_EVENT body must be an object';
  }
  const obj = body as Record<string, unknown>;
  if (typeof obj['deviceId'] !== 'string') {
    return 'STATUS_EVENT.body.deviceId must be a string';
  }
  const features = obj['features'];
  if (!Array.isArray(features)) {
    return 'STATUS_EVENT.body.features must be an array';
  }
  if (features.length === 0) {
    return 'STATUS_EVENT.body.features must contain at least one feature';
  }
  for (const f of features) {
    if (typeof f !== 'object' || f === null) {
      return 'STATUS_EVENT feature entry must be an object';
    }
    const t = (f as Record<string, unknown>)['type'];
    if (typeof t !== 'string' || !ALLOWED_OWN_FEATURE_TYPES.has(t)) {
      return `STATUS_EVENT feature.type ${String(t)} is not allowed`;
    }
    // Steering: STATUS_EVENT must not carry `shutterDirection` for
    // HCU-owned shutters — and the plugin has no business sending a
    // `shutterDirection` field on its own SWITCH devices either.
    if ('shutterDirection' in (f as Record<string, unknown>)) {
      return 'STATUS_EVENT feature must not carry shutterDirection';
    }
  }
  return null;
}

function validatePluginStateResponseBody(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) {
    return 'PLUGIN_STATE_RESPONSE body must be an object';
  }
  const status = (body as Record<string, unknown>)['pluginReadinessStatus'];
  if (
    status !== PluginReadinessStatus.READY &&
    status !== PluginReadinessStatus.CONFIG_REQUIRED &&
    status !== PluginReadinessStatus.ERROR
  ) {
    return `PLUGIN_STATE_RESPONSE pluginReadinessStatus invalid: ${String(
      status,
    )}`;
  }
  return null;
}

function validateControlResponseBody(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) {
    return 'CONTROL_RESPONSE body must be an object';
  }
  const obj = body as Record<string, unknown>;
  if (typeof obj['success'] !== 'boolean') {
    return 'CONTROL_RESPONSE.body.success must be a boolean';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Harness — wires ConnectClient + adapters around the mock.
// ---------------------------------------------------------------------------

interface Harness {
  readonly mock: InProcessHcuMock;
  readonly client: ConnectClient;
  readonly cache: HcuSourceCache;
  readonly hmip: HmipSystemAdapter;
  readonly own: OwnDeviceManager;
}

/**
 * Build a fresh harness. Adapter `now` defaults to `() => new Date()`
 * so vitest fake timers control it deterministically when the test
 * uses `vi.useFakeTimers`.
 */
function makeHarness(): Harness {
  const mock = new InProcessHcuMock();
  const client = new ConnectClient({
    url: URL,
    pluginId: PLUGIN_ID,
    authToken: AUTH_TOKEN,
    receiveSystemEvents: true,
    wsFactory: makeFactory(mock),
  });
  const cache = new HcuSourceCache();
  const hmip = new HmipSystemAdapter({
    client,
    pluginId: PLUGIN_ID,
    cache,
  });
  const own = new OwnDeviceManager({ pluginId: PLUGIN_ID });

  // Wire the OwnDeviceManager's outbound envelopes to the client.
  // The orchestrator does this in production; the integration test
  // mirrors the production wiring so the validator sees the full
  // STATUS_EVENT / CONTROL_RESPONSE traffic.
  own.on('controlResponse', (env) => client.send(env));
  own.on('statusEvent', (env) => client.send(env));

  // Inbound CONTROL_REQUEST → OwnDeviceManager.
  client.on('message', (envelope) => {
    if (envelope.type === PluginMessageType.CONTROL_REQUEST) {
      own.handleControlRequest(envelope);
    }
  });

  hmip.start();
  client.start();

  return { mock, client, cache, hmip, own };
}

/**
 * Stop the harness cleanly. Important when fake timers are in
 * effect: `client.stop()` resolves on the close handshake, which the
 * mock fires on a microtask.
 */
async function stopHarness(h: Harness): Promise<void> {
  h.hmip.stop();
  await h.client.stop();
}

// ---------------------------------------------------------------------------
// Test 1 — DISCOVER produces no ERROR_RESPONSE.
// ---------------------------------------------------------------------------

describe('Connect API end-to-end — DISCOVER produces no ERROR_RESPONSE', () => {
  it('sends PluginStateResponse + DiscoverResponse on open, both pass validation', async () => {
    const h = makeHarness();

    // Subscribe to 'open' before triggering it. ConnectClient.start
    // already wired the underlying socket; the mock fires open
    // synchronously when triggered.
    h.client.on('open', () => {
      h.client.send(
        buildPluginStateResponse({
          pluginId: PLUGIN_ID,
          status: PluginReadinessStatus.READY,
        }),
      );
      h.client.send(
        buildDiscoverResponse({
          pluginId: PLUGIN_ID,
          switchStates: emptyRuntimeState().ownSwitches,
          health: { fusionSolar: true, hcu: true },
        }),
      );
    });

    h.mock.triggerOpen();

    // At least the two envelopes we registered above.
    expect(h.mock.captured.length).toBeGreaterThanOrEqual(2);

    // First envelope must be PLUGIN_STATE_RESPONSE (READY), second
    // DISCOVER_RESPONSE with five SWITCH devices.
    const first = h.mock.captured[0];
    const second = h.mock.captured[1];
    expect(first?.type).toBe(PluginMessageType.PLUGIN_STATE_RESPONSE);
    expect(
      (first?.body as { pluginReadinessStatus?: string } | undefined)
        ?.pluginReadinessStatus,
    ).toBe(PluginReadinessStatus.READY);

    expect(second?.type).toBe(PluginMessageType.DISCOVER_RESPONSE);
    const discoverBody = second?.body as {
      success: boolean;
      devices: Array<{ deviceType: string }>;
    };
    expect(discoverBody.success).toBe(true);
    expect(discoverBody.devices).toHaveLength(5);
    for (const dev of discoverBody.devices) {
      expect(dev.deviceType).toBe('SWITCH');
    }

    // No ERROR_RESPONSE was generated by validation: the validator
    // collected zero errors.
    expect(h.mock.validationErrors).toEqual([]);

    // The plugin itself never emits an ERROR_RESPONSE in this flow.
    const errorResponses = h.mock.captured.filter(
      (e) => e.type === PluginMessageType.ERROR_RESPONSE,
    );
    expect(errorResponses).toEqual([]);

    await stopHarness(h);
  });
});

// ---------------------------------------------------------------------------
// Test 2 — setShutterLevel + manual override.
// ---------------------------------------------------------------------------

describe('Connect API end-to-end — setShutterLevel + manual override', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-21T10:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends one HMIP_SYSTEM_REQUEST, resolves on code 200, then detects a manual override after 50 s', async () => {
    const h = makeHarness();
    const overrides: ManualOverrideDetection[] = [];
    h.hmip.on('manualOverride', (d) => overrides.push(d));

    // The standard READY+DISCOVER handshake on open, so the mock's
    // validation history stays representative across the whole flow.
    h.client.on('open', () => {
      h.client.send(
        buildPluginStateResponse({
          pluginId: PLUGIN_ID,
          status: PluginReadinessStatus.READY,
        }),
      );
      h.client.send(
        buildDiscoverResponse({
          pluginId: PLUGIN_ID,
          switchStates: emptyRuntimeState().ownSwitches,
          health: { fusionSolar: true, hcu: true },
        }),
      );
    });
    h.mock.triggerOpen();

    const captureBeforeSet = h.mock.captured.length;

    // Drive the shutter command. The mock captures the envelope
    // synchronously as part of `client.send` inside setShutterLevel.
    const setPromise = h.hmip.setShutterLevel('shutter-1', 1, 0.0);

    // Exactly one new envelope was sent — the HMIP_SYSTEM_REQUEST.
    expect(h.mock.captured.length).toBe(captureBeforeSet + 1);
    const reqEnvelope = h.mock.captured[captureBeforeSet];
    if (!reqEnvelope) throw new Error('expected HMIP_SYSTEM_REQUEST envelope');
    expect(reqEnvelope.type).toBe(PluginMessageType.HMIP_SYSTEM_REQUEST);

    const reqBody = reqEnvelope.body as {
      path: string;
      body: { deviceId: string; channelIndex: number; shutterLevel: number };
    };
    expect(reqBody.path).toBe('/hmip/device/control/setShutterLevel');
    expect(reqBody.body).toEqual({
      shutterLevel: 0.0,
      channelIndex: 1,
      deviceId: 'shutter-1',
    });

    // Mock acks with 200; the plugin promise resolves.
    h.mock.respondToRequest(reqEnvelope.id, 200);
    await expect(setPromise).resolves.toBeUndefined();

    // Advance the fake clock by 50 s. The HmipSystemAdapter's
    // injected `now` defaults to `() => new Date()` so this also
    // moves the clock the manual-override detector sees.
    await vi.advanceTimersByTimeAsync(50_000);

    // Mock fires an HMIP_SYSTEM_EVENT with shutterLevel=0.5 — outside
    // the 30 s grace window AND outside the 0.05 snap tolerance from
    // the commanded 0.0. The adapter must surface it as manual.
    h.mock.pushEvent({
      eventTransaction: {
        accessPointId: 'AP',
        events: {
          '0': {
            pushEventType: 'DEVICE_CHANGED',
            device: {
              id: 'shutter-1',
              type: 'WINDOW_COVERING',
              functionalChannels: {
                '1': {
                  functionalChannelType: 'SHUTTER_CHANNEL',
                  index: 1,
                  groupIndex: 1,
                  deviceId: 'shutter-1',
                  shutterLevel: 0.5,
                },
              },
            },
          },
        },
        origin: { type: 'DEVICE' },
      },
    });

    expect(overrides).toHaveLength(1);
    const det = overrides[0];
    if (!det) throw new Error('expected manual override detection');
    expect(det.deviceId).toBe('shutter-1');
    expect(det.observedLevel).toBe(0.5);
    expect(det.lastCommandedLevel).toBe(0.0);
    expect(det.lastCommandedAt?.toISOString()).toBe(
      '2026-06-21T10:00:00.000Z',
    );

    // No validation errors from the whole flow.
    expect(h.mock.validationErrors).toEqual([]);

    await stopHarness(h);
  });
});

// ---------------------------------------------------------------------------
// Test 3 — Spec compliance smoke.
// ---------------------------------------------------------------------------

describe('Connect API end-to-end — spec compliance smoke', () => {
  it('DISCOVER + a few CONTROL_REQUESTs produce zero validation errors', async () => {
    const h = makeHarness();

    h.client.on('open', () => {
      h.client.send(
        buildPluginStateResponse({
          pluginId: PLUGIN_ID,
          status: PluginReadinessStatus.READY,
        }),
      );
      h.client.send(
        buildDiscoverResponse({
          pluginId: PLUGIN_ID,
          switchStates: emptyRuntimeState().ownSwitches,
          health: { fusionSolar: true, hcu: true },
        }),
      );
    });
    h.mock.triggerOpen();

    // Seed the OwnDeviceManager with an engine-confirmed baseline
    // so the inbound CONTROL_REQUESTs below are evaluated against
    // a real prior value, not against `null`. Without
    // `engineConfirmed: true`, `loadCache` would leave the
    // engine-confirmed baseline empty and the first
    // `confirmFromEngine` call per switch would also emit a
    // (correct but unrelated) STATUS_EVENT.
    const seededSwitches = emptyRuntimeState().ownSwitches.map((s) => ({
      ...s,
      engineConfirmed: true,
    }));
    h.own.loadCache(seededSwitches);

    // Three inbound CONTROL_REQUESTs from the HCU. Each must be
    // answered with a CONTROL_RESPONSE (success: true) — the
    // validator checks that CONTROL_RESPONSEs are well-formed. The
    // OwnDeviceManager wiring above forwards both controlResponse
    // and statusEvent to client.send, so every artifact passes
    // through the validator.
    h.mock.deliver({
      id: 'req-pause-on',
      pluginId: PLUGIN_ID,
      type: PluginMessageType.CONTROL_REQUEST,
      body: {
        deviceId: 'heatshield-control-pause',
        features: [{ type: 'switchState', on: true }],
      },
    });
    h.mock.deliver({
      id: 'req-vacation-on',
      pluginId: PLUGIN_ID,
      type: PluginMessageType.CONTROL_REQUEST,
      body: {
        deviceId: 'heatshield-control-vacation',
        features: [{ type: 'switchState', on: true }],
      },
    });
    h.mock.deliver({
      id: 'req-pause-off',
      pluginId: PLUGIN_ID,
      type: PluginMessageType.CONTROL_REQUEST,
      body: {
        deviceId: 'heatshield-control-pause',
        features: [{ type: 'switchState', on: false }],
      },
    });

    // The engine ratifies the user inputs. Each confirm differs from
    // the previously-confirmed value, so each emits exactly one
    // STATUS_EVENT. The validator then checks each STATUS_EVENT.
    h.own.confirmFromEngine('heatshield-control-pause', true);
    h.own.confirmFromEngine('heatshield-control-vacation', true);
    h.own.confirmFromEngine('heatshield-control-pause', false);

    // Drive a follow-up DISCOVER_REQUEST so the validator sees the
    // reply path with an echoed id too.
    h.mock.pushDiscoverRequest('req-discover-rerun');
    h.client.send(
      buildDiscoverResponse({
        pluginId: PLUGIN_ID,
        replyTo: {
          id: 'req-discover-rerun',
          pluginId: PLUGIN_ID,
          type: PluginMessageType.DISCOVER_REQUEST,
        },
        switchStates: emptyRuntimeState().ownSwitches,
        health: { fusionSolar: true, hcu: true },
      }),
    );

    // Zero validation errors across every captured envelope.
    expect(h.mock.validationErrors).toEqual([]);

    // Sanity: every captured envelope round-trips through JSON
    // cleanly and re-passes the validator (the body of the test
    // already validated the live versions; this is the explicit
    // "JSON-roundtrip each" assertion from the task brief).
    for (const raw of h.mock.capturedRaw) {
      const env = JSON.parse(raw) as ConnectEnvelope;
      const err = validateOutboundEnvelope(env);
      expect(err).toBeNull();
    }

    // STATUS_EVENT-specific checks: each carries exactly the one
    // changed feature and no `shutterDirection`.
    const statusEvents = h.mock.captured.filter(
      (e) => e.type === PluginMessageType.STATUS_EVENT,
    );
    expect(statusEvents.length).toBe(3);
    for (const ev of statusEvents) {
      const body = ev.body as {
        deviceId: string;
        features: Array<Record<string, unknown>>;
      };
      expect(body.features).toHaveLength(1);
      const f = body.features[0];
      expect(f).toBeDefined();
      if (!f) throw new Error('expected feature entry');
      expect(f['type']).toBe('switchState');
      expect('shutterDirection' in f).toBe(false);
    }

    // No ERROR_RESPONSE at any point.
    const errorResponses = h.mock.captured.filter(
      (e) => e.type === PluginMessageType.ERROR_RESPONSE,
    );
    expect(errorResponses).toEqual([]);

    // Three CONTROL_RESPONSEs were sent (one per inbound request).
    const controlResponses = h.mock.captured.filter(
      (e) => e.type === PluginMessageType.CONTROL_RESPONSE,
    );
    expect(controlResponses).toHaveLength(3);
    for (const cr of controlResponses) {
      const body = cr.body as { success: boolean };
      expect(body.success).toBe(true);
    }

    await stopHarness(h);
  });
});
