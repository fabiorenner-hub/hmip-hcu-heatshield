/**
 * Tests for the runtime-state persistence layer
 * (`src/plugin/persistence/state.ts`) and the underlying schema
 * (`src/shared/state-schema.ts`).
 *
 * Each test allocates its own temp directory under `os.tmpdir()` so the
 * suite never touches `/data/`. The directory is removed in `afterEach`
 * regardless of test outcome.
 *
 * Coverage:
 *   - `readState` on a missing file → `null`.
 *   - `writeState` then `readState` round-trips deep-equal.
 *   - `readState` on corrupt JSON → `null` AND the corrupt file is
 *     unlinked.
 *   - `readState` on schema-invalid payload (e.g. `currentMode: 'BANANA'`)
 *     → `null` AND the file is unlinked.
 *   - `emptyRuntimeState()` parses cleanly through `parseState`.
 *   - `createWindowRuntimeState('w1')` parses cleanly through
 *     `WindowRuntimeStateSchema`.
 *   - `writeState` does not leave a `*.tmp` sibling on success.
 *   - The five-`ownSwitches` constraint: building a state with only four
 *     switches throws on `parseState`.
 *   - `DEFAULT_STATE_PATH` matches the steering rule.
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import {
  createWindowRuntimeState,
  DEFAULT_STATE_PATH,
  emptyRuntimeState,
  readState,
  writeState,
} from '../../src/plugin/persistence/state.js';
import {
  parseState,
  WindowRuntimeStateSchema,
} from '../../src/shared/state-schema.js';
import type { RuntimeState } from '../../src/shared/state-schema.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'heat-shield-state-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function tmpStatePath(name = 'state.json'): string {
  return path.join(tmpDir, name);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw err;
  }
}

describe('persistence/state — DEFAULT_STATE_PATH', () => {
  it('points at /data/state.json per the steering rule', () => {
    expect(DEFAULT_STATE_PATH).toBe('/data/state.json');
  });
});

describe('emptyRuntimeState', () => {
  it('parses cleanly through parseState', () => {
    const empty = emptyRuntimeState();

    expect(() => parseState(empty)).not.toThrow();
  });

  it('produces exactly five own-switch rows in canonical order', () => {
    const empty = emptyRuntimeState();

    expect(empty.ownSwitches).toHaveLength(5);
    expect(empty.ownSwitches.map((s) => s.id)).toEqual([
      'heatshield-state-active',
      'heatshield-state-forecast',
      'heatshield-state-night-cooling',
      'heatshield-control-pause',
      'heatshield-control-vacation',
    ]);
    for (const row of empty.ownSwitches) {
      expect(row.value).toBe(false);
      expect(row.engineConfirmed).toBe(false);
    }
  });

  it('starts with no windows, no mode, no storm hold', () => {
    const empty = emptyRuntimeState();

    expect(empty.windows).toEqual([]);
    expect(empty.currentMode).toBeNull();
    expect(empty.lastCycleAt).toBeNull();
    expect(empty.stormHoldUntil).toBeNull();
    expect(empty.schemaVersion).toBe(1);
  });
});

describe('createWindowRuntimeState', () => {
  it('parses cleanly through WindowRuntimeStateSchema', () => {
    const w = createWindowRuntimeState('schlafzimmer-dach-so');

    expect(() => WindowRuntimeStateSchema.parse(w)).not.toThrow();
    expect(w.windowId).toBe('schlafzimmer-dach-so');
    expect(w.lastCommandedLevel01).toBeNull();
    expect(w.lastCommandedAt).toBeNull();
    expect(w.manualOverrideUntil).toBeNull();
    expect(w.lastDecisionMode).toBeNull();
  });
});

describe('readState', () => {
  it('returns null when the file does not exist', async () => {
    const result = await readState({
      statePath: tmpStatePath('does-not-exist.json'),
    });

    expect(result).toBeNull();
  });

  it('returns null AND removes the file on corrupt JSON', async () => {
    const target = tmpStatePath();
    await fs.writeFile(target, '{ not: valid json,', 'utf8');

    const result = await readState({ statePath: target });

    expect(result).toBeNull();
    expect(await pathExists(target)).toBe(false);
  });

  it('returns null AND removes the file on schema-invalid payload', async () => {
    const target = tmpStatePath();
    const broken = {
      ...emptyRuntimeState(),
      // BANANA is not a valid Mode — schema must reject and discard.
      currentMode: 'BANANA',
    };
    await fs.writeFile(target, JSON.stringify(broken), 'utf8');

    const result = await readState({ statePath: target });

    expect(result).toBeNull();
    expect(await pathExists(target)).toBe(false);
  });

  it('returns null AND removes the file when ownSwitches has only four entries', async () => {
    const target = tmpStatePath();
    const empty = emptyRuntimeState();
    const broken = {
      ...empty,
      ownSwitches: empty.ownSwitches.slice(0, 4),
    };
    await fs.writeFile(target, JSON.stringify(broken), 'utf8');

    const result = await readState({ statePath: target });

    expect(result).toBeNull();
    expect(await pathExists(target)).toBe(false);
  });
});

describe('writeState + readState round-trip', () => {
  it('persists an empty state and reads back deep-equal', async () => {
    const target = tmpStatePath();
    const state = emptyRuntimeState();

    await writeState(state, { statePath: target });
    const read = await readState({ statePath: target });

    expect(read).toEqual(state);
  });

  it('persists a populated state with windows and storm hold', async () => {
    const target = tmpStatePath();
    const state: RuntimeState = {
      ...emptyRuntimeState(),
      currentMode: 'ACTIVE_HEAT_PROTECTION',
      lastCycleAt: '2024-06-21T12:00:00.000Z',
      stormHoldUntil: '2024-06-21T12:10:00.000Z',
      windows: [
        {
          windowId: 'schlafzimmer-dach-so',
          lastCommandedLevel01: 0.95,
          lastCommandedAt: '2024-06-21T11:58:00.000Z',
          manualOverrideUntil: '2024-06-21T13:00:00.000Z',
          lastDecisionMode: 'ACTIVE_HEAT_PROTECTION',
          shade: { state: 'open', shadedSince: null, belowReleaseSince: null },
        },
        {
          windowId: 'arbeitszimmer-fassade-so-tuer',
          lastCommandedLevel01: 0.4,
          lastCommandedAt: '2024-06-21T11:30:00.000Z',
          manualOverrideUntil: null,
          lastDecisionMode: 'SUMMER_WATCH',
          shade: { state: 'open', shadedSince: null, belowReleaseSince: null },
        },
      ],
    };
    state.ownSwitches[0] = {
      id: 'heatshield-state-active',
      value: true,
      engineConfirmed: true,
      updatedAt: '2024-06-21T12:00:00.000Z',
    };

    await writeState(state, { statePath: target });
    const read = await readState({ statePath: target });

    expect(read).toEqual(state);
  });

  it('does not leave a *.tmp sibling behind on a successful write', async () => {
    const target = tmpStatePath();

    await writeState(emptyRuntimeState(), { statePath: target });

    const entries = await fs.readdir(tmpDir);
    expect(entries.filter((e) => e.endsWith('.tmp'))).toEqual([]);
    expect(entries).toContain('state.json');
  });

  it('writes pretty-printed JSON with a trailing newline', async () => {
    const target = tmpStatePath();

    await writeState(emptyRuntimeState(), { statePath: target });
    const raw = await fs.readFile(target, 'utf8');

    expect(raw.endsWith('\n')).toBe(true);
    // Pretty-printed (2-space indent) means more than one line.
    expect(raw.split('\n').length).toBeGreaterThan(5);
  });

  it('creates the parent directory if it does not exist', async () => {
    const nested = path.join(tmpDir, 'nested', 'deeper', 'state.json');

    await writeState(emptyRuntimeState(), { statePath: nested });

    const stat = await fs.stat(nested);
    expect(stat.isFile()).toBe(true);
  });
});

describe('parseState — five-ownSwitches constraint', () => {
  it('throws a ZodError when ownSwitches has only four entries', () => {
    const empty = emptyRuntimeState();
    const broken = {
      ...empty,
      ownSwitches: empty.ownSwitches.slice(0, 4),
    };

    expect(() => parseState(broken)).toThrow(ZodError);
  });

  it('throws a ZodError when ownSwitches has six entries', () => {
    const empty = emptyRuntimeState();
    const broken = {
      ...empty,
      ownSwitches: [
        ...empty.ownSwitches,
        {
          id: 'heatshield-state-active',
          value: false,
          engineConfirmed: false,
          updatedAt: new Date().toISOString(),
        },
      ],
    };

    expect(() => parseState(broken)).toThrow(ZodError);
  });
});
