/**
 * Shared Building Model canonical/hash/revision tests
 * (shared-building-model 1.5/1.6, 3.1).
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  canonicalJson,
  contentHash,
  fnv1a64Hex,
  nextRevision,
  commitRevision,
  checkRevision,
} from '../../src/shared/building-model-canonical.js';
import { parseBuildingModel, type BuildingModel } from '../../src/shared/building-model.js';
import { validBuildingModel } from '../fixtures/building-model.js';

const clone = (m: BuildingModel): BuildingModel =>
  JSON.parse(JSON.stringify(m)) as BuildingModel;

/** Recursively rebuild an object with reversed key order (same content). */
function shuffleKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shuffleKeys);
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).reverse()) out[key] = shuffleKeys(obj[key]);
    return out;
  }
  return value;
}

describe('canonicalJson', () => {
  it('is independent of object key order', () => {
    const a = canonicalJson(validBuildingModel);
    const b = canonicalJson(shuffleKeys(validBuildingModel));
    expect(a).toBe(b);
  });

  it('round-trips: parse(canonicalJson(model)) deep-equals the model', () => {
    const parsed = parseBuildingModel(JSON.parse(canonicalJson(validBuildingModel)));
    expect(parsed).toEqual(validBuildingModel);
  });

  it('preserves meaningful array order (polygon)', () => {
    const m = clone(validBuildingModel);
    const reversed = clone(validBuildingModel);
    reversed.storeys[0]!.spaces[0]!.polygon.reverse();
    expect(canonicalJson(m)).not.toBe(canonicalJson(reversed));
  });
});

describe('contentHash', () => {
  it('ignores the revision counter', () => {
    const a = clone(validBuildingModel);
    const b = { ...clone(validBuildingModel), revision: 999 };
    expect(contentHash(a)).toBe(contentHash(b));
  });

  it('changes when geometry changes', () => {
    const a = clone(validBuildingModel);
    const b = clone(validBuildingModel);
    b.storeys[0]!.spaces[0]!.polygon[0]!.x += 0.5;
    expect(contentHash(a)).not.toBe(contentHash(b));
  });

  it('is stable across key-order shuffles', () => {
    const shuffled = shuffleKeys(validBuildingModel) as BuildingModel;
    expect(contentHash(shuffled)).toBe(contentHash(validBuildingModel));
  });

  it('produces 16-char hex', () => {
    expect(contentHash(validBuildingModel)).toMatch(/^[0-9a-f]{16}$/u);
  });
});

describe('fnv1a64Hex', () => {
  it('is deterministic and differs for different input', () => {
    expect(fnv1a64Hex('abc')).toBe(fnv1a64Hex('abc'));
    expect(fnv1a64Hex('abc')).not.toBe(fnv1a64Hex('abd'));
  });
});

describe('revisioning', () => {
  it('nextRevision increments by exactly one', () => {
    expect(nextRevision(validBuildingModel).revision).toBe(validBuildingModel.revision + 1);
  });

  it('commitRevision bumps only on content change', () => {
    const prev = clone(validBuildingModel);
    const same = clone(validBuildingModel);
    const r1 = commitRevision(prev, same);
    expect(r1.changed).toBe(false);
    expect(r1.model.revision).toBe(same.revision);

    const edited = clone(validBuildingModel);
    edited.storeys[0]!.spaces[0]!.name = 'Umbenannt';
    const r2 = commitRevision(prev, edited);
    expect(r2.changed).toBe(true);
    expect(r2.model.revision).toBe(prev.revision + 1);
  });

  it('checkRevision detects stale writes', () => {
    expect(checkRevision(3, 3)).toEqual({ ok: true });
    expect(checkRevision(3, 5)).toEqual({ ok: false, reason: 'stale', expected: 3, actual: 5 });
  });
});

describe('canonical/hash invariants (property)', () => {
  it('content hash is revision-independent for any revision value', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), (rev) => {
        const m = { ...clone(validBuildingModel), revision: rev };
        expect(contentHash(m)).toBe(contentHash(validBuildingModel));
      }),
    );
  });
});
