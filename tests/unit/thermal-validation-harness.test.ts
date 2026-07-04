/**
 * G6 validation harness (non-normative). Verifies the VDI 6020 comparison
 * mechanics — NOT that the engine passes any real case (that needs the licensed
 * VDI 6007 parameterisation + Datenträger inputs + qualified approval).
 */

import { describe, expect, it } from 'vitest';

import {
  compareSeries,
  evaluateAgainstVdi6020,
  VDI6020_TOLERANCES,
  VDI6007_TESTCASE_S,
} from '../../src/shared/thermal/validation-harness.js';

describe('G6 validation harness', () => {
  it('identical series → zero deviation, within tolerance', () => {
    const temp = [24, 25, 26, 25];
    const load = [100, 200, 764, -638];
    const r = evaluateAgainstVdi6020(temp, temp, load, load);
    expect(r.temperature.absMeanDiff).toBeCloseTo(0, 9);
    expect(r.load.stdDiff).toBeCloseTo(0, 9);
    expect(r.withinTolerance).toBe(true);
    expect(r.breaches).toHaveLength(0);
  });

  it('a large load offset breaches the mean-load limit', () => {
    const temp = [25, 25, 25];
    const actual = [300, 300, 300];
    const expected = [100, 100, 100]; // +200 W mean offset > 50 W
    const r = evaluateAgainstVdi6020(temp, temp, actual, expected);
    expect(r.withinTolerance).toBe(false);
    expect(r.breaches).toContain('meanLoadW');
  });

  it('compareSeries computes mean + sample std of (actual − expected)', () => {
    const d = compareSeries([2, 4, 6], [1, 2, 3]); // diffs 1,2,3 → mean 2, std 1
    expect(d.meanDiff).toBeCloseTo(2, 9);
    expect(d.stdDiff).toBeCloseTo(1, 9);
  });

  it('exposes the public VDI 6020 limits and the VDI 6007 test-case (in_review)', () => {
    expect(VDI6020_TOLERANCES.meanLoadW).toBe(50);
    expect(VDI6020_TOLERANCES.meanTempK).toBe(1.0);
    expect(VDI6007_TESTCASE_S.status).toBe('in_review');
    expect(VDI6007_TESTCASE_S.expected.maxLoadW).toBe(764);
    expect(VDI6007_TESTCASE_S.expected.minLoadW).toBe(-638);
  });
});
