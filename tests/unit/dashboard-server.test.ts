/**
 * Heat Shield — Dashboard server unit tests (Task 10.4 + 10.1/10.2/10.3).
 *
 * Drives the Fastify routes through `app.inject()` so the test runner
 * never opens a real listener. Every dependency on
 * {@link DashboardServerDeps} is mocked via `vi.fn()`; a fixture
 * factory keeps each test focused on the interaction under
 * inspection.
 *
 * Headline coverage (Task 10.4):
 *
 *   - `PUT /api/config` with a body missing `location` returns 400
 *     with `error.code === 'invalid_schema'`,
 *     `error.issues[0].path` includes `'location'`, and the body is
 *     JSON-parseable.
 *   - The same applies to non-JSON payloads (Fastify's strict JSON
 *     parser turns those into a 400 itself; we assert the wire shape
 *     is still our `invalid_*` envelope).
 */

import { describe, expect, it, vi, type Mock } from 'vitest';

import {
  DashboardServer,
  type DashboardServerDeps,
  type DashboardSnapshot,
  type DashboardStreamEvent,
} from '../../src/plugin/dashboard/server.js';
import type { Config } from '../../src/shared/types.js';
import type { HistoryRecord } from '../../src/plugin/persistence/history.js';
import type {
  DecisionRecord,
  WindowDecisionEntry,
  Mode,
} from '../../src/shared/types.js';
import type { HmipDeviceMeta } from '../../src/plugin/sources/hcu.js';

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

/**
 * Minimal valid Config covering Beispielstadt (the steering's default
 * location). The wizard tests reuse this as the baseline payload.
 */
