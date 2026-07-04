/**
 * Thermal knowledge model (non-normative scaffold). Verifies the formula
 * registry integrity, the status-class taxonomy, and the G1–G8 gate helper.
 */

import { describe, expect, it } from 'vitest';

import {
  FORMULA_REGISTRY,
  STATUS_CLASSES,
  QUICK_ESTIMATE_GATES,
  quickEstimateConformity,
  methodRefIds,
} from '../../src/shared/thermal/knowledge-model.js';

describe('thermal knowledge model', () => {
  it('has unique formula ids, each with a known status class', () => {
    const ids = FORMULA_REGISTRY.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const f of FORMULA_REGISTRY) {
      expect(Object.keys(STATUS_CLASSES)).toContain(f.statusClass);
    }
    expect(methodRefIds()).toEqual(ids);
  });

  it('defines all eight conformity gates', () => {
    const ids = QUICK_ESTIMATE_GATES.map((g) => g.id);
    expect(ids).toEqual(['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8']);
  });

  it('non-normative status: claim none; licence met but validation/approval blocked', () => {
    const c = quickEstimateConformity();
    expect(c.claim).toBe('none');
    const byId = new Map(c.gates.map((g) => [g.id, g.state]));
    expect(byId.get('G1')).toBe('met'); // licence held (DEC-008)
    expect(byId.get('G6')).toBe('blocked'); // validation
    expect(byId.get('G8')).toBe('blocked'); // approval
    // Open gates = every non-met/non-na gate.
    expect(c.openGates).toEqual(expect.arrayContaining(['G3', 'G6', 'G7', 'G8']));
    expect(c.openGates).not.toContain('G1');
    expect(c.openGates).not.toContain('G2');
  });
});
