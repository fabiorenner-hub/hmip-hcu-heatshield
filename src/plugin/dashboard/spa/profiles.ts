/**
 * Threshold presets for the four config profiles
 * (`conservative`, `standard`, `aggressive`, `custom`) — Task 12.3.
 *
 * The numbers below mirror the documented defaults from
 * `rolladen-hitzeschutz-regelwerk-dokumentation.md` §19 and
 * `design.md` (the corrected values), with two systematic offsets:
 *
 *   - **conservative**: shifts every comfort threshold down by
 *     ≈0.5 °C and every minimum-action interval up so the system
 *     reacts earlier and moves less often. Suitable for a household
 *     that prefers darker rooms over re-opens.
 *   - **standard**: matches the `ConfigSchema` defaults (regelwerk
 *     §19) one-for-one. Selecting this profile rewrites the `Rules`
 *     subtree to those values without any other side effect.
 *   - **aggressive**: shifts the comfort thresholds up by ≈0.5 °C
 *     and tightens the move-budget so the system reacts later and
 *     moves more often when it does. Suitable for a household that
 *     prefers daylight and is willing to accept slightly warmer
 *     rooms.
 *
 * The `custom` profile is *not* represented here — it preserves
 * whatever the user has already configured (`Rules` is rewritten
 * by the form sliders directly). The Rules tab only spreads a
 * preset over the `Rules` subtree when the user explicitly selects
 * one of the three named profiles.
 *
 * Field names match `RulesSchema` paths from `src/shared/schema.ts`
 * so the spreads below survive a future schema additions: any new
 * preset value propagates through `applyProfile` unchanged.
 */

import type { Rules } from '../../../shared/types.js';

export type ProfileName = 'conservative' | 'standard' | 'aggressive' | 'custom';

/**
 * Concrete numeric presets. Layout mirrors `RulesSchema`. We only
 * include the fields the slider panel actually exposes — the rest
 * fall back to whatever the user already has (or to schema
 * defaults the very first time around).
 */
export interface ProfilePreset {
  comfort: {
    maxIndoorTempC: number;
    preShadeTempC: number;
    vacationOffsetC: number;
    nightCoolingDeltaC: number;
  };
  automation: {
    controlIntervalSeconds: number;
    minSecondsBetweenMoves: number;
    minPositionDeltaPct: number;
  };
  sun: {
    minElevationDeg: number;
  };
  storm: {
    thresholdMs: number;
  };
  nightCooling: {
    deltaC: number;
  };
}

export const PROFILE_PRESETS: Record<Exclude<ProfileName, 'custom'>, ProfilePreset> = {
  // Conservative: 0.5 °C earlier, longer minimum gap, lower wind threshold.
  conservative: {
    comfort: {
      maxIndoorTempC: 24.5,
      preShadeTempC: 23.0,
      vacationOffsetC: 0.7,
      nightCoolingDeltaC: 1.0,
    },
    automation: {
      controlIntervalSeconds: 180,
      minSecondsBetweenMoves: 1200,
      minPositionDeltaPct: 12,
    },
    sun: {
      minElevationDeg: 4,
    },
    storm: {
      thresholdMs: 12.0,
    },
    nightCooling: {
      deltaC: 1.0,
    },
  },
  // Standard: identical to the ConfigSchema defaults.
  standard: {
    comfort: {
      maxIndoorTempC: 25.0,
      preShadeTempC: 23.5,
      vacationOffsetC: 0.5,
      nightCoolingDeltaC: 1.5,
    },
    automation: {
      controlIntervalSeconds: 180,
      minSecondsBetweenMoves: 900,
      minPositionDeltaPct: 15,
    },
    sun: {
      minElevationDeg: 5,
    },
    storm: {
      thresholdMs: 13.9,
    },
    nightCooling: {
      deltaC: 1.5,
    },
  },
  // Aggressive: 0.5 °C later, shorter minimum gap, higher wind threshold.
  aggressive: {
    comfort: {
      maxIndoorTempC: 25.5,
      preShadeTempC: 24.0,
      vacationOffsetC: 1.0,
      nightCoolingDeltaC: 2.0,
    },
    automation: {
      controlIntervalSeconds: 240,
      minSecondsBetweenMoves: 600,
      minPositionDeltaPct: 20,
    },
    sun: {
      minElevationDeg: 6,
    },
    storm: {
      thresholdMs: 15.0,
    },
    nightCooling: {
      deltaC: 2.0,
    },
  },
};

/**
 * Spread a named profile over an existing `Rules` object, returning
 * a new value. `custom` returns the input unchanged so the slider
 * panel never overwrites the user's hand-tuned values when they
 * pick `custom`.
 */
export function applyProfile(rules: Rules, profile: ProfileName): Rules {
  if (profile === 'custom') {
    return { ...rules, profile };
  }
  const preset = PROFILE_PRESETS[profile];
  return {
    ...rules,
    profile,
    comfort: {
      ...rules.comfort,
      maxIndoorTempC: preset.comfort.maxIndoorTempC,
      preShadeTempC: preset.comfort.preShadeTempC,
      vacationOffsetC: preset.comfort.vacationOffsetC,
      nightCoolingDeltaC: preset.comfort.nightCoolingDeltaC,
    },
    automation: {
      ...rules.automation,
      controlIntervalSeconds: preset.automation.controlIntervalSeconds,
      minSecondsBetweenMoves: preset.automation.minSecondsBetweenMoves,
      minPositionDeltaPct: preset.automation.minPositionDeltaPct,
    },
    sun: {
      ...rules.sun,
      minElevationDeg: preset.sun.minElevationDeg,
    },
    storm: {
      ...rules.storm,
      thresholdMs: preset.storm.thresholdMs,
    },
    nightCooling: {
      ...rules.nightCooling,
      deltaC: preset.nightCooling.deltaC,
    },
  };
}
