/**
 * Heat Shield SPA — OTA status hook.
 *
 * Fetches `GET /api/ota/status` on mount and exposes `check()` / `install()`
 * actions that POST to the OTA endpoints. Best-effort: a 503 (boot not wired)
 * or network error leaves `status = null` and the UI hides the OTA controls.
 */

import { useEffect, useState } from 'preact/hooks';

export interface OtaStatus {
  coreVersion: string;
  otaVersion: string;
  otaActive: boolean;
  latest: string | null;
  updateAvailable: boolean;
  requiresCore: boolean;
  mode: 'manual' | 'auto';
  checkIntervalHours: number;
  lastCheck: string | null;
  lastResult: string | null;
}

export interface UseOtaStatus {
  status: OtaStatus | null;
  busy: boolean;
  error: string | null;
  check: () => Promise<void>;
  install: () => Promise<void>;
}

async function getJson(url: string, method: 'GET' | 'POST'): Promise<OtaStatus | null> {
  const res = await fetch(url, method === 'POST' ? { method: 'POST' } : undefined);
  if (res.status === 503) return null; // OTA not wired
  const body = (await res.json()) as OtaStatus | { status?: OtaStatus };
  if (body !== null && typeof body === 'object' && 'coreVersion' in body) return body as OtaStatus;
  if (body !== null && typeof body === 'object' && 'status' in body && body.status) return body.status;
  return null;
}

export function useOtaStatus(): UseOtaStatus {
  const [status, setStatus] = useState<OtaStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  useEffect(() => {
    void load('/api/ota/status', 'GET');
  }, []);

  return {
    status,
    busy,
    error,
    check: () => load('/api/ota/check', 'POST'),
    install: () => load('/api/ota/install', 'POST'),
  };
}
