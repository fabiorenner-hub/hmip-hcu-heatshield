/**
 * Heat Shield — dry-probe runner (Tasks 13.3 + 15 wiring contract).
 *
 * Wraps {@link runCycle} with a guaranteed no-op `setShutterLevel`
 * stub so the dashboard's "Probelauf jetzt" button can run a fully
 * synthetic cycle that produces a {@link DecisionRecord} without
 * issuing any Connect-API control requests.
 *
 * ─── Steering compliance ──────────────────────────────────────────
 *
 *   - The probe path MUST NOT issue `setShutterLevel`. This module
 *     is the ONLY public entry point for that contract; the boot
 *     module (Task 15) wires `runDryProbe` into the dashboard
 *     server's `runProbe` dependency, and from that point on every
 *     probe request flows through `runDryProbe`.
 *   - Native HMIP rollers are never touched: the upstream
 *     `runCycle` calls `deps.hmipSystem.setShutterLevel`, and we
 *     pass a stub that returns immediately and forwards no payload
 *     to anything. The orchestrator's blocked-by tracking
 *     (`hysteresis`, `safety`, `system_error`) sees an
 *     instantaneously-successful "move", so the resulting
 *     `DecisionRecord` mirrors what the engine WOULD have done with
 *     a live Connect transport.
 *   - `appendHistoryRecord` is also stubbed by default — a probe
 *     must not pollute `/data/history.ndjson`. Callers that
 *     explicitly want the probe to be persisted can override via
 *     {@link DryProbeDeps.appendHistoryRecord}.
 *
 * ─── Contract notes ───────────────────────────────────────────────
 *
 *   - The function signature mirrors `runCycle(snapshot, deps)` so
 *     the boot module's `runProbe` callback can be a thin closure.
 *   - The probe re-uses the snapshot the boot module would normally
 *     pass to `runCycle`. Building that snapshot (resolving sources,
 *     computing `pvDroppedRecently`, …) is the boot module's job;
 *     this function is intentionally unaware of where the snapshot
 *     came from.
 *   - The probe cannot lower the orchestrator's invariants: it
 *     produces a fresh `cycleId`, the same DecisionRecord shape, and
 *     the same `newStormHoldUntil` decision the FSM would have
 *     produced. The CALLER is responsible for NOT persisting
 *     `newStormHoldUntil` for a probe — passing it back into
 *     `RuntimeState.stormHoldUntil` would let a probe poison the
 *     STORM hold.
 *
 * Module rules (mirrored from sibling modules):
 *   - Strict TS, ESM, `.js` import suffixes.
 *   - No fs, no Connect API plumbing, no globals.
 *   - Self-contained — unit-testable without a running engine.
 */

import {
  runCycle,
  type CycleOutputs,
  type CycleSnapshot,
  type OrchestratorDeps,
} from '../engine/orchestrator.js';

// ---------------------------------------------------------------------------
// Public types.
// ---------------------------------------------------------------------------

/**
 * Subset of {@link OrchestratorDeps} the dry probe accepts. The
 * caller supplies everything `runCycle` needs EXCEPT the
 * `hmipSystem` and the `appendHistoryRecord` sink — both are
 * forced to no-ops by {@link runDryProbe}, regardless of what the
 * caller passes. That asymmetry is the steering-mandated guarantee:
 * even a buggy boot module wiring cannot accidentally cause a probe
 * to issue `setShutterLevel` or pollute the history file.
 */
export type DryProbeDeps = Omit<
  OrchestratorDeps,
  'hmipSystem' | 'appendHistoryRecord'
> & {
  /**
   * Optional history sink override. Defaults to a no-op so probes
   * never pollute `/data/history.ndjson`. Tests / power users that
   * want to persist a probe can pass a real sink here, but the
   * default behaviour is "do not persist".
   */
  readonly appendHistoryRecord?: OrchestratorDeps['appendHistoryRecord'];
};

// ---------------------------------------------------------------------------
// runDryProbe.
// ---------------------------------------------------------------------------

/**
 * Run one synthetic engine cycle that produces a
 * {@link DecisionRecord} without issuing any `setShutterLevel`
 * calls. Returns the same {@link CycleOutputs} shape as
 * {@link runCycle}, so consumers can render the probe result
 * exactly like a real cycle's output.
 *
 * Implementation: forwards `snapshot` and a copy of `deps` into
 * `runCycle`, but replaces:
 *
 *   - `hmipSystem.setShutterLevel` with `async () => {}` (stubbed),
 *   - `appendHistoryRecord` with `undefined` (sink disabled by
 *     default — caller can re-enable explicitly via
 *     {@link DryProbeDeps.appendHistoryRecord}).
 *
 * The orchestrator never inspects the result of `setShutterLevel`
 * beyond awaiting the promise, so a fast-resolving stub produces a
 * `DecisionRecord` with `moved=true` for every window the engine
 * would have moved.
 */
export async function runDryProbe(
  snapshot: CycleSnapshot,
  deps: DryProbeDeps,
): Promise<CycleOutputs> {
  // Force the stubbed adapter — even if the caller (incorrectly)
  // tried to slip a real `hmipSystem` in via a structural cast, the
  // `Omit` in `DryProbeDeps` prevents it at the type level, and the
  // explicit override here re-establishes the steering guarantee at
  // runtime.
  const stubbedDeps: OrchestratorDeps = {
    config: deps.config,
    hmipSystem: {
      setShutterLevel: async (): Promise<void> => {
        /* Probe path: dispatch is a deliberate no-op (steering). */
      },
    },
    ...(deps.appendHistoryRecord !== undefined
      ? { appendHistoryRecord: deps.appendHistoryRecord }
      : {}),
    ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
    ...(deps.sun !== undefined ? { sun: deps.sun } : {}),
    ...(deps.channelIndexFor !== undefined
      ? { channelIndexFor: deps.channelIndexFor }
      : {}),
  };
  return runCycle(snapshot, stubbedDeps);
}
