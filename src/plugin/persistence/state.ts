/**
 * Heat Shield — runtime state store (Task 3.2).
 *
 * Persists the engine's working memory at `/data/state.json`. Tests
 * override `statePath` to redirect writes into a per-test temp directory.
 *
 * Read pipeline — DELIBERATELY discards corrupt files:
 *
 *   ENOENT                  → null
 *   JSON.parse SyntaxError  → null + best-effort unlink(file)
 *   safeParseState(...)→FAIL → null + best-effort unlink(file)
 *   success                 → RuntimeState
 *
 * Why discard? State is *rebuildable* — every field can be reconstructed
 * from observed device events plus a clean default (`null` /
 * `engineConfirmed: false`). The plugin's worst failure mode is being
 * stuck unable to start because of a stale `state.json`; losing the
 * memory of `manualOverrideUntil` and `lastCommandedLevel01` for one
 * cycle is recoverable. So we prefer "lose memory" over "stuck plugin".
 *
 * Write pipeline:
 *
 *   atomicWriteJson(target, state)   // shared helper, see _atomic.ts
 *
 * No logging, no engine logic. The orchestrator (Task 8) is responsible
 * for sequencing reads/writes and producing well-formed `RuntimeState`
 * payloads.
 */

import { promises as fs } from 'node:fs';

import {
  OwnSwitchIdSchema,
  safeParseState,
} from '../../shared/state-schema.js';
import type {
  OwnSwitchState,
  RuntimeState,
  WindowRuntimeState,
} from '../../shared/state-schema.js';
import { atomicWriteJson } from './_atomic.js';

/**
 * Default location of the persisted runtime state inside the plugin
 * container. Tests must override via {@link StateStoreOptions.statePath}.
 */
export const DEFAULT_STATE_PATH = '/data/state.json';

/**
 * Optional overrides for the persistence functions. Currently only
 * carries the target file path; further knobs (e.g. fsync) can be added
 * without a breaking change.
 */
export interface StateStoreOptions {
  statePath?: string;
}

function resolveStatePath(options?: StateStoreOptions): string {
  return options?.statePath ?? DEFAULT_STATE_PATH;
}

/**
 * Type guard for Node's `ErrnoException` shape. We avoid `any`-casting
 * the `code` property by routing through this helper.
 */
function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return (
    err instanceof Error &&
    typeof (err as NodeJS.ErrnoException).code === 'string'
  );
}

/**
 * Best-effort delete. Used when the state file is corrupt or
 * schema-invalid; we want the next cycle to start clean rather than
 * keep returning `null` while a poison file sits on disk.
 */
async function bestEffortUnlink(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch {
    // The file may already be gone, the directory may be read-only, or
    // we may be racing another writer. None of those are fatal: the
    // caller has already returned `null`, so the next cycle will write
    // a fresh state.json on top.
  }
}

/**
 * Read and validate the persisted runtime state.
 *
 * Returns `null` for *every* expected failure mode (missing file,
 * corrupt JSON, schema-invalid payload). On the corrupt / schema-invalid
 * branches the file is best-effort unlinked so the next cycle starts
 * clean — see the module-level comment for rationale.
 *
 * Concurrency note: on Windows, opening the state file while another
 * writer is mid-`rename` can briefly surface `EBUSY` / `EPERM` /
 * `EACCES`. These are transient and not corruption, so we retry the
 * `readFile` a few times before giving up. POSIX hosts never observe
 * these codes for a regular file; the loop exits on the first
 * iteration there.
 *
 * Unexpected I/O errors (EACCES on the file itself once retries are
 * exhausted, ENOSPC, …) are propagated.
 */
export async function readState(
  options?: StateStoreOptions,
): Promise<RuntimeState | null> {
  const target = resolveStatePath(options);

  const transientCodes: ReadonlySet<string> = new Set([
    'EBUSY',
    'EPERM',
    'EACCES',
  ]);
  const maxAttempts = 8;

  let raw: string | null = null;
  for (let attempt = 0; attempt < maxAttempts && raw === null; attempt += 1) {
    try {
      raw = await fs.readFile(target, 'utf8');
    } catch (err) {
      if (isErrnoException(err) && err.code === 'ENOENT') {
        return null;
      }
      if (
        attempt + 1 < maxAttempts &&
        isErrnoException(err) &&
        transientCodes.has(err.code ?? '')
      ) {
        await new Promise((resolve) =>
          setTimeout(resolve, 25 + attempt * 25),
        );
        continue;
      }
      throw err;
    }
  }
  if (raw === null) {
    // Exhausted retries on a transient code without ever succeeding.
    // Treat as "no readable state right now" — the next cycle will
    // try again.
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    if (err instanceof SyntaxError) {
      await bestEffortUnlink(target);
      return null;
    }
    throw err;
  }

  const result = safeParseState(parsed);
  if (!result.success) {
    await bestEffortUnlink(target);
    return null;
  }
  return result.data;
}

/**
 * Write the runtime state to disk atomically (writeFile to a sibling
 * temp file, then rename onto the target — see {@link atomicWriteJson}).
 *
 * The caller is expected to pass a `RuntimeState` produced by the
 * factories below or by mutating a value already returned from
 * `readState`. There is no defensive `parseState` re-validation here
 * because the engine paths that produce state already build it from
 * type-checked structs; the test suite enforces that
 * `emptyRuntimeState()` and `createWindowRuntimeState(...)` round-trip
 * cleanly.
 */
export async function writeState(
  state: RuntimeState,
  options?: StateStoreOptions,
): Promise<void> {
  const target = resolveStatePath(options);
  await atomicWriteJson(target, state);
}

/**
 * Factory returning a zero-state for fresh containers.
 *
 *   - No mode chosen yet (`currentMode: null`).
 *   - No cycle has been run (`lastCycleAt: null`).
 *   - No windows known (`windows: []`); the orchestrator appends one
 *     entry via {@link createWindowRuntimeState} the first time it sees
 *     a window in the config.
 *   - All five own SWITCH devices start in `value: false,
 *     engineConfirmed: false`. The Connect layer must not emit
 *     STATUS_EVENT until the engine flips `engineConfirmed` on.
 *   - No storm hold (`stormHoldUntil: null`).
 *
 * The order of `ownSwitches` matches the canonical id list in
 * `OwnSwitchIdSchema`. Downstream code may rely on the order being
 * stable.
 */
export function emptyRuntimeState(): RuntimeState {
  const now = new Date().toISOString();
  const ownSwitches: OwnSwitchState[] = OwnSwitchIdSchema.options.map((id) => ({
    id,
    value: false,
    engineConfirmed: false,
    updatedAt: now,
  }));

  return {
    schemaVersion: 1,
    currentMode: null,
    lastCycleAt: null,
    windows: [],
    ownSwitches,
    stormHoldUntil: null,
    userIntent: {
      paused: false,
      pauseUntil: null,
      vacation: false,
    },
    indoorPeak: null,
  };
}

/**
 * Factory used when the orchestrator first sees a new window. The
 * caller must append the returned value to `RuntimeState.windows` —
 * this function does not own the surrounding state object.
 */
export function createWindowRuntimeState(
  windowId: string,
): WindowRuntimeState {
  return {
    windowId,
    lastCommandedLevel01: null,
    lastCommandedAt: null,
    manualOverrideUntil: null,
    lastDecisionMode: null,
    shade: { state: 'open', shadedSince: null, belowReleaseSince: null },
  };
}
