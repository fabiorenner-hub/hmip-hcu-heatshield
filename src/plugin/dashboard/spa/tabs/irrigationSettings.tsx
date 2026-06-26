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

const PLANT_LABEL: Record<string, string> = {
  lawn: 'Rasen', bed: 'Beet', hedge: 'Hecke', vegetable: 'Gemüse', pot: 'Topf', tree: 'Baum/Strauch',
};
const SOIL_LABEL: Record<string, string> = { sand: 'Sand', loam: 'Lehm', silt: 'Schluff', clay: 'Ton' };
const EXP_LABEL: Record<string, string> = { full_sun: 'Volle Sonne', partial: 'Halbschatten', shade: 'Schatten' };
const EMIT_LABEL: Record<string, string> = { drip: 'Tropfer', sprinkler: 'Sprüher', rotor: 'Versenkregner', soaker: 'Perlschlauch' };
const SLOPE_LABEL: Record<string, string> = { flat: 'Eben', moderate: 'Leicht', steep: 'Steil' };
const PRIO_LABEL: Record<string, string> = { low: 'Niedrig', normal: 'Normal', high: 'Hoch', critical: 'Kritisch' };
const MODE_LABEL: Record<string, string> = {
  off: 'Aus', eco: 'Eco', normal: 'Normal', heat: 'Hitze', vacation: 'Urlaub', establishment: 'Anwuchs',
};

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
    setTest('Teste…');
    setServices(null);
    if (draft !== null) await cfg.save(draft);
    try {
      const res = await fetch('/api/gardena/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      if (res.status === 503) {
        setTest('Nicht verfügbar (Plugin-Boot).');
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
          ? `Verbunden ✅ ${j.locations ?? 0} Standort(e), ${j.sensors ?? 0} Sensor(en), ${j.valves ?? 0} Ventil(e)`
          : `Fehler: ${j.error ?? 'unbekannt'}`,
      );
      setServices(j.services ?? null);
    } catch {
      setTest('Netzwerkfehler');
    }
  };

  if (draft === null) {
    return (
      <section class="module-panel" data-testid="tab-irrigation-settings">
        <header class="module-panel__head"><h1>Bewässerung</h1></header>
        <p class="module-panel__hint">Lade Konfiguration…</p>
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
        <h1>Bewässerung</h1>
        <span class="module-panel__badge">{cfg.loading.value ? 'Speichert…' : 'Automatisch gespeichert'}</span>
      </header>
      <p class="module-panel__intro">
        ET-basierte Wassersteuerung: jede Zone erhält ihr Pflanzen-/Boden-/Emitter-Profil,
        ein Gardena-Ventil und optional einen Bodenfeuchte-Sensor. Die Engine führt eine
        Wasserbilanz, lernt das Austrocknen und gießt genau bedarfsgerecht.
      </p>

      <article class="module-panel__card gardena-config" data-testid="gardena-config">
        <h2>Gardena verbinden</h2>
        <p class="module-panel__hint">
          Direkte Anbindung an das GARDENA smart system über deinen eigenen
          API-Zugang. Lege auf <strong>developer.husqvarnagroup.cloud</strong> eine
          Application an, verbinde dort „Authentication" und „GARDENA smart system"
          und trage Application Key + Secret hier ein.
        </p>
        <label class="tab-rules__check">
          <input type="checkbox" data-testid="gardena-enabled" checked={draft.gardena.enabled}
            onChange={(e): void => patchGardena((g) => ({ ...g, enabled: (e.currentTarget as HTMLInputElement).checked }))} />
          <span>Gardena-Anbindung aktiv</span>
        </label>
        <label class="tab-rules__field">
          <span>Application Key (Client-ID)</span>
          <input type="text" data-testid="gardena-client-id" value={draft.gardena.clientId}
            onInput={(e): void => patchGardena((g) => ({ ...g, clientId: (e.currentTarget as HTMLInputElement).value }))} />
        </label>
        <label class="tab-rules__field">
          <span>Application Secret</span>
          <input type="password" data-testid="gardena-client-secret" value={draft.gardena.clientSecret}
            placeholder="•••• (maskiert gespeichert)"
            onInput={(e): void => patchGardena((g) => ({ ...g, clientSecret: (e.currentTarget as HTMLInputElement).value }))} />
        </label>
        <label class="tab-rules__field">
          <span>Location-ID (optional)</span>
          <input type="text" data-testid="gardena-location-id" value={draft.gardena.locationId}
            placeholder="leer = erste Location automatisch"
            onInput={(e): void => patchGardena((g) => ({ ...g, locationId: (e.currentTarget as HTMLInputElement).value }))} />
        </label>
        <div class="tab-rules__telegram-test">
          <button type="button" data-testid="gardena-test" onClick={(): void => void handleTest()}>
            Verbindung testen
          </button>
          {test !== null && (
            <span class="tab-rules__telegram-test-status" data-testid="gardena-test-status">{test}</span>
          )}
        </div>
        {services !== null && (
          <details class="irr-diag" data-testid="gardena-services">
            <summary>Erkannte Gardena-Dienste ({services.length})</summary>
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
        <h2>Allgemein</h2>
        <label class="tab-rules__check">
          <input type="checkbox" data-testid="irr-enabled" checked={irr.enabled}
            onChange={(e): void => patchIrr((i) => ({ ...i, enabled: (e.currentTarget as HTMLInputElement).checked }))} />
          <span>Automatische Bewässerung aktiv</span>
        </label>
        <label class="tab-rules__check">
          <input type="checkbox" checked={irr.autoMode}
            onChange={(e): void => patchIrr((i) => ({ ...i, autoMode: (e.currentTarget as HTMLInputElement).checked }))} />
          <span>Modus automatisch nach Wetter wählen</span>
        </label>
        {!irr.autoMode && select('Modus', irr.mode, MODES, MODE_LABEL, (v) => patchIrr((i) => ({ ...i, mode: v })))}
        <label class="tab-rules__check">
          <input type="checkbox" checked={irr.etModel}
            onChange={(e): void => patchIrr((i) => ({ ...i, etModel: (e.currentTarget as HTMLInputElement).checked }))} />
          <span>ET-Wasserbilanz-Modell verwenden</span>
        </label>
        {numField('Regen-Skip ab (mm in Fenster)', irr.rainSkipMm, (n) => patchIrr((i) => ({ ...i, rainSkipMm: n })), 0, 50, 0.5)}
        {numField('Regen-Vorausschau (h)', irr.rainSkipWindowH, (n) => patchIrr((i) => ({ ...i, rainSkipWindowH: n })), 1, 48)}
        {numField('Frostsperre ≤ (°C)', irr.frostLockoutC, (n) => patchIrr((i) => ({ ...i, frostLockoutC: n })), -10, 10, 0.5)}
        {numField('Wind-Skip ab (m/s, Sprüher)', irr.windSkipMs, (n) => patchIrr((i) => ({ ...i, windSkipMs: n })), 0, 30, 0.5)}
        <label class="tab-rules__check">
          <input type="checkbox" checked={irr.pvPreferred}
            onChange={(e): void => patchIrr((i) => ({ ...i, pvPreferred: (e.currentTarget as HTMLInputElement).checked }))} />
          <span>Bevorzugt bei PV-Überschuss gießen</span>
        </label>
        {irr.pvPreferred && numField('PV-Überschuss-Schwelle (kW)', irr.pvSurplusKw, (n) => patchIrr((i) => ({ ...i, pvSurplusKw: n })), 0, 50, 0.1)}
        <label class="tab-rules__check">
          <input type="checkbox" checked={irr.mowerCoordination}
            onChange={(e): void => patchIrr((i) => ({ ...i, mowerCoordination: (e.currentTarget as HTMLInputElement).checked }))} />
          <span>Mit Mähroboter koordinieren (nicht gießen während Mähen)</span>
        </label>
        {numField('Max. gleichzeitige Ventile', irr.maxConcurrentValves, (n) => patchIrr((i) => ({ ...i, maxConcurrentValves: Math.round(n) })), 1, 12)}
        {numField('Tagesbudget gesamt (min, 0=aus)', Math.round(irr.maxDailySecondsTotal / 60), (n) => patchIrr((i) => ({ ...i, maxDailySecondsTotal: Math.round(n) * 60 })), 0, 1440)}
        <label class="tab-rules__field">
          <span>Pumpen-Steckdose (Gardena POWER_SOCKET serviceId, optional)</span>
          <input type="text" value={irr.pumpSocketId}
            onInput={(e): void => patchIrr((i) => ({ ...i, pumpSocketId: (e.currentTarget as HTMLInputElement).value }))} />
        </label>
        <label class="tab-rules__check">
          <input type="checkbox" data-testid="irr-hide-unused" checked={irr.hideUnusedValves}
            onChange={(e): void => patchIrr((i) => ({ ...i, hideUnusedValves: (e.currentTarget as HTMLInputElement).checked }))} />
          <span>Ungenutzte Ventile (ohne Zone) ausblenden</span>
        </label>
        <p class="module-panel__hint">
          Es ist immer nur <strong>ein Ventil gleichzeitig</strong> geöffnet
          (gemeinsame Wasserversorgung) – fest erzwungen.
        </p>
      </article>

      {valves.length > 0 && (
        <article class="module-panel__card" data-testid="irr-valve-manager">
          <h2>Ventile</h2>
          <p class="module-panel__hint">
            Deaktivierte Ventile verschwinden aus der Bewässern-Ansicht und werden
            nie automatisch gesteuert.
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
                    {zone !== undefined ? `→ ${zone.name}` : 'keiner Zone zugeordnet'}
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
              <button type="button" class="irr-btn irr-btn--ghost" onClick={() => removeZone(z.id)}>Entfernen</button>
            </header>
            <label class="tab-rules__check">
              <input type="checkbox" checked={z.enabled}
                onChange={(e): void => patchZone(z.id, (x) => ({ ...x, enabled: (e.currentTarget as HTMLInputElement).checked }))} />
              <span>Zone aktiv</span>
            </label>
            <label class="tab-rules__field">
              <span>Gardena-Ventil</span>
              <select value={z.valveServiceId}
                onChange={(e): void => patchZone(z.id, (x) => ({ ...x, valveServiceId: (e.currentTarget as HTMLSelectElement).value }))}>
                <option value="">– wählen –</option>
                {valves.map((v) => (<option key={v.deviceId} value={v.deviceId}>{v.name}</option>))}
                {z.valveServiceId !== '' && !valves.some((v) => v.deviceId === z.valveServiceId) && (
                  <option value={z.valveServiceId}>{z.valveServiceId} (offline)</option>
                )}
              </select>
            </label>
            <label class="tab-rules__field">
              <span>Bodenfeuchte-Sensor (optional)</span>
              <select value={z.moistureSensorDeviceId}
                onChange={(e): void => patchZone(z.id, (x) => ({ ...x, moistureSensorDeviceId: (e.currentTarget as HTMLSelectElement).value }))}>
                <option value="">– keiner (nur Modell) –</option>
                {sensors.map((s) => (<option key={s.deviceId} value={s.deviceId}>{s.name}</option>))}
              </select>
            </label>
            <div class="irr-zone-edit__grid">
              {select('Pflanze', z.plant, PLANTS, PLANT_LABEL, (v) => patchZone(z.id, (x) => ({ ...x, plant: v })))}
              {select('Boden', z.soil, SOILS, SOIL_LABEL, (v) => patchZone(z.id, (x) => ({ ...x, soil: v })))}
              {select('Sonne', z.exposure, EXPOSURES, EXP_LABEL, (v) => patchZone(z.id, (x) => ({ ...x, exposure: v })))}
              {select('Emitter', z.emitter, EMITTERS, EMIT_LABEL, (v) => patchZone(z.id, (x) => ({ ...x, emitter: v })))}
              {select('Hang', z.slope, SLOPES, SLOPE_LABEL, (v) => patchZone(z.id, (x) => ({ ...x, slope: v })))}
              {select('Priorität', z.priority, PRIORITIES, PRIO_LABEL, (v) => patchZone(z.id, (x) => ({ ...x, priority: v })))}
              {numField('Abgabe (mm/h, 0=auto)', z.precipRateMmH, (n) => patchZone(z.id, (x) => ({ ...x, precipRateMmH: n })), 0, 100, 0.5)}
              {numField('Wurzeltiefe (cm, 0=auto)', z.rootDepthCm, (n) => patchZone(z.id, (x) => ({ ...x, rootDepthCm: n })), 0, 200)}
              {numField('Start-Stunde', z.allowedStartHour, (n) => patchZone(z.id, (x) => ({ ...x, allowedStartHour: Math.round(n) })), 0, 23)}
              {numField('End-Stunde', z.allowedEndHour, (n) => patchZone(z.id, (x) => ({ ...x, allowedEndHour: Math.round(n) })), 0, 23)}
              {numField('Mindestpause (min)', z.cooldownMinutes, (n) => patchZone(z.id, (x) => ({ ...x, cooldownMinutes: Math.round(n) })), 0, 1440)}
              {numField('Tagesbudget (min, 0=aus)', Math.round(z.maxDailySeconds / 60), (n) => patchZone(z.id, (x) => ({ ...x, maxDailySeconds: Math.round(n) * 60 })), 0, 1440)}
              {numField('Feuchte-Obergrenze (%)', z.moistCeilingPct, (n) => patchZone(z.id, (x) => ({ ...x, moistCeilingPct: n })), 0, 100)}
            </div>
          </article>
        ))}
      </div>

      <button type="button" class="irr-btn" data-testid="irr-add-zone" onClick={addZone}>+ Zone hinzufügen</button>
    </section>
  );
}
