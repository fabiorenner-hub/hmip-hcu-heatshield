/**
 * Heat Shield — Decision Record schema (Task 3.3).
 *
 * The orchestrator (Task 8) builds one `DecisionRecord` per engine cycle
 * and feeds it into the NDJSON history store
 * (`src/plugin/persistence/history.ts`). The dashboard's diagnose tab
 * (Task 13) reads the same shape back via `readLastN`.
 *
 * Field naming follows `schema.ts` and `state-schema.ts`: identifiers in
 * English, ISO-8601 timestamps, no engine logic, no fs. Mode reuses
 * `ModeSchema` so the Decision Record discriminator stays in lockstep
 * with the runtime FSM in `state-schema.ts`.
 *
 * Why a separate file?
 *   - Config schema (`schema.ts`) and runtime state schema
 *     (`state-schema.ts`) are persisted as JSON objects, validated on
 *     write, defaulted on parse. Decision Records are append-only
 *     telemetry rows that fan out to a different store (NDJSON) with
 *     different retention rules. Co-locating them with the config
 *     schema would blur the boundary.
 *   - The history store itself is generic over `T` (manual-override and
 *     storm events have their own shapes). Keeping the Decision Record
 *     schema next to its siblings rather than wired into history.ts
 *     preserves that genericity.
 */

import { z } from 'zod';

import { ModeSchema } from './state-schema.js';

/**
 * Reasons the orchestrator may report for a window where no movement
 * was dispatched even though the risk model produced a non-trivial
 * target. The set is closed: the engine must classify every block into
 * one of these buckets so the dashboard can present a stable legend.
 *
 *   - `hysteresis`        — `|target − current| < min_position_delta_pct`.
 *   - `min_seconds`       — `min_seconds_between_moves` not yet elapsed.
 *   - `manual_override`   — `manualOverrideUntil` is in the future.
 *   - `pause`             — `heatshield-control-pause` is on.
 *   - `storm`             — STORM mode forced the shutter to 0 / locked it.
 *   - `system_error`      — `HMIP_SYSTEM_REQUEST` returned an error
 *                           (design.md §Error Handling).
 *   - `blocked`           — per-window automation block (config).
 *   - `venting`           — window contact reports open; ventilation
 *                           lockout suppresses all movement until it
 *                           closes (smart-shading Requirement 7).
 */
export const BlockedBySchema = z.enum([
  'hysteresis',
  'min_seconds',
  'manual_override',
  'pause',
  'storm',
  'system_error',
  'blocked',
  'venting',
]);

/**
 * Per-window slice of a `DecisionRecord`. `factors` is a free-form map
 * (string → number) so the orchestrator can attach whatever risk
 * components were computed (`sunFactor`, `roomTempFactor`, …) without
 * needing a schema bump every time a factor is added or removed.
 */
/**
 * Planner decision slice (predictive-control-dashboard). Additive and
 * optional so existing records remain valid.
 *   - `deviation`      — triggering deviation when an off-plan move fired (4.5).
 *   - `plannedTarget01`— Forecast_Planner base target for this window [0,1].
 *   - `confidence01`   — trajectory confidence of the associated room [0,1].
 */
export const PlannerDecisionSchema = z.object({
  deviation: z
    .object({
      roomId: z.string(),
      deviationC: z.number().nullable(),
      deviationLoad01: z.number().nullable(),
      triggeringValue: z.enum(['temp', 'load']).nullable(),
    })
    .optional(),
  plannedTarget01: z.number().min(0).max(1).optional(),
  confidence01: z.number().min(0).max(1).optional(),
});

export const WindowDecisionEntrySchema = z.object({
  windowId: z.string().min(1),
  factors: z.record(z.string(), z.number()),
  risk: z.number(),
  rawTarget: z.number(),
  afterSpecialRules: z.number(),
  afterSafety: z.number(),
  finalTarget: z.number(),
  moved: z.boolean(),
  blockedBy: BlockedBySchema.optional(),
  planner: PlannerDecisionSchema.optional(),
});

/**
 * Top-level shape of a single engine-cycle decision row, persisted as
 * one NDJSON line in `/data/history.ndjson` inside a generic
 * `HistoryRecord<DecisionRecord>` envelope.
 */
export const DecisionRecordSchema = z.object({
  cycleId: z.string().min(1),
  ts: z.iso.datetime(),
  mode: ModeSchema,
  windowDecisions: z.array(WindowDecisionEntrySchema),
});

export type BlockedBy = z.infer<typeof BlockedBySchema>;
export type WindowDecisionEntry = z.infer<typeof WindowDecisionEntrySchema>;
export type DecisionRecord = z.infer<typeof DecisionRecordSchema>;

/**
 * Parse an unknown value as a `DecisionRecord`, throwing a `ZodError`
 * on failure. Use this when reading rows back from the history store
 * and validation is required (e.g. the Diagnose-Tab in Task 13).
 */
export function parseDecisionRecord(input: unknown): DecisionRecord {
  return DecisionRecordSchema.parse(input);
}

/**
 * Non-throwing variant of {@link parseDecisionRecord}. Useful when
 * iterating over many lines from the history file and dropping a
 * malformed row is preferred to aborting the whole stream.
 */
export function safeParseDecisionRecord(
  input: unknown,
): z.ZodSafeParseResult<DecisionRecord> {
  return DecisionRecordSchema.safeParse(input);
}
