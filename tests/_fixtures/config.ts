/**
 * Heat Shield — shared test fixtures.
 *
 * These factories return fresh, deep-independent JSON-safe objects on every
 * call so individual tests can mutate them (e.g. drop a required field, set
 * an out-of-range value) without leaking state into the next case.
 *
 * Both fixtures are intentionally hand-written rather than derived from
 * `parseConfig` defaults: the point of the schema tests is that the schema
 * itself fills in missing fields, so we need a *raw* representative input
 * to feed into it.
 */

/**
 * Minimal valid config — only the fields that have no documented default
 * in design.md / regelwerk §19. Everything else must come from Zod
 * defaults / `prefault({})` after `parseConfig`.
 */
export function validMinimalConfig(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    location: {
      latitude: 52.52,
      longitude: 13.41,
      timezone: 'Europe/Berlin',
    },
    globalSignals: {
      outdoorTemp: {
        primary: { kind: 'static', value: 18.5 },
      },
    },
  };
}

/**
 * Realistic config matching design.md §Data Models. Exercises:
 *   - two rooms (Schlafzimmer, Arbeitszimmer) with all four target fields,
 *   - two windows: one SO-Dachfenster (roof_window) and one SO-Fassade-Tür
 *     (`isDoor=true`, `lockoutProtection=true`),
 *   - all four `SourceRef` discriminator variants (`static`, `hmip`,
 *     `fusion`, `openmeteo`) at least once across `globalSignals` and the
 *     room-level signal bindings.
 */
export function validRealisticConfig(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    location: {
      latitude: 52.52,
      longitude: 13.41,
      timezone: 'Europe/Berlin',
    },
    globalSignals: {
      // Primary HMIP CLIMATE_SENSOR with OpenMeteo CLIMATE_SENSOR fallback.
      outdoorTemp: {
        primary: {
          kind: 'hmip',
          deviceId: 'climate-outdoor-1',
          feature: 'actualTemperature',
        },
        fallback: {
          kind: 'openmeteo',
          deviceId: 'openmeteo-example',
          feature: 'actualTemperature',
        },
        staleAfterSec: 900,
      },
      // PV power from FusionSolar plugin.
      pvPower: {
        primary: { kind: 'fusion', field: 'activePower' },
      },
      windSpeed: {
        primary: {
          kind: 'openmeteo',
          deviceId: 'openmeteo-example',
          feature: 'windSpeed',
        },
      },
    },
    fusionSolar: {
      baseUrl: 'http://host.containers.internal:8088',
      pvPeakKwp: 8.8,
      orientationHint: 'southeast',
    },
    rooms: [
      {
        id: 'schlafzimmer',
        name: 'Schlafzimmer',
        priority: 'very_high',
        targets: {
          target_c: 22,
          warning_c: 24,
          strong_shade_c: 25.5,
          critical_c: 27,
        },
        signals: {
          indoorTemp: {
            primary: {
              kind: 'hmip',
              deviceId: 'climate-bedroom',
              feature: 'actualTemperature',
            },
          },
        },
        occupancyMode: 'always_priority',
      },
      {
        id: 'arbeitszimmer',
        name: 'Arbeitszimmer',
        priority: 'high',
        targets: {
          target_c: 22.5,
          warning_c: 24.5,
          strong_shade_c: 26,
          critical_c: 27.5,
        },
        signals: {
          indoorTemp: {
            primary: {
              kind: 'hmip',
              deviceId: 'climate-office',
              feature: 'actualTemperature',
            },
          },
          // Static fallback used as a sanity check for the `static` variant.
          illumination: {
            primary: { kind: 'static', value: 0 },
          },
        },
        occupancyMode: 'always_priority',
      },
    ],
    windows: [
      {
        id: 'schlafzimmer-dach-so',
        roomId: 'schlafzimmer',
        shutterDeviceId: 'shutter-bedroom-roof',
        contactDeviceId: 'contact-bedroom-roof',
        orientationDeg: 135,
        type: 'roof_window',
        isDoor: false,
        canMoveWhenOpen: true,
        maxPositionWhenOpenPct: 60,
        sunPrelookMinutes: 60,
        lockoutProtection: true,
      },
      {
        id: 'arbeitszimmer-fassade-so-tuer',
        roomId: 'arbeitszimmer',
        shutterDeviceId: 'shutter-office-door',
        contactDeviceId: 'contact-office-door',
        orientationDeg: 135,
        type: 'facade',
        isDoor: true,
        canMoveWhenOpen: false,
        maxPositionWhenOpenPct: 0,
        sunPrelookMinutes: 45,
        lockoutProtection: true,
      },
    ],
    rules: {
      profile: 'standard',
      comfort: {
        maxIndoorTempC: 25,
        preShadeTempC: 23.5,
        nightCoolingDeltaC: 1.5,
      },
      automation: {
        controlIntervalSeconds: 180,
        minSecondsBetweenMoves: 900,
        minPositionDeltaPct: 15,
        temperatureHysteresisC: 0.5,
        pvHysteresisKw: 0.7,
        pvSmoothingSamples: 3,
        forecastHorizonMinutes: 60,
      },
      sun: {
        minElevationDeg: 5,
        maxIncidenceAngleFacadeDeg: 90,
        maxIncidenceAngleRoofDeg: 95,
      },
      storm: {
        enabled: true,
        thresholdMs: 13.9,
        releaseMs: 8.0,
        releaseHoldMin: 10,
      },
      nightCooling: {
        enabled: true,
        deltaC: 1.5,
        reopenAtSunriseOffsetMin: -30,
      },
      manualOverrideMinutes: 60,
    },
    dashboard: {
      port: 8089,
      enabled: true,
    },
  };
}
