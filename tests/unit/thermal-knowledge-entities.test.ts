/**
 * Thermal knowledge entity/variable catalog (non-normative data dictionary).
 * Verifies catalog integrity vs the Normen-KI package.
 */

import { describe, expect, it } from 'vitest';

import { KNOWLEDGE_ENTITIES, entityByName, ANSWER_LAYERS } from '../../src/shared/thermal/knowledge-entities.js';

describe('thermal knowledge entities', () => {
  it('has all 22 entities, each with at least one field + provenance required', () => {
    expect(KNOWLEDGE_ENTITIES).toHaveLength(22);
    for (const e of KNOWLEDGE_ENTITIES) {
      expect(e.fields.length).toBeGreaterThan(0);
      expect(e.fields.every((fld) => fld.provenanceRequired === true)).toBe(true);
    }
  });

  it('includes the governance/provenance entities', () => {
    for (const name of ['EvidenceRecord', 'Assumption', 'CalculationRun', 'ValidationResult', 'StandardProfile']) {
      expect(entityByName(name)).toBeDefined();
    }
  });

  it('carries units on the quantitative fields', () => {
    const room = entityByName('Room');
    expect(room?.fields.find((x) => x.name === 'area')?.unit).toBe('m²');
    expect(room?.fields.find((x) => x.name === 'volume')?.unit).toBe('m³');
    expect(entityByName('Zone')?.fields.find((x) => x.name === 'cooling_setpoint')?.unit).toBe('°C');
  });

  it('defines the three answer layers', () => {
    expect(ANSWER_LAYERS).toEqual(['normativ_belegt', 'fachliche_erklaerung', 'annahme']);
  });
});
