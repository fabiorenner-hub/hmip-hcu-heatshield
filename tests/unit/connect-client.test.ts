/**
 * Heat Shield — Connect API client unit tests (Task 6.1).
 *
 * No real network. Every test wires a {@link FakeWebSocket} via the
 * `wsFactory` injection point. Reconnect timing is driven by
 * `vi.useFakeTimers` so the exponential-backoff schedule is
 * deterministic.
 *
 * Coverage map (acceptance criteria from `tasks.md` §6.1):
 *
 *   - `start()` calls `wsFactory` with the configured URL and the
 *     `authtoken`, `plugin-id`, and `hmip-system-events` headers.
 *   - On `'open'`, the client emits `'open'` and `isConnected()`
 *     returns true.
 *   - On `'message'` with valid JSON, the client emits `'message'`
 *     with the parsed envelope.
 *   - On `'message'` with invalid JSON, the client emits `'error'`
 *     once and does not crash.
 *   - On `'close'`, the client schedules a reconnect with the
 *     configured initial backoff. After `factor` increases, the next
 *     delay doubles.
 *   - `stop()` cancels any pending reconnect timer and prevents
 *     further reconnects.
 *   - `send()` writes a JSON line; calling `send` while disconnected
 *     throws.
 *   - Backoff caps at `maxMs`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ConnectClient,
  WS_CLOSED,
  WS_CLOSING,
  WS_CONNECTING,
  WS_OPEN,
  type ConnectEnvelope,
  type WebSocketFactory,
  type WebSocketLike,
} from '../../src/plugin/connect/client.js';

// ---------------------------------------------------------------------------
// FakeWebSocket — a tiny stand-in for the `ws` package's WebSocket.
// ---------------------------------------------------------------------------

type WsListener = (...args: unknown[]) => void;

interface FakeWebSocket extends WebSocketLike {
  /** All payloads passed to `send()` since construction. */
  readonly sent: string[];
  /** Trigger the `'open'` listener. */
  triggerOpen(): void;
  /** Trigger the `'message'` listener with `data`. */
  triggerMessage(data: string | Uint8Array): void;
  /** Trigger the `'close'` listener. */
  triggerClose(code?: number, reason?: string): void;
  /** Trigger the `'error'` listener. */
  triggerError(err: unknown): void;
}

