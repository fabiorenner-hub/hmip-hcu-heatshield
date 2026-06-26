/**
 * Heat Shield — irrigation soil & plant model (pure, testable).
 *
 * Physical constants and helpers for the FAO-56 soil-water-balance approach
 * used by the irrigation engine. No I/O, no Connect artifacts, no logging.
 *
 * Core quantities (all depths in mm of water unless noted):
 *
 *   - Field capacity (FC) and permanent wilting point (PWP) are expressed as
 *     volumetric water fractions (m³/m³). Total available water in the root
 *     zone:  TAW = (FC − PWP) × rootDepth(mm).
 *   - Readily available water:  RAW = MAD × TAW  (MAD = management allowed
 *     depletion fraction). Irrigation triggers when depletion ≥ RAW.
 *   - Crop evapotranspiration:  ETc = ET0 × Kc.
 *
 * The numbers are pragmatic horticultural defaults (not lab values); the
 * learning loop calibrates the effective behaviour per zone over time.
 */

export type SoilType = 'sand' | 'loam' | 'clay' | 'silt';
export type PlantType =
  | 'lawn'
  | 'bed'
  | 'hedge'
  | 'vegetable'
  | 'pot'
  | 'tree';
export type Exposure = 'full_sun' | 'partial' | 'shade';
export type EmitterType = 'drip' | 'sprinkler' | 'rotor' | 'soaker';
export type Slope = 'flat' | 'moderate' | 'steep';

/** Volumetric water properties + max infiltration before runoff (mm/h). */
export interface SoilProps {
  /** Field capacity (volumetric fraction). */
  readonly fc: number;
  /** Permanent wilting point (volumetric fraction). */
  readonly pwp: number;
  /** Basic infiltration rate (mm/h) — caps sprinkler application. */
  readonly infiltrationMmH: number;
}

const SOIL_TABLE: Record<SoilType, SoilProps> = {
  sand: { fc: 0.12, pwp: 0.05, infiltrationMmH: 30 },
  loam: { fc: 0.28, pwp: 0.12, infiltrationMmH: 15 },
  silt: { fc: 0.32, pwp: 0.14, infiltrationMmH: 10 },
  clay: { fc: 0.4, pwp: 0.22, infiltrationMmH: 5 },
};

/** Base crop coefficient (Kc) per plant type (mid-season, illustrative). */
const KC_TABLE: Record<PlantType, number> = {
  lawn: 0.85,
  bed: 0.9,
  hedge: 0.8,
  vegetable: 1.05,
  pot: 1.1,
  tree: 0.75,
};

/** Default rooting depth (cm) per plant type. */
const ROOT_DEPTH_CM: Record<PlantType, number> = {
  lawn: 15,
  bed: 30,
  hedge: 50,
  vegetable: 40,
  pot: 20,
  tree: 80,
};

/** Default management-allowed-depletion fraction per plant type. */
const MAD_TABLE: Record<PlantType, number> = {
  lawn: 0.5,
  bed: 0.45,
  hedge: 0.5,
  vegetable: 0.4,
  pot: 0.3,
  tree: 0.6,
};

/** Default emitter output (mm/h) per emitter type. */
const EMITTER_RATE_MMH: Record<EmitterType, number> = {
  drip: 8,
  sprinkler: 12,
  rotor: 10,
  soaker: 6,
};

/** Exposure multiplier on ETc (more sun → more demand). */
const EXPOSURE_FACTOR: Record<Exposure, number> = {
  full_sun: 1.1,
  partial: 0.9,
  shade: 0.7,
};

/** Max single application (mm) before runoff, given slope + soil. */
const SLOPE_RUNOFF_FACTOR: Record<Slope, number> = {
  flat: 1,
  moderate: 0.7,
  steep: 0.45,
};

export function soilProps(soil: SoilType): SoilProps {
  return SOIL_TABLE[soil];
}

export function defaultKc(plant: PlantType): number {
  return KC_TABLE[plant];
}

export function defaultRootDepthCm(plant: PlantType): number {
  return ROOT_DEPTH_CM[plant];
}

export function defaultMad(plant: PlantType): number {
  return MAD_TABLE[plant];
}

export function defaultEmitterRate(emitter: EmitterType): number {
  return EMITTER_RATE_MMH[emitter];
}

export function exposureFactor(exp: Exposure): number {
  return EXPOSURE_FACTOR[exp];
}

/**
 * Total available water in the root zone (mm).
 * TAW = (FC − PWP) × rootDepthMm.
 */
export function totalAvailableWaterMm(soil: SoilType, rootDepthCm: number): number {
  const p = soilProps(soil);
  const rootMm = Math.max(0, rootDepthCm) * 10;
  return Math.max(0, (p.fc - p.pwp) * rootMm);
}

/** Readily available water (mm) = MAD × TAW. */
export function readilyAvailableWaterMm(
  soil: SoilType,
  rootDepthCm: number,
  mad: number,
): number {
  return totalAvailableWaterMm(soil, rootDepthCm) * clamp01(mad);
}

/**
 * Convert a depth of water to apply (mm) into a valve runtime (seconds),
 * given the emitter precipitation rate (mm/h). Returns 0 for non-positive
 * input.
 */
export function depthMmToSeconds(depthMm: number, precipRateMmH: number): number {
  if (depthMm <= 0 || precipRateMmH <= 0) return 0;
  return Math.round((depthMm / precipRateMmH) * 3600);
}

/** Inverse of {@link depthMmToSeconds}: seconds of runtime → applied depth (mm). */
export function secondsToDepthMm(seconds: number, precipRateMmH: number): number {
  if (seconds <= 0 || precipRateMmH <= 0) return 0;
  return (seconds / 3600) * precipRateMmH;
}

/**
 * Maximum depth (mm) that can be applied in a single pass before runoff,
 * derived from soil infiltration and slope. Used to split a large dose into
 * cycle-and-soak passes on clay / slopes.
 */
export function maxSingleApplicationMm(soil: SoilType, slope: Slope): number {
  const p = soilProps(soil);
  // ~20 min of infiltration as a single soak, scaled by slope runoff factor.
  return Math.max(2, (p.infiltrationMmH / 3) * SLOPE_RUNOFF_FACTOR[slope]);
}

/**
 * Split a target depth (mm) into N cycle-and-soak passes so no single pass
 * exceeds {@link maxSingleApplicationMm}. Returns at least 1 pass.
 */
export function cycleSoakPasses(
  targetMm: number,
  soil: SoilType,
  slope: Slope,
): number {
  if (targetMm <= 0) return 0;
  const maxPass = maxSingleApplicationMm(soil, slope);
  return Math.max(1, Math.ceil(targetMm / maxPass));
}

/**
 * Map a Gardena volumetric soil-moisture reading (% as reported, 0..100) to a
 * depletion estimate (mm) relative to field capacity, for closed-loop
 * correction. `moisturePct` is the sensor's value; we treat 100 % as field
 * capacity and 0 % as the wilting point for that soil. Clamped to [0, TAW].
 */
export function moisturePctToDepletionMm(
  moisturePct: number,
  soil: SoilType,
  rootDepthCm: number,
): number {
  const taw = totalAvailableWaterMm(soil, rootDepthCm);
  const frac = clamp01(moisturePct / 100);
  return clamp(taw * (1 - frac), 0, taw);
}

export function clamp01(x: number): number {
  return clamp(x, 0, 1);
}

export function clamp(x: number, lo: number, hi: number): number {
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}
