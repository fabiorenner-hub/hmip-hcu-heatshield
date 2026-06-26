/**
 * Heat Shield — forecast/plan route tests
 * (predictive-control-dashboard Task 12.1, Requirements 11.1/13.2).
 *
 * Drives `GET /api/forecast` and `GET /api/plan` through Fastify's
 * `inject()`: 200 when the deps are wired, 503 when not, 400 invalid_query
 * for bad params. Existing trends/SSE behaviour is unaffected (separate
 * route registration).
 */

import { describe, expect, it, vi } from 'vitest';

import {
  DashboardServer,
  type DashboardServerDeps,
  type DashboardSnapshot,
  type ForecastResponse,
  type PlanResponse,
} from '../../src/plugin/dashboard/server.js';
import type { Config } from '../../src/shared/types.js';

function snapshotFixture(): DashboardSnapshot {
  return {
    ts: '2026-06-21T12:00:00.000Z',
    mode: 'NORMAL',
    rooms: [],
    windows: [],
    sources: {
      fusionSolar: { sourceOk: true, lastSuccess: null, consecutiveFailures: 0 },
      hcu: { connected: true },
    },
    userIntent: { paused: false, pauseUntil: null, vacation: false },
    storm: { holdUntil: null },
    pluginReadiness: 'READY',
  };
}

function baseDeps(): DashboardServerDeps {
  return {
    config: vi.fn(() => ({}) as unknown as Config),
    updateConfig: vi.fn(async () => {}),
    readState: vi.fn(async () => null),
    readDecisions: vi.fn(async () => []),
    readHistory: vi.fn(async () => []),
    readTrends: vi.fn(async () => []),
    getSnapshot: vi.fn(async () => snapshotFixture()),
    probe: vi.fn(async () => ({ mode: 'NORMAL' as const, windowDecisions: [] })),
    setShutterManually: vi.fn(async () => {}),
    setMaintenanceMode: vi.fn(async () => {}),
    resetConfig: vi.fn(async () => {}),
    subscribe: vi.fn(() => () => {}),
  };
}

function forecastFixture(): ForecastResponse[] {
  return [
    {
      roomId: 'schlafzimmer',
      hours: 12,
      points: [
        { ts: '2026-06-21T12:00:00.000Z', indoorTempC: 22.4, heatLoad01: 0.3 },
        { ts: '2026-06-21T12:15:00.000Z', indoorTempC: 22.6, heatLoad01: 0.32 },
      ],
      uncertain: false,
      confidence01: 0.9,
    },
  ];
}

function planFixture(): PlanResponse {
  return {
    ts: '2026-06-21T12:00:00.000Z',
    windows: [{ windowId: 'fenster-1', target01: 0.5, noMoveNeeded: false }],
    plannedActions: [
      {
        windowId: 'fenster-1',
        scheduledTs: '2026-06-21T12:00:00.000Z',
        targetPercent: 50,
        reason: 'Vorausschauende Position',
        state: 'scheduled',
      },
    ],
  };
}

describe('GET /api/forecast', () => {
  it('returns 503 forecast_unavailable when readForecast is not wired', async () => {
    const server = new DashboardServer(baseDeps(), { port: 0 });
    try {
      const res = await server.fastify.inject({ method: 'GET', url: '/api/forecast' });
      expect(res.statusCode).toBe(503);
      expect((res.json() as { error: { code: string } }).error.code).toBe(
        'forecast_unavailable',
      );
    } finally {
      await server.stop();
    }
  });

  it('returns 200 with forecasts when wired', async () => {
    const readForecast = vi.fn(async () => forecastFixture());
    const server = new DashboardServer({ ...baseDeps(), readForecast }, { port: 0 });
    try {
      const res = await server.fastify.inject({
        method: 'GET',
        url: '/api/forecast?roomId=schlafzimmer&hours=12',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { forecasts: ForecastResponse[] };
      expect(body.forecasts).toHaveLength(1);
      expect(body.forecasts[0]?.roomId).toBe('schlafzimmer');
      expect(readForecast).toHaveBeenCalledWith('schlafzimmer', 12);
    } finally {
      await server.stop();
    }
  });

  it('returns 400 invalid_query when hours is out of range', async () => {
    const readForecast = vi.fn(async () => forecastFixture());
    const server = new DashboardServer({ ...baseDeps(), readForecast }, { port: 0 });
    try {
      const res = await server.fastify.inject({
        method: 'GET',
        url: '/api/forecast?hours=999',
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: { code: string } }).error.code).toBe(
        'invalid_query',
      );
      expect(readForecast).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });
});

describe('GET /api/plan', () => {
  it('returns 503 plan_unavailable when readPlan is not wired', async () => {
    const server = new DashboardServer(baseDeps(), { port: 0 });
    try {
      const res = await server.fastify.inject({ method: 'GET', url: '/api/plan' });
      expect(res.statusCode).toBe(503);
      expect((res.json() as { error: { code: string } }).error.code).toBe(
        'plan_unavailable',
      );
    } finally {
      await server.stop();
    }
  });

  it('returns 200 with the plan when wired', async () => {
    const readPlan = vi.fn(async () => planFixture());
    const server = new DashboardServer({ ...baseDeps(), readPlan }, { port: 0 });
    try {
      const res = await server.fastify.inject({ method: 'GET', url: '/api/plan' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as PlanResponse;
      expect(body.windows).toHaveLength(1);
      expect(body.plannedActions[0]?.state).toBe('scheduled');
      expect(readPlan).toHaveBeenCalledTimes(1);
    } finally {
      await server.stop();
    }
  });

  it('returns an empty plan (200) when wired but no plan exists', async () => {
    const readPlan = vi.fn(async () => null);
    const server = new DashboardServer({ ...baseDeps(), readPlan }, { port: 0 });
    try {
      const res = await server.fastify.inject({ method: 'GET', url: '/api/plan' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as PlanResponse;
      expect(body.windows).toEqual([]);
      expect(body.plannedActions).toEqual([]);
    } finally {
      await server.stop();
    }
  });
});
