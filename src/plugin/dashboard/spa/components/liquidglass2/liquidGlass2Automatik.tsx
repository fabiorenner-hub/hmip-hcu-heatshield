/**
 * Heat Shield — "Liquid Glass V2" Automatik page (DEMO `/liquid-glass-automatik`).
 *
 * Matches the approved mock: a mode header, tabs (Status / Strategie /
 * Simulation / Entscheidungsverlauf), and on Status a three-column layout —
 * live status, a decision rationale, and today's strategy settings — plus a
 * "Letzte Aktionen" strip. All values come from the live snapshot
 * (modeInfo, plannedActions, rooms); honest fallbacks where data is missing.
 */

import { h, Fragment, type JSX } from 'preact';
import { useState, useEffect, useCallback } from 'preact/hooks';
import { route } from 'preact-router';

import { t, fmtTime, fmtNum } from '../../i18n.js';
import { snapshot, riskBreakdowns } from '../../store.js';
import { expertMode } from '../../expertMode.js';
import { useConfig, scheduleSave } from '../../hooks/useConfig.js';
import { Lg2AutoLever } from './shell/lg2Shell.js';
import { ExpertSection, ExpertMetrics, M, RiskBreakdownDetail, hms, relAge } from './shell/lg2Expert.js';
import { Icon, type IconName } from '../icons.js';
import type { Config } from '../../../../../shared/types.js';
import type { DashboardSnapshot, PlannedAction } from '../../types.js';

/** Strategy profile → bilingual label (task 11.15, dynamic from config). */
const PROFILE_LABEL: Record<string, [string, string]> = {
  conservative: ['Konservativ', 'Conservative'],
  standard: ['Standard', 'Standard'],
  aggressive: ['Aggressiv', 'Aggressive'],
  custom: ['Benutzerdefiniert', 'Custom'],
};

interface RoutableProps { path?: string }
type Tab = 'status' | 'strategie' | 'simulation' | 'verlauf';

/** Bilingual labels for the risk factors (expert strategy weights). */
const FACTOR_LABEL: Record<string, [string, string]> = {
  sunFactor: ['Sonne', 'Sun'],
  roomTempFactor: ['Raumtemp.', 'Room temp.'],
  windowTypeFactor: ['Fenstertyp', 'Window type'],
  forecastTempFactor: ['Prognosetemp.', 'Forecast temp.'],
  pvFactor: ['PV', 'PV'],
  radiationFactor: ['Strahlung', 'Radiation'],
  outdoorTempFactor: ['Außentemp.', 'Outdoor temp.'],
  priorityFactor: ['Priorität', 'Priority'],
};

/** Average normalised weight per risk factor across all windows (0..1). */
function aggregateWeights(): Array<{ key: string; weight: number }> {
  const sums: Record<string, { sum: number; n: number }> = {};
  for (const b of Object.values(riskBreakdowns.value)) {
    for (const [key, w] of Object.entries(b.weights)) {
      if (w === undefined) continue;
      const acc = sums[key] ?? { sum: 0, n: 0 };
      acc.sum += w; acc.n += 1;
      sums[key] = acc;
    }
  }
  return Object.entries(sums)
    .map(([key, { sum, n }]) => ({ key, weight: n > 0 ? sum / n : 0 }))
    .sort((a, b) => b.weight - a.weight);
}

function roomForWindow(snap: DashboardSnapshot, windowId: string): string {
  const r = (snap.roomsDetail ?? []).find((x) => x.windowId === windowId);
  return r?.name ?? t('Fenster', 'Window');
}

export function LiquidGlass2Automatik(_props: RoutableProps): JSX.Element {
  const snap = snapshot.value;
  return (
    <main class="lg2-main lg2-auto" data-testid="liquid-glass2-automatik">
      {snap === null ? <AutoSkeleton /> : <AutoBody snap={snap} />}
    </main>
  );
}

function AutoBody(props: { snap: DashboardSnapshot }): JSX.Element {
  const { snap } = props;
  const [tab, setTab] = useState<Tab>('status');
  const mode = snap.modeInfo;
  const now = Date.now();
  const actions = (snap.plannedActions ?? []).slice().sort((a, b) => Date.parse(a.scheduledTs) - Date.parse(b.scheduledTs));
  const future = actions.filter((a) => Date.parse(a.scheduledTs) >= now);
  const past = actions.filter((a) => Date.parse(a.scheduledTs) < now).reverse();

  const tabs: Array<{ id: Tab; label: [string, string] }> = [
    { id: 'status', label: ['Status', 'Status'] },
    { id: 'strategie', label: ['Strategie', 'Strategy'] },
    { id: 'simulation', label: ['Simulation', 'Simulation'] },
    { id: 'verlauf', label: ['Entscheidungsverlauf', 'Decision log'] },
  ];

  return (
    <Fragment>
      <header class="lg2-header">
        <div>
          <h1 class="lg2-header__title">{t('Automatik', 'Automation')}</h1>
          <p class="lg2-header__sub">{t('Regeln, Entscheidungen und Simulation', 'Rules, decisions and simulation')}</p>
        </div>
        <div class="lg2-header__right">
          <Lg2AutoLever />
          <span class="lg2-auto__mode">
            <Icon name="beschattung" size={18} />
            <span><em>{t('Modus', 'Mode')}</em><b>{mode?.label ?? t('Normal', 'Normal')}</b></span>
          </span>
        </div>
      </header>

      <div class="lg2-auto__tabs" role="tablist">
        {tabs.map((tb) => (
          <button key={tb.id} type="button" role="tab" aria-selected={tab === tb.id}
            class={`lg2-auto__tab${tab === tb.id ? ' lg2-auto__tab--on' : ''}`}
            onClick={(): void => setTab(tb.id)}>{t(...tb.label)}</button>
        ))}
      </div>

      {tab === 'status' && <StatusTab snap={snap} future={future} />}
      {tab === 'strategie' && <StrategieTab snap={snap} />}
      {tab === 'simulation' && <SimulationTab />}
      {tab === 'verlauf' && <VerlaufTab />}

      {tab === 'status' && <LastActions snap={snap} past={past.length > 0 ? past : future} />}
    </Fragment>
  );
}

