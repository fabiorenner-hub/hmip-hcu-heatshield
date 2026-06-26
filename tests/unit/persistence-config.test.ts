/**
 * Tests for the persistence layer (`src/plugin/persistence/config.ts`).
 *
 * Each test allocates its own temp directory under `os.tmpdir()` so the
 * suite never touches `/data/`. The directory is removed in `afterEach`
 * regardless of test outcome.
 *
 * Coverage:
 *   - readConfig on a non-existent path → status: 'absent'.
 *   - writeConfig + readConfig round-trip (deep-equal).
 *   - readConfig on invalid JSON → status: 'invalid_json', SyntaxError.
 *   - readConfig on schemaVersion 99 → status: 'unsupported_version',
 *     error.code === 'UNSUPPORTED_VERSION'.
 *   - readConfig on a payload missing `location` → status: 'invalid_schema'.
 *   - writeConfig creates the parent directory if it does not exist.
 *   - writeConfig leaves no `*.tmp` siblings on a successful write.
 *   - readOrSeed returns the seed on a missing file and persists it.
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_CONFIG_PATH,
  readConfig,
  readOrSeed,
  writeConfig,
} from '../../src/plugin/persistence/config.js';
import { parseConfig } from '../../src/shared/schema.js';
import type { Config } from '../../src/shared/types.js';
import { validRealisticConfig } from '../_fixtures/config.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'heat-shield-cfg-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function tmpConfigPath(name = 'config.json'): string {
  return path.join(tmpDir, name);
}

function realConfig(): Config {
  return parseConfig(validRealisticConfig());
}

describe('persistence/config — DEFAULT_CONFIG_PATH', () => {
  it('points at /data/config.json per the steering rule', () => {
    expect(DEFAULT_CONFIG_PATH).toBe('/data/config.json');
  });
});

describe('readConfig', () => {
  it('returns status=absent when the file does not exist', async () => {
    const result = await readConfig({
      configPath: tmpConfigPath('does-not-exist.json'),
    });

    expect(result.status).toBe('absent');
    expect(result.config).toBeNull();
    expect(result.error).toBeUndefined();
  });

  it('returns status=invalid_json with a SyntaxError on a corrupt file', async () => {
    const target = tmpConfigPath();
    await fs.writeFile(target, '{ not: valid json,', 'utf8');

    const result = await readConfig({ configPath: target });

    expect(result.status).toBe('invalid_json');
    expect(result.config).toBeNull();
    expect(result.error).toBeInstanceOf(SyntaxError);
  });

  it('returns status=unsupported_version when schemaVersion is 99', async () => {
    const target = tmpConfigPath();
    await fs.writeFile(target, JSON.stringify({ schemaVersion: 99 }), 'utf8');

    const result = await readConfig({ configPath: target });

    expect(result.status).toBe('unsupported_version');
    expect(result.config).toBeNull();
    expect(result.error).toBeDefined();
    expect((result.error as { code?: string }).code).toBe(
      'UNSUPPORTED_VERSION',
    );
  });

  it('returns status=invalid_schema when location is missing', async () => {
    const target = tmpConfigPath();
    const broken = validRealisticConfig();
    delete (broken as Record<string, unknown>)['location'];
    await fs.writeFile(target, JSON.stringify(broken), 'utf8');

    const result = await readConfig({ configPath: target });

    expect(result.status).toBe('invalid_schema');
    expect(result.config).toBeNull();
    expect(result.error).toBeDefined();
  });
});

describe('writeConfig', () => {
  it('round-trips a realistic config through the filesystem', async () => {
    const target = tmpConfigPath();
    const config = realConfig();

    await writeConfig(config, { configPath: target });
    const read = await readConfig({ configPath: target });

    expect(read.status).toBe('ok');
    expect(read.config).toEqual(config);
  });

  it('creates the parent directory if it does not exist', async () => {
    const nested = path.join(tmpDir, 'nested', 'deeper', 'config.json');
    const config = realConfig();

    await writeConfig(config, { configPath: nested });

    const stat = await fs.stat(nested);
    expect(stat.isFile()).toBe(true);
  });

  it('does not leave a *.tmp sibling behind on a successful write', async () => {
    const target = tmpConfigPath();
    const config = realConfig();

    await writeConfig(config, { configPath: target });

    const entries = await fs.readdir(tmpDir);
    const tmpResidue = entries.filter((e) => e.endsWith('.tmp'));
    expect(tmpResidue).toEqual([]);
    expect(entries).toContain('config.json');
  });

  it('writes human-readable JSON with trailing newline', async () => {
    const target = tmpConfigPath();
    const config = realConfig();

    await writeConfig(config, { configPath: target });
    const raw = await fs.readFile(target, 'utf8');

    expect(raw.endsWith('\n')).toBe(true);
    // Pretty-printed (2-space indent) means more than one line.
    expect(raw.split('\n').length).toBeGreaterThan(5);
  });

  it('overwrites an existing file', async () => {
    const target = tmpConfigPath();
    const first = realConfig();
    await writeConfig(first, { configPath: target });

    const second: Config = { ...first, schemaVersion: 1 };
    second.dashboard = { ...second.dashboard, port: 9090 };
    await writeConfig(second, { configPath: target });

    const read = await readConfig({ configPath: target });
    expect(read.status).toBe('ok');
    expect(read.config?.dashboard.port).toBe(9090);
  });
});

describe('readOrSeed', () => {
  it('seeds the file when it is missing and returns the seed', async () => {
    const target = tmpConfigPath();
    const seed = realConfig();

    const returned = await readOrSeed(() => seed, { configPath: target });

    expect(returned).toEqual(seed);
    const stat = await fs.stat(target);
    expect(stat.isFile()).toBe(true);
  });

  it('returns the persisted config on a second call without re-seeding', async () => {
    const target = tmpConfigPath();
    const seed = realConfig();
    let seedCalls = 0;
    const seedFn = (): Config => {
      seedCalls += 1;
      return seed;
    };

    await readOrSeed(seedFn, { configPath: target });
    const second = await readOrSeed(seedFn, { configPath: target });

    expect(second).toEqual(seed);
    expect(seedCalls).toBe(1);
  });

  it('rethrows the underlying error on invalid_json', async () => {
    const target = tmpConfigPath();
    await fs.writeFile(target, 'not json', 'utf8');

    await expect(
      readOrSeed(() => realConfig(), { configPath: target }),
    ).rejects.toBeInstanceOf(SyntaxError);
  });
});
