/**
 * Manual control hook — direct shutter moves + scenes.
 *
 * Wraps `POST /api/control/shutter/:windowId`. A "scene" simply applies the
 * same level to every supplied window (sequential, best-effort). The engine
 * may re-evaluate on its next cycle (manual-override handling lives in the
 * engine); this hook is the thin transport the Live tab uses.
 */

import { signal, type Signal } from '@preact/signals';

const busySig = signal<boolean>(false);
const lastErrorSig = signal<string | null>(null);

/** Drive a single window to `level01` (0 = open, 1 = closed). */
export async function setShutter(windowId: string, level01: number): Promise<boolean> {
  busySig.value = true;
  try {
    const res = await fetch(`/api/control/shutter/${encodeURIComponent(windowId)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ level01 }),
    });
    if (!res.ok) {
      lastErrorSig.value = `HTTP ${res.status}`;
      return false;
    }
    lastErrorSig.value = null;
    return true;
  } catch (err) {
    lastErrorSig.value = err instanceof Error ? err.message : 'Netzwerkfehler';
    return false;
  } finally {
    busySig.value = false;
  }
}

/** Apply `level01` to every window id (a "scene"). */
export async function applyScene(
  windowIds: readonly string[],
  level01: number,
): Promise<void> {
  busySig.value = true;
  try {
    for (const id of windowIds) {
      await setShutter(id, level01);
    }
  } finally {
    busySig.value = false;
  }
}

/**
 * Turn a Gardena valve on or off via `POST /api/control/gardena/:deviceId`.
 * `channelIndex` is the valve's switch channel from the snapshot so the
 * backend never has to guess. Returns true on success.
 */
export async function setGardenaValve(
  deviceId: string,
  on: boolean,
  channelIndex: number,
): Promise<boolean> {
  busySig.value = true;
  try {
    const res = await fetch(
      `/api/control/gardena/${encodeURIComponent(deviceId)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ on, channelIndex }),
      },
    );
    if (!res.ok) {
      lastErrorSig.value = `HTTP ${res.status}`;
      return false;
    }
    lastErrorSig.value = null;
    return true;
  } catch (err) {
    lastErrorSig.value = err instanceof Error ? err.message : 'Netzwerkfehler';
    return false;
  } finally {
    busySig.value = false;
  }
}

export interface UseControlResult {
  busy: Signal<boolean>;
  lastError: Signal<string | null>;
  setShutter: (windowId: string, level01: number) => Promise<boolean>;
  applyScene: (windowIds: readonly string[], level01: number) => Promise<void>;
  setGardenaValve: (
    deviceId: string,
    on: boolean,
    channelIndex: number,
  ) => Promise<boolean>;
}

/** POST a simple irrigation zone action; returns true on success. */
async function irrigationAction(
  zoneId: string,
  action: 'run' | 'stop' | 'skip' | 'calibrate',
  body?: Record<string, unknown>,
): Promise<boolean> {
  busySig.value = true;
  try {
    const res = await fetch(
      `/api/irrigation/zone/${encodeURIComponent(zoneId)}/${action}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      },
    );
    if (!res.ok) {
      lastErrorSig.value = `HTTP ${res.status}`;
      return false;
    }
    lastErrorSig.value = null;
    return true;
  } catch (err) {
    lastErrorSig.value = err instanceof Error ? err.message : 'Netzwerkfehler';
    return false;
  } finally {
    busySig.value = false;
  }
}

export function runIrrigationZone(zoneId: string, seconds?: number): Promise<boolean> {
  return irrigationAction(zoneId, 'run', seconds !== undefined ? { seconds } : {});
}
export function stopIrrigationZone(zoneId: string): Promise<boolean> {
  return irrigationAction(zoneId, 'stop');
}
export function skipIrrigationZone(zoneId: string): Promise<boolean> {
  return irrigationAction(zoneId, 'skip');
}
export function calibrateIrrigationZone(
  zoneId: string,
  availablePct: number,
): Promise<boolean> {
  return irrigationAction(zoneId, 'calibrate', { availablePct });
}

/** Generic POST helper for the day-ahead plan endpoints; true on success. */
async function planFetch(path: string, body: Record<string, unknown>): Promise<boolean> {
  busySig.value = true;
  try {
    const res = await fetch(`/api/irrigation/plan${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      lastErrorSig.value = `HTTP ${res.status}`;
      return false;
    }
    lastErrorSig.value = null;
    return true;
  } catch (err) {
    lastErrorSig.value = err instanceof Error ? err.message : 'Netzwerkfehler';
    return false;
  } finally {
    busySig.value = false;
  }
}

export function updatePlanEntry(
  entryId: string,
  patch: { startTs?: string; durationMin?: number; enabled?: boolean },
): Promise<boolean> {
  return planFetch(`/${encodeURIComponent(entryId)}/update`, patch);
}
export function deletePlanEntry(entryId: string): Promise<boolean> {
  return planFetch(`/${encodeURIComponent(entryId)}/delete`, {});
}
export function addPlanEntry(
  zoneId: string,
  startTs: string,
  durationMin: number,
): Promise<boolean> {
  return planFetch('', { zoneId, startTs, durationMin });
}
/** Reset the day-ahead plan to the pure AUTO strategy (re-seed from forecast). */
export function resetPlanToAuto(): Promise<boolean> {
  return planFetch('/auto', {});
}

export function useControl(): UseControlResult {
  return {
    busy: busySig,
    lastError: lastErrorSig,
    setShutter,
    applyScene,
    setGardenaValve,
  };
}
