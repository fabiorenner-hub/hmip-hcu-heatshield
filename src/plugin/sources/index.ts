/**
 * Heat Shield — source resolver (Task 5.4).
 *
 * Single entry point that routes a {@link SignalBinding} to the right
 * adapter:
 *
 *   - `static`     → {@link resolveStatic}.
 *   - `hmip`       → HCU cache via {@link pickSignal}.
 *   - `openmeteo`  → HCU cache via {@link pickSignal} (the OpenMeteo
 *                    plugin exposes itself as one or more
 *                    `CLIMATE_SENSOR` devices on the HCU bus, so the
 *                    same cache and the same staleness rule apply).
 *   - `fusion`     → {@link FusionSolarAdapter.getValue}, with the same
 *                    `staleAfterSec` budget {@link pickSignal} applies
 *                    to HCU-backed features.
 *
 * The previous {@link pickSignal} in `hcu.ts` deliberately returned
 * `'no_value'` for `kind: 'fusion'`: FusionSolar is not part of the
 * HCU cache, and bundling its lookup into `pickSignal` would have
 * forced that module to depend on the FusionSolar adapter. This
 * resolver fills that gap by holding both adapters in a {@link
 * SourceContext} and dispatching by `ref.kind`.
 *
 * Resolution rules:
 *
 *   - `binding === undefined`                      → `'unbound'`.
 *   - Try `binding.primary`:
 *       - on success            → `{ ok: true, ..., usedFallback: false }`.
 *       - on failure with no fallback → propagate the primary's reason.
 *   - Try `binding.fallback`:
 *       - on success            → `{ ok: true, ..., usedFallback: true }`.
 *       - on failure            → propagate the fallback's reason.
 *
 * The most-recent attempted leg's reason wins on overall failure (as
 * documented in the design). Boolean / string features (e.g.
 * `raining`) are out of scope for v1: a non-numeric value coming back
 * from the cache is treated as `'no_value'` so the engine never has
 * to narrow at the call site.
 *
 * Strict-mode notes (`exactOptionalPropertyTypes`,
 * `noUncheckedIndexedAccess`):
 *   - The `value` field is statically narrowed to `number` because
 *     all four `SourceRef` arms produce numbers in this codebase
 *     (FusionSolar fields are numeric, HCU and OpenMeteo features the
 *     engine consumes are numeric, static is numeric).
 *   - The `fusion` adapter is allowed to be `null` so the orchestrator
 *     can drop the FusionSolar dependency at runtime when the user
 *     has not configured the local plugin yet.
 */

import type { SignalBinding, SourceRef } from '../../shared/types.js';

import {
  FusionSolarAdapter,
  type FusionField,
  type FusionSnapshotValue,
  type FusionSolarAdapterOptions,
  type FusionSolarStatus,
} from './fusionSolar.js';
import {
  HcuSourceCache,
  pickSignal,
  type HmipDeviceMeta,
  type HmipFeatureValue,
  type SignalResolution,
} from './hcu.js';
import {
  OpenMeteoAdapter,
  type OpenMeteoField,
  type OpenMeteoValue,
  type OpenMeteoAdapterOptions,
  type OpenMeteoStatus,
} from './openMeteo.js';
import {
  createStaticSource,
  resolveStatic,
  type StaticSource,
} from './static.js';

// ---------------------------------------------------------------------------
// Re-exports — keep `from '../sources/index.js'` the canonical import path
// for the rest of the codebase.
// ---------------------------------------------------------------------------

export {
  FusionSolarAdapter,
  HcuSourceCache,
  OpenMeteoAdapter,
  createStaticSource,
  pickSignal,
  resolveStatic,
};
export type {
  FusionField,
  FusionSnapshotValue,
  FusionSolarAdapterOptions,
  FusionSolarStatus,
  HmipDeviceMeta,
  HmipFeatureValue,
  OpenMeteoField,
  OpenMeteoValue,
  OpenMeteoAdapterOptions,
  OpenMeteoStatus,
  SignalResolution,
  StaticSource,
};

// ---------------------------------------------------------------------------
// Public surface.
// ---------------------------------------------------------------------------

/**
 * Bundle of every adapter the resolver might need. `fusion` is
 * nullable so a user without FusionSolar configured can still run the
 * engine — `kind: 'fusion'` references then resolve to `'no_value'`
 * and fall through to whatever fallback the wizard selected (typically
 * the OpenMeteo `shortwave_radiation_wm2` mirror).
 *
 * `now` is captured per cycle (not via a `() => Date` thunk) so every
 * leg of the binding is evaluated against the same instant: the
 * staleness check and the static `observedAt` stamp must agree, and a
 * thunk could drift between calls.
 */
export interface SourceContext {
  readonly hcu: HcuSourceCache;
  readonly fusion: FusionSolarAdapter | null;
  /**
   * Direct OpenMeteo HTTP adapter (Wave 5). Optional so existing callers
   * that never bind an `openmeteo_http` source compile unchanged; when
   * absent, such references resolve to `'no_value'`.
   */
  readonly openMeteo?: OpenMeteoAdapter | null;
  readonly now: Date;
}

