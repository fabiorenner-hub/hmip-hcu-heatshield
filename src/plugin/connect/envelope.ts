/**
 * Heat Shield — Connect API envelope helpers (Task 6.2).
 *
 * Tiny, pure builders for `PluginMessage` envelopes (Spec 1.0.1
 * §6.2.1). The transport lives in {@link ./client.ts}; this module
 * only assembles JS objects that the client will JSON-encode.
 *
 * ─── Spec reconciliation ───────────────────────────────────────────
 *
 * Spec §6.2.1 ("PluginMessage") lists exactly four fields: `id`,
 * `pluginId`, `type`, `body`. There is **no** `category` field on
 * the wire envelope (the `MessageCategory` enum, §6.6.7, applies
 * inside `UserMessage` payloads only).
 *
 * The Task 6.1 brief mentioned a `category` helper, but the
 * orchestrator-verified §6.2.1 reading rules it out. We therefore:
 *
 *   - Do **not** expose a `category` parameter on any builder.
 *   - Keep the optional `category` field on
 *     {@link ConnectEnvelope} (defined by `client.ts`) only as a
 *     non-emitting passthrough, so this module is not a breaking
 *     change to the existing typed surface. None of the builders
 *     here ever populate it, and the wire JSON never contains the
 *     key.
 *
 * ─── ID semantics (steering: `hmip-connect-api.md`) ─────────────────
 *
 *   - **Unsolicited messages** (e.g. startup PluginStateResponse,
 *     STATUS_EVENT for our own switch devices) carry a fresh v4 UUID
 *     as `id`.
 *   - **Replies** (e.g. PluginStateResponse triggered by an inbound
 *     PluginStateRequest, ControlResponse for a ControlRequest) MUST
 *     echo the request's `id`. The HCU correlates flows by id.
 *
 * `randomUUID()` from `node:crypto` is the canonical generator
 * (RFC 4122 v4, 122 bits of entropy). Node 20+ ships it built-in;
 * the project's engines field pins `>=20.0.0`, so no fallback is
 * needed.
 */

import { randomUUID } from 'node:crypto';

import type { ConnectEnvelope } from './client.js';

// ---------------------------------------------------------------------------
// PluginMessageType (spec §6.6.8).
// ---------------------------------------------------------------------------

/**
 * Frozen string-literal map of all `PluginMessageType` values defined
 * in Spec §6.6.8. Use these constants instead of bare string literals
 * so a typo becomes a compile error. The HCU rejects unknown enum
 * values with `ERROR_RESPONSE`, so spelling matters.
 */
export const PluginMessageType = {
  CONFIG_TEMPLATE_REQUEST: 'CONFIG_TEMPLATE_REQUEST',
  CONFIG_TEMPLATE_RESPONSE: 'CONFIG_TEMPLATE_RESPONSE',
  CONFIG_UPDATE_REQUEST: 'CONFIG_UPDATE_REQUEST',
  CONFIG_UPDATE_RESPONSE: 'CONFIG_UPDATE_RESPONSE',
  CONTROL_REQUEST: 'CONTROL_REQUEST',
  CONTROL_RESPONSE: 'CONTROL_RESPONSE',
  CREATE_USER_MESSAGE_REQUEST: 'CREATE_USER_MESSAGE_REQUEST',
  CREATE_USER_MESSAGE_RESPONSE: 'CREATE_USER_MESSAGE_RESPONSE',
  DELETE_USER_MESSAGE_REQUEST: 'DELETE_USER_MESSAGE_REQUEST',
  DELETE_USER_MESSAGE_RESPONSE: 'DELETE_USER_MESSAGE_RESPONSE',
  DISCOVER_REQUEST: 'DISCOVER_REQUEST',
  DISCOVER_RESPONSE: 'DISCOVER_RESPONSE',
  ERROR_RESPONSE: 'ERROR_RESPONSE',
  EXCLUSION_EVENT: 'EXCLUSION_EVENT',
  HMIP_SYSTEM_EVENT: 'HMIP_SYSTEM_EVENT',
  HMIP_SYSTEM_REQUEST: 'HMIP_SYSTEM_REQUEST',
  HMIP_SYSTEM_RESPONSE: 'HMIP_SYSTEM_RESPONSE',
  INCLUSION_EVENT: 'INCLUSION_EVENT',
  LIST_USER_MESSAGES_REQUEST: 'LIST_USER_MESSAGES_REQUEST',
  LIST_USER_MESSAGES_RESPONSE: 'LIST_USER_MESSAGES_RESPONSE',
  PLUGIN_STATE_REQUEST: 'PLUGIN_STATE_REQUEST',
  PLUGIN_STATE_RESPONSE: 'PLUGIN_STATE_RESPONSE',
  STATUS_EVENT: 'STATUS_EVENT',
  STATUS_REQUEST: 'STATUS_REQUEST',
  STATUS_RESPONSE: 'STATUS_RESPONSE',
  SYSTEM_INFO_REQUEST: 'SYSTEM_INFO_REQUEST',
  SYSTEM_INFO_RESPONSE: 'SYSTEM_INFO_RESPONSE',
  USER_MESSAGE_ACK_EVENT: 'USER_MESSAGE_ACK_EVENT',
} as const;

