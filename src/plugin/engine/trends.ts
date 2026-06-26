/**
 * Heat Shield — rolling multi-hour trend store
 * (smart-shading-notifications Task 1.1 / 1.2).
 *
 * `engine/trends.ts` keeps short, in-memory time series for the signals the
 * shading logic reasons about over time: outdoor temperature (front/back/API),
 * room temperatures and PV power. Each `record()` appends one sample per key;
 * samples older than the configured window (`windowHours`, default 3 h) are
 * dropped on every append so the buffers stay bounded.
 *
 * The store answers two questions the engine cares about:
 *
 *   - `slopePerHour(key)` — the rate of change in units/hour over the window,
 *     computed via ordinary least-squares. This is what feeds the
 *     "predictive" branch of the heat-load model (a steep upward temperature
 *     and PV trend warrants closing earlier). Returns `null` when there are
 *     fewer than two distinct points to fit a line through.
 *   - `summary(key)` — the latest value plus a simple average over the
 *     window, for the dashboard feels-like / trend display.
 *
 * ## Design rules (mirrored from the other engine modules)
 *
 *   - Pure data structure: no fs, no logging, no Connect-API artefacts.
 *     Persistence lives in `persistence/trends.ts` (Task 1.3); this module
 *     never touches the disk so it stays unit-testable in isolation.
 *   - Strict TS, ESM, `.js` import suffixes.
 *   - `null` values are accepted by `record()` and simply skipped — a missing
 *     signal must never poison the buffer or throw. Non-finite values
 *     (`NaN`, `±Infinity`) are treated the same as `null`.
 *   - The clock is always injected via the `now` argument so tests stay
 *     deterministic.
 */

/** One persisted/loaded trend sample. Shared with `persistence/trends.ts`. */
export interface TrendSample {
  ts: string;
  key: string;
  value: number;
}

/** Latest value plus the simple average over the retained window. */
export interface TrendSummary {
  latest: number | null;
  avg: number | null;
}

/** One in-memory point: epoch millis + finite value. */
interface Point {
  tsMs: number;
  value: number;
}

/** Default rolling window width in hours (design default). */
export const DEFAULT_TREND_WINDOW_HOURS = 3;

function isFiniteNumber(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Bounded, per-key rolling buffer with least-squares slope estimation.
 *
 * Construct with the window width in hours. Feed samples via `record()`,
 * one batch per engine cycle. Read trends via `slopePerHour()` / `summary()`.
 * Rehydrate after a restart with `load()` (used by the persistence layer).
 */
export class TrendStore {
  private readonly windowMs: number;

  private readonly buffers = new Map<string, Point[]>();

  constructor(windowHours: number = DEFAULT_TREND_WINDOW_HOURS) {
    const hours = isFiniteNumber(windowHours) && windowHours > 0
      ? windowHours
      : DEFAULT_TREND_WINDOW_HOURS;
    this.windowMs = hours * 3_600_000;
  }

  /**
   * Append one sample per key. `null`/non-finite values are skipped so a
   * temporarily missing signal leaves a gap rather than corrupting the trend.
   * Prunes the affected buffers to the window afterwards.
   */
  record(
    now: Date,
    samples: ReadonlyArray<{ key: string; value: number | null }>,
  ): void {
    const tsMs = now.getTime();
    if (!Number.isFinite(tsMs)) {
      return;
    }
    for (const { key, value } of samples) {
      if (!isFiniteNumber(value) || key.length === 0) {
        continue;
      }
      const buf = this.buffers.get(key);
      if (buf === undefined) {
        this.buffers.set(key, [{ tsMs, value }]);
      } else {
        buf.push({ tsMs, value });
      }
    }
    this.prune(now);
  }

  /**
   * Rehydrate the store from persisted samples (oldest → newest order is not
   * required; points are sorted by timestamp on read). Non-finite values and
   * unparseable timestamps are skipped.
   */
  load(samples: ReadonlyArray<TrendSample>, now: Date): void {
    for (const s of samples) {
      const tsMs = Date.parse(s.ts);
      if (!Number.isFinite(tsMs) || !isFiniteNumber(s.value) || s.key.length === 0) {
        continue;
      }
      const buf = this.buffers.get(s.key);
      if (buf === undefined) {
        this.buffers.set(s.key, [{ tsMs, value: s.value }]);
      } else {
        buf.push({ tsMs, value: s.value });
      }
    }
    for (const buf of this.buffers.values()) {
      buf.sort((a, b) => a.tsMs - b.tsMs);
    }
    this.prune(now);
  }

  /** Drop every sample older than the window relative to `now`. */
  prune(now: Date): void {
    const cutoff = now.getTime() - this.windowMs;
    for (const [key, buf] of this.buffers) {
      let firstKept = 0;
      while (firstKept < buf.length && buf[firstKept]!.tsMs < cutoff) {
        firstKept += 1;
      }
      if (firstKept > 0) {
        buf.splice(0, firstKept);
      }
      if (buf.length === 0) {
        this.buffers.delete(key);
      }
    }
  }

  /**
   * Slope in units/hour over the retained window, via ordinary least-squares
   * (`slope = (nΣxy − ΣxΣy) / (nΣxx − (Σx)²)`, x in hours). Returns `null`
   * when there are fewer than two points or when all points share the same
   * timestamp (zero variance in x → undefined slope).
   */
  slopePerHour(key: string): number | null {
    const buf = this.buffers.get(key);
    if (buf === undefined || buf.length < 2) {
      return null;
    }
    const originMs = buf[0]!.tsMs;
    const n = buf.length;
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let sxy = 0;
    for (const p of buf) {
      const x = (p.tsMs - originMs) / 3_600_000; // hours since origin
      const y = p.value;
      sx += x;
      sy += y;
      sxx += x * x;
      sxy += x * y;
    }
    const denom = n * sxx - sx * sx;
    if (denom === 0) {
      return null;
    }
    return (n * sxy - sx * sy) / denom;
  }

  /** Latest value and simple average over the window; `null` when empty. */
  summary(key: string): TrendSummary {
    const buf = this.buffers.get(key);
    if (buf === undefined || buf.length === 0) {
      return { latest: null, avg: null };
    }
    const latest = buf[buf.length - 1]!.value;
    let sum = 0;
    for (const p of buf) {
      sum += p.value;
    }
    return { latest, avg: sum / buf.length };
  }

  /** Export the current retained samples (for persistence snapshots/tests). */
  export(): TrendSample[] {
    const out: TrendSample[] = [];
    for (const [key, buf] of this.buffers) {
      for (const p of buf) {
        out.push({ ts: new Date(p.tsMs).toISOString(), key, value: p.value });
      }
    }
    return out;
  }

  /** Keys currently holding at least one sample. */
  keys(): string[] {
    return [...this.buffers.keys()];
  }
}
