/**
 * Shared Building Model test fixtures (Gate 1, shared-building-model task 1.3).
 *
 * A small but fully valid two-storey model with one roof, one PV array, one
 * construction and one thermal zone. Cross-references are all resolvable, so
 * `validateBuildingModel` returns `{ valid: true, issues: [] }`.
 */

import type { BuildingModel } from '../../src/shared/building-model.js';

// Stable v4 UUIDs (literal so fixtures are deterministic across runs).
const U = {
  project: '00000000-0000-4000-8000-000000000001',
  storeyEg: '00000000-0000-4000-8000-000000000010',
  storeyOg: '00000000-0000-4000-8000-000000000011',
  wallEg: '00000000-0000-4000-8000-000000000020',
  wallOg: '00000000-0000-4000-8000-000000000021',
  openingEg: '00000000-0000-4000-8000-000000000030',
  openingOg: '00000000-0000-4000-8000-000000000031',
  spaceEg: '00000000-0000-4000-8000-000000000040',
  spaceOg: '00000000-0000-4000-8000-000000000041',
  roof: '00000000-0000-4000-8000-000000000050',
  pv: '00000000-0000-4000-8000-000000000060',
  construction: '00000000-0000-4000-8000-000000000070',
  zone: '00000000-0000-4000-8000-000000000080',
} as const;

export const validBuildingModel: BuildingModel = {
  schemaVersion: '1.0.0',
  id: U.project,
  revision: 1,
  site: {
    latitude: 52.0,
    longitude: 13.0,
    timezone: 'Europe/Berlin',
    northAzimuthDeg: 0,
  },
  storeys: [
    {
      id: U.storeyEg,
      name: 'EG',
      elevationM: 0,
      heightM: 2.5,
      walls: [
        {
          id: U.wallEg,
          axis: [
            { x: 0, y: 0 },
            { x: 5, y: 0 },
          ],
          thicknessM: 0.3,
          heightM: 2.5,
          constructionId: U.construction,
          boundary: 'outside',
        },
      ],
      openings: [
        {
          id: U.openingEg,
          type: 'window',
          hostWallId: U.wallEg,
          offsetM: 1,
          widthM: 1.2,
          heightM: 1.4,
          sillM: 0.9,
        },
      ],
      spaces: [
        {
          id: U.spaceEg,
          name: 'Wohnzimmer',
          polygon: [
            { x: 0, y: 0 },
            { x: 5, y: 0 },
            { x: 5, y: 4 },
            { x: 0, y: 4 },
          ],
          useProfileId: null,
          thermalZoneId: U.zone,
        },
      ],
    },
    {
      id: U.storeyOg,
      name: 'OG',
      elevationM: 2.5,
      heightM: 2.4,
      walls: [
        {
          id: U.wallOg,
          axis: [
            { x: 0, y: 0 },
            { x: 5, y: 0 },
          ],
          thicknessM: 0.3,
          heightM: 2.4,
          constructionId: null,
          boundary: 'outside',
        },
      ],
      openings: [
        {
          id: U.openingOg,
          type: 'window',
          hostWallId: U.wallOg,
          offsetM: 1,
          widthM: 1,
          heightM: 1.2,
          sillM: 0.8,
        },
      ],
      spaces: [
        {
          id: U.spaceOg,
          name: 'Schlafzimmer',
          polygon: [
            { x: 0, y: 0 },
            { x: 5, y: 0 },
            { x: 5, y: 4 },
            { x: 0, y: 4 },
          ],
          useProfileId: null,
          thermalZoneId: null,
        },
      ],
    },
  ],
  roofs: [
    {
      id: U.roof,
      type: 'gable',
      storeyId: U.storeyOg,
      pitchDeg: 35,
      ridgeAzimuthDeg: 135,
      overhangM: 0.5,
    },
  ],
  pvArrays: [
    {
      id: U.pv,
      roofFaceId: 'roof-face-se',
      rows: 3,
      columns: 6,
      moduleWidthM: 1.0,
      moduleHeightM: 1.7,
      gapM: 0.02,
    },
  ],
  constructions: [
    {
      id: U.construction,
      name: 'Außenwand 36cm',
      sourceType: 'template',
      uValueWm2K: 0.24,
      heatCapacityKJm2K: 120,
    },
  ],
  thermalZones: [
    {
      id: U.zone,
      name: 'Zone EG',
      spaceIds: [U.spaceEg],
    },
  ],
};

export const fixtureIds = U;
