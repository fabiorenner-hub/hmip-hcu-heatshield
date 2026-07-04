/**
 * Ventilation concept — Quick Estimate v1 (non-normative), DIN 1946-6 method
 * for dwelling ventilation. Simplified, technically-equivalent physics:
 *
 *   base(A)   = −0.002·A² + 1.15·A + 11         [m³/h, area method, h≈2.5 m]
 *   q_stage   = f_stage · base(A)               f_RL=0.7, f_NL=1.0, f_IL=1.3
 *   q_FL      = f_WS · base(A)                   (moisture protection)
 *   q_inf     = e · V · n50                      (infiltration)
 *   measure required  ⇔  q_inf < q_FL
 *   ADL law   q2 = q1·(Δp2/Δp1)^n                (n≈2/3)
 *
 * Above 210 m² the quadratic is not continued: +4 m³/h per additional 10 m².
 * No proprietary tables are reproduced.
 */

export type VentStage = 'reduced' | 'nominal' | 'intensive';
export const STAGE_FACTOR: Record<VentStage, number> = { reduced: 0.7, nominal: 1.0, intensive: 1.3 };

/** Wärmeschutz level + occupancy → moisture-protection factor f_WS. */
export type WaermeschutzLevel = 'high' | 'low';
export type Occupancy = 'low' | 'high';

/** f_WS from the DIN 1946-6 category matrix (published factor values). */
export function moistureProtectionFactor(level: WaermeschutzLevel, occ: Occupancy): number {
  if (level === 'high') return occ === 'low' ? 0.2 : 0.3;
  return occ === 'low' ? 0.3 : 0.4;
}

/**
 * Area base flow [m³/h]. Quadratic up to 210 m², then linear +4 m³/h per 10 m².
 * `areaM2` is the usage-unit floor area A_NE.
 */
export function areaBaseFlow(areaM2: number): number {
  const a = Math.max(0, areaM2);
  const quad = (x: number): number => -0.002 * x * x + 1.15 * x + 11;
  if (a <= 210) return quad(a);
  return quad(210) + ((a - 210) / 10) * 4;
}

/** Total flow for a ventilation stage [m³/h]. */
export function stageFlow(areaM2: number, stage: VentStage): number {
  return STAGE_FACTOR[stage] * areaBaseFlow(areaM2);
}

/** Moisture-protection flow q_FL [m³/h]. */
export function moistureProtectionFlow(areaM2: number, level: WaermeschutzLevel, occ: Occupancy): number {
  return moistureProtectionFactor(level, occ) * areaBaseFlow(areaM2);
}

/** Infiltration flow q_inf = e·V·n50 [m³/h]. */
export function infiltrationFlow(volumeM3: number, n50: number, coefficientE = 0.06): number {
  return Math.max(0, coefficientE) * Math.max(0, volumeM3) * Math.max(0, n50);
}

export interface VentilationConcept {
  areaM2: number;
  baseFlowM3h: number;
  moistureProtectionM3h: number;
  reducedM3h: number;
  nominalM3h: number;
  intensiveM3h: number;
  infiltrationM3h: number;
  /** q_inf < q_FL ⇒ a ventilation measure is required. */
  measureRequired: boolean;
}

/** Full ventilation concept for a usage unit. */
export function ventilationConcept(input: {
  areaM2: number;
  volumeM3: number;
  n50: number;
  waermeschutz: WaermeschutzLevel;
  occupancy: Occupancy;
  infiltrationCoefficientE?: number;
}): VentilationConcept {
  const base = areaBaseFlow(input.areaM2);
  const qFL = moistureProtectionFlow(input.areaM2, input.waermeschutz, input.occupancy);
  const qInf = infiltrationFlow(input.volumeM3, input.n50, input.infiltrationCoefficientE ?? 0.06);
  return {
    areaM2: input.areaM2,
    baseFlowM3h: base,
    moistureProtectionM3h: qFL,
    reducedM3h: STAGE_FACTOR.reduced * base,
    nominalM3h: base,
    intensiveM3h: STAGE_FACTOR.intensive * base,
    infiltrationM3h: qInf,
    measureRequired: qInf < qFL,
  };
}

/**
 * Pressure/flow conversion for air inlets/leakage: q2 = q1·(Δp2/Δp1)^n.
 * Default exponent n = 2/3 (typical for background ventilators/leakage).
 */
export function convertFlowAtPressure(q1: number, dp1: number, dp2: number, exponent = 2 / 3): number {
  if (dp1 <= 0 || dp2 < 0) return q1;
  return q1 * Math.pow(dp2 / dp1, exponent);
}
