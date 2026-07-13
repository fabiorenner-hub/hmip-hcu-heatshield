/**
 * Heat Shield — OTA installer: download → verify → atomic activate.
 *
 * The OTA payload is a single JSON "bundle file" that maps relative paths to
 * base64 content (`main.js` + `public/*`). Using JSON+base64 (instead of tar/
 * zip) keeps extraction to node built-ins only and makes it trivial to guard
 * against path traversal. The build script produces this file; the manifest's
 * `sha256` covers exactly its bytes.
 *
 * Flow (all under `<dataDir>/ota/`):
 *   1. download the bundle bytes,
 *   2. sha256(bytes) === manifest.sha256   (mandatory) [+ optional .sha256 file],
 *   3. optional Ed25519 signature over the bytes,
 *   4. parse JSON, sanity-check format/version,
 *   5. write each sanitized file into `staging/<version>/` (temp),
 *   6. atomically activate: replace `active/` via rename.
 *
 * If ANY step fails, `active/` is left untouched and `staging/` is discarded.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import type { OtaManifest } from './manifest.js';
import type { ReleaseAsset, FetchLike } from './github.js';
import { sha256Hex, sha256Matches, verifySignature } from './verify.js';

export interface OtaBundleFile {
  format: string;
  version: string;
  files: Record<string, string>; // relative path → base64
}

export type InstallResult =
  | { ok: true; version: string }
  | { ok: false; reason: 'download-failed' | 'verify-failed' | 'bad-bundle'; detail: string };

export interface InstallerDeps {
  readonly dataDir: string;
  readonly fetchImpl: FetchLike;
  /** Optional Ed25519 public key (PEM). Absent → signature check is a no-op. */
  readonly publicKeyPem?: string | undefined;
  readonly logger?: (level: 'info' | 'warn', msg: string) => void;
}

const BUNDLE_FORMAT = 'heatshield-ota-1';

function otaDir(dataDir: string): string {
  return path.join(dataDir, 'ota');
}

/**
 * Only allow `main.js` and files under `public/`. Reject absolute paths,
 * backslashes and any `..` segment (path-traversal / zip-slip guard).
 */
export function isSafeBundlePath(rel: string): boolean {
  if (rel.length === 0) return false;
  if (rel.includes('\\') || rel.startsWith('/') || /^[A-Za-z]:/u.test(rel)) return false;
  const segs = rel.split('/');
  if (segs.some((s) => s === '..' || s === '.' || s === '')) return false;
  return rel === 'main.js' || rel.startsWith('public/');
}

/** Parse + shallow-validate a bundle file. */
export function parseBundleFile(bytes: Uint8Array): OtaBundleFile | null {
  let obj: unknown;
  try {
    obj = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    return null;
  }
  if (obj === null || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  if (o['format'] !== BUNDLE_FORMAT) return null;
  if (typeof o['version'] !== 'string') return null;
  const files = o['files'];
  if (files === null || typeof files !== 'object' || Array.isArray(files)) return null;
  const rec = files as Record<string, unknown>;
  for (const [k, v] of Object.entries(rec)) {
    if (typeof v !== 'string' || !isSafeBundlePath(k)) return null;
  }
  if (!('main.js' in rec)) return null;
  return { format: BUNDLE_FORMAT, version: o['version'], files: rec as Record<string, string> };
}

async function download(fetchImpl: FetchLike, url: string): Promise<Uint8Array | null> {
  try {
    const res = await fetchImpl(url, { headers: { 'User-Agent': 'heatshield-ota' } });
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/** Download + verify + activate one payload described by `manifest`. */
export async function installBundle(
  deps: InstallerDeps,
  args: { manifest: OtaManifest; bundle: ReleaseAsset; sha256?: ReleaseAsset | null },
): Promise<InstallResult> {
  const log = deps.logger ?? ((): void => undefined);
  const { manifest } = args;

  const bytes = await download(deps.fetchImpl, args.bundle.url);
  if (bytes === null) return { ok: false, reason: 'download-failed', detail: 'bundle download failed' };

  // 2. Mandatory sha256 vs manifest (+ optional secondary .sha256 file).
  if (!sha256Matches(bytes, manifest.sha256)) {
    return { ok: false, reason: 'verify-failed', detail: 'sha256 != manifest' };
  }
  if (args.sha256 !== undefined && args.sha256 !== null) {
    try {
      const res = await deps.fetchImpl(args.sha256.url, { headers: { 'User-Agent': 'heatshield-ota' } });
      if (res.ok) {
        const first = (await res.text()).trim().split(/\s+/u)[0] ?? '';
        if (first.length === 64 && first.toLowerCase() !== manifest.sha256.toLowerCase()) {
          return { ok: false, reason: 'verify-failed', detail: 'sha256 file mismatch' };
        }
      }
    } catch {
      // Secondary file is best-effort; the mandatory manifest check already passed.
    }
  }

  // 3. Optional signature.
  if (!verifySignature(bytes, manifest.signature, deps.publicKeyPem)) {
    return { ok: false, reason: 'verify-failed', detail: 'signature invalid' };
  }

  // 4. Parse bundle + cross-check version.
  const parsed = parseBundleFile(bytes);
  if (parsed === null) return { ok: false, reason: 'bad-bundle', detail: 'unparseable/invalid bundle' };
  if (parsed.version !== manifest.version) {
    return { ok: false, reason: 'bad-bundle', detail: 'bundle version != manifest' };
  }

  // 5. Write into a fresh staging dir.
  //
  // The manifest's `sha256` covers the whole bundle *file* (JSON+base64), which
  // was verified in step 2 against the downloaded bytes. The bootstrap loader,
  // however, only sees the *extracted* `main.js` on disk at boot — it cannot
  // re-hash the transient bundle. So we compute and persist `mainSha256` (the
  // hash of the decoded `main.js` bytes) into the loader-visible manifest, and
  // the loader verifies exactly that on every boot. Without this, the loader
  // compared main.js's hash to the bundle-file hash and ALWAYS quarantined a
  // freshly installed payload.
  const mainSha256 = sha256Hex(Buffer.from(parsed.files['main.js'] ?? '', 'base64'));
  const base = otaDir(deps.dataDir);
  const staging = path.join(base, 'staging', manifest.version);
  const active = path.join(base, 'active');
  try {
    await fs.rm(staging, { recursive: true, force: true });
    await fs.mkdir(staging, { recursive: true });
    for (const [rel, b64] of Object.entries(parsed.files)) {
      const dest = path.join(staging, rel);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, Buffer.from(b64, 'base64'));
    }
    // Persist the verified manifest alongside the payload for the loader,
    // augmented with the per-file `mainSha256` the loader actually checks.
    await fs.writeFile(
      path.join(staging, 'manifest.json'),
      `${JSON.stringify({ ...manifest, mainSha256 }, null, 2)}\n`,
      'utf8',
    );
  } catch (err) {
    return { ok: false, reason: 'bad-bundle', detail: `staging write failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  // 6. Activate atomically: swap `active` for the freshly staged dir.
  try {
    const trash = path.join(base, `active.old.${Date.now()}`);
    try {
      await fs.rename(active, trash);
    } catch {
      // No prior active dir — fine.
    }
    await fs.rename(staging, active);
    void fs.rm(trash, { recursive: true, force: true }).catch(() => undefined);
  } catch (err) {
    return { ok: false, reason: 'bad-bundle', detail: `activate failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  log('info', `OTA bundle ${manifest.version} installed and activated`);
  return { ok: true, version: manifest.version };
}
