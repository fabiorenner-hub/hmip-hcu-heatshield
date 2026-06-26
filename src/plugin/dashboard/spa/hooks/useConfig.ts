/**
 * Tiny config-fetch hook used by every config tab (Tasks 12.1–12.4).
 *
 * Encapsulates the `GET /api/config` round-trip plus a save helper
 * that posts the merged config back through `PUT /api/config`. The
 * SPA does not validate the config locally — `PUT /api/config`
 * already runs the full Zod schema and returns
 * `error.code === 'invalid_schema'` with `issues[*].path` highlights
 * on failure, which is exactly what the tabs render.
 *
 * The hook returns four signals so the consumer pages can subscribe
 * granularly:
 *
 *   - `config`     — the most recent server-side `Config`, or `null`
 *                    while the first fetch is in flight.
 *   - `loading`    — `true` while either fetch or save is pending.
 *   - `saveError`  — last error response from `PUT /api/config`,
 *                    keeping the `issues[]` array so the UI can pin
 *                    inline error markers to specific paths.
 *   - `loadError`  — last fetch error, displayed as a banner.
 *
 * The transport is intentionally `globalThis.fetch` so unit tests
 * can monkey-patch it via `globalThis.fetch = vi.fn(...)`.
 */

import { signal, type Signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';

import type { Config } from '../../../../shared/types.js';

export interface ApiIssue {
  path: (string | number)[];
  message: string;
  code?: string;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    issues?: ApiIssue[];
  };
}

export interface UseConfigResult {
  config: Signal<Config | null>;
  loading: Signal<boolean>;
  loadError: Signal<string | null>;
  saveError: Signal<ApiErrorBody | null>;
  saveOk: Signal<boolean>;
  refresh: () => Promise<void>;
  save: (next: Config) => Promise<boolean>;
  /** Debounced auto-save: optimistic + PUT after a short idle (default 700 ms). */
  scheduleSave: (next: Config, delayMs?: number) => void;
}

/**
 * Module-level signals. The hook returns the same instances on
 * every call so tabs that mount independently still see the same
 * config without prop-drilling.
 */
const configSig = signal<Config | null>(null);
const loadingSig = signal<boolean>(false);
const loadErrorSig = signal<string | null>(null);
const saveErrorSig = signal<ApiErrorBody | null>(null);
const saveOkSig = signal<boolean>(false);

let inFlightLoad: Promise<void> | null = null;
let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Debounced auto-save. Updates the local config signal immediately
 * (optimistic) and PUTs the change after a short idle window so the
 * user never has to press a Save button.
 */
export function scheduleSave(next: Config, delayMs = 700): void {
  configSig.value = next;
  if (autoSaveTimer !== null) {
    clearTimeout(autoSaveTimer);
  }
  autoSaveTimer = setTimeout(() => {
    autoSaveTimer = null;
    void saveConfig(next);
  }, delayMs);
}

export async function refreshConfig(): Promise<void> {
  if (inFlightLoad !== null) {
    return inFlightLoad;
  }
  loadingSig.value = true;
  inFlightLoad = (async (): Promise<void> => {
    try {
      const res = await fetch('/api/config', {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const json = (await res.json()) as Config;
      configSig.value = json;
      loadErrorSig.value = null;
    } catch (err) {
      loadErrorSig.value =
        err instanceof Error ? err.message : 'unknown error fetching /api/config';
    } finally {
      loadingSig.value = false;
      inFlightLoad = null;
    }
  })();
  return inFlightLoad;
}

export async function saveConfig(next: Config): Promise<boolean> {
  loadingSig.value = true;
  saveOkSig.value = false;
  try {
    const res = await fetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next),
    });
    if (res.ok) {
      configSig.value = next;
      saveErrorSig.value = null;
      saveOkSig.value = true;
      return true;
    }
    const body = (await res.json().catch(() => null)) as ApiErrorBody | null;
    if (body !== null && typeof body === 'object' && 'error' in body) {
      saveErrorSig.value = body;
    } else {
      saveErrorSig.value = {
        error: { code: 'unknown', message: `HTTP ${res.status}` },
      };
    }
    return false;
  } catch (err) {
    saveErrorSig.value = {
      error: {
        code: 'network',
        message: err instanceof Error ? err.message : 'network error',
      },
    };
    return false;
  } finally {
    loadingSig.value = false;
  }
}

export function useConfig(): UseConfigResult {
  useEffect(() => {
    if (configSig.value === null) {
      void refreshConfig();
    }
  }, []);
  return {
    config: configSig,
    loading: loadingSig,
    loadError: loadErrorSig,
    saveError: saveErrorSig,
    saveOk: saveOkSig,
    refresh: refreshConfig,
    save: saveConfig,
    scheduleSave,
  };
}

/** Test-only helper: reset the module-level signals between cases. */
export function __resetConfigStateForTests(): void {
  configSig.value = null;
  loadingSig.value = false;
  loadErrorSig.value = null;
  saveErrorSig.value = null;
  saveOkSig.value = false;
  inFlightLoad = null;
  if (autoSaveTimer !== null) {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
  }
}