/**
 * String-literal union of every value in {@link PluginMessageType}.
 * Use this as the `type` of an envelope to get exhaustive
 * spell-checking from the compiler.
 */
export type PluginMessageTypeName =
  (typeof PluginMessageType)[keyof typeof PluginMessageType];

/**
 * Internal: full set of allowed type strings, used by the
 * {@link isPluginMessageType} guard. Built once at module load.
 */
const PLUGIN_MESSAGE_TYPE_VALUES: ReadonlySet<string> = new Set(
  Object.values(PluginMessageType),
);

/**
 * Type guard for inbound envelope `type` strings. Use this on
 * messages received from the HCU before dispatching: an unknown type
 * means either a spec mismatch or a corrupted message and should be
 * answered with an `ERROR_RESPONSE`, not silently routed.
 */
export function isPluginMessageType(s: string): s is PluginMessageTypeName {
  return PLUGIN_MESSAGE_TYPE_VALUES.has(s);
}

// ---------------------------------------------------------------------------
// PluginReadinessStatus (spec §6.6.9).
// ---------------------------------------------------------------------------

/**
 * The three readiness values defined by §6.6.9. Inventing more (e.g.
 * `STARTING`) breaks the HCU's Jackson deserialiser; stick to this
 * map.
 */
export const PluginReadinessStatus = {
  CONFIG_REQUIRED: 'CONFIG_REQUIRED',
  ERROR: 'ERROR',
  READY: 'READY',
} as const;

/** String-literal union of every value in {@link PluginReadinessStatus}. */
export type PluginReadinessStatusValue =
  (typeof PluginReadinessStatus)[keyof typeof PluginReadinessStatus];

// ---------------------------------------------------------------------------
// Builders.
// ---------------------------------------------------------------------------

/**
 * Generate a fresh v4 UUID for an unsolicited message. Backed by
 * `node:crypto`'s `randomUUID()` (cryptographically strong RNG).
 */
export function newMessageId(): string {
  return randomUUID();
}

/**
 * Build an envelope from primitives. If `id` is omitted a fresh UUID
 * is generated — use this for unsolicited messages (PluginStateResponse
 * on startup, STATUS_EVENT for own devices). Reply flows should pass
 * the inbound id explicitly or use {@link buildReply}.
 *
 * The returned object never carries a `category` key (spec §6.2.1
 * forbids it on the envelope).
 */
export function buildEnvelope(params: {
  id?: string;
  pluginId: string;
  type: PluginMessageTypeName;
  body?: unknown;
}): ConnectEnvelope {
  const id = params.id ?? newMessageId();
  if (params.body === undefined) {
    return {
      id,
      pluginId: params.pluginId,
      type: params.type,
    };
  }
  return {
    id,
    pluginId: params.pluginId,
    type: params.type,
    body: params.body,
  };
}

/**
 * Build a reply envelope that echoes the request's `id` and reuses
 * its `pluginId`. The Connect API correlates request/response flows
 * by id; never invent a fresh id for a reply.
 */
export function buildReply(
  request: ConnectEnvelope,
  params: { type: PluginMessageTypeName; body?: unknown },
): ConnectEnvelope {
  return buildEnvelope({
    id: request.id,
    pluginId: request.pluginId,
    type: params.type,
    body: params.body,
  });
}

/**
 * Build a `PluginStateResponse` envelope (spec §6.6.9 / §6.2.1).
 *
 *   - Without `replyTo`: unsolicited startup announcement; the id is
 *     a fresh UUID.
 *   - With `replyTo`: response to an inbound `PluginStateRequest`;
 *     the id is echoed verbatim.
 *
 * The body shape is `{ pluginReadinessStatus }` — the single field
 * the spec defines for this message type.
 */
export function buildPluginStateResponse(params: {
  pluginId: string;
  status: PluginReadinessStatusValue;
  replyTo?: ConnectEnvelope;
}): ConnectEnvelope {
  const body = { pluginReadinessStatus: params.status };
  if (params.replyTo !== undefined) {
    return buildReply(params.replyTo, {
      type: PluginMessageType.PLUGIN_STATE_RESPONSE,
      body,
    });
  }
  return buildEnvelope({
    pluginId: params.pluginId,
    type: PluginMessageType.PLUGIN_STATE_RESPONSE,
    body,
  });
}

/**
 * Build an `ERROR_RESPONSE` envelope for replying to a malformed or
 * unsupported inbound request. Echoes the inbound id (responses must
 * always do this, even for errors).
 *
 * The body shape is `{ error: { code, message } }`. The spec's
 * `ErrorResponse` schema uses `code` and `message`; both are sent
 * verbatim.
 */
