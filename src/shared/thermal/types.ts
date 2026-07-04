/**
 * Thermal load estimate — shared types (thermal-load-engine).
 *
 * IMPORTANT — NON-NORMATIVE. This engine implements the **Quick Estimate v1**
 * profile: a transparent, technically-equivalent, SIMPLIFIED writing of the
 * heating-load (DIN EN 12831-1 / DIN·TS 12831-1 structure), ventilation
 * (DIN 1946-6 area method) and cooling (VDI 2078 static peak) physics. It is
 * NOT a dimensioning or conformity statement: the full tables, factors and
 * special-case equations live in the paid standard documents. A
 * standards-labelled/"validated" profile stays disabled until a licensed
 * source, traceability matrix, reference cases and independent review exist
 * (see `.kiro/steering/thermal-standards.md`).
 *
 * Pure types only — no zod (keeps the SPA bundle clean), no I/O.
 */

/** Calculation profile id. Only the non-normative estimate is enabled. */
export type ThermalProfileId = 'quick-estimate-v1';

export const THERMAL_PROFILE_VERSION = 'quick-estimate-v1';

/** Air constants (SI). ρ·cp/3600 ≈ 0.34 Wh/(m³·K). */
export const AIR = {
  /** Density [kg/m³]. */
  rho: 1.2,
  /** Specific heat capacity [kJ/(kg·K)]. */
  cp: 1.005,
  /** Volumetric heat capacity per m³/h and K: ρ·cp/3.6 ≈ 0.34 W·h/(m³·K). */
  cV: 0.34,
  /** Latent heat of vaporisation [MJ/kg]. */
  rv: 2.5,
} as const;

/** One opaque or transparent envelope surface of a room. */
export interface ThermalSurface {
  id: string;
  /** Area [m²]. */
  areaM2: number;
  /** Thermal transmittance U [W/(m²·K)]. */
  uValue: number;
  /**
   * What the surface borders. Drives the temperature-correction factor `f`:
   *   - `exterior` → full ΔT to outdoor,
   *   - `ground`   → reduced (equivalent-U handled via `uValue` + `f`),
   *   - `unheated`/`adjacent-heated` → ΔT to `adjacentTempC`.
   */
  boundary: 'exterior' | 'ground' | 'unheated' | 'adjacent-heated';
  /** Temperature of the adjacent space [°C] (for non-exterior boundaries). */
  adjacentTempC?: number;
  /** True for glazing (used by the solar estimate). */
  glazing?: boolean;
  /** Total solar energy transmittance g_tot (glazing only). */
  gTotal?: number;
  /** Shading reduction factor F_sh in [0,1] (glazing only). */
  shadingFactor?: number;
  /** Incident solar irradiance on this surface [W/m²] (cooling only). */
  solarWm2?: number;
}

/** Internal-gain inputs for the cooling estimate. */
export interface InternalGains {
  persons?: number;
  /** Sensible gain per person [W]. */
  personSensibleW?: number;
  /** Latent gain per person [W]. */
  personLatentW?: number;
  /** Installed lighting power [W]. */
  lightingW?: number;
  /** Installed equipment power [W]. */
  equipmentW?: number;
  /** Combined operating/diversity factor applied to lighting+equipment [0,1]. */
  usageFactor?: number;
}

/** Per-room thermal input assembled from the building model + profile. */
export interface RoomThermalInput {
  roomId: string;
  name: string;
  /** Floor area [m²]. */
  floorAreaM2: number;
  /** Room air volume [m³]. */
  volumeM3: number;
  /** Design indoor temperature [°C]. */
  indoorTempC: number;
  surfaces: ThermalSurface[];
  /** Air change rate n [1/h] for the ventilation loss (min-flow applied). */
  airChangeRate?: number;
  /** Optional mechanical supply flow [m³/h]. */
  supplyFlowM3h?: number;
  /** Heat-recovery effectiveness η_t [0,1] for supply air. */
  heatRecovery?: number;
  /** Thermal-bridge surcharge ΔU_WB [W/(m²·K)] added to every U. */
  thermalBridgeSurchargeU?: number;
  /** Reheat allowance factor f_hu [W/m²] (interrupted heating). */
  reheatFactorWm2?: number;
  /** Comfort uplift Δθ_comf [K] for an elevated design indoor temperature. */
  comfortUpliftK?: number;
  gains?: InternalGains;
}

