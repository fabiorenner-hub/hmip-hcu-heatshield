/**
 * Heat Shield — "Logs & Debug" tab (Einstellungen).
 *
 * One place for everything a power user / bug report needs:
 *   - a live Connect-API log viewer (level filter, auto-refresh, copy, download),
 *   - a generic endpoint runner for every diagnostic API (state, config,
 *     diagnostics, decisions, trends, metrics, source discovery, GARDENA test,
 *     dry probe) with a pretty JSON viewer + copy + download,
 *   - a compact system/build info panel.
 *
 * Everything is read-only diagnostics (the probe runs a synthetic cycle that
 * does NOT actuate any shutter — steering rule).
 */

import { h, type JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

import { APP_VERSION } from '../version.js';
import { GITHUB_URL } from '../hooks/useUpdateCheck.js';
import { useDiscovery } from '../hooks/useDiscovery.js';

interface RoutableProps {
  path?: string;
}

interface ConnectEntry {
  ts?: string;
  level?: string;
  msg?: string;
  ctx?: unknown;
}

type Method = 'GET' | 'POST';

interface EndpointDef {
  label: string;
  method: Method;
  path: string;
  body?: string;
}

const ENDPOINTS: EndpointDef[] = [
  { label: 'State', method: 'GET', path: '/api/state' },
  { label: 'Config', method: 'GET', path: '/api/config' },
  { label: 'Diagnostics', method: 'GET', path: '/api/diagnostics' },
  { label: 'Metrics', method: 'GET', path: '/api/metrics' },
  { label: 'Entscheidungen (200)', method: 'GET', path: '/api/decisions?n=200' },
  { label: 'Trends (24 h)', method: 'GET', path: '/api/trends?seconds=86400' },
  { label: 'Connect-Log (1000)', method: 'GET', path: '/api/connect/log?n=1000' },
  { label: 'Quellen entdecken', method: 'POST', path: '/api/sources/discover', body: '{}' },
  { label: 'GARDENA testen', method: 'POST', path: '/api/gardena/test', body: '{}' },
  { label: 'Probelauf (synthetisch)', method: 'POST', path: '/api/probe/run', body: '{}' },
];

const LEVELS = ['all', 'info', 'warn', 'error'] as const;

function download(name: string, text: string): void {
  try {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch {
    /* ignore */
  }
}

function ConnectLog(): JSX.Element {
  const [entries, setEntries] = useState<ConnectEntry[]>([]);
  const [level, setLevel] = useState<string>('all');
  const [live, setLive] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = async (): Promise<void> => {
    try {
      const res = await fetch('/api/connect/log?n=1000', { headers: { Accept: 'application/json' } });
      if (res.status === 503) {
        setError('Connect-Protokoll noch nicht verbunden.');
        return;
      }
      if (!res.ok) {
        setError(`HTTP ${res.status}`);
        return;
      }
      const j = (await res.json()) as { entries?: ConnectEntry[] };
      setEntries(Array.isArray(j.entries) ? j.entries : []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Netzwerkfehler');
    }
  };

  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    if (live) {
      timer.current = setInterval(() => void load(), 5000);
    }
    return (): void => {
      if (timer.current !== null) {
        clearInterval(timer.current);
        timer.current = null;
      }
    };
  }, [live]);

  const shown = entries.filter((e) => level === 'all' || e.level === level);
  const asText = shown
    .map((e) => `${e.ts ?? ''} [${e.level ?? '?'}] ${e.msg ?? ''}${e.ctx !== undefined ? ' ' + JSON.stringify(e.ctx) : ''}`)
    .join('\n');

  return (
    <article class="module-panel__card" data-testid="logs-connect">
      <h3>Connect-Protokoll (live)</h3>
      <div class="logs-toolbar">
        <label class="logs-toolbar__field">
          <span>Level</span>
          <select value={level} onChange={(e): void => setLevel((e.currentTarget as HTMLSelectElement).value)}>
            {LEVELS.map((l) => (
              <option key={l} value={l}>{l}</option>
            ))}
          </select>
        </label>
        <button type="button" class="irr-btn irr-btn--ghost" onClick={(): void => void load()}>Neu laden</button>
        <button type="button" class={`irr-btn${live ? '' : ' irr-btn--ghost'}`} onClick={(): void => setLive((v) => !v)}>
          {live ? 'Live: an' : 'Live: aus'}
        </button>
        <button type="button" class="irr-btn irr-btn--ghost" onClick={(): void => download('connect-log.txt', asText)}>Download</button>
        <span class="logs-toolbar__count">{shown.length} Einträge</span>
      </div>
      {error !== null && <p class="module-panel__hint">{error}</p>}
      <pre class="logs-pre logs-pre--log" data-testid="logs-connect-pre">{asText || '—'}</pre>
    </article>
  );
}

function EndpointRunner(): JSX.Element {
  const [title, setTitle] = useState<string>('');
  const [out, setOut] = useState<string>('');
  const [busy, setBusy] = useState<boolean>(false);

  const run = async (ep: EndpointDef): Promise<void> => {
    setBusy(true);
    setTitle(`${ep.method} ${ep.path}`);
    setOut('Lädt…');
    try {
      const init: RequestInit =
        ep.method === 'POST'
          ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: ep.body ?? '{}' }
          : { headers: { Accept: 'application/json' } };
      const res = await fetch(ep.path, init);
      const text = await res.text();
      let pretty = text;
      try {
        pretty = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        /* not JSON — show raw */
      }
      setOut(`# HTTP ${res.status}\n${pretty}`);
    } catch (err) {
      setOut(err instanceof Error ? err.message : 'Netzwerkfehler');
    } finally {
      setBusy(false);
    }
  };

  const copy = (): void => {
    try {
      void navigator.clipboard?.writeText(out);
    } catch {
      /* ignore */
    }
  };

  return (
    <article class="module-panel__card" data-testid="logs-endpoints">
      <h3>API-Werkzeuge</h3>
      <p class="module-panel__hint">
        Roh-Antworten aller Diagnose-Endpunkte. Der Probelauf rechnet einen
        synthetischen Zyklus, ohne einen Rollladen zu fahren.
      </p>
      <div class="logs-endpoints__grid">
        {ENDPOINTS.map((ep) => (
          <button
            key={ep.path}
            type="button"
            class="irr-btn irr-btn--ghost"
            disabled={busy}
            data-testid={`logs-ep-${ep.path.replace(/[^a-z]+/gi, '-')}`}
            onClick={(): void => void run(ep)}
          >
            {ep.label}
          </button>
        ))}
      </div>
      {out !== '' && (
        <div class="logs-result">
          <div class="logs-toolbar">
            <span class="logs-toolbar__title">{title}</span>
            <button type="button" class="irr-btn irr-btn--ghost" onClick={copy}>Kopieren</button>
            <button type="button" class="irr-btn irr-btn--ghost" onClick={(): void => download('debug.json', out)}>Download</button>
          </div>
          <pre class="logs-pre" data-testid="logs-result-pre">{out}</pre>
        </div>
      )}
    </article>
  );
}

