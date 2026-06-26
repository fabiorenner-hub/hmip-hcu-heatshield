/**
 * Heat Shield — Connect log ring buffer (Task 13.2).
 *
 * In-memory ring buffer that captures the last N log entries
 * produced by the Connect-API surface (`ConnectClient`,
 * `OwnDeviceManager`, `HmipSystemAdapter`, `UserInputBridge`). The
 * buffer is the data source for the diagnose tab's "Connect log"
 * section, exposed through the `GET /api/connect/log` endpoint
 * (Task 13.2 wiring in `dashboard/server.ts`).
 *
 * ─── Design choices ────────────────────────────────────────────────
 *
 *   - The class implements the {@link ConnectLogger} signature so it
 *     can be passed straight into `ConnectClient`,
 *     `OwnDeviceManager`, etc. as their `logger` injection. That
 *     keeps the boot module's wiring trivial: every log site that
 *     already accepts a `ConnectLogger` automatically feeds the
 *     buffer.
 *   - Storage is a fixed-capacity array used as a ring buffer:
 *     `head` advances mod `capacity`, oldest entry is overwritten on
 *     push. This avoids per-append allocations and keeps the worst-
 *     case memory footprint at `capacity * sizeof(entry)`.
 *   - `entries()` returns a fresh array in oldest-first order so the
 *     dashboard can render directly without reversing.
 *   - `clear()` empties the buffer (size 0) but keeps the capacity.
 *   - The buffer makes a defensive shallow clone of the optional
 *     `ctx` map on append so a later mutation of the caller's
 *     object cannot retroactively change the persisted log line.
 *
 * Module rules (mirrored from sibling modules):
 *   - Strict TS, ESM, `.js` import suffixes.
 *   - No console.*, no fs, no globals.
 *   - Pure with respect to the inputs — appending an entry does not
 *     observe the wall clock unless the caller omits a timestamp;
 *     in that case we use the injectable `now()` factory so unit
 *     tests can pin deterministic ISO strings.
 */

import type { ConnectLogger } from './client.js';

// ---------------------------------------------------------------------------
// Public types.
// ---------------------------------------------------------------------------

/**
 * Log levels accepted by the buffer. Mirrors the {@link ConnectLogger}
 * signature so a buffer instance can stand in for that contract.
 */
export type ConnectLogLevel = 'info' | 'warn' | 'error';

/**
 * One captured log entry. The shape mirrors the JSON returned by
 * `GET /api/connect/log`, so the dashboard can render it directly
 * without an additional adapter step.
 *
 *   - `ts`    — ISO-8601 UTC timestamp captured at `append` time.
 *   - `level` — one of `'info' | 'warn' | 'error'`.
 *   - `msg`   — short, human-readable message.
 *   - `ctx`   — optional structured context map. Pass-through;
 *               consumers must not assume a particular shape.
 */
export interface ConnectLogEntry {
  ts: string;
  level: ConnectLogLevel;
  msg: string;
  ctx?: Record<string, unknown>;
}

/**
 * Constructor options for {@link ConnectLogBuffer}.
 *
 *   - `capacity` — ring-buffer size. Defaults to `1000` (steering:
 *                  the diagnose tab loads up to 1000 lines per
 *                  request; the backend cap is `5000` enforced at
 *                  the route layer, but the buffer itself is sized
 *                  to the default request count).
 *   - `now`      — optional clock injection for deterministic tests.
 */
export interface ConnectLogBufferOptions {
  readonly capacity?: number;
  readonly now?: () => Date;
}

// ---------------------------------------------------------------------------
// Defaults.
// ---------------------------------------------------------------------------

const DEFAULT_CAPACITY = 1000;

// ---------------------------------------------------------------------------
// Buffer.
// ---------------------------------------------------------------------------

/**
 * Fixed-capacity ring buffer for Connect-API log entries. See module
 * header for the design notes.
 *
 * Implements {@link ConnectLogger} so a buffer instance can be
 * passed straight into `ConnectClient`, `OwnDeviceManager`, … as
 * their `logger` dependency.
 */
export class ConnectLogBuffer {
  private readonly capacity: number;
  private readonly now: () => Date;
  private readonly storage: Array<ConnectLogEntry | undefined>;
  private head: number = 0;
  private size: number = 0;

  public constructor(options: ConnectLogBufferOptions = {}) {
    const cap =
      options.capacity === undefined || options.capacity <= 0
        ? DEFAULT_CAPACITY
        : Math.floor(options.capacity);
    this.capacity = cap;
    this.now = options.now ?? ((): Date => new Date());
    this.storage = new Array<ConnectLogEntry | undefined>(cap);
  }

  /**
   * Push a new entry into the buffer. When the buffer is at
   * capacity, the oldest entry is overwritten (FIFO eviction).
   *
   * `ctx` is shallow-cloned so a later mutation of the caller's
   * object cannot retroactively change the persisted log line.
   * Nested values are NOT cloned — callers that pass a mutable
   * nested object are responsible for not mutating it post-append.
   */
  public append(
    level: ConnectLogLevel,
    msg: string,
    ctx?: Record<string, unknown>,
  ): void {
    const entry: ConnectLogEntry = {
      ts: this.now().toISOString(),
      level,
      msg,
      ...(ctx !== undefined ? { ctx: { ...ctx } } : {}),
    };
    this.storage[this.head] = entry;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) {
      this.size += 1;
    }
  }

  /**
   * Return the captured entries in oldest-first order. Always a
   * fresh array — consumers can mutate the returned list freely
   * without affecting the buffer.
   */
  public entries(): ConnectLogEntry[] {
    const out: ConnectLogEntry[] = [];
    if (this.size === 0) {
      return out;
    }
    // When the ring is not yet full, entries occupy slots
    // `[0, size)` in insertion order, so `head === size`. When
    // full, the oldest entry is at `head` and we wrap.
    const start =
      this.size < this.capacity
        ? 0
        : this.head;
    for (let i = 0; i < this.size; i += 1) {
      const idx = (start + i) % this.capacity;
      const entry = this.storage[idx];
      if (entry !== undefined) {
        out.push(entry);
      }
    }
    return out;
  }

  /**
   * Empty the buffer. Capacity is preserved.
   */
  public clear(): void {
    for (let i = 0; i < this.capacity; i += 1) {
      this.storage[i] = undefined;
    }
    this.head = 0;
    this.size = 0;
  }

  /**
   * Number of entries currently stored. `<= capacity`.
   */
  public get length(): number {
    return this.size;
  }

  /**
   * {@link ConnectLogger}-compatible bound method. Lets a buffer
   * instance be passed directly as the `logger` injection on
   * `ConnectClient`, `OwnDeviceManager`, … without an additional
   * wrapper:
   *
   *   const buf = new ConnectLogBuffer();
   *   const client = new ConnectClient({ ..., logger: buf.asLogger });
   */
  public readonly asLogger: ConnectLogger = (
    level: ConnectLogLevel,
    msg: string,
    ctx?: Record<string, unknown>,
  ): void => {
    this.append(level, msg, ctx);
  };
}
