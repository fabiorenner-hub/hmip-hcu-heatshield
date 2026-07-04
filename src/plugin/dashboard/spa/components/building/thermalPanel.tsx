/**
 * Thermal Load results panel + setup (thermal-load-engine, Quick Estimate v1).
 *
 * Client-side, LOCAL: imports the pure, zod-free thermal engine and renders a
 * results summary from the already-loaded building model — no server round-trip.
 * A collapsible assumptions editor (design temperatures, airtightness, envelope
 * U-value profile) recomputes live; choices persist per-device in localStorage.
 * Accessible tables; prominent non-normative disclaimer; JSON/CSV export.
 * NON-actuating (display only).
 */

import { h, Fragment, type JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';

import { t } from '../../i18n.js';
import { downloadBlob } from '../../svgExport.js';
import type { BuildingModel } from '../../../../../shared/building-model.js';
import {
  computeThermalEstimate,
  buildRoomThermalInputs,
  totalFloorArea,
  ventilationConcept,
  rcInputsFromRoom,
  buildDesignDay,
  simulateDesignDay,
  buildPdfReport,
  type PdfLine,
  DEFAULT_THERMAL_PROFILE,
  type ThermalParams,
  type ThermalProfileDefaults,
  type ThermalEstimate,
  type WaermeschutzLevel,
  type Occupancy,
} from '../../../../../shared/thermal/index.js';

interface ThermalSettings {
  params: ThermalParams;
  profile: ThermalProfileDefaults;
  n50: number;
  waermeschutz: WaermeschutzLevel;
  occupancy: Occupancy;
}

const LS_KEY = 'hs.thermal.settings.v1';
const LS_SCENARIOS = 'hs.thermal.scenarios.v1';

/** A named, immutable assumptions set (a frozen copy of the settings). */
interface ThermalScenario {
  id: string;
  name: string;
  settings: ThermalSettings;
}

function cloneSettings(s: ThermalSettings): ThermalSettings {
  return {
    params: { ...s.params },
    profile: { ...s.profile },
    n50: s.n50,
    waermeschutz: s.waermeschutz,
    occupancy: s.occupancy,
  };
}

function loadScenarios(): ThermalScenario[] {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(LS_SCENARIOS) : null;
    if (raw === null) return [];
    const parsed = JSON.parse(raw) as ThermalScenario[];
    return Array.isArray(parsed) ? parsed.filter((s) => typeof s?.id === 'string' && typeof s?.name === 'string' && s.settings != null) : [];
  } catch {
    return [];
  }
}

function persistScenarios(list: ThermalScenario[]): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(LS_SCENARIOS, JSON.stringify(list));
  } catch {
    /* best-effort */
  }
}

