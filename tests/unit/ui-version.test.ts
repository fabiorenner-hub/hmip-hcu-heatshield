// @vitest-environment jsdom
/**
 * Global UI-version signal — RETIRED v1 contract (ui-v2-release).
 *
 * The classic v1 (1.20) interface is retired: there is now exactly ONE UI, the
 * "Liquid Glass V2" design. The `uiVersion` signal is therefore permanently
 * `'v2'`, `setUiVersion` is a no-op that keeps `'v2'`, and `readUiVersion()`
 * always returns `'v2'`. The export surface is kept only for import
 * compatibility. These tests pin that retirement contract, including that any
 * previously persisted `'v1'` choice is ignored and that localStorage failures
 * are irrelevant (the value never depends on storage anymore).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const STORAGE_KEY = 'heatshield.uiVersion';

/** Re-import the module fresh so the initial module-load runs against the
 *  current localStorage state (the signal is a module-singleton). */
async function freshModule(): Promise<typeof import('../../src/plugin/dashboard/spa/uiVersion.js')> {
  vi.resetModules();
  return import('../../src/plugin/dashboard/spa/uiVersion.js');
}

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

afterEach(() => {
  localStorage.clear();
});

describe('uiVersion signal (v1 retired)', () => {
  it('is v2 by default when nothing is persisted', async () => {
    const { uiVersion, readUiVersion } = await freshModule();
    expect(uiVersion.value).toBe('v2');
    expect(readUiVersion()).toBe('v2');
  });

  it('ignores a previously persisted v1 choice and stays v2', async () => {
    // v1 is retired: an old stored 'v1' must NOT resurrect the classic UI.
    localStorage.setItem(STORAGE_KEY, 'v1');
    const { uiVersion, readUiVersion } = await freshModule();
    expect(uiVersion.value).toBe('v2');
    expect(readUiVersion()).toBe('v2');
  });

  it('treats any persisted value (including garbage) as v2', async () => {
    localStorage.setItem(STORAGE_KEY, 'nonsense');
    const { uiVersion } = await freshModule();
    expect(uiVersion.value).toBe('v2');
  });

  it('setUiVersion is a no-op: requesting v1 keeps v2', async () => {
    const { uiVersion, setUiVersion, readUiVersion } = await freshModule();
    expect(uiVersion.value).toBe('v2');

    setUiVersion('v1');
    expect(uiVersion.value).toBe('v2');
    expect(readUiVersion()).toBe('v2');

    setUiVersion('v2');
    expect(uiVersion.value).toBe('v2');
    expect(readUiVersion()).toBe('v2');
  });

  it('falls back to v2 when localStorage read throws', async () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const { uiVersion } = await freshModule();
    expect(uiVersion.value).toBe('v2');
    spy.mockRestore();
  });

  it('does not throw when localStorage write is blocked', async () => {
    const { setUiVersion, uiVersion } = await freshModule();
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => setUiVersion('v2')).not.toThrow();
    // The signal remains the single retired value regardless of persistence.
    expect(uiVersion.value).toBe('v2');
    spy.mockRestore();
  });
});
