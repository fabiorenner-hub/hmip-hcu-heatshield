/**
 * Unit tests for the pure OTA modules: semver, manifest, verify, github asset
 * resolution, and the bootstrap loader's `decideBundle` decision matrix.
 */

import { describe, it, expect } from 'vitest';

import { compareSemver, isNewer, isAtLeast, parseSemver } from '../../src/plugin/ota/semver.js';
import { parseManifest } from '../../src/plugin/ota/manifest.js';
import { sha256Hex, sha256Matches, verifySignature } from '../../src/plugin/ota/verify.js';
import { parseRelease, findOtaAssets } from '../../src/plugin/ota/github.js';
import { decideBundle } from '../../src/bootstrap/loader.js';
import { isSafeBundlePath, parseBundleFile } from '../../src/plugin/ota/installer.js';

describe('semver', () => {
  it('parses with optional v prefix and build/pre tails', () => {
    expect(parseSemver('v2.0.22')).toEqual([2, 0, 22]);
    expect(parseSemver('2.0.22+build.1')).toEqual([2, 0, 22]);
    expect(parseSemver('2.0.22-rc.1')).toEqual([2, 0, 22]);
  });
  it('compares numerically (not lexically)', () => {
    expect(compareSemver('2.0.10', '2.0.9')).toBe(1);
    expect(compareSemver('v2.0.9', '2.0.10')).toBe(-1);
    expect(compareSemver('2.0.0', '2.0.0')).toBe(0);
    expect(isNewer('2.1.0', '2.0.99')).toBe(true);
    expect(isAtLeast('2.0.0', '2.0.0')).toBe(true);
    expect(isAtLeast('1.9.0', '2.0.0')).toBe(false);
  });
});

describe('manifest', () => {
  const base = {
    version: 'v2.1.0',
    minCoreVersion: 'v2.0.22',
    sha256: 'a'.repeat(64),
    assetUrl: 'https://github.com/x/y/releases/download/v2.1.0/heatshield-ota-2.1.0.json',
    bundleName: 'heatshield-ota-2.1.0.json',
  };
  it('accepts a valid manifest', () => {
    expect(parseManifest(base)).not.toBeNull();
  });
  it('rejects http (non-https) asset url', () => {
    expect(parseManifest({ ...base, assetUrl: 'http://evil/x.json' })).toBeNull();
  });
  it('rejects a bad sha256 length', () => {
    expect(parseManifest({ ...base, sha256: 'abc' })).toBeNull();
  });
  it('rejects a missing field', () => {
    const { minCoreVersion, ...rest } = base;
    void minCoreVersion;
    expect(parseManifest(rest)).toBeNull();
  });
});

describe('verify', () => {
  it('sha256 matches known bytes', () => {
    const bytes = new TextEncoder().encode('heat shield');
    const hex = sha256Hex(bytes);
    expect(hex).toMatch(/^[0-9a-f]{64}$/u);
    expect(sha256Matches(bytes, hex)).toBe(true);
    expect(sha256Matches(bytes, 'b'.repeat(64))).toBe(false);
  });
  it('signature check is a no-op when no key/sig provided', () => {
    const bytes = new TextEncoder().encode('x');
    expect(verifySignature(bytes, undefined, undefined)).toBe(true);
    expect(verifySignature(bytes, 'sig', undefined)).toBe(true);
  });
});

describe('github asset resolution', () => {
  it('parses a release and finds the three OTA assets', () => {
    const rel = parseRelease({
      tag_name: 'v2.1.0',
      html_url: 'https://github.com/x/y/releases/tag/v2.1.0',
      assets: [
        { name: 'ota-manifest-2.1.0.json', browser_download_url: 'https://x/ota-manifest-2.1.0.json' },
        { name: 'heatshield-ota-2.1.0.json', browser_download_url: 'https://x/heatshield-ota-2.1.0.json' },
        { name: 'heatshield-ota-2.1.0.json.sha256', browser_download_url: 'https://x/heatshield-ota-2.1.0.json.sha256' },
        { name: 'heatshield-2.1.0-arm64.tar.gz', browser_download_url: 'https://x/heatshield-2.1.0-arm64.tar.gz' },
        { name: 'insecure', browser_download_url: 'http://x/insecure' },
      ],
    });
    expect(rel).not.toBeNull();
    const found = findOtaAssets(rel!);
    expect(found.manifest?.name).toBe('ota-manifest-2.1.0.json');
    expect(found.bundle?.name).toBe('heatshield-ota-2.1.0.json');
    expect(found.sha256?.name).toBe('heatshield-ota-2.1.0.json.sha256');
    // The http asset was dropped (https-only).
    expect(rel!.assets.some((a) => a.url.startsWith('http://'))).toBe(false);
  });
});

