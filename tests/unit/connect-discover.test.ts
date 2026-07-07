/**
 * Heat Shield — DiscoverResponse builder unit tests (Task 6.3).
 *
 * Covers the pure builders in `connect/discover.ts`:
 *
 *   - `buildOwnDeviceDescriptors` — canonical order, fixed
 *     deviceType / modelType / firmwareVersion, two features per
 *     descriptor (`switchState` + `maintenance`), per-id `on`
 *     mapping, source-health → `unreach` aggregation, German
 *     friendly names.
 *   - `buildDiscoverResponse` — envelope shape, body shape, id
 *     echoing on `replyTo`, fresh v4 UUID otherwise.
 *   - JSON-encoded descriptors carry only the spec-listed keys.
 */

import { describe, expect, it } from 'vitest';

import type { ConnectEnvelope } from '../../src/plugin/connect/client.js';
import {
  HEAT_SHIELD_FIRMWARE_VERSION,
  HEAT_SHIELD_MODEL_TYPE,
  OWN_DEVICE_FRIENDLY_NAMES,
  buildDiscoverResponse,
  buildOwnDeviceDescriptors,
  type MaintenanceFeature,
  type OwnDeviceDescriptor,
  type SourceHealthSnapshot,
  type SwitchStateFeature,
} from '../../src/plugin/connect/discover.js';
import { PluginMessageType } from '../../src/plugin/connect/envelope.js';
import { OwnSwitchIdSchema } from '../../src/shared/state-schema.js';
import type { OwnSwitchId, OwnSwitchState } from '../../src/shared/types.js';

const PLUGIN_ID = 'de.fr.renner.plugin.heatshield';
const FIXED_TS = '2026-05-01T12:00:00.000Z';
const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ALL_IDS: ReadonlyArray<OwnSwitchId> = OwnSwitchIdSchema.options;

const HEALTHY: SourceHealthSnapshot = { fusionSolar: true, hcu: true };

/**
 * Build a full set of five `OwnSwitchState` rows. `valueFor` lets a
 * test override individual ids while leaving the rest at `false`.
 */
function fiveStates(
  valueFor: Partial<Record<OwnSwitchId, boolean>> = {},
): OwnSwitchState[] {
  return ALL_IDS.map((id) => ({
    id,
    value: valueFor[id] ?? false,
    engineConfirmed: false,
    updatedAt: FIXED_TS,
  }));
}

/** Pull the `switchState` feature from a descriptor (must exist). */
function switchStateOf(d: OwnDeviceDescriptor): SwitchStateFeature {
  const f = d.features.find(
    (x): x is SwitchStateFeature => x.type === 'switchState',
  );
  if (!f) throw new Error(`switchState missing on ${d.deviceId}`);
  return f;
}

/** Pull the `maintenance` feature from a descriptor (must exist). */
function maintenanceOf(d: OwnDeviceDescriptor): MaintenanceFeature {
  const f = d.features.find(
    (x): x is MaintenanceFeature => x.type === 'maintenance',
  );
  if (!f) throw new Error(`maintenance missing on ${d.deviceId}`);
  return f;
}

// ---------------------------------------------------------------------------
// buildOwnDeviceDescriptors.
// ---------------------------------------------------------------------------

