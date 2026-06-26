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
import { t } from '../i18n.js';

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

function getEndpoints(): EndpointDef[] {
  return [
    { label: t('Status', 'State'), method: 'GET', path: '/api/state' },
    { label: t('Konfiguration', 'Config'), method: 'GET', path: '/api/config' },
    { label: t('Diagnose', 'Diagnostics'), method: 'GET', path: '/api/diagnostics' },
    { label: t('Metriken', 'Metrics'), method: 'GET', path: '/api/metrics' },
    { label: t('Entscheidungen (200)', 'Decisions (200)'), method: 'GET', path: '/api/decisions?n=200' },
    { label: t('Trends (24 h)', 'Trends (24 h)'), method: 'GET', path: '/api/trends?seconds=86400' },
    { label: t('Connect-Log (1000)', 'Connect log (1000)'), method: 'GET', path: '/api/connect/log?n=1000' },
    { label: t('Quellen entdecken', 'Discover sources'), method: 'POST', path: '/api/sources/discover', body: '{}' },
    { label: t('GARDENA testen', 'Test GARDENA'), method: 'POST', path: '/api/gardena/test', body: '{}' },
    { label: t('Probelauf (synthetisch)', 'Dry run (synthetic)'), method: 'POST', path: '/api/probe/run', body: '{}' },
  ];
}

const LEVELS = ['all', 'info', 'warn', 'error'] as const;

/** Endpoints pulled for the full "360°" diagnostics export. */
function fullExportEndpoints(): EndpointDef[] {
  return [
    { label: 'state', method: 'GET', path: '/api/state' },
    { label: 'config', method: 'GET', path: '/api/config' },
    { label: 'diagnostics', method: 'GET', path: '/api/diagnostics' },
    { label: 'metrics', method: 'GET', path: '/api/metrics' },
    { label: 'decisions', method: 'GET', path: '/api/decisions?n=500' },
    { label: 'trends-24h', method: 'GET', path: '/api/trends?seconds=86400' },
    { label: 'connect-log', method: 'GET', path: '/api/connect/log?n=2000' },
    { label: 'messages', method: 'GET', path: '/api/messages' },
    { label: 'notifications', method: 'GET', path: '/api/notifications' },
    { label: 'sources-discover', method: 'POST', path: '/api/sources/discover', body: '{}' },
    { label: 'gardena-test', method: 'POST', path: '/api/gardena/test', body: '{}' },
    { label: 'probe-run', method: 'POST', path: '/api/probe/run', body: '{}' },
  ];
}

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
        setError(t('Connect-Protokoll noch nicht verbunden.', 'Connect log not connected yet.'));
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
      setError(err instanceof Error ? err.message : t('Netzwerkfehler', 'Network error'));
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
      <h3>{t('Connect-Protokoll (live)', 'Connect log (live)')}</h3>
      <div class="logs-toolbar">
        <label class="logs-toolbar__field">
          <span>{t('Level', 'Level')}</span>
          <select value={level} onChange={(e): void => setLevel((e.currentTarget as HTMLSelectElement).value)}>
            {LEVELS.map((l) => (
              <option key={l} value={l}>{l}</option>
            ))}
          </select>
        </label>
        <button type="button" class="irr-btn irr-btn--ghost" onClick={(): void => void load()}>{t('Neu laden', 'Reload')}</button>
        <button type="button" class={`irr-btn${live ? '' : ' irr-btn--ghost'}`} onClick={(): void => setLive((v) => !v)}>
          {live ? t('Live: an', 'Live: on') : t('Live: aus', 'Live: off')}
        </button>
        <button type="button" class="irr-btn irr-btn--ghost" onClick={(): void => download('connect-log.txt', asText)}>{t('Download', 'Download')}</button>
        <span class="logs-toolbar__count">{t(`${shown.length} Einträge`, `${shown.length} entries`)}</span>
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
    setOut(t('Lädt…', 'Loading…'));
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
      setOut(err instanceof Error ? err.message : t('Netzwerkfehler', 'Network error'));
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
      <h3>{t('API-Werkzeuge', 'API tools')}</h3>
      <p class="module-panel__hint">
        {t(
          'Roh-Antworten aller Diagnose-Endpunkte. Der Probelauf rechnet einen synthetischen Zyklus, ohne einen Rollladen zu fahren.',
          'Raw responses of all diagnostic endpoints. The dry run computes a synthetic cycle without moving any shutter.',
        )}
      </p>
      <div class="logs-endpoints__grid">
        {getEndpoints().map((ep) => (
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
            <button type="button" class="irr-btn irr-btn--ghost" onClick={copy}>{t('Kopieren', 'Copy')}</button>
            <button type="button" class="irr-btn irr-btn--ghost" onClick={(): void => download('debug.json', out)}>{t('Download', 'Download')}</button>
          </div>
          <pre class="logs-pre" data-testid="logs-result-pre">{out}</pre>
        </div>
      )}
    </article>
  );
}