describe('decideBundle', () => {
  const M = { version: 'v2.1.0', minCoreVersion: 'v2.0.0', sha256: 'a'.repeat(64) };
  const inp = (o: Partial<Parameters<typeof decideBundle>[0]> = {}): Parameters<typeof decideBundle>[0] => ({
    coreVersion: '2.0.22',
    hasActiveBundle: true,
    manifest: M,
    sha256Match: true,
    bootAttempts: 0,
    maxBootAttempts: 3,
    ...o,
  });
  it('loads OTA when everything is valid', () => {
    expect(decideBundle(inp())).toEqual({ kind: 'ota', version: 'v2.1.0' });
  });
  it('falls back to image (no quarantine) when no bundle', () => {
    expect(decideBundle(inp({ hasActiveBundle: false }))).toEqual({ kind: 'image', quarantineDir: false, reason: 'no-ota' });
  });
  it('quarantines on invalid manifest', () => {
    expect(decideBundle(inp({ manifest: null }))).toEqual({ kind: 'image', quarantineDir: true, reason: 'manifest-invalid' });
  });
  it('quarantines on sha256 mismatch', () => {
    expect(decideBundle(inp({ sha256Match: false }))).toEqual({ kind: 'image', quarantineDir: true, reason: 'sha256-mismatch' });
  });
  it('refuses (no quarantine) when core too old', () => {
    expect(decideBundle(inp({ coreVersion: '1.9.0' }))).toEqual({ kind: 'image', quarantineDir: false, reason: 'requires-core' });
  });
  it('quarantines on crash-loop', () => {
    expect(decideBundle(inp({ bootAttempts: 3 }))).toEqual({ kind: 'image', quarantineDir: true, reason: 'crash-loop' });
  });
  it('runs the image (no quarantine) when the core is NEWER than the OTA payload', () => {
    // Freshly installed core 2.1.0 supersedes an older 2.0.30 OTA payload.
    expect(
      decideBundle(inp({ coreVersion: '2.1.0', manifest: { version: 'v2.0.30', minCoreVersion: 'v2.0.0', sha256: 'a'.repeat(64) } })),
    ).toEqual({ kind: 'image', quarantineDir: false, reason: 'core-supersedes' });
  });
  it('runs the image when core == OTA core and the OTA has no build tail', () => {
    expect(
      decideBundle(inp({ coreVersion: '2.1.0', manifest: { version: 'v2.1.0', minCoreVersion: 'v2.0.0', sha256: 'a'.repeat(64) } })),
    ).toEqual({ kind: 'image', quarantineDir: false, reason: 'core-supersedes' });
  });
  it('runs an EXPERIMENTAL OTA (same core + build stamp) over the image', () => {
    expect(
      decideBundle(inp({ coreVersion: '2.1.0', manifest: { version: 'v2.1.0+exp.20260714T120000Z', minCoreVersion: 'v2.0.0', sha256: 'a'.repeat(64) } })),
    ).toEqual({ kind: 'ota', version: 'v2.1.0+exp.20260714T120000Z' });
  });
});

describe('installer helpers', () => {
  it('accepts main.js and public/ paths, rejects traversal', () => {
    expect(isSafeBundlePath('main.js')).toBe(true);
    expect(isSafeBundlePath('public/app.js')).toBe(true);
    expect(isSafeBundlePath('public/assets/x.png')).toBe(true);
    expect(isSafeBundlePath('../etc/passwd')).toBe(false);
    expect(isSafeBundlePath('/abs')).toBe(false);
    expect(isSafeBundlePath('public/../../x')).toBe(false);
    expect(isSafeBundlePath('other.js')).toBe(false);
    expect(isSafeBundlePath('C:/x')).toBe(false);
  });
  it('parses a valid bundle file and rejects a bad one', () => {
    const good = JSON.stringify({
      format: 'heatshield-ota-1',
      version: 'v2.1.0',
      files: { 'main.js': Buffer.from('x').toString('base64'), 'public/app.js': Buffer.from('y').toString('base64') },
    });
    const parsed = parseBundleFile(new TextEncoder().encode(good));
    expect(parsed?.version).toBe('v2.1.0');
    // Missing main.js → rejected.
    const noMain = JSON.stringify({ format: 'heatshield-ota-1', version: 'v2.1.0', files: { 'public/app.js': 'eQ==' } });
    expect(parseBundleFile(new TextEncoder().encode(noMain))).toBeNull();
    // Unsafe path → rejected.
    const traversal = JSON.stringify({ format: 'heatshield-ota-1', version: 'v2.1.0', files: { 'main.js': 'eA==', '../x': 'eA==' } });
    expect(parseBundleFile(new TextEncoder().encode(traversal))).toBeNull();
    // Wrong format → rejected.
    expect(parseBundleFile(new TextEncoder().encode('{"format":"nope","version":"v1.0.0","files":{}}'))).toBeNull();
  });
});