function newId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return `sc-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function defaultSettings(): ThermalSettings {
  return {
    params: { designOutdoorTempC: -12, defaultIndoorTempC: 20, summerOutdoorTempC: 32 },
    profile: { ...DEFAULT_THERMAL_PROFILE },
    n50: 3,
    waermeschutz: 'high',
    occupancy: 'low',
  };
}

function loadSettings(): ThermalSettings {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(LS_KEY) : null;
    if (raw === null) return defaultSettings();
    const parsed = JSON.parse(raw) as Partial<ThermalSettings>;
    const d = defaultSettings();
    return {
      params: { ...d.params, ...(parsed.params ?? {}) },
      profile: { ...d.profile, ...(parsed.profile ?? {}) },
      n50: typeof parsed.n50 === 'number' ? parsed.n50 : d.n50,
      waermeschutz: parsed.waermeschutz === 'low' ? 'low' : 'high',
      occupancy: parsed.occupancy === 'high' ? 'high' : 'low',
    };
  } catch {
    return defaultSettings();
  }
}

function saveSettings(s: ThermalSettings): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(LS_KEY, JSON.stringify(s));
  } catch {
    /* best-effort */
  }
}

function n(v: number, digits = 0): string {
  return v.toFixed(digits);
}

interface SnapshotSummary {
  id: string;
  savedAt: string;
  modelRevision: number;
  buildingHeatingW: number;
  buildingCoolingW: number;
}

async function loadSnapshots(): Promise<SnapshotSummary[]> {
  try {
    const res = await fetch('/api/building/thermal/snapshots');
    if (!res.ok) return [];
    return ((await res.json()) as { snapshots: SnapshotSummary[] }).snapshots ?? [];
  } catch {
    return [];
  }
}

async function saveSnapshot(estimate: ThermalEstimate): Promise<boolean> {
  try {
    const res = await fetch('/api/building/thermal/snapshots', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(estimate),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function readSnapshot(id: string): Promise<ThermalEstimate | null> {
  try {
    const res = await fetch(`/api/building/thermal/snapshots/${id}`);
    if (!res.ok) return null;
    return ((await res.json()) as { estimate: ThermalEstimate }).estimate ?? null;
  } catch {
    return null;
  }
}

function toCsv(est: ThermalEstimate): string {
  const rows: string[] = ['section,room,metric,value,unit'];
  for (const r of est.heating.rooms) {
    rows.push(`heating,${JSON.stringify(r.name)},transmission,${r.transmissionW.toFixed(1)},W`);
    rows.push(`heating,${JSON.stringify(r.name)},ventilation,${r.ventilationW.toFixed(1)},W`);
    rows.push(`heating,${JSON.stringify(r.name)},total,${r.totalW.toFixed(1)},W`);
    rows.push(`heating,${JSON.stringify(r.name)},specific,${r.specificWm2.toFixed(1)},W/m2`);
  }
  rows.push(`heating,BUILDING,envelopeTotal,${est.heating.buildingTotalW.toFixed(1)},W`);
  rows.push(`heating,BUILDING,sumOfRooms,${est.heating.sumOfRoomsW.toFixed(1)},W`);
  rows.push(`cooling,BUILDING,peak,${est.cooling.buildingPeakW.toFixed(1)},W`);
  return rows.join('\r\n');
}

function NumField(props: { label: string; value: number; step?: number; onChange: (v: number) => void; testId: string }): JSX.Element {
  return (
    <label class="bs-thermal__field">
      <span>{props.label}</span>
      <input
        type="number"
        step={props.step ?? 1}
        value={props.value}
        data-testid={props.testId}
        onInput={(e): void => {
          const v = Number((e.currentTarget as HTMLInputElement).value);
          if (Number.isFinite(v)) props.onChange(v);
        }}
      />
    </label>
  );
}

/** Lightweight 24 h canvas sparkline: cooling load (amber) + operative temp (blue). */
function DynamicDayChart(props: { coolingW: number[]; operativeC: number[]; peakHour: number; label: string }): JSX.Element {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const cv = ref.current;
    if (cv === null) return;
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = cv.getContext('2d');
    } catch {
      ctx = null; // jsdom without the canvas package throws — table alternative covers it
    }
    if (ctx === null) return;
    const W = cv.width;
    const H = cv.height;
    const pad = 22;
    const cool = props.coolingW;
    const op = props.operativeC;
    const maxCool = Math.max(1, ...cool);
    const opMin = Math.min(...op);
    const opMax = Math.max(...op);
    const opRange = Math.max(1, opMax - opMin);
    const x = (h: number): number => pad + (h / 23) * (W - 2 * pad);
    const yCool = (v: number): number => H - pad - (v / maxCool) * (H - 2 * pad);
    const yOp = (v: number): number => H - pad - ((v - opMin) / opRange) * (H - 2 * pad);
    ctx.clearRect(0, 0, W, H);
    // baseline
    ctx.strokeStyle = 'rgba(154,166,184,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad, H - pad);
    ctx.lineTo(W - pad, H - pad);
    ctx.stroke();
    // cooling line (amber)
    ctx.strokeStyle = '#ff9d2e';
    ctx.lineWidth = 2;
    ctx.beginPath();
    cool.forEach((v, h) => { const px = x(h); const py = yCool(v); if (h === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); });
    ctx.stroke();
    // operative temperature line (blue)
    ctx.strokeStyle = '#4a8cff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    op.forEach((v, h) => { const px = x(h); const py = yOp(v); if (h === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); });
    ctx.stroke();
    // peak marker (red)
    ctx.fillStyle = '#ff5d57';
    ctx.beginPath();
    ctx.arc(x(props.peakHour), yCool(cool[props.peakHour] ?? 0), 3.5, 0, 2 * Math.PI);
    ctx.fill();
  }, [props.coolingW, props.operativeC, props.peakHour]);
  return <canvas ref={ref} width={480} height={140} class="bs-thermal__chart" data-testid="thermal-dynamic-chart" role="img" aria-label={props.label} />;
}

export function ThermalPanel(props: { model: BuildingModel }): JSX.Element {
  const { model } = props;
  const [settings, setSettings] = useState<ThermalSettings>(() => loadSettings());
  const [showSetup, setShowSetup] = useState<boolean>(false);
  const [snapshots, setSnapshots] = useState<SnapshotSummary[]>([]);
  const [snapMsg, setSnapMsg] = useState<string | null>(null);
  const [compare, setCompare] = useState<{ id: string; estimate: ThermalEstimate } | null>(null);
  const [scenarios, setScenarios] = useState<ThermalScenario[]>(() => loadScenarios());
  const [scenarioName, setScenarioName] = useState<string>('');

  // Load persisted snapshots for the active project on mount (best-effort).
  useEffect(() => {
    void loadSnapshots().then(setSnapshots);
  }, []);

  const update = (patch: Partial<ThermalSettings>): void => {
    setSettings((s) => {
      const next = { ...s, ...patch };
      saveSettings(next);
      return next;
    });
  };
  const updateParams = (patch: Partial<ThermalParams>): void => update({ params: { ...settings.params, ...patch } });
  const updateProfile = (patch: Partial<ThermalProfileDefaults>): void => update({ profile: { ...settings.profile, ...patch } });

  const saveScenario = (): void => {
    const name = scenarioName.trim() || `${t('Szenario', 'Scenario')} ${scenarios.length + 1}`;
    // Immutable: store a deep copy so later edits never mutate the saved set.
    const next = [...scenarios, { id: newId(), name, settings: cloneSettings(settings) }];
    setScenarios(next);
    persistScenarios(next);
    setScenarioName('');
  };
  const applyScenario = (sc: ThermalScenario): void => {
    const restored = cloneSettings(sc.settings);
    setSettings(restored);
    saveSettings(restored);
  };
  const deleteScenario = (id: string): void => {
    const next = scenarios.filter((s) => s.id !== id);
    setScenarios(next);
    persistScenarios(next);
  };

  const { estimate, vent } = useMemo(() => {
    const profile = { ...settings.profile, indoorTempC: settings.params.defaultIndoorTempC };
    // Assumed clear-sky summer irradiance on the envelope for the static cooling
    // estimate (so shading/orientation assumptions have an effect).
    const rooms = buildRoomThermalInputs(model, profile, 500);
    const est = computeThermalEstimate(rooms, settings.params, { modelRevision: model.revision });
    const area = totalFloorArea(model);
    const volume = rooms.reduce((s, r) => s + r.volumeM3, 0);
    const concept = ventilationConcept({ areaM2: area, volumeM3: volume, n50: settings.n50, waermeschutz: settings.waermeschutz, occupancy: settings.occupancy });
    return { estimate: est, vent: concept };
  }, [model, settings]);

  // Dynamic cooling (RC hourly core): design-day peak per building + peak hour +
  // peak operative temperature. Aggregates the per-room hourly cooling.
  const dynamic = useMemo(() => {
    const profile = { ...settings.profile, indoorTempC: settings.params.defaultIndoorTempC };
    const rooms = buildRoomThermalInputs(model, profile, 0);
    if (rooms.length === 0) return null;
    const peakOut = settings.params.summerOutdoorTempC ?? 32;
    const minOut = peakOut - 10;
    const setpoint = settings.params.defaultIndoorTempC + 6; // cooling setpoint above heating indoor
    const buildingCooling = new Array<number>(24).fill(0);
    const buildingOperative = new Array<number>(24).fill(-Infinity);
    let peakOperativeC = -Infinity;
    for (const r of rooms) {
      const { params, solarApertureM2 } = rcInputsFromRoom(r, { coolingSetpointC: setpoint });
      const series = buildDesignDay({ peakOutdoorC: peakOut, minOutdoorC: minOut, peakSolarW: solarApertureM2 * 700 });
      const res = simulateDesignDay(params, series, { days: 3 });
      res.coolingW.forEach((w, h) => { buildingCooling[h] = (buildingCooling[h] ?? 0) + w; });
      res.operativeC.forEach((c, h) => { buildingOperative[h] = Math.max(buildingOperative[h] ?? -Infinity, c); });
      peakOperativeC = Math.max(peakOperativeC, res.peakOperativeC);
    }
    const hourlyOperativeC = buildingOperative.map((v) => (Number.isFinite(v) ? v : 0));
    let peakW = 0;
    let peakHour = 0;
    buildingCooling.forEach((w, h) => { if (w > peakW) { peakW = w; peakHour = h; } });
    return { peakW, peakHour, peakOperativeC, setpoint, hourlyCoolingW: buildingCooling.slice(), hourlyOperativeC };
  }, [model, settings]);

  const hasRooms = estimate.heating.rooms.length > 0;
  const p = settings.params;
  const pr = settings.profile;

  return (
    <section class="bs-thermal" data-testid="building-thermal">
      <div class="bs-underlays__head">
        <strong>{t('Wärmelast (Schätzung)', 'Thermal load (estimate)')}</strong>
        <div class="bs-thermal__headbtns">
          <span class="module-panel__hint" data-testid="thermal-quality">
            {t(
              `Datenqualität ${Math.round(estimate.dataQuality.score * 100)} % · ±${Math.round(estimate.dataQuality.relativeUncertainty * 100)} %`,
              `Data quality ${Math.round(estimate.dataQuality.score * 100)} % · ±${Math.round(estimate.dataQuality.relativeUncertainty * 100)} %`,
            )}
          </span>
          <button type="button" aria-pressed={showSetup} data-testid="thermal-toggle-setup" onClick={(): void => setShowSetup((v) => !v)}>
            {t('Annahmen', 'Assumptions')}
          </button>
        </div>
      </div>

      <p class="bs-thermal__disclaimer" data-testid="thermal-disclaimer">{estimate.disclaimer}</p>

      <p class="module-panel__hint" data-testid="thermal-conformity">
        {t('Konformität: keine', 'Conformity: none')} · {t('offene Gates', 'open gates')}: {estimate.conformity.openGates.join(', ') || '—'} · {t('Methoden', 'methods')}: {estimate.methodRefs.length}
      </p>

      {showSetup && (
        <div class="bs-thermal__setup" data-testid="thermal-setup">
          <fieldset>
            <legend>{t('Auslegung', 'Design')}</legend>
            <NumField label={t('Norm-Außentemp. (°C)', 'Design outdoor (°C)')} value={p.designOutdoorTempC} onChange={(v): void => updateParams({ designOutdoorTempC: v })} testId="thermal-set-outdoor" />
            <NumField label={t('Innentemp. (°C)', 'Indoor (°C)')} value={p.defaultIndoorTempC} onChange={(v): void => updateParams({ defaultIndoorTempC: v })} testId="thermal-set-indoor" />
            <NumField label={t('Sommer-Außentemp. (°C)', 'Summer outdoor (°C)')} value={p.summerOutdoorTempC ?? 32} onChange={(v): void => updateParams({ summerOutdoorTempC: v })} testId="thermal-set-summer" />
          </fieldset>
          <fieldset>
            <legend>{t('Hülle (U-Werte)', 'Envelope (U-values)')}</legend>
            <NumField label={t('Wand', 'Wall')} value={pr.wallU} step={0.01} onChange={(v): void => updateProfile({ wallU: v })} testId="thermal-set-wallu" />
            <NumField label={t('Dach', 'Roof')} value={pr.roofU} step={0.01} onChange={(v): void => updateProfile({ roofU: v })} testId="thermal-set-roofu" />
            <NumField label={t('Boden', 'Floor')} value={pr.floorU} step={0.01} onChange={(v): void => updateProfile({ floorU: v })} testId="thermal-set-flooru" />
            <NumField label={t('Fenster', 'Window')} value={pr.windowU} step={0.1} onChange={(v): void => updateProfile({ windowU: v })} testId="thermal-set-windowu" />
            <NumField label={t('Fensteranteil', 'Window ratio')} value={pr.windowToWallRatio} step={0.05} onChange={(v): void => updateProfile({ windowToWallRatio: v })} testId="thermal-set-winratio" />
            <NumField label={t('Luftwechsel n', 'Air change n')} value={pr.airChangeRate} step={0.1} onChange={(v): void => updateProfile({ airChangeRate: v })} testId="thermal-set-ach" />
          </fieldset>
          <fieldset>
            <legend>{t('Lüftung', 'Ventilation')}</legend>
            <NumField label="n50" value={settings.n50} step={0.5} onChange={(v): void => update({ n50: v })} testId="thermal-set-n50" />
            <label class="bs-thermal__field">
              <span>{t('Wärmeschutz', 'Insulation')}</span>
              <select value={settings.waermeschutz} data-testid="thermal-set-ws" onChange={(e): void => update({ waermeschutz: (e.currentTarget as HTMLSelectElement).value as WaermeschutzLevel })}>
                <option value="high">{t('hoch', 'high')}</option>
                <option value="low">{t('gering', 'low')}</option>
              </select>
            </label>
            <label class="bs-thermal__field">
              <span>{t('Belegung', 'Occupancy')}</span>
              <select value={settings.occupancy} data-testid="thermal-set-occ" onChange={(e): void => update({ occupancy: (e.currentTarget as HTMLSelectElement).value as Occupancy })}>
                <option value="low">{t('gering', 'low')}</option>
                <option value="high">{t('hoch', 'high')}</option>
              </select>
            </label>
          </fieldset>
          <fieldset class="bs-thermal__presets" data-testid="thermal-presets">
            <legend>{t('Szenarien', 'Scenarios')}</legend>
            <button
              type="button"
              data-testid="thermal-preset-shade-on"
              onClick={(): void => updateProfile({ windowShading: 0.35 })}
            >{t('Verschattung an', 'Shading on')}</button>
            <button
              type="button"
              data-testid="thermal-preset-shade-off"
              onClick={(): void => updateProfile({ windowShading: 1 })}
            >{t('Verschattung aus', 'Shading off')}</button>
            <button
              type="button"
              data-testid="thermal-preset-night-vent"
              onClick={(): void => update({ profile: { ...settings.profile, airChangeRate: 4 }, params: { ...settings.params, summerOutdoorTempC: 16 } })}
            >{t('Nachtlüftung', 'Night ventilation')}</button>
          </fieldset>
          <fieldset class="bs-thermal__scenarios" data-testid="thermal-scenarios">
            <legend>{t('Gespeicherte Szenarien', 'Saved scenarios')}</legend>
            <div class="bs-thermal__scenario-new">
              <input
                type="text"
                data-testid="thermal-scenario-name"
                placeholder={t('Name', 'Name')}
                value={scenarioName}
                onInput={(e): void => setScenarioName((e.currentTarget as HTMLInputElement).value)}
              />
              <button type="button" data-testid="thermal-scenario-save" onClick={saveScenario}>{t('Speichern', 'Save')}</button>
            </div>
            {scenarios.length === 0 ? (
              <span class="module-panel__hint" data-testid="thermal-scenarios-empty">{t('Noch keine Szenarien.', 'No scenarios yet.')}</span>
            ) : (
              <ul class="bs-thermal__scenario-list">
                {scenarios.map((sc) => (
                  <li key={sc.id} data-testid={`thermal-scenario-${sc.id}`}>
                    <span>{sc.name}</span>
                    <button type="button" data-testid={`thermal-scenario-apply-${sc.id}`} onClick={(): void => applyScenario(sc)}>{t('Anwenden', 'Apply')}</button>
                    <button type="button" class="bs-danger" data-testid={`thermal-scenario-delete-${sc.id}`} onClick={(): void => deleteScenario(sc.id)}>{t('Löschen', 'Delete')}</button>
                  </li>
                ))}
              </ul>
            )}
          </fieldset>
          <button type="button" class="bs-thermal__reset" data-testid="thermal-reset" onClick={(): void => update(defaultSettings())}>
            {t('Zurücksetzen', 'Reset')}
          </button>
        </div>
      )}

      {!hasRooms ? (
        <p class="module-panel__hint" data-testid="thermal-empty">
          {t('Noch keine Räume — zeichne Räume, dann erscheint hier die Schätzung.', 'No rooms yet — draw rooms and the estimate appears here.')}
        </p>
      ) : (
        <Fragment>
          <table class="bs-thermal__table" data-testid="thermal-heating-table">
            <caption>{t('Norm-Heizlast (vereinfacht) je Raum', 'Heating load (simplified) per room')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('Raum', 'Room')}</th>
                <th scope="col">{t('Transmission', 'Transmission')}</th>
                <th scope="col">{t('Lüftung', 'Ventilation')}</th>
                <th scope="col">{t('Gesamt', 'Total')}</th>
                <th scope="col">W/m²</th>
              </tr>
            </thead>
            <tbody>
              {estimate.heating.rooms.map((r) => (
                <tr key={r.roomId} data-testid={`thermal-room-${r.roomId}`}>
                  <td>{r.name}</td>
                  <td>{n(r.transmissionW)} W</td>
                  <td>{n(r.ventilationW)} W</td>
                  <td><strong>{n(r.totalW)} W</strong></td>
                  <td>{n(r.specificWm2)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">{t('Gebäude (Hülle)', 'Building (envelope)')}</th>
                <td colspan={2}>{t('Summe Räume', 'Sum of rooms')}: {n(estimate.heating.sumOfRoomsW)} W</td>
                <td colspan={2}><strong>{n(estimate.heating.buildingTotalW)} W</strong></td>
              </tr>
            </tfoot>
          </table>

          <table class="bs-thermal__table" data-testid="thermal-vent-table">
            <caption>{t('Lüftungskonzept (Flächenverfahren)', 'Ventilation concept (area method)')}</caption>
            <tbody>
              <tr><th scope="row">{t('Feuchteschutz', 'Moisture protection')}</th><td>{n(vent.moistureProtectionM3h)} m³/h</td></tr>
              <tr><th scope="row">{t('Reduziert', 'Reduced')}</th><td>{n(vent.reducedM3h)} m³/h</td></tr>
              <tr><th scope="row">{t('Nennlüftung', 'Nominal')}</th><td>{n(vent.nominalM3h)} m³/h</td></tr>
              <tr><th scope="row">{t('Intensiv', 'Intensive')}</th><td>{n(vent.intensiveM3h)} m³/h</td></tr>
              <tr><th scope="row">{t('Infiltration', 'Infiltration')}</th><td>{n(vent.infiltrationM3h)} m³/h</td></tr>
              <tr>
                <th scope="row">{t('Maßnahme nötig?', 'Measure required?')}</th>
                <td data-testid="thermal-vent-measure">{vent.measureRequired ? t('ja', 'yes') : t('nein', 'no')}</td>
              </tr>
            </tbody>
          </table>

          <table class="bs-thermal__table" data-testid="thermal-cooling-table">
            <caption>{t('Kühllast (statische Spitze)', 'Cooling load (static peak)')}</caption>
            <tbody>
              <tr><th scope="row">{t('Gebäude-Spitze', 'Building peak')}</th><td><strong>{n(estimate.cooling.buildingPeakW)} W</strong></td></tr>
            </tbody>
          </table>

          {dynamic !== null && (
            <table class="bs-thermal__table" data-testid="thermal-dynamic-table">
              <caption>{t('Dynamische Kühllast (RC-Tagesgang)', 'Dynamic cooling (RC design day)')}</caption>
              <tbody>
                <tr>
                  <th scope="row">{t('Gebäude-Spitze', 'Building peak')}</th>
                  <td data-testid="thermal-dynamic-peak"><strong>{n(dynamic.peakW)} W</strong> {t('um', 'at')} {String(dynamic.peakHour).padStart(2, '0')}:00</td>
                </tr>
                <tr>
                  <th scope="row">{t('Max. operative Temp.', 'Max operative temp')}</th>
                  <td>{n(dynamic.peakOperativeC, 1)} °C</td>
                </tr>
                <tr>
                  <th scope="row">{t('Kühl-Sollwert', 'Cooling setpoint')}</th>
                  <td>{n(dynamic.setpoint, 0)} °C</td>
                </tr>
              </tbody>
            </table>
          )}

          {dynamic !== null && (
            <div class="bs-thermal__chart-wrap" data-testid="thermal-dynamic-daychart">
              <DynamicDayChart
                coolingW={dynamic.hourlyCoolingW}
                operativeC={dynamic.hourlyOperativeC}
                peakHour={dynamic.peakHour}
                label={t('Tagesgang: Kühllast (Amber) und operative Temperatur (Blau)', 'Design day: cooling load (amber) and operative temperature (blue)')}
              />
              <details class="bs-thermal__hourly">
                <summary>{t('Stundenwerte (barrierefrei)', 'Hourly values (accessible)')}</summary>
                <table class="bs-thermal__table">
                  <thead>
                    <tr><th scope="col">{t('Std', 'Hr')}</th><th scope="col">{t('Kühllast', 'Cooling')}</th><th scope="col">{t('Op. Temp', 'Op. temp')}</th></tr>
                  </thead>
                  <tbody>
                    {dynamic.hourlyCoolingW.map((w, hr) => (
                      <tr key={hr}>
                        <td>{String(hr).padStart(2, '0')}:00</td>
                        <td>{n(w)} W</td>
                        <td>{n(dynamic.hourlyOperativeC[hr] ?? 0, 1)} °C</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            </div>
          )}

          <div class="bs-thermal__actions">
            <button
              type="button"
              data-testid="thermal-export-json"
              onClick={(): void => downloadBlob(new Blob([JSON.stringify(estimate, null, 2)], { type: 'application/json' }), `heatshield-thermal-rev${model.revision}.json`)}
            >JSON</button>
            <button
              type="button"
              data-testid="thermal-export-csv"
              onClick={(): void => downloadBlob(new Blob([toCsv(estimate)], { type: 'text/csv' }), `heatshield-thermal-rev${model.revision}.csv`)}
            >CSV</button>
            <button
              type="button"
              data-testid="thermal-export-pdf"
              onClick={(): void => {
                const lines: PdfLine[] = [];
                lines.push({ text: estimate.disclaimer });
                lines.push({ text: `${t('Konformität', 'Conformity')}: ${estimate.conformity.claim} · ${t('offene Gates', 'open gates')}: ${estimate.conformity.openGates.join(', ') || '-'}` });
                lines.push({ text: `Rev. ${estimate.modelRevision} · ${t('Profil', 'profile')} ${estimate.profileVersion} · Hash ${estimate.inputHash} · ${estimate.computedAt.slice(0, 19).replace('T', ' ')}` });
                lines.push({ text: t('Norm-Heizlast (vereinfacht)', 'Heating load (simplified)'), bold: true, gapBefore: 1 });
                for (const r of estimate.heating.rooms) {
                  lines.push({ text: `${r.name}: ${t('Trans.', 'Trans.')} ${n(r.transmissionW)} W · ${t('Lüftung', 'Vent.')} ${n(r.ventilationW)} W · ${t('Gesamt', 'Total')} ${n(r.totalW)} W (${n(r.specificWm2)} W/m²)` });
                }
                lines.push({ text: `${t('Gebäude (Hülle)', 'Building (envelope)')}: ${n(estimate.heating.buildingTotalW)} W · ${t('Summe Räume', 'Sum of rooms')}: ${n(estimate.heating.sumOfRoomsW)} W` });
                lines.push({ text: t('Lüftungskonzept (Flächenverfahren)', 'Ventilation concept'), bold: true, gapBefore: 1 });
                lines.push({ text: `${t('Feuchteschutz', 'Moisture prot.')} ${n(vent.moistureProtectionM3h)} · ${t('Nenn', 'Nominal')} ${n(vent.nominalM3h)} · ${t('Intensiv', 'Intensive')} ${n(vent.intensiveM3h)} m³/h · ${t('Maßnahme', 'Measure')}: ${vent.measureRequired ? t('ja', 'yes') : t('nein', 'no')}` });
                lines.push({ text: t('Kühllast', 'Cooling load'), bold: true, gapBefore: 1 });
                lines.push({ text: `${t('Statische Spitze', 'Static peak')}: ${n(estimate.cooling.buildingPeakW)} W` });
                if (dynamic !== null) {
                  lines.push({ text: `${t('Dynamisch (RC)', 'Dynamic (RC)')}: ${n(dynamic.peakW)} W ${t('um', 'at')} ${String(dynamic.peakHour).padStart(2, '0')}:00 · ${t('max. op. Temp', 'max op. temp')} ${n(dynamic.peakOperativeC, 1)} °C` });
                }
                lines.push({ text: `${t('Methoden', 'Methods')}: ${estimate.methodRefs.join(', ')}`, gapBefore: 1 });
                const bytes = buildPdfReport(t('HeatShield — Wärmelast (Quick Estimate v1)', 'HeatShield — Thermal load (Quick Estimate v1)'), lines);
                downloadBlob(new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' }), `heatshield-thermal-rev${model.revision}.pdf`);
              }}
            >PDF</button>
            <button
              type="button"
              data-testid="thermal-save-snapshot"
              onClick={(): void => {
                setSnapMsg(null);
                void saveSnapshot(estimate).then((ok) => {
                  if (ok) {
                    void loadSnapshots().then(setSnapshots);
                    setSnapMsg(t('Snapshot gespeichert.', 'Snapshot saved.'));
                  } else {
                    setSnapMsg(t('Speichern fehlgeschlagen.', 'Save failed.'));
                  }
                });
              }}
            >{t('Snapshot speichern', 'Save snapshot')}</button>
          </div>
          {snapMsg !== null && <p class="module-panel__hint" data-testid="thermal-snap-msg">{snapMsg}</p>}

          {snapshots.length > 0 && (
            <table class="bs-thermal__table" data-testid="thermal-snapshots">
              <caption>{t('Gespeicherte Snapshots', 'Saved snapshots')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('Zeit', 'Time')}</th>
                  <th scope="col">Rev.</th>
                  <th scope="col">{t('Heizen', 'Heating')}</th>
                  <th scope="col">{t('Kühlen', 'Cooling')}</th>
                  <th scope="col"></th>
                </tr>
              </thead>
              <tbody>
                {snapshots.map((s) => (
                  <tr key={s.id} data-testid={`thermal-snapshot-${s.id}`}>
                    <td>{s.savedAt.slice(0, 19).replace('T', ' ')}</td>
                    <td>{s.modelRevision}</td>
                    <td>{n(s.buildingHeatingW)} W</td>
                    <td>{n(s.buildingCoolingW)} W</td>
                    <td>
                      <button
                        type="button"
                        data-testid={`thermal-compare-${s.id}`}
                        onClick={(): void => { void readSnapshot(s.id).then((est) => { if (est !== null) setCompare({ id: s.id, estimate: est }); }); }}
                      >{t('Vergleichen', 'Compare')}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {compare !== null && (() => {
            const curH = estimate.heating.buildingTotalW;
            const snapH = compare.estimate.heating?.buildingTotalW ?? 0;
            const curC = estimate.cooling.buildingPeakW;
            const snapC = compare.estimate.cooling?.buildingPeakW ?? 0;
            const pct = (cur: number, snap: number): string => (snap === 0 ? '—' : `${(((cur - snap) / snap) * 100).toFixed(1)} %`);
            return (
              <table class="bs-thermal__table" data-testid="thermal-comparison">
                <caption>{t('Vergleich: aktuell vs. Snapshot', 'Comparison: current vs. snapshot')}</caption>
                <thead>
                  <tr>
                    <th scope="col"></th>
                    <th scope="col">{t('Aktuell', 'Current')}</th>
                    <th scope="col">{t('Snapshot', 'Snapshot')}</th>
                    <th scope="col">Δ</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <th scope="row">{t('Heizlast (Hülle)', 'Heating (envelope)')}</th>
                    <td>{n(curH)} W</td>
                    <td>{n(snapH)} W</td>
                    <td data-testid="thermal-cmp-heating">{n(curH - snapH)} W ({pct(curH, snapH)})</td>
                  </tr>
                  <tr>
                    <th scope="row">{t('Kühllast (Spitze)', 'Cooling (peak)')}</th>
                    <td>{n(curC)} W</td>
                    <td>{n(snapC)} W</td>
                    <td data-testid="thermal-cmp-cooling">{n(curC - snapC)} W ({pct(curC, snapC)})</td>
                  </tr>
                </tbody>
                <tfoot>
                  <tr><td colspan={4}>
                    <button type="button" data-testid="thermal-compare-close" onClick={(): void => setCompare(null)}>{t('Vergleich schließen', 'Close comparison')}</button>
                  </td></tr>
                </tfoot>
              </table>
            );
          })()}
        </Fragment>
      )}
    </section>
  );
}
