/**
 * Heat Shield — HCU (Homematic IP system) source cache (Task 5.2).
 *
 * The HCU is the canonical source for every signal that is not the
 * FusionSolar plugin: native HMIP sensors, contact channels, and the
 * OpenMeteo plugin's weather feed (which exposes itself as one or more
 * `CLIMATE_SENSOR` devices). All of these arrive via the same Connect
 * API channel — first as a complete `getSystemState` snapshot at
 * startup, then as `HMIP_SYSTEM_EVENT` push transactions.
 *
 * This module is the *local cache and selector* only. Network plumbing
 * (the WebSocket request/response loop, header negotiation,
 * subscription handshakes) lives in `src/plugin/connect/hmipSystem.ts`
 * (Task 6.5). The Connect layer ingests payloads here via
 * `applySystemState` and `applyEvent`; the engine reads via
 * `getFeature` and `pickSignal`.
 *
 * Cache layout (design.md §Components and Interfaces → HCU):
 *
 *   valuesByDevice : Map<deviceId, Map<feature, HmipFeatureValue>>
 *   metaByDevice   : Map<deviceId, HmipDeviceMeta>
 *
 * Feature extraction policy: walk every `device.functionalChannels.*`
 * channel and lift every primitive (number / boolean / string) value
 * into the device's feature map, keyed by the field name as it appears
 * in the channel object. Channel-meta keys (`functionalChannelType`,
 * `label`, `index`, `groupIndex`, `deviceId`) are skipped so the
 * cache stays focused on actual telemetry.
 *
 * Tolerance policy: malformed input (`null`, primitives, missing
 * `devices`, partial channels) never throws. Unknown shapes are
 * silently skipped. This matches the Connect API's habit of widening
 * payloads in minor releases without bumping a schema version — we
 * never want a malformed event to take down the engine.
 *
 * Strict-mode notes (`exactOptionalPropertyTypes`,
 * `noUncheckedIndexedAccess`):
 *   - Optional meta fields are conditionally assigned (never `=
 *     undefined`).
 *   - `Map.get` results are checked before use.
 *   - All external object accesses go through narrowed `Record<string,
 *     unknown>` casts after a `typeof === 'object'` guard.
 */

import type { SignalBinding, SourceRef } from '../../shared/types.js';

// ---------------------------------------------------------------------------
// Public types.
// ---------------------------------------------------------------------------

/**
 * One feature reading. `value` is the raw primitive captured from the
 * HCU channel (left untyped at the API boundary because Connect
 * features span numbers, booleans, and strings); the engine narrows
 * via the `T` parameter when it knows what to expect.
 *
 * `observedAt` is stamped from the cache's injected clock when the
 * feature is ingested (NOT from any `lastStatusUpdate` field on the
 * device), so the stale window in `pickSignal` is measured against the
 * plugin's local wall clock — the same clock the engine uses for
 * cycle scheduling.
 */
export interface HmipFeatureValue<T = unknown> {
  readonly value: T;
  readonly observedAt: Date;
  readonly deviceId: string;
  readonly feature: string;
  /**
   * The `index` of the functional channel this value was lifted from
   * (Connect API channels carry a numeric `index`). Captured so
   * device control (`setSwitchState`, `setShutterLevel`) can target
   * the exact channel that actually carries the feature instead of
   * guessing channel 1. `undefined` when the source channel omitted
   * a numeric `index`.
   */
  readonly channelIndex?: number;
}

/**
 * Device meta info. `deviceType` is the Connect API §6.6.5 device
 * type string (e.g. `WINDOW_COVERING`, `CLIMATE_SENSOR`).
 * `manufacturerCode` is taken from the spec field of the same name
 * when present, falling back to the looser `modelType` (e.g.
 * `HmIP-HAP`) which the HCU emits for native devices. `friendlyName`
 * is the user-visible label set in the HmIP app (`label` field on
 * the device object).
 *
 * All three info fields are optional — the OpenMeteo plugin in
 * particular populates only some of them depending on which release
 * is installed, and the wizard's heuristic must work either way.
 */
