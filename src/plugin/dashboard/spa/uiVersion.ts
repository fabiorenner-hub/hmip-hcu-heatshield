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

/**
 * The classic v1 (1.20) interface is RETIRED. There is now exactly ONE UI — the
 * "Liquid Glass V2" design — so this flag is permanently `'v2'`. The export
 * surface (constant signal + no-op setter + reader) is kept so existing imports
 * and tests keep compiling; any previously stored `'v1'` choice is ignored.
 */
export const uiVersion = signal<UiVersion>('v2');

/** No-op: v1 is retired; the UI is always v2. Kept for import compatibility. */
export function setUiVersion(_v: UiVersion): void {
  uiVersion.value = 'v2';
}

/**
 * Non-reactive read of the persisted UI version. Kept for callers/tests that
 * need the current value without subscribing (e.g. one-shot mount logic).
 */
export function readUiVersion(): UiVersion {
  return uiVersion.value;
}
