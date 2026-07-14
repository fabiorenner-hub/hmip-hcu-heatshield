/**
 * Source-discovery hook used by the Sources tab and the wizard's
 * Schritt 2 (Tasks 12.2 / 12.4).
 *
 * Wraps `POST /api/sources/discover` so the components stay
 * declarative: hit `discover()` and read the result + status off
 * three signals (`devices`, `climateSensors`, `openMeteo`). The
 * server returns `503` when the boot module hasn't wired the
 * discovery dependency yet; we surface that as a separate
 * `unavailable` flag so the SPA can show a "discovery not ready
 * yet" hint without conflating it with a network error.
 */

import { signal, type Signal } from '@preact/signals';

/**
 * Mirror of `HmipDeviceMeta` from the source-adapter layer. We
 * duplicate the shape so the SPA bundle does not pull the engine /
 * Connect-API type graph into the browser.
 */
export interface DiscoveredDevice {
  deviceId: string;
  deviceType?: string;
  manufacturerCode?: string;
  friendlyName?: string;
}

export type ConnectState = 'off' | 'connecting' | 'connected';

export interface DiscoveryResult {
  devices: DiscoveredDevice[];
  climateSensors: DiscoveredDevice[];
  openMeteo: DiscoveredDevice[];
  connectState?: ConnectState;
  lastError?: string | null;
  attemptedRefresh?: boolean;
  /** Histogram of `deviceType` strings emitted by the HCU. */
  deviceTypeHistogram?: ReadonlyArray<{ deviceType: string; count: number }>;
  /** Devices carrying an `actualTemperature` feature. */
  temperatureSources?: DiscoveredDevice[];
  /** Devices carrying a `shutterLevel` feature (controllable shutters). */
  shutterSources?: DiscoveredDevice[];
  /** Devices carrying a `windowState` feature (window/door contacts). */
  contactSources?: DiscoveredDevice[];
  /** Devices carrying an `illumination` feature (candidate global light sensors). */
  illuminationSources?: DiscoveredDevice[];
  /** Full per-device inventory with feature names. */
  inventory?: ReadonlyArray<{
    deviceId: string;
    deviceType?: string;
    friendlyName?: string;
    features: readonly string[];
    values?: Readonly<Record<string, string | number | boolean>>;
  }>;
  /** Raw device count off the wire, before schema filtering. */
  rawDeviceCount?: number;
  /** Raw deviceType histogram off the wire, before schema filtering. */
  rawDeviceTypeHistogram?: ReadonlyArray<{ deviceType: string; count: number }>;
  /** Build stamp of the live plugin image. */
  pluginBuild?: string;
}

const devicesSig = signal<DiscoveredDevice[]>([]);
const climateSensorsSig = signal<DiscoveredDevice[]>([]);
const openMeteoSig = signal<DiscoveredDevice[]>([]);
const discoveryErrorSig = signal<string | null>(null);
const unavailableSig = signal<boolean>(false);
const discoveringSig = signal<boolean>(false);
const connectStateSig = signal<ConnectState | null>(null);
const lastErrorSig = signal<string | null>(null);
const attemptedRefreshSig = signal<boolean>(false);
const lastDiscoveryAtSig = signal<string | null>(null);
const histogramSig = signal<
  ReadonlyArray<{ deviceType: string; count: number }>
>([]);
const temperatureSourcesSig = signal<DiscoveredDevice[]>([]);
const shutterSourcesSig = signal<DiscoveredDevice[]>([]);
const contactSourcesSig = signal<DiscoveredDevice[]>([]);
const illuminationSourcesSig = signal<DiscoveredDevice[]>([]);
const inventorySig = signal<
  ReadonlyArray<{
    deviceId: string;
    deviceType?: string;
    friendlyName?: string;
    features: readonly string[];
    values?: Readonly<Record<string, string | number | boolean>>;
  }>
>([]);
const rawDeviceCountSig = signal<number | null>(null);
const rawHistogramSig = signal<
  ReadonlyArray<{ deviceType: string; count: number }>
>([]);
const pluginBuildSig = signal<string | null>(null);