export interface HmipDeviceMeta {
  readonly deviceId: string;
  readonly deviceType?: string;
  readonly manufacturerCode?: string;
  readonly friendlyName?: string;
}

/**
 * Outcome of a `pickSignal` call.
 *
 *  - `ok: true`  — the binding resolved to a fresh value. `usedFallback`
 *                 reports which leg of the binding produced it so the
 *                 dashboard can flag fallbacks.
 *  - `ok: false` — `'unbound'` if no binding was supplied, `'stale'`
 *                 if the most-recent attempted ref had a value but it
 *                 was older than `staleAfterSec`, `'no_value'` if the
 *                 most-recent attempted ref had no value at all (or
 *                 was a `'fusion'` ref that this resolver does not
 *                 handle — see notes below).
 */
export type SignalResolution<T = unknown> =
  | {
      readonly ok: true;
      readonly value: T;
      readonly observedAt: Date;
      readonly usedFallback: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: 'unbound' | 'stale' | 'no_value';
    };

// ---------------------------------------------------------------------------
// Internal shape probes.
// ---------------------------------------------------------------------------

/**
 * Permissive Zod probe for a single device entry inside `devices` in
 * `getSystemState` and inside DEVICE_ADDED/DEVICE_CHANGED events.
 *
 * NOTE: device parsing no longer goes through a Zod schema. A strict
 * schema (with e.g. `manufacturerCode: string`) silently dropped
 * EVERY native HmIP device on a real HCU because native devices
 * carry fields with types the schema did not anticipate (numeric
 * `manufacturerCode`, `null` `label`, …). `mergeDevice` now reads
 * each field defensively with a type guard instead, so no device is
 * ever rejected wholesale. See {@link HcuSourceCache.mergeDevice}.
 */

/**
 * Channel-level keys that describe the channel itself rather than a
 * sensor reading. Skipping them keeps the feature map focused on
 * actual telemetry and avoids polluting it with values like
 * `functionalChannelType: 'CLIMATE_SENSOR_CHANNEL'` that the engine
 * would never bind to.
 */
const CHANNEL_META_KEYS: ReadonlySet<string> = new Set([
  'functionalChannelType',
  'label',
  'index',
  'groupIndex',
  'deviceId',
]);

// ---------------------------------------------------------------------------
// Cache.
// ---------------------------------------------------------------------------

/**
 * Local mirror of the HCU's device + feature state. Constructor wires
 * up the clock; everything else is fed through `applySystemState` /
 * `applyEvent` by the Connect layer.
 *
 *   const cache = new HcuSourceCache();
 *   cache.applySystemState(getSystemStateBody);
 *   for await (const evt of events) cache.applyEvent(evt);
 *   const t = cache.getFeature(deviceId, 'actualTemperature');
 */
export class HcuSourceCache {
  private readonly valuesByDevice: Map<
    string,
    Map<string, HmipFeatureValue>
  > = new Map();
  private readonly metaByDevice: Map<string, HmipDeviceMeta> = new Map();
  private readonly now: () => Date;

  public constructor(options: { now?: () => Date } = {}) {
    this.now = options.now ?? ((): Date => new Date());
  }

  /**
   * Ingest the body of an `HMIP_SYSTEM_RESPONSE` to
   * `/hmip/home/getSystemState`. Accepts either the inner body
   * (`{ devices: {...} }`) or the response wrapper
   * (`{ body: { body: { devices: {...} } } }`) so the Connect layer
   * can hand us either shape without unwrapping. Malformed input is
   * silently dropped.
   */
  public applySystemState(snapshot: unknown): void {
    const devices = extractDevices(snapshot);
    if (devices === null) {
      return;
    }
    for (const [key, deviceObj] of Object.entries(devices)) {
      this.mergeDevice(deviceObj, key);
    }
  }

