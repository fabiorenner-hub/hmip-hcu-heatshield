/**
 * Heat Shield — atomic JSON write helper (Task 3.2).
 *
 * Both `config.ts` (`/data/config.json`) and `state.ts`
 * (`/data/state.json`) need the exact same write semantics:
 *
 *   1. ensure the parent directory exists,
 *   2. serialize the payload as pretty-printed JSON with trailing newline,
 *   3. write to a sibling temp file (`<basename>.<pid>.<rand>.tmp`),
 *   4. atomically `rename(tempPath, target)` — on POSIX this is atomic by
 *      definition, on Win10+ NTFS `MoveFileEx` is documented as atomic too,
 *   5. on Windows, fall back to `copyFile` when the rename trips an EPERM /
 *      EACCES / EEXIST / EBUSY (AV scanner, indexer, container layer, or a
 *      racing writer holds the target open briefly). This branch is
 *      best-effort and not atomic; POSIX hosts never reach it.
 *   6. retry the rename / copyFile a small number of times when Windows
 *      surfaces EBUSY / EPERM under heavy contention — these are
 *      transient by nature (the conflicting handle is released within
 *      milliseconds). POSIX hosts never observe these codes.
 *   7. unlink the temp file in `finally` if it has not been consumed by a
 *      successful rename.
 *
 * No logging, no schema awareness — the caller is expected to have
 * validated `payload`. The helper is colocated with the persistence layer
 * (rather than `src/shared`) so the dependency direction stays
 * "shared ← plugin", never the other way around.
 */

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/**
 * Type guard for Node's `ErrnoException` shape. Avoids `any`-casts when
 * branching on `code`.
 */
function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return (
    err instanceof Error &&
    typeof (err as NodeJS.ErrnoException).code === 'string'
  );
}

/**
 * Error codes that indicate a transient lock on Windows: another writer
 * has the file briefly open, an AV scanner is inspecting it, or NTFS is
 * still flushing the previous metadata change. POSIX hosts never raise
 * these codes for `rename` of a regular file.
 */
const WINDOWS_TRANSIENT_CODES: ReadonlySet<string> = new Set([
  'EPERM',
  'EACCES',
  'EEXIST',
  'EBUSY',
]);

/** Sleep helper — used between rename retries. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Write `payload` to `filePath` atomically as pretty-printed JSON with a
 * trailing newline.
 *
 * The caller MUST pass a JSON-serializable value. `JSON.stringify` will
 * throw on a circular structure, which propagates here unchanged.
 */
export async function atomicWriteJson(
  filePath: string,
  payload: unknown,
): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });

  const tempName =
    `${path.basename(filePath)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  const tempPath = path.join(dir, tempName);

  // Trailing newline keeps the file POSIX-compliant and reduces churn in
  // diffs when humans inspect /data/*.json directly.
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;

  // True iff a successful rename has consumed the temp file already; in
  // every other code path the finally block must clean it up.
  let tempConsumed = false;
  try {
    await fs.writeFile(tempPath, serialized, 'utf8');

    // Retry loop for the rename. POSIX `rename` of a regular file
    // either succeeds or fails with EXDEV / ENOSPC / similar
    // permanent errors — it never raises a transient code, so the
    // loop exits on the first iteration. Windows on the other hand
    // can briefly raise EPERM / EACCES / EBUSY when another writer
    // (or an AV scanner) holds the destination open; backing off and
    // retrying is the standard mitigation. We cap the total wait at
    // ~2 s (8 attempts × 250 ms) before falling through to the
    // copyFile fallback.
    const maxAttempts = 8;
    let lastErr: unknown;
    let renamed = false;
    for (let attempt = 0; attempt < maxAttempts && !renamed; attempt += 1) {
      try {
        await fs.rename(tempPath, filePath);
        renamed = true;
      } catch (err) {
        lastErr = err;
        if (
          !(
            isErrnoException(err) &&
            WINDOWS_TRANSIENT_CODES.has(err.code ?? '')
          )
        ) {
          throw err;
        }
        await sleep(25 + attempt * 25);
      }
    }
    if (renamed) {
      tempConsumed = true;
    } else {
      // Windows fallback: copyFile + unlink (the temp file is unlinked
      // in the finally block below). copyFile is best-effort and not
      // atomic; POSIX hosts never reach this branch in practice.
      // copyFile itself can also race a peer briefly, so we retry it
      // with the same backoff schedule.
      let copied = false;
      for (let attempt = 0; attempt < maxAttempts && !copied; attempt += 1) {
        try {
          await fs.copyFile(tempPath, filePath);
          copied = true;
        } catch (err) {
          lastErr = err;
          if (
            !(
              isErrnoException(err) &&
              WINDOWS_TRANSIENT_CODES.has(err.code ?? '')
            )
          ) {
            throw err;
          }
          await sleep(25 + attempt * 25);
        }
      }
      if (!copied) {
        throw lastErr instanceof Error
          ? lastErr
          : new Error('atomicWriteJson: rename and copyFile both failed');
      }
    }
  } finally {
    if (!tempConsumed) {
      try {
        await fs.unlink(tempPath);
      } catch {
        // Best-effort: the temp file may already be gone (rename succeeded
        // on a retry, another process raced us) or the directory itself
        // may have disappeared. Either way we must not mask the original
        // error from the try block.
      }
    }
  }
}
