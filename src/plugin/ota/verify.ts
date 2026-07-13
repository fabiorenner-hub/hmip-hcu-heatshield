/**
 * Heat Shield — OTA verification primitives (pure, node:crypto only).
 *
 * `sha256Hex` is the MANDATORY integrity check applied to every downloaded
 * bundle before it is activated. `verifySignature` is the OPTIONAL Ed25519
 * signature check: when no signature or no public key is configured it is a
 * no-op that returns `true` (Phase 2 — turns strict once a key is provisioned).
 */

import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';

/** Lowercase hex SHA-256 of the given bytes. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Constant-time-ish comparison of two hex digests (case-insensitive). */
export function sha256Matches(bytes: Uint8Array, expectedHex: string): boolean {
  const actual = sha256Hex(bytes).toLowerCase();
  const expected = expectedHex.trim().toLowerCase();
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i += 1) {
    diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Verify an Ed25519 signature over `bytes`.
 *
 *   - `signatureB64 === undefined` OR `publicKeyPem === undefined/empty`
 *     → no-op, returns `true` (signature optional in Phase 1).
 *   - Otherwise the base64 signature is checked against the PEM public key;
 *     any error (bad key, bad signature) returns `false`.
 */
export function verifySignature(
  bytes: Uint8Array,
  signatureB64: string | undefined,
  publicKeyPem: string | undefined,
): boolean {
  if (signatureB64 === undefined || publicKeyPem === undefined || publicKeyPem.trim() === '') {
    return true;
  }
  try {
    const key = createPublicKey(publicKeyPem);
    const sig = Buffer.from(signatureB64, 'base64');
    // Ed25519: algorithm arg must be null.
    return cryptoVerify(null, Buffer.from(bytes), key, sig);
  } catch {
    return false;
  }
}
