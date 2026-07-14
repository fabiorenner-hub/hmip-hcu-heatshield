/**
 * Heat Shield SPA — OTA status hook.
 *
 * Fetches `GET /api/ota/status` on mount and exposes `check()` / `install()`
 * actions that POST to the OTA endpoints. Best-effort: a 503 (boot not wired)
 * or network error leaves `status = null` and the UI hides the OTA controls.
 *
 * B6 — tracked install: `installTracked()` drives a progress state machine
 * (installing → restarting → done) with a live log and auto-reloads the page
 * once the freshly installed payload is active. Fetch failures during the
 * restart window are treated as "still restarting", not errors — that was the
 * confusing part before ("failed to fetch" after pressing update).
 */

import { useEffect, useRef, useState } from 'preact/hooks';

export interface OtaStatus {
  coreVersion: string;
  otaVersion: string;
  otaActive: boolean;
  latest: string | null;
  updateAvailable: boolean;
  requiresCore: boolean;
  mode: 'manual' | 'auto';
  /** Active update channel (stable = releases/latest, experimental = prerelease). */
  channel?: 'stable' | 'experimental';
  /** True when the resolved release is a GitHub prerelease (experimental build). */
  experimentalBuild?: boolean;
  checkIntervalHours: number;
  lastCheck: string | null;
  lastResult: string | null;
}

/** Install progress phases surfaced by {@link useOtaStatus.installTracked}. */
export type OtaPhase = 'idle' | 'installing' | 'restarting' | 'done' | 'error';

export interface UseOtaStatus {
  status: OtaStatus | null;
  busy: boolean;
  error: string | null;
  /** Tracked-install progress phase (idle unless an install is in flight). */
  phase: OtaPhase;
  /** Human-readable progress log for the install stepper. */
  progressLog: string[];
  check: () => Promise<void>;
  install: () => Promise<void>;
  /** Start a tracked install: progress phases + live log + auto-reload. */
  installTracked: () => void;
}

async function getJson(url: string, method: 'GET' | 'POST'): Promise<OtaStatus | null> {
  const res = await fetch(url, method === 'POST' ? { method: 'POST' } : undefined);
  if (res.status === 503) return null; // OTA not wired
  const body = (await res.json()) as OtaStatus | { status?: OtaStatus };
  if (body !== null && typeof body === 'object' && 'coreVersion' in body) return body as OtaStatus;
  if (body !== null && typeof body === 'object' && 'status' in body && body.status) return body.status;
  return null;
}

/** Fetch just the status (GET) for polling; returns null on any failure. */
async function pollStatus(): Promise<OtaStatus | null> {
  try {
    return await getJson('/api/ota/status', 'GET');
  } catch {
    return null;
  }
}

const RESTART_POLL_MS = 2000;
const RESTART_TIMEOUT_MS = 120_000;

export function useOtaStatus(): UseOtaStatus {
  const [status, setStatus] = useState<OtaStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<OtaPhase>('idle');
  const [progressLog, setProgressLog] = useState<string[]>([]);
  const runningRef = useRef<boolean>(false);
  const cancelledRef = useRef<boolean>(false);

  useEffect(() => (): void => { cancelledRef.current = true; }, []);

  const addLog = (line: string): void => {
    setProgressLog((prev) => (prev[prev.length - 1] === line ? prev : [...prev, line]));
  };

  const load = async (url: string, method: 'GET' | 'POST'): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const s = await getJson(url, method);
      if (s !== null) setStatus(s);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'error');
    } finally {
      setBusy(false);
    }
  };

  const reloadPage = (): void => {
    try {
      globalThis.location?.reload();
    } catch {
      /* jsdom / no location — ignore */
    }
  };

  const installTracked = (): void => {
    if (runningRef.current) return;
    runningRef.current = true;
    cancelledRef.current = false;
    const beforeVersion = status?.otaVersion ?? null;
    setError(null);
    setProgressLog([]);
    setPhase('installing');
    addLog('Download & Prüfung des Updates…');

    void (async (): Promise<void> => {
      // Kick off the install. The server installs synchronously and then
      // restarts the process ~0.5 s later, so this POST may either resolve
      // (install ok, restart pending) or reject (socket dropped mid-restart).
      let installEligible = true;
      try {
        const res = await fetch('/api/ota/install', { method: 'POST' });
        const body = (await res.json().catch(() => null)) as
          | { result?: { ok?: boolean; reason?: string; detail?: string } }
          | null;
        const result = body?.result;
        if (result !== undefined && result.ok === false) {
          // Not eligible / verify failed — no restart is coming.
          installEligible = false;
          setPhase('error');
          addLog(`Update nicht möglich: ${result.reason ?? 'unbekannt'}`);
        } else {
          addLog('Update übernommen – Plugin startet neu…');
        }
      } catch {
        // Socket dropped because the process is already restarting — expected.
        addLog('Plugin startet neu…');
      }
      if (!installEligible) {
        runningRef.current = false;
        return;
      }

      setPhase('restarting');
      const started = Date.now();
      let waited = false;
      // Poll until the new payload is active (version changed) or we time out.
      const poll = async (): Promise<void> => {
        if (cancelledRef.current) { runningRef.current = false; return; }
        if (Date.now() - started > RESTART_TIMEOUT_MS) {
          setPhase('error');
          addLog('Zeitüberschreitung. Bitte die Seite manuell neu laden.');
          runningRef.current = false;
          return;
        }
        const s = await pollStatus();
        if (cancelledRef.current) { runningRef.current = false; return; }
        if (s === null) {
          // Unreachable → still restarting.
          if (!waited) { addLog('Warte auf Neustart…'); waited = true; }
          setTimeout(() => { void poll(); }, RESTART_POLL_MS);
          return;
        }
        setStatus(s);
        const changed = beforeVersion === null || s.otaVersion !== beforeVersion;
        if (changed) {
          setPhase('done');
          addLog(`Aktiv: v${s.otaVersion}. Lade Ansicht neu…`);
          runningRef.current = false;
          setTimeout(reloadPage, 1500);
          return;
        }
        // Server is back but the same version — keep waiting briefly.
        setTimeout(() => { void poll(); }, RESTART_POLL_MS);
      };
      setTimeout(() => { void poll(); }, RESTART_POLL_MS);
    })();
  };

  useEffect(() => {
    void load('/api/ota/status', 'GET');
  }, []);

  return {
    status,
    busy,
    error,
    phase,
    progressLog,
    check: () => load('/api/ota/check', 'POST'),
    install: () => load('/api/ota/install', 'POST'),
    installTracked,
  };
}