/** Collect browser/system diagnostics available client-side. */
function collectClientDiagnostics(): Record<string, unknown> {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  const scr = typeof screen !== 'undefined' ? screen : undefined;
  const perfMem = (performance as unknown as { memory?: Record<string, number> } | undefined)?.memory;
  let storageKeys: string[] = [];
  try {
    storageKeys = typeof localStorage !== 'undefined' ? Object.keys(localStorage) : [];
  } catch {
    /* ignore */
  }
  let tz = '';
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    /* ignore */
  }
  return {
    appVersion: APP_VERSION,
    timestamp: new Date().toISOString(),
    url: typeof location !== 'undefined' ? location.href : '',
    language: nav?.language,
    languages: nav?.languages,
    languagePref: (() => {
      try {
        return localStorage.getItem('heatshield.lang');
      } catch {
        return null;
      }
    })(),
    userAgent: nav?.userAgent,
    platform: (nav as unknown as { platform?: string } | undefined)?.platform,
    hardwareConcurrency: nav?.hardwareConcurrency,
    deviceMemory: (nav as unknown as { deviceMemory?: number } | undefined)?.deviceMemory,
    cookieEnabled: nav?.cookieEnabled,
    onLine: nav?.onLine,
    timezone: tz,
    timezoneOffsetMin: new Date().getTimezoneOffset(),
    screen: scr ? { width: scr.width, height: scr.height, colorDepth: scr.colorDepth } : undefined,
    viewport:
      typeof window !== 'undefined'
        ? { innerWidth: window.innerWidth, innerHeight: window.innerHeight, devicePixelRatio: window.devicePixelRatio }
        : undefined,
    performanceMemory: perfMem
      ? {
          usedJSHeapSize: perfMem['usedJSHeapSize'],
          totalJSHeapSize: perfMem['totalJSHeapSize'],
          jsHeapSizeLimit: perfMem['jsHeapSizeLimit'],
        }
      : undefined,
    localStorageKeys: storageKeys,
  };
}

/**
 * "Alle Informationen" — a 360° diagnostics export that bundles every
 * diagnostic endpoint, all live state and the browser/system diagnostics into
 * a single .txt file for bug reports.
 */