export function buildErrorResponse(params: {
  pluginId: string;
  replyTo: ConnectEnvelope;
  error: { code: string; message: string };
}): ConnectEnvelope {
  return buildReply(params.replyTo, {
    type: PluginMessageType.ERROR_RESPONSE,
    body: { error: params.error },
  });
}

// ---------------------------------------------------------------------------
// Config template / update (spec §6.3.1, §6.3.2, §6.6.4, §6.6.11).
// ---------------------------------------------------------------------------

/**
 * Allowed values for `ConfigUpdateResponseStatus` (spec §6.6.4).
 *
 *   - `APPLIED`  — update applied successfully.
 *   - `FAILED`   — could not apply.
 *   - `PENDING`  — accepted, still applying (e.g. async work).
 */
export const ConfigUpdateResponseStatus = {
  APPLIED: 'APPLIED',
  FAILED: 'FAILED',
  PENDING: 'PENDING',
} as const;

export type ConfigUpdateResponseStatusValue =
  (typeof ConfigUpdateResponseStatus)[keyof typeof ConfigUpdateResponseStatus];

/**
 * Property `dataType` values (spec §6.6.11 — `PropertyType`).
 *
 * Steering note: `dataType: 'ENUM'` is observed to render as an empty
 * dropdown in current HCUweb builds, so prefer `STRING` with a `values`
 * list (which is `TYPEAHEAD` semantics). `WEBLINK` is the spec's
 * intended way to point to an out-of-band UI: HCUweb renders the
 * `currentValue` URL as a clickable link, optionally with an info
 * text from `defaultValue`.
 */
export const PropertyDataType = {
  BOOLEAN: 'BOOLEAN',
  ENUM: 'ENUM',
  INTEGER: 'INTEGER',
  NUMBER: 'NUMBER',
  PASSWORD: 'PASSWORD',
  QRCODE: 'QRCODE',
  READONLY: 'READONLY',
  STRING: 'STRING',
  TYPEAHEAD: 'TYPEAHEAD',
  WEBLINK: 'WEBLINK',
} as const;

export type PropertyDataTypeValue =
  (typeof PropertyDataType)[keyof typeof PropertyDataType];

/**
 * Property template (spec §6.4.1's `PropertyTemplate`). Field set is
 * intentionally permissive — the HCU validates against the per-type
 * subset internally — but the literal-typed `dataType` keeps callers
 * from inventing new variants.
 */
export interface ConfigPropertyTemplate {
  readonly dataType: PropertyDataTypeValue;
  readonly friendlyName: string;
  readonly currentValue?: string | number | boolean | null;
  readonly defaultValue?: string | number | boolean | null;
  readonly description?: string;
  readonly required?: boolean;
  readonly groupId?: string;
  readonly order?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minimumLength?: number;
  readonly maximumLength?: number;
  readonly pattern?: string;
  readonly values?: ReadonlyArray<string>;
}

/** Group template (spec §6.3.1's `groups` map). */
export interface ConfigGroupTemplate {
  readonly friendlyName: string;
  readonly description?: string;
  readonly order?: number;
}

/**
 * Build a `CONFIG_TEMPLATE_RESPONSE` envelope (spec §6.3.1) in reply
 * to an incoming `CONFIG_TEMPLATE_REQUEST`.
 *
 * The HCU correlates by `id`, so the inbound envelope MUST be passed
 * via `replyTo` — never invent a fresh id here.
 */
export function buildConfigTemplateResponse(params: {
  replyTo: ConnectEnvelope;
  properties: Readonly<Record<string, ConfigPropertyTemplate>>;
  groups?: Readonly<Record<string, ConfigGroupTemplate>>;
}): ConnectEnvelope {
  const body: Record<string, unknown> = { properties: params.properties };
  if (params.groups !== undefined) {
    body['groups'] = params.groups;
  }
  return buildReply(params.replyTo, {
    type: PluginMessageType.CONFIG_TEMPLATE_RESPONSE,
    body,
  });
}

/**
 * Build a `CONFIG_UPDATE_RESPONSE` envelope (spec §6.3.2) in reply to
 * an incoming `CONFIG_UPDATE_REQUEST`. `message` is optional and is
 * shown to the user via HCUweb when present.
 */
export function buildConfigUpdateResponse(params: {
  replyTo: ConnectEnvelope;
  status: ConfigUpdateResponseStatusValue;
  message?: string;
}): ConnectEnvelope {
  const body: Record<string, unknown> = { status: params.status };
  if (params.message !== undefined) {
    body['message'] = params.message;
  }
  return buildReply(params.replyTo, {
    type: PluginMessageType.CONFIG_UPDATE_RESPONSE,
    body,
  });
}