export interface UseDiscoveryResult {
  devices: Signal<DiscoveredDevice[]>;
  climateSensors: Signal<DiscoveredDevice[]>;
  openMeteo: Signal<DiscoveredDevice[]>;
  error: Signal<string | null>;
  unavailable: Signal<boolean>;
  discovering: Signal<boolean>;
  /** Connect-API state at the time of the last successful call. */
  connectState: Signal<ConnectState | null>;
  /** Last `getSystemState` error reported by the server, if any. */
  lastError: Signal<string | null>;
  /** Whether the last call actually triggered a getSystemState. */
  attemptedRefresh: Signal<boolean>;
  /** ISO timestamp of the last successful discovery response. */
  lastDiscoveryAt: Signal<string | null>;
  /** Histogram of deviceType strings emitted by the HCU. */
  histogram: Signal<ReadonlyArray<{ deviceType: string; count: number }>>;
  /** Devices carrying an actualTemperature feature. */
  temperatureSources: Signal<DiscoveredDevice[]>;
  /** Devices carrying a shutterLevel feature (controllable shutters). */
  shutterSources: Signal<DiscoveredDevice[]>;
  /** Devices carrying a windowState feature (window/door contacts). */
  contactSources: Signal<DiscoveredDevice[]>;
  /** Devices carrying an illumination feature (candidate global light sensors). */
  illuminationSources: Signal<DiscoveredDevice[]>;
  /** Full per-device inventory with feature names. */
  inventory: Signal<
    ReadonlyArray<{
      deviceId: string;
      deviceType?: string;
      friendlyName?: string;
      features: readonly string[];
      values?: Readonly<Record<string, string | number | boolean>>;
    }>
  >;
  /** Raw device count off the wire (null until first discovery). */
  rawDeviceCount: Signal<number | null>;
  /** Raw deviceType histogram off the wire, before schema filtering. */
  rawHistogram: Signal<ReadonlyArray<{ deviceType: string; count: number }>>;
  /** Build stamp of the live plugin image (null until first discovery). */
  pluginBuild: Signal<string | null>;
  discover: () => Promise<void>;
}

export async function runDiscovery(): Promise<void> {
  discoveringSig.value = true;
  try {
    const res = await fetch('/api/sources/discover', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    if (res.status === 503) {
      unavailableSig.value = true;
      discoveryErrorSig.value =
        'Discovery is not yet available; the HCU adapter is still warming up.';
      return;
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const json = (await res.json()) as Partial<DiscoveryResult>;
    devicesSig.value = json.devices ?? [];
    climateSensorsSig.value = json.climateSensors ?? [];
    openMeteoSig.value = json.openMeteo ?? [];
    connectStateSig.value = json.connectState ?? null;
    lastErrorSig.value = json.lastError ?? null;
    attemptedRefreshSig.value = json.attemptedRefresh ?? false;
    lastDiscoveryAtSig.value = new Date().toISOString();
    histogramSig.value = json.deviceTypeHistogram ?? [];
    temperatureSourcesSig.value = json.temperatureSources ?? [];
    shutterSourcesSig.value = json.shutterSources ?? [];
    contactSourcesSig.value = json.contactSources ?? [];
    illuminationSourcesSig.value = json.illuminationSources ?? [];
    inventorySig.value = json.inventory ?? [];
    rawDeviceCountSig.value = json.rawDeviceCount ?? null;
    rawHistogramSig.value = json.rawDeviceTypeHistogram ?? [];
    pluginBuildSig.value = json.pluginBuild ?? null;
    discoveryErrorSig.value = null;
    unavailableSig.value = false;
  } catch (err) {
    discoveryErrorSig.value =
      err instanceof Error ? err.message : 'unknown error during discovery';
  } finally {
    discoveringSig.value = false;
  }
}

export function useDiscovery(): UseDiscoveryResult {
  return {
    devices: devicesSig,
    climateSensors: climateSensorsSig,
    openMeteo: openMeteoSig,
    error: discoveryErrorSig,
    unavailable: unavailableSig,
    discovering: discoveringSig,
    connectState: connectStateSig,
    lastError: lastErrorSig,
    attemptedRefresh: attemptedRefreshSig,
    lastDiscoveryAt: lastDiscoveryAtSig,
    histogram: histogramSig,
    temperatureSources: temperatureSourcesSig,
    shutterSources: shutterSourcesSig,
    contactSources: contactSourcesSig,
    illuminationSources: illuminationSourcesSig,
    inventory: inventorySig,
    rawDeviceCount: rawDeviceCountSig,
    rawHistogram: rawHistogramSig,
    pluginBuild: pluginBuildSig,
    discover: runDiscovery,
  };
}

/** Test-only helper: reset the module-level signals between cases. */
export function __resetDiscoveryStateForTests(): void {
  devicesSig.value = [];
  climateSensorsSig.value = [];
  openMeteoSig.value = [];
  discoveryErrorSig.value = null;
  unavailableSig.value = false;
  discoveringSig.value = false;
  connectStateSig.value = null;
  lastErrorSig.value = null;
  attemptedRefreshSig.value = false;
  lastDiscoveryAtSig.value = null;
  histogramSig.value = [];
  temperatureSourcesSig.value = [];
  shutterSourcesSig.value = [];
  contactSourcesSig.value = [];
  illuminationSourcesSig.value = [];
  inventorySig.value = [];
  rawDeviceCountSig.value = null;
  rawHistogramSig.value = [];
  pluginBuildSig.value = null;
}
