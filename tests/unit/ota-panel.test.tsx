// @vitest-environment jsdom
/**
 * OtaPanel — the shared OTA control embedded in the v2 Updates page.
 *
 * Verifies that, with a wired OTA status, the panel renders the Stable |
 * Experimental channel toggle (B5) and the mode toggle. Regression guard for
 * the bug where the v2 Updates route rendered the v1 tab (no OtaPanel), so the
 * channel switch never appeared.
 */

import { h } from 'preact';
import { render, cleanup, waitFor } from '@testing-library/preact';
import { afterEach, describe, it, expect, vi } from 'vitest';

import { OtaPanel } from '../../src/plugin/dashboard/spa/components/OtaPanel.js';
import { __resetConfigStateForTests } from '../../src/plugin/dashboard/spa/hooks/useConfig.js';

const OTA_STATUS = {
  coreVersion: '2.0.29', otaVersion: '2.0.28', otaActive: true,
  latest: '2.0.28', updateAvailable: false, requiresCore: false,
  mode: 'auto', channel: 'stable', experimentalBuild: false,
  checkIntervalHours: 6, lastCheck: null, lastResult: null,
};

afterEach(() => { cleanup(); __resetConfigStateForTests(); vi.restoreAllMocks(); });

describe('OtaPanel channel toggle (B5)', () => {
  it('renders the Stable | Experimental channel toggle when OTA is wired', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith('/api/ota/status')) {
        return { status: 200, ok: true, json: async () => OTA_STATUS };
      }
      if (url.startsWith('/api/config')) {
        return { status: 200, ok: true, json: async () => ({ updates: { mode: 'auto', checkIntervalHours: 6, channel: 'stable' } }) };
      }
      return { status: 200, ok: true, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);

    const { container } = render(h(OtaPanel, {}));
    await waitFor(() => {
      expect(container.querySelector('[data-testid="ota-panel"]')).not.toBeNull();
    });
    expect(container.querySelector('[data-testid="ota-channel-stable"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="ota-channel-experimental"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="ota-mode-auto"]')).not.toBeNull();
  });

  it('renders nothing when OTA is not wired (503)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith('/api/ota/status')) return { status: 503, ok: false, json: async () => ({}) };
      return { status: 200, ok: true, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(h(OtaPanel, {}));
    // Give the mount fetch a tick; panel stays absent.
    await new Promise((r) => setTimeout(r, 10));
    expect(container.querySelector('[data-testid="ota-panel"]')).toBeNull();
  });
});
