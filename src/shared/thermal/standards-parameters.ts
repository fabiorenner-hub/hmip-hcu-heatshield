/**
 * Licensed normative-parameter capture scaffold (thermal-load-engine).
 *
 * Implements the knowledge model's `parameter_placeholder_schema` + the path to
 * a standards-labelled profile. Licences are held (DEC-008) — but the actual
 * licensed NORM-PARAM values (climate design temperatures, ψ catalogues,
 * ground equivalent-U method, DIN 1946-6 coefficients, VDI 2078 window/solar
 * model, internal-gain profiles) must be ENTERED here as evidence records with
 * a review status. Kiro must never invent these values; they are captured from
 * the licensed documents by a qualified person.
 *
 * A standards-labelled/"validated" profile may be enabled ONLY when every
 * required parameter is `approved` AND validation (G6) + approval (G8) pass.
 * Pure data + helpers; no I/O, no zod, no fabricated values.
 */

export type ParameterReviewStatus = 'captured' | 'reviewed' | 'approved' | 'blocked';

/** One licensed parameter value, mirroring `parameter_placeholder_schema`. */
export interface ParameterEvidence {
  parameterId: string;
  documentVersion: string;
  clauseOrTable: string;
  jurisdiction: string;
  conditions: string;
  valueOrExpression: number | string | number[];
  unit: string;
  validFrom: string;
  validTo: string | null;
  sourceHash: string;
  reviewStatus: ParameterReviewStatus;
}

export interface RequiredParameter {
  parameterId: string;
  standardId: string;
  description: string;
}

/**
 * The NORM-PARAM values a standards-labelled profile requires. These are the
 * placeholders to be filled from the licensed documents — NOT values.
 */
export const REQUIRED_STANDARD_PARAMETERS: readonly RequiredParameter[] = [
  { parameterId: 'design_outdoor_temperature', standardId: 'DIN_TS_12831_1_2020', description: 'Norm-Außentemperatur je Ort/Region (nationale Klimadaten).' },
  { parameterId: 'thermal_bridge_psi_catalogue', standardId: 'DIN_TS_12831_1_2020', description: 'ψ-Werte / Wärmebrückenverfahren.' },
  { parameterId: 'ground_equivalent_u_method', standardId: 'DIN_TS_12831_1_2020', description: 'Äquivalent-U / periodisches Erdreichverfahren.' },
  { parameterId: 'minimum_air_change', standardId: 'DIN_TS_12831_1_2020', description: 'Mindest-Außenluftvolumenströme / Luftwechsel.' },
  { parameterId: 'ventilation_area_coefficients', standardId: 'DIN_1946_6_2019', description: 'Flächenverfahren-Koeffizienten + Stufen-/Grenzwerte.' },
  { parameterId: 'ventilation_infiltration_e', standardId: 'DIN_1946_6_2019', description: 'Volumenstromkoeffizient e und Anwendungsgrenzen.' },
  { parameterId: 'vdi_window_solar_model', standardId: 'VDI_2078_2015', description: 'Fenster-/Solarmodell (Kern VDI 6007 Blatt 2).' },
  { parameterId: 'vdi_dynamic_core', standardId: 'VDI_2078_2015', description: 'Dynamischer RC-Rechenkern (VDI 6007 Blatt 1).' },
  { parameterId: 'internal_gain_profiles', standardId: 'VDI_2078_2015', description: 'Interne Lasten + Zeitprofile.' },
] as const;

export interface StandardsReadiness {
  /** True only when a standards-labelled profile may be enabled. */
  enabled: boolean;
  /** Required parameter ids not yet `approved`. */
  missingParameters: string[];
  /** Human-readable blocking reasons (gates + parameters). */
  reasons: string[];
}

/**
 * Decide whether a standards-labelled profile may be enabled. Requires every
 * {@link REQUIRED_STANDARD_PARAMETERS} to have an `approved` evidence record,
 * AND validation (G6) AND qualified approval (G8). Defaults refuse.
 */
export function standardsProfileReadiness(
  evidence: readonly ParameterEvidence[],
  gates: { validationPassed: boolean; approvedByQualifiedPerson: boolean },
): StandardsReadiness {
  const approved = new Set(evidence.filter((e) => e.reviewStatus === 'approved').map((e) => e.parameterId));
  const missingParameters = REQUIRED_STANDARD_PARAMETERS.filter((p) => !approved.has(p.parameterId)).map((p) => p.parameterId);

  const reasons: string[] = [];
  if (missingParameters.length > 0) {
    reasons.push(`Fehlende freigegebene NORM-PARAM (${missingParameters.length}/${REQUIRED_STANDARD_PARAMETERS.length}).`);
  }
  if (!gates.validationPassed) reasons.push('G6 Validierung gegen lizenzierte Referenzfälle nicht bestanden.');
  if (!gates.approvedByQualifiedPerson) reasons.push('G8 Freigabe durch qualifizierte Person fehlt.');

  return { enabled: reasons.length === 0, missingParameters, reasons };
}
