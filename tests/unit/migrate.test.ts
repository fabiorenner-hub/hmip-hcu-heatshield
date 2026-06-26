/**
 * Tests for `migrate` (config schema migration ladder).
 *
 * Cases covered:
 *   - Identity transform on a v1 config equals `parseConfig`.
 *   - Empty object throws a `ZodError` (required `location` is missing).
 *   - Non-object inputs (`null`, arrays, primitives) throw `MigrationError`
 *     with code `INVALID_INPUT`.
 *   - Unknown numeric `schemaVersion` throws `MigrationError` with code
 *     `UNSUPPORTED_VERSION`.
 *   - Non-integer `schemaVersion` throws `MigrationError` with code
 *     `INVALID_INPUT`.
 *   - A config without `schemaVersion` is stamped with the current version
 *     and parses successfully.
 *   - Shallow-clone behavior: mutations on the input after `migrate`
 *     returned do not leak into the parsed result.
 *   - `CURRENT_SCHEMA_VERSION === 1`.
 */

import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import {
  CURRENT_SCHEMA_VERSION,
  migrate,
  MigrationError,
} from '../../src/shared/migrate.js';
import { parseConfig } from '../../src/shared/schema.js';
import {
  validMinimalConfig,
  validRealisticConfig,
} from '../_fixtures/config.js';

describe('migrate — identity for v1 configs', () => {
  it('returns the same shape as parseConfig for a valid v1 config', () => {
    const input = validRealisticConfig();
    const migrated = migrate(input);
    const parsed = parseConfig(validRealisticConfig());

    expect(migrated).toEqual(parsed);
  });

  it('exports CURRENT_SCHEMA_VERSION as 1', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(1);
  });
});

describe('migrate — invalid structural input', () => {
  it('throws ZodError on the empty object (missing location etc.)', () => {
    let caught: unknown;
    try {
      migrate({});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ZodError);
  });

  it('throws MigrationError(INVALID_INPUT) for null', () => {
    let caught: unknown;
    try {
      migrate(null);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MigrationError);
    expect((caught as MigrationError).code).toBe('INVALID_INPUT');
  });

  it('throws MigrationError(INVALID_INPUT) for arrays', () => {
    let caught: unknown;
    try {
      migrate([]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MigrationError);
    expect((caught as MigrationError).code).toBe('INVALID_INPUT');
  });

  it('throws MigrationError(INVALID_INPUT) for primitive strings', () => {
    let caught: unknown;
    try {
      migrate('hello');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MigrationError);
    expect((caught as MigrationError).code).toBe('INVALID_INPUT');
  });
});

describe('migrate — schemaVersion edge cases', () => {
  it('throws MigrationError(UNSUPPORTED_VERSION) for an unknown version', () => {
    let caught: unknown;
    try {
      migrate({ schemaVersion: 99 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MigrationError);
    expect((caught as MigrationError).code).toBe('UNSUPPORTED_VERSION');
  });

  it('throws MigrationError(INVALID_INPUT) for a non-integer schemaVersion', () => {
    const config = validRealisticConfig();
    config['schemaVersion'] = 1.5;

    let caught: unknown;
    try {
      migrate(config);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MigrationError);
    expect((caught as MigrationError).code).toBe('INVALID_INPUT');
  });

  it('stamps schemaVersion: 1 when it is missing on a valid v1 payload', () => {
    const config = validMinimalConfig();
    delete config['schemaVersion'];

    const migrated = migrate(config);

    expect(migrated.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });
});

describe('migrate — shallow clone behavior', () => {
  it('does not retain a reference to the caller-mutable input object', () => {
    const input = validRealisticConfig();
    const migrated = migrate(input);

    // Mutating the input afterwards must not affect the migrated result.
    input['schemaVersion'] = 999;
    (input['rules'] as Record<string, unknown>)['profile'] = 'aggressive';

    expect(migrated.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(migrated.rules.profile).toBe('standard');
    expect(migrated as unknown).not.toBe(input);
  });
});
