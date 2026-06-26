/**
 * Heat Shield — HmipSystem adapter unit tests (Task 6.5).
 *
 * No real network. The adapter consumes a {@link ConnectClient} via
 * the `'message'` event surface and `send()`; tests therefore wire a
 * tiny `FakeClient` that implements the same surface but lets the
 * test inject inbound envelopes directly.
 *
 * Coverage map:
 *   - `setShutterLevel` produces a single envelope with the correct
 *     path / inner body and resolves on `code === 200`.
 *   - `getSystemState` produces the correct envelope and populates
 *     the cache.
 *   - Non-200 responses reject the pending promise.
 *   - Request timeout: 5 s without a response rejects with the
 *     documented error message.
 *   - Manual-override detection, all four branches:
 *       - within grace window         → no emit
 *       - outside grace, within snap  → no emit
 *       - outside grace, outside snap → emit
 *       - never commanded             → emit (once)
 *   - `start()` / `stop()` are idempotent.
 *   - `getLastCommanded` returns the recorded command (or null).
 */

import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ConnectClient,
  ConnectEnvelope,
} from '../../src/plugin/connect/client.js';
import { PluginMessageType } from '../../src/plugin/connect/envelope.js';
import {
  HmipSystemAdapter,
  type ManualOverrideDetection,
  type ShutterCommand,
} from '../../src/plugin/connect/hmipSystem.js';
import { HcuSourceCache } from '../../src/plugin/sources/hcu.js';

// ---------------------------------------------------------------------------
// FakeClient — structural stand-in for ConnectClient.
// ---------------------------------------------------------------------------

/**
 * Minimal `ConnectClient`-shaped fake. Records every outbound
 * envelope in `sent`; `emit('message', envelope)` mimics the
 * client's inbound dispatch.
 *
 * Casting to `ConnectClient` at the `new HmipSystemAdapter` boundary
 * is safe because we only consume the `on(...)`, `off(...)`, and
 * `send(...)` surface — none of the WebSocket-specific machinery is
 * touched.
 */
class FakeClient extends EventEmitter {
  public readonly sent: ConnectEnvelope[] = [];

  public send(envelope: ConnectEnvelope): void {
    this.sent.push(envelope);
  }
}

const PLUGIN_ID = 'de.fr.renner.plugin.heatshield';

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

interface Harness {
  readonly client: FakeClient;
  readonly cache: HcuSourceCache;
  readonly adapter: HmipSystemAdapter;
  readonly nowRef: { current: Date };
}

function makeHarness(
  initialNow: Date = new Date('2026-06-21T10:00:00.000Z'),
  options: { snapTolerance?: number; manualOverrideGraceMs?: number } = {},
): Harness {
  const client = new FakeClient();
  const nowRef = { current: initialNow };
  const cache = new HcuSourceCache({ now: () => nowRef.current });
  const adapter = new HmipSystemAdapter({
    client: client as unknown as ConnectClient,
    pluginId: PLUGIN_ID,
    cache,
    now: () => nowRef.current,
    ...(options.snapTolerance !== undefined
      ? { snapTolerance: options.snapTolerance }
      : {}),
    ...(options.manualOverrideGraceMs !== undefined
      ? { manualOverrideGraceMs: options.manualOverrideGraceMs }
      : {}),
  });
  adapter.start();
  return { client, cache, adapter, nowRef };
}

/** Build an inbound `HMIP_SYSTEM_RESPONSE` envelope. */
function responseEnvelope(
  id: string,
  code: number,
  body?: unknown,
): ConnectEnvelope {
  const env: ConnectEnvelope = {
    id,
    pluginId: PLUGIN_ID,
    type: PluginMessageType.HMIP_SYSTEM_RESPONSE,
    body: body === undefined ? { code } : { code, body },
  };
  return env;
}

/**
 * Build an `HMIP_SYSTEM_EVENT` envelope whose transaction reports
 * one device with the given shutter level on a single channel.
 */