/* ---- Status tab ----------------------------------------------------------- */

function StatusTab(props: { snap: DashboardSnapshot; future: PlannedAction[] }): JSX.Element {
  const { snap, future } = props;
  const { config } = useConfig();
  const mode = snap.modeInfo;
  const next = future[0] ?? null;
  const rooms = snap.roomsDetail ?? [];
  const blocks = rooms.filter((r) => (r.manualOverrideUntil !== undefined && r.manualOverrideUntil !== null && Date.parse(r.manualOverrideUntil) > Date.now()) || r.windowOpen === true);
  const storm = snap.weatherAlert?.active === true || mode?.id === 'storm';

  return (
    <Fragment>
      <div class="lg2-auto__grid3">
      {/* Live status */}
      <div class="lg2-card lg2-auto__col">
        <h3 class="lg2-card__title">{t('Status', 'Status')}</h3>
        <div class="lg2-auto__big">
          <span class="lg2-auto__biglabel">{t('Nächste Aktion', 'Next action')}</span>
          <span class="lg2-auto__bigval">{next !== null ? fmtTime(next.scheduledTs) : '–'}</span>
          <span class="lg2-auto__bigsub">
            {next !== null
              ? `${roomForWindow(snap, next.windowId)} ${t('auf', 'to')} ${Math.round(next.targetPercent)} %`
              : t('keine Fahrt geplant', 'nothing planned')}
          </span>
        </div>

        <div class="lg2-auto__blocks">
          <div class="lg2-auto__blockhead">{t('Aktive Blockaden', 'Active blocks')} <span class="lg2-auto__blockn">{blocks.length}</span></div>
          {blocks.length === 0 ? (
            <div class="lg2-auto__blockrow"><span class="lg2-auto__bok"><Icon name="beschattung" size={14} /></span>
              <span><b>{t('Keine Blockaden', 'No blocks')}</b><em>{t('Automatik frei', 'Automation clear')}</em></span></div>
          ) : blocks.slice(0, 4).map((r) => (
            <div key={r.id} class="lg2-auto__blockrow">
              <span class="lg2-auto__bicon"><Icon name="schloss" size={14} /></span>
              <span><b>{r.manualOverrideUntil !== undefined && r.manualOverrideUntil !== null && Date.parse(r.manualOverrideUntil) > Date.now() ? t('Manuelle Übersteuerung', 'Manual override') : t('Fenster offen', 'Window open')}</b><em>{r.name}</em></span>
            </div>
          ))}
          <div class="lg2-auto__blockrow">
            <span class={`lg2-auto__bok${storm ? ' lg2-auto__bok--warn' : ''}`}><Icon name="beschattung" size={14} /></span>
            <span><b>{t('Sicherheitsstatus', 'Safety status')}</b>
              <em style={{ color: storm ? '#ff5d57' : '#30d158' }}>{storm ? t('Sturmschutz aktiv', 'Storm protection active') : t('Alles im grünen Bereich', 'All clear')}</em></span>
          </div>
        </div>

        <StormControl snap={snap} config={config.value} />
        <GentleShadeControl config={config.value} />

        <div class="lg2-auto__big lg2-auto__big--sm">
          <span class="lg2-auto__biglabel">{t('Automatik', 'Automation')}</span>
          <span class="lg2-auto__bigval" style={{ color: snap.automationEnabled === false ? '#ff9f0a' : '#30d158' }}>
            {snap.automationEnabled === false ? t('Aus', 'Off') : t('Aktiv', 'Active')}
          </span>
          <span class="lg2-auto__bigsub">{snap.automationEnabled === false ? t('Konfigurationsmodus', 'Configuration mode') : t('läuft & überwacht', 'running & monitoring')}</span>
        </div>
      </div>

      {/* Decision rationale */}
      <div class="lg2-card lg2-auto__col lg2-auto__reason">
        <h3 class="lg2-card__title">{t('Entscheidungsbegründung', 'Decision rationale')}</h3>
        {next !== null ? (
          <Fragment>
            <div class="lg2-auto__decision">
              <span class="lg2-auto__dicon"><Icon name="beschattung" size={20} /></span>
              <div>
                <b>{roomForWindow(snap, next.windowId)} {t('wird gefahren auf', 'moves to')} {Math.round(next.targetPercent)} %</b>
                <em>{t('Geplante Aktion', 'Planned action')}: {fmtTime(next.scheduledTs)}</em>
              </div>
            </div>
            <ReasonBlock icon="sonne" title={t('Hauptgrund', 'Main reason')} body={next.reason || mode?.decidedBy || t('Vorausschauender Hitzeschutz.', 'Predictive heat protection.')} />
            {mode !== undefined && (
              <ReasonBlock icon="forecast" title={t('Ziel des Modus', 'Mode goal')} body={mode.goal} />
            )}
            {mode !== undefined && mode.reasons.length > 0 && (
              <ReasonBlock icon="automation" title={t('Weitere Faktoren', 'Further factors')} body={mode.reasons.slice(0, 3).join(' · ')} />
            )}
            <div class="lg2-auto__stratnote">
              <Icon name="beschattung" size={15} />
              {t('Entscheidung entspricht der aktuellen Strategie', 'Decision matches the current strategy')}
              {mode !== undefined ? ` „${mode.label}"` : ''}
            </div>
          </Fragment>
        ) : (
          <p class="lg2-auto__empty">{t('Aktuell ist keine Aktion geplant — es besteht kein Handlungsbedarf.', 'No action planned right now — nothing to do.')}</p>
        )}
      </div>

      {/* Today's strategy settings — every value derived from live config /
          snapshot (task 11.15); icons chosen to match each setting. */}
      <div class="lg2-card lg2-auto__col">
        <h3 class="lg2-card__title">{t('Heutige Strategie-Einstellungen', "Today's strategy settings")}</h3>
        <StrategySettings snap={snap} config={config.value} mode={mode} />
      </div>
      </div>

      {expertMode.value && (
        <Fragment>
          <div class="lg2-card lg2-auto__expert">
            <h3 class="lg2-card__title">{t('Experten-Details', 'Expert details')}</h3>
            <div class="lg2-auto__expmetrics">
              <div><span>{t('Geplante Aktionen', 'Planned actions')}</span><b>{future.length}</b></div>
              <div><span>{t('Räume', 'Rooms')}</span><b>{rooms.length}</b></div>
              <div><span>{t('Blockaden', 'Blocks')}</span><b>{blocks.length}</b></div>
              <div><span>{t('Modus-ID', 'Mode id')}</span><b>{mode?.id ?? '–'}</b></div>
              <div><span>{t('Prognose-Spitze', 'Peak forecast')}</span><b>{snap.indoorPeakTempC === null || snap.indoorPeakTempC === undefined ? '–' : `${fmtNum(Math.round((snap.indoorPeakTempC) * 10) / 10, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}°`}</b></div>
              <div><span>{t('Pausiert', 'Paused')}</span><b>{snap.userIntent?.paused === true ? t('ja', 'yes') : t('nein', 'no')}</b></div>
              <div><span>{t('Pause bis', 'Pause until')}</span><b>{snap.userIntent?.pauseUntil != null ? hms(snap.userIntent.pauseUntil) : '–'}</b></div>
              <div><span>{t('Urlaub', 'Vacation')}</span><b>{snap.userIntent?.vacation === true ? t('ja', 'yes') : t('nein', 'no')}</b></div>
              <div><span>{t('Sturm-Hold bis', 'Storm hold until')}</span><b>{snap.storm?.holdUntil != null ? hms(snap.storm.holdUntil) : '–'}</b></div>
            </div>
            {mode !== undefined && mode.reasons.length > 0 && (
              <ul class="lg2-auto__reasonlist lg2-auto__expreasons">{mode.reasons.map((r, i) => <li key={i}><Icon name="beschattung" size={14} /> {r}</li>)}</ul>
            )}
            <div class="lg2-auto__exprooms">
              {rooms.map((r) => (
                <span key={r.id}><b>{r.name}</b> {r.indoorTempC === null ? '–' : `${Math.round(r.indoorTempC * 10) / 10}°`} · {Math.round(r.shutterPercent)} %{r.windowOpen === true ? ' · ' + t('offen', 'open') : ''}</span>
              ))}
            </div>
          </div>

          {/* Full planned-action lifecycle (every action, all states + reason). */}
          {(snap.plannedActions ?? []).length > 0 && (
            <ExpertSection title={['Aktions-Lebenszyklus (alle Zustände)', 'Action lifecycle (all states)']} testId="lg2-expert-actionlog"
              hint={['Jede geplante Aktion mit Zielposition, Zustand und Begründung — inkl. blockierter/übersteuerter/erledigter Fahrten.',
                'Every planned action with target, state and reason — incl. blocked/overridden/completed moves.']}>
              <div class="lg2-exp-table">
                {(snap.plannedActions ?? [])
                  .slice()
                  .sort((a, b) => Date.parse(a.scheduledTs) - Date.parse(b.scheduledTs))
                  .map((a) => (
                    <div class="lg2-exp-row" key={`${a.windowId}-${a.scheduledTs}`}>
                      <span class="lg2-exp-row__time">{hms(a.scheduledTs)}</span>
                      <span class="lg2-exp-row__name">{roomForWindow(snap, a.windowId)}</span>
                      <span class="lg2-exp-row__val">→ {Math.round(a.targetPercent)} %</span>
                      <span class={`lg2-exp-row__state lg2-exp-state--${a.state}`}>{a.state}</span>
                      <span class="lg2-exp-row__reason">{a.reason}</span>
                    </div>
                  ))}
              </div>
            </ExpertSection>
          )}

          {/* Ventilation + cooling advisories (transparent heuristics). */}
          {(snap.ventilation !== undefined || snap.cooling !== undefined) && (
            <ExpertSection title={['Lüftungs- & Kühl-Empfehlungen', 'Ventilation & cooling advice']} testId="lg2-expert-advice">
              <Fragment>
                {snap.cooling !== undefined && (
                  <div class="lg2-auto__advice"><b>{snap.cooling.headline}</b><span>{snap.cooling.detail}</span>
                    {snap.cooling.pvSurplusKw != null && <em>{t('PV-Überschuss', 'PV surplus')}: {fmtNum(Math.round(snap.cooling.pvSurplusKw * 100) / 100, { maximumFractionDigits: 2 })} kW</em>}
                  </div>
                )}
                {snap.ventilation !== undefined && (
                  <Fragment>
                    <div class="lg2-auto__advice"><b>{snap.ventilation.overall.headline}</b><span>{snap.ventilation.overall.detail}</span></div>
                    <div class="lg2-auto__exprooms">
                      {snap.ventilation.rooms.map((r) => <span key={r.id}><b>{r.name}</b> {r.headline}</span>)}
                    </div>
                  </Fragment>
                )}
              </Fragment>
            </ExpertSection>
          )}

          {/* Learning / impact summary. */}
          {snap.impact !== undefined && (
            <ExpertSection title={['Lern- & Wirkungs-Kennzahlen', 'Learning & impact metrics']} testId="lg2-expert-impact">
              <ExpertMetrics>
                <M v={snap.impact.learnDays} label={['Lerntage', 'Learn days']} />
                <M v={snap.impact.calibratedRooms} label={['Kalibr. Räume', 'Calibrated rooms']} />
                <M v={snap.impact.tunedRooms} label={['Getunte Räume', 'Tuned rooms']} />
                <M v={snap.impact.comfortShareToday01 == null ? '–' : `${Math.round(snap.impact.comfortShareToday01 * 100)} %`} label={['Komfort heute', 'Comfort today']} />
                <M v={snap.impact.avgMovesPerDay == null ? '–' : fmtNum(Math.round(snap.impact.avgMovesPerDay * 10) / 10, { maximumFractionDigits: 1 })} label={['Ø Fahrten/Tag', 'Avg moves/day']} />
                <M v={snap.impact.forecastAccuracyC == null ? '–' : `± ${fmtNum(Math.round(snap.impact.forecastAccuracyC * 10) / 10, { maximumFractionDigits: 1 })} °C`} label={['Prognose-Fehler', 'Forecast error']} />
                <M v={relAge(snap.ts)} label={['Snapshot-Alter', 'Snapshot age']} />
              </ExpertMetrics>
            </ExpertSection>
          )}
        </Fragment>
      )}
    </Fragment>
  );
}

