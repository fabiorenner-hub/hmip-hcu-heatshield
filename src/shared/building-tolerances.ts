/**
 * Heat Shield — central geometry tolerances for the Building Studio
 * (shared-building-model 1.9). One source of truth for the small distances the
 * editor/rooms/mesh use, so they stay consistent and are easy to tune.
 *
 * PURE constants, no imports.
 */
export const BUILDING_TOLERANCES = {
  /** Endpoints closer than this are treated as the same node (m). */
  mergeM: 0.02,
  /** Room-loop endpoint snapping tolerance for face detection (m). */
  roomSnapM: 0.05,
  /** Default drawing grid step (m). */
  defaultGridM: 0.5,
  /** Pointer hit-test tolerance in screen pixels. */
  hitTestPx: 10,
} as const;
