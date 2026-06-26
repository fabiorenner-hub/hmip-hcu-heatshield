/**
 * Heat Shield — static source adapter (Task 5.3).
 *
 * Tiny adapter for the `'static'` arm of the {@link SourceRef}
 * discriminated union. The orchestrator-level resolver in
 * {@link ../sources/hcu.ts | hcu.ts::pickSignal} already handles the
 * static case inline for convenience, but a dedicated module gives:
 *
 *   - a typed factory `createStaticSource(value)` that the wizard and
 *     unit tests can use to spin up a tiny in-process source without
 *     having to construct a {@link SourceRef} by hand;
 *   - a stand-alone `resolveStatic(ref, now)` that returns the same
 *     {@link SignalResolution} shape used by every other source
 *     adapter, so callers that already hold a `'static'` ref can
 *     resolve it without going through the binding machinery.
 *
 * Design notes:
 *
 *   - `observedAt` is **always cloned** from the caller's `now`. The
 *     {@link SignalResolution} type advertises a `readonly Date`, but
 *     `Date` is mutable in JavaScript; cloning prevents external
 *     callers from mutating the timestamp by reference after the
 *     fact.
 *   - `usedFallback` is hard-coded to `false`. A static value is by
 *     definition the primary leg of any binding it belongs to.
 *   - The function never fails. The narrowed `Extract<SourceRef, …>`
 *     parameter type guarantees `value` is a `number` at compile
 *     time, so we do not need a runtime guard here.
 */

import type { SourceRef } from '../../shared/types.js';

import type { SignalResolution } from './hcu.js';

/**
 * Resolve a `'static'` {@link SourceRef} into the canonical
 * {@link SignalResolution} shape.
 *
 * @param ref - A `SourceRef` narrowed to its `'static'` arm.
 * @param now - Wall-clock instant used to stamp `observedAt`.
 *              Cloned defensively so later mutations of the caller's
 *              `Date` do not leak into the result.
 * @returns Always `{ ok: true, value: ref.value, observedAt, usedFallback: false }`.
 */
export function resolveStatic(
  ref: Extract<SourceRef, { kind: 'static' }>,
  now: Date,
): SignalResolution<number> {
  return {
    ok: true,
    value: ref.value,
    observedAt: new Date(now.getTime()),
    usedFallback: false,
  };
}

/**
 * Tiny in-process source built around a single literal value.
 *
 * The wizard uses this when the user opts to bind a signal to a
 * fixed setpoint (e.g. comfort target 21°C without a sensor). Tests
 * use it as a deterministic stand-in for an HCU- or FusionSolar-
 * backed source.
 */
export interface StaticSource {
  /** The literal value this source returns on every `resolve`. */
  readonly value: number;
  /**
   * Resolve the source against the supplied wall-clock instant.
   * Equivalent to calling `resolveStatic({ kind: 'static', value }, now)`.
   */
  resolve(now: Date): SignalResolution<number>;
}

/**
 * Factory for {@link StaticSource}. The returned object captures
 * `value` once and exposes it both as a readonly property (for
 * inspection in the wizard's preview pane) and via `resolve` (for
 * the resolver loop in the orchestrator).
 *
 * @param value - The literal value the source should return.
 */
export function createStaticSource(value: number): StaticSource {
  return {
    value,
    resolve(now: Date): SignalResolution<number> {
      return resolveStatic({ kind: 'static', value }, now);
    },
  };
}
