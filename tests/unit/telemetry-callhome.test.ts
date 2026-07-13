/**
 * Unit tests for the anonymous call-home (install analytics).
 */

import { describe, it, expect } from 'vitest';

import {
  installIdFor,
  buildCallHomePayload,
  sendCallHome,
  TELEMETRY_ENDPOINT,
  type CallHomePayload,
} from '../../src/plugin/telemetry/callHome.js';

const NOW = new Date('2026-07-13T18:00:00.000Z');

function inputs(sgtin: string | null): Parameters<typeof buildCallHomePayload>[0] {
  return {
    sgtin,
    pluginId: 'de.fr.renner.plugin.heatshield',
    coreVersion: '2.0.24',
    otaVersion: '2.0.24',
    buildId: '2.0.24+x',
    arch: 'arm64',
    lang: 'de',
    now: NOW,
  };
}

describe('installIdFor', () => {
  it('is a stable 64-hex hash, unique per SGTIN, and not the raw SGTIN', () => {
    const a = installIdFor('3014F711A000ABCDEF');
    const b = installIdFor('3014F711A000ABCDEF');
    const c = installIdFor('3014F711A000999999');
    expect(a).toMatch(/^[0-9a-f]{64}$/u);
    expect(a).toBe(b); // stable
    expect(a).not.toBe(c); // unique per installation
    expect(a).not.toContain('3014F711'); // never leaks the serial
  });
});

describe('buildCallHomePayload', () => {
  it('builds a minimal payload with only a hashed id + versions', () => {
    const p = buildCallHomePayload(inputs('3014F711A000ABCDEF'));
    expect(p).not.toBeNull();
    const payload = p as CallHomePayload;
    expect(payload.installId).toBe(installIdFor('3014F711A000ABCDEF'));
    expect(payload.schema).toBe(1);
    expect(payload.event).toBe('start');
    expect(payload.coreVersion).toBe('2.0.24');
    // No forbidden fields.
    const keys = Object.keys(payload);
    expect(keys).not.toContain('sgtin');
    expect(keys).not.toContain('authToken');
    expect(keys).not.toContain('location');
  });
  it('returns null without a stable SGTIN (remote-dev / smoke)', () => {
    expect(buildCallHomePayload(inputs(null))).toBeNull();
    expect(buildCallHomePayload(inputs('   '))).toBeNull();
  });
});

describe('sendCallHome', () => {
  it('POSTs JSON to the fixed https endpoint and reports 2xx', async () => {
    let seenUrl = '';
    let seenBody = '';
    const ok = await sendCallHome(buildCallHomePayload(inputs('X0000000000ABCD'))!, {
      fetchImpl: async (url, init) => {
        seenUrl = url;
        seenBody = init.body;
        return { ok: true, status: 204 };
      },
    });
    expect(ok).toBe(true);
    expect(seenUrl).toBe(TELEMETRY_ENDPOINT);
    expect(seenUrl.startsWith('https://')).toBe(true);
    expect(JSON.parse(seenBody).pluginId).toBe('de.fr.renner.plugin.heatshield');
  });
  it('swallows network errors (best-effort)', async () => {
    const ok = await sendCallHome(buildCallHomePayload(inputs('X0000000000ABCD'))!, {
      fetchImpl: async () => {
        throw new Error('offline');
      },
    });
    expect(ok).toBe(false);
  });
});
