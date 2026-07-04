/**
 * Evidence register evaluator (thermal-load-engine, non-normative).
 *
 * Consumes the operator's "Normen-KI Evidence Register" (records + requirements)
 * and computes the conformity claim by the register's own rule: NO
 * standards-labelled/validated claim until all nine G3 parameters are approved,
 * the three G6 reference cases pass, and G8 (qualified approval) is approved.
 *
 * Pure, defensive parser (accepts the snake_case register JSON). Contains NO
 * licensed values and never fabricates them; it only reflects the approval
 * state that a qualified person recorded. `claim` is `none` unless every gate
 * is satisfied. See `.kiro/generated/thermal-g3-g6-capture.md`.
 */

/** The nine required G3 NORM-PARAM ids (must all be `approved`). */
export const REQUIRED_G3_PARAMS: readonly string[] = [
  'design_outdoor_temperature',
  'thermal_bridge_psi_catalogue',
  'ground_equivalent_u_method',
  'minimum_air_change',
  'ventilation_area_coefficients',
  'ventilation_infiltration_e',
  'vdi_window_solar_model',
  'vdi_dynamic_core',
  'internal_gain_profiles',
];

/** The three required G6 reference-case ids (must all pass/approve). */
export const REQUIRED_G6_CASES: readonly string[] = [
  'g6_heating_load_din_ts_12831_1',
  'g6_ventilation_din_1946_6_bbl1_2025_06',
  'g6_cooling_load_vdi_2078_6007',
];

export interface RegisterRecord {
  evidenceId: string;
  reviewStatus: string;
  gateLinks: string[];
  parameterId: string | null;
  referenceCaseId: string | null;
}

export interface EvidenceRegister {
  records: RegisterRecord[];
}

export interface RegisterEvaluation {
  /** `none` unless G1 + all G3 + all G6 + G8 are satisfied. */
  claim: 'none' | 'standards-profile';
  g1LicenceApproved: boolean;
  g3ApprovedParams: string[];
  g3MissingParams: string[];
  /** G3 params with an `in_review` record but not yet approved (progress only). */
  g3InReviewParams: string[];
  g6PassedCases: string[];
  g6OpenCases: string[];
  /** G6 cases with an `in_review` record but not yet passed (progress only). */
  g6InReviewCases: string[];
  g8Approved: boolean;
  /** Requirement ids still blocking a claim. */
  blockedBy: string[];
}

const APPROVED = new Set(['approved']);
const IN_REVIEW = new Set(['in_review']);
const G6_OK = new Set(['approved', 'passed_pending_review', 'passed']);

/** Defensively parse the register JSON (snake_case) into typed records. */
export function parseEvidenceRegister(raw: unknown): EvidenceRegister {
  const recordsRaw = (raw !== null && typeof raw === 'object' && Array.isArray((raw as { records?: unknown }).records))
    ? ((raw as { records: unknown[] }).records)
    : [];
  const records: RegisterRecord[] = [];
  for (const r of recordsRaw) {
    if (r === null || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const gl = Array.isArray(o['gate_links']) ? (o['gate_links'] as unknown[]).filter((x): x is string => typeof x === 'string') : [];
    records.push({
      evidenceId: typeof o['evidence_id'] === 'string' ? o['evidence_id'] : '',
      reviewStatus: typeof o['review_status'] === 'string' ? o['review_status'] : 'pending_evidence',
      gateLinks: gl,
      parameterId: typeof o['parameter_id'] === 'string' ? o['parameter_id'] : null,
      referenceCaseId: typeof o['reference_case_id'] === 'string' ? o['reference_case_id'] : null,
    });
  }
  return { records };
}

/** Evaluate the register against the claim policy. */
export function evaluateRegister(register: EvidenceRegister): RegisterEvaluation {
  const rec = register.records;
  const g1LicenceApproved = rec.some((r) => APPROVED.has(r.reviewStatus) && r.gateLinks.includes('G1'));
  const g8Approved = rec.some((r) => APPROVED.has(r.reviewStatus) && r.gateLinks.includes('G8'));

  const g3ApprovedParams = REQUIRED_G3_PARAMS.filter((p) =>
    rec.some((r) => APPROVED.has(r.reviewStatus) && r.parameterId === p),
  );
  const g3MissingParams = REQUIRED_G3_PARAMS.filter((p) => !g3ApprovedParams.includes(p));
  const g3InReviewParams = REQUIRED_G3_PARAMS.filter((p) =>
    !g3ApprovedParams.includes(p) && rec.some((r) => IN_REVIEW.has(r.reviewStatus) && r.parameterId === p),
  );

  const g6PassedCases = REQUIRED_G6_CASES.filter((c) =>
    rec.some((r) => G6_OK.has(r.reviewStatus) && r.referenceCaseId === c),
  );
  const g6OpenCases = REQUIRED_G6_CASES.filter((c) => !g6PassedCases.includes(c));
  const g6InReviewCases = REQUIRED_G6_CASES.filter((c) =>
    !g6PassedCases.includes(c) && rec.some((r) => IN_REVIEW.has(r.reviewStatus) && r.referenceCaseId === c),
  );

  const blockedBy: string[] = [];
  if (!g1LicenceApproved) blockedBy.push('G1');
  for (const p of g3MissingParams) blockedBy.push(`G3:${p}`);
  for (const c of g6OpenCases) blockedBy.push(`G6:${c}`);
  if (!g8Approved) blockedBy.push('G8');

  const claim: 'none' | 'standards-profile' = blockedBy.length === 0 ? 'standards-profile' : 'none';
  return { claim, g1LicenceApproved, g3ApprovedParams, g3MissingParams, g3InReviewParams, g6PassedCases, g6OpenCases, g6InReviewCases, g8Approved, blockedBy };
}
