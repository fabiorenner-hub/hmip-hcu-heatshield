/**
 * Heat Shield — inferred TypeScript types.
 *
 * This module is the type-only counterpart to `src/shared/schema.ts`. Every
 * shape in the codebase that mirrors a config-time entity is derived here
 * via `z.infer<typeof ...>` so the schemas in `schema.ts` remain the single
 * source of truth.
 *
 * Conventions:
 *   - Pure type module: no runtime code, no value re-exports.
 *   - Schema imports are `import type` so this file participates in
 *     type-only graph optimization (NodeNext + ESM friendly).
 *   - Hand-rolled literal unions live below the `z.infer` block; they
 *     describe runtime concerns (FSM modes, contact debounce states) that
 *     are not part of the persisted config.
 */

import type { z } from 'zod';

import type {
  AutomationRulesSchema,
  ComfortRulesSchema,
  ConfigSchema,
  DashboardSchema,
  FusionSolarSchema,
  GlobalSignalsSchema,
  GardenaSchema,
  IrrigationSchema,
  IrrigationZoneSchema,
  HeatLoadRulesSchema,
  LocationSchema,
  ModeThresholdsSchema,
  NightCoolingRulesSchema,
  NotificationEventsSchema,
  NotificationsSchema,
  RoomSchema,
  RoomTargetsSchema,
  RulesSchema,
  SignalBindingSchema,
  SourceRefSchema,
  StormRulesSchema,
  SunRulesSchema,
  TelegramConfigSchema,
  WindowSchema,
} from './schema.js';

// Runtime state types (Task 3.2). State lives in `/data/state.json` and is
// the engine's persistent memory between restarts; the schemas live in
// `./state-schema.ts` so this module stays a pure type re-export hub.
export type {
  OwnSwitchId,
  OwnSwitchState,
  RuntimeState,
  UserIntentState,
  WindowRuntimeState,
} from './state-schema.js';

// Decision Record types (Task 3.3). The orchestrator produces one
// DecisionRecord per engine cycle; the schema lives in
// `./decision-schema.ts` so the history store stays generic.
export type {
  BlockedBy,
  DecisionRecord,
  WindowDecisionEntry,
} from './decision-schema.js';

// ---------------------------------------------------------------------------
// Inferred config types — alphabetical for easy lookup.
// ---------------------------------------------------------------------------

export type AutomationRules = z.infer<typeof AutomationRulesSchema>;
export type ComfortRules = z.infer<typeof ComfortRulesSchema>;
export type Config = z.infer<typeof ConfigSchema>;
export type DashboardConfig = z.infer<typeof DashboardSchema>;
export type FusionSolarConfig = z.infer<typeof FusionSolarSchema>;
export type GlobalSignals = z.infer<typeof GlobalSignalsSchema>;
export type GardenaConfig = z.infer<typeof GardenaSchema>;
export type IrrigationConfig = z.infer<typeof IrrigationSchema>;
export type IrrigationZone = z.infer<typeof IrrigationZoneSchema>;
export type HeatLoadRules = z.infer<typeof HeatLoadRulesSchema>;
export type Location = z.infer<typeof LocationSchema>;
export type ModeThresholds = z.infer<typeof ModeThresholdsSchema>;
export type NightCoolingRules = z.infer<typeof NightCoolingRulesSchema>;
export type NotificationEvents = z.infer<typeof NotificationEventsSchema>;
export type Notifications = z.infer<typeof NotificationsSchema>;
export type Room = z.infer<typeof RoomSchema>;
export type RoomTargets = z.infer<typeof RoomTargetsSchema>;
export type Rules = z.infer<typeof RulesSchema>;
export type SignalBinding = z.infer<typeof SignalBindingSchema>;
export type SourceRef = z.infer<typeof SourceRefSchema>;
export type StormRules = z.infer<typeof StormRulesSchema>;
export type SunRules = z.infer<typeof SunRulesSchema>;
export type TelegramConfig = z.infer<typeof TelegramConfigSchema>;
export type Window = z.infer<typeof WindowSchema>;

// ---------------------------------------------------------------------------
// Runtime-only literal unions.
// These describe engine and orchestrator state that is not persisted in
// `/data/config.json`, so they are not derivable from the Zod schemas.
// ---------------------------------------------------------------------------

/**
 * Finite-state machine modes used by the engine. STORM has the highest
 * priority above every other mode (steering rule). `heat_mode_active` is
 * defined as `mode ∈ {ACTIVE_HEAT_PROTECTION, HEATWAVE}` and must not be
 * widened.
 */
export type Mode =
  | 'NORMAL'
  | 'SUMMER_WATCH'
  | 'ACTIVE_HEAT_PROTECTION'
  | 'HEATWAVE'
  | 'NIGHT_COOLING'
  | 'STORM'
  | 'VACATION'
  | 'MAINTENANCE';

/**
 * Room priority — extracted from the schema so the literal union stays in
 * lockstep with whatever `RoomSchema.priority` accepts.
 */
export type Priority = Room['priority'];

/**
 * Discriminator of `SourceRef`. Used by the source-adapter dispatch to pick
 * the right `pickSignal` implementation (static / hmip / fusion / openmeteo).
 */
export type SourceKind = SourceRef['kind'];

/**
 * Window-contact debounce state as exposed in the orchestrator's
 * `CycleSnapshot`. `unknown` is reported when the contact device has not
 * produced a fresh sample within its stale window.
 */
export type ContactState = 'closed' | 'tilted' | 'open' | 'unknown';
