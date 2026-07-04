/**
 * Heat Shield — standard / expert view mode (uebersicht-rework, Task 14).
 *
 * Progressive disclosure: the overview shows a calm decision surface by
 * default; enabling expert mode reveals additional raw values and the manual
 * controls without changing the base hierarchy. The choice is persisted
 * per-device in localStorage (the plugin stays LOCAL, no telemetry), mirroring
 * the pattern used by `i18n.ts` / `ambient.ts`.
 */

import { signal } from '@preact/signals';

const STORAGE_KEY = 'heatshield.expertMode';

function load(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

/** Reactive expert-mode flag. Default OFF (calm standard view). */
export const expertMode = signal<boolean>(load());

/** Persist + apply the expert-mode flag. */
export function setExpertMode(on: boolean): void {
  expertMode.value = on;
  try {
    localStorage.setItem(STORAGE_KEY, on ? 'true' : 'false');
  } catch {
    /* ignore */
  }
}

/** Toggle expert mode. */
export function toggleExpertMode(): void {
  setExpertMode(!expertMode.value);
}
