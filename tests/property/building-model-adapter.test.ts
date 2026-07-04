/**
 * Compatibility adapter tests — config → candidate building model
 * (shared-building-model 2.5, DEC-004).
 */

import { describe, it, expect } from 'vitest';
import { parseConfig } from '../../src/shared/schema.js';
import type { Config } from '../../src/shared/types.js';
import {
  configToCandidateModel,
  deterministicUuid,
} from '../../src/shared/building-model-adapter.js';

const targets = { target_c: 24, warning_c: 26, strong_shade_c: 27, critical_c: 29 };

function makeConfig(): Config {
  return parseConfig({
    schemaVersion: 1,
    location: { latitude: 52.5, longitude: 13.1, timezone: 'Europe/Berlin' },
    globalSignals: { outdoorTemp: { primary: { kind: 'static', value: 20 } } },
    rooms: [
      { id: 'room-eg-wohnen', name: 'Wohnzimmer', floor: 'EG', priority: 'high', targets },
      { id: 'room-nofloor', name: 'Flur', priority: 'low', targets },
    ],
    windows: [
      {
        id: 'win-1',
        roomId: 'room-eg-wohnen',
        shutterDeviceId: 'dev-shutter-1',
        contactDeviceId: 'dev-contact-1',
        orientationDeg: 180,
        type: 'facade',
        areaM2: 2.0,
      },
      {
        id: 'win-roof',
        roomId: 'room-eg-wohnen',
        shutterDeviceId: 'dev-shutter-2',
        orientationDeg: 135,
        type: 'roof_window',
      },
      {
        id: 'win-orphan',
        roomId: 'room-missing',
        shutterDeviceId: 'dev-x',
        orientationDeg: 90,
        type: 'facade',
      },
    ],
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

describe('deterministicUuid', () => {
  it('is stable per seed and RFC-4122-v4 shaped', () => {
    expect(deterministicUuid('x')).toBe(deterministicUuid('x'));
    expect(deterministicUuid('x')).toMatch(UUID_RE);
    expect(deterministicUuid('x')).not.toBe(deterministicUuid('y'));
  });
});

describe('configToCandidateModel', () => {
  it('maps rooms→spaces and windows→openings', () => {
    const m = configToCandidateModel(makeConfig());
    expect(m.kind).toBe('candidate');
    expect(m.spaces).toHaveLength(2);
    // win-orphan is skipped → 2 openings.
    expect(m.openings).toHaveLength(2);
    expect(m.storeys.map((s) => s.name).sort()).toEqual(['EG', 'Sonstige']);
  });

  it('carries orientation/area through and marks roof windows', () => {
    const m = configToCandidateModel(makeConfig());
    const roof = m.openings.find((o) => o.isRoofWindow);
    const facade = m.openings.find((o) => !o.isRoofWindow);
    expect(facade?.orientationDeg).toBe(180);
    expect(facade?.areaM2).toBe(2.0);
    expect(roof?.orientationDeg).toBe(135);
    expect(roof?.areaM2).toBeNull();
  });

  it('emits NO geometry: spaces have null polygon, openings null host wall', () => {
    const m = configToCandidateModel(makeConfig());
    expect(m.spaces.every((s) => s.polygon === null && s.meta.hasGeometry === false)).toBe(true);
    expect(m.openings.every((o) => o.hostWallId === null)).toBe(true);
  });

  it('keeps original ids as aliases (both directions)', () => {
    const m = configToCandidateModel(makeConfig());
    const space = m.spaces.find((s) => s.meta.aliasOf === 'room-eg-wohnen');
    expect(space).toBeDefined();
    expect(m.aliases).toContainEqual({
      kind: 'space',
      originalId: 'room-eg-wohnen',
      uuid: space!.id,
    });
  });

  it('keeps device bindings outside geometry', () => {
    const m = configToCandidateModel(makeConfig());
    const b = m.bindings.find((x) => x.windowAlias === 'win-1');
    expect(b?.shutterDeviceId).toBe('dev-shutter-1');
    expect(b?.contactDeviceId).toBe('dev-contact-1');
    const roofBinding = m.bindings.find((x) => x.windowAlias === 'win-roof');
    expect(roofBinding?.contactDeviceId).toBeNull();
  });

  it('warns about no-geometry, assumed north, unknown floor and orphan window', () => {
    const m = configToCandidateModel(makeConfig());
    const codes = m.warnings.map((w) => w.code);
    expect(codes).toContain('NO_GEOMETRY');
    expect(codes).toContain('ASSUMED_NORTH');
    expect(codes).toContain('UNKNOWN_FLOOR');
    expect(codes).toContain('ORPHAN_WINDOW');
  });

  it('is deterministic (idempotent) and does not mutate input', () => {
    const cfg = makeConfig();
    const snapshot = JSON.stringify(cfg);
    const a = configToCandidateModel(cfg);
    const b = configToCandidateModel(cfg);
    expect(a).toEqual(b);
    expect(JSON.stringify(cfg)).toBe(snapshot);
  });
});