function shutterEventEnvelope(
  deviceId: string,
  shutterLevel: number,
): ConnectEnvelope {
  return {
    id: 'evt-' + deviceId,
    pluginId: PLUGIN_ID,
    type: PluginMessageType.HMIP_SYSTEM_EVENT,
    body: {
      eventTransaction: {
        accessPointId: 'AP',
        events: {
          '0': {
            pushEventType: 'DEVICE_CHANGED',
            device: {
              id: deviceId,
              type: 'WINDOW_COVERING',
              functionalChannels: {
                '1': {
                  functionalChannelType: 'SHUTTER_CHANNEL',
                  index: 1,
                  groupIndex: 1,
                  deviceId,
                  shutterLevel,
                },
              },
            },
          },
        },
        origin: { type: 'DEVICE' },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// setShutterLevel.
// ---------------------------------------------------------------------------

describe('HmipSystemAdapter — setShutterLevel', () => {
  it('sends a single envelope with the right path and body, resolves on code 200', async () => {
    const { client, adapter } = makeHarness();
    const commands: ShutterCommand[] = [];
    adapter.on('shutterCommanded', (cmd) => commands.push(cmd));

    const promise = adapter.setShutterLevel('shutter-bedroom', 1, 0.5);

    // Exactly one envelope was sent and `'shutterCommanded'` fired
    // before it went out.
    expect(client.sent).toHaveLength(1);
    expect(commands).toEqual([
      { deviceId: 'shutter-bedroom', channelIndex: 1, level01: 0.5 },
    ]);

    const env = client.sent[0];
    if (!env) throw new Error('expected envelope');
    expect(env.type).toBe(PluginMessageType.HMIP_SYSTEM_REQUEST);
    expect(env.pluginId).toBe(PLUGIN_ID);
    expect(typeof env.id).toBe('string');
    expect(env.body).toEqual({
      path: '/hmip/device/control/setShutterLevel',
      body: {
        shutterLevel: 0.5,
        channelIndex: 1,
        deviceId: 'shutter-bedroom',
      },
    });

    // Inject the matching response.
    client.emit('message', responseEnvelope(env.id, 200));

    await expect(promise).resolves.toBeUndefined();
  });

  it('rejects when the response carries a non-200 code', async () => {
    const { client, adapter } = makeHarness();
    const promise = adapter.setShutterLevel('shutter-bedroom', 1, 0.5);

    const env = client.sent[0];
    if (!env) throw new Error('expected envelope');
    client.emit('message', responseEnvelope(env.id, 400));

    await expect(promise).rejects.toThrow(/code 400/);
  });

  it('records last commanded level + timestamp before sending', () => {
    const initialNow = new Date('2026-06-21T10:00:00.000Z');
    const { adapter } = makeHarness(initialNow);

    void adapter.setShutterLevel('shutter-bedroom', 1, 0.7);

    const last = adapter.getLastCommanded('shutter-bedroom');
    expect(last).not.toBeNull();
    expect(last?.level).toBe(0.7);
    expect(last?.at.getTime()).toBe(initialNow.getTime());
  });

  it('returns null from getLastCommanded for never-commanded devices', () => {
    const { adapter } = makeHarness();
    expect(adapter.getLastCommanded('unknown-shutter')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getSystemState.
// ---------------------------------------------------------------------------

describe('HmipSystemAdapter — getSystemState', () => {
  it('sends the right envelope, populates the cache, emits systemStateLoaded', async () => {
    const { client, cache, adapter } = makeHarness();
    let loaded = 0;
    adapter.on('systemStateLoaded', () => {
      loaded += 1;
    });

    const promise = adapter.getSystemState();

    expect(client.sent).toHaveLength(1);
    const env = client.sent[0];
    if (!env) throw new Error('expected envelope');
    expect(env.type).toBe(PluginMessageType.HMIP_SYSTEM_REQUEST);
    expect(env.body).toEqual({
      path: '/hmip/home/getSystemState',
      body: {},
    });

    // Inject a system-state response.
    client.emit(
      'message',
      responseEnvelope(env.id, 200, {
        devices: {
          'climate-bedroom': {
            id: 'climate-bedroom',
            type: 'CLIMATE_SENSOR',
            label: 'Wandsensor Schlafzimmer',
            modelType: 'HmIP-STH',
            functionalChannels: {
              '1': {
                functionalChannelType: 'CLIMATE_SENSOR_CHANNEL',
                index: 1,
                groupIndex: 1,
                deviceId: 'climate-bedroom',
                actualTemperature: 23.4,
              },
            },
          },
        },
      }),
    );

    await expect(promise).resolves.toBeUndefined();
    expect(loaded).toBe(1);
    expect(cache.listDevices().map((d) => d.deviceId)).toEqual([
      'climate-bedroom',
    ]);
    expect(
      cache.getFeature('climate-bedroom', 'actualTemperature')?.value,
    ).toBe(23.4);
  });

  it('rejects on non-200 response', async () => {
    const { client, adapter } = makeHarness();
    const promise = adapter.getSystemState();
    const env = client.sent[0];
    if (!env) throw new Error('expected envelope');
    client.emit('message', responseEnvelope(env.id, 500));
    await expect(promise).rejects.toThrow(/code 500/);
  });
});

// ---------------------------------------------------------------------------
// Request timeout.
// ---------------------------------------------------------------------------

describe('HmipSystemAdapter — request timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects with the documented error after 5 seconds with no response', async () => {
    const { adapter } = makeHarness();
    const promise = adapter.setShutterLevel('shutter-bedroom', 1, 0.5);
    // Attach a rejection handler immediately so the timer rejection
    // is consumed even if the test fails before awaiting.
    const settled = promise.catch((err: Error) => err);

    // Just before the deadline: still pending.
    await vi.advanceTimersByTimeAsync(4_999);

    // Cross the deadline.
    await vi.advanceTimersByTimeAsync(2);

    const result = await settled;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toBe('HMIP_SYSTEM_REQUEST timed out');
  });
});

// ---------------------------------------------------------------------------
// Manual-override detection.
// ---------------------------------------------------------------------------

describe('HmipSystemAdapter — manual override detection', () => {
  it('emits manualOverride when an event arrives outside grace and outside snap tolerance', async () => {
    const T0 = new Date('2026-06-21T10:00:00.000Z');
    const { client, adapter, nowRef } = makeHarness(T0);
    const overrides: ManualOverrideDetection[] = [];
    adapter.on('manualOverride', (d) => overrides.push(d));

    // T0: command shutter to 0.0 and resolve 200.
    const cmd = adapter.setShutterLevel('shutter1', 1, 0.0);
    const sent = client.sent[0];
    if (!sent) throw new Error('expected envelope');
    client.emit('message', responseEnvelope(sent.id, 200));
    await cmd;

    // T0 + 50 s: shutterLevel 0.5 reported → outside grace (30 s)
    // and outside snap tolerance (default 0.05) → manual override.
    nowRef.current = new Date(T0.getTime() + 50_000);
    client.emit('message', shutterEventEnvelope('shutter1', 0.5));

    expect(overrides).toHaveLength(1);
    const det = overrides[0];
    if (!det) throw new Error('expected detection');
    expect(det.deviceId).toBe('shutter1');
    expect(det.observedLevel).toBe(0.5);
    expect(det.lastCommandedLevel).toBe(0.0);
    expect(det.lastCommandedAt?.getTime()).toBe(T0.getTime());
  });

  it('does NOT emit when an event arrives within the grace window', async () => {
    const T0 = new Date('2026-06-21T10:00:00.000Z');
    const { client, adapter, nowRef } = makeHarness(T0);
    const overrides: ManualOverrideDetection[] = [];
    adapter.on('manualOverride', (d) => overrides.push(d));

    const cmd = adapter.setShutterLevel('shutter1', 1, 0.0);
    const sent = client.sent[0];
    if (!sent) throw new Error('expected envelope');
    client.emit('message', responseEnvelope(sent.id, 200));
    await cmd;

    // T0 + 5 s: still within grace window → no emit.
    nowRef.current = new Date(T0.getTime() + 5_000);
    client.emit('message', shutterEventEnvelope('shutter1', 0.5));

    expect(overrides).toHaveLength(0);
  });

  it('does NOT emit when the observed level is within snap tolerance of the commanded value', async () => {
    const T0 = new Date('2026-06-21T10:00:00.000Z');
    const { client, adapter, nowRef } = makeHarness(T0);
    const overrides: ManualOverrideDetection[] = [];
    adapter.on('manualOverride', (d) => overrides.push(d));

    const cmd = adapter.setShutterLevel('shutter1', 1, 0.0);
    const sent = client.sent[0];
    if (!sent) throw new Error('expected envelope');
    client.emit('message', responseEnvelope(sent.id, 200));
    await cmd;

    // T0 + 50 s: shutterLevel 0.03 → within snap tolerance (0.05) of
    // commanded 0.0 → no emit.
    nowRef.current = new Date(T0.getTime() + 50_000);
    client.emit('message', shutterEventEnvelope('shutter1', 0.03));

    expect(overrides).toHaveLength(0);
  });

  it('emits manualOverride when a never-commanded device reports a shutterLevel', () => {
    const T0 = new Date('2026-06-21T10:00:00.000Z');
    const { client, adapter } = makeHarness(T0);
    const overrides: ManualOverrideDetection[] = [];
    adapter.on('manualOverride', (d) => overrides.push(d));

    client.emit('message', shutterEventEnvelope('shutter-untouched', 0.4));

    expect(overrides).toHaveLength(1);
    const det = overrides[0];
    if (!det) throw new Error('expected detection');
    expect(det.deviceId).toBe('shutter-untouched');
    expect(det.observedLevel).toBe(0.4);
    expect(det.lastCommandedLevel).toBeNull();
    expect(det.lastCommandedAt).toBeNull();
  });

  it('rate-limits never-commanded emissions to one per device until next setShutterLevel', async () => {
    const T0 = new Date('2026-06-21T10:00:00.000Z');
    const { client, adapter, nowRef } = makeHarness(T0);
    const overrides: ManualOverrideDetection[] = [];
    adapter.on('manualOverride', (d) => overrides.push(d));

    client.emit('message', shutterEventEnvelope('shutter-untouched', 0.4));
    client.emit('message', shutterEventEnvelope('shutter-untouched', 0.6));
    client.emit('message', shutterEventEnvelope('shutter-untouched', 0.8));
    expect(overrides).toHaveLength(1);

    // After a real command + 50 s, a divergent event re-arms the
    // detector through the regular grace+tolerance branch.
    const promise = adapter.setShutterLevel('shutter-untouched', 1, 0.0);
    const sent = client.sent[0];
    if (!sent) throw new Error('expected envelope');
    client.emit('message', responseEnvelope(sent.id, 200));
    await promise;

    nowRef.current = new Date(T0.getTime() + 60_000);
    client.emit('message', shutterEventEnvelope('shutter-untouched', 0.9));
    expect(overrides).toHaveLength(2);
  });

  it('forwards the event body via systemEvent and updates the cache', () => {
    const T0 = new Date('2026-06-21T10:00:00.000Z');
    const { client, cache, adapter } = makeHarness(T0);
    const events: unknown[] = [];
    adapter.on('systemEvent', (b) => events.push(b));

    client.emit('message', shutterEventEnvelope('shutter-x', 0.25));

    expect(events).toHaveLength(1);
    // Cache picked up the device + feature.
    expect(cache.getFeature('shutter-x', 'shutterLevel')?.value).toBe(0.25);
  });
});

// ---------------------------------------------------------------------------
// start / stop.
// ---------------------------------------------------------------------------

describe('HmipSystemAdapter — start / stop idempotency', () => {
  it('start() is idempotent: a second call does not double-register', () => {
    const T0 = new Date('2026-06-21T10:00:00.000Z');
    const client = new FakeClient();
    const cache = new HcuSourceCache({ now: () => T0 });
    const adapter = new HmipSystemAdapter({
      client: client as unknown as ConnectClient,
      pluginId: PLUGIN_ID,
      cache,
      now: () => T0,
    });

    adapter.start();
    adapter.start();

    const events: unknown[] = [];
    adapter.on('systemEvent', (b) => events.push(b));

    client.emit('message', shutterEventEnvelope('s1', 0.5));
    // Exactly one delivery, not two.
    expect(events).toHaveLength(1);
  });

  it('stop() removes the listener; further messages do nothing', () => {
    const T0 = new Date('2026-06-21T10:00:00.000Z');
    const client = new FakeClient();
    const cache = new HcuSourceCache({ now: () => T0 });
    const adapter = new HmipSystemAdapter({
      client: client as unknown as ConnectClient,
      pluginId: PLUGIN_ID,
      cache,
      now: () => T0,
    });
    adapter.start();
    const events: unknown[] = [];
    adapter.on('systemEvent', (b) => events.push(b));

    adapter.stop();
    client.emit('message', shutterEventEnvelope('s1', 0.5));
    expect(events).toHaveLength(0);

    // Second stop is a no-op — does not throw, does not flip state.
    expect(() => adapter.stop()).not.toThrow();
  });
});
