/**
 * Heat Shield — Own-device manager unit tests (Task 6.4).
 *
 * Covers `OwnDeviceManager` in `connect/ownDevices.ts`:
 *
 *   - cache round-trips via `loadCache` / `getCache` / `getSwitch`,
 *   - `confirmFromEngine` emits exactly one `'statusEvent'` only on
 *     effective change (steering: STATUS_EVENT only on
 *     engine-confirmed transitions),
 *   - `confirmFromEngine` updates `engineConfirmed: true` and
 *     stamps `updatedAt`,
 *   - `handleControlRequest` happy path: `userInput` +
 *     `controlResponse(success: true)`, no `statusEvent`,
 *   - `handleControlRequest` failure paths: unknown deviceId,
 *     malformed body, missing `switchState` feature,
 *   - end-to-end round-trip: user CONTROL_REQUEST → engine
 *     `confirmFromEngine` with the same value → STATUS_EVENT fires
 *     because the previous engine-confirmed value differed.
 */

import { describe, expect, it } from 'vitest';

import type { ConnectEnvelope } from '../../src/plugin/connect/client.js';
import { PluginMessageType } from '../../src/plugin/connect/envelope.js';
import {
  OwnDeviceManager,
  type OwnDeviceUserInput,
} from '../../src/plugin/connect/ownDevices.js';
import { OwnSwitchIdSchema } from '../../src/shared/state-schema.js';
import type { OwnSwitchId, OwnSwitchState } from '../../src/shared/types.js';

const PLUGIN_ID = 'de.fr.renner.plugin.heatshield';
const FIXED_TS = '2026-05-01T12:00:00.000Z';
const ALL_IDS: ReadonlyArray<OwnSwitchId> = OwnSwitchIdSchema.options;

const fixedNow = (iso: string): (() => Date) => (): Date => new Date(iso);

/** Build a fresh manager with a deterministic clock. */
function makeManager(nowIso = '2026-05-01T13:00:00.000Z'): OwnDeviceManager {
  return new OwnDeviceManager({
    pluginId: PLUGIN_ID,
    now: fixedNow(nowIso),
  });
}

/** Build an `OwnSwitchState` row for an id. */
function row(
  id: OwnSwitchId,
  patch: Partial<Omit<OwnSwitchState, 'id'>> = {},
): OwnSwitchState {
  return {
    id,
    value: false,
    engineConfirmed: false,
    updatedAt: FIXED_TS,
    ...patch,
  };
}

/** Build a CONTROL_REQUEST envelope. */
function controlRequest(
  id: string,
  switchOn: boolean | null,
  envelopeId = 'req-1',
): ConnectEnvelope {
  const features: Array<Record<string, unknown>> = [];
  if (switchOn !== null) {
    features.push({ type: 'switchState', on: switchOn });
  }
  return {
    id: envelopeId,
    pluginId: PLUGIN_ID,
    type: PluginMessageType.CONTROL_REQUEST,
    body: { deviceId: id, features },
  };
}

/** Capture all events of a given name into an array. */
function capture<T>(
  manager: OwnDeviceManager,
  name: 'statusEvent' | 'controlResponse' | 'userInput',
): T[] {
  const sink: T[] = [];
  manager.on(name, (payload: T) => {
    sink.push(payload);
  });
  return sink;
}

// ---------------------------------------------------------------------------
// Cache lifecycle.
// ---------------------------------------------------------------------------

