/**
 * Diagnose tab (Tasks 13.1 / 13.2 / 13.3).
 *
 * Three sections:
 *
 *   1. Decision records   — table of last N records from
 *      `GET /api/decisions`. Slider 50..1000 (the route's max),
 *      filter by mode / windowId / blockedBy, JSON export via Blob
 *      + `URL.createObjectURL`.
 *   2. Connect log        — table from `GET /api/connect/log?n=1000`
 *      with a level filter and a "Live" toggle that re-fetches
 *      every 10 s. On 503 (`connect_log_unavailable`) the section
 *      renders an empty-state hint instead of an error.
 *   3. Probelauf          — single button that calls
 *      `POST /api/probe/run`. The result (mode + per-window
 *      `finalTarget`) is rendered inline. Steering: this path goes
 *      through `runtime/probe.ts::runDryProbe` on the server side,
 *      so a click never issues `setShutterLevel`.
 *
 * Module rules:
 *   - Strict TS, ESM, `.js` import suffixes.
 *   - No new runtime deps; everything is plain `preact/hooks` +
 *     `fetch` + `URL.createObjectURL`.
 *   - Filtering is client-side over the most recent fetch slice.
 */

import { Fragment, h, type JSX } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';

import type { Mode } from '../types.js';
import { TelemetryCard } from '../components/TelemetryCard.js';
import { t } from '../i18n.js';

// ---------------------------------------------------------------------------
// Wire types — kept inline so the SPA bundle does not import server types.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Constants.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Decision records section.
// ---------------------------------------------------------------------------

interface DecisionsState {
  records: DecisionRow[];
  loading: boolean;
  error: string | null;
}

