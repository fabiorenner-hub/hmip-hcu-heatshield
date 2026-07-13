/**
 * OTA state + installer integration tests (temp FS + fake fetch).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { readOtaState, writeOtaState, emptyOtaState } from '../../src/plugin/ota/state.js';
import { installBundle } from '../../src/plugin/ota/installer.js';
import { sha256Hex } from '../../src/plugin/ota/verify.js';
import type { OtaManifest } from '../../src/plugin/ota/manifest.js';
import type { FetchLike } from '../../src/plugin/ota/github.js';

let dir = '';

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hs-ota-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function bundleBytes(version: string): Uint8Array {
  const json = JSON.stringify({
    format: 'heatshield-ota-1',
    version,
    files: {
      'main.js': Buffer.from('export async function main(){}').toString('base64'),
      'public/app.js': Buffer.from('console.log(1)').toString('base64'),
    },
  });
  return new TextEncoder().encode(json);
}

function fakeFetch(bytes: Uint8Array): FetchLike {
  return (async () => ({
    ok: true,
    status: 200,
    json: async () => JSON.parse(Buffer.from(bytes).toString('utf8')),
    text: async () => Buffer.from(bytes).toString('utf8'),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  })) as unknown as FetchLike;
}

describe('OTA state', () => {
  it('returns default on missing/corrupt and round-trips a write', async () => {
    expect(await readOtaState(dir)).toEqual(emptyOtaState());
    await writeOtaState(dir, { activeVersion: 'v2.1.0', bootAttempts: 2, lastGoodAt: null, quarantined: ['v2.0.9'] });
    const s = await readOtaState(dir);
    expect(s.activeVersion).toBe('v2.1.0');
    expect(s.bootAttempts).toBe(2);
    expect(s.quarantined).toEqual(['v2.0.9']);
    // Corrupt file → default.
    await fs.writeFile(path.join(dir, 'ota', 'state.json'), '{ not json', 'utf8');
    expect(await readOtaState(dir)).toEqual(emptyOtaState());
  });
});

describe('installBundle', () => {
  it('downloads, verifies and activates a valid bundle', async () => {
    const bytes = bundleBytes('v2.1.0');
    const manifest: OtaManifest = {
      version: 'v2.1.0',
      minCoreVersion: 'v2.0.0',
      sha256: sha256Hex(bytes),
      assetUrl: 'https://x/heatshield-ota-2.1.0.json',
      bundleName: 'heatshield-ota-2.1.0.json',
    };
    const res = await installBundle(
      { dataDir: dir, fetchImpl: fakeFetch(bytes) },
      { manifest, bundle: { name: manifest.bundleName, url: manifest.assetUrl }, sha256: null },
    );
    expect(res.ok).toBe(true);
    // active/ populated.
    expect(await fs.readFile(path.join(dir, 'ota', 'active', 'main.js'), 'utf8')).toContain('main');
    expect(await fs.readFile(path.join(dir, 'ota', 'active', 'public', 'app.js'), 'utf8')).toContain('console.log');
    const activeManifest = JSON.parse(await fs.readFile(path.join(dir, 'ota', 'active', 'manifest.json'), 'utf8')) as OtaManifest;
    expect(activeManifest.version).toBe('v2.1.0');
  });

  it('leaves active/ untouched when sha256 does not match', async () => {
    const bytes = bundleBytes('v2.1.0');
    const manifest: OtaManifest = {
      version: 'v2.1.0',
      minCoreVersion: 'v2.0.0',
      sha256: 'f'.repeat(64), // wrong
      assetUrl: 'https://x/b.json',
      bundleName: 'b.json',
    };
    const res = await installBundle(
      { dataDir: dir, fetchImpl: fakeFetch(bytes) },
      { manifest, bundle: { name: 'b.json', url: manifest.assetUrl }, sha256: null },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('verify-failed');
    // No active dir created.
    await expect(fs.access(path.join(dir, 'ota', 'active'))).rejects.toBeTruthy();
  });
});