  /**
   * Ingest the body of an `HMIP_SYSTEM_EVENT`. The canonical shape is
   * `{ eventTransaction: { events: { '0': { pushEventType, device,
   * ... }, ... } } }` (Connect API §6.9). For each event entry that
   * carries a `device` object, the device is merged into the cache —
   * existing meta and features are preserved if the event omits them
   * (the spec promises a complete device on DEVICE_CHANGED, but the
   * OpenMeteo plugin emits partials in practice and we want to be
   * forgiving). DEVICE_ADDED is handled by the same code path —
   * a new `deviceId` is added on first sight.
   *
   * As a tolerance affordance, a top-level `{ devices: {...} }` shape
   * is also accepted in case the Connect layer hands us the inner
   * body of a response by mistake.
   */
  public applyEvent(partial: unknown): void {
    if (partial === null || typeof partial !== 'object') {
      return;
    }
    const root = partial as Record<string, unknown>;

    // Canonical event-transaction path.
    const txn = root['eventTransaction'];
    if (txn !== null && typeof txn === 'object') {
      const events = (txn as Record<string, unknown>)['events'];
      if (events !== null && typeof events === 'object') {
        for (const ev of Object.values(events as Record<string, unknown>)) {
          if (ev === null || typeof ev !== 'object') {
            continue;
          }
          const device = (ev as Record<string, unknown>)['device'];
          if (device !== null && typeof device === 'object') {
            this.mergeDevice(device);
          }
        }
      }
    }

    // Tolerant fallback: a snapshot-shaped partial.
    const devices = root['devices'];
    if (devices !== null && typeof devices === 'object') {
      for (const [key, deviceObj] of Object.entries(
        devices as Record<string, unknown>,
      )) {
        this.mergeDevice(deviceObj, key);
      }
    }
  }

  /**
   * Meta entry for a known device, or `undefined` if the device has
   * never been seen.
   */
  public getDevice(deviceId: string): HmipDeviceMeta | undefined {
    return this.metaByDevice.get(deviceId);
  }

  /**
   * Latest cached value for `feature` on `deviceId`. Returns
   * `undefined` if the device or feature has never been seen.
   * Stale-checking is the caller's responsibility (see `pickSignal`
   * for the binding-aware path).
   */
  public getFeature(
    deviceId: string,
    feature: string,
  ): HmipFeatureValue | undefined {
    return this.valuesByDevice.get(deviceId)?.get(feature);
  }

  /**
   * All known devices, sorted by `deviceId` for deterministic UI
   * rendering in the wizard's discovery panel.
   */
  public listDevices(): readonly HmipDeviceMeta[] {
    return Array.from(this.metaByDevice.values()).sort((a, b) =>
      a.deviceId.localeCompare(b.deviceId),
    );
  }

  /**
   * All feature names currently cached for `deviceId`. Returns an
   * empty array if the device is unknown or has never produced a
   * feature value. Order matches the cache insertion order which
   * mirrors the order in which the HCU emits the features.
   *
   * Used by the dashboard's discovery view to surface
   * temperature-capable devices regardless of `deviceType` — the
   * Connect API spec lets multiple device archetypes carry
   * `ActualTemperature`, and we want the wizard to find them all.
   */
  public listFeatures(deviceId: string): readonly string[] {
    const features = this.valuesByDevice.get(deviceId);
    if (features === undefined) return [];
    return Array.from(features.keys());
  }

  /**
   * Subset of {@link listDevices} carrying at least one feature
   * whose name matches the (lowercased) `featureName`. Lets the
   * dashboard offer "every device that reports temperature" without
   * pinning to a specific `deviceType` enum value, which is fragile
   * (HMIP heating thermostats, wall thermostats, climate sensors,
   * and several third-party plugins all report
   * `actualTemperature`).
   */
  public findDevicesWithFeature(
    featureName: string,
  ): readonly HmipDeviceMeta[] {
    const needle = featureName.toLowerCase();
    return this.listDevices().filter((d) => {
      const features = this.valuesByDevice.get(d.deviceId);
      if (features === undefined) return false;
      for (const key of features.keys()) {
        if (key.toLowerCase() === needle) return true;
      }
      return false;
    });
  }

