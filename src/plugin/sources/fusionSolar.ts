/**
 * Heat Shield — FusionSolar source adapter (Task 5.1).
 *
 * Polls the local FusionSolar plugin's `/api/snapshot` endpoint at a
 * configurable interval (default 30 s) and exposes the most recent
 * successfully-decoded values to the engine. The adapter is fully
 * dependency-injected:
 *
 *   - `fetchFn`  — defaults to `globalThis.fetch` (Node ≥ 20 has it
 *                  built in). Tests pass a mock that mimics the
 *                  `Response` surface we actually consume (`ok`,
 *                  `status`, `json()`).
 *   - `now`      — clock injection used for `observedAt` stamps and
 *                  for the `lastSuccess` / `lastError` ledger.
 *   - `setTimeout` recursion is preferred over `setInterval` so two
 *     polls cannot overlap if the HCU's network stack briefly stalls
 *     beyond `pollIntervalMs`.
 *
 * 3-strikes failure logic (design.md §Error Handling, Requirement 9.2):
 *
 *   - timeout (AbortController fires), non-2xx HTTP status, JSON parse
 *     error, or schema-validation rejection all count as a failure.
 *   - `consecutiveFailures` is incremented on every failure and reset
 *     to 0 on every successful poll.
 *   - When `consecutiveFailures` reaches `failureThreshold` (default 3)
 *     and the previous health was healthy, `sourceOk` flips to `false`
 *     and a `'sourceUnavailable'` event is emitted exactly once.
 *   - The next successful poll flips `sourceOk` back to `true` and
 *     emits a single `'sourceRecovered'` event.
 *
 * SSE / `/api/stream` is **deliberately deferred to a follow-up
 * subtask**. The polling cadence (30 s) is tight enough to satisfy the
 * Requirement 12.2 latency budget on its own, and SSE handling adds
 * non-trivial test machinery (mock streams, backpressure semantics) for
 * a marginal win. The shape of `FusionSolarAdapterOptions` is left
 * deliberately closed (no `enableStream` knob) so the SSE surface can
 * be designed without an obsolete flag in the public API. When the
 * stream is added the adapter will gain a single
 * `enableStream?: boolean` option and the SSE failure mode will degrade
 * silently to the polling path documented here.
 *
 * Pure module-level rules:
 *   - No fs, no Connect API artifacts, no logging.
 *   - Strict TS (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`).
 *   - No `any`, no `// @ts-ignore`. `import type` where appropriate.
 */

import { EventEmitter } from 'node:events';

import { z } from 'zod';

import type { SourceRef } from '../../shared/types.js';

// ---------------------------------------------------------------------------
// Internal Zod schema for `/api/snapshot`.
// ---------------------------------------------------------------------------

/**
 * Subset of `/api/snapshot` we actually consume. Every value field is
 * `.optional()` because the upstream plugin ships them only when the
 * inverter has a fresh sample, and `.passthrough()` is used at every
 * object level so future field additions in the upstream plugin do not
 * break us.
 */
const SnapshotResponseSchema = z.object({
  snapshot: z
    .object({
      connected: z.boolean(),
      lastUpdate: z.number().optional(),
      values: z
        .object({
          inputPower: z.number().optional(),
          activePower: z.number().optional(),
          meterActivePower: z.number().optional(),
          batterySoc: z.number().optional(),
          batteryChargeDischargePower: z.number().optional(),
          internalTemp: z.number().optional(),
        })
        .passthrough(),
    })
    .passthrough(),
});

// ---------------------------------------------------------------------------
// Public types.
// ---------------------------------------------------------------------------

/**
 * Set of FusionSolar fields the engine may bind to. Re-derived from
 * `SourceRef`'s `'fusion'` variant so the schema stays the single
 * source of truth — adding a new field in `src/shared/schema.ts`
 * automatically widens this union.
 */
export type FusionField = Extract<SourceRef, { kind: 'fusion' }>['field'];

