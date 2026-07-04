// @vitest-environment jsdom
/**
 * Global UI-version signal (ui-v2-release, Task 1).
 *
 * Verifies the persisted design flag: default v2, setUiVersion persists and
 * flips the reactive signal, and localStorage failures fall back to v2.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const STORAGE_KEY = 'heatshield.uiVersion';

/** Re-import the module fresh so the initial `load()` runs against the current
 *  localStorage state (the signal is a module-singleton). */
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

describe('uiVersion signal', () => {
  it('defaults to v2 when nothing is persisted', async () => {
    const { uiVersion, readUiVersion } = await freshModule();
    expect(uiVersion.value).toBe('v2');
    expect(readUiVersion()).toBe('v2');
  });

  it('loads a persisted v1 choice on init', async () => {
    localStorage.setItem(STORAGE_KEY, 'v1');
    const { uiVersion } = await freshModule();
    expect(uiVersion.value).toBe('v1');
  });

  it('treats any non-"v1" persisted value as v2', async () => {
    localStorage.setItem(STORAGE_KEY, 'nonsense');
    const { uiVersion } = await freshModule();
    expect(uiVersion.value).toBe('v2');
  });

  it('setUiVersion persists and flips the reactive signal', async () => {
    const { uiVersion, setUiVersion } = await freshModule();
    expect(uiVersion.value).toBe('v2');

    setUiVersion('v1');
    expect(uiVersion.value).toBe('v1');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('v1');

    setUiVersion('v2');
    expect(uiVersion.value).toBe('v2');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('v2');
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
    // The in-memory signal still updates even if persistence fails.
    expect(uiVersion.value).toBe('v2');
    spy.mockRestore();
  });
});
