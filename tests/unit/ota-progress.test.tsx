// @vitest-environment jsdom
/**
 * B6 — tracked OTA install flow (useOtaStatus.installTracked).
 *
 * Verifies the progress state machine: installing → restarting → done, with a
 * live log, and that a fetch failure during the restart window is treated as
 * "still restarting" (not an error) until the new payload version comes up.
 */

import { h } from 'preact';
import { render, fireEvent, cleanup } from '@testing-library/preact';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

import { useOtaStatus } from '../../src/plugin/dashboard/spa/hooks/useOtaStatus.js';

function Harness(): ReturnType<typeof h> {
  const ota = useOtaStatus();
  return h('div', null, [
    h('span', { 'data-testid': 'phase', key: 'p' }, ota.phase),
    h('button', { 'data-testid': 'go', key: 'g', onClick: () => ota.installTracked() }, 'go'),
  ]);
}

const STATUS_BEFORE = {
  coreVersion: '2.0.30', otaVersion: '2.0.30', otaActive: false,
  latest: '2.0.30', updateAvailable: true, requiresCore: false,
  mode: 'manual', channel: 'experimental', experimentalBuild: true,
  checkIntervalHours: 6, lastCheck: null, lastResult: null,
};

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
beforeEach(() => { vi.useFakeTimers(); });

describe('useOtaStatus.installTracked (B6)', () => {
  it('drives installing → restarting → done and reloads', async () => {
    let restarted = false;
    let installCalls = 0;
    const version = (): string => (restarted ? '2.0.30+exp.20260715T1300Z' : '2.0.30');
    const fetchMock = vi.fn(async (url: string, init?: { method?: string }) => {
      if (url === '/api/ota/install' && init?.method === 'POST') {
        installCalls += 1;
        restarted = true; // server restarts into the new payload
        return { status: 200, ok: true, json: async () => ({ result: { ok: true }, status: { ...STATUS_BEFORE, otaVersion: version() } }) };
      }
      // GET /api/ota/status
      return { status: 200, ok: true, json: async () => ({ ...STATUS_BEFORE, otaVersion: version() }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const reload = vi.fn();
    vi.stubGlobal('location', { reload } as unknown as Location);

    const { getByTestId } = render(h(Harness, {}));
    await vi.advanceTimersByTimeAsync(1); // flush mount GET

    fireEvent.click(getByTestId('go'));
    await vi.advanceTimersByTimeAsync(1); // POST install resolves
    expect(installCalls).toBe(1);
    // restarting phase begins; poll scheduled at +2000ms
    await vi.advanceTimersByTimeAsync(2000); // poll → version changed → done
    expect(getByTestId('phase').textContent).toBe('done');
    await vi.advanceTimersByTimeAsync(1500); // reload timer
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('treats a fetch failure during restart as "restarting", then completes', async () => {
    let restarted = false;
    let firstPollFailed = false;
    const fetchMock = vi.fn(async (url: string, init?: { method?: string }) => {
      if (url === '/api/ota/install' && init?.method === 'POST') {
        restarted = true;
        throw new Error('socket dropped'); // process restarted before responding
      }
      // First status poll AFTER the restart fails (server still down); then it
      // recovers with the new payload version.
      if (restarted && !firstPollFailed) {
        firstPollFailed = true;
        throw new Error('connection refused');
      }
      return { status: 200, ok: true, json: async () => ({ ...STATUS_BEFORE, otaVersion: restarted ? '2.0.30+exp.NEW' : '2.0.30' }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('location', { reload: vi.fn() } as unknown as Location);

    const { getByTestId } = render(h(Harness, {}));
    await vi.advanceTimersByTimeAsync(1); // mount GET (phaseCalls=1)
    fireEvent.click(getByTestId('go'));
    await vi.advanceTimersByTimeAsync(1); // POST rejects → restarting
    expect(getByTestId('phase').textContent).toBe('restarting');
    await vi.advanceTimersByTimeAsync(2000); // first poll fails (still restarting)
    expect(getByTestId('phase').textContent).toBe('restarting');
    await vi.advanceTimersByTimeAsync(2000); // second poll → new version → done
    expect(getByTestId('phase').textContent).toBe('done');
  });
});
