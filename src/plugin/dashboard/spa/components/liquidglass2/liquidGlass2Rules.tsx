/**
 * Heat Shield — "Liquid Glass V2" Regeln & Grenzwerte (route `/rules`).
 *
 * lg2-native rework of the v1 `RulesTab` (ui-v2-release Runde 12, Requirement
 * 14). Reuses the v1 DATA layer (`useConfig`, `applyProfile`/`PROFILE_PRESETS`,
 * the `POST /api/config/probe` live preview and `POST /api/probe/run`
 * simulation) but is built as an own lg2 component with `--lg2-*` styling — it
 * does NOT embed the v1 tab.
 *
 * Full v1 functional scope: profile switch, every threshold slider (identical
 * min/max/step to v1), the automation extensions (storm, cooling target,
 * night-inactive, quiet hours, winter insulation, learning auto-apply, hot-day,
 * floor shading), a live preview of the resulting mode + per-window target, and
 * a real synthetic simulation that never moves a shutter.
 */

import { Fragment, h, type JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';

import type { Config, Rules } from '../../../../../shared/types.js';
import { applyProfile, type ProfileName, PROFILE_PRESETS } from '../../profiles.js';
import { useConfig } from '../../hooks/useConfig.js';
import { runDiscovery, useDiscovery } from '../../hooks/useDiscovery.js';
import { deviceLabel } from '../../format.js';
import { expertMode } from '../../expertMode.js';
import { t } from '../../i18n.js';
import { Icon } from '../icons.js';

interface RoutableProps { path?: string }

interface SliderSpec {
  path: string;
  labelDe: string;
  labelEn: string;
  min: number;
  max: number;
  step: number;
  unit: string;
  /** DISPLAY-only multiplier (e.g. m/s → km/h). */
  scale?: number;
  /** Fallback shown when the config value is unset (optional fields). */
  dflt?: number;
  /** Group key for the arranged threshold sections. */
  group: 'comfort' | 'automation' | 'sun' | 'heat';
}

// Ordered threshold groups with bilingual headings (nicer arrangement).
const SLIDER_GROUPS: Array<{ key: SliderSpec['group']; de: string; en: string }> = [
  { key: 'comfort', de: 'Komfort', en: 'Comfort' },
  { key: 'automation', de: 'Automatik & Bewegungen', en: 'Automation & moves' },
  { key: 'sun', de: 'Sonne, Sturm & Nacht', en: 'Sun, storm & night' },
  { key: 'heat', de: 'Wärmelast & Beschattung', en: 'Heat load & shading' },
];

// 1:1 the v1 slider table (tabs/rules.tsx) — identical min/max/step (R14.3).
const SLIDERS: SliderSpec[] = [
  { group: 'comfort', path: 'comfort.maxIndoorTempC', labelDe: 'Max. Innentemperatur (max. tolerierbar)', labelEn: 'Max. indoor temperature (max tolerated)', min: 22, max: 28, step: 0.5, unit: '°C' },
  { group: 'comfort', path: 'comfort.targetIndoorTempC', labelDe: 'Innenraum-Zieltemperatur (Optimum)', labelEn: 'Indoor target temperature (optimum)', min: 18, max: 26, step: 0.5, unit: '°C', dflt: 23 },
  { group: 'comfort', path: 'comfort.preShadeTempC', labelDe: 'Vor-Beschattung ab (Innentemperatur)', labelEn: 'Pre-shading from (indoor temp.)', min: 21, max: 26, step: 0.5, unit: '°C' },
  { group: 'comfort', path: 'comfort.vacationOffsetC', labelDe: 'Urlaubs-Absenkung', labelEn: 'Vacation offset', min: 0, max: 2, step: 0.1, unit: '°C' },
  { group: 'automation', path: 'automation.controlIntervalSeconds', labelDe: 'Zyklusintervall', labelEn: 'Cycle interval', min: 180, max: 3600, step: 60, unit: 's' },
  { group: 'automation', path: 'automation.minSecondsBetweenMoves', labelDe: 'Mindestpause zwischen Fahrten', labelEn: 'Cooldown between moves', min: 300, max: 21600, step: 300, unit: 's' },
  { group: 'automation', path: 'automation.minPositionDeltaPct', labelDe: 'Mindest-Positionsänderung', labelEn: 'Min. position change', min: 5, max: 30, step: 1, unit: '%' },
  { group: 'sun', path: 'sun.minElevationDeg', labelDe: 'Sonne · Mindesthöhe', labelEn: 'Sun · minimum elevation', min: 0, max: 15, step: 1, unit: '°' },
  { group: 'sun', path: 'storm.thresholdMs', labelDe: 'Sturm · Schwelle', labelEn: 'Storm · threshold', min: 10, max: 41.7, step: 0.1, unit: 'km/h', scale: 3.6 },
  { group: 'sun', path: 'nightCooling.deltaC', labelDe: 'Nachtkühlung · Delta', labelEn: 'Night cooling · delta', min: 0.5, max: 3, step: 0.1, unit: '°C' },
  { group: 'heat', path: 'heatLoad.pvWeight', labelDe: 'Wärmelast · PV-Gewicht', labelEn: 'Heat load · PV weight', min: 0, max: 1, step: 0.05, unit: '' },
  { group: 'heat', path: 'heatLoad.tempWeight', labelDe: 'Wärmelast · Temp-Gewicht', labelEn: 'Heat load · temp weight', min: 0, max: 1, step: 0.05, unit: '' },
  { group: 'heat', path: 'heatLoad.trendWeight', labelDe: 'Wärmelast · Trend-Gewicht', labelEn: 'Heat load · trend weight', min: 0, max: 1, step: 0.05, unit: '' },
  { group: 'heat', path: 'heatLoad.activateThreshold', labelDe: 'Beschattung · Aktivierungsschwelle', labelEn: 'Shading · activation threshold', min: 0, max: 1, step: 0.05, unit: '' },
  { group: 'heat', path: 'heatLoad.releaseThreshold', labelDe: 'Beschattung · Deaktivierungsschwelle', labelEn: 'Shading · release threshold', min: 0, max: 1, step: 0.05, unit: '' },
  { group: 'heat', path: 'heatLoad.releaseHoldMinutes', labelDe: 'Beschattung · Mindesthaltezeit', labelEn: 'Shading · minimum hold time', min: 0, max: 180, step: 5, unit: 'min' },
  { group: 'heat', path: 'heatLoad.trendWindowHours', labelDe: 'Trend · Zeitfenster', labelEn: 'Trend · time window', min: 0.5, max: 12, step: 0.5, unit: 'h' },
];

const PROFILES: ProfileName[] = ['conservative', 'standard', 'aggressive', 'custom'];
const DEBOUNCE_MS = 300;

function profileLabel(p: ProfileName): string {
  switch (p) {
    case 'conservative': return t('Konservativ', 'Conservative');
    case 'standard': return t('Standard', 'Standard');
    case 'aggressive': return t('Aggressiv', 'Aggressive');
    case 'custom': return t('Benutzerdefiniert', 'Custom');
    default: return p;
  }
}

function getRulesValue(rules: Rules, path: string, dflt = 0): number {
  const [head, tail] = path.split('.');
  if (head === undefined || tail === undefined) return dflt;
  const block = (rules as unknown as Record<string, Record<string, unknown>>)[head];
  const v = block?.[tail];
  return typeof v === 'number' ? v : dflt;
}

function setRulesValue(rules: Rules, path: string, value: number): Rules {
  const [head, tail] = path.split('.');
  if (head === undefined || tail === undefined) return rules;
  const next = {
    ...rules,
    [head]: { ...((rules as unknown as Record<string, Record<string, unknown>>)[head] ?? {}), [tail]: value },
  } as Rules;
  return { ...next, profile: 'custom' };
}

interface ProbeResult { mode: string; windows: Array<{ windowId: string; finalTarget: number }> }

/** POST helper with a hard timeout so the error paths (R14.8–14.10) are testable. */
async function postJson(url: string, body: unknown | undefined, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: 'POST',
      ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export function LiquidGlass2Rules(_props: RoutableProps): JSX.Element {
  const cfg = useConfig();
  const discovery = useDiscovery();
  const [draft, setDraft] = useState<Config | null>(null);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchedRef = useRef<boolean>(false);

  useEffect(() => {
    if (discovery.inventory.value.length === 0 && !discovery.discovering.value) void runDiscovery();
  }, []);

  // Bind/clear the GLOBAL light sensor (chosen like the PV source). Writes into
  // `globalSignals.illumination` (feature `illumination`, lux). Empty = none.
  const setLightSensor = (deviceId: string): void => {
    touchedRef.current = true;
    setDraft((prev) => {
      if (prev === null) return prev;
      const globalSignals = { ...prev.globalSignals };
      if (deviceId === '') delete globalSignals.illumination;
      else globalSignals.illumination = { primary: { kind: 'hmip', deviceId, feature: 'illumination' }, staleAfterSec: 600 };
      return { ...prev, globalSignals };
    });
  };

  useEffect(() => {
    const c = cfg.config.value;
    if (c === null) return;
    // Hydrate on first load AND re-sync when the config changes EXTERNALLY (e.g.
    // per-room targets edited in the Rooms tab, or another browser) as long as
    // the user hasn't started editing THIS tab. This keeps the two tabs in sync
    // without a reload and stops a stale Rules draft from clobbering edits made
    // elsewhere on the next auto-save (forum: "changed thresholds not applied").
    if (draft !== null && touchedRef.current) return;
    if (draft !== null && JSON.stringify(draft) === JSON.stringify(c)) return;
    setDraft(c);
  }, [cfg.config.value]);

  useEffect(() => {
    if (draft === null || cfg.config.value === null) return;
    if (JSON.stringify(draft) !== JSON.stringify(cfg.config.value)) cfg.scheduleSave(draft);
  }, [draft]);

  useEffect(() => () => { if (debounceRef.current !== null) clearTimeout(debounceRef.current); }, []);

  const triggerProbe = (next: Config): void => {
    if (debounceRef.current !== null) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void (async (): Promise<void> => {
        try {
          const res = await postJson('/api/config/probe', next, 10_000);
          if (!res.ok) { setProbeError(`HTTP ${res.status}`); return; }
          const json = (await res.json()) as { mode: string; windowDecisions: Array<{ windowId: string; finalTarget: number }> };
          setProbe({ mode: json.mode, windows: json.windowDecisions });
          setProbeError(null);
        } catch (err) {
          // Keep the last valid preview (R14.8); only surface the error.
          setProbeError(err instanceof Error && err.name === 'AbortError'
            ? t('Zeitüberschreitung bei der Vorschau', 'Preview timed out')
            : err instanceof Error ? err.message : t('Unbekannter Fehler', 'Unknown error'));
        }
      })();
    }, DEBOUNCE_MS);
  };

  const patchRules = (mut: (r: Rules) => Rules): void => {
    touchedRef.current = true;
    setDraft((prev) => {
      if (prev === null) return prev;
      const next: Config = { ...prev, rules: mut(prev.rules) };
      triggerProbe(next);
      return next;
    });
  };

  const presetReference = useMemo<Record<string, number>>(() => {
    if (draft === null || draft.rules.profile === 'custom') return {};
    const preset = PROFILE_PRESETS[draft.rules.profile];
    const out: Record<string, number> = {};
    for (const s of SLIDERS) {
      const [head, tail] = s.path.split('.');
      if (head === undefined || tail === undefined) continue;
      const v = (preset as unknown as Record<string, Record<string, number>>)[head]?.[tail];
      if (typeof v === 'number') out[s.path] = v;
    }
    return out;
  }, [draft]);

  if (draft === null) {
    return (
      <main class="lg2-main lg2-rules" data-testid="liquid-glass2-rules">
        <header class="lg2-header"><div><h1 class="lg2-header__title">{t('Regeln & Grenzwerte', 'Rules & thresholds')}</h1></div></header>
        <div class="lg2-card lg2-rules__empty">{t('Konfiguration wird geladen…', 'Loading configuration…')}</div>
      </main>
    );
  }

  const activeProfile: ProfileName = draft.rules.profile;
  const comfort = draft.rules.comfort;
  const automation = draft.rules.automation;
  const winName = (id: string): string => {
    const w = draft.windows.find((x) => x.id === id);
    const room = w !== undefined ? draft.rooms.find((r) => r.id === w.roomId) : undefined;
    return room?.name ?? t('Fenster', 'Window');
  };

  const renderSlider = (s: SliderSpec): JSX.Element => {
    const value = getRulesValue(draft.rules, s.path, s.dflt ?? 0);
    const reference = presetReference[s.path];
    return (
      <div class="lg2-rules__slider" key={s.path} data-testid={`lg2-rules-slider-row-${s.path}`}>
        <div class="lg2-rules__slider-head">
          <span class="lg2-rules__slider-label">{t(s.labelDe, s.labelEn)}</span>
          <span class="lg2-rules__slider-val" data-testid={`lg2-rules-output-${s.path}`}>
            {Math.round(value * (s.scale ?? 1) * 10) / 10}{s.unit}
          </span>
        </div>
        <input type="range" class="lg2-rules__range" min={s.min} max={s.max} step={s.step} value={value}
          data-testid={`lg2-rules-slider-${s.path}`}
          onInput={(e): void => {
            const next = Number.parseFloat((e.currentTarget as HTMLInputElement).value);
            if (Number.isFinite(next)) patchRules((r) => setRulesValue(r, s.path, next));
          }} />
        {reference !== undefined && Math.abs(reference - value) > 1e-6 && (
          <small class="lg2-rules__slider-ref">{t('Vorgabe', 'preset')} {Math.round(reference * (s.scale ?? 1) * 10) / 10}{s.unit}</small>
        )}
      </div>
    );
  };

  const shadingProfile = draft.rules.shadingProfile ?? 'balanced';
  const eveningEnabled = draft.rules.eveningOpen?.enabled ?? true;
  const eveningBelow = draft.rules.eveningOpen?.openWhenExposureBelow ?? 0.12;
  const pvOn = draft.rules.pvShading?.enabled ?? false;
  const pvAz = draft.rules.pvShading?.arrayAzimuthDeg ?? 225;
  const pvHighPct = Math.round((draft.rules.pvShading?.highPvFraction ?? 0.6) * 100);
  const PV_DEFAULT = { enabled: true, highPvFraction: 0.6, lobeWidthDeg: 90, maxClose01: 1 } as const;

  return (
    <main class="lg2-main lg2-rules" data-testid="liquid-glass2-rules">
      <header class="lg2-header">
        <div>
          <h1 class="lg2-header__title">{t('Regeln & Grenzwerte', 'Rules & thresholds')}</h1>
          <p class="lg2-header__sub">{t('Strategie, Schwellwerte und Simulation', 'Strategy, thresholds and simulation')}</p>
        </div>
        <span class="lg2-rules__autosave" data-testid="lg2-rules-autosave">
          {cfg.loading.value ? t('Speichert…', 'Saving…') : t('Automatisch gespeichert', 'Auto-saved')}
        </span>
      </header>

      {cfg.saveError.value !== null && (
        <div class="lg2-card lg2-rules__error" data-testid="lg2-rules-save-error">
          {t('Speichern fehlgeschlagen — Werte bleiben erhalten.', 'Saving failed — your values are kept.')}
        </div>
      )}

      {/* Profile */}
      <section class="lg2-card lg2-rules__card">
        <h2 class="lg2-card__title">{t('Strategie-Profil', 'Strategy profile')}</h2>
        <div class="lg2-seg lg2-rules__profiles" role="tablist">
          {PROFILES.map((p) => (
            <button key={p} type="button" role="tab" aria-selected={activeProfile === p}
              class={`lg2-seg__btn${activeProfile === p ? ' lg2-seg__btn--on' : ''}`}
              data-testid={`lg2-rules-profile-${p}`}
              onClick={(): void => patchRules((r) => applyProfile(r, p))}>{profileLabel(p)}</button>
          ))}
        </div>
      </section>

      {/* Shading strategy (Phase 4/3) — the high-level daylight ↔ protection dial. */}
      <section class="lg2-card lg2-rules__card" data-testid="lg2-rules-shading-strategy">
        <h2 class="lg2-card__title">{t('Beschattungs-Strategie', 'Shading strategy')}</h2>
        <p class="lg2-rules__hint">{t('Balance zwischen Tageslicht und Wärmeschutz. „Ausgewogen" ist die empfohlene Voreinstellung.', 'Balance between daylight and heat protection. "Balanced" is the recommended default.')}</p>
        <div class="lg2-seg lg2-rules__profiles" role="tablist">
          {([['daylight', 'Tageslicht', 'Daylight'], ['balanced', 'Ausgewogen', 'Balanced'], ['protection', 'Wärmeschutz', 'Heat protection']] as const).map(([key, de, en]) => (
            <button key={key} type="button" role="tab" aria-selected={shadingProfile === key}
              class={`lg2-seg__btn${shadingProfile === key ? ' lg2-seg__btn--on' : ''}`}
              data-testid={`lg2-rules-shadingprofile-${key}`}
              onClick={(): void => patchRules((r) => ({ ...r, shadingProfile: key }))}>{t(de, en)}</button>
          ))}
        </div>
        <RuleToggle testId="lg2-rules-eveningopen" on={eveningEnabled}
          label={t('Abends erst öffnen, wenn keine Sonne mehr am Fenster ist (spätes Öffnen)', 'Only open in the evening once no sun is left on the window (late opening)')}
          onToggle={(on): void => patchRules((r) => ({ ...r, eveningOpen: { ...(r.eveningOpen ?? { openWhenExposureBelow: 0.12 }), enabled: on } }))} />
        {eveningEnabled && (
          <div class="lg2-rules__slider" data-testid="lg2-rules-eveningopen-row">
            <div class="lg2-rules__slider-head">
              <span class="lg2-rules__slider-label">{t('Fenster abends noch beschatten bis Sonnenanteil', 'Keep evening shade until sun share')}</span>
              <span class="lg2-rules__slider-val">{Math.round(eveningBelow * 100)}%</span>
            </div>
            <input type="range" class="lg2-rules__range" min={0} max={0.4} step={0.02} value={eveningBelow}
              data-testid="lg2-rules-eveningopen-slider"
              onInput={(e): void => {
                const v = Number.parseFloat((e.currentTarget as HTMLInputElement).value);
                if (Number.isFinite(v)) patchRules((r) => ({ ...r, eveningOpen: { ...(r.eveningOpen ?? { enabled: true }), enabled: true, openWhenExposureBelow: v } }));
              }} />
            <small class="lg2-rules__slider-ref">{t('höher = früher öffnen · niedriger = länger beschatten', 'higher = open sooner · lower = keep shaded longer')}</small>
          </div>
        )}

        <RuleToggle testId="lg2-rules-pvshading" on={pvOn}
          label={t('PV-Boost: Fenster in Anlagen-Richtung bei hoher PV-Leistung stärker schließen (und geschlossen halten)', 'PV boost: close windows facing the array harder at high PV output (and keep them closed)')}
          onToggle={(on): void => patchRules((r) => ({ ...r, pvShading: { ...(r.pvShading ?? PV_DEFAULT), enabled: on } }))} />
        {pvOn && (
          <div class="lg2-rules__row2">
            <RuleNumber testId="lg2-rules-pv-azimuth" label={t('Anlagen-Ausrichtung (°, 225 = SW)', 'Array azimuth (°, 225 = SW)')} unit="°" min={0} max={359} step={5}
              value={pvAz}
              onChange={(v): void => patchRules((r) => ({ ...r, pvShading: { ...(r.pvShading ?? PV_DEFAULT), enabled: true, arrayAzimuthDeg: Math.round(Math.max(0, Math.min(359, v))) } }))} />
            <RuleNumber testId="lg2-rules-pv-highpct" label={t('PV „sehr hoch" ab %', 'PV "very high" from %')} unit="%" min={30} max={95} step={5}
              value={pvHighPct}
              onChange={(v): void => patchRules((r) => ({ ...r, pvShading: { ...(r.pvShading ?? PV_DEFAULT), enabled: true, highPvFraction: Math.max(0.3, Math.min(0.95, v / 100)) } }))} />
          </div>
        )}
      </section>

      {/* Live preview — expert only (hidden in Basis). */}
      {expertMode.value && (
        <section class="lg2-card lg2-rules__card" data-testid="lg2-rules-preview">
          <h2 class="lg2-card__title">{t('Live-Vorschau', 'Live preview')}</h2>
          {probeError !== null && (
            <p class="lg2-rules__preview-err" data-testid="lg2-rules-probe-error">{t('Vorschau:', 'Preview:')} {probeError}</p>
          )}
          {probe === null ? (
            <p class="lg2-rules__hint">{t('Ändere einen Wert, um die Auswirkung zu sehen.', 'Change a value to see the impact.')}</p>
          ) : (
            <Fragment>
              <p class="lg2-rules__preview-mode">{t('Modus', 'Mode')}: <b>{probe.mode}</b></p>
              <div class="lg2-rules__preview-grid">
                {probe.windows.map((w) => (
                  <span key={w.windowId} class="lg2-rules__preview-cell">
                    <em>{winName(w.windowId)}</em><b>{Math.round(w.finalTarget * 100)} %</b>
                  </span>
                ))}
              </div>
            </Fragment>
          )}
        </section>
      )}

      {/* Thresholds — arranged into labelled groups. */}
      <section class="lg2-card lg2-rules__card">
        <h2 class="lg2-card__title">{t('Schwellwerte', 'Thresholds')}</h2>
        {SLIDER_GROUPS.map((g) => (
          <div class="lg2-rules__group" key={g.key}>
            <h3 class="lg2-rules__group-head">{t(g.de, g.en)}</h3>
            {g.key === 'comfort' && (
              <p class="lg2-rules__hint" data-testid="lg2-rules-comfort-scope">
                {t(
                  'Diese Werte gelten global. Die eigentlichen Beschattungs-Schwellen (Ziel- und Warntemperatur) legst du PRO RAUM im Tab „Räume" fest — die Automatik nutzt immer die Raum-Werte, nicht diese globalen. Die globale Max.-Innentemperatur dient als übergeordnete Obergrenze (z. B. für die Kühl-Tag-Logik).',
                  'These values are global. The actual shading thresholds (target and warning temperature) are set PER ROOM in the "Rooms" tab — the automation always uses the room values, not these global ones. The global max indoor temperature acts as an overall ceiling (e.g. for the cool-day logic).',
                )}
              </p>
            )}
            <div class="lg2-rules__sliders">
              {SLIDERS.filter((s) => s.group === g.key).map((s) => renderSlider(s))}
            </div>
          </div>
        ))}
      </section>

      {/* Automation extensions */}
      <section class="lg2-card lg2-rules__card" data-testid="lg2-rules-extensions">
        <h2 class="lg2-card__title">{t('Automatik-Erweiterungen', 'Automation extensions')}</h2>

        <RuleToggle testId="lg2-rules-storm" on={draft.rules.storm.enabled ?? true}
          label={t('Sturmschutz aktiv (öffnet bei hohem Wind — Sicherheit)', 'Storm protection active (opens on high wind — safety)')}
          onToggle={(on): void => patchRules((r) => ({ ...r, storm: { ...r.storm, enabled: on } }))} />

        <RuleToggle testId="lg2-rules-cooltarget" on={comfort.coolTargetC !== undefined}
          label={t('Kühl-Soll aktiv (Ziel-Innentemperatur für alle Räume)', 'Cooling target active (target indoor temp for all rooms)')}
          onToggle={(on): void => patchRules((r) => {
            const c = { ...r.comfort };
            if (on) c.coolTargetC = c.coolTargetC ?? 24; else delete c.coolTargetC;
            return { ...r, comfort: c };
          })} />
        {comfort.coolTargetC !== undefined && (
          <RuleNumber testId="lg2-rules-cooltarget-value" label={t('Kühl-Soll-Temperatur', 'Cooling target temperature')} unit="°C"
            min={16} max={30} step={0.5} value={comfort.coolTargetC}
            onChange={(v): void => patchRules((r) => ({ ...r, comfort: { ...r.comfort, coolTargetC: Math.max(16, Math.min(30, v)) } }))} />
        )}

        <RuleToggle testId="lg2-rules-proactive-shade" on={comfort.proactiveShadeFromTarget === true}
          label={t('Vorausschauend ab Zieltemperatur beschatten (statt erst ab der Warnschwelle)', 'Shade proactively from the target temperature (instead of only from the warning threshold)')}
          onToggle={(on): void => patchRules((r) => {
            const c = { ...r.comfort };
            if (on) c.proactiveShadeFromTarget = true; else delete c.proactiveShadeFromTarget;
            return { ...r, comfort: c };
          })} />
        <p class="lg2-rules__hint">
          {t(
            'Standard aus. Normalerweise beginnt die Beschattung eines Fensters erst, wenn die Vorhersage die Warnschwelle (warning_c) des Raums erreicht. Ist diese Option an, startet eine sanfte, stufenweise Beschattung schon, sobald die vorhergesagte Temperatur über die Zieltemperatur (target_c) steigt — aber nur an Fenstern, auf die die Sonne wirklich direkt scheint. Wie weit geschlossen wird, richtet sich weiter nach der Warnschwelle; diese Option verschiebt nur den Zeitpunkt, ab dem der Schutz einsetzt, nach vorne. Das hält Räume näher am Optimum, kostet aber etwas Tageslicht.',
            'Off by default. Normally a window only starts shading once the forecast reaches the room\'s warning threshold (warning_c). With this on, gentle graduated shading begins as soon as the forecast rises above the target temperature (target_c) — but only on windows the sun is actually shining on directly. How far the shutter closes is still governed by the warning threshold; this option only moves the moment protection begins earlier. It keeps rooms closer to the optimum at the cost of a little daylight.',
          )}
        </p>

        <RuleToggle testId="lg2-rules-night-inactive" on={automation.pauseBetweenSunsetAndSunrise ?? false}
          label={t('Nachts inaktiv (keine Fahrten zwischen Sonnenunter- und -aufgang; Sturm bleibt aktiv)', 'Inactive at night (no moves between sunset and sunrise; storm stays active)')}
          onToggle={(on): void => patchRules((r) => ({ ...r, automation: { ...r.automation, pauseBetweenSunsetAndSunrise: on } }))} />

        <RuleToggle testId="lg2-rules-quiet" on={automation.quietHours?.enabled ?? false}
          label={t('Ruhezeit (festes Zeitfenster ohne Fahrten; Sturm bleibt aktiv)', 'Quiet hours (fixed window without moves; storm stays active)')}
          onToggle={(on): void => patchRules((r) => ({ ...r, automation: { ...r.automation, quietHours: { ...r.automation.quietHours, enabled: on } } }))} />
        {(automation.quietHours?.enabled ?? false) && (
          <div class="lg2-rules__row2">
            <RuleNumber testId="lg2-rules-quiet-start" label={t('von … Uhr', 'from … h')} min={0} max={23} step={1}
              value={automation.quietHours?.startHour ?? 22}
              onChange={(v): void => patchRules((r) => ({ ...r, automation: { ...r.automation, quietHours: { ...r.automation.quietHours, startHour: Math.min(23, Math.max(0, Math.round(v))) } } }))} />
            <RuleNumber testId="lg2-rules-quiet-end" label={t('bis … Uhr', 'to … h')} min={0} max={23} step={1}
              value={automation.quietHours?.endHour ?? 6}
              onChange={(v): void => patchRules((r) => ({ ...r, automation: { ...r.automation, quietHours: { ...r.automation.quietHours, endHour: Math.min(23, Math.max(0, Math.round(v))) } } }))} />
          </div>
        )}

        <RuleToggle testId="lg2-rules-insulation" on={draft.rules.insulation?.enabled ?? false}
          label={t('Winter-Isolierung (Rollläden schließen in kalten Nächten)', 'Winter insulation (shutters close on cold nights)')}
          onToggle={(on): void => patchRules((r) => ({ ...r, insulation: { ...r.insulation, enabled: on } }))} />
        {(draft.rules.insulation?.enabled ?? false) && (
          <div class="lg2-rules__row2">
            <RuleNumber testId="lg2-rules-insulation-maxtemp" label={t('nur bei ≤ … °C außen', 'only when ≤ … °C outdoor')} unit="°C" min={-20} max={20} step={1}
              value={draft.rules.insulation?.maxOutdoorTempC ?? 5}
              onChange={(v): void => patchRules((r) => ({ ...r, insulation: { ...r.insulation, maxOutdoorTempC: v } }))} />
            <RuleNumber testId="lg2-rules-insulation-level" label={t('Schließgrad %', 'Closing level %')} unit="%" min={0} max={100} step={5}
              value={Math.round((draft.rules.insulation?.level01 ?? 1) * 100)}
              onChange={(v): void => patchRules((r) => ({ ...r, insulation: { ...r.insulation, level01: Math.min(1, Math.max(0, v / 100)) } }))} />
          </div>
        )}

        <RuleToggle testId="lg2-rules-learning-autoapply" on={draft.learning?.autoApply ?? false}
          label={t('Lern-Empfehlungen automatisch übernehmen', 'Apply learning recommendations automatically')}
          onToggle={(on): void => { touchedRef.current = true; setDraft((prev) => prev === null ? prev : { ...prev, learning: { ...prev.learning, autoApply: on } }); }} />

        <h3 class="lg2-rules__subhead">{t('Hitzetag-Schutz', 'Hot-day protection')}</h3>
        <RuleToggle testId="lg2-rules-hotday" on={draft.rules.hotDay?.enabled ?? true}
          label={t('Mindest-Beschattung an heißen, sonnigen Tagen', 'Minimum shading on hot, sunny days')}
          onToggle={(on): void => patchRules((r) => ({ ...r, hotDay: { ...r.hotDay, enabled: on } }))} />
        {(draft.rules.hotDay?.enabled ?? true) && (
          <HotDayStagesEditor
            stages={hotDayStagesOf(draft.rules.hotDay)}
            onChange={(stages): void => patchRules((r) => ({ ...r, hotDay: { ...r.hotDay, stages } }))}
          />
        )}

        <h3 class="lg2-rules__subhead">{t('Stockwerk-Beschattung', 'Floor-based shading')}</h3>
        <RuleToggle testId="lg2-rules-floorshading" on={draft.rules.floorShading?.enabled ?? true}
          label={t('Obergeschosse früher beschatten als das Erdgeschoss', 'Shade upper floors earlier than the ground floor')}
          onToggle={(on): void => patchRules((r) => ({ ...r, floorShading: { ...r.floorShading, enabled: on } }))} />
        {[...new Set(draft.rooms.map((r) => r.floor).filter((f): f is string => !!f))].map((floor) => (
          <RuleNumber key={floor} testId={`lg2-rules-floor-lead-${floor}`} label={t(`Vorlauf „${floor}" (°C früher)`, `Lead "${floor}" (°C earlier)`)} unit="°C"
            min={0} max={4} step={0.1} value={draft.rules.floorShading?.leadByFloor?.[floor] ?? 0}
            onChange={(v): void => patchRules((r) => {
              const lead = { ...(r.floorShading?.leadByFloor ?? {}) };
              lead[floor] = Math.min(4, Math.max(0, v));
              return { ...r, floorShading: { ...r.floorShading, leadByFloor: lead } };
            })} />
        ))}
      </section>

      {/* Global light sensor + live-sky (cloud nowcast) source */}
      {(() => {
        const lightBinding = draft.globalSignals?.illumination?.primary;
        const lightDeviceId =
          lightBinding !== undefined && lightBinding.kind === 'hmip' ? lightBinding.deviceId : undefined;
        const lights = discovery.illuminationSources.value;
        const nowcastSrc = draft.rules.cloudNowcastSource ?? 'auto';
        const NOWCAST_OPTS: ReadonlyArray<{ key: 'auto' | 'light' | 'pv' | 'off'; de: string; en: string }> = [
          { key: 'auto', de: 'Automatisch', en: 'Automatic' },
          { key: 'light', de: 'Lichtsensor', en: 'Light sensor' },
          { key: 'pv', de: 'PV-Anlage', en: 'PV system' },
          { key: 'off', de: 'Aus', en: 'Off' },
        ];
        return (
          <section class="lg2-card lg2-rules__card" data-testid="lg2-rules-lightsensor">
            <h2 class="lg2-card__title">{t('Lichtsensor & Live-Himmel', 'Light sensor & live sky')}</h2>
            <p class="lg2-rules__hint">
              {t(
                'Ein globaler Außen-Lichtsensor (Helligkeit in Lux) wird wie die PV-Anlage hausweit genutzt: Er misst live, wie hell es gerade draußen ist, und korrigiert damit die Strahlungs-Vorhersage der nächsten Stunden (Wolken vorausschauend). Anders als die PV-Anlage hängt er nicht von der Anlagen-Ausrichtung ab und ist deshalb meist der zuverlässigere Wolken-Fühler.',
                'A global outdoor light sensor (brightness in lux) is used house-wide like the PV system: it measures live how bright it is outside and corrects the near-term radiation forecast (clouds, proactively). Unlike the PV system it does not depend on the array orientation, so it is usually the more reliable cloud probe.',
              )}
            </p>
            <label class="lg2-rules__field" data-testid="lg2-rules-lightsensor-select">
              <span class="lg2-rules__field-label">{t('Globaler Lichtsensor', 'Global light sensor')}</span>
              <select
                value={lightDeviceId ?? ''}
                onChange={(e): void => setLightSensor((e.currentTarget as HTMLSelectElement).value)}
              >
                <option value="">{t('— kein Lichtsensor —', '— no light sensor —')}</option>
                {lightDeviceId !== undefined && !lights.some((d) => d.deviceId === lightDeviceId) && (
                  <option value={lightDeviceId}>{t(`Sensor (…${lightDeviceId.slice(-4)})`, `Sensor (…${lightDeviceId.slice(-4)})`)}</option>
                )}
                {lights.map((d) => (<option key={d.deviceId} value={d.deviceId}>{deviceLabel(d)}</option>))}
              </select>
              {lights.length === 0 && (
                <small class="lg2-rules__hint">{t('Keine Lichtsensoren gefunden. Ggf. „Geräte suchen" im Tab „Räume" ausführen.', 'No light sensors found. Run "Discover devices" in the "Rooms" tab if needed.')}</small>
              )}
            </label>

            <span class="lg2-rules__field-label">{t('Live-Himmel-Quelle (Wolken-Korrektur)', 'Live-sky source (cloud correction)')}</span>
            <div class="lg2-seg" role="tablist" data-testid="lg2-rules-nowcast-source">
              {NOWCAST_OPTS.map((o) => (
                <button key={o.key} type="button" role="tab" aria-selected={nowcastSrc === o.key}
                  class={`lg2-seg__btn${nowcastSrc === o.key ? ' lg2-seg__btn--on' : ''}`}
                  data-testid={`lg2-rules-nowcast-${o.key}`}
                  onClick={(): void => patchRules((r) => ({ ...r, cloudNowcastSource: o.key }))}>
                  {t(o.de, o.en)}
                </button>
              ))}
            </div>
            <p class="lg2-rules__hint">
              {t(
                'Automatisch nutzt den Lichtsensor, sobald er verfügbar ist, sonst die PV-Anlage. „Aus" verwendet nur die reine Wettervorhersage.',
                'Automatic uses the light sensor when available, otherwise the PV system. "Off" uses the raw weather forecast only.',
              )}
            </p>
          </section>
        );
      })()}

      {/* Simulation / dry run — expert only (hidden in Basis). */}
      {expertMode.value && <SimulationPanel winName={winName} />}
    </main>
  );
}