export function LogsDebugTab(_props: RoutableProps): JSX.Element {
  const discovery = useDiscovery();
  const build = discovery.pluginBuild.value;

  return (
    <section class="module-panel tab-logs-debug" data-testid="tab-logs-debug">
      <header class="module-panel__head">
        <h1>Logs &amp; Debug</h1>
        <span class="module-panel__badge">Logs · Roh-Daten · Werkzeuge</span>
      </header>
      <p class="module-panel__intro">
        Umfangreiche Diagnose: das Live-Connect-Protokoll, alle Diagnose-Endpunkte
        als Roh-JSON (mit Kopieren/Download) und Build-Infos — ideal für
        Fehlersuche und Bug-Reports.
      </p>

      <article class="module-panel__card" data-testid="logs-sysinfo">
        <h3>System &amp; Build</h3>
        <dl class="logs-sysinfo">
          <div><dt>Version</dt><dd>v{APP_VERSION}</dd></div>
          <div><dt>Build</dt><dd>{build ?? '—'}</dd></div>
          <div><dt>GitHub</dt><dd><a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">{GITHUB_URL}</a></dd></div>
          <div><dt>User-Agent</dt><dd class="logs-sysinfo__ua">{typeof navigator !== 'undefined' ? navigator.userAgent : '—'}</dd></div>
        </dl>
      </article>

      <ConnectLog />
      <EndpointRunner />
    </section>
  );
}
