/**
 * Heat Shield — OTA manifest schema (Zod) + parser.
 *
 * The manifest is a small JSON published as a GitHub release asset
 * (`ota-manifest-<v>.json`). It describes ONE payload bundle: its version, the
 * minimum core (image) version it needs, the bundle's sha256, an https asset
 * URL, the asset filename, and an optional Ed25519 signature.
 *
 * Guardrails baked into the schema:
 *   - `sha256` must be 64 hex chars.
 *   - `assetUrl` must be a valid `https:` URL (no plain http, no other scheme).
 *   - `version` / `minCoreVersion` must look like `vX.Y.Z` / `X.Y.Z`.
 */

import { z } from 'zod';

const SEMVER_RE = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;
const SHA256_RE = /^[0-9a-f]{64}$/iu;

export const OtaManifestSchema = z.object({
  version: z.string().regex(SEMVER_RE, 'version must be X.Y.Z'),
  minCoreVersion: z.string().regex(SEMVER_RE, 'minCoreVersion must be X.Y.Z'),
  sha256: z.string().regex(SHA256_RE, 'sha256 must be 64 hex chars'),
  assetUrl: z
    .string()
    .url()
    .refine((u) => u.startsWith('https://'), 'assetUrl must be https'),
  bundleName: z.string().min(1),
  signature: z.string().min(1).optional(),
  notes: z.string().optional(),
});

export type OtaManifest = z.infer<typeof OtaManifestSchema>;

/** Parse + validate a manifest object; returns null on any violation. */
export function parseManifest(raw: unknown): OtaManifest | null {
  const res = OtaManifestSchema.safeParse(raw);
  return res.success ? res.data : null;
}

/** Parse a manifest from a JSON string; returns null on parse/validation error. */
export function parseManifestJson(json: string): OtaManifest | null {
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch {
    return null;
  }
  return parseManifest(obj);
}