describe('buildOwnDeviceDescriptors', () => {
  it('returns the five descriptors in the canonical OwnSwitchIdSchema order', () => {
    const descriptors = buildOwnDeviceDescriptors(fiveStates(), HEALTHY);

    expect(descriptors).toHaveLength(ALL_IDS.length);
    expect(descriptors.map((d) => d.deviceId)).toEqual([...ALL_IDS]);
  });

  it('sets fixed deviceType / modelType / firmwareVersion on every descriptor', () => {
    const descriptors = buildOwnDeviceDescriptors(fiveStates(), HEALTHY);
    for (const d of descriptors) {
      expect(d.deviceType).toBe('SWITCH');
      expect(d.modelType).toBe(HEAT_SHIELD_MODEL_TYPE);
      expect(d.modelType).toBe('HSV1');
      expect(d.firmwareVersion).toBe(HEAT_SHIELD_FIRMWARE_VERSION);
      expect(d.firmwareVersion).toBe('0.1.0');
    }
  });

  it('emits exactly two features (switchState + maintenance) per descriptor', () => {
    const descriptors = buildOwnDeviceDescriptors(fiveStates(), HEALTHY);
    for (const d of descriptors) {
      expect(d.features).toHaveLength(2);
      const types = d.features.map((f) => f.type).sort();
      expect(types).toEqual(['maintenance', 'switchState']);
    }
  });

  it('with all switches off returns switchState.on === false everywhere', () => {
    const descriptors = buildOwnDeviceDescriptors(fiveStates(), HEALTHY);
    for (const d of descriptors) {
      expect(switchStateOf(d).on).toBe(false);
    }
  });

  it('with healthy sources returns maintenance.unreach === false everywhere', () => {
    const descriptors = buildOwnDeviceDescriptors(fiveStates(), HEALTHY);
    for (const d of descriptors) {
      const m = maintenanceOf(d);
      expect(m.unreach).toBe(false);
      expect(m.lowBat).toBe(false);
      expect(m.sabotage).toBe(false);
    }
  });

  it('flips only the matching switchState.on when one switch is true', () => {
    const target: OwnSwitchId = 'heatshield-control-pause';
    const descriptors = buildOwnDeviceDescriptors(
      fiveStates({ [target]: true }),
      HEALTHY,
    );
    for (const d of descriptors) {
      const expected = d.deviceId === target;
      expect(switchStateOf(d).on).toBe(expected);
    }
  });

  it('marks every descriptor unreach when fusionSolar is unhealthy', () => {
    const descriptors = buildOwnDeviceDescriptors(fiveStates(), {
      fusionSolar: false,
      hcu: true,
    });
    for (const d of descriptors) {
      expect(maintenanceOf(d).unreach).toBe(true);
    }
  });

  it('marks every descriptor unreach when hcu is unhealthy', () => {
    const descriptors = buildOwnDeviceDescriptors(fiveStates(), {
      fusionSolar: true,
      hcu: false,
    });
    for (const d of descriptors) {
      expect(maintenanceOf(d).unreach).toBe(true);
    }
  });

  it('marks every descriptor unreach when both sources are unhealthy', () => {
    const descriptors = buildOwnDeviceDescriptors(fiveStates(), {
      fusionSolar: false,
      hcu: false,
    });
    for (const d of descriptors) {
      expect(maintenanceOf(d).unreach).toBe(true);
    }
  });

  it('uses the German friendlyName from OWN_DEVICE_FRIENDLY_NAMES', () => {
    const descriptors = buildOwnDeviceDescriptors(fiveStates(), HEALTHY);
    for (const d of descriptors) {
      expect(d.friendlyName).toBe(OWN_DEVICE_FRIENDLY_NAMES[d.deviceId]);
    }
    // Spot-check the actual labels.
    const byId = new Map(descriptors.map((d) => [d.deviceId, d.friendlyName]));
    expect(byId.get('heatshield-state-active')).toBe('Hitzeschutz aktiv');
    expect(byId.get('heatshield-state-forecast')).toBe('Hitzeschutz in Kürze');
    expect(byId.get('heatshield-state-night-cooling')).toBe(
      'Nachtkühlung aktiv',
    );
    expect(byId.get('heatshield-control-pause')).toBe('Hitzeschutz pausieren');
    expect(byId.get('heatshield-control-vacation')).toBe(
      'Hitzeschutz Urlaubsmodus',
    );
  });

  it('defaults missing switch states to value=false (defensive)', () => {
    // Drop two ids from the input; defensive default should kick in.
    const partial = fiveStates().filter(
      (s) =>
        s.id !== 'heatshield-state-active' &&
        s.id !== 'heatshield-control-vacation',
    );
    const descriptors = buildOwnDeviceDescriptors(partial, HEALTHY);
    expect(descriptors).toHaveLength(ALL_IDS.length);
    for (const d of descriptors) {
      expect(switchStateOf(d).on).toBe(false);
    }
  });

  it('JSON-encoded descriptors carry only the spec-listed keys', () => {
    const [first] = buildOwnDeviceDescriptors(fiveStates(), HEALTHY);
    if (!first) throw new Error('expected at least one descriptor');
    const wire = JSON.parse(JSON.stringify(first)) as Record<string, unknown>;
    expect(Object.keys(wire).sort()).toEqual([
      'deviceId',
      'deviceType',
      'features',
      'firmwareVersion',
      'friendlyName',
      'modelType',
    ]);
  });
});

// ---------------------------------------------------------------------------
// buildDiscoverResponse.
// ---------------------------------------------------------------------------

describe('buildDiscoverResponse', () => {
  it('returns a DISCOVER_RESPONSE envelope with success=true and five devices', () => {
    const env = buildDiscoverResponse({
      pluginId: PLUGIN_ID,
      switchStates: fiveStates(),
      health: HEALTHY,
    });

    expect(env.type).toBe(PluginMessageType.DISCOVER_RESPONSE);
    expect(env.type).toBe('DISCOVER_RESPONSE');
    expect(env.pluginId).toBe(PLUGIN_ID);

    const body = env.body as { success: boolean; devices: OwnDeviceDescriptor[] };
    expect(body.success).toBe(true);
    expect(body.devices).toHaveLength(ALL_IDS.length);
    expect(body.devices.map((d) => d.deviceId)).toEqual([...ALL_IDS]);
  });

  it('echoes the request id when replyTo is provided', () => {
    const request: ConnectEnvelope = {
      id: 'req-discover-42',
      pluginId: PLUGIN_ID,
      type: PluginMessageType.DISCOVER_REQUEST,
    };
    const env = buildDiscoverResponse({
      pluginId: PLUGIN_ID,
      replyTo: request,
      switchStates: fiveStates(),
      health: HEALTHY,
    });

    expect(env.id).toBe('req-discover-42');
    expect(env.pluginId).toBe(PLUGIN_ID);
    expect(env.type).toBe('DISCOVER_RESPONSE');
  });

  it('generates a fresh v4 UUID as id when no replyTo is given', () => {
    const env = buildDiscoverResponse({
      pluginId: PLUGIN_ID,
      switchStates: fiveStates(),
      health: HEALTHY,
    });
    expect(env.id).toMatch(UUID_V4_REGEX);
  });

  it('omits the optional error field on success', () => {
    const env = buildDiscoverResponse({
      pluginId: PLUGIN_ID,
      switchStates: fiveStates(),
      health: HEALTHY,
    });
    const body = env.body as Record<string, unknown>;
    expect('error' in body).toBe(false);
    expect(Object.keys(body).sort()).toEqual(['devices', 'success']);
  });

  it('JSON-encodes the envelope with no category key (Spec §6.2.1)', () => {
    const env = buildDiscoverResponse({
      pluginId: PLUGIN_ID,
      switchStates: fiveStates(),
      health: HEALTHY,
    });
    const wire = JSON.parse(JSON.stringify(env)) as Record<string, unknown>;
    expect('category' in wire).toBe(false);
    expect(Object.keys(wire).sort()).toEqual(['body', 'id', 'pluginId', 'type']);
  });
});
