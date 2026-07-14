/**
 * Heat Shield — "Liquid Glass V2" native Quellen page (route `/sources`).
 *
 * A fully lg2-native rebuild of the classic `SourcesTab` with the SAME feature
 * scope (no functional loss). It reuses the v1 DATA layer verbatim — `useConfig`
 * (debounced auto-save via `scheduleSave`), `useDiscovery`/`runDiscovery`
 * (`POST /api/sources/discover`), `POST /api/config/probe`, `PUT /api/config`
 * and the shared `snapshot` signal — but renders its own `lg2-*` layout built
 * only from `--lg2-*` tokens (no `--hs-*`/`--color-*`, no v1 classes), matching
 * the `liquidGlass2Diagnostics`/`liquidGlass2Notifications` templates.
 *
 * Full v1 functional scope (nothing lost):
 *   - Device discovery (auto on first mount + manual "Geräte suchen" button),
 *     the shared `DiscoveryStatus` banner and the discovery error line.
 *   - FusionSolar: configured base URL + editable PV peak power (kWp).
 *   - HCU temperature-sensor list + OpenMeteo candidate list.
 *   - Open-Meteo (direct): enable toggle + fetch interval (minutes).
 *   - Per-signal binding editors for every global signal (temperature, PV,
 *     wind, cloud) — primary + fallback dropdowns sourced from the live
 *     discovery inventory (HMIP `actualTemperature`, OpenMeteo features,
 *     FusionSolar fields, Open-Meteo direct, fixed value), per-signal live
 *     value hints, a "Testen" button (`/api/config/probe`) that resolves the
 *     mode + first window's factor breakdown, and a staleness chip.
 *   - Per-room indoor-temperature bindings (primary + fallback).
 *   - Optimistic auto-save with inline save-error / save-ok feedback.
 *
 * Bilingual throughout, honest `–`/empty degradation.
 */

