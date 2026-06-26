/**
 * Heat Shield — boot module smoke (Task 15.1).
 *
 * Lightweight test that the boot pipeline is wired correctly:
 *   - the seed config validates,
 *   - a `HeatShieldBoot` instance starts the dashboard server on a
 *     free port,
 *   - `/api/state` returns 200 with a parseable snapshot,
 *   - `stop()` shuts everything down without throwing.
 *
 * The Connect-API path is disabled (`HEATSHIELD_NO_CONNECT=1`) so the
 * test does not need a fake WebSocket server.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { HeatShieldBoot, seedDefaultConfig } from '../../src/plugin/index.js';
import { emptyRuntimeState } from '../../src/plugin/persistence/state.js';
import { parseConfig } from '../../src/shared/schema.js';

async function freePort(): Promise<number> {
  // Use Node's auto-assigned port: bind to 0 then read back.
  const net = await import('node:net');
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.listen(0, () => {
      const addr = server.address();
      if (typeof addr === 'object' && addr !== null) {
        const port = addr.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('no port assigned')));
      }
    });
    server.once('error', reject);
  });
}

describe('HeatShieldBoot (Task 15.1)', () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      if (fn) await fn();
    }
  });

  it('seedDefaultConfig parses against the schema', () => {
    const cfg = seedDefaultConfig();
    expect(cfg.location.timezone).toBe('Europe/Berlin');
    expect(parseConfig(cfg)).toBeDefined();
    expect(cfg.dashboard.port).toBe(8089);
  });

  it('starts the dashboard server and serves /api/state', async () => {
    const port = await freePort();
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'heatshield-boot-'));
    cleanups.push(() => fs.rm(dataDir, { recursive: true, force: true }));

    const env = {
      dataDir,
      port,
      noConnect: true,
      connectUrl: 'wss://example.invalid:9001',
      authToken: null,
      tokenPath: '/TOKEN',
      fusionUrl: null,
    };
    const boot = new HeatShieldBoot(env, seedDefaultConfig(), emptyRuntimeState());
    cleanups.push(() => boot.stop());
    await boot.start();

    const stateRes = await fetch(`http://localhost:${port}/api/state`);
    expect(stateRes.status).toBe(200);
    const body = (await stateRes.json()) as { ts?: string; sources?: unknown };
    expect(typeof body.ts).toBe('string');
    expect(body.sources).toBeTruthy();

    // Root serves either the bundled SPA or the built-in stub — both
    // expose the "Heat Shield Dashboard" string.
    const rootRes = await fetch(`http://localhost:${port}/`);
    expect(rootRes.status).toBe(200);
    const html = await rootRes.text();
    expect(html).toContain('Heat Shield Dashboard');
  }, 15_000);
});
