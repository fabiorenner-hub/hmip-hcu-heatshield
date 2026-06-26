/**
 * Heat Shield — Connect API envelope helpers unit tests (Task 6.2).
 *
 * Covers the pure builders in `connect/envelope.ts`:
 *
 *   - `newMessageId` — v4 UUID shape and uniqueness across calls.
 *   - `buildEnvelope` — id defaulting, body defaulting, no `category`
 *     key on the wire.
 *   - `buildReply` — id and pluginId echoing.
 *   - `buildPluginStateResponse` — body shape; id from `replyTo` if
 *     given, fresh UUID otherwise.
 *   - `buildErrorResponse` — type and body shape, id echoed.
 *   - `isPluginMessageType` — type guard semantics.
 *   - `PluginMessageType` — frozen-as-const guarantee (compile-time
 *     check via type assignability).
 */

import { describe, expect, it } from 'vitest';

import {
  PluginMessageType,
  PluginReadinessStatus,
  buildEnvelope,
  buildErrorResponse,
  buildPluginStateResponse,
  buildReply,
  isPluginMessageType,
  newMessageId,
  type PluginMessageTypeName,
  type PluginReadinessStatusValue,
} from '../../src/plugin/connect/envelope.js';
import type { ConnectEnvelope } from '../../src/plugin/connect/client.js';

const PLUGIN_ID = 'de.fr.renner.plugin.heatshield';
const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// newMessageId.
// ---------------------------------------------------------------------------

