/**
 * Heat Shield — "Liquid Glass V2" native Diagnose page (ui-v2-release).
 *
 * A fully lg2-native rebuild of the classic `DiagnosticsTab` with the SAME
 * feature scope (no functional loss), but its own `lg2-diag*` layout built
 * only from `--lg2-*` tokens — no `--hs-*`/`--color-*`, no v1 classes.
 *
 * Sections (identical data endpoints, no backend change):
 *   1. Entscheidungs-Protokoll — `GET /api/decisions?n=` with an N slider
 *      (50..1000), client-side filters (mode / window / blockedBy) and a JSON
 *      export via `Blob` + `URL.createObjectURL`.
 *   2. Connect-Protokoll — `GET /api/connect/log?n=` with a level filter and a
 *      "Live (10s)" toggle. A `503` renders an honest empty-state hint.
 *   3. Probelauf — `POST /api/probe/run`; the result (mode + per-window
 *      `finalTarget`) renders inline. Never issues `setShutterLevel`
 *      (server-side dry probe, steering rule).
 *   4. Sichern / wiederherstellen — config export/import (`GET`/`PUT
 *      /api/config`) and a full backup (`GET`/`POST /api/backup`).
 *
 * Everything is plain `preact/hooks` + `fetch` + `URL.createObjectURL`; text is
 * bilingual and values degrade honestly to `–`.
 */

import { Fragment, h, type JSX } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';

import { t } from '../../i18n.js';
import { Icon } from '../icons.js';
import { TelemetryCard } from '../TelemetryCard.js';
import type { Mode } from '../../types.js';

interface RoutableProps {
  path?: string;
}

/* -------------------------------------------------------------------------- */
/* Wire types — inline so the SPA bundle does not import server types.        */
/* -------------------------------------------------------------------------- */

type BlockedBy =
  | 'hysteresis'
  | 'min_seconds'
  | 'manual_override'
  | 'pause'
  | 'storm'
  | 'system_error';

interface WindowDecisionEntry {
  windowId: string;
  factors: Record<string, number>;
  risk: number;
  rawTarget: number;
  afterSpecialRules: number;
  afterSafety: number;
  finalTarget: number;
  moved: boolean;
  blockedBy?: BlockedBy;
}

interface DecisionRecord {
  cycleId: string;
  ts: string;
  mode: Mode;
  windowDecisions: WindowDecisionEntry[];
}

interface DecisionRow {
  ts: string;
  cycleId: string;
  payload: DecisionRecord;
}

interface ConnectLogEntry {
  ts: string;
  level: string;
  msg: string;
  ctx?: Record<string, unknown>;
}

interface ProbeResult {
  mode: Mode;
  windowDecisions: WindowDecisionEntry[];
  ts: string;
  cycleId: string;
}

/* -------------------------------------------------------------------------- */
/* Constants.                                                                 */
/* -------------------------------------------------------------------------- */

const DECISIONS_MIN = 50;
const DECISIONS_MAX = 1000;
const DECISIONS_DEFAULT = 200;
const CONNECT_LOG_DEFAULT = 1000;
const LIVE_REFRESH_INTERVAL_MS = 10_000;

const ALL_MODES: ReadonlyArray<Mode> = [
  'NORMAL',
  'SUMMER_WATCH',
  'ACTIVE_HEAT_PROTECTION',
  'HEATWAVE',
  'NIGHT_COOLING',
  'STORM',
  'VACATION',
  'MAINTENANCE',
];

const ALL_BLOCKED: ReadonlyArray<BlockedBy> = [
  'hysteresis',
  'min_seconds',
  'manual_override',
  'pause',
  'storm',
  'system_error',
];

const ALL_LEVELS: ReadonlyArray<string> = ['info', 'warn', 'error'];

/* -------------------------------------------------------------------------- */
/* Shared helpers.                                                            */
/* -------------------------------------------------------------------------- */

