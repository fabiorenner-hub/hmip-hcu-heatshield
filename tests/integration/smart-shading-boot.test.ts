/**
 * Integration smoke for the smart-shading-notifications wiring in
 * `index.ts` (Task 12.3).
 *
 * Boots `HeatShieldBoot` with the Connect path disabled and verifies that the
 * new subsystems are wired end-to-end through the real dashboard server:
 *   - `GET /api/messages` returns the (empty) message list + unread count,
 *     proving the MessageStore deps are wired.
 *   - `GET /api/state` carries the `feelsLike`, `trends` and `unreadMessages`
 *     blocks, proving the snapshot extension + TrendStore/HeatLoad wiring.
 *   - `POST /api/messages/read` succeeds.
 *
 * The per-window venting lockout (no setShutterLevel while open) and the
 * shade.activated→message mapping are covered deterministically by the
 * orchestrator and notification unit tests; this test focuses on the boot
 * wiring that those units cannot see.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { HeatShieldBoot, seedDefaultConfig } from '../../src/plugin/index.js';
import { emptyRuntimeState } from '../../src/plugin/persistence/state.js';

async function freePort(): Promise<number> {
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

describe('smart-shading boot wiring (Task 12.3)', () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      if (fn) await fn();
    }
  });

  it('wires the message store + snapshot extension through the server', async () => {
    const port = await freePort();
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'heatshield-ss-'));
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

    // Messages endpoint is wired (empty on a fresh boot).
    const msgRes = await fetch(`http://localhost:${port}/api/messages`);
    expect(msgRes.status).toBe(200);
    const msgBody = (await msgRes.json()) as { messages: unknown[]; unread: number };
    expect(Array.isArray(msgBody.messages)).toBe(true);
    expect(msgBody.unread).toBe(0);

    // Snapshot carries the new blocks.
    const stateRes = await fetch(`http://localhost:${port}/api/state`);
    expect(stateRes.status).toBe(200);
    const snap = (await stateRes.json()) as {
      feelsLike?: { effectiveLoad01: number; feelsLikeC: number | null };
      trends?: { outdoorCph: number | null; pvKwph: number | null };
      unreadMessages?: number;
    };
    expect(snap.feelsLike).toBeDefined();
    expect(typeof snap.feelsLike?.effectiveLoad01).toBe('number');
    expect(snap.trends).toBeDefined();
    expect(snap.unreadMessages).toBe(0);

    // Mark-read endpoint is wired.
    const readRes = await fetch(`http://localhost:${port}/api/messages/read`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(readRes.status).toBe(200);
    const readBody = (await readRes.json()) as { ok: boolean; unread: number };
    expect(readBody.ok).toBe(true);
    expect(readBody.unread).toBe(0);
  }, 15_000);
});
