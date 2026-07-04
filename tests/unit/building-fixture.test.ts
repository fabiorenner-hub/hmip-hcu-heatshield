/**
 * Golden building-model fixture (shared-building-model 1.3). The committed
 * example instance is bound to the Zod contract here so it can never silently
 * drift from the schema: it must parse, be referentially valid, migrate as an
 * identity, and canonicalise deterministically.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

import { parseBuildingModel, validateBuildingModel } from '../../src/shared/building-model.js';
import { migrateBuildingModel } from '../../src/shared/building-migrate.js';
import { canonicalJson, contentHash } from '../../src/shared/building-model-canonical.js';
import { buildMesh, faceCounts } from '../../src/shared/building-mesh.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(here, '..', 'fixtures', 'building-model.example.json');
const raw = JSON.parse(readFileSync(fixturePath, 'utf8')) as unknown;

describe('golden building-model fixture', () => {
  it('parses against the Zod schema', () => {
    expect(() => parseBuildingModel(raw)).not.toThrow();
  });

  it('is referentially valid', () => {
    const model = parseBuildingModel(raw);
    expect(validateBuildingModel(model).valid).toBe(true);
  });

  it('migrates as an identity (current schema version)', () => {
    const model = parseBuildingModel(raw);
    expect(migrateBuildingModel(raw)).toEqual(model);
  });

  it('canonicalises deterministically and hashes stably', () => {
    const model = parseBuildingModel(raw);
    expect(canonicalJson(model)).toBe(canonicalJson(parseBuildingModel(raw)));
    expect(contentHash(model)).toMatch(/^[0-9a-f]{16}$/u);
  });

  it('meshes into walls (with the window cut) + a room floor/ceiling + a flat roof', () => {
    const model = parseBuildingModel(raw);
    const c = faceCounts(buildMesh(model));
    // The window opening is cut as a real hole, so the hosting wall segment
    // emits extra panels + reveal faces (more than the naive 24-face box).
    expect(c.wall).toBeGreaterThan(24);
    expect(c.floor).toBe(1);
    expect(c.ceiling).toBe(1);
    expect(c.roof).toBe(1);
  });
});
