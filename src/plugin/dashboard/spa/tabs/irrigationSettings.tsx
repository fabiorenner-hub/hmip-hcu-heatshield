/**
 * Heat Shield — "Bewässerung" settings (Einstellungen tile).
 *
 * Global irrigation settings + per-zone configuration. Each zone maps to a
 * Gardena valve (and optional moisture sensor, picked from the live snapshot)
 * and carries its plant/soil/emitter profile that drives the ET water-balance
 * engine. Auto-saves through `useConfig`.
 */

import { h, type JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import type { Config, IrrigationConfig, IrrigationZone } from '../../../../shared/types.js';
import { useConfig } from '../hooks/useConfig.js';
import { snapshot } from '../store.js';
import { t, lang } from '../i18n.js';

interface RoutableProps {
  path?: string;
}

const PLANTS = ['lawn', 'bed', 'hedge', 'vegetable', 'pot', 'tree'] as const;
const SOILS = ['sand', 'loam', 'silt', 'clay'] as const;
const EXPOSURES = ['full_sun', 'partial', 'shade'] as const;
const EMITTERS = ['drip', 'sprinkler', 'rotor', 'soaker'] as const;
const SLOPES = ['flat', 'moderate', 'steep'] as const;
const PRIORITIES = ['low', 'normal', 'high', 'critical'] as const;
const MODES = ['off', 'eco', 'normal', 'heat', 'vacation', 'establishment'] as const;

const PLANT_LABEL_DE: Record<string, string> = {
  lawn: 'Rasen', bed: 'Beet', hedge: 'Hecke', vegetable: 'Gemüse', pot: 'Topf', tree: 'Baum/Strauch',
};
const PLANT_LABEL_EN: Record<string, string> = {
  lawn: 'Lawn', bed: 'Bed', hedge: 'Hedge', vegetable: 'Vegetables', pot: 'Pot', tree: 'Tree/shrub',
};
const SOIL_LABEL_DE: Record<string, string> = { sand: 'Sand', loam: 'Lehm', silt: 'Schluff', clay: 'Ton' };
const SOIL_LABEL_EN: Record<string, string> = { sand: 'Sand', loam: 'Loam', silt: 'Silt', clay: 'Clay' };
const EXP_LABEL_DE: Record<string, string> = { full_sun: 'Volle Sonne', partial: 'Halbschatten', shade: 'Schatten' };
const EXP_LABEL_EN: Record<string, string> = { full_sun: 'Full sun', partial: 'Partial shade', shade: 'Shade' };
const EMIT_LABEL_DE: Record<string, string> = { drip: 'Tropfer', sprinkler: 'Sprüher', rotor: 'Versenkregner', soaker: 'Perlschlauch' };
const EMIT_LABEL_EN: Record<string, string> = { drip: 'Drip', sprinkler: 'Sprinkler', rotor: 'Rotor', soaker: 'Soaker hose' };
const SLOPE_LABEL_DE: Record<string, string> = { flat: 'Eben', moderate: 'Leicht', steep: 'Steil' };
const SLOPE_LABEL_EN: Record<string, string> = { flat: 'Flat', moderate: 'Moderate', steep: 'Steep' };
const PRIO_LABEL_DE: Record<string, string> = { low: 'Niedrig', normal: 'Normal', high: 'Hoch', critical: 'Kritisch' };
const PRIO_LABEL_EN: Record<string, string> = { low: 'Low', normal: 'Normal', high: 'High', critical: 'Critical' };
const MODE_LABEL_DE: Record<string, string> = {
  off: 'Aus', eco: 'Eco', normal: 'Normal', heat: 'Hitze', vacation: 'Urlaub', establishment: 'Anwuchs',
};
const MODE_LABEL_EN: Record<string, string> = {
  off: 'Off', eco: 'Eco', normal: 'Normal', heat: 'Heat', vacation: 'Vacation', establishment: 'Establishment',
};
const pickLabels = (de: Record<string, string>, en: Record<string, string>): Record<string, string> =>
  lang.value === 'en' ? en : de;

function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `zone-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }
}

export function IrrigationSettingsTab(_props: RoutableProps): JSX.Element {
  const cfg = useConfig();
  const [draft, setDraft] = useState<Config | null>(null);
  const [test, setTest] = useState<string | null>(null);
  const [services, setServices] = useState<Array<{ id: string; type: string; attrs: string[] }> | null>(null);

  useEffect(() => {
    if (cfg.config.value !== null && draft === null) setDraft(cfg.config.value);
  }, [cfg.config.value]);

  useEffect(() => {
    if (draft === null || cfg.config.value === null) return;
    if (JSON.stringify(draft) !== JSON.stringify(cfg.config.value)) cfg.scheduleSave(draft);
  }, [draft]);

  const patchIrr = (mutate: (i: IrrigationConfig) => IrrigationConfig): void => {
    setDraft((p) => (p === null ? p : { ...p, irrigation: mutate(p.irrigation) }));
  };
  const patchZone = (id: string, mutate: (z: IrrigationZone) => IrrigationZone): void => {
    patchIrr((i) => ({ ...i, zones: i.zones.map((z) => (z.id === id ? mutate(z) : z)) }));
  };
  const patchGardena = (mutate: (g: Config['gardena']) => Config['gardena']): void => {
    setDraft((p) => (p === null ? p : { ...p, gardena: mutate(p.gardena) }));
  };

  const handleTest = async (): Promise<void> => {
    setTest(t('Teste…', 'Testing…'));
    setServices(null);
    if (draft !== null) await cfg.save(draft);
    try {
      const res = await fetch('/api/gardena/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      if (res.status === 503) {
        setTest(t('Nicht verfügbar (Plugin-Boot).', 'Unavailable (plugin boot).'));
        return;
      }
      const j = (await res.json()) as {
        ok: boolean;
        locations?: number;
        sensors?: number;
        valves?: number;
        error?: string;
        services?: Array<{ id: string; type: string; attrs: string[] }>;
      };
      setTest(
        j.ok
          ? t(
              `Verbunden ✅ ${j.locations ?? 0} Standort(e), ${j.sensors ?? 0} Sensor(en), ${j.valves ?? 0} Ventil(e)`,
              `Connected ✅ ${j.locations ?? 0} location(s), ${j.sensors ?? 0} sensor(s), ${j.valves ?? 0} valve(s)`,
            )
          : t(`Fehler: ${j.error ?? 'unbekannt'}`, `Error: ${j.error ?? 'unknown'}`),
      );
      setServices(j.services ?? null);
    } catch {
      setTest(t('Netzwerkfehler', 'Network error'));
    }
  };

  if (draft === null) {
    return (
      <section class="module-panel" data-testid="tab-irrigation-settings">
        <header class="module-panel__head"><h1>{t('Bewässerung', 'Irrigation')}</h1></header>
        <p class="module-panel__hint">{t('Lade Konfiguration…', 'Loading configuration…')}</p>
      </section>
    );
  }

  const irr = draft.irrigation;
  const valves = snapshot.value?.gardena?.valves ?? [];
  const sensors = snapshot.value?.gardena?.sensors ?? [];

  const addZone = (): void => {
    const zone: IrrigationZone = {
      id: newId(),
      name: `Zone ${irr.zones.length + 1}`,
      enabled: true,
      valveServiceId: '',
      moistureSensorDeviceId: '',
      plant: 'lawn',
      soil: 'loam',
      exposure: 'full_sun',
      emitter: 'sprinkler',
      slope: 'flat',
      precipRateMmH: 0,
      rootDepthCm: 0,
      kc: 0,
      mad: 0,
      areaM2: 0,
      priority: 'normal',
      allowedStartHour: 4,
      allowedEndHour: 8,
      maxDailySeconds: 0,
      cooldownMinutes: 360,
      moistCeilingPct: 80,
    };
    patchIrr((i) => ({ ...i, zones: [...i.zones, zone] }));
  };
  const removeZone = (id: string): void => {
    patchIrr((i) => ({ ...i, zones: i.zones.filter((z) => z.id !== id) }));
  };

  const numField = (
    label: string,
    value: number,
    onSet: (n: number) => void,
    min: number,
    max: number,
    step = 1,
  ): JSX.Element => (
    <label class="tab-rules__field">
      <span>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onInput={(e): void => {
          const v = Number.parseFloat((e.currentTarget as HTMLInputElement).value);
          if (Number.isFinite(v)) onSet(Math.min(max, Math.max(min, v)));
        }}
      />
    </label>
  );

  const select = <T extends string>(
    label: string,
    value: T,
    options: readonly T[],
    labels: Record<string, string>,
    onSet: (v: T) => void,
  ): JSX.Element => (
    <label class="tab-rules__field">
      <span>{label}</span>
      <select
        value={value}
        onChange={(e): void => onSet((e.currentTarget as HTMLSelectElement).value as T)}
      >
        {options.map((o) => (
          <option key={o} value={o}>{labels[o] ?? o}</option>
        ))}
      </select>
    </label>
  );

  return (
    <section class="module-panel tab-irrigation-settings" data-testid="tab-irrigation-settings">
      <header class="module-panel__head">
        <h1>{t('Bewässerung', 'Irrigation')}</h1>
        <span class="module-panel__badge">{cfg.loading.value ? t('Speichert…', 'Saving…') : t('Automatisch gespeichert', 'Auto-saved')}</span>
      </header>
      <p class="module-panel__intro">
        {t(
          'ET-basierte Wassersteuerung: jede Zone erhält ihr Pflanzen-/Boden-/Emitter-Profil, ein Gardena-Ventil und optional einen Bodenfeuchte-Sensor. Die Engine führt eine Wasserbilanz, lernt das Austrocknen und gießt genau bedarfsgerecht.',
          'ET-based water control: each zone carries its plant/soil/emitter profile, a Gardena valve and an optional soil-moisture sensor. The engine keeps a water balance, learns the dry-down and irrigates exactly on demand.',
        )}
      </p>

      <article class="module-panel__card gardena-config" data-testid="gardena-config">
        <h2>{t('Gardena verbinden', 'Connect Gardena')}</h2>
        <p class="module-panel__hint">
          {t(
            'Direkte Anbindung an das GARDENA smart system über deinen eigenen API-Zugang. Lege auf developer.husqvarnagroup.cloud eine Application an, verbinde dort „Authentication" und „GARDENA smart system" und trage Application Key + Secret hier ein.',
            'Direct connection to the GARDENA smart system via your own API access. Create an application at developer.husqvarnagroup.cloud, connect "Authentication" and "GARDENA smart system" there, and enter the Application Key + Secret here.',
          )}
        </p>
        <label class="tab-rules__check">
          <input type="checkbox" data-testid="gardena-enabled" checked={draft.gardena.enabled}
            onChange={(e): void => patchGardena((g) => ({ ...g, enabled: (e.currentTarget as HTMLInputElement).checked }))} />
          <span>{t('Gardena-Anbindung aktiv', 'Gardena connection active')}</span>
        </label>
        <label class="tab-rules__field">
          <span>{t('Application Key (Client-ID)', 'Application Key (Client ID)')}</span>
          <input type="text" data-testid="gardena-client-id" value={draft.gardena.clientId}
            onInput={(e): void => patchGardena((g) => ({ ...g, clientId: (e.currentTarget as HTMLInputElement).value }))} />
        </label>
        <label class="tab-rules__field">
          <span>{t('Application Secret', 'Application Secret')}</span>
          <input type="password" data-testid="gardena-client-secret" value={draft.gardena.clientSecret}
            placeholder={t('•••• (maskiert gespeichert)', '•••• (stored masked)')}
            onInput={(e): void => patchGardena((g) => ({ ...g, clientSecret: (e.currentTarget as HTMLInputElement).value }))} />
        </label>
        <label class="tab-rules__field">
          <span>{t('Location-ID (optional)', 'Location ID (optional)')}</span>
          <input type="text" data-testid="gardena-location-id" value={draft.gardena.locationId}
            placeholder={t('leer = erste Location automatisch', 'empty = first location automatically')}
            onInput={(e): void => patchGardena((g) => ({ ...g, locationId: (e.currentTarget as HTMLInputElement).value }))} />
        </label>
        <div class="tab-rules__telegram-test">
          <button type="button" data-testid="gardena-test" onClick={(): void => void handleTest()}>
            {t('Verbindung testen', 'Test connection')}
          </button>
          {test !== null && (
            <span class="tab-rules__telegram-test-status" data-testid="gardena-test-status">{test}</span>
          )}
        </div>
        {services !== null && (
          <details class="irr-diag" data-testid="gardena-services">
            <summary>{t('Erkannte Gardena-Dienste', 'Detected Gardena services')} ({services.length})</summary>
            <ul>
              {services.map((s) => (
                <li key={s.id}>
                  <code>{s.type}</code> · {s.id.split(':')[0]} · {s.attrs.join(', ') || '—'}
                </li>
              ))}
            </ul>
          </details>
        )}
      </article>

      <article class="module-panel__card" data-testid="irr-global">
        <h2>{t('Allgemein', 'General')}</h2>
        <label class="tab-rules__check">
          <input type="checkbox" data-testid="irr-enabled" checked={irr.enabled}
            onChange={(e): void => patchIrr((i) => ({ ...i, enabled: (e.currentTarget as HTMLInputElement).checked }))} />
          <span>{t('Automatische Bewässerung aktiv', 'Automatic irrigation active')}</span>
        </label>
        <label class="tab-rules__check">
          <input type="checkbox" checked={irr.autoMode}
            onChange={(e): void => patchIrr((i) => ({ ...i, autoMode: (e.currentTarget as HTMLInputElement).checked }))} />
          <span>{t('Modus automatisch nach Wetter wählen', 'Choose mode automatically by weather')}</span>
        </label>
        {!irr.autoMode && select(t('Modus', 'Mode'), irr.mode, MODES, pickLabels(MODE_LABEL_DE, MODE_LABEL_EN), (v) => patchIrr((i) => ({ ...i, mode: v })))}
        <label class="tab-rules__check">
          <input type="checkbox" checked={irr.etModel}
            onChange={(e): void => patchIrr((i) => ({ ...i, etModel: (e.currentTarget as HTMLInputElement).checked }))} />
          <span>{t('ET-Wasserbilanz-Modell verwenden', 'Use ET water-balance model')}</span>
        </label>
        {numField(t('Regen-Skip ab (mm in Fenster)', 'Rain skip from (mm in window)'), irr.rainSkipMm, (n) => patchIrr((i) => ({ ...i, rainSkipMm: n })), 0, 50, 0.5)}
        {numField(t('Regen-Vorausschau (h)', 'Rain look-ahead (h)'), irr.rainSkipWindowH, (n) => patchIrr((i) => ({ ...i, rainSkipWindowH: n })), 1, 48)}
        {numField(t('Frostsperre ≤ (°C)', 'Frost lockout ≤ (°C)'), irr.frostLockoutC, (n) => patchIrr((i) => ({ ...i, frostLockoutC: n })), -10, 10, 0.5)}
        {numField(t('Wind-Skip ab (m/s, Sprüher)', 'Wind skip from (m/s, sprinkler)'), irr.windSkipMs, (n) => patchIrr((i) => ({ ...i, windSkipMs: n })), 0, 30, 0.5)}
        <label class="tab-rules__check">
          <input type="checkbox" checked={irr.pvPreferred}
            onChange={(e): void => patchIrr((i) => ({ ...i, pvPreferred: (e.currentTarget as HTMLInputElement).checked }))} />
          <span>{t('Bevorzugt bei PV-Überschuss gießen', 'Prefer watering on PV surplus')}</span>
        </label>
        {irr.pvPreferred && numField(t('PV-Überschuss-Schwelle (kW)', 'PV surplus threshold (kW)'), irr.pvSurplusKw, (n) => patchIrr((i) => ({ ...i, pvSurplusKw: n })), 0, 50, 0.1)}
        <label class="tab-rules__check">
          <input type="checkbox" checked={irr.mowerCoordination}
            onChange={(e): void => patchIrr((i) => ({ ...i, mowerCoordination: (e.currentTarget as HTMLInputElement).checked }))} />
          <span>{t('Mit Mähroboter koordinieren (nicht gießen während Mähen)', 'Coordinate with robot mower (do not water while mowing)')}</span>
        </label>
        {numField(t('Max. gleichzeitige Ventile', 'Max. concurrent valves'), irr.maxConcurrentValves, (n) => patchIrr((i) => ({ ...i, maxConcurrentValves: Math.round(n) })), 1, 12)}
        {numField(t('Tagesbudget gesamt (min, 0=aus)', 'Total daily budget (min, 0=off)'), Math.round(irr.maxDailySecondsTotal / 60), (n) => patchIrr((i) => ({ ...i, maxDailySecondsTotal: Math.round(n) * 60 })), 0, 1440)}
        <label class="tab-rules__field">
          <span>{t('Pumpen-Steckdose (Gardena POWER_SOCKET serviceId, optional)', 'Pump socket (Gardena POWER_SOCKET serviceId, optional)')}</span>
          <input type="text" value={irr.pumpSocketId}
            onInput={(e): void => patchIrr((i) => ({ ...i, pumpSocketId: (e.currentTarget as HTMLInputElement).value }))} />
        </label>
        <label class="tab-rules__check">
          <input type="checkbox" data-testid="irr-hide-unused" checked={irr.hideUnusedValves}
            onChange={(e): void => patchIrr((i) => ({ ...i, hideUnusedValves: (e.currentTarget as HTMLInputElement).checked }))} />
          <span>{t('Ungenutzte Ventile (ohne Zone) ausblenden', 'Hide unused valves (without zone)')}</span>
        </label>
        <p class="module-panel__hint">
          {t(
            'Es ist immer nur ein Ventil gleichzeitig geöffnet (gemeinsame Wasserversorgung) – fest erzwungen.',
            'Only one valve is ever open at a time (shared water supply) – hard-enforced.',
          )}
        </p>
      </article>

      {valves.length > 0 && (
        <article class="module-panel__card" data-testid="irr-valve-manager">
          <h2>{t('Ventile', 'Valves')}</h2>
          <p class="module-panel__hint">
            {t(
              'Deaktivierte Ventile verschwinden aus der Bewässern-Ansicht und werden nie automatisch gesteuert.',
              'Disabled valves disappear from the watering view and are never controlled automatically.',
            )}
          </p>
          <ul class="irr-valve-list">
            {valves.map((v) => {
              const off = irr.disabledValveIds.includes(v.deviceId);
              const zone = irr.zones.find((z) => z.valveServiceId === v.deviceId);
              return (
                <li key={v.deviceId} class="irr-valve-list__item">
                  <label class="tab-rules__check">
                    <input
                      type="checkbox"
                      data-testid={`irr-valve-enabled-${v.deviceId}`}
                      checked={!off}
                      onChange={(e): void => {
                        const on = (e.currentTarget as HTMLInputElement).checked;
                        patchIrr((i) => ({
                          ...i,
                          disabledValveIds: on
                            ? i.disabledValveIds.filter((id) => id !== v.deviceId)
                            : Array.from(new Set([...i.disabledValveIds, v.deviceId])),
                        }));
                      }}
                    />
                    <span>{v.name}</span>
                  </label>
                  <span class="irr-valve-list__zone">
                    {zone !== undefined ? `→ ${zone.name}` : t('keiner Zone zugeordnet', 'not assigned to a zone')}
                  </span>
                </li>
              );
            })}
          </ul>
        </article>
      )}

      <div class="irr-settings-zones">
        {irr.zones.map((z) => (
          <article class="module-panel__card irr-zone-edit" key={z.id} data-testid={`irr-zone-edit-${z.id}`}>
            <header class="irr-zone-edit__head">
              <input class="irr-zone-edit__name" type="text" value={z.name}
                onInput={(e): void => patchZone(z.id, (x) => ({ ...x, name: (e.currentTarget as HTMLInputElement).value }))} />
              <button type="button" class="irr-btn irr-btn--ghost" onClick={() => removeZone(z.id)}>{t('Entfernen', 'Remove')}</button>
            </header>
            <label class="tab-rules__check">
              <input type="checkbox" checked={z.enabled}
                onChange={(e): void => patchZone(z.id, (x) => ({ ...x, enabled: (e.currentTarget as HTMLInputElement).checked }))} />
              <span>{t('Zone aktiv', 'Zone active')}</span>
            </label>
            <label class="tab-rules__field">
              <span>{t('Gardena-Ventil', 'Gardena valve')}</span>
              <select value={z.valveServiceId}
                onChange={(e): void => patchZone(z.id, (x) => ({ ...x, valveServiceId: (e.currentTarget as HTMLSelectElement).value }))}>
                <option value="">{t('– wählen –', '– select –')}</option>
                {valves.map((v) => (<option key={v.deviceId} value={v.deviceId}>{v.name}</option>))}
                {z.valveServiceId !== '' && !valves.some((v) => v.deviceId === z.valveServiceId) && (
                  <option value={z.valveServiceId}>{z.valveServiceId} ({t('offline', 'offline')})</option>
                )}
              </select>
            </label>
            <label class="tab-rules__field">
              <span>{t('Bodenfeuchte-Sensor (optional)', 'Soil-moisture sensor (optional)')}</span>
              <select value={z.moistureSensorDeviceId}
                onChange={(e): void => patchZone(z.id, (x) => ({ ...x, moistureSensorDeviceId: (e.currentTarget as HTMLSelectElement).value }))}>
                <option value="">{t('– keiner (nur Modell) –', '– none (model only) –')}</option>
                {sensors.map((s) => (<option key={s.deviceId} value={s.deviceId}>{s.name}</option>))}
              </select>
            </label>
            <div class="irr-zone-edit__grid">
              {select(t('Pflanze', 'Plant'), z.plant, PLANTS, pickLabels(PLANT_LABEL_DE, PLANT_LABEL_EN), (v) => patchZone(z.id, (x) => ({ ...x, plant: v })))}
              {select(t('Boden', 'Soil'), z.soil, SOILS, pickLabels(SOIL_LABEL_DE, SOIL_LABEL_EN), (v) => patchZone(z.id, (x) => ({ ...x, soil: v })))}
              {select(t('Sonne', 'Sun'), z.exposure, EXPOSURES, pickLabels(EXP_LABEL_DE, EXP_LABEL_EN), (v) => patchZone(z.id, (x) => ({ ...x, exposure: v })))}
              {select(t('Emitter', 'Emitter'), z.emitter, EMITTERS, pickLabels(EMIT_LABEL_DE, EMIT_LABEL_EN), (v) => patchZone(z.id, (x) => ({ ...x, emitter: v })))}
              {select(t('Hang', 'Slope'), z.slope, SLOPES, pickLabels(SLOPE_LABEL_DE, SLOPE_LABEL_EN), (v) => patchZone(z.id, (x) => ({ ...x, slope: v })))}
              {select(t('Priorität', 'Priority'), z.priority, PRIORITIES, pickLabels(PRIO_LABEL_DE, PRIO_LABEL_EN), (v) => patchZone(z.id, (x) => ({ ...x, priority: v })))}
              {numField(t('Abgabe (mm/h, 0=auto)', 'Output (mm/h, 0=auto)'), z.precipRateMmH, (n) => patchZone(z.id, (x) => ({ ...x, precipRateMmH: n })), 0, 100, 0.5)}
              {numField(t('Wurzeltiefe (cm, 0=auto)', 'Root depth (cm, 0=auto)'), z.rootDepthCm, (n) => patchZone(z.id, (x) => ({ ...x, rootDepthCm: n })), 0, 200)}
              {numField(t('Start-Stunde', 'Start hour'), z.allowedStartHour, (n) => patchZone(z.id, (x) => ({ ...x, allowedStartHour: Math.round(n) })), 0, 23)}
              {numField(t('End-Stunde', 'End hour'), z.allowedEndHour, (n) => patchZone(z.id, (x) => ({ ...x, allowedEndHour: Math.round(n) })), 0, 23)}
              {numField(t('Mindestpause (min)', 'Cooldown (min)'), z.cooldownMinutes, (n) => patchZone(z.id, (x) => ({ ...x, cooldownMinutes: Math.round(n) })), 0, 1440)}
              {numField(t('Tagesbudget (min, 0=aus)', 'Daily budget (min, 0=off)'), Math.round(z.maxDailySeconds / 60), (n) => patchZone(z.id, (x) => ({ ...x, maxDailySeconds: Math.round(n) * 60 })), 0, 1440)}
              {numField(t('Feuchte-Obergrenze (%)', 'Moisture ceiling (%)'), z.moistCeilingPct, (n) => patchZone(z.id, (x) => ({ ...x, moistCeilingPct: n })), 0, 100)}
            </div>
          </article>
        ))}
      </div>

      <button type="button" class="irr-btn" data-testid="irr-add-zone" onClick={addZone}>{t('+ Zone hinzufügen', '+ Add zone')}</button>
    </section>
  );
}
