/**
 * Heat Shield — Connect API DiscoverResponse builder (Task 6.3).
 *
 * The plugin exposes exactly five virtual SWITCH devices on the HCU
 * (design.md §"Connect-API-Integration / Eigene Geräte"):
 *
 *   - `heatshield-state-active`         — Hitzeschutz aktiv (read)
 *   - `heatshield-state-forecast`       — Hitzeschutz in Kürze (read)
 *   - `heatshield-state-night-cooling`  — Nachtkühlung aktiv (read)
 *   - `heatshield-control-pause`        — Hitzeschutz pausieren (write)
 *   - `heatshield-control-vacation`     — Hitzeschutz Urlaubsmodus (write)
 *
 * This module is a pure builder: given the cached `OwnSwitchState`
 * rows from `RuntimeStateSchema.ownSwitches` plus a snapshot of
 * source health, it returns the `DISCOVER_RESPONSE` envelope as
 * specified in Spec 1.0.1 §6.3.6. The transport (`client.ts`) and
 * envelope helpers (`envelope.ts`) handle wire concerns.
 *
 * ─── Spec mapping (Spec 1.0.1) ─────────────────────────────────────
 *
 *   - §6.3.6 DiscoverResponse body: `{ success, devices?, error? }`.
 *     We always send `success: true` plus a `devices` array; the
 *     `error` key is omitted on success (the spec marks it optional).
 *   - §6.6.5 SWITCH deviceType: required `SwitchState`, optional
 *     `OnTime`, `Maintenance`. We emit `SwitchState` + `Maintenance`
 *     only — `OnTime` is not meaningful for a virtual switch.
 *   - §6.6.6 Feature `type` enum: `switchState`, `maintenance` are
 *     both listed.
 *   - §6.7.36 SwitchState: `{ type: 'switchState', on: Boolean }`.
 *   - §6.7.16 Maintenance: `{ type: 'maintenance', unreach?,
 *     lowBat?, sabotage? }`. Booleans only; we always set all three
 *     so the HCU's representation is unambiguous (`unreach=false`
 *     means "reachable", not "unknown").
 *
 * ─── Steering compliance ───────────────────────────────────────────
 *
 *   - `friendlyName` is sent as a bare German string (the spec
 *     example uses a bare string; the field also accepts an
 *     `{ en, de }` map but that is not exercised here).
 *   - The plugin never invents enum values: `deviceType` is fixed to
 *     `'SWITCH'` and feature `type` strings come from the closed
 *     constants below.
 *   - `Maintenance.unreach` aggregates source health across **all**
 *     adapters: when *either* FusionSolar *or* the HCU adapter is
 *     unhealthy, the engine cannot make trustworthy decisions, so
 *     every status switch shows the unreach symbol simultaneously.
 *     This is the user-visible signal that automation is paused for
 *     a sources reason rather than a manual override.
 */

import type { OwnSwitchId, OwnSwitchState } from '../../shared/types.js';
import { OwnSwitchIdSchema } from '../../shared/state-schema.js';

import type { ConnectEnvelope } from './client.js';
import { PluginMessageType, buildEnvelope, buildReply } from './envelope.js';

// ---------------------------------------------------------------------------
// Feature types (Spec §6.7.36 SwitchState, §6.7.16 Maintenance).
// ---------------------------------------------------------------------------

/**
 * `SwitchState` feature payload (§6.7.36). The `on` field is
 * Boolean. We make it optional in the type so callers may also
 * represent "not yet known" by omitting it; the builder in this file
 * always sets it.
 */
export interface SwitchStateFeature {
  type: 'switchState';
  on?: boolean;
}

/**
 * `Maintenance` feature payload (§6.7.16). All three fields are
 * optional in the spec. Heat Shield always sends `unreach`,
 * `lowBat`, and `sabotage` so the HCU never has to fall back to a
 * "field missing" interpretation.
 */
export interface MaintenanceFeature {
  type: 'maintenance';
  unreach?: boolean;
  lowBat?: boolean;
  sabotage?: boolean;
}

/** Discriminated union of features Heat Shield emits on its own devices. */
export type OwnDeviceFeature = SwitchStateFeature | MaintenanceFeature;

/**
 * Wire shape for one of the five plugin-owned SWITCH devices. Field
 * names match the §6.3.6 example verbatim; no extra keys (no
 * `category`, no `room`, no `serial`) are added — the HCU rejects
 * unknown fields silently.
 */
export interface OwnDeviceDescriptor {
  deviceId: OwnSwitchId;
  deviceType: 'SWITCH';
  friendlyName: string;
  modelType: string;
  firmwareVersion: string;
  features: OwnDeviceFeature[];
}

// ---------------------------------------------------------------------------
// Constants.
// ---------------------------------------------------------------------------

/**
 * Model identifier the plugin presents for its own virtual devices.
 * Short, fixed string so the HCU can group all five entries under
 * the same model row in the device list.
 */
export const HEAT_SHIELD_MODEL_TYPE = 'HSV1';

/**
 * Firmware version reported with every own device. Mirrors the
 * `version` field in `package.json`. When the plugin version moves,
 * this constant moves with it.
 */
export const HEAT_SHIELD_FIRMWARE_VERSION = '0.1.0';

