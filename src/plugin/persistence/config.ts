/**
 * Heat Shield — atomic configuration store (Task 3.1).
 *
 * The persisted config lives at `/data/config.json` per the steering rule
 * "Persistenz nur unter `/data/`". Tests override `configPath` so they can
 * touch a per-test temp directory under `os.tmpdir()` without writing into
 * the container volume.
 *
 * Read pipeline (mirrors design.md §Error Handling):
 *
 *   ENOENT                 → { status: 'absent' }            // fresh install
 *   JSON.parse SyntaxError → { status: 'invalid_json' }      // file corrupt
 *   MigrationError(UV)     → { status: 'unsupported_version' }
 *   MigrationError(II)     → { status: 'invalid_schema' }
 *   ZodError               → { status: 'invalid_schema' }
 *   success                → { status: 'ok', config }
 *
 * Write pipeline:
 *
 *   parseConfig(config)        // defensive, idempotent on a valid Config
 *   atomicWriteJson(target,…)  // shared helper, see _atomic.ts
 *
 * The atomic write logic itself (write-temp + rename + Windows fallback)
 * is factored into `./_atomic.ts` so both the config store and the runtime
 * state store (Task 3.2) use the exact same primitive. There is only one
 * place in the codebase that knows how to consistently flush a JSON file
 * to `/data/`.
 *
 * No logging, no Connect API artifacts. Logging is layered on in Task 6
 * once the structured logger exists.
 */

import { promises as fs } from 'node:fs';

import { ZodError } from 'zod';

import { migrate, MigrationError } from '../../shared/migrate.js';
import { parseConfig } from '../../shared/schema.js';
import type { Config } from '../../shared/types.js';
import { atomicWriteJson } from './_atomic.js';

/**
 * Default location of the persisted config inside the plugin container.
 * Tests must override via {@link ConfigStoreOptions.configPath}.
 */
export const DEFAULT_CONFIG_PATH = '/data/config.json';

/**
 * Optional overrides for the persistence functions. Currently only carries
 * the target file path; further knobs (e.g. fsync) can be added without a
 * breaking change.
 */
export interface ConfigStoreOptions {
  configPath?: string;
}

/**
 * Discriminator for {@link ConfigReadResult.status}. The dashboard branches
 * directly on this so the wizard / ERROR / READY transitions stay legible.
 */
export type ConfigReadStatus =
  | 'ok'
  | 'absent'
  | 'invalid_json'
  | 'invalid_schema'
  | 'unsupported_version';

/**
 * Structured outcome of {@link readConfig}. `config` is non-null only when
 * `status === 'ok'`. `error` carries the underlying cause for the three
 * error statuses; it is omitted on `ok` and `absent`.
 */
export interface ConfigReadResult {
  config: Config | null;
  status: ConfigReadStatus;
  error?: Error;
}

function resolveConfigPath(options?: ConfigStoreOptions): string {
  return options?.configPath ?? DEFAULT_CONFIG_PATH;
}

/**
 * Type guard for Node's `ErrnoException` shape. We avoid `any`-casting the
 * `code` property by routing through this helper.
 */
function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return (
    err instanceof Error &&
    typeof (err as NodeJS.ErrnoException).code === 'string'
  );
}

/**
 * Read and validate the persisted config.
 *
 * Never throws for "expected" failure modes (missing file, corrupt JSON,
 * unsupported schema version, schema-invalid payload). Unexpected errors
 * (EACCES on the file itself, ENOSPC, …) are propagated.
 */
export async function readConfig(
  options?: ConfigStoreOptions,
): Promise<ConfigReadResult> {
  const target = resolveConfigPath(options);

  let raw: string;
  try {
    raw = await fs.readFile(target, 'utf8');
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') {
      return { config: null, status: 'absent' };
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    if (err instanceof SyntaxError) {
      return { config: null, status: 'invalid_json', error: err };
    }
    throw err;
  }

  try {
    const config = migrate(parsed);
    return { config, status: 'ok' };
  } catch (err) {
    if (err instanceof MigrationError) {
      const status: ConfigReadStatus =
        err.code === 'UNSUPPORTED_VERSION'
          ? 'unsupported_version'
          : 'invalid_schema';
      return { config: null, status, error: err };
    }
    if (err instanceof ZodError) {
      return { config: null, status: 'invalid_schema', error: err };
    }
    throw err;
  }
}

/**
 * Write a validated config to disk atomically (writeFile to a sibling temp
 * file, then rename onto the target — see {@link atomicWriteJson}).
 *
 * The caller is expected to pass a `Config` that has already passed schema
 * validation; the leading `parseConfig` call is a defensive belt-and-braces
 * check that throws a `ZodError` on a malformed payload before we touch
 * the filesystem.
 */
export async function writeConfig(
  config: Config,
  options?: ConfigStoreOptions,
): Promise<void> {
  // Defensive validation. parseConfig is idempotent on a valid Config, so
  // the only observable effect is throwing on a malformed payload before
  // we create any temp files.
  parseConfig(config);

  const target = resolveConfigPath(options);
  await atomicWriteJson(target, config);
}

/**
 * Read the persisted config; if the file is absent, call `seed()` to
 * produce a default `Config`, write it, and return it.
 *
 * Any other error status (`invalid_json`, `invalid_schema`,
 * `unsupported_version`) is rethrown via the underlying `error` so the
 * caller can decide whether to surface ERROR vs CONFIG_REQUIRED on the
 * dashboard.
 */
export async function readOrSeed(
  seed: () => Config,
  options?: ConfigStoreOptions,
): Promise<Config> {
  const result = await readConfig(options);

  if (result.status === 'ok' && result.config !== null) {
    return result.config;
  }
  if (result.status === 'absent') {
    const seeded = seed();
    await writeConfig(seeded, options);
    return seeded;
  }

  throw (
    result.error ??
    new Error(`Cannot read persisted config: status=${result.status}`)
  );
}
