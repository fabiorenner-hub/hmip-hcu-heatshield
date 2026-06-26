/**
 * Heat Shield — HCU source cache tests (Task 5.2).
 *
 * No real network. The cache is a pure in-process structure; tests
 * feed it synthetic `getSystemState` and `HMIP_SYSTEM_EVENT` bodies
 * shaped after the Connect API §6.8.6.4 / §6.9 examples.
 *
 * Coverage map:
 *   - apply a synthetic snapshot with two CLIMATE_SENSOR devices and
 *     one WINDOW_COVERING. `listDevices()` returns deterministic
 *     order, `findClimateSensors()` filters correctly, `getFeature`
 *     returns the captured primitive.
 *   - apply an event that updates one feature and adds a new feature
 *     on an existing device. Cache merges correctly; sibling features
 *     are not clobbered.
 *   - `pickSignal` cases for static / hmip / openmeteo / fusion /
 *     undefined / stale-with-fallback / stale-without-fallback.
 *   - tolerance: malformed inputs (`{}`, `null`, `'hello'`) do not
 *     throw.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  HcuSourceCache,
  pickSignal,
  type HmipDeviceMeta,
} from '../../src/plugin/sources/hcu.js';
import type { SignalBinding } from '../../src/shared/types.js';

// ---------------------------------------------------------------------------
// Fixtures — shaped after Connect API §6.8.6.4 / §6.9 examples.
// ---------------------------------------------------------------------------

/**
 * Synthetic `getSystemState` body with three devices:
 *  - climate-bedroom: CLIMATE_SENSOR (Wandsensor Schlafzimmer).
 *  - climate-example: CLIMATE_SENSOR (OpenMeteo Beispielstadt).
 *  - shutter-bedroom: WINDOW_COVERING.
 *
 * Each device carries a few primitive features across one or two
 * functional channels. Channel-meta keys (`functionalChannelType`,
 * `label`, `index`, `groupIndex`, `deviceId`) are present so we
 * verify they are skipped.
 */
function makeSnapshot(): unknown {
  return {
    devices: {
      'climate-bedroom': {
        id: 'climate-bedroom',
        type: 'CLIMATE_SENSOR',
        label: 'Wandsensor Schlafzimmer',
        modelType: 'HmIP-STH',
        functionalChannels: {
          '0': {
            functionalChannelType: 'DEVICE_BASE',
            label: '',
            index: 0,
            groupIndex: 0,
            deviceId: 'climate-bedroom',
          },
          '1': {
            functionalChannelType: 'CLIMATE_SENSOR_CHANNEL',
            label: '',
            index: 1,
            groupIndex: 1,
            deviceId: 'climate-bedroom',
            actualTemperature: 23.4,
            humidity: 55,
          },
        },
      },
      'climate-example': {
        id: 'climate-example',
        type: 'CLIMATE_SENSOR',
        label: 'OpenMeteo Beispielstadt',
        manufacturerCode: 'OpenMeteo',
        functionalChannels: {
          '1': {
            functionalChannelType: 'CLIMATE_SENSOR_CHANNEL',
            index: 1,
            groupIndex: 1,
            deviceId: 'climate-example',
            actualTemperature: 27.8,
            illumination: 78000,
            windSpeed: 6.2,
            raining: false,
          },
        },
      },
      'shutter-bedroom': {
        id: 'shutter-bedroom',
        type: 'WINDOW_COVERING',
        label: 'Rollladen Schlafzimmer',
        modelType: 'HmIP-BROLL',
        functionalChannels: {
          '1': {
            functionalChannelType: 'SHUTTER_CHANNEL',
            index: 1,
            groupIndex: 1,
            deviceId: 'shutter-bedroom',
            shutterLevel: 0.0,
            processing: false,
          },
        },
      },
    },
  };
}

/**
 * Synthetic `HMIP_SYSTEM_EVENT` body that updates `actualTemperature`
 * on `climate-bedroom` and adds a brand-new `vaporAmount` feature on
 * the same device. `humidity` is intentionally omitted from the event
 * to verify sibling features survive a partial update.
 */
