/**
 * Unit tests for the forecast persistence store (Task 8.1).
 * Baseline round-trip + corrupt/missing baseline → empty (deviation skipped).
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  readBaseline,
  writeBaseline,
  readPlan,
  writePlan,
} from '../../src/plugin/persistence/forecastStore.js';

let dataDir: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hs-forecast-'));
});
afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('forecastStore', () => {
  it('round-trips the deviation baseline', async () => {
    const baseline = {
      r1: { indoorTempC: 24.2, heatLoad01: 0.6 },
      r2: { indoorTempC: null, heatLoad01: null },
    };
    await writeBaseline(baseline, { dataDir });
    expect(await readBaseline({ dataDir })).toEqual(baseline);
  });

  it('returns {} when the baseline file is missing', async () => {
    expect(await readBaseline({ dataDir })).toEqual({});
  });

  it('returns {} when the baseline file is corrupt', async () => {
    await fs.writeFile(path.join(dataDir, 'forecast-baseline.json'), '{not json', 'utf8');
    expect(await readBaseline({ dataDir })).toEqual({});
  });

  it('round-trips the plan and returns null when missing', async () => {
    expect(await readPlan({ dataDir })).toBeNull();
    const plan = {
      ts: '2026-06-21T08:00:00.000Z',
      windows: [{ windowId: 'w1', target01: 0.5, noMoveNeeded: false }],
      plannedActions: [],
    };
    await writePlan(plan, { dataDir });
    expect(await readPlan({ dataDir })).toEqual(plan);
  });
});