const FUSION_FIELDS: readonly FusionField[] = [
  'inputPower',
  'activePower',
  'batterySoc',
  'batteryChargeDischargePower',
  'meterActivePower',
  'internalTemp',
] as const;

/**
 * One field-level reading. `value` is the raw number reported by the
 * upstream plugin in its native unit (W for power fields, % for SoC,
 * °C for `internalTemp`). `observedAt` is stamped when the adapter
 * decoded the snapshot, NOT the upstream `lastUpdate` — the engine
 * uses `observedAt` for the stale-after-Sec budget and that budget
 * is measured from our local clock.
 */
export interface FusionSnapshotValue {
  readonly value: number;
  readonly observedAt: Date;
}

/**
 * Health snapshot. `sourceOk` reflects the 3-strikes ledger; the
 * orchestrator routes to a fallback (HCU inverter plugin or
 * `weather.shortwave_radiation_wm2`) whenever this is `false`
 * (Requirement 9.2).
 */
export interface FusionSolarStatus {
  readonly sourceOk: boolean;
  readonly lastSuccess: Date | null;
  readonly lastError: { message: string; ts: Date } | null;
  readonly consecutiveFailures: number;
}

/**
 * Adapter options. Defaults:
 *   - `pollIntervalMs`    30_000  (regelwerk § datasource cadence)
 *   - `httpTimeoutMs`     5_000   (one-fifth of the poll period)
 *   - `failureThreshold`  3       (design.md §Error Handling)
 *   - `fetchFn`           globalThis.fetch (Node ≥ 20)
 *   - `now`               () => new Date()
 */
export interface FusionSolarAdapterOptions {
  readonly baseUrl: string;
  readonly pollIntervalMs?: number;
  readonly httpTimeoutMs?: number;
  readonly failureThreshold?: number;
  readonly fetchFn?: typeof globalThis.fetch;
  readonly now?: () => Date;
}

/**
 * Typed event map. Keeps TS strict-mode happy without leaking
 * `any[]`-tail listener signatures into consumer code.
 */
type FusionSolarEvents = {
  value: [field: FusionField, snapshot: FusionSnapshotValue];
  sourceUnavailable: [error: { message: string; ts: Date }];
  sourceRecovered: [info: { ts: Date }];
};

// ---------------------------------------------------------------------------
// Adapter.
// ---------------------------------------------------------------------------

/**
 * FusionSolar polling adapter. Constructor stores configuration only;
 * call `start()` to begin polling, `pollOnce()` for a deterministic
 * one-shot (used by tests and by the dashboard's "probe now" button),
 * and `stop()` to shut down the recurrence and await any in-flight
 * request.
 */
export class FusionSolarAdapter extends EventEmitter<FusionSolarEvents> {
  private readonly baseUrl: string;
  private readonly pollIntervalMs: number;
  private readonly httpTimeoutMs: number;
  private readonly failureThreshold: number;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly now: () => Date;

  private readonly values: Map<FusionField, FusionSnapshotValue> = new Map();

  private sourceOk: boolean = true;
  private lastSuccess: Date | null = null;
  private lastError: { message: string; ts: Date } | null = null;
  private consecutiveFailures: number = 0;

  private running: boolean = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;

  public constructor(options: FusionSolarAdapterOptions) {
    super();
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.pollIntervalMs = options.pollIntervalMs ?? 30_000;
    this.httpTimeoutMs = options.httpTimeoutMs ?? 5_000;
    this.failureThreshold = options.failureThreshold ?? 3;
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? ((): Date => new Date());
  }

