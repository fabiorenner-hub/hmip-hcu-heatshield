/**
 * OTA experimental-channel tests (B5).
 *
 * Covers the build-aware version compare, the prerelease list fetch, and the
 * OtaManager channel selection: a `stable`-channel HCU never resolves a
 * prerelease, while an `experimental`-channel HCU picks the newest prerelease
 * and treats a same-version-but-newer-build-stamp payload as an update.
 */

import { describe, it, expect } from 'vitest';

import {
  isNewer,
  isNewerWithBuild,
  buildTail,
} from '../../src/plugin/ota/semver.js';
import {
  parseRelease,
  fetchLatestPrerelease,
  RELEASES_API,
  LATEST_RELEASE_API,
  type FetchLike,
} from '../../src/plugin/ota/github.js';
import { OtaManager } from '../../src/plugin/ota/manager.js';

describe('semver build-aware compare (experimental)', () => {
  it('buildTail extracts the +tail', () => {
    expect(buildTail('2.0.30+exp.20260715T1200Z')).toBe('exp.20260715T1200Z');
    expect(buildTail('2.0.30')).toBe('');
  });

  it('isNewerWithBuild: same core + later stamp is newer', () => {
    expect(isNewerWithBuild('2.0.30+exp.20260715T1300Z', '2.0.30+exp.20260715T1200Z')).toBe(true);
    expect(isNewerWithBuild('2.0.30+exp.20260715T1200Z', '2.0.30+exp.20260715T1300Z')).toBe(false);
  });

  it('isNewerWithBuild: equal builds are not newer', () => {
    expect(isNewerWithBuild('2.0.30+exp.1', '2.0.30+exp.1')).toBe(false);
  });

  it('isNewerWithBuild: a build tail beats the same core with no tail', () => {
    expect(isNewerWithBuild('2.0.30+exp.1', '2.0.30')).toBe(true);
  });

  it('isNewerWithBuild: a newer core wins regardless of build', () => {
    expect(isNewerWithBuild('2.0.31', '2.0.30+exp.99999')).toBe(true);
  });

  it('plain isNewer ignores build tails (stable channel)', () => {
    expect(isNewer('2.0.30+exp.2', '2.0.30+exp.1')).toBe(false);
  });
});

describe('github parseRelease / prerelease', () => {
  it('parses the prerelease flag', () => {
    expect(parseRelease({ tag_name: 'v2.0.30', prerelease: true })?.prerelease).toBe(true);
    expect(parseRelease({ tag_name: 'v2.0.30' })?.prerelease).toBe(false);
  });

  it('fetchLatestPrerelease picks the newest prerelease from the list', async () => {
    const list = [
      { tag_name: 'v2.0.30', prerelease: false, assets: [] },
      { tag_name: 'experimental', prerelease: true, html_url: 'https://x', assets: [] },
      { tag_name: 'v2.0.29', prerelease: true, assets: [] },
    ];
    const fetchImpl: FetchLike = async (url) => ({
      ok: true,
      status: 200,
      json: async () => (url === RELEASES_API ? list : null),
      text: async () => '',
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    const rel = await fetchLatestPrerelease(fetchImpl);
    expect(rel?.prerelease).toBe(true);
    expect(rel?.tagName).toBe('experimental');
  });

  it('fetchLatestPrerelease returns null when no prerelease exists', async () => {
    const fetchImpl: FetchLike = async () => ({
      ok: true,
      status: 200,
      json: async () => [{ tag_name: 'v2.0.30', prerelease: false, assets: [] }],
      text: async () => '',
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    expect(await fetchLatestPrerelease(fetchImpl)).toBeNull();
  });
});

describe('OtaManager channel selection', () => {
  const CORE = '2.0.30';
  const manifest = (version: string): string =>
    JSON.stringify({
      version,
      minCoreVersion: '2.0.0',
      sha256: 'a'.repeat(64),
      assetUrl: 'https://x/heatshield-ota.json',
      bundleName: 'heatshield-ota.json',
    });

  /** Fake GitHub: a stable v2.0.30 (no OTA assets) + an experimental prerelease
   * carrying a same-core payload with a later build stamp. */
  function makeFetch(): FetchLike {
    const preAssets = [
      { name: 'ota-manifest.json', browser_download_url: 'https://x/ota-manifest.json' },
      { name: 'heatshield-ota-2.0.30.json', browser_download_url: 'https://x/heatshield-ota.json' },
    ];
    return (async (url: string) => {
      if (url === LATEST_RELEASE_API) {
        return { ok: true, status: 200, json: async () => ({ tag_name: 'v2.0.30', prerelease: false, assets: [] }), text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) };
      }
      if (url === RELEASES_API) {
        return { ok: true, status: 200, json: async () => [
          { tag_name: 'experimental', prerelease: true, html_url: 'https://x', assets: preAssets },
          { tag_name: 'v2.0.30', prerelease: false, assets: [] },
        ], text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) };
      }
      if (url === 'https://x/ota-manifest.json') {
        return { ok: true, status: 200, json: async () => null, text: async () => manifest('2.0.30+exp.20260715T1300Z'), arrayBuffer: async () => new ArrayBuffer(0) };
      }
      return { ok: false, status: 404, json: async () => null, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) };
    }) as unknown as FetchLike;
  }

  it('stable channel does NOT surface the experimental prerelease', async () => {
    const mgr = new OtaManager({
      dataDir: '/nonexistent-hs-ota',
      coreVersion: CORE,
      getMode: () => 'manual',
      getIntervalHours: () => 6,
      getChannel: () => 'stable',
      requestRestart: () => undefined,
      fetchImpl: makeFetch(),
    });
    const out = await mgr.check();
    // Stable resolves releases/latest (v2.0.30, no OTA assets) → nothing to install.
    expect(out.updateAvailable).toBe(false);
    expect(mgr.getStatus().channel).toBe('stable');
    expect(mgr.getStatus().experimentalBuild).toBe(false);
  });

  it('experimental channel installs a same-version newer-build payload', async () => {
    const mgr = new OtaManager({
      dataDir: '/nonexistent-hs-ota',
      coreVersion: CORE, // running OTA version defaults to core (2.0.30, no tail)
      getMode: () => 'manual',
      getIntervalHours: () => 6,
      getChannel: () => 'experimental',
      requestRestart: () => undefined,
      fetchImpl: makeFetch(),
    });
    const out = await mgr.check();
    expect(out.updateAvailable).toBe(true); // 2.0.30+exp.stamp is newer than 2.0.30
    expect(mgr.getStatus().experimentalBuild).toBe(true);
    expect(mgr.getStatus().channel).toBe('experimental');
  });
});
