/**
 * Shared Building Model — shape + referential-integrity tests
 * (shared-building-model tasks 1.2/1.4/3.1).
 *
 * Covers: the valid fixture parses and validates clean; each cross-reference
 * code fires on a targeted mutation; property test asserts `validate` never
 * throws and `valid === (issues.length === 0)` for arbitrary edits.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  parseBuildingModel,
  safeParseBuildingModel,
  validateBuildingModel,
  type BuildingModel,
} from '../../src/shared/building-model.js';
import { validBuildingModel, fixtureIds } from '../fixtures/building-model.js';

const clone = (m: BuildingModel): BuildingModel =>
  JSON.parse(JSON.stringify(m)) as BuildingModel;

describe('building-model shape', () => {
  it('parses the valid fixture', () => {
    expect(() => parseBuildingModel(validBuildingModel)).not.toThrow();
  });

  it('rejects an unknown top-level key (strict)', () => {
    const bad = { ...clone(validBuildingModel), bogus: 1 } as unknown;
    expect(safeParseBuildingModel(bad).success).toBe(false);
  });

  it('rejects a wrong schemaVersion', () => {
    const bad = { ...clone(validBuildingModel), schemaVersion: '2.0.0' } as unknown;
    expect(safeParseBuildingModel(bad).success).toBe(false);
  });

  it('rejects a non-uuid id', () => {
    const bad = { ...clone(validBuildingModel), id: 'not-a-uuid' } as unknown;
    expect(safeParseBuildingModel(bad).success).toBe(false);
  });

  it('rejects pitch outside [0,80]', () => {
    const bad = clone(validBuildingModel);
    bad.roofs[0]!.pitchDeg = 95;
    expect(safeParseBuildingModel(bad).success).toBe(false);
  });
});

describe('building-model referential integrity', () => {
  it('validates the fixture clean', () => {
    const res = validateBuildingModel(validBuildingModel);
    expect(res).toEqual({ valid: true, issues: [] });
  });

  it('flags a missing host wall', () => {
    const m = clone(validBuildingModel);
    m.storeys[0]!.openings[0]!.hostWallId = '00000000-0000-4000-8000-0000000000ff';
    const res = validateBuildingModel(m);
    expect(res.valid).toBe(false);
    expect(res.issues.map((i) => i.code)).toContain('OPENING_HOST_WALL_MISSING');
  });

  it('flags a host wall that lives on the wrong storey', () => {
    const m = clone(validBuildingModel);
    // EG opening points at the OG wall — exists, but wrong storey.
    m.storeys[0]!.openings[0]!.hostWallId = fixtureIds.wallOg;
    const res = validateBuildingModel(m);
    expect(res.issues.map((i) => i.code)).toContain('OPENING_HOST_WALL_WRONG_STOREY');
  });

  it('flags a missing construction reference', () => {
    const m = clone(validBuildingModel);
    m.storeys[0]!.walls[0]!.constructionId = '00000000-0000-4000-8000-0000000000aa';
    const res = validateBuildingModel(m);
    expect(res.issues.map((i) => i.code)).toContain('WALL_CONSTRUCTION_MISSING');
  });

  it('flags a thermal zone referencing an unknown space', () => {
    const m = clone(validBuildingModel);
    m.thermalZones[0]!.spaceIds = ['00000000-0000-4000-8000-0000000000bb'];
    const res = validateBuildingModel(m);
    expect(res.issues.map((i) => i.code)).toContain('THERMAL_ZONE_SPACE_MISSING');
  });

  it('flags an empty thermal zone', () => {
    const m = clone(validBuildingModel);
    m.thermalZones[0]!.spaceIds = [];
    const res = validateBuildingModel(m);
    expect(res.issues.map((i) => i.code)).toContain('THERMAL_ZONE_EMPTY');
  });

  it('flags a roof on a missing storey', () => {
    const m = clone(validBuildingModel);
    m.roofs[0]!.storeyId = '00000000-0000-4000-8000-0000000000cc';
    const res = validateBuildingModel(m);
    expect(res.issues.map((i) => i.code)).toContain('ROOF_STOREY_MISSING');
  });

  it('flags a duplicate id', () => {
    const m = clone(validBuildingModel);
    m.constructions.push({ ...m.constructions[0]! });
    const res = validateBuildingModel(m);
    expect(res.issues.map((i) => i.code)).toContain('DUPLICATE_ID');
  });
});

describe('building-model validate invariants (property)', () => {
  it('never throws and valid iff no issues, for arbitrary host-wall edits', () => {
    fc.assert(
      fc.property(fc.string(), (hostWallId) => {
        const m = clone(validBuildingModel);
        m.storeys[0]!.openings[0]!.hostWallId = hostWallId;
        const res = validateBuildingModel(m);
        expect(res.valid).toBe(res.issues.length === 0);
      }),
    );
  });
});