  /**
   * Begin polling. The first poll fires immediately (asynchronously);
   * subsequent polls are scheduled via `setTimeout` from the
   * completion handler so two requests can never overlap.
   */
  public start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    void this.tick();
  }

  /**
   * Stop the polling loop and await any in-flight request. Idempotent:
   * calling `stop()` multiple times is safe.
   */
  public async stop(): Promise<void> {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.inFlight !== null) {
      try {
        await this.inFlight;
      } catch {
        // pollOnce never throws; this catch is defensive.
      }
    }
  }

  /**
   * Most recent successfully-polled value for `field`, or `null` if
   * none has been seen yet (or the field was missing from every
   * successful snapshot so far).
   */
  public getValue(field: FusionField): FusionSnapshotValue | null {
    return this.values.get(field) ?? null;
  }

  /**
   * Current health snapshot. Frozen ledger fields so consumers cannot
   * accidentally mutate the adapter's internal state.
   */
  public getStatus(): FusionSolarStatus {
    return {
      sourceOk: this.sourceOk,
      lastSuccess: this.lastSuccess,
      lastError: this.lastError,
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  /**
   * Execute exactly one poll cycle. Public so tests and the
   * dashboard's diagnostics endpoint can trigger a poll without
   * starting the recurrence. Never throws — failures are folded into
   * the 3-strikes ledger.
   */
  public async pollOnce(): Promise<void> {
    if (this.inFlight !== null) {
      // Coalesce: if a poll is already running, return that promise
      // rather than launch a second concurrent request.
      return this.inFlight;
    }
    const work = this.doPoll();
    this.inFlight = work;
    try {
      await work;
    } finally {
      this.inFlight = null;
    }
  }

  // -------------------------------------------------------------------------
  // Internals.
  // -------------------------------------------------------------------------

  private async tick(): Promise<void> {
    if (!this.running) {
      return;
    }
    try {
      await this.pollOnce();
    } catch {
      // pollOnce is fully internalised — defensive catch only.
    }
    if (!this.running) {
      return;
    }
    this.timer = setTimeout(() => {
      void this.tick();
    }, this.pollIntervalMs);
  }

  private async doPoll(): Promise<void> {
    const url = `${this.baseUrl}/api/snapshot`;
    const ac = new AbortController();
    const timeoutId = setTimeout(() => {
      ac.abort();
    }, this.httpTimeoutMs);

    try {
      let response: Response;
      try {
        response = await this.fetchFn(url, { signal: ac.signal });
      } catch (err) {
        this.recordFailure(this.describeError(err, 'fetch failed'));
        return;
      }

      if (!response.ok) {
        this.recordFailure(`HTTP ${response.status}`);
        return;
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch (err) {
        this.recordFailure(this.describeError(err, 'JSON parse failed'));
        return;
      }

      const parsed = SnapshotResponseSchema.safeParse(body);
      if (!parsed.success) {
        this.recordFailure(`schema mismatch: ${parsed.error.issues.length} issue(s)`);
        return;
      }

      this.recordSuccess(parsed.data.snapshot.values);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private recordSuccess(
    values: z.infer<typeof SnapshotResponseSchema>['snapshot']['values'],
  ): void {
    const observedAt = this.now();
    for (const field of FUSION_FIELDS) {
      const raw = values[field];
      if (typeof raw === 'number' && Number.isFinite(raw)) {
        const snapshot: FusionSnapshotValue = { value: raw, observedAt };
        this.values.set(field, snapshot);
        this.emit('value', field, snapshot);
      }
    }
    this.consecutiveFailures = 0;
    this.lastSuccess = observedAt;
    this.lastError = null;
    if (!this.sourceOk) {
      this.sourceOk = true;
      this.emit('sourceRecovered', { ts: observedAt });
    }
  }

  private recordFailure(message: string): void {
    const ts = this.now();
    this.consecutiveFailures += 1;
    this.lastError = { message, ts };
    if (this.sourceOk && this.consecutiveFailures >= this.failureThreshold) {
      this.sourceOk = false;
      this.emit('sourceUnavailable', { message, ts });
    }
  }

  private describeError(err: unknown, fallback: string): string {
    if (err instanceof Error) {
      // AbortError surfaces as a DOMException with `.name === 'AbortError'`
      // in Node 20; fall back to the message otherwise.
      if (err.name === 'AbortError') {
        return `timeout after ${this.httpTimeoutMs}ms`;
      }
      return err.message.length > 0 ? err.message : fallback;
    }
    return fallback;
  }
}
