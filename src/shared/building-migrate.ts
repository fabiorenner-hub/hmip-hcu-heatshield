/**
 * Heat Shield — Building Model schema migration (shared-building-model 1.7).
 *
 * The persisted model in `/data/building/model.json` carries a `schemaVersion`
 * string literal (see `BuildingModelSchema`). Whenever that literal is bumped,
 * this module translates an older payload into the current shape before it is
 * parsed against the active Zod schema.
 *
 * Design (mirrors `migrate.ts` for config):
 *   - Pure data-shape concern: no fs, no logging.
 *   - The switch over `schemaVersion` is the single source of truth for the
 *     pipeline. New versions insert a `case` ABOVE the current one that mutates
 *     `candidate` and falls through to the next stage.
 *   - Shape failures bubble up as Zod errors from `parseBuildingModel`.
 *     Migration-specific failures use {@link BuildingMigrationError} so the
 *     persistence layer can tell "seed a default" from "stored payload invalid".
 *
 * SERVER-SIDE ONLY: imports the Zod parser. Never import this from the SPA.
 */

import { parseBuildingModel, type BuildingModel } from './building-model.js';
import { SCHEMA_VERSION } from './building-model-core.js';

export type BuildingMigrationErrorCode = 'UNSUPPORTED_VERSION' | 'INVALID_INPUT';

export class BuildingMigrationError extends Error {
  public readonly code: BuildingMigrationErrorCode;

  public constructor(message: string, code: BuildingMigrationErrorCode) {
    super(message);
    this.name = 'BuildingMigrationError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Migrate an arbitrary persisted payload up to the current schema version and
 * parse it. A missing `schemaVersion` is treated as a fresh current-version
 * document (stamped, then parsed). An unknown/future version throws
 * `BuildingMigrationError('UNSUPPORTED_VERSION')`.
 */
export function migrateBuildingModel(input: unknown): BuildingModel {
  if (!isPlainObject(input)) {
    throw new BuildingMigrationError('Building model payload must be a JSON object.', 'INVALID_INPUT');
  }

  const candidate: Record<string, unknown> = { ...input };
  const rawVersion = candidate['schemaVersion'];

  if (rawVersion === undefined) {
    candidate['schemaVersion'] = SCHEMA_VERSION;
    return parseBuildingModel(candidate);
  }
  if (typeof rawVersion !== 'string') {
    throw new BuildingMigrationError(
      `Building model has a non-string schemaVersion (${String(rawVersion)}); expected "${SCHEMA_VERSION}".`,
      'INVALID_INPUT',
    );
  }

  switch (rawVersion) {
    // Template for the next breaking change:
    //   case '1.0.0': {
    //     candidate = migrateV1_0_0toV1_1_0(candidate);
    //     // fallthrough
    //   }
    case SCHEMA_VERSION: {
      // Identity migration for the current version — defaults applied by Zod.
      return parseBuildingModel(candidate);
    }
    default: {
      throw new BuildingMigrationError(
        `Unsupported building-model schemaVersion "${rawVersion}"; this build understands "${SCHEMA_VERSION}".`,
        'UNSUPPORTED_VERSION',
      );
    }
  }
}