describe('newMessageId', () => {
  it('returns a string matching the v4 UUID shape', () => {
    const id = newMessageId();
    expect(typeof id).toBe('string');
    expect(id).toMatch(UUID_V4_REGEX);
  });

  it('produces a different id on each call', () => {
    const a = newMessageId();
    const b = newMessageId();
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// buildEnvelope.
// ---------------------------------------------------------------------------

describe('buildEnvelope', () => {
  it('generates a fresh UUID id when none is supplied and omits the category key', () => {
    const env = buildEnvelope({
      pluginId: PLUGIN_ID,
      type: PluginMessageType.PLUGIN_STATE_RESPONSE,
    });

    expect(env.id).toMatch(UUID_V4_REGEX);
    expect(env.pluginId).toBe(PLUGIN_ID);
    expect(env.type).toBe('PLUGIN_STATE_RESPONSE');
    // Spec §6.2.1: envelope has no `category` field.
    expect('category' in env).toBe(false);
  });

  it('honours the supplied id and body verbatim', () => {
    const body = { foo: 1, bar: 'baz' };
    const env = buildEnvelope({
      id: 'fixed-id-123',
      pluginId: PLUGIN_ID,
      type: PluginMessageType.STATUS_EVENT,
      body,
    });

    expect(env.id).toBe('fixed-id-123');
    expect(env.pluginId).toBe(PLUGIN_ID);
    expect(env.type).toBe('STATUS_EVENT');
    expect(env.body).toBe(body);
  });

  it('omits the body key when body is undefined', () => {
    const env = buildEnvelope({
      pluginId: PLUGIN_ID,
      type: PluginMessageType.PLUGIN_STATE_REQUEST,
    });
    expect('body' in env).toBe(false);
  });

  it('JSON-encodes without a category field', () => {
    const env = buildEnvelope({
      pluginId: PLUGIN_ID,
      type: PluginMessageType.PLUGIN_STATE_RESPONSE,
      body: { pluginReadinessStatus: 'READY' },
    });
    const wire = JSON.parse(JSON.stringify(env)) as Record<string, unknown>;
    expect(Object.keys(wire).sort()).toEqual(['body', 'id', 'pluginId', 'type']);
  });
});

// ---------------------------------------------------------------------------
// buildReply.
// ---------------------------------------------------------------------------

describe('buildReply', () => {
  it('echoes the request id and pluginId, applies the supplied type and body', () => {
    const request: ConnectEnvelope = {
      id: 'req-abc-123',
      pluginId: PLUGIN_ID,
      type: PluginMessageType.CONTROL_REQUEST,
      body: { features: [] },
    };
    const reply = buildReply(request, {
      type: PluginMessageType.CONTROL_RESPONSE,
      body: { success: true },
    });

    expect(reply.id).toBe(request.id);
    expect(reply.pluginId).toBe(request.pluginId);
    expect(reply.type).toBe('CONTROL_RESPONSE');
    expect(reply.body).toEqual({ success: true });
    expect('category' in reply).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildPluginStateResponse.
// ---------------------------------------------------------------------------

describe('buildPluginStateResponse', () => {
  it('produces an unsolicited PluginStateResponse with a fresh UUID', () => {
    const env = buildPluginStateResponse({
      pluginId: PLUGIN_ID,
      status: PluginReadinessStatus.READY,
    });

    expect(env.id).toMatch(UUID_V4_REGEX);
    expect(env.pluginId).toBe(PLUGIN_ID);
    expect(env.type).toBe('PLUGIN_STATE_RESPONSE');
    expect(env.body).toEqual({ pluginReadinessStatus: 'READY' });
  });

  it('echoes the inbound id when replyTo is supplied', () => {
    const request: ConnectEnvelope = {
      id: 'req-state-1',
      pluginId: PLUGIN_ID,
      type: PluginMessageType.PLUGIN_STATE_REQUEST,
    };
    const env = buildPluginStateResponse({
      pluginId: PLUGIN_ID,
      status: PluginReadinessStatus.CONFIG_REQUIRED,
      replyTo: request,
    });

    expect(env.id).toBe('req-state-1');
    expect(env.body).toEqual({ pluginReadinessStatus: 'CONFIG_REQUIRED' });
  });

  it('accepts the ERROR readiness value', () => {
    const env = buildPluginStateResponse({
      pluginId: PLUGIN_ID,
      status: PluginReadinessStatus.ERROR,
    });
    expect(env.body).toEqual({ pluginReadinessStatus: 'ERROR' });
  });
});

// ---------------------------------------------------------------------------
// buildErrorResponse.
// ---------------------------------------------------------------------------

describe('buildErrorResponse', () => {
  it('produces an ERROR_RESPONSE envelope with the inbound id and the error body', () => {
    const request: ConnectEnvelope = {
      id: 'req-broken-1',
      pluginId: PLUGIN_ID,
      type: PluginMessageType.CONTROL_REQUEST,
      body: { malformed: true },
    };
    const error = { code: 'BAD_BODY', message: 'features missing' };
    const env = buildErrorResponse({
      pluginId: PLUGIN_ID,
      replyTo: request,
      error,
    });

    expect(env.id).toBe(request.id);
    expect(env.pluginId).toBe(PLUGIN_ID);
    expect(env.type).toBe('ERROR_RESPONSE');
    expect(env.body).toEqual({ error });
  });
});

// ---------------------------------------------------------------------------
// isPluginMessageType.
// ---------------------------------------------------------------------------

describe('isPluginMessageType', () => {
  it('returns true for every value in the PluginMessageType map', () => {
    for (const value of Object.values(PluginMessageType)) {
      expect(isPluginMessageType(value)).toBe(true);
    }
  });

  it('returns true for known string literals', () => {
    expect(isPluginMessageType('STATUS_EVENT')).toBe(true);
    expect(isPluginMessageType('DISCOVER_REQUEST')).toBe(true);
    expect(isPluginMessageType('ERROR_RESPONSE')).toBe(true);
  });

  it('returns false for unknown strings', () => {
    expect(isPluginMessageType('FOO')).toBe(false);
    expect(isPluginMessageType('')).toBe(false);
    expect(isPluginMessageType('status_event')).toBe(false); // case-sensitive
    expect(isPluginMessageType('STOPPED')).toBe(false);
  });

  it('narrows the type to PluginMessageTypeName on true', () => {
    const raw: string = 'CONTROL_REQUEST';
    if (isPluginMessageType(raw)) {
      // Compile-time check: `raw` is now narrowed.
      const narrowed: PluginMessageTypeName = raw;
      expect(narrowed).toBe('CONTROL_REQUEST');
    } else {
      throw new Error('expected guard to accept CONTROL_REQUEST');
    }
  });
});

// ---------------------------------------------------------------------------
// PluginMessageType — frozen string-literal guarantee.
// ---------------------------------------------------------------------------

describe('PluginMessageType / PluginReadinessStatus const-ness', () => {
  it('exposes string-literal types via the union (compile + runtime check)', () => {
    // Compile-time: the value of a key has the exact literal type.
    const v: 'STATUS_EVENT' = PluginMessageType.STATUS_EVENT;
    expect(v).toBe('STATUS_EVENT');

    const r: 'READY' = PluginReadinessStatus.READY;
    expect(r).toBe('READY');

    // The PluginReadinessStatusValue alias resolves to the union
    // and accepts every member.
    const all: PluginReadinessStatusValue[] = [
      'CONFIG_REQUIRED',
      'ERROR',
      'READY',
    ];
    expect(all).toHaveLength(3);
  });

  it('lists the full §6.6.8 enum (28 values)', () => {
    expect(Object.keys(PluginMessageType)).toHaveLength(28);
  });

  it('lists the full §6.6.9 enum (3 values)', () => {
    expect(Object.keys(PluginReadinessStatus)).toHaveLength(3);
  });
});