  /**
   * Full device inventory for the discovery diagnostic: every cached
   * device plus the list of feature names it exposes. This is the
   * ground-truth view the wizard/diagnostics surface so a user can
   * identify which `PLUGIN_EXTERNAL` device is a room thermostat, a
   * window contact, a shutter, etc. — without us having to guess
   * feature names up front. Sorted by `deviceId` (inherited from
   * {@link listDevices}); features sorted alphabetically for stable
   * rendering.
   */
  public listInventory(): ReadonlyArray<{
    deviceId: string;
    deviceType?: string;
    friendlyName?: string;
    features: readonly string[];
    values: Readonly<Record<string, string | number | boolean>>;
  }> {
    return this.listDevices().map((d) => {
      const featureMap = this.valuesByDevice.get(d.deviceId);
      const features = Array.from(featureMap?.keys() ?? []).sort((a, b) =>
        a.localeCompare(b),
      );
      const values: Record<string, string | number | boolean> = {};
      if (featureMap !== undefined) {
        for (const [k, v] of featureMap.entries()) {
          const raw = v.value;
          if (
            typeof raw === 'string' ||
            typeof raw === 'number' ||
            typeof raw === 'boolean'
          ) {
            values[k] = raw;
          }
        }
      }
      const entry: {
        deviceId: string;
        deviceType?: string;
        friendlyName?: string;
        features: readonly string[];
        values: Readonly<Record<string, string | number | boolean>>;
      } = { deviceId: d.deviceId, features, values };
      if (d.deviceType !== undefined) entry.deviceType = d.deviceType;
      if (d.friendlyName !== undefined) entry.friendlyName = d.friendlyName;
      return entry;
    });
  }

  /**
   * Subset of `listDevices()` filtered to `deviceType ===
   * 'CLIMATE_SENSOR'`. Used by the wizard's step 2 OpenMeteo
   * heuristic and by the source-discovery panel to surface candidate
   * temperature sources.
   *
   * NOTE (verified against a real HCU, 2026-06): the Connect-API
   * §6.6.5 `DeviceType` enum (`CLIMATE_SENSOR`, `WINDOW_COVERING`, …)
   * applies to a PLUGIN's OWN devices in a DiscoverResponse. Devices
   * read back from `/hmip/home/getSystemState` carry the HMIP system
   * `type` instead (`SHUTTER_CONTACT`, `PLUGIN_EXTERNAL`, …). So
   * filtering system-state devices by `CLIMATE_SENSOR` matches
   * nothing on a real system. We therefore classify system-state
   * devices by the **features they expose**, not their `deviceType`.
   * This method is kept for API compatibility (it now also accepts
   * devices that carry an `actualTemperature` feature) but new code
   * should prefer {@link findDevicesWithFeature}.
   */
  public findClimateSensors(): readonly HmipDeviceMeta[] {
    const byFeature = new Set(
      this.findDevicesWithFeature('actualTemperature').map((d) => d.deviceId),
    );
    return this.listDevices().filter(
      (d) => d.deviceType === 'CLIMATE_SENSOR' || byFeature.has(d.deviceId),
    );
  }