function makeUpdateEvent(): unknown {
  return {
    eventTransaction: {
      accessPointId: '3014F711A00003C000000789',
      events: {
        '0': {
          pushEventType: 'DEVICE_CHANGED',
          device: {
            id: 'climate-bedroom',
            type: 'CLIMATE_SENSOR',
            label: 'Wandsensor Schlafzimmer',
            functionalChannels: {
              '1': {
                functionalChannelType: 'CLIMATE_SENSOR_CHANNEL',
                index: 1,
                groupIndex: 1,
                deviceId: 'climate-bedroom',
                actualTemperature: 24.7,
                vaporAmount: 11.2,
              },
            },
          },
        },
      },
      origin: { type: 'DEVICE' },
    },
  };
}

// ---------------------------------------------------------------------------
// Cache ingestion & lookups.
// ---------------------------------------------------------------------------

describe('HcuSourceCache — applySystemState', () => {
  let cache: HcuSourceCache;
  const fixedNow = new Date('2026-06-21T10:00:00.000Z');

  beforeEach(() => {
    cache = new HcuSourceCache({ now: () => fixedNow });
    cache.applySystemState(makeSnapshot());
  });

  it('lists all devices in deterministic (deviceId-sorted) order', () => {
    const devices = cache.listDevices();
    expect(devices.map((d: HmipDeviceMeta) => d.deviceId)).toEqual([
      'climate-bedroom',
      'climate-example',
      'shutter-bedroom',
    ]);
  });

  it('captures device meta (type, friendlyName, manufacturerCode)', () => {
    const bedroom = cache.getDevice('climate-bedroom');
    expect(bedroom?.deviceType).toBe('CLIMATE_SENSOR');
    expect(bedroom?.friendlyName).toBe('Wandsensor Schlafzimmer');
    // Falls back to modelType when manufacturerCode is absent.
    expect(bedroom?.manufacturerCode).toBe('HmIP-STH');

    const example = cache.getDevice('climate-example');
    expect(example?.manufacturerCode).toBe('OpenMeteo');
    expect(example?.friendlyName).toBe('OpenMeteo Beispielstadt');
  });

  it('findClimateSensors returns exactly the two CLIMATE_SENSOR devices', () => {
    const sensors = cache.findClimateSensors();
    expect(sensors.map((d) => d.deviceId)).toEqual([
      'climate-bedroom',
      'climate-example',
    ]);
  });

  it('getFeature returns the captured primitive value', () => {
    expect(cache.getFeature('climate-bedroom', 'actualTemperature')?.value).toBe(
      23.4,
    );
    expect(cache.getFeature('climate-bedroom', 'humidity')?.value).toBe(55);
    expect(cache.getFeature('climate-example', 'illumination')?.value).toBe(
      78000,
    );
    expect(cache.getFeature('climate-example', 'raining')?.value).toBe(false);
    expect(cache.getFeature('shutter-bedroom', 'shutterLevel')?.value).toBe(0.0);
  });

  it('skips channel-meta keys (functionalChannelType, label, index, …)', () => {
    expect(
      cache.getFeature('climate-bedroom', 'functionalChannelType'),
    ).toBeUndefined();
    expect(cache.getFeature('climate-bedroom', 'index')).toBeUndefined();
    expect(cache.getFeature('climate-bedroom', 'deviceId')).toBeUndefined();
  });

  it('stamps observedAt with the injected clock', () => {
    const fv = cache.getFeature('climate-bedroom', 'actualTemperature');
    expect(fv?.observedAt.getTime()).toBe(fixedNow.getTime());
  });

  it('returns undefined for unknown device or feature', () => {
    expect(cache.getDevice('unknown')).toBeUndefined();
    expect(cache.getFeature('climate-bedroom', 'nope')).toBeUndefined();
    expect(cache.getFeature('unknown', 'actualTemperature')).toBeUndefined();
  });
});