import { Fragment, h, type JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';

import type {
  Config,
  SignalBinding,
  SourceRef,
} from '../../../../../shared/types.js';
import { snapshot } from '../../store.js';
import { useConfig } from '../../hooks/useConfig.js';
import {
  runDiscovery,
  useDiscovery,
  type DiscoveredDevice,
} from '../../hooks/useDiscovery.js';
import { DiscoveryStatus } from '../discoveryStatus.js';
import { deviceLabel, formatValue } from '../../format.js';
import { t } from '../../i18n.js';

interface RoutableProps {
  path?: string;
}

interface GlobalSignalKey {
  key:
    | 'outdoorTemp'
    | 'frontOutdoorTemp'
    | 'backOutdoorTemp'
    | 'pvPower'
    | 'windSpeed'
    | 'forecastMaxTemp'
    | 'forecastCloudCover';
  labelDe: string;
  labelEn: string;
  /** Encourages the right candidate group in the dropdown. */
  group: 'temperature' | 'pv' | 'radiation' | 'wind' | 'cloud';
}

const GLOBAL_SIGNALS: GlobalSignalKey[] = [
  { key: 'outdoorTemp', labelDe: 'Außentemperatur', labelEn: 'Outdoor temperature', group: 'temperature' },
  { key: 'frontOutdoorTemp', labelDe: 'Außentemp. vorne (NO)', labelEn: 'Outdoor temp. front (NE)', group: 'temperature' },
  { key: 'backOutdoorTemp', labelDe: 'Außentemp. hinten (SW)', labelEn: 'Outdoor temp. back (SW)', group: 'temperature' },
  { key: 'pvPower', labelDe: 'PV-Leistung / Sonne (FusionSolar inputPower)', labelEn: 'PV power / sun (FusionSolar inputPower)', group: 'pv' },
  { key: 'windSpeed', labelDe: 'Windgeschwindigkeit', labelEn: 'Wind speed', group: 'wind' },
  { key: 'forecastMaxTemp', labelDe: 'Vorhersage Max-Temp', labelEn: 'Forecast max temp', group: 'temperature' },
  { key: 'forecastCloudCover', labelDe: 'Vorhersage Bewölkung', labelEn: 'Forecast cloud cover', group: 'cloud' },
];

/** value-string → live value lookup, formatted for display. */
type ValueLookup = (deviceId: string, feature: string) => string | undefined;

function stalenessLabel(state: string): string {
  switch (state) {
    case 'fresh':
      return t('aktuell', 'fresh');
    case 'soon':
      return t('bald veraltet', 'stale soon');
    case 'stale':
      return t('veraltet', 'stale');
    default:
      return '—';
  }
}

/**
 * Identity string for an option. Encodes the source kind plus the variant
 * fields so dropdown values round-trip back into a real `SourceRef`. Format:
 *
 *   - `static::<value>`
 *   - `hmip::<deviceId>::<feature>`
 *   - `fusion::<field>`
 *   - `openmeteo::<deviceId>::<feature>`
 *   - `openmeteo_http::<field>`
 *   - `__none__` for "no fallback"
 */
function encodeSourceRef(ref: SourceRef | undefined): string {
  if (ref === undefined) {
    return '__none__';
  }
  switch (ref.kind) {
    case 'static':
      return `static::${ref.value}`;
    case 'hmip':
      return `hmip::${ref.deviceId}::${ref.feature}`;
    case 'fusion':
      return `fusion::${ref.field}`;
    case 'openmeteo':
      return `openmeteo::${ref.deviceId}::${ref.feature}`;
    case 'openmeteo_http':
      return `openmeteo_http::${ref.field}`;
    default: {
      const _exhaustive: never = ref;
      void _exhaustive;
      return '__none__';
    }
  }
}

function decodeSourceRef(value: string): SourceRef | undefined {
  if (value === '__none__' || value.length === 0) {
    return undefined;
  }
  const parts = value.split('::');
  const kind = parts[0];
  if (kind === 'static') {
    const v = Number.parseFloat(parts[1] ?? '0');
    return { kind: 'static', value: Number.isFinite(v) ? v : 0 };
  }
  if (kind === 'hmip' && parts[1] !== undefined && parts[2] !== undefined) {
    return { kind: 'hmip', deviceId: parts[1], feature: parts[2] };
  }
  if (kind === 'fusion' && parts[1] !== undefined) {
    return {
      kind: 'fusion',
      field: parts[1] as Extract<SourceRef, { kind: 'fusion' }>['field'],
    };
  }
  if (kind === 'openmeteo' && parts[1] !== undefined && parts[2] !== undefined) {
    return {
      kind: 'openmeteo',
      deviceId: parts[1],
      feature: parts[2] as Extract<SourceRef, { kind: 'openmeteo' }>['feature'],
    };
  }
  if (kind === 'openmeteo_http' && parts[1] !== undefined) {
    return {
      kind: 'openmeteo_http',
      field: parts[1] as Extract<SourceRef, { kind: 'openmeteo_http' }>['field'],
    };
  }
  return undefined;
}

interface OptionEntry {
  value: string;
  label: string;
}

/**
 * Build the dropdown option list for a logical signal. Heuristic:
 *
 *   - temperature/cloud/wind → OpenMeteo features + per-temperature-capable
 *     HCU device `actualTemperature` HMIP refs.
 *   - pv → all six FusionSolar fields.
 *   - radiation → OpenMeteo `illumination` + `sunshineDuration` plus a static
 *     row.
 *
 * The `static::0` row is always available as a sensible "leave at 0" fallback
 * for users without an outdoor temperature sensor.
 */
function buildOptions(
  group: GlobalSignalKey['group'],
  discovery: {
    devices: DiscoveredDevice[];
    openMeteo: DiscoveredDevice[];
    temperatureSources: DiscoveredDevice[];
  },
  valueOf: ValueLookup,
): OptionEntry[] {
  const out: OptionEntry[] = [];
  // Temperature-capable HCU devices are detected by FEATURE
  // (actualTemperature), not by the `CLIMATE_SENSOR` deviceType enum — native
  // HmIP wall thermostats / temp-humidity sensors expose actualTemperature but
  // are typed WALL_MOUNTED_THERMOSTAT_PRO, TEMPERATURE_HUMIDITY_SENSOR_OUTDOOR,
  // etc.
  const tempDevices = discovery.temperatureSources;

  /** Append " = <value>" when a live value is known for the ref. */
  const withVal = (label: string, deviceId: string, feature: string): string => {
    const v = valueOf(deviceId, feature);
    return v !== undefined ? `${label} = ${v}` : label;
  };

  if (group === 'temperature') {
    for (const d of tempDevices) {
      out.push({
        value: encodeSourceRef({ kind: 'hmip', deviceId: d.deviceId, feature: 'actualTemperature' }),
        label: withVal(
          `${deviceLabel(d)} · ${t('Temperatur', 'Temperature')}`,
          d.deviceId,
          'actualTemperature',
        ),
      });
    }
    for (const d of discovery.openMeteo) {
      out.push({
        value: encodeSourceRef({
          kind: 'openmeteo',
          deviceId: d.deviceId,
          feature: 'actualTemperature',
        }),
        label: withVal(
          `${deviceLabel(d)} · ${t('Temperatur', 'Temperature')}`,
          d.deviceId,
          'actualTemperature',
        ),
      });
    }
    out.push({
      value: encodeSourceRef({ kind: 'openmeteo_http', field: 'temperature' }),
      label: t('Open-Meteo (direkt) · Außentemperatur', 'Open-Meteo (direct) · Outdoor temperature'),
    });
    out.push({
      value: encodeSourceRef({ kind: 'openmeteo_http', field: 'maxTempToday' }),
      label: t('Open-Meteo (direkt) · Tageshöchsttemperatur', 'Open-Meteo (direct) · Daily high temperature'),
    });
  } else if (group === 'pv') {
    const FUSION_LABELS: Record<string, string> = {
      inputPower: t('PV-Erzeugung / Sonne (empfohlen)', 'PV generation / sun (recommended)'),
      activePower: t('Wechselrichter AC-Leistung', 'Inverter AC power'),
      meterActivePower: t('Netzleistung (Bezug/Einspeisung)', 'Grid power (import/export)'),
      batterySoc: t('Akku-Ladestand (%)', 'Battery charge level (%)'),
      batteryChargeDischargePower: t('Akku Lade-/Entladeleistung', 'Battery charge/discharge power'),
      internalTemp: t('Wechselrichter-Temperatur', 'Inverter temperature'),
    };
    for (const f of [
      'inputPower',
      'activePower',
      'meterActivePower',
      'batterySoc',
      'batteryChargeDischargePower',
      'internalTemp',
    ] as const) {
      out.push({
        value: encodeSourceRef({ kind: 'fusion', field: f }),
        label: `FusionSolar · ${FUSION_LABELS[f] ?? f}`,
      });
    }
  } else if (group === 'radiation') {
    for (const d of discovery.openMeteo) {
      out.push({
        value: encodeSourceRef({
          kind: 'openmeteo',
          deviceId: d.deviceId,
          feature: 'illumination',
        }),
        label: withVal(`${deviceLabel(d)} · ${t('Beleuchtungsstärke', 'Illuminance')}`, d.deviceId, 'illumination'),
      });
      out.push({
        value: encodeSourceRef({
          kind: 'openmeteo',
          deviceId: d.deviceId,
          feature: 'sunshineDuration',
        }),
        label: withVal(`${deviceLabel(d)} · ${t('Sonnenscheindauer', 'Sunshine duration')}`, d.deviceId, 'sunshineDuration'),
      });
    }
    out.push({
      value: encodeSourceRef({ kind: 'openmeteo_http', field: 'radiation' }),
      label: t('Open-Meteo (direkt) · Globalstrahlung (W/m²)', 'Open-Meteo (direct) · Global radiation (W/m²)'),
    });
  } else if (group === 'wind') {
    for (const d of discovery.openMeteo) {
      out.push({
        value: encodeSourceRef({
          kind: 'openmeteo',
          deviceId: d.deviceId,
          feature: 'windSpeed',
        }),
        label: withVal(`${deviceLabel(d)} · ${t('Wind', 'Wind')}`, d.deviceId, 'windSpeed'),
      });
    }
    out.push({
      value: encodeSourceRef({ kind: 'openmeteo_http', field: 'windSpeed' }),
      label: t('Open-Meteo (direkt) · Windgeschwindigkeit (m/s)', 'Open-Meteo (direct) · Wind speed (m/s)'),
    });
  } else if (group === 'cloud') {
    for (const d of discovery.openMeteo) {
      out.push({
        value: encodeSourceRef({
          kind: 'openmeteo',
          deviceId: d.deviceId,
          feature: 'sunshineDuration',
        }),
        label: withVal(`${deviceLabel(d)} · ${t('Sonnenscheindauer', 'Sunshine duration')}`, d.deviceId, 'sunshineDuration'),
      });
    }
    out.push({
      value: encodeSourceRef({ kind: 'openmeteo_http', field: 'cloudCover' }),
      label: t('Open-Meteo (direkt) · Bewölkung (%)', 'Open-Meteo (direct) · Cloud cover (%)'),
    });
  }

  out.push({
    value: encodeSourceRef({ kind: 'static', value: 0 }),
    label: t('Fester Wert · 0', 'Fixed value · 0'),
  });
  return out;
}

interface ProbeOutcome {
  mode: string;
  factors: Record<string, number>;
  windowId: string | null;
}

/* -------------------------------------------------------------------------- */
/* Top-level page.                                                            */
/* -------------------------------------------------------------------------- */

export function LiquidGlass2Sources(_props: RoutableProps): JSX.Element {
  const cfg = useConfig();
  const discovery = useDiscovery();
  const [draftConfig, setDraftConfig] = useState<Config | null>(null);
  const [probeByKey, setProbeByKey] = useState<Record<string, ProbeOutcome | null>>({});

  const hydratedRef = useRef<boolean>(false);
  const touchedRef = useRef<boolean>(false);

  useEffect(() => {
    if (cfg.config.value !== null && !hydratedRef.current) {
      hydratedRef.current = true;
      setDraftConfig(cfg.config.value);
    }
  }, [cfg.config.value]);

  // Auto-discover on first mount so the mapping dropdowns are populated with the
  // live device list immediately — the user should not have to press
  // "Geräte suchen" just to see sources that are already assigned.
  useEffect(() => {
    if (discovery.inventory.value.length === 0 && !discovery.discovering.value) {
      void runDiscovery();
    }
  }, []);

  // Auto-save: persist source-binding edits after a short idle. Gated by
  // `touchedRef` so the initial hydration never fires a spurious save.
  useEffect(() => {
    if (!touchedRef.current || draftConfig === null || cfg.config.value === null) {
      return;
    }
    if (JSON.stringify(draftConfig) !== JSON.stringify(cfg.config.value)) {
      cfg.scheduleSave(draftConfig);
    }
  }, [draftConfig]);

  // Live value lookup keyed by deviceId → feature, from the latest discovery
  // inventory. Used to show each option's current reading.
  const valueOf = useMemo<ValueLookup>(() => {
    const inv = discovery.inventory.value;
    const byId = new Map<string, Readonly<Record<string, string | number | boolean>>>();
    for (const d of inv) {
      if (d.values !== undefined) {
        byId.set(d.deviceId, d.values);
      }
    }
    return (deviceId: string, feature: string): string | undefined => {
      const v = byId.get(deviceId)?.[feature];
      return v === undefined ? undefined : formatValue(v);
    };
  }, [discovery.inventory.value]);

  const setBinding = (
    scope: 'global' | 'room',
    key: string,
    leg: 'primary' | 'fallback',
    ref: SourceRef | undefined,
  ): void => {
    touchedRef.current = true;
    setDraftConfig((prev) => {
      if (prev === null) {
        return prev;
      }
      const next: Config = { ...prev };
      if (scope === 'global') {
        const gs = { ...next.globalSignals };
        const k = key as keyof Config['globalSignals'];
        const existing = gs[k] as SignalBinding | undefined;
        if (leg === 'primary' && ref !== undefined) {
          const merged: SignalBinding = {
            ...(existing ?? { staleAfterSec: 600, primary: ref }),
            primary: ref,
          };
          (gs as Record<string, unknown>)[k as string] = merged;
        }
        if (leg === 'fallback' && existing !== undefined) {
          const merged: SignalBinding = { ...existing };
          if (ref === undefined) {
            delete merged.fallback;
          } else {
            merged.fallback = ref;
          }
          (gs as Record<string, unknown>)[k as string] = merged;
        }
        next.globalSignals = gs;
      } else {
        // Room-scoped indoorTemp.
        next.rooms = next.rooms.map((r) => {
          if (r.id !== key) {
            return r;
          }
          const existing = r.signals.indoorTemp;
          if (leg === 'primary' && ref !== undefined) {
            const merged: SignalBinding = {
              ...(existing ?? { staleAfterSec: 600, primary: ref }),
              primary: ref,
            };
            return { ...r, signals: { ...r.signals, indoorTemp: merged } };
          }
          if (leg === 'fallback' && existing !== undefined) {
            const merged: SignalBinding = { ...existing };
            if (ref === undefined) {
              delete merged.fallback;
            } else {
              merged.fallback = ref;
            }
            return { ...r, signals: { ...r.signals, indoorTemp: merged } };
          }
          return r;
        });
      }
      return next;
    });
  };

  const runProbe = async (signalKey: string): Promise<void> => {
    if (draftConfig === null) {
      return;
    }
    try {
      const res = await fetch('/api/config/probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draftConfig),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const json = (await res.json()) as {
        mode: string;
        windowDecisions: Array<{ windowId: string; factors: Record<string, number> }>;
      };
      const first = json.windowDecisions[0];
      setProbeByKey((prev) => ({
        ...prev,
        [signalKey]: {
          mode: json.mode,
          factors: first?.factors ?? {},
          windowId: first?.windowId ?? null,
        },
      }));
    } catch {
      setProbeByKey((prev) => ({ ...prev, [signalKey]: null }));
    }
  };

  const stalenessByKey = useMemo<Record<string, 'fresh' | 'soon' | 'stale'>>(() => {
    // The dashboard snapshot reports source-level health for FusionSolar and
    // HCU; per-binding staleness is approximated by mapping HCU disconnected to
    // "stale" for any HCU-bound signal and FusionSolar source failure likewise.
    const out: Record<string, 'fresh' | 'soon' | 'stale'> = {};
    const snap = snapshot.value;
    if (snap === null) {
      return out;
    }
    const hcuFresh = snap.sources.hcu.connected;
    const fusionFresh = snap.sources.fusionSolar.sourceOk;
    if (draftConfig === null) {
      return out;
    }
    for (const sig of GLOBAL_SIGNALS) {
      const binding = draftConfig.globalSignals[sig.key];
      if (binding === undefined) {
        continue;
      }
      const ref = binding.primary;
      if (ref.kind === 'fusion') {
        out[sig.key] = fusionFresh ? 'fresh' : 'stale';
      } else if (ref.kind === 'hmip' || ref.kind === 'openmeteo') {
        out[sig.key] = hcuFresh ? 'fresh' : 'stale';
      } else {
        out[sig.key] = 'fresh';
      }
    }
    return out;
  }, [draftConfig, snapshot.value]);

  if (draftConfig === null) {
    return (
      <main class="lg2-main lg2-sources" data-testid="liquid-glass2-sources">
        <header class="lg2-header">
          <div><h1 class="lg2-header__title">{t('Quellen', 'Sources')}</h1></div>
        </header>
        <div class="lg2-card lg2-sources__empty">{t('Konfiguration wird geladen…', 'Loading configuration…')}</div>
      </main>
    );
  }

  const discoveryView = {
    devices: discovery.devices.value,
    openMeteo: discovery.openMeteo.value,
    temperatureSources: discovery.temperatureSources.value,
  };

  return (
    <main class="lg2-main lg2-sources" data-testid="liquid-glass2-sources">
      <header class="lg2-header">
        <div>
          <h1 class="lg2-header__title">{t('Quellen', 'Sources')}</h1>
          <p class="lg2-header__sub">{t('Signale den Geräten zuordnen, testen und überwachen', 'Map signals to devices, test and monitor them')}</p>
        </div>
        <div class="lg2-sources__actions">
          <button
            type="button"
            class="lg2-btn"
            data-testid="sources-discover"
            onClick={(): void => {
              void runDiscovery();
            }}
            disabled={discovery.discovering.value}
          >
            {discovery.discovering.value ? t('Suche läuft…', 'Searching…') : t('Geräte suchen', 'Discover devices')}
          </button>
          <span class="lg2-sources__autosave" data-testid="sources-autosave">
            {cfg.loading.value ? t('Speichert…', 'Saving…') : t('Automatisch gespeichert', 'Auto-saved')}
          </span>
        </div>
      </header>

      <div class="lg2-settings lg2-sources__body">
        <DiscoveryStatus discovery={discovery} />

        {discovery.error.value !== null && (
          <p class="lg2-sources__error" data-testid="sources-discover-error">
            {discovery.error.value}
          </p>
        )}

        {/* Discovered sources overview. */}
        <section class="lg2-card lg2-sources__card" data-testid="sources-discovered">
          <details open class="lg2-sources__group">
            <summary class="lg2-sources__summary">FusionSolar</summary>
            <p class="lg2-settings__hint">
              {t('Konfigurierte Basis-URL:', 'Configured base URL:')} <code>{draftConfig.fusionSolar.baseUrl}</code>
            </p>
            <label class="lg2-field">
              <span class="lg2-field__label">{t('PV-Spitzenleistung bei voller Sonne (kWp)', 'PV peak power at full sun (kWp)')}</span>
              <input
                type="number"
                class="lg2-field__input"
                min={0.1}
                step={0.1}
                data-testid="sources-pvpeak"
                value={draftConfig.fusionSolar.pvPeakKwp}
                onInput={(e): void => {
                  const v = Number.parseFloat((e.currentTarget as HTMLInputElement).value);
                  if (Number.isFinite(v) && v > 0) {
                    touchedRef.current = true;
                    setDraftConfig((prev) =>
                      prev === null
                        ? prev
                        : { ...prev, fusionSolar: { ...prev.fusionSolar, pvPeakKwp: v } },
                    );
                  }
                }}
              />
            </label>
            <p class="lg2-settings__hint">
              {t(
                'Maximale Erzeugung deiner Anlage = „volle Sonne". Bezugsgröße für die Wärmelast (z. B. 8.8 für 8,8 kWp).',
                'Maximum generation of your system = "full sun". Reference value for the heat load (e.g. 8.8 for 8.8 kWp).',
              )}
            </p>
          </details>

          <details open class="lg2-sources__group">
            <summary class="lg2-sources__summary">
              {t('HCU Temperatur-Sensoren', 'HCU temperature sensors')} ({discovery.temperatureSources.value.length})
            </summary>
            <ul class="lg2-sources__list" data-testid="sources-list-climate">
              {discovery.temperatureSources.value.map((d) => (
                <li key={d.deviceId}><strong>{deviceLabel(d)}</strong></li>
              ))}
            </ul>
          </details>

          <details open class="lg2-sources__group">
            <summary class="lg2-sources__summary">
              {t('OpenMeteo-Kandidaten', 'OpenMeteo candidates')} ({discovery.openMeteo.value.length})
            </summary>
            <ul class="lg2-sources__list" data-testid="sources-list-openmeteo">
              {discovery.openMeteo.value.map((d) => (
                <li key={d.deviceId}><strong>{deviceLabel(d)}</strong></li>
              ))}
            </ul>
          </details>

          <details class="lg2-sources__group">
            <summary class="lg2-sources__summary">
              {t('Open-Meteo (direkt, ohne HCU-Plugin)', 'Open-Meteo (direct, without HCU plugin)')}
            </summary>
            <p class="lg2-settings__hint">
              {t(
                'Holt Wetterdaten (Temperatur, Bewölkung, Globalstrahlung, Wind, Niederschlag, Tageshöchstwert) direkt von open-meteo.com für deinen Standort. Aktivieren und in den Dropdowns unten „Open-Meteo (direkt)" als Quelle wählen.',
                'Fetches weather data (temperature, cloud cover, global radiation, wind, precipitation, daily high) directly from open-meteo.com for your location. Enable it and select "Open-Meteo (direct)" as the source in the dropdowns below.',
              )}
            </p>
            <ToggleRow
              on={draftConfig.openMeteo?.enabled ?? false}
              testId="sources-openmeteo-enabled"
              label={t('Open-Meteo direkt abrufen', 'Fetch Open-Meteo directly')}
              onToggle={(on): void => {
                touchedRef.current = true;
                setDraftConfig((prev) =>
                  prev === null
                    ? prev
                    : { ...prev, openMeteo: { ...prev.openMeteo, enabled: on } },
                );
              }}
            />
            <label class="lg2-field">
              <span class="lg2-field__label">{t('Abruf-Intervall (Minuten)', 'Fetch interval (minutes)')}</span>
              <input
                type="number"
                class="lg2-field__input"
                min={5}
                max={180}
                step={5}
                data-testid="sources-openmeteo-interval"
                value={draftConfig.openMeteo?.pollIntervalMinutes ?? 15}
                onInput={(e): void => {
                  const v = Number.parseInt((e.currentTarget as HTMLInputElement).value, 10);
                  if (Number.isFinite(v)) {
                    const clamped = Math.min(180, Math.max(5, v));
                    touchedRef.current = true;
                    setDraftConfig((prev) =>
                      prev === null
                        ? prev
                        : {
                            ...prev,
                            openMeteo: { ...prev.openMeteo, pollIntervalMinutes: clamped },
                          },
                    );
                  }
                }}
              />
            </label>
          </details>
        </section>

        {/* Global signals. */}
        <section class="lg2-card lg2-sources__card" data-testid="sources-global">
          <h2 class="lg2-card__title">{t('Globale Signale', 'Global signals')}</h2>
          <div class="lg2-sources__tablewrap">
            <table class="lg2-sources__table">
              <thead>
                <tr>
                  <th>{t('Signal', 'Signal')}</th>
                  <th>{t('Primärquelle', 'Primary source')}</th>
                  <th>{t('Ersatzquelle', 'Fallback source')}</th>
                  <th>{t('Status', 'Status')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {GLOBAL_SIGNALS.map((sig) => {
                  const binding = draftConfig.globalSignals[sig.key];
                  const options = buildOptions(sig.group, discoveryView, valueOf);
                  const probe = probeByKey[sig.key];
                  const staleness = stalenessByKey[sig.key];
                  return (
                    <Fragment key={sig.key}>
                      <tr data-testid={`sources-row-${sig.key}`}>
                        <th scope="row">{t(sig.labelDe, sig.labelEn)}</th>
                        <td>
                          <select
                            class="lg2-field__input"
                            data-testid={`sources-${sig.key}-primary`}
                            value={encodeSourceRef(binding?.primary)}
                            onChange={(e): void =>
                              setBinding(
                                'global',
                                sig.key,
                                'primary',
                                decodeSourceRef((e.currentTarget as HTMLSelectElement).value),
                              )
                            }
                          >
                            {options.map((o) => (
                              <option key={o.value} value={o.value}>{o.label}</option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <select
                            class="lg2-field__input"
                            data-testid={`sources-${sig.key}-fallback`}
                            value={encodeSourceRef(binding?.fallback)}
                            disabled={binding === undefined}
                            onChange={(e): void =>
                              setBinding(
                                'global',
                                sig.key,
                                'fallback',
                                decodeSourceRef((e.currentTarget as HTMLSelectElement).value),
                              )
                            }
                          >
                            <option value="__none__">{t('— keine —', '— none —')}</option>
                            {options.map((o) => (
                              <option key={o.value} value={o.value}>{o.label}</option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <span
                            class={`lg2-sources__staleness lg2-sources__staleness--${staleness ?? 'unknown'}`}
                            data-testid={`sources-${sig.key}-staleness`}
                            data-state={staleness ?? 'unknown'}
                          >
                            <span class={`lg2-dot lg2-dot--${staleness === 'stale' ? 'hot' : staleness === 'soon' ? 'mid' : 'ok'}`} />{' '}
                            {stalenessLabel(staleness ?? 'unknown')}
                          </span>
                        </td>
                        <td>
                          <button
                            type="button"
                            class="lg2-btn"
                            data-testid={`sources-${sig.key}-test`}
                            onClick={(): void => {
                              void runProbe(sig.key);
                            }}
                          >
                            {t('Testen', 'Test')}
                          </button>
                        </td>
                      </tr>
                      {probe && (
                        <tr data-testid={`sources-${sig.key}-probe`}>
                          <td colSpan={5}>
                            <small class="lg2-sources__probe">
                              mode={probe.mode}
                              {probe.windowId !== null && (
                                <Fragment>
                                  {' · window '}
                                  {probe.windowId}
                                  {' · factors '}
                                  {Object.entries(probe.factors)
                                    .map(([k, v]) => `${k}=${v.toFixed(2)}`)
                                    .join(', ')}
                                </Fragment>
                              )}
                            </small>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        {/* Rooms · indoor temperature. */}
        <section class="lg2-card lg2-sources__card" data-testid="sources-rooms">
          <h2 class="lg2-card__title">{t('Räume · Innentemperatur', 'Rooms · indoor temperature')}</h2>
          {draftConfig.rooms.length === 0 ? (
            <p class="lg2-settings__hint">{t('Keine Räume konfiguriert. Lege zuerst Räume im Tab „Räume" an.', 'No rooms configured. First add rooms in the "Rooms" tab.')}</p>
          ) : (
            <div class="lg2-sources__tablewrap">
              <table class="lg2-sources__table">
                <thead>
                  <tr>
                    <th>{t('Raum', 'Room')}</th>
                    <th>{t('Primärquelle', 'Primary source')}</th>
                    <th>{t('Ersatzquelle', 'Fallback source')}</th>
                  </tr>
                </thead>
                <tbody>
                  {draftConfig.rooms.map((r) => {
                    const binding = r.signals.indoorTemp;
                    const options = buildOptions('temperature', discoveryView, valueOf);
                    return (
                      <tr key={r.id} data-testid={`sources-room-${r.id}`}>
                        <th scope="row">{r.name}</th>
                        <td>
                          <select
                            class="lg2-field__input"
                            data-testid={`sources-room-${r.id}-primary`}
                            value={encodeSourceRef(binding?.primary)}
                            onChange={(e): void =>
                              setBinding(
                                'room',
                                r.id,
                                'primary',
                                decodeSourceRef((e.currentTarget as HTMLSelectElement).value),
                              )
                            }
                          >
                            {options.map((o) => (
                              <option key={o.value} value={o.value}>{o.label}</option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <select
                            class="lg2-field__input"
                            data-testid={`sources-room-${r.id}-fallback`}
                            value={encodeSourceRef(binding?.fallback)}
                            disabled={binding === undefined}
                            onChange={(e): void =>
                              setBinding(
                                'room',
                                r.id,
                                'fallback',
                                decodeSourceRef((e.currentTarget as HTMLSelectElement).value),
                              )
                            }
                          >
                            <option value="__none__">{t('— keine —', '— none —')}</option>
                            {options.map((o) => (
                              <option key={o.value} value={o.value}>{o.label}</option>
                            ))}
                          </select>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {cfg.saveError.value !== null && (
          <div class="lg2-card lg2-sources__save-error" data-testid="sources-save-error">
            <strong>{cfg.saveError.value.error.message}</strong>
          </div>
        )}
        {cfg.saveOk.value && (
          <p class="lg2-sources__save-ok" data-testid="sources-save-ok">{t('Gespeichert.', 'Saved.')}</p>
        )}
      </div>
    </main>
  );
}

/* -------------------------------------------------------------------------- */
/* Local lg2 primitive — a labelled switch row (matches the notifications      */
/* template's ToggleRow, since `lg2Primitives` exposes only `Seg`).            */
/* -------------------------------------------------------------------------- */

function ToggleRow(props: {
  on: boolean;
  label: string;
  hint?: string;
  testId?: string;
  onToggle: (on: boolean) => void;
}): JSX.Element {
  return (
    <div class="lg2-settings__row">
      <span>
        {props.label}
        {props.hint !== undefined && <small> {props.hint}</small>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={props.on}
        aria-label={props.label}
        class={`lg2-toggle${props.on ? ' lg2-toggle--on' : ''}`}
        {...(props.testId !== undefined ? { 'data-testid': props.testId } : {})}
        onClick={(): void => props.onToggle(!props.on)}
      />
    </div>
  );
}