function useDecisions(n: number): DecisionsState & { reload: () => Promise<void> } {
  const [state, setState] = useState<DecisionsState>({
    records: [],
    loading: false,
    error: null,
  });

  const reload = useCallback(async (): Promise<void> => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const res = await fetch(`/api/decisions?n=${n}`);
      if (!res.ok) {
        setState({
          records: [],
          loading: false,
          error: `HTTP ${res.status}`,
        });
        return;
      }
      const json = (await res.json()) as { records: DecisionRow[] };
      setState({ records: json.records ?? [], loading: false, error: null });
    } catch (err) {
      setState({
        records: [],
        loading: false,
        error: err instanceof Error ? err.message : 'unknown error',
      });
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

function applyDecisionFilter(
  records: DecisionRow[],
  filter: DecisionFilter,
): DecisionRow[] {
  return records.filter((row) => {
    const rec = row.payload;
    if (filter.mode !== 'ALL' && rec.mode !== filter.mode) {
      return false;
    }
    const wid = filter.windowId.trim();
    if (wid.length > 0) {
      const hit = rec.windowDecisions.some((w) => w.windowId.includes(wid));
      if (!hit) {
        return false;
      }
    }
    if (filter.blockedBy === 'NONE') {
      const hasBlocked = rec.windowDecisions.some(
        (w) => w.blockedBy !== undefined,
      );
      if (hasBlocked) {
        return false;
      }
    } else if (filter.blockedBy !== 'ALL') {
      const hit = rec.windowDecisions.some(
        (w) => w.blockedBy === filter.blockedBy,
      );
      if (!hit) {
        return false;
      }
    }
    return true;
  });
}

function exportDecisionsAsJson(records: DecisionRow[]): void {
  // Steering: no new runtime deps. The browser's `Blob` +
  // `URL.createObjectURL` are sufficient; tests mock both globals.
  const json = JSON.stringify(records, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `heatshield-decisions-${new Date().toISOString()}.json`;
  document.body.appendChild(a);
  try {
    // jsdom logs "Not implemented: navigation to another Document"
    // when an anchor click would navigate. We do not actually need
    // a navigation in tests — the assertion is on Blob +
    // URL.createObjectURL — so we swallow the navigation error.
    a.click();
  } catch {
    // Swallow — the download has already started in real browsers.
  }
  document.body.removeChild(a);
  // Release the object URL on the next tick so the click handler
  // has time to start the download.
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}

interface DecisionsSectionProps {
  records: DecisionRow[];
  loading: boolean;
  error: string | null;
  n: number;
  onN: (next: number) => void;
  filter: DecisionFilter;
  onFilter: (next: DecisionFilter) => void;
  onReload: () => void;
}

function DecisionsSection(props: DecisionsSectionProps): JSX.Element {
  const filtered = useMemo(
    () => applyDecisionFilter(props.records, props.filter),
    [props.records, props.filter],
  );

  return (
    <section
      class="diag-decisions"
      data-testid="diag-decisions"
      aria-label={t('Entscheidungs-Protokoll', 'Decision records')}
    >
      <header class="diag-section__header">
        <h3>{t('Entscheidungs-Protokoll', 'Decision records')}</h3>
        <div class="diag-decisions__controls">
          <label class="diag-decisions__slider">
            <span>
              N: <strong data-testid="diag-decisions-n-value">{props.n}</strong>
            </span>
            <input
              type="range"
              min={DECISIONS_MIN}
              max={DECISIONS_MAX}
              step={50}
              value={props.n}
              data-testid="diag-decisions-n"
              onInput={(e): void => {
                const v = Number.parseInt(
                  (e.currentTarget as HTMLInputElement).value,
                  10,
                );
                if (Number.isInteger(v)) {
                  props.onN(v);
                }
              }}
            />
          </label>
          <label>
            {t('Modus', 'Mode')}:{' '}
            <select
              data-testid="diag-decisions-filter-mode"
              value={props.filter.mode}
              onChange={(e): void => {
                const v = (e.currentTarget as HTMLSelectElement).value;
                props.onFilter({
                  ...props.filter,
                  mode: (v === 'ALL' ? 'ALL' : (v as Mode)),
                });
              }}
            >
              <option value="ALL">{t('alle', 'all')}</option>
              {ALL_MODES.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('Fenster', 'Window')}:{' '}
            <input
              type="text"
              data-testid="diag-decisions-filter-window"
              placeholder="windowId"
              value={props.filter.windowId}
              onInput={(e): void => {
                const v = (e.currentTarget as HTMLInputElement).value;
                props.onFilter({ ...props.filter, windowId: v });
              }}
            />
          </label>
          <label>
            {t('Blockiert von', 'BlockedBy')}:{' '}
            <select
              data-testid="diag-decisions-filter-blocked"
              value={props.filter.blockedBy}
              onChange={(e): void => {
                const v = (e.currentTarget as HTMLSelectElement).value;
                const blocked: BlockedBy | 'ALL' | 'NONE' =
                  v === 'ALL' || v === 'NONE'
                    ? (v as 'ALL' | 'NONE')
                    : (v as BlockedBy);
                props.onFilter({ ...props.filter, blockedBy: blocked });
              }}
            >
              <option value="ALL">{t('alle', 'all')}</option>
              <option value="NONE">{t('keine (frei)', 'none (free)')}</option>
              {ALL_BLOCKED.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            data-testid="diag-decisions-reload"
            onClick={(): void => {
              props.onReload();
            }}
          >
            {t('Neu laden', 'Reload')}
          </button>
          <button
            type="button"
            data-testid="diag-decisions-export"
            disabled={filtered.length === 0}
            onClick={(): void => {
              exportDecisionsAsJson(filtered);
            }}
          >
            {t('JSON-Export', 'JSON export')}
          </button>
        </div>
      </header>

      {props.error !== null && (
        <p class="diag-error" data-testid="diag-decisions-error">
          {props.error}
        </p>
      )}
      {props.loading && (
        <p class="diag-hint" data-testid="diag-decisions-loading">
          {t('Wird geladen…', 'Loading…')}
        </p>
      )}

      <table class="diag-table" data-testid="diag-decisions-table">
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
              <tr
                key={row.payload.cycleId}
                data-testid={`diag-decisions-row-${row.payload.cycleId}`}
                data-mode={row.payload.mode}
              >
                <td>{row.ts}</td>
                <td>{row.payload.cycleId}</td>
                <td>{row.payload.mode}</td>
                <td>{row.payload.windowDecisions.length}</td>
                <td>{blocked}</td>
              </tr>
            );
          })}
          {filtered.length === 0 && !props.loading && (
            <tr>
              <td colSpan={5}>
                <em data-testid="diag-decisions-empty">
                  {t('Keine Einträge für den aktuellen Filter.', 'No entries for the current filter.')}
                </em>
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <p class="diag-decisions__footer">
        {t('Zeige', 'Showing')}{' '}
        <strong data-testid="diag-decisions-count">{filtered.length}</strong> {t('von', 'of')}{' '}
        {props.records.length} {t('geladen.', 'loaded.')}
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Connect log section.
// ---------------------------------------------------------------------------

interface ConnectLogState {
  entries: ConnectLogEntry[];
  loading: boolean;
  error: string | null;
  unavailable: boolean;
}

function useConnectLog(n: number): ConnectLogState & {
  reload: () => Promise<void>;
} {
  const [state, setState] = useState<ConnectLogState>({
    entries: [],
    loading: false,
    error: null,
    unavailable: false,
  });

  const reload = useCallback(async (): Promise<void> => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const res = await fetch(`/api/connect/log?n=${n}`);
      if (res.status === 503) {
        setState({
          entries: [],
          loading: false,
          error: null,
          unavailable: true,
        });
        return;
      }
      if (!res.ok) {
        setState({
          entries: [],
          loading: false,
          error: `HTTP ${res.status}`,
          unavailable: false,
        });
        return;
      }
      const json = (await res.json()) as { entries: ConnectLogEntry[] };
      setState({
        entries: json.entries ?? [],
        loading: false,
        error: null,
        unavailable: false,
      });
    } catch (err) {
      setState({
        entries: [],
        loading: false,
        error: err instanceof Error ? err.message : 'unknown error',
        unavailable: false,
      });
    }
  }, [n]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { ...state, reload };
}

interface ConnectLogSectionProps {
  state: ConnectLogState;
  levelFilter: string;
  onLevelFilter: (next: string) => void;
  live: boolean;
  onLive: (next: boolean) => void;
  onReload: () => void;
}

function ConnectLogSection(props: ConnectLogSectionProps): JSX.Element {
  const filtered = useMemo(() => {
    if (props.levelFilter === 'ALL') {
      return props.state.entries;
    }
    return props.state.entries.filter((e) => e.level === props.levelFilter);
  }, [props.state.entries, props.levelFilter]);

  return (
    <section
      class="diag-connect-log"
      data-testid="diag-connect-log"
      aria-label={t('Connect-Protokoll', 'Connect log')}
    >
      <header class="diag-section__header">
        <h3>{t('Connect-Protokoll', 'Connect log')}</h3>
        <div class="diag-connect-log__controls">
          <label>
            Level:{' '}
            <select
              data-testid="diag-connect-log-level"
              value={props.levelFilter}
              onChange={(e): void => {
                props.onLevelFilter((e.currentTarget as HTMLSelectElement).value);
              }}
            >
              <option value="ALL">{t('alle', 'all')}</option>
              {ALL_LEVELS.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              data-testid="diag-connect-log-live"
              checked={props.live}
              onChange={(e): void => {
                props.onLive((e.currentTarget as HTMLInputElement).checked);
              }}
            />{' '}
            {t('Live (10s)', 'Live (10s)')}
          </label>
          <button
            type="button"
            data-testid="diag-connect-log-reload"
            onClick={(): void => {
              props.onReload();
            }}
          >
            {t('Neu laden', 'Reload')}
          </button>
        </div>
      </header>

      {props.state.unavailable && (
        <p class="diag-hint" data-testid="diag-connect-log-unavailable">
          {t('Connect-API-Protokoll noch nicht verbunden.', 'Connect API log not connected yet.')}
        </p>
      )}
      {props.state.error !== null && (
        <p class="diag-error" data-testid="diag-connect-log-error">
          {props.state.error}
        </p>
      )}
      {props.state.loading && !props.live && (
        <p class="diag-hint" data-testid="diag-connect-log-loading">
          {t('Wird geladen…', 'Loading…')}
        </p>
      )}

      <table class="diag-table" data-testid="diag-connect-log-table">
        <thead>
          <tr>
            <th>{t('Zeit', 'Time')}</th>
            <th>{t('Level', 'Level')}</th>
            <th>{t('Nachricht', 'Message')}</th>
            <th>{t('Kontext', 'Ctx')}</th>
          </tr>
        </thead>
        <tbody data-testid="diag-connect-log-rows">
          {filtered.map((entry, i) => (
            <tr
              key={`${entry.ts}-${i}`}
              data-testid={`diag-connect-log-row-${i}`}
              data-level={entry.level}
            >
              <td>{entry.ts}</td>
              <td>{entry.level}</td>
              <td>{entry.msg}</td>
              <td>
                {entry.ctx === undefined ? '' : JSON.stringify(entry.ctx)}
              </td>
            </tr>
          ))}
          {filtered.length === 0 &&
            !props.state.loading &&
            !props.state.unavailable && (
              <tr>
                <td colSpan={4}>
                  <em data-testid="diag-connect-log-empty">
                    {t('Keine Protokolleinträge.', 'No log entries.')}
                  </em>
                </td>
              </tr>
            )}
        </tbody>
      </table>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Probelauf section.
// ---------------------------------------------------------------------------

interface ProbeSectionState {
  result: ProbeResult | null;
  loading: boolean;
  error: string | null;
  unavailable: boolean;
}

function ProbeSection(): JSX.Element {
  const [state, setState] = useState<ProbeSectionState>({
    result: null,
    loading: false,
    error: null,
    unavailable: false,
  });

  const runProbe = useCallback(async (): Promise<void> => {
    setState((s) => ({ ...s, loading: true, error: null, unavailable: false }));
    try {
      const res = await fetch('/api/probe/run', { method: 'POST' });
      if (res.status === 503) {
        setState({
          result: null,
          loading: false,
          error: null,
          unavailable: true,
        });
        return;
      }
      if (!res.ok) {
        setState({
          result: null,
          loading: false,
          error: `HTTP ${res.status}`,
          unavailable: false,
        });
        return;
      }
      const json = (await res.json()) as ProbeResult;
      setState({
        result: json,
        loading: false,
        error: null,
        unavailable: false,
      });
    } catch (err) {
      setState({
        result: null,
        loading: false,
        error: err instanceof Error ? err.message : 'unknown error',
        unavailable: false,
      });
    }
  }, []);

  return (
    <section
      class="diag-probe"
      data-testid="diag-probe"
      aria-label={t('Probelauf', 'Dry run')}
    >
      <header class="diag-section__header">
        <h3>{t('Probelauf jetzt', 'Dry run now')}</h3>
      </header>
      <p class="diag-hint">
        {t('Rechnet einen synthetischen Engine-Zyklus, ohne', 'Runs one synthetic engine cycle without dispatching')}{' '}
        <code>setShutterLevel</code> {t('an einen HMIP-Rollladen zu senden (Steering-Regel).', 'to any HMIP shutter (steering rule).')}
      </p>
      <button
        type="button"
        data-testid="diag-probe-run"
        disabled={state.loading}
        onClick={(): void => {
          void runProbe();
        }}
      >
        {state.loading ? t('Läuft…', 'Running…') : t('Probelauf starten', 'Start dry run')}
      </button>

      {state.unavailable && (
        <p class="diag-hint" data-testid="diag-probe-unavailable">
          {t('Probelauf noch nicht verfügbar.', 'Dry run not available yet.')}
        </p>
      )}
      {state.error !== null && (
        <p class="diag-error" data-testid="diag-probe-error">
          {state.error}
        </p>
      )}

      {state.result !== null && (
        <Fragment>
          <p>
            {t('Modus', 'Mode')}:{' '}
            <strong data-testid="diag-probe-mode">{state.result.mode}</strong>
            {'  '}
            <small>{t('Zyklus', 'cycle')} {state.result.cycleId}</small>
          </p>
          <ul data-testid="diag-probe-windows">
            {state.result.windowDecisions.map((w) => (
              <li
                key={w.windowId}
                data-testid={`diag-probe-window-${w.windowId}`}
              >
                <strong>{w.windowId}</strong>: finalTarget ={' '}
                {(w.finalTarget * 100).toFixed(0)}%
                {w.blockedBy !== undefined && (
                  <span> ({t('blockiert', 'blocked')}: {w.blockedBy})</span>
                )}
              </li>
            ))}
          </ul>
        </Fragment>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Top-level tab.
// ---------------------------------------------------------------------------

export function DiagnosticsTab(): JSX.Element {
  const [n, setN] = useState<number>(DECISIONS_DEFAULT);
  const [filter, setFilter] = useState<DecisionFilter>({
    mode: 'ALL',
    windowId: '',
    blockedBy: 'ALL',
  });
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
    <section class="tab-diagnostics" data-testid="tab-diagnostics">
      <h2>{t('Diagnose', 'Diagnostics')}</h2>

      <DecisionsSection
        records={decisions.records}
        loading={decisions.loading}
        error={decisions.error}
        n={n}
        onN={setN}
        filter={filter}
        onFilter={setFilter}
        onReload={(): void => {
          void decisions.reload();
        }}
      />

      <ConnectLogSection
        state={connectLog}
        levelFilter={levelFilter}
        onLevelFilter={setLevelFilter}
        live={live}
        onLive={setLive}
        onReload={(): void => {
          void connectLog.reload();
        }}
      />

      <ProbeSection />
      <TelemetryCard />
      <SettingsBackup />
    </section>
  );
}

/**
 * Backup & restore the plugin configuration. Export downloads the current
 * config JSON (with the Telegram token masked, as served by the API);
 * import sends a config file back through `PUT /api/config` (which preserves
 * the stored token when the imported one is still masked).
 */
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
      const text = await res.text();
      const blob = new Blob([text], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/gu, '-');
      a.download = `heatshield-config-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setStatus(t('Exportiert.', 'Exported.'));
    } catch (err) {
      setStatus(t(`Fehler: ${err instanceof Error ? err.message : 'unbekannt'}`, `Error: ${err instanceof Error ? err.message : 'unknown'}`));
    }
  };

  const onImport = async (file: File): Promise<void> => {
    setStatus(t('Importiere…', 'Importing…'));
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as unknown;
      const res = await fetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed),
      });
      if (res.ok) {
        setStatus(t('Importiert und gespeichert. ✅', 'Imported and saved. ✅'));
      } else {
        const body = (await res.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
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
      const text = await res.text();
      const blob = new Blob([text], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/gu, '-');
      a.download = `heatshield-backup-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setStatus(t('Voll-Backup exportiert.', 'Full backup exported.'));
    } catch (err) {
      setStatus(t(`Fehler: ${err instanceof Error ? err.message : 'unbekannt'}`, `Error: ${err instanceof Error ? err.message : 'unknown'}`));
    }
  };

  const onImportFull = async (file: File): Promise<void> => {
    setStatus(t('Stelle Voll-Backup wieder her…', 'Restoring full backup…'));
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as unknown;
      const res = await fetch('/api/backup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed),
      });
      if (res.ok) {
        setStatus(t('Backup wiederhergestellt (Config + Lerndaten). ✅', 'Backup restored (config + learning data). ✅'));
      } else {
        const body = (await res.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        setStatus(t(`Abgelehnt: ${body?.error?.message ?? `HTTP ${res.status}`}`, `Rejected: ${body?.error?.message ?? `HTTP ${res.status}`}`));
      }
    } catch (err) {
      setStatus(t(`Ungültige Datei: ${err instanceof Error ? err.message : 'unbekannt'}`, `Invalid file: ${err instanceof Error ? err.message : 'unknown'}`));
    }
  };

  return (
    <section class="diag-backup" data-testid="diag-backup">
      <h3>{t('Sichern / wiederherstellen', 'Backup / restore')}</h3>
      <div class="diag-backup__row">
        <button
          type="button"
          data-testid="config-export"
          onClick={(): void => {
            void onExport();
          }}
        >
          {t('Konfiguration exportieren', 'Export configuration')}
        </button>
        <label class="diag-backup__import">
          {t('Konfiguration importieren …', 'Import configuration …')}
          <input
            type="file"
            accept="application/json,.json"
            data-testid="config-import"
            style={{ display: 'none' }}
            onChange={(e): void => {
              const file = (e.currentTarget as HTMLInputElement).files?.[0];
              if (file !== undefined) {
                void onImport(file);
              }
            }}
          />
        </label>
      </div>
      <div class="diag-backup__row">
        <button
          type="button"
          class="diag-backup__full"
          data-testid="backup-export"
          onClick={(): void => {
            void onExportFull();
          }}
        >
          {t('Voll-Backup exportieren (inkl. Lerndaten)', 'Export full backup (incl. learning data)')}
        </button>
        <label class="diag-backup__import">
          {t('Voll-Backup wiederherstellen …', 'Restore full backup …')}
          <input
            type="file"
            accept="application/json,.json"
            data-testid="backup-import"
            style={{ display: 'none' }}
            onChange={(e): void => {
              const file = (e.currentTarget as HTMLInputElement).files?.[0];
              if (file !== undefined) {
                void onImportFull(file);
              }
            }}
          />
        </label>
        {status !== null && (
          <span class="diag-backup__status" data-testid="config-backup-status">
            {status}
          </span>
        )}
      </div>
      <p class="diag-backup__hint">
        {t(
          'Das Voll-Backup enthält Konfiguration, gelernte Beschattungs-Effekte (learning.ndjson) und die thermische Kalibrierung (calibration.ndjson) in einer Datei. Der Telegram-Bot-Token wird maskiert exportiert; beim Wiederherstellen bleibt der aktuell gespeicherte Token erhalten.',
          'The full backup contains the configuration, learned shading effects (learning.ndjson) and the thermal calibration (calibration.ndjson) in a single file. The Telegram bot token is exported masked; on restore the currently stored token is preserved.',
        )}
      </p>
    </section>
  );
}
