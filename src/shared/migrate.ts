/**
 * Heat Shield — config schema migration.
 *
 * The persisted config in `/data/config.json` carries a `schemaVersion`
 * literal (see `ConfigSchema` in `./schema.ts`). Whenever that literal is
 * bumped, this module is responsible for translating an older payload into
 * the current shape before it is parsed against the active schema.
 *
 * Design constraints (Task 2.3, requirements 2.1 / 12.5):
 *   - Pure data-shape concern: no `fs`, no logging, no Connect API artifacts.
 *   - The switch over `schemaVersion` is the single source of truth for the
 *     migration pipeline. New versions are added by inserting a `case` ABOVE
 *     `CURRENT_SCHEMA_VERSION` that mutates `input` and falls through to the
 *     next stage (see the `case 2:` template below).
 *   - Validation failures bubble up as Zod `ZodError`s from `parseConfig`.
 *     Migration-specific failures use `MigrationError` so callers (Task 3.1
 *     persistence layer) can distinguish "needs default seed / wizard" from
 *     "stored payload is structurally invalid".
 */

import { parseConfig } from './schema.js';
import type { Config } from './types.js';

/**
 * Current persisted schema version. Bump this in lockstep with the
 * `schemaVersion: z.literal(N)` field in `ConfigSchema` whenever a breaking
 * change to the config shape is introduced.
 */
export const CURRENT_SCHEMA_VERSION = 1 as const;

/**
 * Discriminator codes attached to every `MigrationError`. They give the
 * persistence layer (Task 3.1) a stable hook to decide between
 *   - `INVALID_INPUT`     → seed defaults / re-run the wizard,
 *   - `UNSUPPORTED_VERSION` → keep the plugin in `CONFIG_REQUIRED` and
 *     surface a clear error in the dashboard (design.md §Error Handling).
 */
export type MigrationErrorCode = 'UNSUPPORTED_VERSION' | 'INVALID_INPUT';

/**
 * Typed error thrown by {@link migrate} when the input cannot be coerced
 * into a known schema version. The `code` field is read-only so downstream
 * code can pattern-match on it without worrying about mutation.
 */
export class MigrationError extends Error {
  public readonly code: MigrationErrorCode;

  public constructor(message: string, code: MigrationErrorCode) {
    super(message);
    this.name = 'MigrationError';
    this.code = code;
    // Preserve a clean prototype chain across the ES2022 → CJS boundary.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Type guard for plain object inputs. Arrays, `null`, and primitives are
 * rejected — the persisted config must be a JSON object. Functions are
 * already excluded by `typeof value === 'object'`.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Refresh legacy mode-threshold defaults that are baked into older persisted
 * configs. The SUMMER_WATCH thresholds were lowered (forecast 24 → 20 °C,
 * outdoor 22 → 18 °C); these values are NOT user-editable in the dashboard, so
 * any config still carrying the EXACT previous defaults is on the old default
 * and is refreshed to the new one. Surgical + idempotent: only values equal to
 * the previous defaults are touched, and fresh objects are returned so the
 * caller's input is never mutated (migrate's no-mutation contract).
 */
function refreshLegacyDefaults(
  candidate: Record<string, unknown>,
): Record<string, unknown> {
  const rules = candidate['rules'];
  if (!isPlainObject(rules)) return candidate;
  const th = rules['thresholds'];
  if (!isPlainObject(th)) return candidate;
  const needsForecast = th['summerForecastC'] === 24;
  const needsOutdoor = th['summerOutdoorC'] === 22;
  if (!needsForecast && !needsOutdoor) return candidate;
  return {
    ...candidate,
    rules: {
      ...rules,
      thresholds: {
        ...th,
        ...(needsForecast ? { summerForecastC: 20 } : {}),
        ...(needsOutdoor ? { summerOutdoorC: 18 } : {}),
      },
    },
  };
}

/**
 * Migrate an arbitrary persisted payload to the current `Config` shape.
 *
 * Behavior:
 *   1. Non-object inputs (`null`, `undefined`, primitives, arrays) raise a
 *      `MigrationError` with code `INVALID_INPUT`. The persistence layer is
 *      expected to catch this and decide whether to seed defaults / launch
 *      the wizard (Task 3.1).
 *   2. Missing `schemaVersion` is treated as a fresh, unversioned config —
 *      it is stamped with `schemaVersion: CURRENT_SCHEMA_VERSION` and run
 *      through `parseConfig` so an empty `{}` (with caller-provided
 *      `location` and `globalSignals.outdoorTemp`) flows cleanly into v1.
 *   3. A known `schemaVersion` is run through the migration switch. v1 is
 *      currently an identity transform that just defers to `parseConfig`
 *      to apply Zod defaults.
 *   4. Any other (numeric) version raises `MigrationError` with code
 *      `UNSUPPORTED_VERSION`, citing both the input and the current
 *      version so the dashboard can show a usable diff.
 *
 * Future-proofing: when a v2 is introduced, add the migration step before
 * the v1 case and let it fall through, e.g.
 *
 * ```ts
 * // case 2:
 * //   input = migrateV2toV3(input);
 * //   // fallthrough
 * // case 3:
 * //   return parseConfig(input);
 * ```
 *
 * @param input  Untrusted JSON payload, typically the result of
 *               `JSON.parse(fs.readFileSync('/data/config.json'))`.
 * @returns      A `Config` validated against the current schema.
 * @throws       {@link MigrationError} for non-object input or unsupported
 *               schema versions; `ZodError` for structural validation
 *               failures inside `parseConfig`.
 */
export function migrate(input: unknown): Config {
  if (!isPlainObject(input)) {
    throw new MigrationError(
      'Config payload must be a plain object; received ' +
        (input === null ? 'null' : Array.isArray(input) ? 'array' : typeof input),
      'INVALID_INPUT',
    );
  }

  // Work on a shallow clone so we never mutate the caller's object.
  const candidate: Record<string, unknown> = refreshLegacyDefaults({ ...input });
  const rawVersion = candidate['schemaVersion'];

  if (rawVersion === undefined) {
    candidate['schemaVersion'] = CURRENT_SCHEMA_VERSION;
    return parseConfig(candidate);
  }

  if (typeof rawVersion !== 'number' || !Number.isInteger(rawVersion)) {
    throw new MigrationError(
      `Config has a non-integer schemaVersion (${String(rawVersion)}); expected ${CURRENT_SCHEMA_VERSION}.`,
      'INVALID_INPUT',
    );
  }

  // The switch is the canonical migration ladder. New versions slot in
  // ABOVE the current case and fall through; see JSDoc above for the
  // template.
  switch (rawVersion) {
    // case 2:
    //   candidate = migrateV1toV2(candidate);
    //   // fallthrough
    case CURRENT_SCHEMA_VERSION: {
      // Identity migration for v1 — defaults are applied by parseConfig.
      return parseConfig(candidate);
    }
    default: {
      throw new MigrationError(
        `Unsupported config schemaVersion ${rawVersion}; this build understands up to ${CURRENT_SCHEMA_VERSION}.`,
        'UNSUPPORTED_VERSION',
      );
    }
  }
}

/**
 * Convenience alias for {@link migrate}. Some call sites read more clearly
 * with the verbose name — both forms are provided for documentation value
 * and refer to the exact same implementation.
 */
export const migrateAndParse: (input: unknown) => Config = migrate;
