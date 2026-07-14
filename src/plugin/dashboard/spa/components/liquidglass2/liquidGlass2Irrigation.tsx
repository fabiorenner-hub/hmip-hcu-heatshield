/**
 * Heat Shield — "Liquid Glass V2" Bewässerung page (route `/bewaesserung`).
 *
 * lg2-native rework of the v1 `IrrigationSettingsTab`. Reuses the v1 DATA layer
 * verbatim (`useConfig` + the debounced auto-save, the live `snapshot` signal
 * for Gardena valves/sensors, and `POST /api/gardena/test`) but is an own lg2
 * component built from `--lg2-*` tokens and own `lg2-*` classes — it does NOT
 * embed the v1 tab and carries no `--hs-*`/`--color-*` or v1 classes.
 *
 * Full v1 functional scope (no feature loss):
 *   - Connect Gardena: enabled toggle, Application Key (client id), Application
 *     Secret (masked), optional Location ID, the "Verbindung testen" button
 *     that flushes the draft first and calls `POST /api/gardena/test`, plus the
 *     detected-services disclosure list.
 *   - General: automatic irrigation on/off, auto-mode-by-weather + manual mode
 *     select, ET water-balance model, sensor blend weight, rain skip (mm +
 *     look-ahead h), frost lockout, wind skip, PV-preferred + surplus kW, mower
 *     coordination, max concurrent valves, total daily budget, pump socket id,
 *     hide-unused-valves.
 *   - Valves: per-valve enable toggle backed by `irrigation.disabledValveIds`
 *     with the assigned-zone hint (from the live snapshot).
 *   - Zones: add/remove, name, enabled, Gardena valve (with offline fallback
 *     option) and optional moisture sensor selects, plant/soil/exposure/emitter/
 *     slope/priority profile, and every per-zone number field (output rate,
 *     root depth, start/end hour, cooldown, daily budget, moisture ceiling).
 *
 * Bilingual throughout; auto-saves through `useConfig.scheduleSave`.
 */

