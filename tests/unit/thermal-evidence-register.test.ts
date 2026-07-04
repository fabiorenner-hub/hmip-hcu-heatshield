/**
 * Evidence register evaluator (non-normative). Verifies the operator's
 * claim-policy rule: claim stays `none` until G1 + all 9 G3 + all 3 G6 + G8
 * are satisfied. Uses the exact record shape from the Normen-KI package.
 */

import { describe, expect, it } from 'vitest';

import {
  parseEvidenceRegister,
  evaluateRegister,
  REQUIRED_G3_PARAMS,
  REQUIRED_G6_CASES,
} from '../../src/shared/thermal/evidence-register.js';

// The register shipped in the package: only the G1 licence attestation approved.
const packageRegister = {
  records: [
    { evidence_id: 'EV-GOV-LIC-001', review_status: 'approved', gate_links: ['G1'] },
  ],
};

describe('evidence register evaluator', () => {
  it('package register: G1 approved, everything else blocks → claim none', () => {
    const evalr = evaluateRegister(parseEvidenceRegister(packageRegister));
    expect(evalr.g1LicenceApproved).toBe(true);
    expect(evalr.claim).toBe('none');
    expect(evalr.g3MissingParams).toHaveLength(9);
    expect(evalr.g6OpenCases).toHaveLength(3);
    expect(evalr.g8Approved).toBe(false);
    expect(evalr.blockedBy).not.toContain('G1');
    expect(evalr.blockedBy).toContain('G8');
    expect(evalr.blockedBy.length).toBe(9 + 3 + 1); // all G3 + G6 + G8
  });

  it('empty register blocks everything incl. G1', () => {
    const evalr = evaluateRegister(parseEvidenceRegister({ records: [] }));
    expect(evalr.claim).toBe('none');
    expect(evalr.blockedBy).toContain('G1');
  });

  it('fully-approved register → standards-profile claim, nothing blocking', () => {
    const records = [
      { evidence_id: 'G1', review_status: 'approved', gate_links: ['G1'] },
      { evidence_id: 'G8', review_status: 'approved', gate_links: ['G8'] },
      ...REQUIRED_G3_PARAMS.map((p, i) => ({ evidence_id: `P${i}`, review_status: 'approved', parameter_id: p })),
      ...REQUIRED_G6_CASES.map((c, i) => ({ evidence_id: `C${i}`, review_status: 'approved', reference_case_id: c })),
    ];
    const evalr = evaluateRegister(parseEvidenceRegister({ records }));
    expect(evalr.claim).toBe('standards-profile');
    expect(evalr.blockedBy).toHaveLength(0);
  });

  it('one un-approved G3 parameter keeps the claim none', () => {
    const records = [
      { evidence_id: 'G1', review_status: 'approved', gate_links: ['G1'] },
      { evidence_id: 'G8', review_status: 'approved', gate_links: ['G8'] },
      ...REQUIRED_G3_PARAMS.slice(1).map((p, i) => ({ evidence_id: `P${i}`, review_status: 'approved', parameter_id: p })),
      ...REQUIRED_G6_CASES.map((c, i) => ({ evidence_id: `C${i}`, review_status: 'approved', reference_case_id: c })),
    ];
    const evalr = evaluateRegister(parseEvidenceRegister({ records }));
    expect(evalr.claim).toBe('none');
    expect(evalr.blockedBy).toContain(`G3:${REQUIRED_G3_PARAMS[0]}`);
  });

  it('in_review records show progress but never satisfy a gate (claim stays none)', () => {
    const evalr = evaluateRegister(parseEvidenceRegister({
      records: [
        { evidence_id: 'G1', review_status: 'approved', gate_links: ['G1'] },
        { evidence_id: 'WB', review_status: 'in_review', parameter_id: 'thermal_bridge_psi_catalogue' },
        { evidence_id: 'VS', review_status: 'in_review', parameter_id: 'vdi_window_solar_model' },
        { evidence_id: 'C', review_status: 'in_review', reference_case_id: REQUIRED_G6_CASES[2] },
      ],
    }));
    expect(evalr.claim).toBe('none');
    expect(evalr.g3ApprovedParams).toHaveLength(0);
    expect(evalr.g3InReviewParams).toEqual(expect.arrayContaining(['thermal_bridge_psi_catalogue', 'vdi_window_solar_model']));
    expect(evalr.g6InReviewCases).toContain(REQUIRED_G6_CASES[2]);
    // in_review still blocks.
    expect(evalr.blockedBy).toContain('G3:thermal_bridge_psi_catalogue');
  });

  it('G6 accepts passed_pending_review as passing', () => {
    const evalr = evaluateRegister(parseEvidenceRegister({
      records: [{ evidence_id: 'C', review_status: 'passed_pending_review', reference_case_id: REQUIRED_G6_CASES[0] }],
    }));
    expect(evalr.g6PassedCases).toContain(REQUIRED_G6_CASES[0]);
  });
});
