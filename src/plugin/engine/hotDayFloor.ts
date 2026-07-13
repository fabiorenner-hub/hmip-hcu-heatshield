/**
 * Heat Shield — hot-day minimum-shade floor (pure).
 *
 * On very hot, sunny days the plugin keeps a baseline of shading so a room does
 * not bake. The user can configure this either as a single legacy stage
 * (`outdoorThresholdC` + `maxOpenPercent`) or, preferably, as a freely
 * configurable multi-stage ramp (`stages`): each stage says "at/above this
 * outdoor temperature, hold at least this much shading". Example the feature was
 * built for: `{30 °C → 30 %}`, `{35 °C → 50 %}`.
 *
 * This module contains only the pure decision (temperature → shading percent).
 * The gating (enabled, mode ≠ STORM/NIGHT_COOLING, PV power present) and the
 * application to the shutter target live in the orchestrator.
 */

/** Minimal shape of one stage this module needs. */
export interface HotDayStageLike {
  readonly outdoorThresholdC: number;
  /** Minimum shading (closed fraction) in percent, 0..100. */
  readonly shadingPercent: number;
}

/** Minimal shape of the hot-day rules this module needs. */
export interface HotDayRulesLike {
  readonly outdoorThresholdC: number;
  readonly maxOpenPercent: number;
  readonly stages?: ReadonlyArray<HotDayStageLike> | undefined;
}

function clampPercent(p: number): number {
  if (!Number.isFinite(p)) return 0;
  return Math.max(0, Math.min(100, Math.round(p)));
}

/**
 * Effective minimum shading percent (0 = no floor … 100 = fully closed) for a
 * given outdoor temperature, or `null` when the hot-day floor does not apply at
 * that temperature.
 *
 * Multi-stage (`stages` present and non-empty): pick the stage with the HIGHEST
 * `outdoorThresholdC` that the temperature has reached; its `shadingPercent` is
 * the floor. If the temperature has not reached any stage → `null`.
 *
 * Legacy single-stage fallback: at/above `outdoorThresholdC` the floor is
 * `100 − maxOpenPercent`; below it → `null`.
 */
export function hotDayShadingPercent(
  hotDay: HotDayRulesLike,
  outdoorTempC: number,
): number | null {
  if (!Number.isFinite(outdoorTempC)) return null;

  const stages = hotDay.stages;
  if (stages !== undefined && stages.length > 0) {
    let best: HotDayStageLike | null = null;
    for (const s of stages) {
      if (outdoorTempC >= s.outdoorThresholdC) {
        if (best === null || s.outdoorThresholdC > best.outdoorThresholdC) {
          best = s;
        }
      }
    }
    return best === null ? null : clampPercent(best.shadingPercent);
  }

  if (outdoorTempC >= hotDay.outdoorThresholdC) {
    return clampPercent(100 - hotDay.maxOpenPercent);
  }
  return null;
}