/**
 * Editable storm-protection control (v2 UI). Lets the user enable/disable the
 * storm safety force-open directly from the Automatik status column — the same
 * `config.rules.storm.enabled` flag the classic Regeln tab exposes. Disabling
 * it also asks the engine to release any stale storm hold (via the config PUT,
 * see index.ts `applyConfigChange`). Uses optimistic debounced auto-save.
 */
function StormControl(props: { snap: DashboardSnapshot; config: Config | null }): JSX.Element {
  const { snap, config } = props;
  if (config === null) return <Fragment />;
  const storm = config.rules?.storm;
  const enabled = storm?.enabled !== false;
  const holdUntil = snap.storm?.holdUntil ?? null;
  const holdActive = holdUntil !== null && Date.parse(holdUntil) > Date.now();

  const toggle = (): void => {
    const next: Config = {
      ...config,
      rules: { ...config.rules, storm: { ...config.rules.storm, enabled: !enabled } },
    };
    scheduleSave(next, 300);
  };

  return (
    <div class="lg2-auto__stormctl" data-testid="lg2-storm-control">
      <div class="lg2-auto__stormctl-row">
        <span class="lg2-auto__stormctl-icon"><Icon name="wind" size={16} /></span>
        <span class="lg2-auto__stormctl-label">
          <b>{t('Sturmschutz', 'Storm protection')}</b>
          <em>
            {enabled
              ? t(`Auffahren ab ${fmtNum(Math.round((storm?.thresholdMs ?? 13.9) * 10) / 10, { maximumFractionDigits: 1 })} m/s`,
                  `Force-open at ${fmtNum(Math.round((storm?.thresholdMs ?? 13.9) * 10) / 10, { maximumFractionDigits: 1 })} m/s`)
              : t('Deaktiviert — kein automatisches Auffahren bei Wind', 'Disabled — no automatic force-open on wind')}
          </em>
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={t('Sturmschutz umschalten', 'Toggle storm protection')}
          class={`lg2-toggle${enabled ? ' lg2-toggle--on' : ''}`}
          data-testid="lg2-storm-toggle"
          onClick={toggle}
        />
      </div>
      {holdActive && (
        <p class="lg2-auto__stormctl-hold" data-testid="lg2-storm-hold">
          {enabled
            ? t(`Sturm-Haltezeit aktiv bis ${fmtTime(holdUntil)} Uhr.`, `Storm hold active until ${fmtTime(holdUntil)}.`)
            : t('Sturm-Haltezeit wird beim Deaktivieren aufgehoben.', 'Storm hold is released when disabling.')}
        </p>
      )}
    </div>
  );
}