describe('HcuSourceCache — applyEvent', () => {
  it('merges feature updates and additions while preserving siblings', () => {
    let now = new Date('2026-06-21T10:00:00.000Z');
    const cache = new HcuSourceCache({ now: () => now });
    cache.applySystemState(makeSnapshot());

    expect(
      cache.getFeature('climate-bedroom', 'actualTemperature')?.value,
    ).toBe(23.4);
    expect(cache.getFeature('climate-bedroom', 'humidity')?.value).toBe(55);
    expect(
      cache.getFeature('climate-bedroom', 'vaporAmount'),
    ).toBeUndefined();

    // 60 s later an event updates one feature and adds another.
    now = new Date('2026-06-21T10:01:00.000Z');
    cache.applyEvent(makeUpdateEvent());

    expect(
      cache.getFeature('climate-bedroom', 'actualTemperature')?.value,
    ).toBe(24.7);
    expect(
      cache
        .getFeature('climate-bedroom', 'actualTemperature')
        ?.observedAt.getTime(),
    ).toBe(now.getTime());

    // Newly observed feature lands in the cache.
    expect(cache.getFeature('climate-bedroom', 'vaporAmount')?.value).toBe(
      11.2,
    );

    // Sibling feature not mentioned by the event is preserved.
    expect(cache.getFeature('climate-bedroom', 'humidity')?.value).toBe(55);

    // Unrelated devices are not touched.
    expect(cache.getFeature('shutter-bedroom', 'shutterLevel')?.value).toBe(
      0.0,
    );
  });

  it('adds a brand-new device that first appears in an event', () => {
    const cache = new HcuSourceCache({
      now: () => new Date('2026-06-21T10:00:00.000Z'),
    });
    cache.applySystemState(makeSnapshot());

    cache.applyEvent({
      eventTransaction: {
        accessPointId: 'AP',
        events: {
          '0': {
            pushEventType: 'DEVICE_ADDED',
            device: {
              id: 'climate-livingroom',
              type: 'CLIMATE_SENSOR',
              label: 'Wohnzimmer',
              functionalChannels: {
                '1': {
                  functionalChannelType: 'CLIMATE_SENSOR_CHANNEL',
                  index: 1,
                  groupIndex: 1,
                  deviceId: 'climate-livingroom',
                  actualTemperature: 22.1,
                },
              },
            },
          },
        },
      },
    });

    expect(cache.getDevice('climate-livingroom')?.deviceType).toBe(
      'CLIMATE_SENSOR',
    );
    expect(
      cache.getFeature('climate-livingroom', 'actualTemperature')?.value,
    ).toBe(22.1);

    // Climate-sensor count grew.
    expect(cache.findClimateSensors().map((d) => d.deviceId)).toEqual([
      'climate-bedroom',
      'climate-example',
      'climate-livingroom',
    ]);
  });
});

describe('HcuSourceCache — tolerance to malformed input', () => {
  it('does not throw on null / primitives / missing devices', () => {
    const cache = new HcuSourceCache();
    expect(() => cache.applySystemState({})).not.toThrow();
    expect(() => cache.applySystemState(null)).not.toThrow();
    expect(() => cache.applySystemState(undefined)).not.toThrow();
    expect(() => cache.applySystemState('hello')).not.toThrow();
    expect(() => cache.applySystemState(42)).not.toThrow();
    expect(() => cache.applySystemState({ devices: 'not-an-object' })).not.toThrow();

    expect(() => cache.applyEvent('hello')).not.toThrow();
    expect(() => cache.applyEvent(null)).not.toThrow();
    expect(() => cache.applyEvent({})).not.toThrow();
    expect(() =>
      cache.applyEvent({ eventTransaction: { events: { '0': null } } }),
    ).not.toThrow();

    expect(cache.listDevices()).toEqual([]);
  });

  it('uses the map key as deviceId when the device object omits an inner id', () => {
    const cache = new HcuSourceCache({
      now: () => new Date('2026-06-21T10:00:00.000Z'),
    });
    cache.applySystemState({
      devices: {
        bad: 'not-an-object',
        // No inner `id` — real HMIP getSystemState keys devices by
        // their id, so the map key IS the id. Must be kept under it.
        'no-inner-id': { type: 'CLIMATE_SENSOR' },
        good: {
          id: 'good',
          type: 'CLIMATE_SENSOR',
          functionalChannels: {
            '1': { actualTemperature: 21.0 },
          },
        },
      },
    });
    // `bad` (non-object) is skipped; the other two survive.
    expect(cache.listDevices().map((d) => d.deviceId).sort()).toEqual([
      'good',
      'no-inner-id',
    ]);
    expect(cache.getFeature('good', 'actualTemperature')?.value).toBe(21.0);
  });

  it('keeps native HmIP devices whose meta fields have unexpected types (regression: 118→49 parser drop)', () => {
    // Real-HCU shapes that the old strict Zod schema rejected,
    // silently dropping every native device: numeric
    // `manufacturerCode`, `null` `label`, and a device with neither
    // type nor label. All three MUST survive now.
    const cache = new HcuSourceCache({
      now: () => new Date('2026-06-21T10:00:00.000Z'),
    });
    cache.applySystemState({
      devices: {
        shutter: {
          id: 'shutter',
          type: 'BRAND_SHUTTER',
          manufacturerCode: 1, // number, not string
          label: 'Rollo Schlafzimmer',
          functionalChannels: {
            '1': { shutterLevel: 0.5, functionalChannelType: 'SHUTTER_CHANNEL' },
          },
        },
        contact: {
          id: 'contact',
          type: 'SHUTTER_CONTACT',
          label: null, // null, not string
          functionalChannels: {
            '1': { windowState: 'CLOSED' },
          },
        },
        thermostat: {
          id: 'thermostat',
          type: 'WALL_MOUNTED_THERMOSTAT_PRO',
          manufacturerCode: 2,
          functionalChannels: {
            '1': { actualTemperature: 22.4, humidity: 48 },
          },
        },
      },
    });

    const ids = cache.listDevices().map((d) => d.deviceId);
    expect(ids).toContain('shutter');
    expect(ids).toContain('contact');
    expect(ids).toContain('thermostat');

    expect(cache.getFeature('shutter', 'shutterLevel')?.value).toBe(0.5);
    expect(cache.getFeature('contact', 'windowState')?.value).toBe('CLOSED');
    expect(cache.getFeature('thermostat', 'actualTemperature')?.value).toBe(
      22.4,
    );

    // Feature-based discovery must now surface them.
    expect(
      cache.findDevicesWithFeature('shutterLevel').map((d) => d.deviceId),
    ).toContain('shutter');
    expect(
      cache.findDevicesWithFeature('actualTemperature').map((d) => d.deviceId),
    ).toContain('thermostat');

    // Numeric manufacturerCode is coerced to string in meta.
    expect(cache.getDevice('shutter')?.manufacturerCode).toBe('1');
  });
});

