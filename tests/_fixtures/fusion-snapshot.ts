/**
 * Heat Shield — realistic FusionSolar `/api/snapshot` fixture.
 *
 * Captured from the live HCU (`http://host.containers.internal:8088/api/snapshot`)
 * during a sunny midday window. Fields irrelevant to the heat-shield
 * adapter are kept verbatim so the `.passthrough()` branches in
 * `SnapshotResponseSchema` are exercised by the tests.
 *
 * Tests must clone this body before mutating to keep cases independent:
 * use `structuredClone(fusionSnapshotBody)` or a hand-written deep
 * spread.
 */
export const fusionSnapshotBody = {
  snapshot: {
    connected: true,
    lastUpdate: 1779446393383,
    lastError: null,
    static: {
      batteryRatedCapacity: 5000,
      model: 'SUN2000-8KTL-M1',
      sn: 'BT21C0060114',
      firmwareVersion: 'V100R001-02',
      ratedPower: 8000,
    },
    values: {
      inputPower: 2484,
      activePower: 2474,
      meterActivePower: -315,
      batterySoc: 100,
      batteryChargeDischargePower: 24,
      internalTemp: 46.6,
    },
  },
  devices: [],
  hcu: { id: 'hcu-example' },
  config: { pollSeconds: 30 },
  stats: { pollsOk: 1234, pollsFail: 0 },
} as const;