import { h, type JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import type { Config, IrrigationConfig, IrrigationZone } from '../../../../../shared/types.js';
import { useConfig } from '../../hooks/useConfig.js';
import { snapshot } from '../../store.js';
import { t, lang } from '../../i18n.js';
import { Icon } from '../icons.js';
import { Seg } from './shell/lg2Primitives.js';

interface RoutableProps {
  path?: string;
}

/* -------------------------------------------------------------------------- */
/* Enum option lists + bilingual labels (ported verbatim from the v1 tab).    */
/* -------------------------------------------------------------------------- */

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

/** Build the `[value, label]` tuples the Seg control expects. */
function segOptions<T extends string>(options: readonly T[], labels: Record<string, string>): Array<[T, string]> {
  return options.map((o) => [o, labels[o] ?? o]);
}

function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `zone-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }
}

/* -------------------------------------------------------------------------- */
/* Page.                                                                      */
/* -------------------------------------------------------------------------- */

export function LiquidGlass2Irrigation(_props: RoutableProps): JSX.Element {
  const cfg = useConfig();
  const [draft, setDraft] = useState<Config | null>(null);
  const [test, setTest] = useState<string | null>(null);
  const [services, setServices] = useState<Array<{ id: string; type: string; attrs: string[] }> | null>(null);

  useEffect(() => {
    if (cfg.config.value !== null && draft === null) setDraft(cfg.config.value);
  }, [cfg.config.value]);

  // Auto-save after a short idle; the deep-equality guard prevents a save loop
  // once the server echoes the persisted config back.
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
      <main class="lg2-main lg2-irrigation" data-testid="liquid-glass2-irrigation">
        <header class="lg2-header">
          <div><h1 class="lg2-header__title">{t('Bewässerung', 'Irrigation')}</h1></div>
        </header>
        <div class="lg2-card lg2-irrigation__empty">{t('Konfiguration wird geladen…', 'Loading configuration…')}</div>
      </main>
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

  return (
    <main class="lg2-main lg2-irrigation" data-testid="liquid-glass2-irrigation">
      <header class="lg2-header">
        <div>
          <h1 class="lg2-header__title">{t('Bewässerung', 'Irrigation')}</h1>
          <p class="lg2-header__sub">{t('Zonen, Gardena-Ventile und ET-Wassersteuerung', 'Zones, Gardena valves and ET water control')}</p>
        </div>
        <span class="lg2-irrigation__autosave" data-testid="lg2-irrigation-autosave">
          {cfg.loading.value ? t('Speichert…', 'Saving…') : t('Automatisch gespeichert', 'Auto-saved')}
        </span>
      </header>

      <p class="lg2-settings__hint">
        {t(
          'ET-basierte Wassersteuerung: jede Zone erhält ihr Pflanzen-/Boden-/Emitter-Profil, ein Gardena-Ventil und optional einen Bodenfeuchte-Sensor. Die Engine führt eine Wasserbilanz, lernt das Austrocknen und gießt genau bedarfsgerecht.',
          'ET-based water control: each zone carries its plant/soil/emitter profile, a Gardena valve and an optional soil-moisture sensor. The engine keeps a water balance, learns the dry-down and irrigates exactly on demand.',
        )}
      </p>

      {cfg.saveError.value !== null && (
        <div class="lg2-card lg2-irrigation__error" data-testid="lg2-irrigation-save-error">
          {cfg.saveError.value.error.message}
        </div>
      )}

      {/* Connect Gardena */}
      <section class="lg2-card lg2-irrigation__card" data-testid="gardena-config">
        <h2 class="lg2-card__title"><Icon name="tropfen" size={18} /> {t('Gardena verbinden', 'Connect Gardena')}</h2>
        <p class="lg2-settings__hint">
          {t(
            'Direkte Anbindung an das GARDENA smart system über deinen eigenen API-Zugang. Lege auf developer.husqvarnagroup.cloud eine Application an, verbinde dort „Authentication" und „GARDENA smart system" und trage Application Key + Secret hier ein.',
            'Direct connection to the GARDENA smart system via your own API access. Create an application at developer.husqvarnagroup.cloud, connect "Authentication" and "GARDENA smart system" there, and enter the Application Key + Secret here.',
          )}
        </p>

        <ToggleRow on={draft.gardena.enabled} testId="gardena-enabled"
          label={t('Gardena-Anbindung aktiv', 'Gardena connection active')}
          onToggle={(on): void => patchGardena((g) => ({ ...g, enabled: on }))} />

        <TextField label={t('Application Key (Client-ID)', 'Application Key (Client ID)')}
          value={draft.gardena.clientId} testId="gardena-client-id"
          onInput={(v): void => patchGardena((g) => ({ ...g, clientId: v }))} />

        <TextField label={t('Application Secret', 'Application Secret')} type="password"
          value={draft.gardena.clientSecret} testId="gardena-client-secret"
          placeholder={t('•••• (maskiert gespeichert)', '•••• (stored masked)')}
          onInput={(v): void => patchGardena((g) => ({ ...g, clientSecret: v }))} />

        <TextField label={t('Location-ID (optional)', 'Location ID (optional)')}
          value={draft.gardena.locationId} testId="gardena-location-id"
          placeholder={t('leer = erste Location automatisch', 'empty = first location automatically')}
          onInput={(v): void => patchGardena((g) => ({ ...g, locationId: v }))} />

        <div class="lg2-form__test">
          <button type="button" class="lg2-btn" data-testid="gardena-test" onClick={(): void => void handleTest()}>
            {t('Verbindung testen', 'Test connection')}
          </button>
          {test !== null && (
            <span class="lg2-form__status" data-testid="gardena-test-status">{test}</span>
          )}
        </div>

        {services !== null && (
          <details class="lg2-irrigation__services" data-testid="gardena-services">
            <summary>{t('Erkannte Gardena-Dienste', 'Detected Gardena services')} ({services.length})</summary>
            <ul class="lg2-irrigation__services-list">
              {services.map((s) => (
                <li key={s.id}>
                  <code>{s.type}</code> · {s.id.split(':')[0]} · {s.attrs.join(', ') || '—'}
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      {/* General */}
      <section class="lg2-card lg2-irrigation__card" data-testid="irr-global">
        <h2 class="lg2-card__title"><Icon name="einstellungen" size={18} /> {t('Allgemein', 'General')}</h2>

        <ToggleRow on={irr.enabled} testId="irr-enabled"
          label={t('Automatische Bewässerung aktiv', 'Automatic irrigation active')}
          onToggle={(on): void => patchIrr((i) => ({ ...i, enabled: on }))} />

        <ToggleRow on={irr.autoMode}
          label={t('Modus automatisch nach Wetter wählen', 'Choose mode automatically by weather')}
          onToggle={(on): void => patchIrr((i) => ({ ...i, autoMode: on }))} />

        {!irr.autoMode && (
          <SelectField<(typeof MODES)[number]> label={t('Modus', 'Mode')} value={irr.mode}
            options={MODES} labels={pickLabels(MODE_LABEL_DE, MODE_LABEL_EN)}
            onChange={(v): void => patchIrr((i) => ({ ...i, mode: v }))} />
        )}

        <ToggleRow on={irr.etModel}
          label={t('ET-Wasserbilanz-Modell verwenden', 'Use ET water-balance model')}
          onToggle={(on): void => patchIrr((i) => ({ ...i, etModel: on }))} />

        <NumField label={t('Sensor-Gewicht (0..1)', 'Sensor weight (0..1)')} value={irr.sensorWeight}
          min={0} max={1} step={0.05} testId="irr-sensor-weight"
          hint={t('Einfluss des Feuchtesensors auf die modellierte Austrocknung.', 'Weight of the moisture sensor blended into the modeled depletion.')}
          onChange={(n): void => patchIrr((i) => ({ ...i, sensorWeight: n }))} />

        <NumField label={t('Regen-Skip ab (mm in Fenster)', 'Rain skip from (mm in window)')} value={irr.rainSkipMm}
          min={0} max={50} step={0.5}
          onChange={(n): void => patchIrr((i) => ({ ...i, rainSkipMm: n }))} />

        <NumField label={t('Regen-Vorausschau (h)', 'Rain look-ahead (h)')} value={irr.rainSkipWindowH}
          min={1} max={48} step={1}
          onChange={(n): void => patchIrr((i) => ({ ...i, rainSkipWindowH: Math.round(n) }))} />

        <NumField label={t('Frostsperre ≤ (°C)', 'Frost lockout ≤ (°C)')} value={irr.frostLockoutC}
          min={-10} max={10} step={0.5}
          onChange={(n): void => patchIrr((i) => ({ ...i, frostLockoutC: n }))} />

        <NumField label={t('Wind-Skip ab (m/s, Sprüher)', 'Wind skip from (m/s, sprinkler)')} value={irr.windSkipMs}
          min={0} max={30} step={0.5}
          onChange={(n): void => patchIrr((i) => ({ ...i, windSkipMs: n }))} />

        <ToggleRow on={irr.pvPreferred}
          label={t('Bevorzugt bei PV-Überschuss gießen', 'Prefer watering on PV surplus')}
          onToggle={(on): void => patchIrr((i) => ({ ...i, pvPreferred: on }))} />

        {irr.pvPreferred && (
          <NumField label={t('PV-Überschuss-Schwelle (kW)', 'PV surplus threshold (kW)')} value={irr.pvSurplusKw}
            min={0} max={50} step={0.1}
            onChange={(n): void => patchIrr((i) => ({ ...i, pvSurplusKw: n }))} />
        )}

        <ToggleRow on={irr.mowerCoordination}
          label={t('Mit Mähroboter koordinieren (nicht gießen während Mähen)', 'Coordinate with robot mower (do not water while mowing)')}
          onToggle={(on): void => patchIrr((i) => ({ ...i, mowerCoordination: on }))} />

        <NumField label={t('Max. gleichzeitige Ventile', 'Max. concurrent valves')} value={irr.maxConcurrentValves}
          min={1} max={12} step={1}
          onChange={(n): void => patchIrr((i) => ({ ...i, maxConcurrentValves: Math.round(n) }))} />

        <NumField label={t('Tagesbudget gesamt (min, 0=aus)', 'Total daily budget (min, 0=off)')}
          value={Math.round(irr.maxDailySecondsTotal / 60)} min={0} max={1440} step={1}
          onChange={(n): void => patchIrr((i) => ({ ...i, maxDailySecondsTotal: Math.round(n) * 60 }))} />

        <TextField label={t('Pumpen-Steckdose (Gardena POWER_SOCKET serviceId, optional)', 'Pump socket (Gardena POWER_SOCKET serviceId, optional)')}
          value={irr.pumpSocketId}
          onInput={(v): void => patchIrr((i) => ({ ...i, pumpSocketId: v }))} />

        <ToggleRow on={irr.hideUnusedValves} testId="irr-hide-unused"
          label={t('Ungenutzte Ventile (ohne Zone) ausblenden', 'Hide unused valves (without zone)')}
          onToggle={(on): void => patchIrr((i) => ({ ...i, hideUnusedValves: on }))} />

        <p class="lg2-settings__hint">
          {t(
            'Es ist immer nur ein Ventil gleichzeitig geöffnet (gemeinsame Wasserversorgung) – fest erzwungen.',
            'Only one valve is ever open at a time (shared water supply) – hard-enforced.',
          )}
        </p>
      </section>

      {/* Valves */}
      {valves.length > 0 && (
        <section class="lg2-card lg2-irrigation__card" data-testid="irr-valve-manager">
          <h2 class="lg2-card__title"><Icon name="tropfen" size={18} /> {t('Ventile', 'Valves')}</h2>
          <p class="lg2-settings__hint">
            {t(
              'Deaktivierte Ventile verschwinden aus der Bewässern-Ansicht und werden nie automatisch gesteuert.',
              'Disabled valves disappear from the watering view and are never controlled automatically.',
            )}
          </p>
          <ul class="lg2-irrigation__valves">
            {valves.map((v) => {
              const off = irr.disabledValveIds.includes(v.deviceId);
              const zone = irr.zones.find((z) => z.valveServiceId === v.deviceId);
              return (
                <li key={v.deviceId} class="lg2-irrigation__valve">
                  <ToggleRow on={!off} testId={`irr-valve-enabled-${v.deviceId}`}
                    label={v.name}
                    onToggle={(on): void => patchIrr((i) => ({
                      ...i,
                      disabledValveIds: on
                        ? i.disabledValveIds.filter((id) => id !== v.deviceId)
                        : Array.from(new Set([...i.disabledValveIds, v.deviceId])),
                    }))} />
                  <span class="lg2-irrigation__valve-zone">
                    {zone !== undefined ? `→ ${zone.name}` : t('keiner Zone zugeordnet', 'not assigned to a zone')}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* Zones */}
      <div class="lg2-irrigation__zones">
        {irr.zones.map((z) => (
          <section class="lg2-card lg2-irrigation__zone" key={z.id} data-testid={`irr-zone-edit-${z.id}`}>
            <header class="lg2-irrigation__zone-head">
              <input class="lg2-form__control lg2-irrigation__zone-name" type="text" value={z.name}
                onInput={(e): void => patchZone(z.id, (x) => ({ ...x, name: (e.currentTarget as HTMLInputElement).value }))} />
              <button type="button" class="lg2-btn lg2-btn--ghost" onClick={(): void => removeZone(z.id)}>
                {t('Entfernen', 'Remove')}
              </button>
            </header>

            <ToggleRow on={z.enabled}
              label={t('Zone aktiv', 'Zone active')}
              onToggle={(on): void => patchZone(z.id, (x) => ({ ...x, enabled: on }))} />

            <label class="lg2-form__field">
              <span class="lg2-form__label">{t('Gardena-Ventil', 'Gardena valve')}</span>
              <select class="lg2-form__control" value={z.valveServiceId}
                onChange={(e): void => patchZone(z.id, (x) => ({ ...x, valveServiceId: (e.currentTarget as HTMLSelectElement).value }))}>
                <option value="">{t('– wählen –', '– select –')}</option>
                {valves.map((v) => (<option key={v.deviceId} value={v.deviceId}>{v.name}</option>))}
                {z.valveServiceId !== '' && !valves.some((v) => v.deviceId === z.valveServiceId) && (
                  <option value={z.valveServiceId}>{z.valveServiceId} ({t('offline', 'offline')})</option>
                )}
              </select>
            </label>

            <label class="lg2-form__field">
              <span class="lg2-form__label">{t('Bodenfeuchte-Sensor (optional)', 'Soil-moisture sensor (optional)')}</span>
              <select class="lg2-form__control" value={z.moistureSensorDeviceId}
                onChange={(e): void => patchZone(z.id, (x) => ({ ...x, moistureSensorDeviceId: (e.currentTarget as HTMLSelectElement).value }))}>
                <option value="">{t('– keiner (nur Modell) –', '– none (model only) –')}</option>
                {sensors.map((s) => (<option key={s.deviceId} value={s.deviceId}>{s.name}</option>))}
              </select>
            </label>

            <div class="lg2-irrigation__zone-grid">
              <SelectField<(typeof PLANTS)[number]> label={t('Pflanze', 'Plant')} value={z.plant}
                options={PLANTS} labels={pickLabels(PLANT_LABEL_DE, PLANT_LABEL_EN)}
                onChange={(v): void => patchZone(z.id, (x) => ({ ...x, plant: v }))} />
              <SelectField<(typeof SOILS)[number]> label={t('Boden', 'Soil')} value={z.soil}
                options={SOILS} labels={pickLabels(SOIL_LABEL_DE, SOIL_LABEL_EN)}
                onChange={(v): void => patchZone(z.id, (x) => ({ ...x, soil: v }))} />
              <SegField<(typeof EXPOSURES)[number]> label={t('Sonne', 'Sun')} value={z.exposure}
                options={segOptions(EXPOSURES, pickLabels(EXP_LABEL_DE, EXP_LABEL_EN))}
                onChange={(v): void => patchZone(z.id, (x) => ({ ...x, exposure: v }))} />
              <SelectField<(typeof EMITTERS)[number]> label={t('Emitter', 'Emitter')} value={z.emitter}
                options={EMITTERS} labels={pickLabels(EMIT_LABEL_DE, EMIT_LABEL_EN)}
                onChange={(v): void => patchZone(z.id, (x) => ({ ...x, emitter: v }))} />
              <SegField<(typeof SLOPES)[number]> label={t('Hang', 'Slope')} value={z.slope}
                options={segOptions(SLOPES, pickLabels(SLOPE_LABEL_DE, SLOPE_LABEL_EN))}
                onChange={(v): void => patchZone(z.id, (x) => ({ ...x, slope: v }))} />
              <SelectField<(typeof PRIORITIES)[number]> label={t('Priorität', 'Priority')} value={z.priority}
                options={PRIORITIES} labels={pickLabels(PRIO_LABEL_DE, PRIO_LABEL_EN)}
                onChange={(v): void => patchZone(z.id, (x) => ({ ...x, priority: v }))} />
              <NumField label={t('Abgabe (mm/h, 0=auto)', 'Output (mm/h, 0=auto)')} value={z.precipRateMmH}
                min={0} max={100} step={0.5}
                onChange={(n): void => patchZone(z.id, (x) => ({ ...x, precipRateMmH: n }))} />
              <NumField label={t('Wurzeltiefe (cm, 0=auto)', 'Root depth (cm, 0=auto)')} value={z.rootDepthCm}
                min={0} max={200} step={1}
                onChange={(n): void => patchZone(z.id, (x) => ({ ...x, rootDepthCm: n }))} />
              <NumField label={t('Start-Stunde', 'Start hour')} value={z.allowedStartHour}
                min={0} max={23} step={1}
                onChange={(n): void => patchZone(z.id, (x) => ({ ...x, allowedStartHour: Math.round(n) }))} />
              <NumField label={t('End-Stunde', 'End hour')} value={z.allowedEndHour}
                min={0} max={23} step={1}
                onChange={(n): void => patchZone(z.id, (x) => ({ ...x, allowedEndHour: Math.round(n) }))} />
              <NumField label={t('Mindestpause (min)', 'Cooldown (min)')} value={z.cooldownMinutes}
                min={0} max={1440} step={1}
                onChange={(n): void => patchZone(z.id, (x) => ({ ...x, cooldownMinutes: Math.round(n) }))} />
              <NumField label={t('Tagesbudget (min, 0=aus)', 'Daily budget (min, 0=off)')}
                value={Math.round(z.maxDailySeconds / 60)} min={0} max={1440} step={1}
                onChange={(n): void => patchZone(z.id, (x) => ({ ...x, maxDailySeconds: Math.round(n) * 60 }))} />
              <NumField label={t('Feuchte-Obergrenze (%)', 'Moisture ceiling (%)')} value={z.moistCeilingPct}
                min={0} max={100} step={1}
                onChange={(n): void => patchZone(z.id, (x) => ({ ...x, moistCeilingPct: n }))} />
            </div>
          </section>
        ))}
      </div>

      <button type="button" class="lg2-btn lg2-irrigation__add" data-testid="irr-add-zone" onClick={addZone}>
        {t('+ Zone hinzufügen', '+ Add zone')}
      </button>
    </main>
  );
}

/* -------------------------------------------------------------------------- */
/* lg2 form primitives (shared lg2-form__* classes)                           */
/* -------------------------------------------------------------------------- */

function ToggleRow(props: {
  on: boolean;
  label: string;
  hint?: string;
  testId?: string;
  onToggle: (on: boolean) => void;
}): JSX.Element {
  return (
    <div class="lg2-form__row">
      <span class="lg2-form__row-text">
        <span class="lg2-form__row-label">{props.label}</span>
        {props.hint !== undefined && <span class="lg2-form__row-hint">{props.hint}</span>}
      </span>
      <button type="button" role="switch" aria-checked={props.on}
        class={`lg2-toggle${props.on ? ' lg2-toggle--on' : ''}`}
        {...(props.testId !== undefined ? { 'data-testid': props.testId } : {})}
        onClick={(): void => props.onToggle(!props.on)} />
    </div>
  );
}

function TextField(props: {
  label: string;
  value: string;
  type?: string;
  placeholder?: string;
  testId?: string;
  onInput: (v: string) => void;
}): JSX.Element {
  return (
    <label class="lg2-form__field">
      <span class="lg2-form__label">{props.label}</span>
      <input type={props.type ?? 'text'} class="lg2-form__control" value={props.value}
        {...(props.placeholder !== undefined ? { placeholder: props.placeholder } : {})}
        {...(props.testId !== undefined ? { 'data-testid': props.testId } : {})}
        onInput={(e): void => props.onInput((e.currentTarget as HTMLInputElement).value)} />
    </label>
  );
}

function NumField(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  hint?: string;
  testId?: string;
  onChange: (v: number) => void;
}): JSX.Element {
  return (
    <label class="lg2-form__num">
      <span class="lg2-form__label">{props.label}</span>
      <span class="lg2-form__num-box">
        <input type="number" min={props.min} max={props.max} step={props.step} value={props.value}
          {...(props.testId !== undefined ? { 'data-testid': props.testId } : {})}
          onInput={(e): void => {
            const v = Number.parseFloat((e.currentTarget as HTMLInputElement).value);
            if (Number.isFinite(v)) props.onChange(Math.min(props.max, Math.max(props.min, v)));
          }} />
        {props.unit !== undefined && props.unit !== '' && <em>{props.unit}</em>}
      </span>
      {props.hint !== undefined && <span class="lg2-form__row-hint">{props.hint}</span>}
    </label>
  );
}

function SelectField<T extends string>(props: {
  label: string;
  value: T;
  options: readonly T[];
  labels: Record<string, string>;
  testId?: string;
  onChange: (v: T) => void;
}): JSX.Element {
  return (
    <label class="lg2-form__field">
      <span class="lg2-form__label">{props.label}</span>
      <select class="lg2-form__control" value={props.value}
        {...(props.testId !== undefined ? { 'data-testid': props.testId } : {})}
        onChange={(e): void => props.onChange((e.currentTarget as HTMLSelectElement).value as T)}>
        {props.options.map((o) => (
          <option key={o} value={o}>{props.labels[o] ?? o}</option>
        ))}
      </select>
    </label>
  );
}

function SegField<T extends string>(props: {
  label: string;
  value: T;
  options: Array<[T, string]>;
  onChange: (v: T) => void;
}): JSX.Element {
  return (
    <div class="lg2-form__field">
      <span class="lg2-form__label">{props.label}</span>
      <Seg value={props.value} options={props.options} onChange={props.onChange} />
    </div>
  );
}