function makeFakeWs(): FakeWebSocket {
  const listeners: Record<string, WsListener[]> = {
    open: [],
    message: [],
    close: [],
    error: [],
  };
  const sent: string[] = [];
  let readyState = WS_CONNECTING;

  const ws: FakeWebSocket = {
    sent,
    get readyState(): number {
      return readyState;
    },
    set readyState(v: number) {
      readyState = v;
    },
    send(data: string): void {
      sent.push(data);
    },
    close(code?: number, reason?: string): void {
      readyState = WS_CLOSING;
      // Mimic the `ws` library: the `close` event fires
      // asynchronously after `close()` is invoked.
      queueMicrotask(() => {
        readyState = WS_CLOSED;
        for (const l of listeners.close) {
          l(code ?? 1000, reason ?? '');
        }
      });
    },
    on(event, listener) {
      const bucket = listeners[event];
      if (bucket !== undefined) {
        bucket.push(listener);
      }
      return ws;
    },
    triggerOpen(): void {
      readyState = WS_OPEN;
      for (const l of listeners.open) {
        l();
      }
    },
    triggerMessage(data: string | Uint8Array): void {
      for (const l of listeners.message) {
        l(data);
      }
    },
    triggerClose(code?: number, reason?: string): void {
      readyState = WS_CLOSED;
      for (const l of listeners.close) {
        l(code ?? 1006, reason ?? '');
      }
    },
    triggerError(err: unknown): void {
      for (const l of listeners.error) {
        l(err);
      }
    },
  };

  return ws;
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

interface FactoryHarness {
  readonly factory: WebSocketFactory;
  readonly calls: Array<{
    url: string;
    headers: Record<string, string>;
    ws: FakeWebSocket;
  }>;
  readonly latest: () => FakeWebSocket;
}

function makeFactoryHarness(): FactoryHarness {
  const calls: FactoryHarness['calls'] = [];
  const factory: WebSocketFactory = (url, options) => {
    const ws = makeFakeWs();
    calls.push({ url, headers: { ...options.headers }, ws });
    return ws;
  };
  return {
    factory,
    calls,
    latest(): FakeWebSocket {
      const last = calls[calls.length - 1];
      if (last === undefined) {
        throw new Error('no fake ws constructed yet');
      }
      return last.ws;
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

const PLUGIN_ID = 'de.fr.renner.plugin.heatshield';
const AUTH_TOKEN = 'TESTTOKEN-0123456789ABCDEF';
const URL = 'wss://host.containers.internal:9001';

// ---------------------------------------------------------------------------
// Lifecycle.
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers();
  // Pin Math.random so jitter is deterministic. 0.5 → multiplier 1.0,
  // i.e. no offset from the nominal exponential delay.
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Cases.
// ---------------------------------------------------------------------------

describe('ConnectClient — handshake', () => {
  it('start() calls wsFactory with the configured URL and headers', () => {
    const h = makeFactoryHarness();
    const client = new ConnectClient({
      url: URL,
      pluginId: PLUGIN_ID,
      authToken: AUTH_TOKEN,
      receiveSystemEvents: true,
      wsFactory: h.factory,
    });

    client.start();

    expect(h.calls).toHaveLength(1);
    const call = h.calls[0];
    expect(call?.url).toBe(URL);
    expect(call?.headers['authtoken']).toBe(AUTH_TOKEN);
    expect(call?.headers['plugin-id']).toBe(PLUGIN_ID);
    expect(call?.headers['hmip-system-events']).toBe('true');
  });

  it('omits the hmip-system-events header when receiveSystemEvents=false', () => {
    const h = makeFactoryHarness();
    const client = new ConnectClient({
      url: URL,
      pluginId: PLUGIN_ID,
      authToken: AUTH_TOKEN,
      receiveSystemEvents: false,
      wsFactory: h.factory,
    });

    client.start();

    expect(h.calls[0]?.headers['hmip-system-events']).toBeUndefined();
  });

  it('start() is idempotent: a second call does not open a second socket', () => {
    const h = makeFactoryHarness();
    const client = new ConnectClient({
      url: URL,
      pluginId: PLUGIN_ID,
      authToken: AUTH_TOKEN,
      wsFactory: h.factory,
    });

    client.start();
    client.start();

    expect(h.calls).toHaveLength(1);
  });

  it('emits "open" and reflects isConnected()=true once the socket opens', () => {
    const h = makeFactoryHarness();
    const client = new ConnectClient({
      url: URL,
      pluginId: PLUGIN_ID,
      authToken: AUTH_TOKEN,
      wsFactory: h.factory,
    });

    let openCount = 0;
    client.on('open', () => {
      openCount += 1;
    });

    client.start();
    expect(client.isConnected()).toBe(false);

    h.latest().triggerOpen();

    expect(openCount).toBe(1);
    expect(client.isConnected()).toBe(true);
  });
});

describe('ConnectClient — message decoding', () => {
  it('emits "message" with the parsed envelope on valid JSON', () => {
    const h = makeFactoryHarness();
    const client = new ConnectClient({
      url: URL,
      pluginId: PLUGIN_ID,
      authToken: AUTH_TOKEN,
      wsFactory: h.factory,
    });

    const messages: ConnectEnvelope[] = [];
    client.on('message', (env) => {
      messages.push(env);
    });

    client.start();
    h.latest().triggerOpen();

    const envelope: ConnectEnvelope = {
      id: '38967997-e1b3-463f-8dc4-f889bb5d10a2',
      pluginId: PLUGIN_ID,
      type: 'PLUGIN_STATE_REQUEST',
      body: {},
    };
    h.latest().triggerMessage(JSON.stringify(envelope));

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual(envelope);
  });

  it('decodes Buffer message payloads as utf-8', () => {
    const h = makeFactoryHarness();
    const client = new ConnectClient({
      url: URL,
      pluginId: PLUGIN_ID,
      authToken: AUTH_TOKEN,
      wsFactory: h.factory,
    });
    const messages: ConnectEnvelope[] = [];
    client.on('message', (env) => {
      messages.push(env);
    });
    client.start();
    h.latest().triggerOpen();

    const envelope = {
      id: 'abc',
      pluginId: PLUGIN_ID,
      type: 'PLUGIN_STATE_REQUEST',
    };
    h.latest().triggerMessage(Buffer.from(JSON.stringify(envelope), 'utf8'));

    expect(messages).toHaveLength(1);
    expect(messages[0]?.id).toBe('abc');
  });

  it('emits "error" exactly once on malformed JSON without crashing', () => {
    const h = makeFactoryHarness();
    const client = new ConnectClient({
      url: URL,
      pluginId: PLUGIN_ID,
      authToken: AUTH_TOKEN,
      wsFactory: h.factory,
    });

    const errors: Error[] = [];
    client.on('error', (err) => {
      errors.push(err);
    });
    let messageCount = 0;
    client.on('message', () => {
      messageCount += 1;
    });

    client.start();
    h.latest().triggerOpen();
    h.latest().triggerMessage('{ this is not json');

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(/JSON/i);
    expect(messageCount).toBe(0);
    // Subsequent valid messages still flow.
    h.latest().triggerMessage(
      JSON.stringify({
        id: 'x',
        pluginId: PLUGIN_ID,
        type: 'PLUGIN_STATE_REQUEST',
      }),
    );
    expect(messageCount).toBe(1);
  });

  it('emits "error" when JSON is well-formed but envelope shape is wrong', () => {
    const h = makeFactoryHarness();
    const client = new ConnectClient({
      url: URL,
      pluginId: PLUGIN_ID,
      authToken: AUTH_TOKEN,
      wsFactory: h.factory,
    });
    const errors: Error[] = [];
    client.on('error', (err) => {
      errors.push(err);
    });
    client.start();
    h.latest().triggerOpen();

    h.latest().triggerMessage(JSON.stringify({ id: 1, pluginId: 'x' }));

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(/required fields/i);
  });
});

describe('ConnectClient — reconnect / backoff', () => {
  it('schedules a reconnect with the configured initial backoff after close', async () => {
    const h = makeFactoryHarness();
    const client = new ConnectClient({
      url: URL,
      pluginId: PLUGIN_ID,
      authToken: AUTH_TOKEN,
      wsFactory: h.factory,
      backoff: { initialMs: 1_000, maxMs: 30_000, factor: 2, jitter: false },
    });

    const reconnects: Array<{ attempt: number; delayMs: number }> = [];
    client.on('reconnect', (info) => {
      reconnects.push(info);
    });

    client.start();
    h.latest().triggerOpen();
    h.latest().triggerClose(1006, 'lost');

    expect(reconnects).toHaveLength(1);
    expect(reconnects[0]?.attempt).toBe(1);
    expect(reconnects[0]?.delayMs).toBe(1_000);
    expect(h.calls).toHaveLength(1);

    // Just before the deadline: still no second factory call.
    await vi.advanceTimersByTimeAsync(999);
    expect(h.calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(h.calls).toHaveLength(2);
  });

  it('doubles the delay on consecutive failures (factor=2)', async () => {
    const h = makeFactoryHarness();
    const client = new ConnectClient({
      url: URL,
      pluginId: PLUGIN_ID,
      authToken: AUTH_TOKEN,
      wsFactory: h.factory,
      backoff: { initialMs: 1_000, maxMs: 30_000, factor: 2, jitter: false },
    });

    const reconnects: Array<{ attempt: number; delayMs: number }> = [];
    client.on('reconnect', (info) => {
      reconnects.push(info);
    });

    client.start();
    // First close → attempt 1, delay 1000.
    h.latest().triggerClose(1006, 'first');
    await vi.advanceTimersByTimeAsync(1_000);
    // Second close (the new socket also dies before opening) →
    // attempt 2, delay 2000.
    h.latest().triggerClose(1006, 'second');
    await vi.advanceTimersByTimeAsync(2_000);
    // Third close → attempt 3, delay 4000.
    h.latest().triggerClose(1006, 'third');

    expect(reconnects.map((r) => r.attempt)).toEqual([1, 2, 3]);
    expect(reconnects.map((r) => r.delayMs)).toEqual([1_000, 2_000, 4_000]);
  });

  it('caps the delay at maxMs', async () => {
    const h = makeFactoryHarness();
    const client = new ConnectClient({
      url: URL,
      pluginId: PLUGIN_ID,
      authToken: AUTH_TOKEN,
      wsFactory: h.factory,
      backoff: { initialMs: 1_000, maxMs: 5_000, factor: 2, jitter: false },
    });
    const delays: number[] = [];
    client.on('reconnect', (info) => {
      delays.push(info.delayMs);
    });

    client.start();
    // Fire enough closes that the uncapped delay would exceed maxMs.
    // Schedule sequence (uncapped): 1000, 2000, 4000, 8000, 16000.
    // Capped at 5000 from attempt 4 onward.
    for (let i = 0; i < 5; i += 1) {
      h.latest().triggerClose(1006, `n=${i}`);
      // Advance enough to fire the next reconnect timer.
      await vi.advanceTimersByTimeAsync(20_000);
    }

    expect(delays.length).toBeGreaterThanOrEqual(5);
    expect(delays[0]).toBe(1_000);
    expect(delays[1]).toBe(2_000);
    expect(delays[2]).toBe(4_000);
    expect(delays[3]).toBe(5_000);
    expect(delays[4]).toBe(5_000);
    for (const d of delays) {
      expect(d).toBeLessThanOrEqual(5_000);
    }
  });

  it('resets the attempt counter on a successful open', async () => {
    const h = makeFactoryHarness();
    const client = new ConnectClient({
      url: URL,
      pluginId: PLUGIN_ID,
      authToken: AUTH_TOKEN,
      wsFactory: h.factory,
      backoff: { initialMs: 1_000, maxMs: 30_000, factor: 2, jitter: false },
    });
    const delays: number[] = [];
    client.on('reconnect', (info) => {
      delays.push(info.delayMs);
    });

    client.start();
    // Fail twice without opening.
    h.latest().triggerClose(1006, 'a');
    await vi.advanceTimersByTimeAsync(1_000);
    h.latest().triggerClose(1006, 'b');
    await vi.advanceTimersByTimeAsync(2_000);

    // Now the third socket opens cleanly, then dies.
    h.latest().triggerOpen();
    h.latest().triggerClose(1006, 'c');

    // Last reconnect should be back at the initial delay.
    expect(delays[delays.length - 1]).toBe(1_000);
  });
});

describe('ConnectClient — stop()', () => {
  it('cancels a pending reconnect timer and prevents further reconnects', async () => {
    const h = makeFactoryHarness();
    const client = new ConnectClient({
      url: URL,
      pluginId: PLUGIN_ID,
      authToken: AUTH_TOKEN,
      wsFactory: h.factory,
      backoff: { initialMs: 1_000, maxMs: 30_000, factor: 2, jitter: false },
    });

    client.start();
    h.latest().triggerClose(1006, 'lost');
    expect(h.calls).toHaveLength(1);

    // Stop before the reconnect timer fires.
    await client.stop();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.calls).toHaveLength(1);
  });

  it('closes the active socket and resolves once the close handshake completes', async () => {
    const h = makeFactoryHarness();
    const client = new ConnectClient({
      url: URL,
      pluginId: PLUGIN_ID,
      authToken: AUTH_TOKEN,
      wsFactory: h.factory,
    });

    client.start();
    h.latest().triggerOpen();
    expect(client.isConnected()).toBe(true);

    const stopP = client.stop();
    // The fake's close() schedules its close event on a microtask;
    // allow it to run.
    await flushMicrotasks();
    await stopP;

    expect(client.isConnected()).toBe(false);
  });

  it('does not schedule a reconnect when close fires after stop()', async () => {
    const h = makeFactoryHarness();
    const client = new ConnectClient({
      url: URL,
      pluginId: PLUGIN_ID,
      authToken: AUTH_TOKEN,
      wsFactory: h.factory,
    });
    const reconnects: number[] = [];
    client.on('reconnect', (info) => {
      reconnects.push(info.attempt);
    });

    client.start();
    h.latest().triggerOpen();

    const stopP = client.stop();
    await flushMicrotasks();
    await stopP;

    expect(reconnects).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.calls).toHaveLength(1);
  });
});

describe('ConnectClient — send()', () => {
  it('JSON-encodes and writes envelopes to the socket', () => {
    const h = makeFactoryHarness();
    const client = new ConnectClient({
      url: URL,
      pluginId: PLUGIN_ID,
      authToken: AUTH_TOKEN,
      wsFactory: h.factory,
    });

    client.start();
    h.latest().triggerOpen();

    const envelope: ConnectEnvelope = {
      id: 'aa-bb',
      pluginId: PLUGIN_ID,
      type: 'PLUGIN_STATE_RESPONSE',
      body: { pluginReadinessStatus: 'READY' },
    };
    client.send(envelope);

    expect(h.latest().sent).toHaveLength(1);
    const parsed = JSON.parse(h.latest().sent[0] ?? '');
    expect(parsed).toEqual(envelope);
  });

  it('throws when the socket is not OPEN', () => {
    const h = makeFactoryHarness();
    const client = new ConnectClient({
      url: URL,
      pluginId: PLUGIN_ID,
      authToken: AUTH_TOKEN,
      wsFactory: h.factory,
    });

    // Before start: no socket at all.
    expect(() =>
      client.send({
        id: 'x',
        pluginId: PLUGIN_ID,
        type: 'PLUGIN_STATE_RESPONSE',
      }),
    ).toThrow(/not open/);

    // After start but before open: readyState=CONNECTING.
    client.start();
    expect(() =>
      client.send({
        id: 'y',
        pluginId: PLUGIN_ID,
        type: 'PLUGIN_STATE_RESPONSE',
      }),
    ).toThrow(/not open/);
  });

  it('throws when called after a close', async () => {
    const h = makeFactoryHarness();
    const client = new ConnectClient({
      url: URL,
      pluginId: PLUGIN_ID,
      authToken: AUTH_TOKEN,
      wsFactory: h.factory,
      backoff: { initialMs: 60_000, maxMs: 60_000, factor: 1, jitter: false },
    });
    client.start();
    h.latest().triggerOpen();
    h.latest().triggerClose(1006, 'lost');

    expect(() =>
      client.send({
        id: 'z',
        pluginId: PLUGIN_ID,
        type: 'PLUGIN_STATE_RESPONSE',
      }),
    ).toThrow(/not open/);

    await client.stop();
  });
});
