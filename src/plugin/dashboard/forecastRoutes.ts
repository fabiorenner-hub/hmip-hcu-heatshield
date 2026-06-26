/**
 * Heat Shield — forecast/plan Fastify routes
 * (predictive-control-dashboard Task 12, Requirements 11.1/13.2/13.5/18.3).
 *
 *   - `GET /api/forecast?roomId=&hours=` — per-room forecast trajectories
 *     (indoor temperature + heat load) for the analysis charts.
 *   - `GET /api/plan`                    — the current position plan +
 *     PlannedAction[].
 *
 * Both routes read through the optional {@link DashboardServerDeps}
 * accessors `readForecast` / `readPlan`. When those are not wired (boot
 * has not connected the live `PlannerResult` yet) the routes answer
 * `503` — analogous to the existing `discover_unavailable` pattern — so
 * the SPA can distinguish "not ready" from "empty". Bad query params
 * yield `400 invalid_query` using the shared ApiErrorBody envelope.
 *
 * This module is I/O-thin: it only validates query params and forwards
 * to the deps. No engine coupling, no Connect artefacts.
 */

import type { FastifyInstance } from 'fastify';

import type { DashboardServerDeps } from './server.js';

/** Default and cap for `GET /api/forecast?hours=`. */
const DEFAULT_FORECAST_HOURS = 12;
const MIN_FORECAST_HOURS = 1;
const MAX_FORECAST_HOURS = 48;

interface ErrorBody {
  error: {
    code: string;
    message: string;
  };
}

function errorBody(code: string, message: string): ErrorBody {
  return { error: { code, message } };
}

/**
 * Parse `raw` as an integer in `[min, max]`, returning `null` for any
 * malformed input (so the caller can emit `invalid_query`).
 */
function parseIntInRange(raw: unknown, min: number, max: number): number | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    return null;
  }
  const asString = typeof raw === 'number' ? String(raw) : raw;
  const n = Number.parseInt(asString, 10);
  if (!Number.isInteger(n) || asString !== String(n)) {
    return null;
  }
  if (n < min || n > max) {
    return null;
  }
  return n;
}

/**
 * Register the `/api/forecast` and `/api/plan` routes on `app`.
 * Called from {@link DashboardServer.registerRoutes}.
 */
export function registerForecastRoutes(
  app: FastifyInstance,
  deps: DashboardServerDeps,
): void {
  app.get('/api/forecast', async (req, reply) => {
    const readForecast = deps.readForecast;
    if (readForecast === undefined) {
      return reply
        .code(503)
        .send(
          errorBody(
            'forecast_unavailable',
            'Forecast trajectories are not yet available; planner not wired',
          ),
        );
    }
    const query = (req.query ?? {}) as Record<string, unknown>;
    const rawRoom = query['roomId'];
    if (rawRoom !== undefined && typeof rawRoom !== 'string') {
      return reply
        .code(400)
        .send(errorBody('invalid_query', 'roomId must be a string'));
    }
    const roomId = typeof rawRoom === 'string' && rawRoom.length > 0 ? rawRoom : undefined;
    const rawHours = query['hours'];
    const hours =
      rawHours === undefined
        ? DEFAULT_FORECAST_HOURS
        : parseIntInRange(rawHours, MIN_FORECAST_HOURS, MAX_FORECAST_HOURS);
    if (hours === null) {
      return reply
        .code(400)
        .send(
          errorBody(
            'invalid_query',
            `hours must be an integer in [${MIN_FORECAST_HOURS}, ${MAX_FORECAST_HOURS}]`,
          ),
        );
    }
    try {
      const forecasts = await readForecast(roomId, hours);
      return { forecasts };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(500).send(errorBody('internal_error', message));
    }
  });

  app.get('/api/plan', async (_req, reply) => {
    const readPlan = deps.readPlan;
    if (readPlan === undefined) {
      return reply
        .code(503)
        .send(
          errorBody(
            'plan_unavailable',
            'Position plan is not yet available; planner not wired',
          ),
        );
    }
    try {
      const plan = await readPlan();
      if (plan === null) {
        return {
          ts: new Date(0).toISOString(),
          windows: [],
          plannedActions: [],
        };
      }
      return plan;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(500).send(errorBody('internal_error', message));
    }
  });
}