// ---------------------------------------------------------------------------
// Selector — pickSignal.
// ---------------------------------------------------------------------------

describe('pickSignal', () => {
  const fixedNow = new Date('2026-06-21T10:00:00.000Z');

  function makeCache(): HcuSourceCache {
    const cache = new HcuSourceCache({ now: () => fixedNow });
    cache.applySystemState(makeSnapshot());
    return cache;
  }

  it('returns { ok: false, reason: "unbound" } when no binding given', () => {
    const cache = makeCache();
    const r = pickSignal(undefined, cache, { now: fixedNow });
    expect(r).toEqual({ ok: false, reason: 'unbound' });
  });

  it('resolves a static primary immediately', () => {
    const cache = makeCache();
    const binding: SignalBinding = {
      primary: { kind: 'static', value: 19.5 },
      staleAfterSec: 600,
    };
    const r = pickSignal<number>(binding, cache, { now: fixedNow });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toBe(19.5);
      expect(r.usedFallback).toBe(false);
      expect(r.observedAt.getTime()).toBe(fixedNow.getTime());
    }
  });

  it('resolves a fresh hmip primary against the HCU cache', () => {
    const cache = makeCache();
    const binding: SignalBinding = {
      primary: {
        kind: 'hmip',
        deviceId: 'climate-bedroom',
        feature: 'actualTemperature',
      },
      staleAfterSec: 600,
    };
    const r = pickSignal<number>(binding, cache, { now: fixedNow });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toBe(23.4);
      expect(r.usedFallback).toBe(false);
    }
  });

  it('resolves a fresh openmeteo primary against the same cache', () => {
    // Verifies that 'openmeteo' bindings travel through the HCU cache —
    // OpenMeteo plugin's CLIMATE_SENSOR is just another deviceId.
    const cache = makeCache();
    const binding: SignalBinding = {
      primary: {
        kind: 'openmeteo',
        deviceId: 'climate-example',
        feature: 'actualTemperature',
      },
      staleAfterSec: 600,
    };
    const r = pickSignal<number>(binding, cache, { now: fixedNow });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toBe(27.8);
      expect(r.usedFallback).toBe(false);
    }
  });

  it('returns { ok: false, reason: "stale" } when primary is past staleAfterSec and no fallback exists', () => {
    const cache = makeCache();
    // 11 minutes after the snapshot stamp; staleAfterSec=600 (10 min).
    const later = new Date(fixedNow.getTime() + 11 * 60 * 1000);
    const binding: SignalBinding = {
      primary: {
        kind: 'hmip',
        deviceId: 'climate-bedroom',
        feature: 'actualTemperature',
      },
      staleAfterSec: 600,
    };
    const r = pickSignal<number>(binding, cache, { now: later });
    expect(r).toEqual({ ok: false, reason: 'stale' });
  });

  it('falls back to a static fallback with usedFallback=true when primary is stale', () => {
    const cache = makeCache();
    const later = new Date(fixedNow.getTime() + 11 * 60 * 1000);
    const binding: SignalBinding = {
      primary: {
        kind: 'hmip',
        deviceId: 'climate-bedroom',
        feature: 'actualTemperature',
      },
      fallback: { kind: 'static', value: 21.0 },
      staleAfterSec: 600,
    };
    const r = pickSignal<number>(binding, cache, { now: later });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toBe(21.0);
      expect(r.usedFallback).toBe(true);
      expect(r.observedAt.getTime()).toBe(later.getTime());
    }
  });

  it('returns { ok: false, reason: "no_value" } for an unknown hmip device with no fallback', () => {
    const cache = makeCache();
    const binding: SignalBinding = {
      primary: { kind: 'hmip', deviceId: 'missing', feature: 'foo' },
      staleAfterSec: 600,
    };
    const r = pickSignal(binding, cache, { now: fixedNow });
    expect(r).toEqual({ ok: false, reason: 'no_value' });
  });

  it('documented behavior: fusion primary is not handled by pickSignal', () => {
    const cache = makeCache();
    const binding: SignalBinding = {
      primary: { kind: 'fusion', field: 'activePower' },
      staleAfterSec: 600,
    };
    const r = pickSignal(binding, cache, { now: fixedNow });
    expect(r).toEqual({ ok: false, reason: 'no_value' });
  });

  it('uses a fresh hmip fallback when primary has no value', () => {
    const cache = makeCache();
    const binding: SignalBinding = {
      primary: { kind: 'hmip', deviceId: 'missing', feature: 'foo' },
      fallback: {
        kind: 'hmip',
        deviceId: 'climate-bedroom',
        feature: 'actualTemperature',
      },
      staleAfterSec: 600,
    };
    const r = pickSignal<number>(binding, cache, { now: fixedNow });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toBe(23.4);
      expect(r.usedFallback).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// OpenMeteo discovery heuristic — task 5.5.
// ---------------------------------------------------------------------------

describe('HcuSourceCache — findOpenMeteoSensors', () => {
  /**
   * Synthetic snapshot covering every branch of the heuristic:
   *  - climate-bedroom        : Wandsensor Schlafzimmer (HmIP-STH) → no match.
   *  - climate-example      : OpenMeteo Beispielstadt + manufacturerCode OpenMeteo → match (name).
   *  - climate-attic          : Wetterdaten Vorhersage + manufacturerCode OpenMeteo → match (manufacturerCode).
   *  - climate-berlin         : OPENMETEO Berlin (uppercase) → match (case-insensitive name).
   *  - shutter-openmeteo-fake : WINDOW_COVERING called "OpenMeteo Wetterdaten" → must NOT match (wrong type).
   */
  function makeOpenMeteoSnapshot(): unknown {
    return {
      devices: {
        'climate-bedroom': {
          id: 'climate-bedroom',
          type: 'CLIMATE_SENSOR',
          label: 'Wandsensor Schlafzimmer',
          modelType: 'HmIP-STH',
          functionalChannels: {
            '1': {
              functionalChannelType: 'CLIMATE_SENSOR_CHANNEL',
              actualTemperature: 23.4,
            },
          },
        },
        'climate-example': {
          id: 'climate-example',
          type: 'CLIMATE_SENSOR',
          label: 'OpenMeteo Beispielstadt',
          manufacturerCode: 'OpenMeteo',
          functionalChannels: {
            '1': {
              functionalChannelType: 'CLIMATE_SENSOR_CHANNEL',
              actualTemperature: 27.8,
            },
          },
        },
        'climate-attic': {
          id: 'climate-attic',
          type: 'CLIMATE_SENSOR',
          label: 'Wetterdaten Vorhersage',
          manufacturerCode: 'OpenMeteo',
          functionalChannels: {
            '1': {
              functionalChannelType: 'CLIMATE_SENSOR_CHANNEL',
              actualTemperature: 28.4,
            },
          },
        },
        'climate-berlin': {
          id: 'climate-berlin',
          type: 'CLIMATE_SENSOR',
          label: 'OPENMETEO Berlin',
          modelType: 'HmIP-STH',
          functionalChannels: {
            '1': {
              functionalChannelType: 'CLIMATE_SENSOR_CHANNEL',
              actualTemperature: 26.0,
            },
          },
        },
        'shutter-openmeteo-fake': {
          id: 'shutter-openmeteo-fake',
          type: 'WINDOW_COVERING',
          label: 'OpenMeteo Wetterdaten',
          manufacturerCode: 'OpenMeteo',
          functionalChannels: {
            '1': {
              functionalChannelType: 'SHUTTER_CHANNEL',
              shutterLevel: 0.0,
            },
          },
        },
      },
    };
  }

  it('returns the two original matching ids in deterministic deviceId order', () => {
    const cache = new HcuSourceCache({
      now: () => new Date('2026-06-21T10:00:00.000Z'),
    });
    cache.applySystemState({
      devices: {
        'climate-bedroom': {
          id: 'climate-bedroom',
          type: 'CLIMATE_SENSOR',
          label: 'Wandsensor Schlafzimmer',
          modelType: 'HmIP-STH',
          functionalChannels: {
            '1': {
              functionalChannelType: 'CLIMATE_SENSOR_CHANNEL',
              actualTemperature: 23.4,
            },
          },
        },
        'climate-example': {
          id: 'climate-example',
          type: 'CLIMATE_SENSOR',
          label: 'OpenMeteo Beispielstadt',
          manufacturerCode: 'OpenMeteo',
          functionalChannels: {
            '1': {
              functionalChannelType: 'CLIMATE_SENSOR_CHANNEL',
              actualTemperature: 27.8,
            },
          },
        },
        'climate-attic': {
          id: 'climate-attic',
          type: 'CLIMATE_SENSOR',
          label: 'Wetterdaten Vorhersage',
          manufacturerCode: 'OpenMeteo',
          functionalChannels: {
            '1': {
              functionalChannelType: 'CLIMATE_SENSOR_CHANNEL',
              actualTemperature: 28.4,
            },
          },
        },
      },
    });

    const ids = cache.findOpenMeteoSensors().map((d) => d.deviceId);
    // listDevices() sorts by deviceId; example matches via name,
    // attic via manufacturerCode. attic (c-a) sorts before example
    // (c-f).
    expect(ids).toEqual(['climate-attic', 'climate-example']);
  });

  it('matches on uppercase friendlyName (case-insensitive heuristic)', () => {
    const cache = new HcuSourceCache({
      now: () => new Date('2026-06-21T10:00:00.000Z'),
    });
    cache.applySystemState(makeOpenMeteoSnapshot());

    const ids = cache.findOpenMeteoSensors().map((d) => d.deviceId);
    // attic (manufacturerCode), berlin (uppercase name), example
    // (mixed-case name). Bedroom does not match. The shutter is
    // excluded because it is not a CLIMATE_SENSOR.
    expect(ids).toEqual([
      'climate-attic',
      'climate-berlin',
      'climate-example',
    ]);
  });

  it('excludes a WINDOW_COVERING device even if its label contains "OpenMeteo"', () => {
    const cache = new HcuSourceCache({
      now: () => new Date('2026-06-21T10:00:00.000Z'),
    });
    cache.applySystemState(makeOpenMeteoSnapshot());

    const ids = cache.findOpenMeteoSensors().map((d) => d.deviceId);
    expect(ids).not.toContain('shutter-openmeteo-fake');
    // Sanity: the shutter is in the device list, just not in this filter.
    expect(cache.listDevices().map((d) => d.deviceId)).toContain(
      'shutter-openmeteo-fake',
    );
  });

  it('returns an empty list when no CLIMATE_SENSOR matches', () => {
    const cache = new HcuSourceCache({
      now: () => new Date('2026-06-21T10:00:00.000Z'),
    });
    cache.applySystemState({
      devices: {
        'climate-bedroom': {
          id: 'climate-bedroom',
          type: 'CLIMATE_SENSOR',
          label: 'Wandsensor Schlafzimmer',
          modelType: 'HmIP-STH',
          functionalChannels: {
            '1': {
              functionalChannelType: 'CLIMATE_SENSOR_CHANNEL',
              actualTemperature: 23.4,
            },
          },
        },
      },
    });
    expect(cache.findOpenMeteoSensors()).toEqual([]);
  });
});
