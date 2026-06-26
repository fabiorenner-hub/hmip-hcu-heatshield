/**
 * Rules & Thresholds tab (Task 12.3).
 *
 * Profile switcher (`conservative / standard / aggressive /
 * custom`) followed by a slider per threshold. Selecting one of the
 * named profiles spreads its preset over the `Rules` subtree;
 * `custom` keeps the current values.
 *
 * Live probe panel: every slider change debounces 300 ms and then
 * sends the in-progress config to `POST /api/config/probe`. The
 * resulting `windowDecisions[*].finalTarget` is rendered alongside
 * the slider so the user sees the impact of each tweak before
 * saving.
 *
 * Save → `PUT /api/config`.
 */

import { Fragment, h, type JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';

import type { Config, Rules } from '../../../../shared/types.js';
import { applyProfile, type ProfileName, PROFILE_PRESETS } from '../profiles.js';
import { useConfig } from '../hooks/useConfig.js';
import { AutomationStatusCard } from '../components/dashboard/analysisRail.js';
import { AutomationTechnical } from '../components/dashboard/automationTechnical.js';
import { snapshot } from '../store.js';

interface SliderSpec {
  /** Dot-separated path into `Rules`, e.g. `comfort.maxIndoorTempC`. */
  path: string;
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
  /** Multiply the stored value for DISPLAY only (e.g. m/s → km/h). Default 1. */
  scale?: number;
}

const SLIDERS: SliderSpec[] = [
  { path: 'comfort.maxIndoorTempC', label: 'Komfort · max. Innentemperatur', min: 22, max: 28, step: 0.5, unit: '°C' },
  { path: 'comfort.preShadeTempC', label: 'Komfort · Vor-Beschattung ab', min: 21, max: 26, step: 0.5, unit: '°C' },
  { path: 'comfort.vacationOffsetC', label: 'Komfort · Urlaubs-Absenkung', min: 0, max: 2, step: 0.1, unit: '°C' },
  { path: 'automation.controlIntervalSeconds', label: 'Automatik · Zyklusintervall', min: 180, max: 3600, step: 60, unit: 's' },
  { path: 'automation.minSecondsBetweenMoves', label: 'Automatik · Mindestpause zwischen Fahrten', min: 300, max: 21600, step: 300, unit: 's' },
  { path: 'automation.minPositionDeltaPct', label: 'Automatik · Mindest-Positionsänderung', min: 5, max: 30, step: 1, unit: '%' },
  { path: 'sun.minElevationDeg', label: 'Sonne · Mindesthöhe', min: 0, max: 15, step: 1, unit: '°' },
  { path: 'storm.thresholdMs', label: 'Sturm · Schwelle', min: 10, max: 20, step: 0.1, unit: 'km/h', scale: 3.6 },
  { path: 'nightCooling.deltaC', label: 'Nachtkühlung · Delta', min: 0.5, max: 3, step: 0.1, unit: '°C' },
  // Smart-shading (PV-geführte Wärmelast & Hysterese).
  { path: 'heatLoad.pvWeight', label: 'Wärmelast · PV-Gewicht', min: 0, max: 1, step: 0.05, unit: '' },
  { path: 'heatLoad.tempWeight', label: 'Wärmelast · Temp-Gewicht', min: 0, max: 1, step: 0.05, unit: '' },
  { path: 'heatLoad.trendWeight', label: 'Wärmelast · Trend-Gewicht', min: 0, max: 1, step: 0.05, unit: '' },
  { path: 'heatLoad.activateThreshold', label: 'Beschattung · Aktivierungsschwelle', min: 0, max: 1, step: 0.05, unit: '' },
  { path: 'heatLoad.releaseThreshold', label: 'Beschattung · Deaktivierungsschwelle', min: 0, max: 1, step: 0.05, unit: '' },
  { path: 'heatLoad.releaseHoldMinutes', label: 'Beschattung · Mindesthaltezeit', min: 0, max: 180, step: 5, unit: 'min' },
  { path: 'heatLoad.trendWindowHours', label: 'Trend · Zeitfenster', min: 0.5, max: 12, step: 0.5, unit: 'h' },
];

const PROFILES: ProfileName[] = ['conservative', 'standard', 'aggressive', 'custom'];

const PROFILE_LABELS: Record<ProfileName, string> = {
  conservative: 'Konservativ',
  standard: 'Standard',
  aggressive: 'Aggressiv',
  custom: 'Benutzerdefiniert',
};

const DEBOUNCE_MS = 300;

function getRulesValue(rules: Rules, path: string): number {
  const parts = path.split('.');
  // We only navigate one or two levels deep (per SLIDERS table).
  const head = parts[0];
  const tail = parts[1];
  if (head === undefined || tail === undefined) {
    return 0;
  }
  const block = (rules as unknown as Record<string, Record<string, unknown>>)[head];
  const v = block?.[tail];
  return typeof v === 'number' ? v : 0;
}

function setRulesValue(rules: Rules, path: string, value: number): Rules {
  const parts = path.split('.');
  const head = parts[0];
  const tail = parts[1];
  if (head === undefined || tail === undefined) {
    return rules;
  }
  const next = {
    ...rules,
    [head]: {
      ...((rules as unknown as Record<string, Record<string, unknown>>)[head] ?? {}),
      [tail]: value,
    },
  } as Rules;
  // Tweaking any slider switches the profile to `custom` so the
  // profile switcher reflects the user's intent.
  return { ...next, profile: 'custom' };
}

interface ProbeResult {
  mode: string;
  windows: Array<{ windowId: string; finalTarget: number }>;
}

export function RulesTab(): JSX.Element {
  const cfg = useConfig();
  const [draftConfig, setDraftConfig] = useState<Config | null>(null);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (cfg.config.value !== null && draftConfig === null) {
      setDraftConfig(cfg.config.value);
    }
  }, [cfg.config.value]);

  // Auto-save: persist rule/notification edits after a short idle. The
  // deep-equality guard prevents a save loop after the server echoes back.
  useEffect(() => {
    if (draftConfig === null || cfg.config.value === null) {
      return;
    }
    if (JSON.stringify(draftConfig) !== JSON.stringify(cfg.config.value)) {
      cfg.scheduleSave(draftConfig);
    }
  }, [draftConfig]);

  const triggerProbe = (next: Config): void => {
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current);
    }
    debounceTimerRef.current = setTimeout(() => {
      void (async (): Promise<void> => {
        try {
          const res = await fetch('/api/config/probe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(next),
          });
          if (!res.ok) {
            setProbeError(`HTTP ${res.status}`);
            setProbe(null);
            return;
          }
          const json = (await res.json()) as {
            mode: string;
            windowDecisions: Array<{ windowId: string; finalTarget: number }>;
          };
          setProbe({ mode: json.mode, windows: json.windowDecisions });
          setProbeError(null);
        } catch (err) {
          setProbeError(err instanceof Error ? err.message : 'unknown error');
        }
      })();
    }, DEBOUNCE_MS);
  };

  useEffect(() => {
    return (): void => {
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  const handleProfile = (profile: ProfileName): void => {
    setDraftConfig((prev) => {
      if (prev === null) {
        return prev;
      }
      const nextRules = applyProfile(prev.rules, profile);
      const next: Config = { ...prev, rules: nextRules };
      triggerProbe(next);
      return next;
    });
  };

  const handleSlider = (path: string, value: number): void => {
    setDraftConfig((prev) => {
      if (prev === null) {
        return prev;
      }
      const nextRules = setRulesValue(prev.rules, path, value);
      const next: Config = { ...prev, rules: nextRules };
      triggerProbe(next);
      return next;
    });
  };

  const presetReference = useMemo<Record<string, number>>(() => {
    if (draftConfig === null) {
      return {};
    }
    if (draftConfig.rules.profile === 'custom') {
      return {};
    }
    const preset = PROFILE_PRESETS[draftConfig.rules.profile];
    const out: Record<string, number> = {};
    for (const s of SLIDERS) {
      const parts = s.path.split('.');
      const head = parts[0];
      const tail = parts[1];
      if (head === undefined || tail === undefined) {
        continue;
      }
      const block = (preset as unknown as Record<string, Record<string, number>>)[head];
      const v = block?.[tail];
      if (typeof v === 'number') {
        out[s.path] = v;
      }
    }
    return out;
  }, [draftConfig]);

  if (draftConfig === null) {
    return (
      <section class="tab-rules" data-testid="tab-rules">
        <h2>Regeln und Schwellen</h2>
        <p>Konfiguration wird geladen…</p>
      </section>
    );
  }

  const activeProfile: ProfileName = draftConfig.rules.profile;

  const probeWindowLabel = (windowId: string): string => {
    const win = draftConfig.windows.find((w) => w.id === windowId);
    const tail = `…${windowId.slice(-4)}`;
    if (win === undefined) {
      return `Fenster (${tail})`;
    }
    const room = draftConfig.rooms.find((r) => r.id === win.roomId);
    const roomName = room?.name ?? 'Ohne Raum';
    return `${roomName} – Rollladen (${tail})`;
  };

  return (
    <section class="tab-rules" data-testid="tab-rules">
      <header class="tab-rules__header">
        <h2>Regeln und Schwellen</h2>
        <span class="tab-rules__autosave" data-testid="rules-autosave">
          {cfg.loading.value ? 'Speichert…' : 'Automatisch gespeichert'}
        </span>
      </header>

      {snapshot.value !== null && (
        <AutomationStatusCard snapshot={snapshot.value} />
      )}

      {snapshot.value !== null && (
        <AutomationTechnical snapshot={snapshot.value} config={draftConfig} />
      )}

      <div class="tab-rules__profile-switcher" role="tablist">
        {PROFILES.map((p) => (
          <button
            key={p}
            type="button"
            role="tab"
            aria-selected={activeProfile === p}
            class={activeProfile === p ? 'tab-rules__profile-btn--active' : ''}
            data-testid={`rules-profile-${p}`}
            onClick={(): void => handleProfile(p)}
          >
            {PROFILE_LABELS[p]}
          </button>
        ))}
      </div>

      <div class="tab-rules__sliders">
        {SLIDERS.map((s) => {
          const value = getRulesValue(draftConfig.rules, s.path);
          const reference = presetReference[s.path];
          return (
            <div class="tab-rules__slider-row" key={s.path} data-testid={`rules-slider-row-${s.path}`}>
              <label>
                <span>{s.label}</span>
                <input
                  type="range"
                  min={s.min}
                  max={s.max}
                  step={s.step}
                  value={value}
                  data-testid={`rules-slider-${s.path}`}
                  onInput={(e): void => {
                    const next = Number.parseFloat((e.currentTarget as HTMLInputElement).value);
                    if (Number.isFinite(next)) {
                      handleSlider(s.path, next);
                    }
                  }}
                />
                <output data-testid={`rules-output-${s.path}`}>
                  {Math.round(value * (s.scale ?? 1) * 10) / 10}
                  {s.unit}
                </output>
              </label>
              {reference !== undefined && Math.abs(reference - value) > 1e-6 && (
                <small class="tab-rules__slider-ref">
                  preset {Math.round(reference * (s.scale ?? 1) * 10) / 10}
                  {s.unit}
                </small>
              )}
            </div>
          );
        })}
      </div>

      <section class="tab-rules__advanced" data-testid="rules-advanced">
        <h3>Automatik-Erweiterungen</h3>

        <label class="tab-rules__check">
          <input
            type="checkbox"
            data-testid="rules-night-inactive"
            checked={draftConfig.rules.automation.pauseBetweenSunsetAndSunrise ?? false}
            onChange={(e): void => {
              const on = (e.currentTarget as HTMLInputElement).checked;
              setDraftConfig((prev) =>
                prev === null
                  ? prev
                  : {
                      ...prev,
                      rules: {
                        ...prev.rules,
                        automation: {
                          ...prev.rules.automation,
                          pauseBetweenSunsetAndSunrise: on,
                        },
                      },
                    },
              );
            }}
          />
          <span>
            Nachts inaktiv: zwischen Sonnenuntergang und Sonnenaufgang keine
            automatischen Rollladenfahrten (Sturm bleibt aktiv)
          </span>
        </label>

        <label class="tab-rules__check">
          <input
            type="checkbox"
            data-testid="rules-quiet-enabled"
            checked={draftConfig.rules.automation.quietHours?.enabled ?? false}
            onChange={(e): void => {
              const on = (e.currentTarget as HTMLInputElement).checked;
              setDraftConfig((prev) =>
                prev === null
                  ? prev
                  : {
                      ...prev,
                      rules: {
                        ...prev.rules,
                        automation: {
                          ...prev.rules.automation,
                          quietHours: { ...prev.rules.automation.quietHours, enabled: on },
                        },
                      },
                    },
              );
            }}
          />
          <span>
            Ruhezeit: in einem festen Zeitfenster keine automatischen Fahrten
            (Sturm bleibt aktiv)
          </span>
        </label>
        <label class="tab-rules__field">
          <span>Ruhezeit von … Uhr</span>
          <input
            type="number"
            min={0}
            max={23}
            step={1}
            data-testid="rules-quiet-start"
            value={draftConfig.rules.automation.quietHours?.startHour ?? 22}
            onInput={(e): void => {
              const v = Number.parseInt((e.currentTarget as HTMLInputElement).value, 10);
              if (Number.isFinite(v)) {
                const startHour = Math.min(23, Math.max(0, v));
                setDraftConfig((prev) =>
                  prev === null
                    ? prev
                    : {
                        ...prev,
                        rules: {
                          ...prev.rules,
                          automation: {
                            ...prev.rules.automation,
                            quietHours: { ...prev.rules.automation.quietHours, startHour },
                          },
                        },
                      },
                );
              }
            }}
          />
        </label>
        <label class="tab-rules__field">
          <span>… bis … Uhr</span>
          <input
            type="number"
            min={0}
            max={23}
            step={1}
            data-testid="rules-quiet-end"
            value={draftConfig.rules.automation.quietHours?.endHour ?? 6}
            onInput={(e): void => {
              const v = Number.parseInt((e.currentTarget as HTMLInputElement).value, 10);
              if (Number.isFinite(v)) {
                const endHour = Math.min(23, Math.max(0, v));
                setDraftConfig((prev) =>
                  prev === null
                    ? prev
                    : {
                        ...prev,
                        rules: {
                          ...prev.rules,
                          automation: {
                            ...prev.rules.automation,
                            quietHours: { ...prev.rules.automation.quietHours, endHour },
                          },
                        },
                      },
                );
              }
            }}
          />
        </label>

        <label class="tab-rules__check">
          <input
            type="checkbox"
            data-testid="rules-insulation-enabled"
            checked={draftConfig.rules.insulation?.enabled ?? false}
            onChange={(e): void => {
              const on = (e.currentTarget as HTMLInputElement).checked;
              setDraftConfig((prev) =>
                prev === null
                  ? prev
                  : {
                      ...prev,
                      rules: {
                        ...prev.rules,
                        insulation: { ...prev.rules.insulation, enabled: on },
                      },
                    },
              );
            }}
          />
          <span>Winter-Isolierung (Rollläden schließen in kalten Nächten)</span>
        </label>
        <label class="tab-rules__field">
          <span>Isolieren nur bei Außentemperatur ≤ … °C</span>
          <input
            type="number"
            min={-20}
            max={20}
            step={1}
            data-testid="rules-insulation-maxtemp"
            value={draftConfig.rules.insulation?.maxOutdoorTempC ?? 5}
            onInput={(e): void => {
              const v = Number.parseFloat((e.currentTarget as HTMLInputElement).value);
              if (Number.isFinite(v)) {
                setDraftConfig((prev) =>
                  prev === null
                    ? prev
                    : {
                        ...prev,
                        rules: {
                          ...prev.rules,
                          insulation: { ...prev.rules.insulation, maxOutdoorTempC: v },
                        },
                      },
                );
              }
            }}
          />
        </label>
        <label class="tab-rules__field">
          <span>Schließgrad zur Isolierung (%)</span>
          <input
            type="number"
            min={0}
            max={100}
            step={5}
            data-testid="rules-insulation-level"
            value={Math.round((draftConfig.rules.insulation?.level01 ?? 1) * 100)}
            onInput={(e): void => {
              const v = Number.parseInt((e.currentTarget as HTMLInputElement).value, 10);
              if (Number.isFinite(v)) {
                const level01 = Math.min(1, Math.max(0, v / 100));
                setDraftConfig((prev) =>
                  prev === null
                    ? prev
                    : {
                        ...prev,
                        rules: {
                          ...prev.rules,
                          insulation: { ...prev.rules.insulation, level01 },
                        },
                      },
                );
              }
            }}
          />
        </label>

        <label class="tab-rules__check">
          <input
            type="checkbox"
            data-testid="rules-learning-autoapply"
            checked={draftConfig.learning?.autoApply ?? false}
            onChange={(e): void => {
              const on = (e.currentTarget as HTMLInputElement).checked;
              setDraftConfig((prev) =>
                prev === null
                  ? prev
                  : { ...prev, learning: { ...prev.learning, autoApply: on } },
              );
            }}
          />
          <span>Lern-Empfehlungen automatisch übernehmen</span>
        </label>
      </section>

      <aside class="tab-rules__probe" data-testid="rules-probe">
        <h3>Live-Vorschau</h3>
        {probeError !== null && <p class="tab-rules__error">{probeError}</p>}
        {probe === null && probeError === null && (
          <p class="tab-rules__hint">Einen Regler bewegen für eine Vorschau.</p>
        )}
        {probe !== null && (
          <Fragment>
            <p>
              Modus: <strong data-testid="rules-probe-mode">{probe.mode}</strong>
            </p>
            <ul data-testid="rules-probe-windows">
              {probe.windows.map((w) => (
                <li key={w.windowId}>
                  {probeWindowLabel(w.windowId)}: Ziel {(w.finalTarget * 100).toFixed(0)}%
                </li>
              ))}
            </ul>
          </Fragment>
        )}
      </aside>

      {cfg.saveError.value !== null && (
        <div class="tab-rules__error" data-testid="rules-save-error">
          <strong>{cfg.saveError.value.error.message}</strong>
        </div>
      )}
      {cfg.saveOk.value && (
        <p class="tab-rules__ok" data-testid="rules-save-ok">Gespeichert.</p>
      )}
    </section>
  );
}
