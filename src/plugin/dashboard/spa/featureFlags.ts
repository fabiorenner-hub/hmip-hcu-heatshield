/**
 * Heat Shield dashboard — client-side feature flags (HeatShield Unified
 * Programme, Gate 2 slice G2.1).
 *
 * Mirrors the programme `config/feature-flags.json` keys relevant to the SPA.
 * Flags default **OFF** and are overridable per-device via localStorage (dev
 * toggling) — the plugin stays LOCAL with no telemetry. While a flag is off the
 * shipped shell renders exactly as before, so new shells can land dark behind
 * these flags through Gate 2 (DEC: flags default off until Gate 3 parity).
 */

export type FeatureFlag = 'premiumUiV2' | 'mobileUiV2' | 'buildingStudioV2';

const DEFAULTS: Record<FeatureFlag, boolean> = {
  premiumUiV2: false,
  mobileUiV2: false,
  buildingStudioV2: false,
};

const STORAGE_PREFIX = 'heatshield.flag.';

/** Read a flag (localStorage override → default). Never throws. */
export function getFlag(flag: FeatureFlag): boolean {
  try {
    const raw = window.localStorage.getItem(`${STORAGE_PREFIX}${flag}`);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
  } catch {
    /* ignore — fall through to default */
  }
  return DEFAULTS[flag];
}

/** Set or clear a per-device flag override (`null` clears → back to default). */
export function setFlag(flag: FeatureFlag, value: boolean | null): void {
  try {
    const key = `${STORAGE_PREFIX}${flag}`;
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value ? 'true' : 'false');
  } catch {
    /* ignore */
  }
}
