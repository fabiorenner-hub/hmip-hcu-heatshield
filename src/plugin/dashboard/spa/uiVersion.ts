/**
 * Heat Shield — global UI version signal (ui-v2-release, Task 1).
 *
 * One canonical route set renders EITHER the stable v1 (1.20) design or the
 * "Liquid Glass V2" design; which one is chosen depends solely on this global,
 * reactive flag — not on the URL. Switching the value re-renders the current
 * route in the other design without navigating away.
 *
 * The choice is persisted per-device in localStorage (the plugin stays LOCAL,
 * no telemetry), mirroring the pattern used by `expertMode.ts` / `ambient.ts`.
 */

import { signal } from '@preact/signals';

export type UiVersion = 'v1' | 'v2';

const STORAGE_KEY = 'heatshield.uiVersion';

function load(): UiVersion {
  try {
    // Default to the v2 "Liquid Glass" design; only an explicit stored 'v1'
    // opts back into the legacy 1.20 interface.
    return localStorage.getItem(STORAGE_KEY) === 'v1' ? 'v1' : 'v2';
  } catch {
    return 'v2';
  }
}

/**
 * Reactive UI-version flag. Default `v2` (the "Liquid Glass" interface); a
 * stored `v1` opts back into the stable 1.20 design. Read `uiVersion.value`
 * anywhere the design must branch; the component re-renders when it changes.
 */
export const uiVersion = signal<UiVersion>(load());

/** Persist + apply the UI-version choice. Applies globally to the whole app. */
export function setUiVersion(v: UiVersion): void {
  uiVersion.value = v;
  try {
    localStorage.setItem(STORAGE_KEY, v);
  } catch {
    /* ignore — LOCAL, best-effort persistence */
  }
}

/**
 * Non-reactive read of the persisted UI version. Kept for callers/tests that
 * need the current value without subscribing (e.g. one-shot mount logic).
 */
export function readUiVersion(): UiVersion {
  return uiVersion.value;
}