function FullExportCard(props: { build: string | null }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>('');

  const run = async (): Promise<void> => {
    setBusy(true);
    const eps = fullExportEndpoints();
    const parts: string[] = [];
    const now = new Date();
    parts.push('========================================================');
    parts.push('  HEAT SHIELD — COMPLETE DIAGNOSTICS EXPORT (360°)');
    parts.push('========================================================');
    parts.push(`generated: ${now.toISOString()}`);
    parts.push(`appVersion: v${APP_VERSION}`);
    parts.push(`pluginBuild: ${props.build ?? '—'}`);
    parts.push('');
    parts.push('======== BROWSER & SYSTEM DIAGNOSTICS ========');
    parts.push(JSON.stringify(collectClientDiagnostics(), null, 2));
    parts.push('');

    for (let i = 0; i < eps.length; i++) {
      const ep = eps[i]!;
      setStatus(t(`Sammle ${i + 1}/${eps.length}: ${ep.path}`, `Collecting ${i + 1}/${eps.length}: ${ep.path}`));
      parts.push(`======== ${ep.method} ${ep.path} ========`);
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
          /* not JSON — raw */
        }
        parts.push(`HTTP ${res.status} ${res.statusText}`);
        parts.push(pretty || '(empty)');
      } catch (err) {
        parts.push(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
      }
      parts.push('');
    }

    const stamp = now.toISOString().replace(/[:.]/g, '-');
    download(`heatshield-diagnostics-${stamp}.txt`, parts.join('\n'));
    setStatus(t('Fertig — Download gestartet.', 'Done — download started.'));
    setBusy(false);
  };

  return (
    <article class="module-panel__card logs-fullexport" data-testid="logs-fullexport">
      <h3>{t('Alle Informationen', 'All information')}</h3>
      <p class="module-panel__hint">
        {t(
          '360°-Diagnose: bündelt alle Status- und Diagnose-Endpunkte, API-Werkzeuge, das Connect-Protokoll sowie Browser- und System-Informationen in einer einzigen .txt-Datei — ideal für Bug-Reports.',
          '360° diagnostics: bundles all status & diagnostic endpoints, API tools, the Connect log plus browser and system info into a single .txt file — ideal for bug reports.',
        )}
      </p>
      <div class="logs-toolbar">
        <button
          type="button"
          class="irr-btn"
          disabled={busy}
          data-testid="logs-fullexport-btn"
          onClick={(): void => void run()}
        >
          {busy ? t('Sammle Diagnose…', 'Collecting diagnostics…') : t('⬇ Alle Informationen herunterladen', '⬇ Download all information')}
        </button>
        {status !== '' && <span class="logs-toolbar__count" data-testid="logs-fullexport-status">{status}</span>}
      </div>
    </article>
  );
}

export function LogsDebugTab(_props: RoutableProps): JSX.Element {
  const discovery = useDiscovery();
  const build = discovery.pluginBuild.value;

  return (
    <section class="module-panel tab-logs-debug" data-testid="tab-logs-debug">
      <header class="module-panel__head">
        <h1>{t('Logs & Debug', 'Logs & Debug')}</h1>
        <span class="module-panel__badge">{t('Logs · Roh-Daten · Werkzeuge', 'Logs · Raw data · Tools')}</span>
      </header>
      <p class="module-panel__intro">
        {t(
          'Umfangreiche Diagnose: das Live-Connect-Protokoll, alle Diagnose-Endpunkte als Roh-JSON (mit Kopieren/Download) und Build-Infos — ideal für Fehlersuche und Bug-Reports.',
          'Extensive diagnostics: the live Connect log, all diagnostic endpoints as raw JSON (with copy/download) and build info — ideal for troubleshooting and bug reports.',
        )}
      </p>

      <FullExportCard build={build} />

      <article class="module-panel__card" data-testid="logs-sysinfo">
        <h3>{t('System & Build', 'System & build')}</h3>
        <dl class="logs-sysinfo">
          <div><dt>{t('Version', 'Version')}</dt><dd>v{APP_VERSION}</dd></div>
          <div><dt>{t('Build', 'Build')}</dt><dd>{build ?? '—'}</dd></div>
          <div><dt>GitHub</dt><dd><a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">{GITHUB_URL}</a></dd></div>
          <div><dt>User-Agent</dt><dd class="logs-sysinfo__ua">{typeof navigator !== 'undefined' ? navigator.userAgent : '—'}</dd></div>
        </dl>
      </article>

      <ConnectLog />
      <EndpointRunner />
    </section>
  );
}