/** Site/climate + global parameters. */
export interface ThermalParams {
  /** Design (norm) outdoor temperature θ_e [°C]. */
  designOutdoorTempC: number;
  /** Default design indoor temperature [°C] when a room omits it. */
  defaultIndoorTempC: number;
  /** Summer design outdoor temperature for cooling [°C]. */
  summerOutdoorTempC?: number;
  /** Outdoor/indoor humidity ratio for latent ventilation [kg/kg]. */
  outdoorHumidityRatio?: number;
  indoorHumidityRatio?: number;
}

export type Warning = { code: string; message: string };

/** A single quantified result with mandatory provenance. */
export interface QuantifiedResult {
  /** Value in `unit`. */
  value: number;
  unit: string;
  /** ± uncertainty band (same unit), best-effort from data quality. */
  uncertainty: number;
}

export interface RoomHeatingResult {
  roomId: string;
  name: string;
  transmissionW: number;
  ventilationW: number;
  reheatW: number;
  comfortW: number;
  /** Φ_HL,i = Φ_stand + max(comfort, reheat). */
  totalW: number;
  /** Specific heating load [W/m²]. */
  specificWm2: number;
  transmissionByBoundary: Record<string, number>;
}

export interface RoomCoolingResult {
  roomId: string;
  name: string;
  solarW: number;
  opaqueW: number;
  internalSensibleW: number;
  internalLatentW: number;
  ventilationSensibleW: number;
  ventilationLatentW: number;
  /** Peak sensible cooling load (≥0). */
  sensibleW: number;
  latentW: number;
  totalW: number;
}

/** Data-quality assessment for one calculation. */
export interface DataQuality {
  /** 0..1 (1 = all inputs present/plausible). */
  score: number;
  /** Relative uncertainty applied to results, e.g. 0.25 = ±25 %. */
  relativeUncertainty: number;
  missingInputs: string[];
}

export interface ThermalEstimate {
  profile: ThermalProfileId;
  profileVersion: string;
  /** ISO timestamp of the computation. */
  computedAt: string;
  /** Building model revision the estimate was derived from. */
  modelRevision: number;
  /** FNV-1a hash of the canonicalised inputs (reproducibility). */
  inputHash: string;
  params: ThermalParams;
  heating: {
    rooms: RoomHeatingResult[];
    /** Building heating load ≠ Σ room loads (inter-room transfer nets out). */
    buildingTotalW: number;
    sumOfRoomsW: number;
  };
  cooling: {
    rooms: RoomCoolingResult[];
    /** Peak building cooling load = max over time of Σ rooms; here Σ of peaks (static estimate). */
    buildingPeakW: number;
  };
  dataQuality: DataQuality;
  warnings: Warning[];
  /** Conformity status — `claim: 'none'`; license/validation/approval gates blocked. */
  conformity: {
    claim: 'none';
    gates: Array<{ id: string; name: string; state: 'met' | 'partial' | 'blocked' | 'na'; note: string }>;
    openGates: string[];
  };
  /** Formula-registry ids the estimate is built from (traceability). */
  methodRefs: string[];
  /** Mandatory non-normative disclaimer. */
  disclaimer: string;
}

export const NON_NORMATIVE_DISCLAIMER =
  'Quick Estimate v1 — nicht-normative, technisch gleichwertige Näherung (DIN EN 12831-1 / ' +
  'DIN·TS 12831-1 / DIN 1946-6 / VDI 2078 Struktur). Keine Dimensionierungs- oder ' +
  'Konformitätsaussage; vollständige Tabellen/Faktoren stehen in den kostenpflichtigen Normen.';
