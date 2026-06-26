#!/usr/bin/env node
/**
 * Heat Shield — local smoke test (Task 15.2).
 *
 * Boots the compiled `dist/plugin/index.js` with `HEATSHIELD_NO_CONNECT=1`
 * so the smoke run does not depend on a live HCU, then polls the dashboard
 * until `/api/state` returns 200 and `/` returns the bundled SPA HTML.
 * Cleans up `.smoke-data/` and the child process before exiting.
 *
 * Usage: `npm run smoke` (after `npm run build`).
 *
 * Exit codes:
 *   0 — all checks passed.
 *   1 — child crashed before becoming ready, or a check failed.
 *   2 — never reached the readiness deadline.
 */

import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const PORT = Number.parseInt(
  process.env.HEATSHIELD_DASHBOARD_PORT ?? '18089',
  10,
);
const DATA_DIR = process.env.HEATSHIELD_DATA_DIR ?? path.join(ROOT, '.smoke-data');
const READY_DEADLINE_MS = 30_000;
const SHUTDOWN_DEADLINE_MS = 5_000;
const POLL_INTERVAL_MS = 250;

function log(msg) {
  // eslint-disable-next-line no-console
  console.log(`[smoke] ${msg}`);
}

async function pollOk(url, deadlineMs) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < deadlineMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(
    `timed out waiting for ${url}: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}

async function main() {
  // Best-effort cleanup of any stale data dir from a previous run.
  await rm(DATA_DIR, { recursive: true, force: true });

  const env = {
    ...process.env,
    HEATSHIELD_NO_CONNECT: '1',
    HEATSHIELD_DATA_DIR: DATA_DIR,
    HEATSHIELD_DASHBOARD_PORT: String(PORT),
  };

  log(`spawning node dist/plugin/index.js on port ${PORT} (no connect)`);
  const child = spawn(
    process.execPath,
    [path.join(ROOT, 'dist', 'plugin', 'index.js')],
    {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let exitedEarly = false;
  child.stdout.on('data', (b) => process.stdout.write(`[child] ${b}`));
  child.stderr.on('data', (b) => process.stderr.write(`[child] ${b}`));
  const earlyExit = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      exitedEarly = true;
      resolve({ code, signal });
    });
  });

  const cleanup = async () => {
    if (exitedEarly) return;
    log('sending SIGTERM');
    child.kill('SIGTERM');
    const stopped = await Promise.race([
      new Promise((r) => child.once('exit', r)),
      new Promise((r) => setTimeout(() => r('timeout'), SHUTDOWN_DEADLINE_MS)),
    ]);
    if (stopped === 'timeout') {
      log('SIGKILL after grace window');
      child.kill('SIGKILL');
      await new Promise((r) => child.once('exit', r));
    }
  };

  try {
    // Race readiness against an early child exit so we surface a real
    // crash promptly instead of waiting for the 30s deadline.
    const readyOrCrash = await Promise.race([
      (async () => {
        const t0 = Date.now();
        const stateRes = await pollOk(
          `http://localhost:${PORT}/api/state`,
          READY_DEADLINE_MS,
        );
        log(`/api/state OK after ${Date.now() - t0} ms`);
        const stateBody = await stateRes.json();
        if (typeof stateBody.ts !== 'string') {
          throw new Error('snapshot missing ts field');
        }
        return 'ready';
      })(),
      earlyExit.then(({ code, signal }) =>
        Promise.reject(
          new Error(
            `plugin exited before ready (code=${code}, signal=${signal})`,
          ),
        ),
      ),
    ]);
    if (readyOrCrash !== 'ready') throw new Error('readiness check failed');

    const indexRes = await pollOk(`http://localhost:${PORT}/`, 5_000);
    const html = await indexRes.text();
    if (
      !html.includes('Heat Shield Dashboard') &&
      !html.includes('id="root"')
    ) {
      throw new Error(
        `dashboard root HTML missing SPA marker (first 200 chars: ${html.slice(
          0,
          200,
        )})`,
      );
    }
    log('/ returns SPA HTML');

    log('all checks passed');
  } finally {
    await cleanup();
    await rm(DATA_DIR, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().then(
  () => {
    process.exit(0);
  },
  (err) => {
    // eslint-disable-next-line no-console
    console.error('[smoke] FAIL:', err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