describe('OwnDeviceManager — cache lifecycle', () => {
  it('loadCache followed by getCache round-trips the input', () => {
    const manager = makeManager();
    const input: OwnSwitchState[] = ALL_IDS.map((id, i) =>
      row(id, { value: i % 2 === 0, engineConfirmed: i === 0 }),
    );

    manager.loadCache(input);
    const out = manager.getCache();

    expect(out).toHaveLength(5);
    expect(out.map((s) => s.id)).toEqual([...ALL_IDS]);
    for (const expected of input) {
      const actual = out.find((s) => s.id === expected.id);
      expect(actual).toEqual(expected);
    }
  });

  it('loadCache replaces previous contents (does not merge)', () => {
    const manager = makeManager();
    manager.loadCache(ALL_IDS.map((id) => row(id, { value: true })));
    manager.loadCache([row('heatshield-state-active', { value: false })]);

    const out = manager.getCache();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: 'heatshield-state-active',
      value: false,
    });
  });

  it('getSwitch returns a copy, not the live cache row', () => {
    const manager = makeManager();
    manager.loadCache([row('heatshield-state-active', { value: true })]);

    const fetched = manager.getSwitch('heatshield-state-active');
    expect(fetched).toBeDefined();
    if (fetched) {
      // Mutating the copy must not affect the manager's cache.
      (fetched as { value: boolean }).value = false;
    }
    expect(manager.getSwitch('heatshield-state-active')?.value).toBe(true);
  });

  it('getSwitch returns undefined for an id not in the cache', () => {
    const manager = makeManager();
    expect(manager.getSwitch('heatshield-state-active')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// confirmFromEngine.
// ---------------------------------------------------------------------------

describe('OwnDeviceManager — confirmFromEngine', () => {
  it('emits one statusEvent when transitioning unconfirmed false → confirmed true', () => {
    const manager = makeManager();
    manager.loadCache([
      row('heatshield-state-active', {
        value: false,
        engineConfirmed: false,
      }),
    ]);

    const status = capture<ConnectEnvelope>(manager, 'statusEvent');
    manager.confirmFromEngine('heatshield-state-active', true);

    expect(status).toHaveLength(1);
    const env = status[0];
    if (!env) throw new Error('expected statusEvent envelope');
    expect(env.type).toBe(PluginMessageType.STATUS_EVENT);
    expect(env.type).toBe('STATUS_EVENT');
    expect(env.pluginId).toBe(PLUGIN_ID);
    const body = env.body as {
      deviceId: string;
      features: Array<{ type: string; on?: boolean }>;
    };
    expect(body.deviceId).toBe('heatshield-state-active');
    expect(body.features).toHaveLength(1);
    expect(body.features[0]).toEqual({ type: 'switchState', on: true });
  });

  it('emits NO statusEvent when re-confirming an already-confirmed value', () => {
    const manager = makeManager();
    manager.loadCache([
      row('heatshield-state-active', {
        value: true,
        engineConfirmed: true,
      }),
    ]);

    const status = capture<ConnectEnvelope>(manager, 'statusEvent');
    manager.confirmFromEngine('heatshield-state-active', true);

    expect(status).toHaveLength(0);
  });

  it('emits a statusEvent on a genuine change (true → false)', () => {
    const manager = makeManager();
    manager.loadCache([
      row('heatshield-state-active', {
        value: false,
        engineConfirmed: false,
      }),
    ]);
    const status = capture<ConnectEnvelope>(manager, 'statusEvent');

    manager.confirmFromEngine('heatshield-state-active', true);
    manager.confirmFromEngine('heatshield-state-active', false);

    expect(status).toHaveLength(2);
    const second = status[1];
    if (!second) throw new Error('expected second envelope');
    const body = second.body as {
      deviceId: string;
      features: Array<{ type: string; on?: boolean }>;
    };
    expect(body.deviceId).toBe('heatshield-state-active');
    expect(body.features[0]).toEqual({ type: 'switchState', on: false });
  });

  it('updates engineConfirmed: true and stamps updatedAt with the injected clock', () => {
    const nowIso = '2026-06-15T08:30:00.000Z';
    const manager = makeManager(nowIso);
    manager.loadCache([
      row('heatshield-state-active', {
        value: false,
        engineConfirmed: false,
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    ]);

    manager.confirmFromEngine('heatshield-state-active', true);

    const after = manager.getSwitch('heatshield-state-active');
    expect(after).toBeDefined();
    expect(after?.value).toBe(true);
    expect(after?.engineConfirmed).toBe(true);
    expect(after?.updatedAt).toBe(nowIso);
  });

  it('first-ever confirmation (no cached row) still emits a statusEvent', () => {
    const manager = makeManager();
    const status = capture<ConnectEnvelope>(manager, 'statusEvent');

    manager.confirmFromEngine('heatshield-state-active', true);

    expect(status).toHaveLength(1);
    expect(manager.getSwitch('heatshield-state-active')).toMatchObject({
      value: true,
      engineConfirmed: true,
    });
  });

  it('confirming after a markUnconfirmed with the same value still emits (engine-confirmed value transitioned from null to true)', () => {
    const manager = makeManager();
    manager.loadCache([
      row('heatshield-control-pause', {
        value: false,
        engineConfirmed: true,
      }),
    ]);

    // User clicks (cache becomes value=true, engineConfirmed=false).
    manager.markUnconfirmed('heatshield-control-pause', true);
    const status = capture<ConnectEnvelope>(manager, 'statusEvent');

    // Engine confirms the same requested value: a real transition
    // from previously-confirmed `false` to now-confirmed `true`.
    manager.confirmFromEngine('heatshield-control-pause', true);
    expect(status).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// markUnconfirmed.
// ---------------------------------------------------------------------------

describe('OwnDeviceManager — markUnconfirmed', () => {
  it('writes value/engineConfirmed=false/updatedAt and emits no events', () => {
    const nowIso = '2026-07-04T17:00:00.000Z';
    const manager = makeManager(nowIso);
    const status = capture<ConnectEnvelope>(manager, 'statusEvent');
    const userInput = capture<OwnDeviceUserInput>(manager, 'userInput');

    manager.markUnconfirmed('heatshield-control-pause', true);

    expect(status).toHaveLength(0);
    expect(userInput).toHaveLength(0);
    expect(manager.getSwitch('heatshield-control-pause')).toEqual({
      id: 'heatshield-control-pause',
      value: true,
      engineConfirmed: false,
      updatedAt: nowIso,
    });
  });
});

// ---------------------------------------------------------------------------
// handleControlRequest — happy path.
// ---------------------------------------------------------------------------

describe('OwnDeviceManager — handleControlRequest (happy path)', () => {
  it('emits userInput, emits controlResponse(success=true), no statusEvent', () => {
    const manager = makeManager();
    manager.loadCache([
      row('heatshield-control-pause', {
        value: false,
        engineConfirmed: true,
      }),
    ]);

    const status = capture<ConnectEnvelope>(manager, 'statusEvent');
    const responses = capture<ConnectEnvelope>(manager, 'controlResponse');
    const inputs = capture<OwnDeviceUserInput>(manager, 'userInput');

    const req = controlRequest('heatshield-control-pause', true, 'req-42');
    manager.handleControlRequest(req);

    // statusEvent: NEVER on CONTROL_REQUEST — only the engine drives that.
    expect(status).toHaveLength(0);

    // userInput: one event with the right payload.
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toEqual({
      deviceId: 'heatshield-control-pause',
      requestedValue: true,
      rawRequest: req,
    });

    // controlResponse: success: true, deviceId echoed, id echoed.
    expect(responses).toHaveLength(1);
    const resp = responses[0];
    if (!resp) throw new Error('expected controlResponse envelope');
    expect(resp.id).toBe('req-42');
    expect(resp.pluginId).toBe(PLUGIN_ID);
    expect(resp.type).toBe(PluginMessageType.CONTROL_RESPONSE);
    expect(resp.body).toEqual({
      success: true,
      deviceId: 'heatshield-control-pause',
    });
  });

  it('cache reflects value=requestedValue, engineConfirmed=false after CONTROL_REQUEST', () => {
    const nowIso = '2026-08-01T10:00:00.000Z';
    const manager = makeManager(nowIso);
    manager.loadCache([
      row('heatshield-control-pause', {
        value: false,
        engineConfirmed: true,
      }),
    ]);

    manager.handleControlRequest(
      controlRequest('heatshield-control-pause', true),
    );

    expect(manager.getSwitch('heatshield-control-pause')).toEqual({
      id: 'heatshield-control-pause',
      value: true,
      engineConfirmed: false,
      updatedAt: nowIso,
    });
  });
});

// ---------------------------------------------------------------------------
// handleControlRequest — failure paths.
// ---------------------------------------------------------------------------

describe('OwnDeviceManager — handleControlRequest (failure paths)', () => {
  it('unknown deviceId → success: false, error.code: UNKNOWN_DEVICE, no userInput', () => {
    const manager = makeManager();
    const responses = capture<ConnectEnvelope>(manager, 'controlResponse');
    const inputs = capture<OwnDeviceUserInput>(manager, 'userInput');
    const status = capture<ConnectEnvelope>(manager, 'statusEvent');

    manager.handleControlRequest(
      controlRequest('foreign-device-id', true, 'req-99'),
    );

    expect(inputs).toHaveLength(0);
    expect(status).toHaveLength(0);
    expect(responses).toHaveLength(1);
    const resp = responses[0];
    if (!resp) throw new Error('expected controlResponse envelope');
    expect(resp.id).toBe('req-99');
    expect(resp.type).toBe(PluginMessageType.CONTROL_RESPONSE);
    const body = resp.body as {
      success: boolean;
      deviceId?: string;
      error?: { code: string; message: string };
    };
    expect(body.success).toBe(false);
    expect(body.deviceId).toBe('foreign-device-id');
    expect(body.error?.code).toBe('UNKNOWN_DEVICE');
    expect(typeof body.error?.message).toBe('string');
  });

  it('malformed body (missing features) → success: false, error.code: BAD_REQUEST', () => {
    const manager = makeManager();
    const responses = capture<ConnectEnvelope>(manager, 'controlResponse');
    const inputs = capture<OwnDeviceUserInput>(manager, 'userInput');

    const malformed: ConnectEnvelope = {
      id: 'req-bad',
      pluginId: PLUGIN_ID,
      type: PluginMessageType.CONTROL_REQUEST,
      body: { deviceId: 'heatshield-control-pause' },
    };
    manager.handleControlRequest(malformed);

    expect(inputs).toHaveLength(0);
    expect(responses).toHaveLength(1);
    const resp = responses[0];
    if (!resp) throw new Error('expected controlResponse envelope');
    expect(resp.id).toBe('req-bad');
    const body = resp.body as {
      success: boolean;
      error?: { code: string; message: string };
    };
    expect(body.success).toBe(false);
    expect(body.error?.code).toBe('BAD_REQUEST');
  });

  it('malformed body (no body at all) → success: false, error.code: BAD_REQUEST', () => {
    const manager = makeManager();
    const responses = capture<ConnectEnvelope>(manager, 'controlResponse');

    manager.handleControlRequest({
      id: 'req-empty',
      pluginId: PLUGIN_ID,
      type: PluginMessageType.CONTROL_REQUEST,
    });

    expect(responses).toHaveLength(1);
    const resp = responses[0];
    if (!resp) throw new Error('expected controlResponse envelope');
    const body = resp.body as { success: boolean; error?: { code: string } };
    expect(body.success).toBe(false);
    expect(body.error?.code).toBe('BAD_REQUEST');
  });

  it('no switchState feature → success: true, no userInput', () => {
    const manager = makeManager();
    const responses = capture<ConnectEnvelope>(manager, 'controlResponse');
    const inputs = capture<OwnDeviceUserInput>(manager, 'userInput');

    // Feature array present but switchState missing.
    manager.handleControlRequest(
      controlRequest('heatshield-control-pause', null, 'req-noop'),
    );

    expect(inputs).toHaveLength(0);
    expect(responses).toHaveLength(1);
    const resp = responses[0];
    if (!resp) throw new Error('expected controlResponse envelope');
    expect(resp.id).toBe('req-noop');
    expect(resp.body).toEqual({
      success: true,
      deviceId: 'heatshield-control-pause',
    });
  });
});

// ---------------------------------------------------------------------------
// Round-trip flow.
// ---------------------------------------------------------------------------

describe('OwnDeviceManager — round-trip (CONTROL_REQUEST → confirmFromEngine)', () => {
  it('user input followed by engine confirmation with the same value emits exactly one STATUS_EVENT', () => {
    const manager = makeManager();
    manager.loadCache([
      row('heatshield-control-pause', {
        value: false,
        engineConfirmed: true,
      }),
    ]);

    const status = capture<ConnectEnvelope>(manager, 'statusEvent');
    const responses = capture<ConnectEnvelope>(manager, 'controlResponse');
    const inputs = capture<OwnDeviceUserInput>(manager, 'userInput');

    // 1) User toggles via the HmIP app.
    manager.handleControlRequest(
      controlRequest('heatshield-control-pause', true, 'req-1'),
    );
    expect(inputs).toHaveLength(1);
    expect(responses).toHaveLength(1);
    expect(status).toHaveLength(0);

    // 2) Engine evaluates and confirms the requested value.
    manager.confirmFromEngine('heatshield-control-pause', true);

    // STATUS_EVENT fires because the previous engine-confirmed
    // value (false) differs from the new engine-confirmed value
    // (true). The manager filters by the *engine-confirmed* baseline,
    // not the optimistic cache value.
    expect(status).toHaveLength(1);
    const env = status[0];
    if (!env) throw new Error('expected statusEvent envelope');
    expect(env.type).toBe(PluginMessageType.STATUS_EVENT);
    const body = env.body as {
      deviceId: string;
      features: Array<{ type: string; on?: boolean }>;
    };
    expect(body.deviceId).toBe('heatshield-control-pause');
    expect(body.features).toEqual([{ type: 'switchState', on: true }]);
  });

  it('engine overrides the user input → STATUS_EVENT carries the engine value, not the requested one', () => {
    const manager = makeManager();
    manager.loadCache([
      row('heatshield-control-pause', {
        value: false,
        engineConfirmed: true,
      }),
    ]);
    const status = capture<ConnectEnvelope>(manager, 'statusEvent');

    manager.handleControlRequest(
      controlRequest('heatshield-control-pause', true, 'req-1'),
    );
    // Engine declines the toggle (e.g. STORM mode active) and
    // reasserts `false`. The previous engine-confirmed value was
    // `false`, so no transition → no STATUS_EVENT.
    manager.confirmFromEngine('heatshield-control-pause', false);

    expect(status).toHaveLength(0);
    expect(manager.getSwitch('heatshield-control-pause')).toMatchObject({
      value: false,
      engineConfirmed: true,
    });
  });
});