/* -------------------------------------------------------------------------- */
/* Simulation panel — real synthetic probe, never moves a shutter (R14.5).    */
/* -------------------------------------------------------------------------- */

function SimulationPanel(props: { winName: (id: string) => string }): JSX.Element {
  const [result, setResult] = useState<ProbeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = (): void => {
    setBusy(true);
    setError(null);
    void (async (): Promise<void> => {
      try {
        const res = await postJson('/api/probe/run', undefined, 10_000);
        if (res.status === 503) { setError(t('Simulation derzeit nicht verfügbar.', 'Simulation currently unavailable.')); return; }
        if (!res.ok) { setError(`HTTP ${res.status}`); return; }
        const json = (await res.json()) as { mode: string; windowDecisions: Array<{ windowId: string; finalTarget: number }> };
        setResult({ mode: json.mode, windows: json.windowDecisions });
      } catch (err) {
        setError(err instanceof Error && err.name === 'AbortError'
          ? t('Zeitüberschreitung beim Probelauf', 'Simulation timed out')
          : err instanceof Error ? err.message : t('Unbekannter Fehler', 'Unknown error'));
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <section class="lg2-card lg2-rules__card lg2-rules__sim" data-testid="lg2-rules-simulation">
      <h2 class="lg2-card__title">{t('Simulation / Probelauf', 'Simulation / dry run')}</h2>
      <p class="lg2-rules__sim-note" data-testid="lg2-rules-sim-note">
        <Icon name="forecast" size={15} /> {t('Probelauf berechnet nur — es wird KEIN Rollladen gefahren.', 'A dry run only computes — NO shutter is moved.')}
      </p>
      <button type="button" class="lg2-btn" data-testid="lg2-rules-sim-run" disabled={busy} onClick={run}>
        {busy ? t('Läuft…', 'Running…') : t('Probelauf jetzt', 'Run simulation now')}
      </button>
      {error !== null && <p class="lg2-rules__preview-err" data-testid="lg2-rules-sim-error">{error}</p>}
      {result !== null && (
        <Fragment>
          <p class="lg2-rules__preview-mode">{t('Ergebnis-Modus', 'Result mode')}: <b>{result.mode}</b></p>
          <div class="lg2-rules__preview-grid" data-testid="lg2-rules-sim-result">
            {result.windows.map((w) => (
              <span key={w.windowId} class="lg2-rules__preview-cell">
                <em>{props.winName(w.windowId)}</em><b>{Math.round(w.finalTarget * 100)} %</b>
              </span>
            ))}
          </div>
        </Fragment>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* lg2 form primitives                                                        */
/* -------------------------------------------------------------------------- */

function RuleToggle(props: { on: boolean; label: string; testId: string; onToggle: (on: boolean) => void }): JSX.Element {
  return (
    <label class="lg2-rules__toggle">
      <button type="button" role="switch" aria-checked={props.on}
        class={`lg2-toggle${props.on ? ' lg2-toggle--on' : ''}`}
        data-testid={props.testId} onClick={(): void => props.onToggle(!props.on)} />
      <span>{props.label}</span>
    </label>
  );
}

function RuleNumber(props: { label: string; value: number; min: number; max: number; step: number; unit?: string; testId: string; onChange: (v: number) => void }): JSX.Element {
  return (
    <label class="lg2-rules__num">
      <span>{props.label}</span>
      <span class="lg2-rules__num-input">
        <input type="number" min={props.min} max={props.max} step={props.step} value={props.value}
          data-testid={props.testId}
          onChange={(e): void => {
            const v = Number((e.currentTarget as HTMLInputElement).value);
            if (Number.isFinite(v)) props.onChange(v);
          }} />
        {props.unit !== undefined && props.unit !== '' && <em>{props.unit}</em>}
      </span>
    </label>
  );
}

/* -------------------------------------------------------------------------- */
/* Hot-day multi-stage editor: freely configurable temperature → shading ramp */
/* (e.g. 30 °C → 30 %, 35 °C → 50 %). Falls back to the legacy single stage.   */
/* -------------------------------------------------------------------------- */

interface HotDayStage { outdoorThresholdC: number; shadingPercent: number }

/** Resolve the editable stage list from the rules (migrating the legacy pair). */
function hotDayStagesOf(hotDay: Rules['hotDay'] | undefined): HotDayStage[] {
  const stages = hotDay?.stages;
  if (stages !== undefined && stages.length > 0) {
    return stages.map((s) => ({ outdoorThresholdC: s.outdoorThresholdC, shadingPercent: s.shadingPercent }));
  }
  // Seed one stage from the legacy single-stage fields (shading = 100 − maxOpen).
  return [{
    outdoorThresholdC: hotDay?.outdoorThresholdC ?? 30,
    shadingPercent: Math.max(0, Math.min(100, 100 - (hotDay?.maxOpenPercent ?? 50))),
  }];
}

function HotDayStagesEditor(props: { stages: HotDayStage[]; onChange: (stages: HotDayStage[]) => void }): JSX.Element {
  const clampTemp = (v: number): number => Math.min(50, Math.max(20, Math.round(v)));
  const clampPct = (v: number): number => Math.min(100, Math.max(0, Math.round(v)));
  const write = (next: HotDayStage[]): void => {
    props.onChange([...next].sort((a, b) => a.outdoorThresholdC - b.outdoorThresholdC));
  };
  const stages = props.stages;
  return (
    <div class="lg2-rules__stages" data-testid="lg2-rules-hotday-stages">
      <p class="lg2-rules__stages-hint">
        {t('Stufen: ab welcher Außentemperatur mindestens wie stark beschattet wird. Es gilt immer die höchste erreichte Stufe.',
          'Stages: from which outdoor temperature to hold at least this much shading. The highest reached stage always wins.')}
      </p>
      {stages.map((st, i) => (
        <div class="lg2-rules__stage" key={`stage-${i}`} data-testid={`lg2-rules-hotday-stage-${i}`}>
          <RuleNumber testId={`lg2-rules-hotday-temp-${i}`} label={t('ab ≥ … °C außen', 'from ≥ … °C outdoor')} unit="°C" min={20} max={50} step={1}
            value={st.outdoorThresholdC}
            onChange={(v): void => write(stages.map((s, j) => (j === i ? { ...s, outdoorThresholdC: clampTemp(v) } : s)))} />
          <RuleNumber testId={`lg2-rules-hotday-shade-${i}`} label={t('Beschattung %', 'shading %')} unit="%" min={0} max={100} step={5}
            value={st.shadingPercent}
            onChange={(v): void => write(stages.map((s, j) => (j === i ? { ...s, shadingPercent: clampPct(v) } : s)))} />
          <button type="button" class="lg2-rules__stage-del" data-testid={`lg2-rules-hotday-del-${i}`}
            disabled={stages.length <= 1}
            aria-label={t('Stufe entfernen', 'Remove stage')}
            onClick={(): void => write(stages.filter((_, j) => j !== i))}>
            <Icon name="schliessen" size={14} />
          </button>
        </div>
      ))}
      <button type="button" class="lg2-rules__stage-add" data-testid="lg2-rules-hotday-add"
        onClick={(): void => {
          const last = stages[stages.length - 1];
          write([...stages, {
            outdoorThresholdC: clampTemp((last?.outdoorThresholdC ?? 30) + 5),
            shadingPercent: clampPct((last?.shadingPercent ?? 30) + 20),
          }]);
        }}>
        + {t('Stufe hinzufügen', 'Add stage')}
      </button>
    </div>
  );
}
