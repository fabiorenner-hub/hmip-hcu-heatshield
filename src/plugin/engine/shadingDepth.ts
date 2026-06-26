/**
 * Heat Shield — orientation- and heat-load-aware shading depth
 * (smart-shading-notifications Task 4.1 / 4.2 / 4.4).
 *
 * Once the shading FSM (`engine/shadingState.ts`) says a window should be
 * `shaded`, *how far* should the shutter actually close? Requirement 4 wants
 * the answer to be "only as far as needed": a partial closure that depends on
 * how squarely the sun hits the window (`incidence01`) and how strong the
 * effective heat load is (`heatLoad01`), capped by the heat-stau limit
 * (95 % façade / 100 % roof, or the per-window override).
 *
 * ## Model
 *
 *   - When the FSM state is `open`, or there is no direct sun on the window
 *     (`incidence01 = 0`), the depth collapses to `minOpenDepth01` — the
 *     shutter rides up to its open position. This is what makes
 *     "no sun ⇒ open" fall out (Requirement 4.2 / Property 3).
 *   - When `shaded` and the sun is on the window, the depth grows with both
 *     incidence and heat load:
 *
 *       g     = clamp01(incidence01 · (HEAT_BASE + (1 − HEAT_BASE)·heatLoad01))
 *       depth = minOpenDepth01 + (heatCap01 − minOpenDepth01) · g
 *
 *     `HEAT_BASE` (0.5) guarantees that a fully-incident sun already drives a
 *     meaningful closure even at zero modelled heat load, while a high heat
 *     load pushes the closure towards the cap. `depth` is therefore
 *     monotonically non-decreasing in both `incidence01` and `heatLoad01`.
 *   - `depth` never exceeds `heatCap01` (Requirement 4.6 / Property 6), and
 *     never drops below the open floor.
 *
 * ## Orientation order (Requirement 4.4 / 4.5 / Property 4)
 *
 * This module does not look at orientation directly — that lives in
 * `incidence01`, which the orchestrator derives from the sun position and the
 * window's `orientationDeg` via `engine/sun.ts`. Because a NE-facing window
 * loses the sun (incidence → 0) earlier in the day than a SW-facing one, and
 * `depth` collapses to the open floor at `incidence01 = 0`, the NE window
 * opens no later than the SW window. The orientation ordering is thus an
 * emergent property of feeding the correct incidence in.
 *
 * ## Module rules
 *
 *   - Pure: no fs, no logging, no globals. Strict TS, ESM, `.js` suffixes.
 *   - Output is always in `[min(minOpenDepth01, heatCap01), heatCap01]`.
 */

import type { ShadeState } from './shadingState.js';

/** Default open-position depth (Connect API: 0 = fully open … keep a hair closed). */
export const DEFAULT_MIN_OPEN_DEPTH01 = 0.1;

/** Floor contribution of incidence before heat load amplifies it. */
const HEAT_BASE = 0.5;

export interface ShadingDepthInputs {
  /** FSM state from `engine/shadingState.ts`. */
  shadeState: ShadeState;
  /** Sun incidence on the window in `[0, 1]` (0 = no direct sun). */
  incidence01: number;
  /** Effective heat load in `[0, 1]` from `effectiveHeatLoad01`. */
  heatLoad01: number;
  /** Heat-stau cap in `[0, 1]` (95 % façade / 100 % roof / per-window override). */
  heatCap01: number;
  /** Depth used when the window is open / no sun. Defaults to 0.1. */
  minOpenDepth01?: number;
}

function clamp01(x: number): number {
  if (Number.isNaN(x)) {
    return 0;
  }
  if (x <= 0) {
    return 0;
  }
  if (x >= 1) {
    return 1;
  }
  return x;
}

/**
 * Compute the target shutter depth for a window in `[0, 1]`
 * (1 = fully closed). See the module header for the model and the
 * monotonicity / cap guarantees.
 */
export function shadingDepth01(inputs: ShadingDepthInputs): number {
  const incidence01 = clamp01(inputs.incidence01);
  const heatLoad01 = clamp01(inputs.heatLoad01);
  const heatCap01 = clamp01(inputs.heatCap01);
  const minOpenRaw = inputs.minOpenDepth01 ?? DEFAULT_MIN_OPEN_DEPTH01;
  // The open floor can never exceed the cap (a tight cap wins).
  const minOpen = Math.min(clamp01(minOpenRaw), heatCap01);

  // Open, or no direct sun → ride up to the open floor.
  if (inputs.shadeState === 'open' || incidence01 <= 0) {
    return minOpen;
  }

  const g = clamp01(incidence01 * (HEAT_BASE + (1 - HEAT_BASE) * heatLoad01));
  const depth = minOpen + (heatCap01 - minOpen) * g;
  // Defensive clamp against IEEE-754 drift; depth is already in band.
  if (depth < minOpen) {
    return minOpen;
  }
  if (depth > heatCap01) {
    return heatCap01;
  }
  return depth;
}
