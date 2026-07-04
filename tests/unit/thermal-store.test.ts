/**
 * Thermal calculation-snapshot store (thermal-load-engine). Verifies save →
 * list (newest-first summaries) → read on a temp dir, and per-project isolation.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { saveThermalSnapshot, listThermalSnapshots, readThermalSnapshot } from '../../src/plugin/persistence/thermalStore.js';

let dataDir: string;
beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'heat-shield-thermal-'));
});
afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

const estimate = {
  profile: 'quick-estimate-v1',
  modelRevision: 4,
  inputHash: 'abcd1234',
  heating: { buildingTotalW: 1234.5, sumOfRoomsW: 1500 },
  cooling: { buildingPeakW: 800 },
};

describe('thermalStore', () => {
  it('saves and lists a snapshot summary', async () => {
    const saved = await saveThermalSnapshot(estimate, { dataDir });
    expect(saved.buildingHeatingW).toBeCloseTo(1234.5, 4);
    expect(saved.modelRevision).toBe(4);
    const list = await listThermalSnapshots({ dataDir });
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(saved.id);
    expect(list[0]?.buildingCoolingW).toBe(800);
  });

  it('reads back the full estimate payload', async () => {
    const saved = await saveThermalSnapshot(estimate, { dataDir });
    const full = (await readThermalSnapshot(saved.id, { dataDir })) as typeof estimate;
    expect(full.inputHash).toBe('abcd1234');
    expect(await readThermalSnapshot('snap-does-not-exist', { dataDir })).toBeNull();
  });

  it('isolates snapshots per project', async () => {
    await saveThermalSnapshot(estimate, { dataDir }); // default project
    const other = await listThermalSnapshots({ dataDir, projectId: 'p2' });
    expect(other).toHaveLength(0);
    await saveThermalSnapshot({ ...estimate, modelRevision: 9 }, { dataDir, projectId: 'p2' });
    expect(await listThermalSnapshots({ dataDir, projectId: 'p2' })).toHaveLength(1);
    expect(await listThermalSnapshots({ dataDir })).toHaveLength(1);
  });
});
