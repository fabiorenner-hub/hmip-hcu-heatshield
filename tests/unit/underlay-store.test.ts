/**
 * Underlay store round-trip (BME-03/04/12): add (validate + strip + persist),
 * list, update (display + calibration), read binary, delete.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  addUnderlay,
  listUnderlays,
  updateUnderlay,
  deleteUnderlay,
  readUnderlayBinary,
} from '../../src/plugin/persistence/underlayStore.js';

const PNG_1x1_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=';
const PNG_DATA_URL = `data:image/png;base64,${PNG_1x1_B64}`;

let dataDir: string;
beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'heat-shield-underlay-'));
});
afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('underlayStore', () => {
  it('adds, validates and lists an underlay', async () => {
    const res = await addUnderlay(PNG_DATA_URL, { storeyId: 's1', name: 'Plan' }, { dataDir });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.meta.widthPx).toBe(1);
    expect(res.meta.heightPx).toBe(1);
    expect(res.meta.metersPerPixel).toBeNull();
    const list = await listUnderlays({ dataDir });
    expect(list).toHaveLength(1);
    expect(list[0]?.storeyId).toBe('s1');
  });

  it('rejects a non-image and an unsupported media type', async () => {
    expect((await addUnderlay('not a data url', { storeyId: 's1' }, { dataDir })).ok).toBe(false);
    const webp = await addUnderlay('data:image/webp;base64,AAAA', { storeyId: 's1' }, { dataDir });
    expect(webp.ok).toBe(false);
  });

  it('updates display + calibration fields (clamped)', async () => {
    const res = await addUnderlay(PNG_DATA_URL, { storeyId: 's1' }, { dataDir });
    if (!res.ok) throw new Error('add failed');
    const updated = await updateUnderlay(res.meta.id, { opacityPct: 999, metersPerPixel: 0.03, rotationDeg: 400 }, { dataDir });
    expect(updated?.opacityPct).toBe(100);
    expect(updated?.metersPerPixel).toBe(0.03);
    expect(updated?.rotationDeg).toBe(40);
  });

  it('persists a normalised freeform crop polygon and clears it', async () => {
    const res = await addUnderlay(PNG_DATA_URL, { storeyId: 's1' }, { dataDir });
    if (!res.ok) throw new Error('add failed');
    expect(res.meta.crop).toEqual([]);
    // Out-of-range points are clamped; a valid triangle survives the round-trip.
    const withCrop = await updateUnderlay(
      res.meta.id,
      { crop: [{ x: -0.5, y: 0 }, { x: 1.5, y: 0 }, { x: 0.5, y: 1.2 }] },
      { dataDir },
    );
    expect(withCrop?.crop).toEqual([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0.5, y: 1 }]);
    // Survives a reload from disk.
    expect((await listUnderlays({ dataDir }))[0]?.crop).toHaveLength(3);
    // Fewer than three points → crop cleared.
    const cleared = await updateUnderlay(res.meta.id, { crop: [{ x: 0.1, y: 0.1 }] }, { dataDir });
    expect(cleared?.crop).toEqual([]);
  });

  it('reads the stored binary and deletes it', async () => {
    const res = await addUnderlay(PNG_DATA_URL, { storeyId: 's1' }, { dataDir });
    if (!res.ok) throw new Error('add failed');
    const bin = await readUnderlayBinary(res.meta.id, { dataDir });
    expect(bin?.mediaType).toBe('image/png');
    expect((bin?.bytes.length ?? 0)).toBeGreaterThan(0);
    expect(await deleteUnderlay(res.meta.id, { dataDir })).toBe(true);
    expect(await listUnderlays({ dataDir })).toHaveLength(0);
    expect(await readUnderlayBinary(res.meta.id, { dataDir })).toBeNull();
  });
});