/**
 * Resolve a {@link SignalBinding} against the supplied
 * {@link SourceContext}. The result narrows `value` to `number` (see
 * module header for the rationale).
 *
 * @param binding - The signal binding to resolve. `undefined` is
 *                  accepted as the orchestrator's "feature is not
 *                  bound" sentinel and surfaces as `'unbound'`.
 * @param ctx     - Adapter bundle plus the current wall-clock instant.
 */
export function resolveSignal(
  binding: SignalBinding | undefined,
  ctx: SourceContext,
): SignalResolution<number> {
  if (binding === undefined) {
    return { ok: false, reason: 'unbound' };
  }

  const primary = resolveLeg(binding.primary, binding.staleAfterSec, ctx);
  if (primary.ok) {
    return {
      ok: true,
      value: primary.value,
      observedAt: primary.observedAt,
      usedFallback: false,
    };
  }

  if (binding.fallback !== undefined) {
    const fallback = resolveLeg(binding.fallback, binding.staleAfterSec, ctx);
    if (fallback.ok) {
      return {
        ok: true,
        value: fallback.value,
        observedAt: fallback.observedAt,
        usedFallback: true,
      };
    }
    // Fallback was the most-recent attempt — its reason wins.
    return { ok: false, reason: fallback.reason };
  }

  return { ok: false, reason: primary.reason };
}

// ---------------------------------------------------------------------------
// Internal helpers.
// ---------------------------------------------------------------------------

/**
 * Outcome of resolving a single leg (primary or fallback). Mirrors
 * {@link SignalResolution} but without the `usedFallback` flag — that
 * flag is decided at the binding level by {@link resolveSignal}.
 *
 * `'unbound'` is impossible here because every leg is a concrete
 * {@link SourceRef}; the union is narrowed accordingly.
 */
type LegOutcome =
  | { readonly ok: true; readonly value: number; readonly observedAt: Date }
  | { readonly ok: false; readonly reason: 'stale' | 'no_value' };

function resolveLeg(
  ref: SourceRef,
  staleAfterSec: number,
  ctx: SourceContext,
): LegOutcome {
  switch (ref.kind) {
    case 'static': {
      // resolveStatic never fails — narrow with a runtime check anyway
      // so the LegOutcome shape stays uniform.
      const r = resolveStatic(ref, ctx.now);
      if (!r.ok) {
        return { ok: false, reason: 'no_value' };
      }
      return { ok: true, value: r.value, observedAt: r.observedAt };
    }

    case 'hmip':
    case 'openmeteo': {
      // Delegate to pickSignal with a single-leg binding so the cache
      // staleness rule lives in one place. `staleAfterSec` is forwarded
      // verbatim.
      const r = pickSignal<unknown>(
        { primary: ref, staleAfterSec },
        ctx.hcu,
        { now: ctx.now },
      );
      if (!r.ok) {
        // 'unbound' is impossible (we passed a binding); collapse to
        // 'no_value' for exhaustiveness.
        return {
          ok: false,
          reason: r.reason === 'stale' ? 'stale' : 'no_value',
        };
      }
      if (typeof r.value !== 'number' || !Number.isFinite(r.value)) {
        // Boolean/string features (e.g. `raining`) are not
        // engine-consumable in v1.
        return { ok: false, reason: 'no_value' };
      }
      return { ok: true, value: r.value, observedAt: r.observedAt };
    }

    case 'fusion':
      return resolveFusion(ref, staleAfterSec, ctx);

    case 'openmeteo_http':
      return resolveOpenMeteoHttp(ref, staleAfterSec, ctx);
  }
}

function resolveFusion(
  ref: Extract<SourceRef, { kind: 'fusion' }>,
  staleAfterSec: number,
  ctx: SourceContext,
): LegOutcome {
  if (ctx.fusion === null) {
    return { ok: false, reason: 'no_value' };
  }
  const fv: FusionSnapshotValue | null = ctx.fusion.getValue(ref.field);
  if (fv === null) {
    return { ok: false, reason: 'no_value' };
  }
  const ageMs = ctx.now.getTime() - fv.observedAt.getTime();
  if (ageMs > staleAfterSec * 1000) {
    return { ok: false, reason: 'stale' };
  }
  return { ok: true, value: fv.value, observedAt: fv.observedAt };
}

function resolveOpenMeteoHttp(
  ref: Extract<SourceRef, { kind: 'openmeteo_http' }>,
  staleAfterSec: number,
  ctx: SourceContext,
): LegOutcome {
  const adapter = ctx.openMeteo ?? null;
  if (adapter === null) {
    return { ok: false, reason: 'no_value' };
  }
  const v = adapter.getValue(ref.field);
  if (v === null) {
    return { ok: false, reason: 'no_value' };
  }
  const ageMs = ctx.now.getTime() - v.observedAt.getTime();
  if (ageMs > staleAfterSec * 1000) {
    return { ok: false, reason: 'stale' };
  }
  return { ok: true, value: v.value, observedAt: v.observedAt };
}
