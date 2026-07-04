/**
 * Underlay HTTP routes (BME-03/04/12) end-to-end against the real store.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { DashboardServer, type DashboardServerDeps, type DashboardSnapshot } from '../../src/plugin/dashboard/server.js';
import {
  listUnderlays,
  addUnderlay,
  updateUnderlay,
  deleteUnderlay,
  readUnderlayBinary,
} from '../../src/plugin/persistence/underlayStore.js';
import type { Config } from '../../src/shared/types.js';
import type { UnderlayMeta } from '../../src/shared/building-underlay.js';

const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=';

let dataDir: string;
beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'heat-shield-uroutes-'));
});
afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

function makeServer(withUnderlays = true): DashboardServer {
  const noop = async (): Promise<void> => undefined;
  const deps: DashboardServerDeps = {
    config: () => ({}) as unknown as Config,
    updateConfig: noop,
    readState: async () => null,
    readDecisions: async () => [],
    readHistory: async () => [],
    readTrends: async () => [],
    getSnapshot: async () => ({}) as unknown as DashboardSnapshot,
    probe: async () => ({ mode: 'NORMAL' as const, windowDecisions: [] }),
    setShutterManually: noop,
    setMaintenanceMode: noop,
    resetConfig: noop,
    subscribe: () => () => undefined,
  };
  if (withUnderlays) {
    deps.listUnderlays = () => listUnderlays({ dataDir });
    deps.addUnderlay = (dataUrl, input) => addUnderlay(dataUrl, input, { dataDir });
    deps.updateUnderlay = (id, patch) => updateUnderlay(id, patch, { dataDir });
    deps.deleteUnderlay = (id) => deleteUnderlay(id, { dataDir });
    deps.getUnderlayBinary = (id) => readUnderlayBinary(id, { dataDir });
  }
  return new DashboardServer(deps, { port: 0 });
}

describe('underlay HTTP routes', () => {
  it('uploads, lists, serves the image, patches and deletes', async () => {
    const server = makeServer();
    const up = await server.fastify.inject({
      method: 'POST',
      url: '/api/building/underlays',
      payload: { dataUrl: PNG_DATA_URL, storeyId: 's1', name: 'Plan' },
    });
    expect(up.statusCode).toBe(200);
    const meta = (up.json() as { meta: UnderlayMeta }).meta;
    expect(meta.widthPx).toBe(1);

    const list = await server.fastify.inject({ method: 'GET', url: '/api/building/underlays' });
    expect((list.json() as { underlays: UnderlayMeta[] }).underlays).toHaveLength(1);

    const img = await server.fastify.inject({ method: 'GET', url: `/api/building/underlays/${meta.id}/image` });
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toContain('image/png');

    const patch = await server.fastify.inject({ method: 'PUT', url: `/api/building/underlays/${meta.id}`, payload: { opacityPct: 40 } });
    expect(patch.statusCode).toBe(200);
    expect((patch.json() as { meta: UnderlayMeta }).meta.opacityPct).toBe(40);

    const del = await server.fastify.inject({ method: 'DELETE', url: `/api/building/underlays/${meta.id}` });
    expect(del.statusCode).toBe(200);
    expect((await server.fastify.inject({ method: 'GET', url: '/api/building/underlays' })).json()).toEqual({ underlays: [] });
  });

  it('rejects an unsupported upload with 400', async () => {
    const server = makeServer();
    const res = await server.fastify.inject({
      method: 'POST',
      url: '/api/building/underlays',
      payload: { dataUrl: 'data:application/pdf;base64,AAAA', storeyId: 's1' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 for an unknown underlay image', async () => {
    const server = makeServer();
    const res = await server.fastify.inject({ method: 'GET', url: '/api/building/underlays/nope/image' });
    expect(res.statusCode).toBe(404);
  });

  it('returns 503 when underlay deps are not wired', async () => {
    const server = makeServer(false);
    const res = await server.fastify.inject({ method: 'GET', url: '/api/building/underlays' });
    expect(res.statusCode).toBe(503);
  });
});
