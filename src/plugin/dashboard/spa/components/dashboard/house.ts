/**
 * Heat Shield — client-side house digital-twin asset
 * (predictive-control-dashboard Task 15, Requirement 9.1).
 *
 * The house twin now uses a SINGLE static, transparent render
 * (`heatshield_haus_transparent_rgba_final.png`, served as `house.png`).
 * The background no longer switches by sun position or shutter state —
 * all dynamic information lives in the SVG/HTML overlays on top of it.
 */

/** Base URL for the served house assets. */
export const HOUSE_ASSET_BASE = '/assets/house';

/** The single static house render filename. */
export const HOUSE_STATIC_ASSET = 'house.png';

/** Full URL for the static house background asset. */
export function houseAssetUrl(): string {
  return `${HOUSE_ASSET_BASE}/${HOUSE_STATIC_ASSET}`;
}
