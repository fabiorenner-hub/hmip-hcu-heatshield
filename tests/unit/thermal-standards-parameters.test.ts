/**
 * Licensed normative-parameter capture scaffold. A standards-labelled profile
 * stays disabled until every required parameter is `approved` AND G6/G8 pass.
 */

import { describe, expect, it } from 'vitest';

import {
  REQUIRED_STANDARD_PARAMETERS,
  standardsProfileReadiness,
  type ParameterEvidence,
} from '../../src/shared/thermal/standards-parameters.js';

function approvedEvidence(): ParameterEvidence[] {
  return REQUIRED_STANDARD_PARAMETERS.map((p) => ({
    parameterId: p.parameterId,
    documentVersion: p.standardId,
    clauseOrTable: 'n/a',
    jurisdiction: 'DE',
    conditions: 'true',
    valueOrExpression: 0,
    unit: '-',
    validFrom: '2026-01-01',
    validTo: null,
    sourceHash: 'x',
    reviewStatus: 'approved',
  }));
}

describe('standards parameter readiness', () => {
  it('refuses with no evidence (all parameters missing, gates open)', () => {
    const r = standardsProfileReadiness([], { validationPassed: false, approvedByQualifiedPerson: false });
    expect(r.enabled).toBe(false);
    expect(r.missingParameters.length).toBe(REQUIRED_STANDARD_PARAMETERS.length);
    expect(r.reasons.length).toBeGreaterThanOrEqual(3);
  });

  it('still refuses when parameters approved but validation/approval gates open', () => {
    const r = standardsProfileReadiness(approvedEvidence(), { validationPassed: false, approvedByQualifiedPerson: false });
    expect(r.enabled).toBe(false);
    expect(r.missingParameters).toHaveLength(0);
    expect(r.reasons.some((x) => x.includes('G6'))).toBe(true);
    expect(r.reasons.some((x) => x.includes('G8'))).toBe(true);
  });

  it('enables only when all parameters approved AND G6 + G8 pass', () => {
    const r = standardsProfileReadiness(approvedEvidence(), { validationPassed: true, approvedByQualifiedPerson: true });
    expect(r.enabled).toBe(true);
    expect(r.reasons).toHaveLength(0);
  });

  it('a single non-approved parameter keeps it disabled', () => {
    const ev = approvedEvidence();
    ev[0]!.reviewStatus = 'captured';
    const r = standardsProfileReadiness(ev, { validationPassed: true, approvedByQualifiedPerson: true });
    expect(r.enabled).toBe(false);
    expect(r.missingParameters).toContain(REQUIRED_STANDARD_PARAMETERS[0]!.parameterId);
  });
});