/** Download a text blob without new runtime deps (tests mock the globals). */
function downloadBlob(name: string, text: string, type: string): void {
  try {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    try {
      a.click();
    } catch {
      /* jsdom navigation is swallowed — the download already started. */
    }
    a.remove();
    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 0);
  } catch {
    /* ignore */
  }
}

function stamp(): string {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/gu, '-');
}

/* -------------------------------------------------------------------------- */
/* Decision records.                                                          */
/* -------------------------------------------------------------------------- */

interface DecisionsState {
  records: DecisionRow[];
  loading: boolean;
  error: string | null;
}

function useDecisions(n: number): DecisionsState & { reload: () => Promise<void> } {
  const [state, setState] = useState<DecisionsState>({ records: [], loading: false, error: null });

  const reload = useCallback(async (): Promise<void> => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const res = await fetch(`/api/decisions?n=${n}`);
      if (!res.ok) {
        setState({ records: [], loading: false, error: `HTTP ${res.status}` });
        return;
      }
      const json = (await res.json()) as { records?: DecisionRow[] };
      setState({ records: json.records ?? [], loading: false, error: null });
    } catch (err) {
      setState({ records: [], loading: false, error: err instanceof Error ? err.message : t('Unbekannter Fehler', 'Unknown error') });
    }
  }, [n]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { ...state, reload };
}

interface DecisionFilter {
  mode: Mode | 'ALL';
  windowId: string;
  blockedBy: BlockedBy | 'ALL' | 'NONE';
}

function applyDecisionFilter(records: DecisionRow[], filter: DecisionFilter): DecisionRow[] {
  return records.filter((row) => {
    const rec = row.payload;
    if (filter.mode !== 'ALL' && rec.mode !== filter.mode) return false;
    const wid = filter.windowId.trim();
    if (wid.length > 0 && !rec.windowDecisions.some((w) => w.windowId.includes(wid))) return false;
    if (filter.blockedBy === 'NONE') {
      if (rec.windowDecisions.some((w) => w.blockedBy !== undefined)) return false;
    } else if (filter.blockedBy !== 'ALL') {
      if (!rec.windowDecisions.some((w) => w.blockedBy === filter.blockedBy)) return false;
    }
    return true;
  });
}

