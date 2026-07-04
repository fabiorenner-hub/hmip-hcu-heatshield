/**
 * Automatic room detection (BME-10) — planar face traversal of the wall graph.
 */

import { describe, expect, it } from 'vitest';

import { detectRooms, pointInPolygon, centroid } from '../../src/shared/building-rooms.js';
import type { Wall } from '../../src/shared/building-model.js';

function wall(id: string, axis: Array<[number, number]>): Wall {
  return {
    id: `00000000-0000-4000-8000-${id.padStart(12, '0')}`,
    axis: axis.map(([x, y]) => ({ x, y })),
    thicknessM: 0.24,
    heightM: null,
    constructionId: null,
    boundary: 'outside',
  };
}

describe('detectRooms', () => {
  it('finds no room for an open polyline', () => {
    const walls = [wall('1', [[0, 0], [4, 0], [4, 3]])];
    expect(detectRooms(walls)).toHaveLength(0);
  });

  it('finds one room for a closed square (single wall)', () => {
    const walls = [wall('1', [[0, 0], [4, 0], [4, 3], [0, 3], [0, 0]])];
    const rooms = detectRooms(walls);
    expect(rooms).toHaveLength(1);
    expect(rooms[0]!.areaM2).toBeCloseTo(12, 6);
  });

  it('finds one room for a square built from four separate walls', () => {
    const walls = [
      wall('1', [[0, 0], [4, 0]]),
      wall('2', [[4, 0], [4, 3]]),
      wall('3', [[4, 3], [0, 3]]),
      wall('4', [[0, 3], [0, 0]]),
    ];
    const rooms = detectRooms(walls);
    expect(rooms).toHaveLength(1);
    expect(rooms[0]!.areaM2).toBeCloseTo(12, 6);
  });

  it('finds two rooms for two squares sharing a middle wall', () => {
    // Left square 0..4, right square 4..8, shared edge x=4.
    const walls = [
      wall('1', [[0, 0], [4, 0]]),
      wall('2', [[4, 0], [8, 0]]),
      wall('3', [[8, 0], [8, 3]]),
      wall('4', [[8, 3], [4, 3]]),
      wall('5', [[4, 3], [0, 3]]),
      wall('6', [[0, 3], [0, 0]]),
      wall('7', [[4, 0], [4, 3]]), // shared middle wall
    ];
    const rooms = detectRooms(walls);
    expect(rooms).toHaveLength(2);
    expect(rooms.reduce((s, r) => s + r.areaM2, 0)).toBeCloseTo(24, 6);
  });

  it('snaps near-coincident endpoints within tolerance', () => {
    const walls = [
      wall('1', [[0, 0], [4, 0]]),
      wall('2', [[4.01, 0], [4, 3]]),
      wall('3', [[4, 3], [0, 3]]),
      wall('4', [[0, 3], [0.0, 0.01]]),
    ];
    expect(detectRooms(walls, 0.05)).toHaveLength(1);
  });
});

describe('polygon helpers', () => {
  it('pointInPolygon detects inside/outside', () => {
    const sq = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }];
    expect(pointInPolygon({ x: 2, y: 2 }, sq)).toBe(true);
    expect(pointInPolygon({ x: 5, y: 2 }, sq)).toBe(false);
  });

  it('centroid averages vertices', () => {
    expect(centroid([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }])).toEqual({ x: 2, y: 2 });
  });
});