  /**
   * Devices that most likely belong to the OpenMeteo plugin. On a
   * real HCU these come through `getSystemState` as
   * `deviceType: PLUGIN_EXTERNAL` with a `friendlyName` like
   * `"Wetter Open-Meteo"`, `"Wetter Open-Meteo (heute)"`, … — NOT as
   * `CLIMATE_SENSOR`. Identification is therefore purely heuristic
   * and feature-aware, independent of `deviceType`:
   *
   *   1. `friendlyName` matches `/open[\s_-]?meteo/i` — covers
   *      `Open-Meteo` (hyphen, the real default label),
   *      `OpenMeteo`, `open meteo`, `OPEN_METEO`. The earlier
   *      `/openmeteo/i` form missed the hyphenated default and was
   *      the reason discovery surfaced zero candidates.
   *   2. `manufacturerCode?.toLowerCase()` contains `openmeteo`
   *      (covers installations that kept a default label but where
   *      the plugin tagged a stable vendor code).
   *
   * The device must additionally expose at least one weather-ish
   * feature (`actualTemperature`, `humidity`, `illumination`,
   * `windSpeed`, `raining`, `sunshineDuration`) so a `WINDOW_COVERING`
   * that a user happened to rename "Open-Meteo" is not misclassified.
   */
  public findOpenMeteoSensors(): readonly HmipDeviceMeta[] {
    const weatherFeatures = [
      'actualTemperature',
      'humidity',
      'illumination',
      'windSpeed',
      'raining',
      'sunshineDuration',
    ];
    return this.listDevices().filter((d) => {
      const nameMatch =
        d.friendlyName !== undefined &&
        /open[\s_-]?meteo/i.test(d.friendlyName);
      const codeMatch =
        d.manufacturerCode !== undefined &&
        d.manufacturerCode.toLowerCase().includes('openmeteo');
      if (!nameMatch && !codeMatch) return false;
      const features = this.listFeatures(d.deviceId).map((f) =>
        f.toLowerCase(),
      );
      return weatherFeatures.some((wf) =>
        features.includes(wf.toLowerCase()),
      );
    });
  }

  // -------------------------------------------------------------------------
  // Internal merge.
  // -------------------------------------------------------------------------