/**
 * German labels shown in the HmIP smartphone app. Keys are the five
 * `OwnSwitchId` values; values are the friendly names exactly as the
 * design document spells them. The map is `Record<OwnSwitchId,
 * string>` so a future addition to `OwnSwitchIdSchema` produces a
 * compile error here.
 */
export const OWN_DEVICE_FRIENDLY_NAMES: Record<OwnSwitchId, string> = {
  'heatshield-state-active': 'Hitzeschutz aktiv',
  'heatshield-state-forecast': 'Hitzeschutz in Kürze',
  'heatshield-state-night-cooling': 'Nachtkühlung aktiv',
  'heatshield-control-pause': 'Hitzeschutz pausieren',
  'heatshield-control-vacation': 'Hitzeschutz Urlaubsmodus',
  'heatshield-control-automation': 'Hitzeschutz Automatik',
};

/**
 * Snapshot of source-adapter health used by {@link
 * buildOwnDeviceDescriptors} to drive `Maintenance.unreach`.
 *
 *   - `fusionSolar` — `false` means the FusionSolar HTTP adapter is
 *     in 3-strikes failure or has not produced a fresh snapshot.
 *   - `hcu` — `false` means the HCU connection / system-events
 *     subscription has not delivered a usable cache yet.
 *
 * Either flag at `false` flips `unreach` for **all** five own
 * devices — the engine cannot make trustworthy decisions when any
 * source is missing, so the user-facing "unreach" symbol lights up
 * across the board.
 */
export interface SourceHealthSnapshot {
  fusionSolar: boolean;
  hcu: boolean;
}

// ---------------------------------------------------------------------------
// Builders.
// ---------------------------------------------------------------------------

/**
 * Default state for an own switch when the cached row is missing.
 * `RuntimeStateSchema.ownSwitches` enforces `length(5)`, so this
 * defensive fallback should never fire in production — but a future
 * migration that drops a row would otherwise crash the discover
 * builder. We prefer "device shows up as `off`" over "DISCOVER blows
 * up".
 */
const DEFAULT_SWITCH_VALUE = false;

/**
 * Build the five `OwnDeviceDescriptor` entries in the canonical
 * order defined by `OwnSwitchIdSchema.options`. Each descriptor
 * carries exactly two features:
 *
 *   1. `SwitchState` with `on` taken from the matching cached row.
 *   2. `Maintenance` with `unreach = !(fusionSolar && hcu)` plus
 *      `lowBat: false` and `sabotage: false` (always false — these
 *      are virtual devices with no battery and no tamper sensor).
 *
 * @param switchStates - Cached switch states (any order; the builder
 *   indexes by `id`).
 * @param health - Current source-adapter health snapshot.
 */
export function buildOwnDeviceDescriptors(
  switchStates: ReadonlyArray<OwnSwitchState>,
  health: SourceHealthSnapshot,
): OwnDeviceDescriptor[] {
  // Build an id → state lookup so we can iterate the canonical id
  // order (defined by the schema) rather than the input order.
  const byId = new Map<OwnSwitchId, OwnSwitchState>();
  for (const state of switchStates) {
    byId.set(state.id, state);
  }

  const unreach = !(health.fusionSolar && health.hcu);

  return OwnSwitchIdSchema.options.map((id) => {
    const cached = byId.get(id);
    const on = cached ? cached.value : DEFAULT_SWITCH_VALUE;

    const features: OwnDeviceFeature[] = [
      { type: 'switchState', on },
      { type: 'maintenance', unreach, lowBat: false, sabotage: false },
    ];

    return {
      deviceId: id,
      deviceType: 'SWITCH',
      friendlyName: OWN_DEVICE_FRIENDLY_NAMES[id],
      modelType: HEAT_SHIELD_MODEL_TYPE,
      firmwareVersion: HEAT_SHIELD_FIRMWARE_VERSION,
      features,
    };
  });
}

/**
 * Build a complete `DISCOVER_RESPONSE` envelope ready for `client.send`.
 *
 *   - With `replyTo` (the typical case — answering an inbound
 *     `DISCOVER_REQUEST`): the envelope id and pluginId are echoed
 *     from the request, per the spec's "responses must echo the
 *     request id" rule.
 *   - Without `replyTo`: a fresh v4 UUID is generated. Some plugin
 *     libraries push a discover response on startup unsolicited;
 *     supporting that unblocks future startup-announcement code
 *     without a second envelope shape.
 *
 * The body is `{ success: true, devices: [...] }`; the optional
 * `error` field is omitted on success.
 */
export function buildDiscoverResponse(params: {
  pluginId: string;
  replyTo?: ConnectEnvelope;
  switchStates: ReadonlyArray<OwnSwitchState>;
  health: SourceHealthSnapshot;
}): ConnectEnvelope {
  const devices = buildOwnDeviceDescriptors(params.switchStates, params.health);
  const body = { success: true, devices };

  if (params.replyTo !== undefined) {
    return buildReply(params.replyTo, {
      type: PluginMessageType.DISCOVER_RESPONSE,
      body,
    });
  }
  return buildEnvelope({
    pluginId: params.pluginId,
    type: PluginMessageType.DISCOVER_RESPONSE,
    body,
  });
}
