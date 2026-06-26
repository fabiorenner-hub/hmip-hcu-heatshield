/**
 * Heat Shield — pure dashboard-snapshot field helpers
 * (predictive-control-dashboard Task 11, Properties 19–23).
 *
 * These small, deterministic helpers are the testable core of the V2
 * snapshot producer in `index.ts::buildSnapshot`. Keeping them pure (no
 * `this`, no I/O) lets the property tests in `tests/property` exercise the
 * snapshot-quality invariants directly.
 */

import type {
  DashboardSnapshotV2,
  FacadeKey,
  PlannedAction,
  PlannedActionState,
  ValueWithQuality,
} from './server.js';

/** All valid planned-action lifecycle states (Property 22). */
export const PLANNED_ACTION_STATES: readonly PlannedActionState[] = [
  'recommended',
  'scheduled',
  'executing',
  'completed',
  'blocked',
  'manuallyOverridden',
];

/** Runtime guard: is `x` a valid PlannedActionState? */
export function isPlannedActionState(x: unknown): x is PlannedActionState {
  return typeof x === 'string' && (PLANNED_ACTION_STATES as readonly string[]).includes(x);
}

/**
 * Cardinal facade key for an orientation in degrees
 * (Heat-Shield convention N=0, E=90, S=180, W=270). Nearest cardinal with
 * deterministic boundaries.
 */
export function facadeKeyFor(orientationDeg: number): FacadeKey {
  const n = ((orientationDeg % 360) + 360) % 360;
  if (n >= 45 && n < 135) return 'E';
  if (n >= 135 && n < 225) return 'S';
  if (n >= 225 && n < 315) return 'W';
  return 'N';
}

/** Last four characters of a device id (the part users recognise). */
export function shortId(deviceId: string): string {
  return deviceId.length <= 4 ? deviceId : deviceId.slice(-4);
}

/**
 * Human device label that NEVER exposes the full UUID (Property 23). Always
 * contains the last-4 id tail in parentheses.
 */
export function deviceShortLabel(
  deviceId: string,
  friendlyName?: string,
  roomName?: string,
): string {
  const tail = `(…${shortId(deviceId)})`;
  const device =
    friendlyName !== undefined && friendlyName.length > 0 ? friendlyName : 'Rollladen';
  const room = roomName !== undefined && roomName.length > 0 ? roomName : 'Ohne Raum';
  return `${room} – ${device} ${tail}`;
}

/** Construct a normalized ValueWithQuality (Property 20). */
export function makeValueWithQuality(
  value: number | null,
  origin: ValueWithQuality['origin'],
  source: string,
  confidence01: number,
): ValueWithQuality {
  const c = confidence01 < 0 ? 0 : confidence01 > 1 ? 1 : confidence01;
  return { value, origin, source, confidence01: c };
}

/** A planned action enriched with provenance for transparent display. */
export interface DisplayedAction {
  /** What: the resulting shutter target percent. */
  effectPercent: number;
  /** When: ISO-8601 timestamp. */
  whenTs: string;
  /** Why: human reason. */
  reason: string;
  /** Which data: underlying data source label. */
  dataSource: string;
  /** Confidence in [0,1]. */
  confidence01: number;
}

/** Build a transparent displayed action from a planned action (Property 19). */
export function toDisplayedAction(
  action: PlannedAction,
  dataSource: string,
  confidence01: number,
): DisplayedAction {
  return {
    effectPercent: action.targetPercent,
    whenTs: action.scheduledTs,
    reason: action.reason,
    dataSource,
    confidence01,
  };
}

/**
 * True iff all five transparency fields are present and non-empty
 * (Property 19): effect, when, reason, data source, confidence.
 */
export function isTransparencyComplete(d: DisplayedAction): boolean {
  return (
    Number.isFinite(d.effectPercent) &&
    typeof d.whenTs === 'string' &&
    !Number.isNaN(Date.parse(d.whenTs)) &&
    typeof d.reason === 'string' &&
    d.reason.length > 0 &&
    typeof d.dataSource === 'string' &&
    d.dataSource.length > 0 &&
    Number.isFinite(d.confidence01)
  );
}

/** True iff a ValueWithQuality is well-formed (Property 20). */
export function isValueWithQualityValid(v: ValueWithQuality): boolean {
  return (
    (v.origin === 'measured' || v.origin === 'forecast' || v.origin === 'estimated') &&
    typeof v.source === 'string' &&
    v.source.length > 0 &&
    v.confidence01 >= 0 &&
    v.confidence01 <= 1
  );
}

/**
 * Validate the required shape of a V2 snapshot (Property 21): `ts`,
 * `modeInfo{id,label,goal,reasons}`, `environment`, `facades`, `rooms[]`,
 * and a `nextAction` field on every room detail.
 */
export function validateSnapshotV2(snap: DashboardSnapshotV2): boolean {
  if (typeof snap.ts !== 'string' || Number.isNaN(Date.parse(snap.ts))) {
    return false;
  }
  const m = snap.modeInfo;
  if (
    m === undefined ||
    typeof m.id !== 'string' ||
    typeof m.label !== 'string' ||
    typeof m.goal !== 'string' ||
    !Array.isArray(m.reasons)
  ) {
    return false;
  }
  if (snap.environment === undefined || snap.facades === undefined) {
    return false;
  }
  if (!Array.isArray(snap.rooms)) {
    return false;
  }
  const rd = snap.roomsDetail ?? [];
  for (const r of rd) {
    if (!('nextAction' in r)) {
      return false;
    }
    if (!isPlannedActionState(r.status)) {
      return false;
    }
  }
  return true;
}
