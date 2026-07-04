/**
 * Property-based invariants for the Shared Building Model (shared-building-model
 * 3.1). Builds random models through the pure editor commands and asserts the
 * canonical/hash/validation/migration contracts hold.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { newBuildingModel, newEditorState, addWall, addSpace, type EditorContext } from '../../src/shared/building-editor.js';
import { canonicalJson, contentHash, nextRevision } from '../../src/shared/building-model-canonical.js';
import { validateBuildingModel, type BuildingModel } from '../../src/shared/building-model.js';
import { migrateBuildingModel } from '../../src/shared/building-migrate.js';

function ctxFrom(seed: number): EditorContext {
  let n = seed;
  return {
    newId: (): string => {
      n += 1;
      return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
    },
  };
}

const coord = fc.integer({ min: -20, max: 20 });
const point = fc.record({ x: coord, y: coord });

function buildModel(ctx: EditorContext, walls: Array<Array<{ x: number; y: number }>>, rooms: Array<Array<{ x: number; y: number }>>): BuildingModel {
  let state = newEditorState(newBuildingModel(ctx, { latitude: 52.5, longitude: 13.4, timezone: 'Europe/Berlin' }));
  for (const axis of walls) state = addWall(ctx, state, { axis });
  for (const poly of rooms) state = addSpace(ctx, state, { name: 'R', polygon: poly });
  return state.model;
}

describe('building model invariants (property-based)', () => {
  it('editor-built models are always referentially valid', () => {
    fc.assert(
      fc.property(
        fc.array(fc.array(point, { minLength: 2, maxLength: 5 }), { maxLength: 6 }),
        fc.array(fc.array(point, { minLength: 3, maxLength: 6 }), { maxLength: 4 }),
        (walls, rooms) => {
          const model = buildModel(ctxFrom(1), walls, rooms);
          expect(validateBuildingModel(model).valid).toBe(true);
        },
      ),
    );
  });

  it('canonicalJson is stable and revision-independent for the hash', () => {
    fc.assert(
      fc.property(fc.array(fc.array(point, { minLength: 2, maxLength: 4 }), { maxLength: 5 }), (walls) => {
        const model = buildModel(ctxFrom(2), walls, []);
        // Structurally equal models → identical canonical string.
        const clone = JSON.parse(JSON.stringify(model)) as BuildingModel;
        expect(canonicalJson(model)).toBe(canonicalJson(clone));
        // A revision bump does NOT change the content hash.
        expect(contentHash(nextRevision(model))).toBe(contentHash(model));
      }),
    );
  });

  it('migrate ∘ serialize round-trips to an equal model', () => {
    fc.assert(
      fc.property(fc.array(fc.array(point, { minLength: 2, maxLength: 4 }), { maxLength: 5 }), (walls) => {
        const model = buildModel(ctxFrom(3), walls, []);
        const back = migrateBuildingModel(JSON.parse(JSON.stringify(model)));
        expect(back).toEqual(model);
      }),
    );
  });
});
