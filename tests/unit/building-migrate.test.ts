/**
 * Building Model migration framework (shared-building-model 1.7 / 3.2).
 */

import { describe, expect, it } from 'vitest';

import { migrateBuildingModel, BuildingMigrationError } from '../../src/shared/building-migrate.js';
import { newBuildingModel, defaultEditorContext } from '../../src/shared/building-editor.js';
import { SCHEMA_VERSION } from '../../src/shared/building-model-core.js';

function seed(): ReturnType<typeof newBuildingModel> {
  return newBuildingModel(defaultEditorContext(), { latitude: 52.5, longitude: 13.4, timezone: 'Europe/Berlin' });
}

describe('migrateBuildingModel', () => {
  it('round-trips a current-version model', () => {
    const model = seed();
    const back = migrateBuildingModel(JSON.parse(JSON.stringify(model)));
    expect(back).toEqual(model);
  });

  it('stamps an unversioned payload with the current schema version', () => {
    const model = seed();
    const { schemaVersion: _omit, ...rest } = model;
    const migrated = migrateBuildingModel(rest);
    expect(migrated.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it('throws UNSUPPORTED_VERSION for an unknown future version', () => {
    const model = { ...seed(), schemaVersion: '9.9.9' };
    try {
      migrateBuildingModel(model);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(BuildingMigrationError);
      expect((err as BuildingMigrationError).code).toBe('UNSUPPORTED_VERSION');
    }
  });

  it('throws INVALID_INPUT for a non-object payload', () => {
    expect(() => migrateBuildingModel(42)).toThrow(BuildingMigrationError);
    expect(() => migrateBuildingModel(null)).toThrow(BuildingMigrationError);
    expect(() => migrateBuildingModel([1, 2])).toThrow(BuildingMigrationError);
  });

  it('throws INVALID_INPUT for a non-string schemaVersion', () => {
    try {
      migrateBuildingModel({ ...seed(), schemaVersion: 1 });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as BuildingMigrationError).code).toBe('INVALID_INPUT');
    }
  });
});