/**
 * Editable "gentle shading" control (v2 UI). Wires `config.rules.gentleShading`
 * so the user can ask the plugin to shade gradually (cap the summer heat-
 * protection escalation at a partial level, e.g. 50 %) instead of slamming
 * shutters fully shut on mild-warm days. A real heatwave / storm is always
 * exempt (safety wins) — see orchestrator step 3b⅞.
 */
function GentleShadeControl(props: { config: Config | null }): JSX.Element {
  const { config } = props;
  if (config === null) return <Fragment />;
  const gs = config.rules?.gentleShading;
  const enabled = gs?.enabled === true;
  const maxPct = Math.round((gs?.maxClose01 ?? 0.5) * 100);

  const patch = (next: { enabled?: boolean; maxClose01?: number }): void => {
    const nextCfg: Config = {
      ...config,
      rules: {
        ...config.rules,
        gentleShading: {
          enabled: next.enabled ?? enabled,
          maxClose01: next.maxClose01 ?? (gs?.maxClose01 ?? 0.5),
        },
      },
    };
    scheduleSave(nextCfg, 300);
  };

  return (
    <div class="lg2-auto__stormctl" data-testid="lg2-gentle-control">
      <div class="lg2-auto__stormctl-row">
        <span class="lg2-auto__stormctl-icon" style={{ color: 'var(--lg2-amber, #ff9d2e)', background: 'rgba(255,157,46,0.14)', borderColor: 'rgba(255,157,46,0.28)' }}>
          <Icon name="beschattung" size={16} />
        </span>
        <span class="lg2-auto__stormctl-label">
          <b>{t('Sanftes Beschatten', 'Gentle shading')}</b>
          <em>
            {enabled
              ? t(`Erst teilweise (max. ${maxPct} %) beschatten, dann beobachten — außer bei echter Hitzewelle.`,
                  `Shade partially first (max. ${maxPct} %), then observe — except in a real heatwave.`)
              : t('Aus — Hitzeschutz schließt bei Bedarf voll.', 'Off — heat protection closes fully when needed.')}
          </em>
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={t('Sanftes Beschatten umschalten', 'Toggle gentle shading')}
          class={`lg2-toggle${enabled ? ' lg2-toggle--on' : ''}`}
          data-testid="lg2-gentle-toggle"
          onClick={(): void => patch({ enabled: !enabled })}
        />
      </div>
      {enabled && (
        <div class="lg2-auto__stormctl-row" style={{ paddingLeft: '36px' }}>
          <span class="lg2-auto__stormctl-label"><em>{t('Obergrenze zuerst', 'Initial cap')}</em></span>
          <div class="lg2-seg" role="tablist">
            {[0.3, 0.5, 0.7].map((v) => (
              <button key={v} type="button" role="tab" aria-selected={Math.round((gs?.maxClose01 ?? 0.5) * 100) === Math.round(v * 100)}
                class={`lg2-seg__btn${Math.round((gs?.maxClose01 ?? 0.5) * 100) === Math.round(v * 100) ? ' lg2-seg__btn--on' : ''}`}
                data-testid={`lg2-gentle-cap-${Math.round(v * 100)}`}
                onClick={(): void => patch({ maxClose01: v })}>{Math.round(v * 100)}%</button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ReasonBlock(props: { icon: IconName; title: string; body: string }): JSX.Element {
  return (
    <div class="lg2-auto__reasonrow">
      <span class="lg2-auto__ricon"><Icon name={props.icon} size={17} /></span>
      <div><b>{props.title}</b><span>{props.body}</span></div>
    </div>
  );
}
function SettingRow(props: { icon: IconName; label: string; value: string; accent?: boolean }): JSX.Element {
  return (
    <button type="button" class="lg2-auto__setrow" onClick={(): void => { route('/rules'); }}>
      <span class="lg2-auto__seticon"><Icon name={props.icon} size={17} /></span>
      <span class="lg2-auto__setlabel">{props.label}</span>
      <span class={`lg2-auto__setval${props.accent === true ? ' lg2-auto__setval--accent' : ''}`}>{props.value}</span>
      <Icon name="forecast" size={14} />
    </button>
  );
}

/**
 * Today's strategy settings, fully derived from live config + snapshot (task
 * 11.15). No static placeholder texts: every value reads from `config.rules`
 * (profile, comfort ceiling, night cooling, storm threshold, quiet hours) or
 * the user intent (`vacation`); honest `–` while the config is still loading.
 */
function StrategySettings(props: {
  snap: DashboardSnapshot;
  config: Config | null;
  mode: DashboardSnapshot['modeInfo'];
}): JSX.Element {
  const { snap, config, mode } = props;
  const rules = config?.rules;
  const num = (v: number | undefined, unit: string): string =>
    v === undefined || !Number.isFinite(v) ? '–' : `${fmtNum(Math.round(v * 10) / 10, { maximumFractionDigits: 1 })} ${unit}`;

  const profile = rules?.profile;
  const nc = rules?.nightCooling;
  const quiet = rules?.automation?.quietHours;
  const vacation = snap.userIntent?.vacation === true;

  const nightCoolingVal = nc === undefined
    ? '–'
    : nc.enabled
      ? t(`Aktiv · ΔT ${num(nc.deltaC, '°C')}`, `Active · ΔT ${num(nc.deltaC, '°C')}`)
      : t('Aus', 'Off');
  const quietVal = quiet === undefined
    ? '–'
    : quiet.enabled
      ? `${String(quiet.startHour).padStart(2, '0')}–${String(quiet.endHour).padStart(2, '0')} ${t('Uhr', 'h')}`
      : t('Aus', 'Off');

  return (
    <div class="lg2-auto__settings">
      <SettingRow icon="beschattung" label={t('Aktiver Modus', 'Active mode')} value={mode?.label ?? t('Normal', 'Normal')} />
      <SettingRow icon="forecast" label={t('Ziel', 'Goal')} value={mode?.goal ?? t('Komfort & Energie', 'Comfort & energy')} />
      <SettingRow icon="einstellungen" label={t('Strategie-Profil', 'Strategy profile')}
        value={profile === undefined ? '–' : t(...(PROFILE_LABEL[profile] ?? [profile, profile]))} />
      <SettingRow icon="thermometer" label={t('Komfortgrenze', 'Comfort ceiling')} value={num(rules?.comfort?.maxIndoorTempC, '°C')} />
      <SettingRow icon="klima" label={t('Nachtlüftung', 'Night ventilation')} value={nightCoolingVal} accent={nc?.enabled === true} />
      <SettingRow icon="wind" label={t('Sturmschwelle', 'Storm threshold')} value={num(rules?.storm?.thresholdMs, 'm/s')} />
      <SettingRow icon="schloss" label={t('Ruhezeiten', 'Quiet hours')} value={quietVal} />
      <SettingRow icon={vacation ? 'schloss' : 'haus'} label={t('Abwesenheit', 'Away mode')}
        value={vacation ? t('Aktiv', 'Active') : t('Inaktiv', 'Inactive')} accent={vacation} />
    </div>
  );
}

/* ---- Other tabs ----------------------------------------------------------- */

function StrategieTab(props: { snap: DashboardSnapshot }): JSX.Element {
  const mode = props.snap.modeInfo;
  return (
    <div class="lg2-card lg2-auto__panel">
      <h3 class="lg2-card__title">{t('Aktive Strategie', 'Active strategy')}: {mode?.label ?? t('Normal', 'Normal')}</h3>
      <p class="lg2-auto__panelintro">{mode?.goal ?? t('Ausgewogen zwischen Komfort und Energie.', 'Balanced between comfort and energy.')}</p>
      {mode !== undefined && mode.reasons.length > 0 && (
        <ul class="lg2-auto__reasonlist">
          {mode.reasons.map((r, i) => <li key={i}><Icon name="beschattung" size={14} /> {r}</li>)}
        </ul>
      )}
      <button type="button" class="lg2-btn" onClick={(): void => { route('/rules'); }}>{t('Regeln & Grenzwerte bearbeiten', 'Edit rules & thresholds')}</button>

      {expertMode.value && (() => {
        const weights = aggregateWeights();
        if (weights.length === 0) return null;
        return (
          <div class="lg2-auto__weights" data-testid="lg2-expert-weights">
            <h4 class="lg2-auto__weights-title">{t('Risiko-Gewichte (normalisiert, Ø über Fenster)', 'Risk weights (normalised, avg over windows)')}</h4>
            {weights.map((w) => (
              <div class="lg2-auto__weightrow" key={w.key}>
                <span class="lg2-auto__weightlbl">{t(...(FACTOR_LABEL[w.key] ?? [w.key, w.key]))}</span>
                <span class="lg2-auto__weightbar"><span class="lg2-auto__weightfill" style={{ width: `${Math.round(Math.min(1, w.weight) * 100)}%` }} /></span>
                <span class="lg2-auto__weightval">{Math.round(w.weight * 100)} %</span>
              </div>
            ))}
            <p class="lg2-settings__hint">
              {t('Das Risikomodell ist auf [0,1] normalisiert; STORM hat stets Vorrang vor allen Gewichten.',
                'The risk model is normalised to [0,1]; STORM always takes precedence over all weights.')}
            </p>
          </div>
        );
      })()}

      {expertMode.value && Object.keys(riskBreakdowns.value).length > 0 && (
        <div class="lg2-auto__riskfull" data-testid="lg2-expert-riskfull">
          <h4 class="lg2-auto__weights-title">{t('Risiko-Zerlegung je Fenster', 'Risk decomposition per window')}</h4>
          {Object.values(riskBreakdowns.value).map((b) => (
            <RiskBreakdownDetail key={b.windowId} b={b} name={props.snap.roomsDetail?.find((r) => r.windowId === b.windowId)?.name ?? b.windowId} />
          ))}
        </div>
      )}
    </div>
  );
}
function SimulationTab(): JSX.Element {
  return (
    <div class="lg2-card lg2-auto__panel lg2-auto__sim">
      <span class="lg2-auto__simicon"><Icon name="forecast" size={26} /></span>
      <h3 class="lg2-card__title">{t('Was-wäre-wenn-Simulation', 'What-if simulation')}</h3>
      <p class="lg2-auto__panelintro">{t('Spiele Strategie-Änderungen gegen die aktuelle Prognose durch, bevor du sie aktivierst — inkl. erwarteter Raumtemperatur und Energieeinsatz.', 'Play strategy changes against the current forecast before activating them — incl. expected room temperature and energy use.')}</p>
      <button type="button" class="lg2-btn" onClick={(): void => { route('/rules'); }}>{t('Simulation öffnen', 'Open simulation')}</button>
    </div>
  );
}
/** One window's decision inside a historical record. */
interface DecisionWindowEntry {
  windowId: string;
  finalTarget: number;
  moved: boolean;
  blockedBy?: string;
}
interface DecisionRecord {
  cycleId: string;
  ts: string;
  mode: string;
  windowDecisions: DecisionWindowEntry[];
}
interface DecisionRow { ts: string; cycleId: string; payload: DecisionRecord }

/**
 * Entscheidungsverlauf — the REAL historical decision log from
 * `GET /api/decisions` (ui-v2-release Runde 12, Requirement 15). Basic view
 * shows the most recent records; Expert mode adds a count selector (10–500),
 * filters (mode / window / blockedBy) and a JSON export. Honest empty and
 * error states; missing single values render as „–".
 */
function VerlaufTab(): JSX.Element {
  const expert = expertMode.value;
  const [n, setN] = useState<number>(50);
  const [rows, setRows] = useState<DecisionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [fMode, setFMode] = useState<string>('ALL');
  const [fBlocked, setFBlocked] = useState<string>('ALL');

  const reload = useCallback((): void => {
    setLoading(true);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5_000);
    void (async (): Promise<void> => {
      try {
        const res = await fetch(`/api/decisions?n=${n}`, { signal: ctrl.signal });
        if (!res.ok) { setError(`HTTP ${res.status}`); return; }
        const json = (await res.json()) as { records?: DecisionRow[] };
        setRows(json.records ?? []);
        setError(null);
      } catch (err) {
        setError(err instanceof Error && err.name === 'AbortError'
          ? t('Zeitüberschreitung beim Laden', 'Loading timed out')
          : err instanceof Error ? err.message : t('Unbekannter Fehler', 'Unknown error'));
      } finally {
        clearTimeout(timer);
        setLoading(false);
      }
    })();
  }, [n]);

  useEffect(() => { reload(); }, [reload]);

  const filtered = (rows ?? []).filter((r) => {
    if (fMode !== 'ALL' && r.payload.mode !== fMode) return false;
    if (fBlocked !== 'ALL') {
      const has = r.payload.windowDecisions.some((w) => (w.blockedBy ?? '') === fBlocked);
      if (!has) return false;
    }
    return true;
  });

  const exportJson = (): void => {
    try {
      const blob = new Blob([JSON.stringify(filtered, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `heatshield-decisions-${Date.now()}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { /* ignore */ }
  };

  const modes = [...new Set((rows ?? []).map((r) => r.payload.mode))];
  const blockeds = [...new Set((rows ?? []).flatMap((r) => r.payload.windowDecisions.map((w) => w.blockedBy).filter((b): b is string => !!b)))];

  return (
    <div class="lg2-card lg2-auto__panel" data-testid="lg2-verlauf">
      <div class="lg2-auto__lasthead">
        <h3 class="lg2-card__title">{t('Entscheidungsverlauf', 'Decision log')}</h3>
        <button type="button" class="lg2-auto__lastlink" data-testid="lg2-verlauf-reload" onClick={reload}>
          {t('Neu laden', 'Reload')} <Icon name="forecast" size={14} />
        </button>
      </div>

      {expert && (
        <div class="lg2-verlauf__filters" data-testid="lg2-verlauf-filters">
          <label class="lg2-fc__ctl"><span>{t('Anzahl', 'Count')}</span>
            <input type="number" class="lg2-cfg__select" min={10} max={500} step={10} value={n}
              data-testid="lg2-verlauf-n"
              onChange={(e): void => { const v = Number((e.currentTarget as HTMLInputElement).value); if (Number.isFinite(v)) setN(Math.min(500, Math.max(10, Math.round(v)))); }} />
          </label>
          <label class="lg2-fc__ctl"><span>{t('Modus', 'Mode')}</span>
            <select class="lg2-cfg__select" value={fMode} onChange={(e): void => setFMode((e.currentTarget as HTMLSelectElement).value)}>
              <option value="ALL">{t('Alle', 'All')}</option>
              {modes.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
          <label class="lg2-fc__ctl"><span>{t('Blockade', 'Blocked by')}</span>
            <select class="lg2-cfg__select" value={fBlocked} onChange={(e): void => setFBlocked((e.currentTarget as HTMLSelectElement).value)}>
              <option value="ALL">{t('Alle', 'All')}</option>
              {blockeds.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </label>
          <button type="button" class="lg2-btn" data-testid="lg2-verlauf-export" onClick={exportJson}>{t('JSON-Export', 'JSON export')}</button>
        </div>
      )}

      {error !== null ? (
        <div class="lg2-verlauf__state lg2-verlauf__state--err" data-testid="lg2-verlauf-error">
          <span>{t('Fehler beim Laden:', 'Error loading:')} {error}</span>
          <button type="button" class="lg2-btn" onClick={reload}>{t('Erneut laden', 'Retry')}</button>
        </div>
      ) : loading && rows === null ? (
        <p class="lg2-auto__empty">{t('Lade Verlauf…', 'Loading log…')}</p>
      ) : filtered.length === 0 ? (
        <p class="lg2-auto__empty" data-testid="lg2-verlauf-empty">
          {t('Noch keine Entscheidungen protokolliert.', 'No decisions logged yet.')}
        </p>
      ) : (
        <div class="lg2-auto__log" data-testid="lg2-verlauf-rows">
          {filtered.slice(0, expert ? 500 : 20).map((row) => {
            const rec = row.payload;
            const moved = rec.windowDecisions.filter((w) => w.moved);
            const blocked = rec.windowDecisions.filter((w) => !w.moved && w.blockedBy !== undefined);
            const detail = [
              moved.length > 0 ? t(`${moved.length} gefahren`, `${moved.length} moved`) : '',
              blocked.length > 0 ? t(`${blocked.length} blockiert`, `${blocked.length} blocked`) : '',
            ].filter(Boolean).join(' · ') || t('keine Fahrt', 'no move');
            const firstBlock = blocked[0]?.blockedBy;
            return (
              <div key={`${rec.cycleId}-${rec.ts}`} class="lg2-auto__logrow" data-testid="lg2-verlauf-row">
                <span class="lg2-auto__logtime">{fmtTime(rec.ts)}</span>
                <span class="lg2-auto__logzone">{rec.mode || '–'}</span>
                <span class="lg2-auto__logact">{detail}</span>
                <span class="lg2-auto__logreason">{firstBlock !== undefined ? `${t('blockiert', 'blocked')}: ${firstBlock}` : `${moved.length}/${rec.windowDecisions.length} ${t('Fenster', 'windows')}`}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ---- Last actions strip --------------------------------------------------- */

function LastActions(props: { snap: DashboardSnapshot; past: PlannedAction[] }): JSX.Element {
  const { snap, past } = props;
  if (past.length === 0) return <Fragment />;
  return (
    <div class="lg2-card lg2-auto__last">
      <div class="lg2-auto__lasthead">
        <h3 class="lg2-card__title">{t('Letzte Aktionen', 'Recent actions')}</h3>
        <button type="button" class="lg2-auto__lastlink" onClick={(): void => { route('/rules'); }}>{t('Alle Aktionen anzeigen', 'Show all')} <Icon name="mehr" size={14} /></button>
      </div>
      <div class="lg2-auto__lastgrid">
        {past.slice(0, 5).map((a) => (
          <div key={`${a.windowId}-${a.scheduledTs}`} class="lg2-auto__lastcard">
            <span class="lg2-auto__lasttime"><span class="lg2-dot lg2-dot--ok" /> {fmtTime(a.scheduledTs)}</span>
            <span class="lg2-auto__lastact">{roomForWindow(snap, a.windowId)} {t('auf', 'to')} {Math.round(a.targetPercent)} %</span>
            <span class="lg2-auto__lastgrund">{a.reason}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function AutoSkeleton(): JSX.Element {
  return (
    <div data-testid="lg2-auto-skeleton" aria-hidden="true" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div class="lg2-sk" style={{ height: '44px', width: '260px' }} />
      <div class="lg2-sk" style={{ height: '40px', width: '380px' }} />
      <div class="lg2-sk" style={{ height: '54vh', borderRadius: '20px' }} />
    </div>
  );
}