function DecisionsSection(props: {
  records: DecisionRow[];
  loading: boolean;
  error: string | null;
  n: number;
  onN: (next: number) => void;
  filter: DecisionFilter;
  onFilter: (next: DecisionFilter) => void;
  onReload: () => void;
}): JSX.Element {
  const filtered = useMemo(() => applyDecisionFilter(props.records, props.filter), [props.records, props.filter]);

  return (
    <section class="lg2-card lg2-diag__card" data-testid="diag-decisions" aria-label={t('Entscheidungs-Protokoll', 'Decision records')}>
      <div class="lg2-diag__cardhead">
        <h3 class="lg2-card__title"><Icon name="automation" size={18} /> {t('Entscheidungs-Protokoll', 'Decision records')}</h3>
        <span class="lg2-diag__count" data-testid="diag-decisions-count">{filtered.length} / {props.records.length}</span>
      </div>

      <div class="lg2-diag__toolbar">
        <label class="lg2-diag__ctl lg2-diag__ctl--range">
          <span>N · <strong data-testid="diag-decisions-n-value">{props.n}</strong></span>
          <input
            type="range"
            class="lg2-diag__range"
            min={DECISIONS_MIN}
            max={DECISIONS_MAX}
            step={50}
            value={props.n}
            data-testid="diag-decisions-n"
            onInput={(e): void => {
              const v = Number.parseInt((e.currentTarget as HTMLInputElement).value, 10);
              if (Number.isInteger(v)) props.onN(v);
            }}
          />
        </label>
        <label class="lg2-diag__ctl">
          <span>{t('Modus', 'Mode')}</span>
          <select
            class="lg2-diag__select"
            data-testid="diag-decisions-filter-mode"
            value={props.filter.mode}
            onChange={(e): void => {
              const v = (e.currentTarget as HTMLSelectElement).value;
              props.onFilter({ ...props.filter, mode: v === 'ALL' ? 'ALL' : (v as Mode) });
            }}
          >
            <option value="ALL">{t('alle', 'all')}</option>
            {ALL_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <label class="lg2-diag__ctl">
          <span>{t('Fenster', 'Window')}</span>
          <input
            type="text"
            class="lg2-diag__input"
            data-testid="diag-decisions-filter-window"
            placeholder="windowId"
            value={props.filter.windowId}
            onInput={(e): void => props.onFilter({ ...props.filter, windowId: (e.currentTarget as HTMLInputElement).value })}
          />
        </label>
        <label class="lg2-diag__ctl">
          <span>{t('Blockiert von', 'Blocked by')}</span>
          <select
            class="lg2-diag__select"
            data-testid="diag-decisions-filter-blocked"
            value={props.filter.blockedBy}
            onChange={(e): void => {
              const v = (e.currentTarget as HTMLSelectElement).value;
              const blocked: BlockedBy | 'ALL' | 'NONE' = v === 'ALL' || v === 'NONE' ? (v as 'ALL' | 'NONE') : (v as BlockedBy);
              props.onFilter({ ...props.filter, blockedBy: blocked });
            }}
          >
            <option value="ALL">{t('alle', 'all')}</option>
            <option value="NONE">{t('keine (frei)', 'none (free)')}</option>
            {ALL_BLOCKED.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </label>
        <div class="lg2-diag__toolbar-actions">
          <button type="button" class="lg2-diag__btn lg2-diag__btn--ghost" data-testid="diag-decisions-reload" onClick={props.onReload}>{t('Neu laden', 'Reload')}</button>
          <button type="button" class="lg2-diag__btn" data-testid="diag-decisions-export" disabled={filtered.length === 0} onClick={(): void => downloadBlob(`heatshield-decisions-${new Date().toISOString()}.json`, JSON.stringify(filtered, null, 2), 'application/json')}>{t('JSON-Export', 'JSON export')}</button>
        </div>
      </div>

      {props.error !== null && <p class="lg2-diag__error" data-testid="diag-decisions-error">{props.error}</p>}
      {props.loading && <p class="lg2-diag__hint" data-testid="diag-decisions-loading">{t('Wird geladen…', 'Loading…')}</p>}

      <div class="lg2-diag__tablewrap">
        <table class="lg2-diag__table" data-testid="diag-decisions-table">
          <thead>
            <tr>
              <th>{t('Zeit', 'Time')}</th>
              <th>{t('Zyklus', 'Cycle')}</th>
              <th>{t('Modus', 'Mode')}</th>
              <th>{t('Fenster', 'Windows')}</th>
              <th>{t('Blockiert', 'Blocked')}</th>
            </tr>
          </thead>
          <tbody data-testid="diag-decisions-rows">
            {filtered.map((row) => {
              const blocked = row.payload.windowDecisions
                .filter((w) => w.blockedBy !== undefined)
                .map((w) => `${w.windowId}:${w.blockedBy ?? ''}`)
                .join(', ');
              return (
                <tr key={row.payload.cycleId} data-testid={`diag-decisions-row-${row.payload.cycleId}`} data-mode={row.payload.mode}>
                  <td>{row.ts}</td>
                  <td>{row.payload.cycleId}</td>
                  <td><span class="lg2-diag__pill">{row.payload.mode}</span></td>
                  <td>{row.payload.windowDecisions.length}</td>
                  <td>{blocked === '' ? '–' : blocked}</td>
                </tr>
              );
            })}
            {filtered.length === 0 && !props.loading && (
              <tr>
                <td colSpan={5}><em class="lg2-diag__empty" data-testid="diag-decisions-empty">{t('Keine Einträge für den aktuellen Filter.', 'No entries for the current filter.')}</em></td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p class="lg2-diag__footer">
        {t('Zeige', 'Showing')} <strong>{filtered.length}</strong> {t('von', 'of')} {props.records.length} {t('geladen.', 'loaded.')}
      </p>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Connect log.                                                               */
/* -------------------------------------------------------------------------- */

interface ConnectLogState {
  entries: ConnectLogEntry[];
  loading: boolean;
  error: string | null;
  unavailable: boolean;
}

function useConnectLog(n: number): ConnectLogState & { reload: () => Promise<void> } {
  const [state, setState] = useState<ConnectLogState>({ entries: [], loading: false, error: null, unavailable: false });

  const reload = useCallback(async (): Promise<void> => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const res = await fetch(`/api/connect/log?n=${n}`);
      if (res.status === 503) {
        setState({ entries: [], loading: false, error: null, unavailable: true });
        return;
      }
      if (!res.ok) {
        setState({ entries: [], loading: false, error: `HTTP ${res.status}`, unavailable: false });
        return;
      }
      const json = (await res.json()) as { entries?: ConnectLogEntry[] };
      setState({ entries: json.entries ?? [], loading: false, error: null, unavailable: false });
    } catch (err) {
      setState({ entries: [], loading: false, error: err instanceof Error ? err.message : t('Unbekannter Fehler', 'Unknown error'), unavailable: false });
    }
  }, [n]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { ...state, reload };
}

function ConnectLogSection(props: {
  state: ConnectLogState;
  levelFilter: string;
  onLevelFilter: (next: string) => void;
  live: boolean;
  onLive: (next: boolean) => void;
  onReload: () => void;
}): JSX.Element {
  const filtered = useMemo(() => {
    if (props.levelFilter === 'ALL') return props.state.entries;
    return props.state.entries.filter((e) => e.level === props.levelFilter);
  }, [props.state.entries, props.levelFilter]);

  return (
    <section class="lg2-card lg2-diag__card" data-testid="diag-connect-log" aria-label={t('Connect-Protokoll', 'Connect log')}>
      <div class="lg2-diag__cardhead">
        <h3 class="lg2-card__title"><Icon name="automation" size={18} /> {t('Connect-Protokoll', 'Connect log')}</h3>
        <span class="lg2-diag__count">{filtered.length}</span>
      </div>

      <div class="lg2-diag__toolbar">
        <label class="lg2-diag__ctl">
          <span>Level</span>
          <select class="lg2-diag__select" data-testid="diag-connect-log-level" value={props.levelFilter} onChange={(e): void => props.onLevelFilter((e.currentTarget as HTMLSelectElement).value)}>
            <option value="ALL">{t('alle', 'all')}</option>
            {ALL_LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </label>
        <button
          type="button"
          role="switch"
          aria-checked={props.live}
          class={`lg2-toggle${props.live ? ' lg2-toggle--on' : ''}`}
          data-testid="diag-connect-log-live"
          aria-label={t('Live (10s)', 'Live (10s)')}
          onClick={(): void => props.onLive(!props.live)}
        />
        <span class="lg2-diag__livelabel">{props.live ? t('Live: an (10s)', 'Live: on (10s)') : t('Live: aus', 'Live: off')}</span>
        <div class="lg2-diag__toolbar-actions">
          <button type="button" class="lg2-diag__btn lg2-diag__btn--ghost" data-testid="diag-connect-log-reload" onClick={props.onReload}>{t('Neu laden', 'Reload')}</button>
        </div>
      </div>

      {props.state.unavailable && <p class="lg2-diag__hint" data-testid="diag-connect-log-unavailable">{t('Connect-API-Protokoll noch nicht verbunden.', 'Connect API log not connected yet.')}</p>}
      {props.state.error !== null && <p class="lg2-diag__error" data-testid="diag-connect-log-error">{props.state.error}</p>}
      {props.state.loading && !props.live && <p class="lg2-diag__hint" data-testid="diag-connect-log-loading">{t('Wird geladen…', 'Loading…')}</p>}

      {filtered.length === 0 && !props.state.loading && !props.state.unavailable ? (
        <p class="lg2-diag__empty" data-testid="diag-connect-log-empty">{t('Keine Protokolleinträge.', 'No log entries.')}</p>
      ) : (
        <div class="lg2-diag__log" data-testid="diag-connect-log-rows">
          {filtered.map((entry, i) => (
            <div key={`${entry.ts}-${i}`} class={`lg2-diag__logrow lg2-diag__logrow--${entry.level}`} data-testid={`diag-connect-log-row-${i}`} data-level={entry.level}>
              <span class="lg2-diag__logtime">{entry.ts}</span>
              <span class={`lg2-diag__loglevel lg2-diag__loglevel--${entry.level}`}>{entry.level}</span>
              <span class="lg2-diag__logmsg">{entry.msg}</span>
              <span class="lg2-diag__logctx">{entry.ctx === undefined ? '' : JSON.stringify(entry.ctx)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Probelauf.                                                                 */
/* -------------------------------------------------------------------------- */

interface ProbeSectionState {
  result: ProbeResult | null;
  loading: boolean;
  error: string | null;
  unavailable: boolean;
}

function ProbeSection(): JSX.Element {
  const [state, setState] = useState<ProbeSectionState>({ result: null, loading: false, error: null, unavailable: false });

  const runProbe = useCallback(async (): Promise<void> => {
    setState((s) => ({ ...s, loading: true, error: null, unavailable: false }));
    try {
      const res = await fetch('/api/probe/run', { method: 'POST' });
      if (res.status === 503) {
        setState({ result: null, loading: false, error: null, unavailable: true });
        return;
      }
      if (!res.ok) {
        setState({ result: null, loading: false, error: `HTTP ${res.status}`, unavailable: false });
        return;
      }
      const json = (await res.json()) as ProbeResult;
      setState({ result: json, loading: false, error: null, unavailable: false });
    } catch (err) {
      setState({ result: null, loading: false, error: err instanceof Error ? err.message : t('Unbekannter Fehler', 'Unknown error'), unavailable: false });
    }
  }, []);

  return (
    <section class="lg2-card lg2-diag__card" data-testid="diag-probe" aria-label={t('Probelauf', 'Dry run')}>
      <div class="lg2-diag__cardhead">
        <h3 class="lg2-card__title"><Icon name="forecast" size={18} /> {t('Probelauf jetzt', 'Dry run now')}</h3>
      </div>
      <p class="lg2-diag__hint">
        {t('Rechnet einen synthetischen Engine-Zyklus, ohne', 'Runs one synthetic engine cycle without dispatching')}{' '}
        <code class="lg2-diag__code">setShutterLevel</code> {t('an einen HMIP-Rollladen zu senden (Steering-Regel).', 'to any HMIP shutter (steering rule).')}
      </p>
      <div class="lg2-diag__toolbar-actions">
        <button type="button" class="lg2-diag__btn" data-testid="diag-probe-run" disabled={state.loading} onClick={(): void => void runProbe()}>
          {state.loading ? t('Läuft…', 'Running…') : t('Probelauf starten', 'Start dry run')}
        </button>
      </div>

      {state.unavailable && <p class="lg2-diag__hint" data-testid="diag-probe-unavailable">{t('Probelauf noch nicht verfügbar.', 'Dry run not available yet.')}</p>}
      {state.error !== null && <p class="lg2-diag__error" data-testid="diag-probe-error">{state.error}</p>}

      {state.result !== null && (
        <Fragment>
          <p class="lg2-diag__proberesult">
            {t('Modus', 'Mode')}: <strong data-testid="diag-probe-mode"><span class="lg2-diag__pill">{state.result.mode}</span></strong>{' '}
            <small class="lg2-diag__muted">{t('Zyklus', 'cycle')} {state.result.cycleId}</small>
          </p>
          <ul class="lg2-diag__probelist" data-testid="diag-probe-windows">
            {state.result.windowDecisions.map((w) => (
              <li key={w.windowId} class="lg2-diag__proberow" data-testid={`diag-probe-window-${w.windowId}`}>
                <strong>{w.windowId}</strong>
                <span class="lg2-diag__probeval">{(w.finalTarget * 100).toFixed(0)} %</span>
                {w.blockedBy !== undefined && <span class="lg2-diag__probeblock">{t('blockiert', 'blocked')}: {w.blockedBy}</span>}
              </li>
            ))}
          </ul>
        </Fragment>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Backup / restore.                                                          */
/* -------------------------------------------------------------------------- */

function SettingsBackup(): JSX.Element {
  const [status, setStatus] = useState<string | null>(null);

  const onExport = async (): Promise<void> => {
    setStatus(t('Exportiere…', 'Exporting…'));
    try {
      const res = await fetch('/api/config', { headers: { Accept: 'application/json' } });
      if (!res.ok) {
        setStatus(t(`Fehler: HTTP ${res.status}`, `Error: HTTP ${res.status}`));
        return;
      }
      downloadBlob(`heatshield-config-${stamp()}.json`, await res.text(), 'application/json');
      setStatus(t('Exportiert.', 'Exported.'));
    } catch (err) {
      setStatus(t(`Fehler: ${err instanceof Error ? err.message : 'unbekannt'}`, `Error: ${err instanceof Error ? err.message : 'unknown'}`));
    }
  };

  const onImport = async (file: File): Promise<void> => {
    setStatus(t('Importiere…', 'Importing…'));
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      const res = await fetch('/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed) });
      if (res.ok) {
        setStatus(t('Importiert und gespeichert. ✅', 'Imported and saved. ✅'));
      } else {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        setStatus(t(`Abgelehnt: ${body?.error?.message ?? `HTTP ${res.status}`}`, `Rejected: ${body?.error?.message ?? `HTTP ${res.status}`}`));
      }
    } catch (err) {
      setStatus(t(`Ungültige Datei: ${err instanceof Error ? err.message : 'unbekannt'}`, `Invalid file: ${err instanceof Error ? err.message : 'unknown'}`));
    }
  };

  const onExportFull = async (): Promise<void> => {
    setStatus(t('Erstelle Voll-Backup…', 'Creating full backup…'));
    try {
      const res = await fetch('/api/backup', { headers: { Accept: 'application/json' } });
      if (!res.ok) {
        setStatus(t(`Fehler: HTTP ${res.status}`, `Error: HTTP ${res.status}`));
        return;
      }
      downloadBlob(`heatshield-backup-${stamp()}.json`, await res.text(), 'application/json');
      setStatus(t('Voll-Backup exportiert.', 'Full backup exported.'));
    } catch (err) {
      setStatus(t(`Fehler: ${err instanceof Error ? err.message : 'unbekannt'}`, `Error: ${err instanceof Error ? err.message : 'unknown'}`));
    }
  };

  const onImportFull = async (file: File): Promise<void> => {
    setStatus(t('Stelle Voll-Backup wieder her…', 'Restoring full backup…'));
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      const res = await fetch('/api/backup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed) });
      if (res.ok) {
        setStatus(t('Backup wiederhergestellt (Config + Lerndaten). ✅', 'Backup restored (config + learning data). ✅'));
      } else {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        setStatus(t(`Abgelehnt: ${body?.error?.message ?? `HTTP ${res.status}`}`, `Rejected: ${body?.error?.message ?? `HTTP ${res.status}`}`));
      }
    } catch (err) {
      setStatus(t(`Ungültige Datei: ${err instanceof Error ? err.message : 'unbekannt'}`, `Invalid file: ${err instanceof Error ? err.message : 'unknown'}`));
    }
  };

  return (
    <section class="lg2-card lg2-diag__card" data-testid="diag-backup">
      <div class="lg2-diag__cardhead">
        <h3 class="lg2-card__title"><Icon name="einstellungen" size={18} /> {t('Sichern / wiederherstellen', 'Backup / restore')}</h3>
      </div>
      <div class="lg2-diag__backup">
        <div class="lg2-diag__backup-row">
          <button type="button" class="lg2-diag__btn" data-testid="config-export" onClick={(): void => void onExport()}>{t('Konfiguration exportieren', 'Export configuration')}</button>
          <label class="lg2-diag__btn lg2-diag__btn--ghost lg2-diag__import">
            {t('Konfiguration importieren …', 'Import configuration …')}
            <input type="file" accept="application/json,.json" data-testid="config-import" class="lg2-diag__file"
              onChange={(e): void => { const f = (e.currentTarget as HTMLInputElement).files?.[0]; if (f !== undefined) void onImport(f); }} />
          </label>
        </div>
        <div class="lg2-diag__backup-row">
          <button type="button" class="lg2-diag__btn" data-testid="backup-export" onClick={(): void => void onExportFull()}>{t('Voll-Backup exportieren (inkl. Lerndaten)', 'Export full backup (incl. learning data)')}</button>
          <label class="lg2-diag__btn lg2-diag__btn--ghost lg2-diag__import">
            {t('Voll-Backup wiederherstellen …', 'Restore full backup …')}
            <input type="file" accept="application/json,.json" data-testid="backup-import" class="lg2-diag__file"
              onChange={(e): void => { const f = (e.currentTarget as HTMLInputElement).files?.[0]; if (f !== undefined) void onImportFull(f); }} />
          </label>
        </div>
        {status !== null && <span class="lg2-diag__status" data-testid="config-backup-status">{status}</span>}
        <p class="lg2-diag__hint">
          {t(
            'Das Voll-Backup enthält Konfiguration, gelernte Beschattungs-Effekte (learning.ndjson) und die thermische Kalibrierung (calibration.ndjson) in einer Datei. Der Telegram-Bot-Token wird maskiert exportiert; beim Wiederherstellen bleibt der aktuell gespeicherte Token erhalten.',
            'The full backup contains the configuration, learned shading effects (learning.ndjson) and the thermal calibration (calibration.ndjson) in a single file. The Telegram bot token is exported masked; on restore the currently stored token is preserved.',
          )}
        </p>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Top-level page.                                                            */
/* -------------------------------------------------------------------------- */

export function LiquidGlass2Diagnostics(_props: RoutableProps): JSX.Element {
  const [n, setN] = useState<number>(DECISIONS_DEFAULT);
  const [filter, setFilter] = useState<DecisionFilter>({ mode: 'ALL', windowId: '', blockedBy: 'ALL' });
  const decisions = useDecisions(n);

  const connectLog = useConnectLog(CONNECT_LOG_DEFAULT);
  const [levelFilter, setLevelFilter] = useState<string>('ALL');
  const [live, setLive] = useState<boolean>(false);
  const liveTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!live) {
      if (liveTimerRef.current !== null) {
        clearInterval(liveTimerRef.current);
        liveTimerRef.current = null;
      }
      return;
    }
    liveTimerRef.current = setInterval(() => {
      void connectLog.reload();
    }, LIVE_REFRESH_INTERVAL_MS);
    return (): void => {
      if (liveTimerRef.current !== null) {
        clearInterval(liveTimerRef.current);
        liveTimerRef.current = null;
      }
    };
  }, [live, connectLog.reload]);

  return (
    <main class="lg2-main lg2-diag" data-testid="liquid-glass2-diagnostics">
      <header class="lg2-header">
        <div>
          <h1 class="lg2-header__title">{t('Diagnose', 'Diagnostics')}</h1>
          <p class="lg2-header__sub">{t('Entscheidungen, Connect-Protokoll, Probelauf und Backup', 'Decisions, connect log, dry run and backup')}</p>
        </div>
      </header>

      <DecisionsSection
        records={decisions.records}
        loading={decisions.loading}
        error={decisions.error}
        n={n}
        onN={setN}
        filter={filter}
        onFilter={setFilter}
        onReload={(): void => void decisions.reload()}
      />

      <ConnectLogSection
        state={connectLog}
        levelFilter={levelFilter}
        onLevelFilter={setLevelFilter}
        live={live}
        onLive={setLive}
        onReload={(): void => void connectLog.reload()}
      />

      <ProbeSection />
      <section class="lg2-card lg2-diag-telemetry"><TelemetryCard /></section>
      <SettingsBackup />
    </main>
  );
}
