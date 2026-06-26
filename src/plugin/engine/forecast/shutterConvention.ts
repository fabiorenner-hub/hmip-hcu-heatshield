/**
 * Heat Shield — shutter percent ↔ level01 convention
 * (predictive-control-dashboard Requirement 1).
 *
 * Single source of truth for the shutter percent convention used across the
 * engine, dashboard, config and persistence:
 *
 *   **0 % = fully OPEN, 100 % = fully CLOSED.**
 *
 * The Connect API `setShutterLevel` expects `shutterLevel ∈ [0, 1]` with
 * `1 = fully closed`. So percent and level01 map linearly with the SAME
 * orientation: `level01 = percent / 100`, `percent = level01 * 100`.
 *
 * Pure module: no I/O, no logging. Deterministic.
 */

/** Clamp a number into [lo, hi]. */
function clamp(value: number, lo: number, hi: number): number {
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

/**
 * Map a shutter percent (0 = open … 100 = closed) to the Connect API
 * `shutterLevel` range [0, 1] (0 = open … 1 = closed). Out-of-range input is
 * clamped so a caller can never command an invalid `setShutterLevel`.
 */
export function percentToLevel01(percent: number): number {
  return clamp(percent, 0, 100) / 100;
}

/**
 * Map a Connect API `shutterLevel` (0 = open … 1 = closed) back to a shutter
 * percent (0 = open … 100 = closed). Out-of-range input is clamped.
 */
export function level01ToPercent(level01: number): number {
  return clamp(level01, 0, 1) * 100;
}

/**
 * Round-trip a percent value through the persistence representation. Storing
 * and reading a shutter percent must preserve the value and the convention.
 * Persisted as the same percent number (0 = open … 100 = closed).
 */
export function persistRoundTripPercent(percent: number): number {
  return clamp(percent, 0, 100);
}