  private mergeDevice(deviceObj: unknown, fallbackId?: string): void {
    // Defensive field extraction — NEVER reject the whole device just
    // because one meta field has an unexpected type. The earlier
    // strict Zod schema (`manufacturerCode: string` etc.) silently
    // dropped EVERY native HmIP device on a real HCU (verified
    // 2026-06: 118 sent, 49 survived) because native devices carry
    // fields like a numeric `manufacturerCode` or a `null` `label`
    // that the strict schema rejected. We now read each field with a
    // type guard and ignore mismatches, so a `BRAND_SHUTTER`,
    // `SHUTTER_CONTACT`, `WALL_MOUNTED_THERMOSTAT_PRO`, … all survive.
    if (deviceObj === null || typeof deviceObj !== 'object') {
      return;
    }
    const obj = deviceObj as Record<string, unknown>;
    // Prefer the device's own `id`; fall back to the map key from
    // `getSystemState.devices` / event `devices` so a device object
    // that omits an inner `id` is still cached under its real id.
    const rawId = obj['id'];
    const deviceId =
      typeof rawId === 'string' && rawId.length > 0
        ? rawId
        : fallbackId !== undefined && fallbackId.length > 0
          ? fallbackId
          : null;
    if (deviceId === null) {
      return;
    }

    const typeStr =
      typeof obj['type'] === 'string' ? (obj['type'] as string) : undefined;
    // `manufacturerCode` may be a string OR a number on native
    // devices; `modelType` (e.g. "HmIP-BBL") is the friendlier
    // fallback. Coerce numbers to string so the meta field stays a
    // string.
    const rawMfr = obj['manufacturerCode'];
    const mfrStr =
      typeof rawMfr === 'string'
        ? rawMfr
        : typeof rawMfr === 'number'
          ? String(rawMfr)
          : undefined;
    const modelStr =
      typeof obj['modelType'] === 'string'
        ? (obj['modelType'] as string)
        : undefined;
    const labelStr =
      typeof obj['label'] === 'string' ? (obj['label'] as string) : undefined;
    const channels =
      obj['functionalChannels'] !== null &&
      typeof obj['functionalChannels'] === 'object'
        ? (obj['functionalChannels'] as Record<string, unknown>)
        : undefined;

    // Meta merge — preserve existing fields when the event omits them.
    const existingMeta = this.metaByDevice.get(deviceId);
    const meta: { -readonly [K in keyof HmipDeviceMeta]: HmipDeviceMeta[K] } = {
      deviceId,
    };
    if (typeStr !== undefined) {
      meta.deviceType = typeStr;
    } else if (existingMeta?.deviceType !== undefined) {
      meta.deviceType = existingMeta.deviceType;
    }
    if (mfrStr !== undefined) {
      meta.manufacturerCode = mfrStr;
    } else if (modelStr !== undefined) {
      meta.manufacturerCode = modelStr;
    } else if (existingMeta?.manufacturerCode !== undefined) {
      meta.manufacturerCode = existingMeta.manufacturerCode;
    }
    if (labelStr !== undefined && labelStr.length > 0) {
      meta.friendlyName = labelStr;
    } else if (existingMeta?.friendlyName !== undefined) {
      meta.friendlyName = existingMeta.friendlyName;
    }
    this.metaByDevice.set(deviceId, meta);

    // Feature merge — primitives only, channel-meta keys skipped.
    if (channels === undefined) {
      return;
    }
    let features = this.valuesByDevice.get(deviceId);
    if (features === undefined) {
      features = new Map();
      this.valuesByDevice.set(deviceId, features);
    }
    const observedAt = this.now();
    for (const channel of Object.values(channels)) {
      if (channel === null || typeof channel !== 'object') {
        continue;
      }
      const channelObj = channel as Record<string, unknown>;
      const idxRaw = channelObj['index'];
      const channelIndex =
        typeof idxRaw === 'number' ? idxRaw : undefined;
      for (const [key, raw] of Object.entries(channelObj)) {
        if (CHANNEL_META_KEYS.has(key)) {
          continue;
        }
        if (
          typeof raw === 'number' ||
          typeof raw === 'boolean' ||
          typeof raw === 'string'
        ) {
          features.set(key, {
            value: raw,
            observedAt,
            deviceId,
            feature: key,
            ...(channelIndex !== undefined ? { channelIndex } : {}),
          });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Selector.
// ---------------------------------------------------------------------------

/**
 * Resolve a `SignalBinding` against the HCU cache.
 *
 * Resolution rules (matching design.md §Components and Interfaces and
 * the binding's discriminated union):
 *
 *   - `binding === undefined`               → `{ ok: false, reason: 'unbound' }`.
 *   - `kind: 'static'`                      → always succeeds with the literal value
 *                                             stamped at `opts.now`.
 *   - `kind: 'hmip'` / `kind: 'openmeteo'`  → look up `getFeature(deviceId, feature)`.
 *                                             Hit + age ≤ `staleAfterSec * 1000`
 *                                             succeeds; hit + stale falls through to
 *                                             the fallback; miss falls through with
 *                                             reason `'no_value'`.
 *   - `kind: 'fusion'`                      → returns `'no_value'` unconditionally.
 *                                             FusionSolar lives outside the HCU
 *                                             cache and is consulted by the
 *                                             orchestrator separately. `pickSignal`
 *                                             only resolves bindings that travel
 *                                             through the HCU.
 *
 * On primary failure, `fallback` (if present) is tried with the same
 * rules; success there reports `usedFallback: true`. If neither leg
 * yields a fresh value, the failure reason of the most-recent attempt
 * is returned.
 */
export function pickSignal<T = unknown>(
  binding: SignalBinding | undefined,
  cache: HcuSourceCache,
  opts: { now: Date },
): SignalResolution<T> {
  if (binding === undefined) {
    return { ok: false, reason: 'unbound' };
  }

  const primary = tryResolve<T>(
    binding.primary,
    cache,
    opts.now,
    binding.staleAfterSec,
  );
  if (primary.ok) {
    return {
      ok: true,
      value: primary.value,
      observedAt: primary.observedAt,
      usedFallback: false,
    };
  }

  if (binding.fallback !== undefined) {
    const fallback = tryResolve<T>(
      binding.fallback,
      cache,
      opts.now,
      binding.staleAfterSec,
    );
    if (fallback.ok) {
      return {
        ok: true,
        value: fallback.value,
        observedAt: fallback.observedAt,
        usedFallback: true,
      };
    }
    // Most-recent failure reason wins — fallback was tried last.
    return { ok: false, reason: fallback.reason };
  }

  return { ok: false, reason: primary.reason };
}

// ---------------------------------------------------------------------------
// Internal helpers.
// ---------------------------------------------------------------------------

type ResolveOutcome<T> =
  | { readonly ok: true; readonly value: T; readonly observedAt: Date }
  | { readonly ok: false; readonly reason: 'stale' | 'no_value' };

function tryResolve<T>(
  ref: SourceRef,
  cache: HcuSourceCache,
  now: Date,
  staleAfterSec: number,
): ResolveOutcome<T> {
  switch (ref.kind) {
    case 'static':
      return {
        ok: true,
        value: ref.value as unknown as T,
        observedAt: now,
      };
    case 'hmip':
    case 'openmeteo': {
      const fv = cache.getFeature(ref.deviceId, ref.feature);
      if (fv === undefined) {
        return { ok: false, reason: 'no_value' };
      }
      const ageMs = now.getTime() - fv.observedAt.getTime();
      if (ageMs > staleAfterSec * 1000) {
        return { ok: false, reason: 'stale' };
      }
      return {
        ok: true,
        value: fv.value as T,
        observedAt: fv.observedAt,
      };
    }
    case 'fusion':
      // FusionSolar is not part of the HCU cache. The orchestrator
      // routes 'fusion' bindings through the FusionSolar adapter
      // directly. Document this clearly so callers do not silently
      // wonder why their fusion binding never resolves.
      return { ok: false, reason: 'no_value' };
    case 'openmeteo_http':
      // Direct OpenMeteo HTTP values are not in the HCU cache either;
      // the resolver in `sources/index.ts` routes them through the
      // OpenMeteoAdapter. Mirror the 'fusion' behaviour here.
      return { ok: false, reason: 'no_value' };
  }
}

/**
 * Pull the `devices` map out of either the inner body or the full
 * response wrapper of `getSystemState`. Returns `null` (rather than
 * throwing) when the input is malformed.
 */
function extractDevices(
  snapshot: unknown,
): Record<string, unknown> | null {
  if (snapshot === null || typeof snapshot !== 'object') {
    return null;
  }
  const root = snapshot as Record<string, unknown>;

  // Direct: { devices: {...} }
  const direct = root['devices'];
  if (direct !== null && typeof direct === 'object' && !Array.isArray(direct)) {
    return direct as Record<string, unknown>;
  }

  // Wrapped response: { body: { code: 200, body: { devices: {...} } } }
  const outerBody = root['body'];
  if (outerBody !== null && typeof outerBody === 'object') {
    const innerBody = (outerBody as Record<string, unknown>)['body'];
    if (innerBody !== null && typeof innerBody === 'object') {
      const innerDevices = (innerBody as Record<string, unknown>)['devices'];
      if (
        innerDevices !== null &&
        typeof innerDevices === 'object' &&
        !Array.isArray(innerDevices)
      ) {
        return innerDevices as Record<string, unknown>;
      }
    }
    // Or one level: { body: { devices: {...} } }
    const oneLevel = (outerBody as Record<string, unknown>)['devices'];
    if (
      oneLevel !== null &&
      typeof oneLevel === 'object' &&
      !Array.isArray(oneLevel)
    ) {
      return oneLevel as Record<string, unknown>;
    }
  }

  return null;
}