function exampleConfig(): Config {
  return {
    schemaVersion: 1,
    automationEnabled: false,
    location: {
      latitude: 52.52,
      longitude: 13.41,
      timezone: 'Europe/Berlin',
    },
    globalSignals: {
      outdoorTemp: {
        primary: { kind: 'static', value: 22 },
        staleAfterSec: 600,
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
          warning_c: 23.5,
          strong_shade_c: 24,
          critical_c: 25,
        },
        signals: {},
        occupancyMode: 'always_priority',
      },
    ],
    windows: [
      {
        id: 'fenster-1',
        roomId: 'schlafzimmer',
        shutterDeviceId: 'hmip-shutter-1',
        orientationDeg: 135,
        type: 'roof_window',
        isDoor: false,
        canMoveWhenOpen: true,
        maxPositionWhenOpenPct: 60,
        sunPrelookMinutes: 60,
        lockoutProtection: true,
      },
    ],
    rules: {
      profile: 'standard',
      comfort: {
        maxIndoorTempC: 25,
        preShadeTempC: 23.5,
        nightCoolingDeltaC: 1.5,
        vacationOffsetC: 0.5,
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
        releaseMs: 8,
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

function snapshotFixture(): DashboardSnapshot {
  return {
    ts: '2026-06-21T12:00:00.000Z',
    mode: 'NORMAL',
    rooms: [{ id: 'schlafzimmer', tempC: 22.4 }],
    windows: [
      {
        id: 'fenster-1',
        currentLevel01: 0.3,
        manualOverrideUntil: null,
        lastDecisionMode: 'NORMAL',
      },
    ],
    sources: {
      fusionSolar: {
        sourceOk: true,
        lastSuccess: '2026-06-21T11:59:30.000Z',
        consecutiveFailures: 0,
      },
      hcu: { connected: true },
    },
    userIntent: {
      paused: false,
      pauseUntil: null,
      vacation: false,
    },
    storm: { holdUntil: null },
    pluginReadiness: 'READY',
    automationEnabled: false,
  };
}

function probeFixture(mode: Mode = 'NORMAL'): {
  mode: Mode;
  windowDecisions: WindowDecisionEntry[];
} {
  return {
    mode,
    windowDecisions: [
      {
        windowId: 'fenster-1',
        factors: { sunFactor: 0.5 },
        risk: 0.5,
        rawTarget: 0.7,
        afterSpecialRules: 0.7,
        afterSafety: 0.7,
        finalTarget: 0.7,
        moved: false,
      },
    ],
  };
}

function decisionRecord(idx: number): HistoryRecord<DecisionRecord> {
  const ts = new Date(Date.UTC(2026, 5, 21, 12, idx, 0)).toISOString();
  const cycleId = `cycle-${idx.toString().padStart(3, '0')}`;
  return {
    ts,
    cycleId,
    payload: {
      cycleId,
      ts,
      mode: 'NORMAL',
      windowDecisions: [],
    },
  };
}

interface MockedDeps {
  deps: DashboardServerDeps;
  config: Mock;
  updateConfig: Mock;
  readState: Mock;
  readDecisions: Mock;
  readHistory: Mock;
  readTrends: Mock;
  getSnapshot: Mock;
  probe: Mock;
  setShutterManually: Mock;
  setMaintenanceMode: Mock;
  setAutomationEnabled: Mock;
  resetConfig: Mock;
  subscribe: Mock;
  emitter: { emit: (event: DashboardStreamEvent) => void };
  discoverSources: Mock | undefined;
  getConnectLog: Mock | undefined;
  runProbe: Mock | undefined;
  getLearningSnapshot: Mock | undefined;
  applyRecommendation: Mock | undefined;
  dismissRecommendation: Mock | undefined;
  getMessages: Mock | undefined;
  markMessagesRead: Mock | undefined;
  sendTestNotification: Mock | undefined;
}

interface FixtureOptions {
  withDiscover?: boolean;
  withConnectLog?: boolean;
  withRunProbe?: boolean;
  withLearningSnapshot?: boolean;
  withApplyRecommendation?: boolean;
  withDismissRecommendation?: boolean;
  applyReturnsNotFound?: boolean;
  withMessages?: boolean;
}

function makeFixture(options: FixtureOptions = {}): MockedDeps {
  const handlers = new Set<(event: DashboardStreamEvent) => void>();
  const subscribe = vi.fn((handler: (event: DashboardStreamEvent) => void) => {
    handlers.add(handler);
    return (): void => {
      handlers.delete(handler);
    };
  });
  const emitter = {
    emit: (event: DashboardStreamEvent): void => {
      for (const h of handlers) {
        h(event);
      }
    },
  };

  let currentConfig: Config = exampleConfig();
  const config = vi.fn(() => currentConfig);
  const updateConfig = vi.fn(async (c: Config) => {
    currentConfig = c;
  });

  const readState = vi.fn(async () => null);
  const readDecisions = vi.fn(async (n: number) => {
    const out: HistoryRecord<DecisionRecord>[] = [];
    for (let i = 0; i < n; i += 1) {
      out.push(decisionRecord(i));
    }
    return out;
  });
  const readHistory = vi.fn(async (_seconds: number) => {
    return [decisionRecord(0), decisionRecord(1)];
  });
  const readTrends = vi.fn(async (_seconds: number) => {
    return [
      { ts: '2026-06-21T12:00:00.000Z', key: 'outdoor', value: 22.5 },
      { ts: '2026-06-21T12:03:00.000Z', key: 'outdoor', value: 23.1 },
      { ts: '2026-06-21T12:00:00.000Z', key: 'pv', value: 4.2 },
    ];
  });
  const getSnapshot = vi.fn(async () => snapshotFixture());
  const probe = vi.fn(async (_overrideConfig?: Config) => probeFixture());
  const setShutterManually = vi.fn(async () => {});
  const setMaintenanceMode = vi.fn(async () => {});
  const setAutomationEnabled = vi.fn(async () => {});
  const resetConfig = vi.fn(async () => {});

  let discoverSources: Mock | undefined;
  if (options.withDiscover === true) {
    const fakeMeta: HmipDeviceMeta = {
      deviceId: 'meteo-1',
      deviceType: 'CLIMATE_SENSOR',
      friendlyName: 'OpenMeteo Beispielstadt',
    };
    discoverSources = vi.fn(() => ({
      devices: [fakeMeta],
      climateSensors: [fakeMeta],
      openMeteo: [fakeMeta],
    }));
  }

  let getConnectLog: Mock | undefined;
  if (options.withConnectLog === true) {
    // Pre-canned log slice (oldest first). Three entries with two
    // levels so the route's `n=` slicing and the level filter on the
    // SPA can be exercised without a real `ConnectLogBuffer`.
    const fakeLog: Array<{
      ts: string;
      level: string;
      msg: string;
      ctx?: Record<string, unknown>;
    }> = [
      { ts: '2026-06-21T12:00:00.000Z', level: 'info', msg: 'connect open' },
      { ts: '2026-06-21T12:00:01.000Z', level: 'warn', msg: 'reconnect' },
      {
        ts: '2026-06-21T12:00:02.000Z',
        level: 'error',
        msg: 'send failed',
        ctx: { code: 'ECONNRESET' },
      },
    ];
    getConnectLog = vi.fn(() => fakeLog);
  }

  let runProbe: Mock | undefined;
  if (options.withRunProbe === true) {
    runProbe = vi.fn(async () => ({
      ...probeFixture(),
      ts: '2026-06-21T12:05:00.000Z',
      cycleId: 'probe-001',
    }));
  }

  let getLearningSnapshot: Mock | undefined;
  if (options.withLearningSnapshot === true) {
    getLearningSnapshot = vi.fn(async () => ({
      computedAt: '2026-06-21T20:00:00.000Z',
      metrics: [
        {
          date: '2026-06-19',
          roomId: 'schlafzimmer',
          preShadeRiseCph: 0.4,
          postShadeRiseCph: 0.2,
          effectiveShadeGain: 0.2,
          firstShadeTimeIso: '2026-06-19T09:00:00.000Z',
          samplesPre: 12,
          samplesPost: 12,
        },
      ],
      recommendations: [
        {
          id: 'lowGain-schlafzimmer',
          roomId: 'schlafzimmer',
          severity: 'warn',
          title: 'Vorausschauzeit erhöhen',
          message: 'Hitzeschutz wirkt zu schwach.',
          createdAt: '2026-06-21T20:00:00.000Z',
          suggestedConfigPatch: {
            path: ['windows', 0, 'sunPrelookMinutes'],
            from: 60,
            to: 90,
          },
        },
      ],
    }));
  }

  let applyRecommendation: Mock | undefined;
  if (options.withApplyRecommendation === true) {
    if (options.applyReturnsNotFound === true) {
      applyRecommendation = vi.fn(async () => ({ ok: false }));
    } else {
      applyRecommendation = vi.fn(async (_id: string) => ({
        ok: true,
        appliedPatch: {
          path: ['windows', 0, 'sunPrelookMinutes'],
          from: 60,
          to: 90,
        },
      }));
    }
  }

  let dismissRecommendation: Mock | undefined;
  if (options.withDismissRecommendation === true) {
    dismissRecommendation = vi.fn(async () => ({ ok: true }));
  }

  let getMessages: Mock | undefined;
  let markMessagesRead: Mock | undefined;
  let sendTestNotification: Mock | undefined;
  if (options.withMessages === true) {
    const msgs = [
      {
        id: 'msg-1',
        ts: '2026-06-22T08:00:00.000Z',
        kind: 'close' as const,
        title: 'Hitzeschutz aktiv',
        body: 'Rollladen fährt herunter.',
        read: false,
      },
      {
        id: 'msg-2',
        ts: '2026-06-22T09:00:00.000Z',
        kind: 'ventilate' as const,
        title: 'Lüften empfohlen',
        body: 'Jetzt lüften.',
        read: true,
      },
    ];
    getMessages = vi.fn(() => msgs);
    markMessagesRead = vi.fn(async (_ids?: readonly string[]) => 0);
    sendTestNotification = vi.fn(async () => ({ ok: true }));
  }

  const deps: DashboardServerDeps = {
    config,
    updateConfig,
    readState,
    readDecisions,
    readHistory,
    readTrends,
    getSnapshot,
    probe,
    setShutterManually,
    setMaintenanceMode,
    setAutomationEnabled,
    resetConfig,
    subscribe,
    ...(discoverSources !== undefined ? { discoverSources } : {}),
    ...(getConnectLog !== undefined ? { getConnectLog } : {}),
    ...(runProbe !== undefined ? { runProbe } : {}),
    ...(getLearningSnapshot !== undefined ? { getLearningSnapshot } : {}),
    ...(applyRecommendation !== undefined ? { applyRecommendation } : {}),
    ...(dismissRecommendation !== undefined
      ? { dismissRecommendation }
      : {}),
    ...(getMessages !== undefined ? { getMessages } : {}),
    ...(markMessagesRead !== undefined ? { markMessagesRead } : {}),
    ...(sendTestNotification !== undefined ? { sendTestNotification } : {}),
  };

  return {
    deps,
    config,
    updateConfig,
    readState,
    readDecisions,
    readHistory,
    readTrends,
    getSnapshot,
    probe,
    setShutterManually,
    setMaintenanceMode,
    setAutomationEnabled,
    resetConfig,
    subscribe,
    emitter,
    discoverSources,
    getConnectLog,
    runProbe,
    getLearningSnapshot,
    applyRecommendation,
    dismissRecommendation,
    getMessages,
    markMessagesRead,
    sendTestNotification,
  };
}

function makeServer(options: FixtureOptions = {}): {
  server: DashboardServer;
  fx: MockedDeps;
} {
  const fx = makeFixture(options);
  const server = new DashboardServer(fx.deps, { port: 0 });
  return { server, fx };
}

// ---------------------------------------------------------------------------
// /api/state.
// ---------------------------------------------------------------------------

describe('GET /api/state', () => {
  it('returns the snapshot JSON', async () => {
    const { server, fx } = makeServer();
    try {
      const res = await server.fastify.inject({
        method: 'GET',
        url: '/api/state',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as DashboardSnapshot;
      expect(body).toEqual(snapshotFixture());
      expect(fx.getSnapshot).toHaveBeenCalledTimes(1);
    } finally {
      await server.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// /api/config — happy path + Task 10.4 schema-conflict contract.
// ---------------------------------------------------------------------------

describe('GET /api/config', () => {
  it('returns the current config', async () => {
    const { server, fx } = makeServer();
    try {
      const res = await server.fastify.inject({
        method: 'GET',
        url: '/api/config',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Config;
      expect(body.location.timezone).toBe('Europe/Berlin');
      expect(fx.config).toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });
});

describe('PUT /api/config', () => {
  it('persists a valid body and returns 200 ok', async () => {
    const { server, fx } = makeServer();
    try {
      const res = await server.fastify.inject({
        method: 'PUT',
        url: '/api/config',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify(exampleConfig()),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(fx.updateConfig).toHaveBeenCalledTimes(1);
    } finally {
      await server.stop();
    }
  });

  // Headline of Task 10.4 — schema conflict on PUT /api/config.
  it('returns 400 invalid_schema with location issue when location is missing', async () => {
    const { server, fx } = makeServer();
    try {
      const broken = exampleConfig() as unknown as Record<string, unknown>;
      delete broken['location'];
      const res = await server.fastify.inject({
        method: 'PUT',
        url: '/api/config',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify(broken),
      });

      expect(res.statusCode).toBe(400);
      expect(res.headers['content-type']).toMatch(/application\/json/);

      // Body must be JSON-parseable.
      const body = res.json() as {
        error: {
          code: string;
          message: string;
          issues: Array<{ path: (string | number)[]; message: string }>;
        };
      };

      expect(body.error.code).toBe('invalid_schema');
      expect(typeof body.error.message).toBe('string');
      expect(body.error.message.length).toBeGreaterThan(0);
      expect(body.error.issues).toBeDefined();
      expect(body.error.issues.length).toBeGreaterThan(0);
      expect(body.error.issues[0]?.path).toContain('location');

      expect(fx.updateConfig).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });

  it('returns 400 with the same envelope shape on non-JSON body', async () => {
    const { server, fx } = makeServer();
    try {
      const res = await server.fastify.inject({
        method: 'PUT',
        url: '/api/config',
        headers: { 'content-type': 'application/json' },
        payload: 'not even json',
      });

      expect(res.statusCode).toBe(400);
      // The body must still be JSON parseable.
      const body = res.json() as {
        error: { code: string; message: string };
      };
      expect(typeof body.error.code).toBe('string');
      expect(typeof body.error.message).toBe('string');
      expect(fx.updateConfig).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// /api/config/probe.
// ---------------------------------------------------------------------------

describe('POST /api/config/probe', () => {
  it('returns the probe result for the current config', async () => {
    const { server, fx } = makeServer();
    try {
      const res = await server.fastify.inject({
        method: 'POST',
        url: '/api/config/probe',
        headers: { 'content-type': 'application/json' },
        payload: '',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as ReturnType<typeof probeFixture>;
      expect(body.mode).toBe('NORMAL');
      expect(body.windowDecisions).toHaveLength(1);
      expect(fx.probe).toHaveBeenCalledTimes(1);
    } finally {
      await server.stop();
    }
  });

  it('accepts a valid override and forwards it to probe', async () => {
    const { server, fx } = makeServer();
    try {
      const override = exampleConfig();
      const res = await server.fastify.inject({
        method: 'POST',
        url: '/api/config/probe',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify(override),
      });
      expect(res.statusCode).toBe(200);
      expect(fx.probe).toHaveBeenCalledWith(
        expect.objectContaining({ schemaVersion: 1 }),
      );
    } finally {
      await server.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// /api/sources/discover.
// ---------------------------------------------------------------------------

describe('POST /api/sources/discover', () => {
  it('returns 503 when discoverSources is undefined', async () => {
    const { server } = makeServer({ withDiscover: false });
    try {
      const res = await server.fastify.inject({
        method: 'POST',
        url: '/api/sources/discover',
      });
      expect(res.statusCode).toBe(503);
      const body = res.json() as { error: { code: string } };
      expect(body.error.code).toBe('discover_unavailable');
    } finally {
      await server.stop();
    }
  });

  it('returns the discovery payload when wired', async () => {
    const { server, fx } = makeServer({ withDiscover: true });
    try {
      const res = await server.fastify.inject({
        method: 'POST',
        url: '/api/sources/discover',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        devices: HmipDeviceMeta[];
        climateSensors: HmipDeviceMeta[];
        openMeteo: HmipDeviceMeta[];
      };
      expect(body.openMeteo).toHaveLength(1);
      expect(body.openMeteo[0]?.deviceId).toBe('meteo-1');
      expect(fx.discoverSources).toHaveBeenCalledTimes(1);
    } finally {
      await server.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// /api/control/* — shutter, maintenance, reset.
// ---------------------------------------------------------------------------

describe('POST /api/control/shutter/:windowId', () => {
  it('forwards a valid level01 to setShutterManually', async () => {
    const { server, fx } = makeServer();
    try {
      const res = await server.fastify.inject({
        method: 'POST',
        url: '/api/control/shutter/fenster-1',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ level01: 0.5 }),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(fx.setShutterManually).toHaveBeenCalledWith('fenster-1', 0.5);
    } finally {
      await server.stop();
    }
  });

  it('returns 400 invalid_schema when level01 is out of range', async () => {
    const { server, fx } = makeServer();
    try {
      const res = await server.fastify.inject({
        method: 'POST',
        url: '/api/control/shutter/fenster-1',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ level01: 1.5 }),
      });
      expect(res.statusCode).toBe(400);
      const body = res.json() as { error: { code: string } };
      expect(body.error.code).toBe('invalid_schema');
      expect(fx.setShutterManually).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });
});

describe('POST /api/control/automation', () => {
  it('forwards the enabled flag to setAutomationEnabled', async () => {
    const { server, fx } = makeServer();
    try {
      const res = await server.fastify.inject({
        method: 'POST',
        url: '/api/control/automation',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ enabled: true }),
      });
      expect(res.statusCode).toBe(200);
      expect(fx.setAutomationEnabled).toHaveBeenCalledWith(true);
      expect(JSON.parse(res.body)).toEqual({ ok: true, enabled: true });
    } finally {
      await server.stop();
    }
  });

  it('rejects a non-boolean body with invalid_schema', async () => {
    const { server } = makeServer();
    try {
      const res = await server.fastify.inject({
        method: 'POST',
        url: '/api/control/automation',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ enabled: 'yes' }),
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error.code).toBe('invalid_schema');
    } finally {
      await server.stop();
    }
  });
});

describe('POST /api/control/maintenance', () => {
  it('forwards the on flag to setMaintenanceMode', async () => {
    const { server, fx } = makeServer();
    try {
      const res = await server.fastify.inject({
        method: 'POST',
        url: '/api/control/maintenance',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ on: true }),
      });
      expect(res.statusCode).toBe(200);
      expect(fx.setMaintenanceMode).toHaveBeenCalledWith(true);
    } finally {
      await server.stop();
    }
  });
});

describe('POST /api/control/reset', () => {
  it('calls resetConfig', async () => {
    const { server, fx } = makeServer();
    try {
      const res = await server.fastify.inject({
        method: 'POST',
        url: '/api/control/reset',
      });
      expect(res.statusCode).toBe(200);
      expect(fx.resetConfig).toHaveBeenCalledTimes(1);
    } finally {
      await server.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// /api/decisions and /api/history.
// ---------------------------------------------------------------------------

describe('GET /api/decisions', () => {
  it('returns the requested number of records', async () => {
    const { server, fx } = makeServer();
    try {
      const res = await server.fastify.inject({
        method: 'GET',
        url: '/api/decisions?n=5',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { records: HistoryRecord<DecisionRecord>[] };
      expect(body.records).toHaveLength(5);
      expect(fx.readDecisions).toHaveBeenCalledWith(5);
    } finally {
      await server.stop();
    }
  });

  it('defaults n to 200 when omitted', async () => {
    const { server, fx } = makeServer();
    try {
      const res = await server.fastify.inject({
        method: 'GET',
        url: '/api/decisions',
      });
      expect(res.statusCode).toBe(200);
      expect(fx.readDecisions).toHaveBeenCalledWith(200);
    } finally {
      await server.stop();
    }
  });
});

describe('GET /api/history', () => {
  it('returns history for the requested seconds', async () => {
    const { server, fx } = makeServer();
    try {
      const res = await server.fastify.inject({
        method: 'GET',
        url: '/api/history?seconds=3600',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { records: HistoryRecord<DecisionRecord>[] };
      expect(body.records).toHaveLength(2);
      expect(fx.readHistory).toHaveBeenCalledWith(3600);
    } finally {
      await server.stop();
    }
  });

  it('returns 400 invalid_query when seconds is missing', async () => {
    const { server } = makeServer();
    try {
      const res = await server.fastify.inject({
        method: 'GET',
        url: '/api/history',
      });
      expect(res.statusCode).toBe(400);
      const body = res.json() as { error: { code: string } };
      expect(body.error.code).toBe('invalid_query');
    } finally {
      await server.stop();
    }
  });
});

describe('GET /api/trends', () => {
  it('returns trend samples for the requested seconds', async () => {
    const { server, fx } = makeServer();
    try {
      const res = await server.fastify.inject({
        method: 'GET',
        url: '/api/trends?seconds=86400',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        samples: Array<{ ts: string; key: string; value: number }>;
      };
      expect(body.samples).toHaveLength(3);
      expect(body.samples[0]?.key).toBe('outdoor');
      expect(fx.readTrends).toHaveBeenCalledWith(86400);
    } finally {
      await server.stop();
    }
  });

  it('returns 400 invalid_query when seconds is out of range', async () => {
    const { server } = makeServer();
    try {
      const res = await server.fastify.inject({
        method: 'GET',
        url: '/api/trends?seconds=0',
      });
      expect(res.statusCode).toBe(400);
      const body = res.json() as { error: { code: string } };
      expect(body.error.code).toBe('invalid_query');
    } finally {
      await server.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// /api/stream — SSE.
// ---------------------------------------------------------------------------

describe('GET /api/stream', () => {
  it('opens an SSE connection with text/event-stream content type', async () => {
    const { server, fx } = makeServer();
    try {
      const responsePromise = server.fastify.inject({
        method: 'GET',
        url: '/api/stream',
        headers: { accept: 'text/event-stream' },
      });

      // Wait until the subscribe handler has been registered.
      for (let i = 0; i < 50 && fx.subscribe.mock.calls.length === 0; i += 1) {
        await new Promise((r) => setTimeout(r, 5));
      }
      // Tear down the stream so inject() can resolve.
      server.closeAllStreams();
      const res = await responsePromise;

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/event-stream/);
      expect(fx.subscribe).toHaveBeenCalledTimes(1);
    } finally {
      await server.stop();
    }
  });

  it('forwards a subscribed event as data: <json>\\n\\n on the stream', async () => {
    const { server, fx } = makeServer();
    try {
      const event: DashboardStreamEvent = {
        type: 'cycle.completed',
        payload: { cycleId: 'c-1' },
      };

      const responsePromise = server.fastify.inject({
        method: 'GET',
        url: '/api/stream',
      });

      // Wait until the subscribe handler has been registered.
      for (let i = 0; i < 50 && fx.subscribe.mock.calls.length === 0; i += 1) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(fx.subscribe).toHaveBeenCalled();
      // Emit our event into the stream, then close so inject resolves.
      fx.emitter.emit(event);
      // Yield the event loop once so the readable enqueues the chunk.
      await new Promise((r) => setTimeout(r, 5));
      server.closeAllStreams();

      const res = await responsePromise;
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/event-stream/);
      expect(res.body).toContain('data:');
      expect(res.body).toContain('"type":"cycle.completed"');
    } finally {
      await server.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// /api/wizard/step/:n.
// ---------------------------------------------------------------------------

describe('POST /api/wizard/step/:n', () => {
  it('accepts a valid step 1 (Beispielstadt location) and returns 200', async () => {
    const { server, fx } = makeServer();
    try {
      const res = await server.fastify.inject({
        method: 'POST',
        url: '/api/wizard/step/1',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          latitude: 52.52,
          longitude: 13.41,
          timezone: 'Europe/Berlin',
        }),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { ok: boolean; status: string };
      expect(body.ok).toBe(true);
      expect(body.status).toBe('READY');
      expect(fx.updateConfig).toHaveBeenCalledTimes(1);
    } finally {
      await server.stop();
    }
  });

  it('rejects an out-of-range step number with 400 invalid_param', async () => {
    const { server, fx } = makeServer();
    try {
      const res = await server.fastify.inject({
        method: 'POST',
        url: '/api/wizard/step/99',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({}),
      });
      expect(res.statusCode).toBe(400);
      const body = res.json() as { error: { code: string } };
      expect(body.error.code).toBe('invalid_param');
      expect(fx.updateConfig).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });

  it('rejects an invalid step body with 400 invalid_schema', async () => {
    const { server, fx } = makeServer();
    try {
      const res = await server.fastify.inject({
        method: 'POST',
        url: '/api/wizard/step/1',
        headers: { 'content-type': 'application/json' },
        // Missing timezone — Step1Schema requires it.
        payload: JSON.stringify({ latitude: 52.52, longitude: 13.41 }),
      });
      expect(res.statusCode).toBe(400);
      const body = res.json() as {
        error: {
          code: string;
          issues: Array<{ path: (string | number)[] }>;
        };
      };
      expect(body.error.code).toBe('invalid_schema');
      expect(body.error.issues.length).toBeGreaterThan(0);
      expect(fx.updateConfig).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// /api/connect/log — Task 13.2.
// ---------------------------------------------------------------------------

describe('GET /api/connect/log', () => {
  it('returns 503 connect_log_unavailable when the dep is not wired', async () => {
    const { server } = makeServer({ withConnectLog: false });
    try {
      const res = await server.fastify.inject({
        method: 'GET',
        url: '/api/connect/log',
      });
      expect(res.statusCode).toBe(503);
      const body = res.json() as { error: { code: string } };
      expect(body.error.code).toBe('connect_log_unavailable');
    } finally {
      await server.stop();
    }
  });

  it('returns the buffer entries (oldest first) when wired', async () => {
    const { server, fx } = makeServer({ withConnectLog: true });
    try {
      const res = await server.fastify.inject({
        method: 'GET',
        url: '/api/connect/log',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        entries: Array<{ ts: string; level: string; msg: string }>;
      };
      expect(body.entries).toHaveLength(3);
      expect(body.entries[0]?.msg).toBe('connect open');
      expect(body.entries[2]?.msg).toBe('send failed');
      expect(fx.getConnectLog).toHaveBeenCalledTimes(1);
    } finally {
      await server.stop();
    }
  });

  it('respects the n query parameter and returns the latest n entries', async () => {
    const { server } = makeServer({ withConnectLog: true });
    try {
      const res = await server.fastify.inject({
        method: 'GET',
        url: '/api/connect/log?n=2',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        entries: Array<{ msg: string }>;
      };
      // Buffer has 3 entries; n=2 returns the last two (still oldest
      // first within the slice).
      expect(body.entries).toHaveLength(2);
      expect(body.entries[0]?.msg).toBe('reconnect');
      expect(body.entries[1]?.msg).toBe('send failed');
    } finally {
      await server.stop();
    }
  });

  it('returns 400 invalid_query when n exceeds the cap (5000)', async () => {
    const { server } = makeServer({ withConnectLog: true });
    try {
      const res = await server.fastify.inject({
        method: 'GET',
        url: '/api/connect/log?n=99999',
      });
      expect(res.statusCode).toBe(400);
      const body = res.json() as { error: { code: string } };
      expect(body.error.code).toBe('invalid_query');
    } finally {
      await server.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// /api/probe/run — Task 13.3.
// ---------------------------------------------------------------------------

describe('POST /api/probe/run', () => {
  it('returns 503 probe_unavailable when the dep is not wired', async () => {
    const { server } = makeServer({ withRunProbe: false });
    try {
      const res = await server.fastify.inject({
        method: 'POST',
        url: '/api/probe/run',
      });
      expect(res.statusCode).toBe(503);
      const body = res.json() as { error: { code: string } };
      expect(body.error.code).toBe('probe_unavailable');
    } finally {
      await server.stop();
    }
  });

  it('forwards the call to runProbe and returns the result', async () => {
    const { server, fx } = makeServer({ withRunProbe: true });
    try {
      const res = await server.fastify.inject({
        method: 'POST',
        url: '/api/probe/run',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        mode: string;
        windowDecisions: WindowDecisionEntry[];
        ts: string;
        cycleId: string;
      };
      expect(body.mode).toBe('NORMAL');
      expect(body.cycleId).toBe('probe-001');
      expect(body.ts).toBe('2026-06-21T12:05:00.000Z');
      expect(body.windowDecisions).toHaveLength(1);
      expect(fx.runProbe).toHaveBeenCalledTimes(1);
    } finally {
      await server.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// /api/learn/* — Task 14.2.
// ---------------------------------------------------------------------------

describe('GET /api/learn/snapshot', () => {
  it('returns 503 learning_unavailable when getLearningSnapshot is undefined', async () => {
    const { server } = makeServer({ withLearningSnapshot: false });
    try {
      const res = await server.fastify.inject({
        method: 'GET',
        url: '/api/learn/snapshot',
      });
      expect(res.statusCode).toBe(503);
      const body = res.json() as { error: { code: string } };
      expect(body.error.code).toBe('learning_unavailable');
    } finally {
      await server.stop();
    }
  });

  it('returns the snapshot JSON when wired', async () => {
    const { server, fx } = makeServer({ withLearningSnapshot: true });
    try {
      const res = await server.fastify.inject({
        method: 'GET',
        url: '/api/learn/snapshot',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        recommendations: Array<{ severity: string; id: string }>;
        metrics: Array<{ roomId: string }>;
      };
      expect(body.recommendations).toHaveLength(1);
      expect(body.recommendations[0]?.severity).toBe('warn');
      expect(body.recommendations[0]?.id).toBe('lowGain-schlafzimmer');
      expect(body.metrics[0]?.roomId).toBe('schlafzimmer');
      expect(fx.getLearningSnapshot).toHaveBeenCalledTimes(1);
    } finally {
      await server.stop();
    }
  });
});

describe('POST /api/learn/recommendations/:id/apply', () => {
  it('returns 503 learning_unavailable when applyRecommendation is undefined', async () => {
    const { server } = makeServer({ withApplyRecommendation: false });
    try {
      const res = await server.fastify.inject({
        method: 'POST',
        url: '/api/learn/recommendations/lowGain-schlafzimmer/apply',
      });
      expect(res.statusCode).toBe(503);
      const body = res.json() as { error: { code: string } };
      expect(body.error.code).toBe('learning_unavailable');
    } finally {
      await server.stop();
    }
  });

  it('forwards the id to applyRecommendation and returns the result', async () => {
    const { server, fx } = makeServer({ withApplyRecommendation: true });
    try {
      const res = await server.fastify.inject({
        method: 'POST',
        url: '/api/learn/recommendations/lowGain-schlafzimmer/apply',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        ok: boolean;
        appliedPatch: { from: number; to: number };
      };
      expect(body.ok).toBe(true);
      expect(body.appliedPatch.from).toBe(60);
      expect(body.appliedPatch.to).toBe(90);
      expect(fx.applyRecommendation).toHaveBeenCalledWith(
        'lowGain-schlafzimmer',
      );
    } finally {
      await server.stop();
    }
  });

  it('returns 404 recommendation_not_found when applyRecommendation returns ok:false', async () => {
    const { server } = makeServer({
      withApplyRecommendation: true,
      applyReturnsNotFound: true,
    });
    try {
      const res = await server.fastify.inject({
        method: 'POST',
        url: '/api/learn/recommendations/missing/apply',
      });
      expect(res.statusCode).toBe(404);
      const body = res.json() as { error: { code: string } };
      expect(body.error.code).toBe('recommendation_not_found');
    } finally {
      await server.stop();
    }
  });
});

describe('POST /api/learn/recommendations/:id/dismiss', () => {
  it('returns 503 learning_unavailable when dismissRecommendation is undefined', async () => {
    const { server } = makeServer({ withDismissRecommendation: false });
    try {
      const res = await server.fastify.inject({
        method: 'POST',
        url: '/api/learn/recommendations/lowGain-schlafzimmer/dismiss',
      });
      expect(res.statusCode).toBe(503);
    } finally {
      await server.stop();
    }
  });

  it('forwards the id to dismissRecommendation when wired', async () => {
    const { server, fx } = makeServer({ withDismissRecommendation: true });
    try {
      const res = await server.fastify.inject({
        method: 'POST',
        url: '/api/learn/recommendations/lowGain-schlafzimmer/dismiss',
      });
      expect(res.statusCode).toBe(200);
      expect(fx.dismissRecommendation).toHaveBeenCalledWith(
        'lowGain-schlafzimmer',
      );
    } finally {
      await server.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// GET / — static index fallback.
// ---------------------------------------------------------------------------

describe('GET /', () => {
  it('returns 200 with HTML content', async () => {
    const { server } = makeServer();
    try {
      const res = await server.fastify.inject({ method: 'GET', url: '/' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.body).toContain('Heat Shield');
    } finally {
      await server.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// /api/messages (smart-shading Task 10.1).
// ---------------------------------------------------------------------------

describe('GET /api/messages', () => {
  it('returns 503 when the messages dep is not wired', async () => {
    const { server } = makeServer();
    const res = await server.fastify.inject({ method: 'GET', url: '/api/messages' });
    expect(res.statusCode).toBe(503);
  });

  it('returns the message list and unread count when wired', async () => {
    const { server } = makeServer({ withMessages: true });
    const res = await server.fastify.inject({ method: 'GET', url: '/api/messages' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { messages: unknown[]; unread: number };
    expect(body.messages).toHaveLength(2);
    expect(body.unread).toBe(1);
  });
});

describe('POST /api/messages/read', () => {
  it('returns 503 when the messages dep is not wired', async () => {
    const { server } = makeServer();
    const res = await server.fastify.inject({
      method: 'POST',
      url: '/api/messages/read',
      payload: {},
    });
    expect(res.statusCode).toBe(503);
  });

  it('marks all read when no ids are given', async () => {
    const { server, fx } = makeServer({ withMessages: true });
    const res = await server.fastify.inject({
      method: 'POST',
      url: '/api/messages/read',
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; unread: number };
    expect(body.ok).toBe(true);
    expect(body.unread).toBe(0);
    expect(fx.markMessagesRead).toHaveBeenCalledWith(undefined);
  });

  it('forwards specific ids', async () => {
    const { server, fx } = makeServer({ withMessages: true });
    const res = await server.fastify.inject({
      method: 'POST',
      url: '/api/messages/read',
      payload: { ids: ['msg-1'] },
    });
    expect(res.statusCode).toBe(200);
    expect(fx.markMessagesRead).toHaveBeenCalledWith(['msg-1']);
  });

  it('rejects a non-string ids array with invalid_schema', async () => {
    const { server } = makeServer({ withMessages: true });
    const res = await server.fastify.inject({
      method: 'POST',
      url: '/api/messages/read',
      payload: { ids: [1, 2] },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /api/config — Telegram token masking (smart-shading Task 8.3).
// ---------------------------------------------------------------------------

describe('GET /api/config — token masking', () => {
  it('masks the Telegram bot token in the response', async () => {
    const { server, fx } = makeServer();
    const cfg = exampleConfig();
    cfg.notifications = {
      telegram: {
        enabled: true,
        botToken: '123456:SUPERSECRETTOKEN',
        chatId: '9',
        commandsEnabled: false,
        allowControl: true,
        allowedChatIds: [],
      },
      morningBriefLocalTime: '07:30',
      dailySummaryLocalTime: '21:00',
      dailySummaryEnabled: false,
      language: 'de',
      events: { ventilate: true, open: true, close: true, weather: true },
      forecastUpdates: { enabled: false, everyHours: 3 },
    };
    fx.config.mockReturnValue(cfg);

    const res = await server.fastify.inject({ method: 'GET', url: '/api/config' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      notifications?: { telegram: { botToken: string } };
    };
    expect(body.notifications?.telegram.botToken).not.toContain('SUPERSECRET');
    expect(body.notifications?.telegram.botToken).toContain('123456:');
  });
});

// ---------------------------------------------------------------------------
// POST /api/notifications/test (Telegram test send).
// ---------------------------------------------------------------------------

describe('POST /api/notifications/test', () => {
  it('returns 503 when the test hook is not wired', async () => {
    const { server } = makeServer();
    const res = await server.fastify.inject({
      method: 'POST',
      url: '/api/notifications/test',
    });
    expect(res.statusCode).toBe(503);
  });

  it('forwards to sendTestNotification and returns the result', async () => {
    const { server, fx } = makeServer({ withMessages: true });
    const res = await server.fastify.inject({
      method: 'POST',
      url: '/api/notifications/test',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(fx.sendTestNotification).toHaveBeenCalledTimes(1);
  });
});
