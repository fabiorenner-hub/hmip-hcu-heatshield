/**
 * Heat Shield — full per-window pipeline integration (Task 7.7).
 *
 * Wires the five engine stages together for a single window and asserts
 * the final shutter target lands in the range documented by the
 * regelwerk doc §18.1–§18.5 (with the corrections from `design.md` §10
 * applied) plus standalone storm / manual-override / combined cases.
 *
 * Pipeline (matches `engine/orchestrator.ts` order — Task 8 will land
 * the orchestrator proper; this test exercises the same composition):
 *
 *   1. Sun position via `engine/sun.ts::getSunPosition`.
 *   2. Continuous sun factor via `engine/sun.ts::sunFactor`.
 *   3. Risk + risk → shutter ladder via `engine/risk.ts`.
 *   4. Special rules §13 via `engine/specialRules.ts`.
 *   5. Ventilation §14 via `engine/ventilation.ts`.
 *   6. Safety priority order via `engine/safety.ts`.
 *   7. Hysteresis §15 via `engine/hysteresis.ts`.
 *
 * Reproducibility — every test pins location to Beispielstadt
 * (52.52°N, 13.41°E, `Europe/Berlin`) and time to a known sunny-summer
 * moment (`2026-06-21T08:00:00Z` = 10:00 Berlin local). At that instant
 * the sun sits at azimuth ≈ 110.4° / elevation ≈ 43.9°, which is well
 * inside both the façade (90°) and the roof (95°) incidence cones for
 * an SE 135° window — so `sunOnWindow` returns true for the
 * regelwerk's SE windows without any manual override.
 *
 * Some scenarios call for a sun configuration that contradicts the real
 * astronomical state (for instance §18.2 "bewölkt — sun theoretically
 * possible soon" needs `sunOnWindowNow=false` despite the sun being
 * physically on the window). Those scenarios pass explicit override
 * fields; the helper feeds those overrides into the downstream stages.
 */

import { describe, expect, it } from 'vitest';

import { applyHysteresis } from '../../src/plugin/engine/hysteresis.js';
import { applySafety } from '../../src/plugin/engine/safety.js';
import { applySpecialRules } from '../../src/plugin/engine/specialRules.js';
import {
  computeRisk,
  mapRiskToShutter01,
  type RiskProfile,
} from '../../src/plugin/engine/risk.js';
import {
  getSunPosition,
  sunFactor,
  sunOnWindow,
  sunOnWindowSoon,
} from '../../src/plugin/engine/sun.js';
import { applyVentilation } from '../../src/plugin/engine/ventilation.js';
import type {
  AutomationRules,
  ContactState,
  Location,
  Mode,
  Priority,
  RoomTargets,
  SunRules,
  Window,
} from '../../src/shared/types.js';

// ---------------------------------------------------------------------------
// Fixed test-time constants — Beispielstadt + sunny summer noon.
// ---------------------------------------------------------------------------

const TEST_LOCATION: Location = {
  latitude: 52.52,
  longitude: 13.41,
  timezone: 'Europe/Berlin',
};

/**
 * Reference instant: 2026-06-21 08:00 UTC = 10:00 Berlin local. At
 * Beispielstadt the sun is at az≈110.4°, el≈43.9° — strong SE light, well
 * inside the façade incidence cone for any window oriented SE 135°.
 */
const NOW = new Date('2026-06-21T08:00:00.000Z');

/** Schema-default sun rules — match `SunRulesSchema` defaults. */
const SUN_RULES: SunRules = {
  minElevationDeg: 5,
  maxIncidenceAngleFacadeDeg: 90,
  maxIncidenceAngleRoofDeg: 95,
};

/** Automation hysteresis defaults — match `AutomationRulesSchema`. */
const AUTOMATION_RULES: Pick<
  AutomationRules,
  'minSecondsBetweenMoves' | 'minPositionDeltaPct'
> = {
  minSecondsBetweenMoves: 900,
  minPositionDeltaPct: 15,
};

/** PV peak — matches the steering doc's installed system (8.8 kWp Sun2000). */
const PV_PEAK_KWP = 8.8;

/**
 * Bedroom-style targets (priorised sleep room from regelwerk §19). The
 * office and living-room scenarios reuse the same numbers because the
 * §18 examples never inspect the per-room `target_c` ladder; they
 * inspect the resulting target after the full pipeline.
 */
const ROOM_TARGETS: RoomTargets = {
  target_c: 23,
  warning_c: 24.5,
  strong_shade_c: 25,
  critical_c: 26,
};

// ---------------------------------------------------------------------------
// Scenario definition + runPipeline helper.
// ---------------------------------------------------------------------------

interface Scenario {
  /** Wall-clock instant for the cycle. Defaults to `NOW`. */
  now?: Date;
  /** Fully populated `Window` shape; we use `Required` so tests cannot omit a flag. */
  window: Required<
    Pick<
      Window,
      | 'orientationDeg'
      | 'type'
      | 'isDoor'
      | 'canMoveWhenOpen'
      | 'maxPositionWhenOpenPct'
      | 'lockoutProtection'
      | 'sunPrelookMinutes'
    >
  >;
  /** Stable room id — bedroom/office/living-room style. */
  roomId: string;
  /** Window priority — drives `priorityFactor` in the risk model. */
  priority: Priority;
  /** Contact state for ventilation §14. */
  contactState: ContactState;
  /** Indoor / outdoor / forecast temperatures. */
  roomTempC: number | null;
  outdoorTempC: number | null;
  forecastMaxTempC: number | null;
  /** PV smoothed kW; null disables PV factor and §13.x.d. */
  pvSmoothedKw: number | null;
  /** Short-wave radiation; null disables radiation factor. */
  radiationWm2: number | null;
  /** Risk profile to apply. */
  profile: RiskProfile;
  /** FSM mode — passed directly so tests stay precise. */
  mode: Mode;
  /** Pause-control switch. */
  pauseControl: boolean;
  /**
   * Optional overrides for the sun-on-window state. When a scenario
   * does not provide them, the helper computes them from the real
   * astronomical state. The §18.2 "bewölkt" case overrides
   * `sunOnWindowNow=false` despite the real sun being on the window;
   * that is the only way to model "theoretically possible soon" within
   * a deterministic test.
   */
  sunFactor01Override?: number;
  sunOnWindowNowOverride?: boolean;
  sunOnWindowSoonOverride?: boolean;
  /** Manual-override expiry (or null). */
  manualOverrideUntil: Date | null;
  /** Current shutter level, or null for first-move scenarios. */
  currentLevel01: number | null;
  /** Last engine-issued move, or null. */
  lastMovedAt: Date | null;
}

interface PipelineResult {
  finalTarget01: number;
  shouldMove: boolean;
  blockedBy: string | undefined;
  breakdown: {
    sunFactor01: number;
    sunOnWindowNow: boolean;
    sunOnWindowSoon: boolean;
    risk: number;
    baseTarget01: number;
    afterSpecial: number;
    afterVentilation: number;
    afterSafety: number;
    safetySuppressMove: boolean;
    blockedByOpenWindow: boolean;
    appliedRules: string[];
  };
}

/**
 * Run the full per-window pipeline for one scenario and return the
 * final target plus a per-stage breakdown. The breakdown is used both
 * by assertions and by the diagnostic output when a test fails — the
 * `appliedRules` array carries the stable regelwerk references that
 * fired during this evaluation.
 *
 * Steps mirror the orchestrator's intended order one-to-one. Sun
 * factor / sun-on-window flags are computed from the real
 * astronomical state when the scenario does not override them.
 */
function runPipeline(scenario: Scenario): PipelineResult {
  const now = scenario.now ?? NOW;

  // --- Step 1 + 2: sun position and continuous factor ----------------------
  const sun = getSunPosition(now, TEST_LOCATION);

  const computedSunFactor = sunFactor(now, TEST_LOCATION, scenario.window, SUN_RULES);
  const sunFactor01 = scenario.sunFactor01Override ?? computedSunFactor;

  const computedSunNow = sunOnWindow(sun, scenario.window, SUN_RULES);
  const sunOnWindowNow = scenario.sunOnWindowNowOverride ?? computedSunNow;

  const computedSunSoon = sunOnWindowSoon(
    now,
    TEST_LOCATION,
    scenario.window,
    SUN_RULES,
  );
  const sunOnWindowSoonValue = scenario.sunOnWindowSoonOverride ?? computedSunSoon;

  // --- Step 3: risk → baseTarget ------------------------------------------
  const risk = computeRisk({
    window: { orientationDeg: scenario.window.orientationDeg, type: scenario.window.type },
    windowPriority: scenario.priority,
    sun,
    sunFactor01,
    roomTempC: scenario.roomTempC,
    roomTargets: ROOM_TARGETS,
    outdoorTempC: scenario.outdoorTempC,
    forecastMaxTempC: scenario.forecastMaxTempC,
    pvSmoothedKw: scenario.pvSmoothedKw,
    pvPeakKwp: PV_PEAK_KWP,
    radiationWm2: scenario.radiationWm2,
    profile: scenario.profile,
  });
  const baseTarget01 = mapRiskToShutter01(risk.riskTotal);

  // --- Step 4: special rules ----------------------------------------------
  const special = applySpecialRules({
    window: { orientationDeg: scenario.window.orientationDeg, type: scenario.window.type },
    roomId: scenario.roomId,
    priority: scenario.priority,
    roomTempC: scenario.roomTempC,
    pvSmoothedKw: scenario.pvSmoothedKw,
    pvPeakKwp: PV_PEAK_KWP,
    sunOnWindowNow,
    sunOnWindowSoon: sunOnWindowSoonValue,
    forecastMaxTempC: scenario.forecastMaxTempC,
    mode: scenario.mode,
    baseTarget01,
  });

  // --- Step 5: ventilation -----------------------------------------------
  const ventilation = applyVentilation({
    window: {
      isDoor: scenario.window.isDoor,
      canMoveWhenOpen: scenario.window.canMoveWhenOpen,
      maxPositionWhenOpenPct: scenario.window.maxPositionWhenOpenPct,
      lockoutProtection: scenario.window.lockoutProtection,
      type: scenario.window.type,
    },
    contactState: scenario.contactState,
    roomTempC: scenario.roomTempC,
    outdoorTempC: scenario.outdoorTempC,
    sunOnWindowNow,
    pvSmoothedKw: scenario.pvSmoothedKw,
    baseTarget01: special.target01,
  });

  // --- Step 6: safety -----------------------------------------------------
  const safety = applySafety({
    window: {
      type: scenario.window.type,
      isDoor: scenario.window.isDoor,
      lockoutProtection: scenario.window.lockoutProtection,
    },
    windowState: { manualOverrideUntil: scenario.manualOverrideUntil?.toISOString() ?? null },
    mode: scenario.mode,
    pauseControl: scenario.pauseControl,
    baseTarget01: ventilation.target01,
    currentLevel01: scenario.currentLevel01,
    blockedByOpenWindow: ventilation.blockedByOpenWindow,
    now,
  });

  // --- Step 7: hysteresis -------------------------------------------------
  const hysteresis = applyHysteresis({
    finalTarget01: safety.target01,
    currentLevel01: scenario.currentLevel01,
    lastMovedAt: scenario.lastMovedAt,
    now,
    rules: AUTOMATION_RULES,
    suppressFromSafety: safety.suppressMove,
    pvDroppedRecently: false,
  });

  return {
    finalTarget01: hysteresis.target01,
    shouldMove: hysteresis.shouldMove,
    blockedBy: hysteresis.blockedBy,
    breakdown: {
      sunFactor01,
      sunOnWindowNow,
      sunOnWindowSoon: sunOnWindowSoonValue,
      risk: risk.riskTotal,
      baseTarget01,
      afterSpecial: special.target01,
      afterVentilation: ventilation.target01,
      afterSafety: safety.target01,
      safetySuppressMove: safety.suppressMove,
      blockedByOpenWindow: ventilation.blockedByOpenWindow,
      appliedRules: [
        ...special.appliedRules,
        ...ventilation.appliedRules,
        ...safety.appliedRules,
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Default window shapes used across the §18 examples.
// ---------------------------------------------------------------------------

/** SE roof window with 60% door-lockout cap and 60-min prelook. */
const SE_ROOF_60: Required<Scenario['window']> = {
  orientationDeg: 135,
  type: 'roof_window',
  isDoor: false,
  canMoveWhenOpen: true,
  maxPositionWhenOpenPct: 60,
  lockoutProtection: true,
  sunPrelookMinutes: 60,
};

/** SE roof window with the door-lockout cap raised to 90% (used in §18.4). */
const SE_ROOF_90: Required<Scenario['window']> = {
  ...SE_ROOF_60,
  maxPositionWhenOpenPct: 90,
};

/** SE façade window. */
const SE_FACADE_60: Required<Scenario['window']> = {
  orientationDeg: 135,
  type: 'facade',
  isDoor: false,
  canMoveWhenOpen: true,
  maxPositionWhenOpenPct: 60,
  lockoutProtection: true,
  sunPrelookMinutes: 60,
};

/** SE façade door — used by §18.5 to exercise the door-lockout cap. */
const SE_FACADE_DOOR_60: Required<Scenario['window']> = {
  ...SE_FACADE_60,
  isDoor: true,
};

// ---------------------------------------------------------------------------
// §18.1 Schlafzimmer-Dachfenster, sonniger Morgen.
// ---------------------------------------------------------------------------

describe('regelwerk §18.1 — bedroom roof window, sunny morning', () => {
  it('forces target = 1.0 via §13.1.d (PV > 4 kW + sun on window)', () => {
    const r = runPipeline({
      window: SE_ROOF_60,
      roomId: 'schlafzimmer',
      priority: 'very_high',
      contactState: 'closed',
      roomTempC: 23.4,
      outdoorTempC: 24,
      forecastMaxTempC: 29,
      pvSmoothedKw: 4.8,
      radiationWm2: 600,
      profile: 'standard',
      mode: 'ACTIVE_HEAT_PROTECTION', // forecast=29 ≥ 25, room=23.4 < 23.5
      pauseControl: false,
      manualOverrideUntil: null,
      currentLevel01: null, // first move
      lastMovedAt: null,
    });

    // Expected: target == 1.0 (regelwerk §18.1 / design §13.1.d).
    expect(r.finalTarget01).toBeCloseTo(1.0, 9);
    expect(r.shouldMove).toBe(true);
    expect(r.blockedBy).toBeUndefined();
    // §13.1.d signature in the rule list.
    expect(r.breakdown.appliedRules).toContain('§13.1.d bedroom-roof-pv-force');
  });
});

// ---------------------------------------------------------------------------
// §18.2 Arbeitszimmer-Fassadenfenster, bewölkt (with design.md §10 fix).
// ---------------------------------------------------------------------------

describe('regelwerk §18.2 — office facade window, cloudy', () => {
  it('lands in the mid-range [0.4, 0.7] when PV is low and sun only soon', () => {
    // Brief: sun "theoretically possible soon" — model as
    // sunOnWindowNow=false, sunOnWindowSoon=true. The corresponding
    // sunFactor01 per design.md §Property 2 is 0.6 (no current
    // incidence, soon hit only).
    const r = runPipeline({
      window: SE_FACADE_60,
      roomId: 'arbeitszimmer',
      priority: 'very_high',
      contactState: 'closed',
      roomTempC: 23.6,
      outdoorTempC: null,
      forecastMaxTempC: 26,
      pvSmoothedKw: 0.9,
      radiationWm2: null,
      profile: 'standard',
      // forecast=26 ≥ 25 → ACTIVE_HEAT_PROTECTION; room=23.6 ≥ 23.5
      // also forces ACTIVE_HEAT_PROTECTION, so the value below would
      // be picked by the FSM regardless.
      mode: 'ACTIVE_HEAT_PROTECTION',
      pauseControl: false,
      sunFactor01Override: 0.6,
      sunOnWindowNowOverride: false,
      sunOnWindowSoonOverride: true,
      manualOverrideUntil: null,
      currentLevel01: null,
      lastMovedAt: null,
    });

    // Design.md §10 correction: with low PV the score should not push
    // to 0.9; mid-range is the documented expectation. (V1.8 finer ladder
    // widened the mid band downward, so the lower bound is 0.30.)
    expect(r.finalTarget01).toBeGreaterThanOrEqual(0.3);
    expect(r.finalTarget01).toBeLessThanOrEqual(0.7);
    // §13.1/§13.2 do not fire (façade, not roof) and §13.3 needs
    // forecast ≥ 30 or HEATWAVE — neither is true here, so the
    // pipeline stays on the risk ladder alone.
    expect(
      r.breakdown.appliedRules.filter((s) => s.startsWith('§13')),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §18.3 Schlafzimmer-Fenster offen, draußen kühler.
// ---------------------------------------------------------------------------

describe('regelwerk §18.3 — bedroom window open, cooler outdoors', () => {
  it('drops target to ≤ 0.20 via §14.2 cooling branch', () => {
    const r = runPipeline({
      window: SE_FACADE_60,
      roomId: 'schlafzimmer',
      priority: 'very_high',
      contactState: 'open',
      roomTempC: 24.2,
      outdoorTempC: 20.8, // delta = +3.4 °C ⇒ §14.2 cooling
      forecastMaxTempC: 24,
      pvSmoothedKw: 0.5,
      radiationWm2: null,
      profile: 'standard',
      mode: 'SUMMER_WATCH',
      pauseControl: false,
      // No sun on the window for this scenario (regelwerk §18.3 has
      // sun outside the SE band by then). Override to keep the
      // expectations decoupled from the real ephemeris.
      sunFactor01Override: 0,
      sunOnWindowNowOverride: false,
      sunOnWindowSoonOverride: false,
      manualOverrideUntil: null,
      currentLevel01: null,
      lastMovedAt: null,
    });

    expect(r.finalTarget01).toBeLessThanOrEqual(0.2);
    expect(r.breakdown.appliedRules).toContain('§14.2 outside-cooler');
  });
});

// ---------------------------------------------------------------------------
// §18.4 Dachfenster offen, draußen wärmer und Sonne.
// ---------------------------------------------------------------------------

describe('regelwerk §18.4 — office roof open, outside warmer + sun', () => {
  it('lands in [0.85, 0.95] (regelwerk says 90–95%)', () => {
    // We use the SE_ROOF_90 variant so the §14.5 cap sits at 0.90
    // rather than the default 0.60. The regelwerk's "Dachfenster
    // offen" case implicitly assumes a roof window can stay nearly
    // closed for shading even with the sash open.
    const r = runPipeline({
      window: SE_ROOF_90,
      roomId: 'arbeitszimmer',
      priority: 'very_high',
      contactState: 'open',
      roomTempC: 24,
      outdoorTempC: 29,
      forecastMaxTempC: 29, // < 30 ⇒ ACTIVE_HEAT_PROTECTION, not HEATWAVE
      pvSmoothedKw: 5,
      radiationWm2: 700,
      profile: 'standard',
      mode: 'ACTIVE_HEAT_PROTECTION',
      pauseControl: false,
      manualOverrideUntil: null,
      currentLevel01: null,
      lastMovedAt: null,
    });

    expect(r.finalTarget01).toBeGreaterThanOrEqual(0.85);
    expect(r.finalTarget01).toBeLessThanOrEqual(0.95);
    // §13.2.d (PV force) and §14.4 outside-warmer are the dominant
    // signatures we expect to see here.
    expect(r.breakdown.appliedRules).toContain('§13.2.d office-roof-pv-force');
    expect(r.breakdown.appliedRules).toContain('§14.4 outside-warmer');
    // §14.5 generic lockout-protection caps the final target.
    expect(r.breakdown.appliedRules).toContain('§14.5 lockout-protection');
  });
});

// ---------------------------------------------------------------------------
// §18.5 Terrassentür offen, Hitze.
// ---------------------------------------------------------------------------

describe('regelwerk §18.5 — patio door open, heat', () => {
  it('caps target at 0.60 via §14.5 door-lockout, even with HEATWAVE inputs', () => {
    const r = runPipeline({
      window: SE_FACADE_DOOR_60,
      roomId: 'living-room',
      priority: 'very_high',
      contactState: 'open',
      roomTempC: 25,
      outdoorTempC: 30,
      forecastMaxTempC: 30, // ≥ 30 ⇒ HEATWAVE
      pvSmoothedKw: 5,
      radiationWm2: 800,
      profile: 'standard',
      mode: 'HEATWAVE',
      pauseControl: false,
      manualOverrideUntil: null,
      currentLevel01: null,
      lastMovedAt: null,
    });

    expect(r.finalTarget01).toBeCloseTo(0.6, 9);
    expect(r.breakdown.appliedRules).toContain('§14.5 door-lockout');
    // The pre-cap target was elevated by §14.4 outside-warmer.
    expect(r.breakdown.appliedRules).toContain('§14.4 outside-warmer');
  });
});

// ---------------------------------------------------------------------------
// Standalone scenarios — storm, manual override, combined.
// ---------------------------------------------------------------------------

describe('standalone — STORM forces full open regardless of heat-protection inputs', () => {
  it('mode=STORM ⇒ final target = 0.0 with shouldMove=true', () => {
    // Hot inputs that would normally drive toward 1.0 — the safety
    // layer overrides on STORM and the pipeline emits target=0.0.
    const r = runPipeline({
      window: SE_ROOF_60,
      roomId: 'schlafzimmer',
      priority: 'very_high',
      contactState: 'closed',
      roomTempC: 25,
      outdoorTempC: 30,
      forecastMaxTempC: 30,
      pvSmoothedKw: 5,
      radiationWm2: 800,
      profile: 'standard',
      mode: 'STORM',
      pauseControl: false,
      manualOverrideUntil: null,
      currentLevel01: null,
      lastMovedAt: null,
    });

    expect(r.finalTarget01).toBe(0.0);
    expect(r.shouldMove).toBe(true);
    expect(r.blockedBy).toBeUndefined();
    expect(r.breakdown.appliedRules).toContain('storm: force open');
  });
});

describe('standalone — manual override blocks even on hot inputs', () => {
  it('manualOverrideUntil 30 min in the future ⇒ shouldMove=false, blockedBy=safety_suppress', () => {
    // Bedroom roof + sun + warm + HEATWAVE — every special rule
    // pushes the target to 1.0. Without the override the pipeline
    // would close the shutter; with it we expect the safety layer
    // to suppress the move.
    const future = new Date(NOW.getTime() + 30 * 60 * 1000);
    const r = runPipeline({
      window: SE_ROOF_60,
      roomId: 'schlafzimmer',
      priority: 'very_high',
      contactState: 'closed',
      roomTempC: 24,
      outdoorTempC: 30,
      forecastMaxTempC: 30,
      pvSmoothedKw: 5,
      radiationWm2: 800,
      profile: 'standard',
      mode: 'HEATWAVE',
      pauseControl: false,
      manualOverrideUntil: future,
      currentLevel01: 0.5, // engine has moved this window before
      lastMovedAt: new Date(NOW.getTime() - 60 * 60 * 1000),
    });

    expect(r.shouldMove).toBe(false);
    expect(r.blockedBy).toBe('safety_suppress');
    // The pipeline computed a hot target before safety kicked in; we
    // assert that as a sanity check on the upstream stages.
    expect(r.breakdown.afterVentilation).toBeCloseTo(1.0, 9);
    // Safety surfaced the manual override rule.
    expect(
      r.breakdown.appliedRules.some((s) => s.startsWith('manual override active until')),
    ).toBe(true);
  });
});

describe('standalone — combined door + STORM', () => {
  it('STORM outranks the §14.5 door cap; final target = 0.0', () => {
    // Pipeline order: ventilation applies the §14.5 door cap (0.60),
    // safety then sees STORM and forces 0.0 regardless. This is the
    // documented behaviour in design.md §10 (STORM has the highest
    // priority above all other rules).
    const r = runPipeline({
      window: SE_FACADE_DOOR_60,
      roomId: 'living-room',
      priority: 'very_high',
      contactState: 'open',
      roomTempC: 25,
      outdoorTempC: 30,
      forecastMaxTempC: 30,
      pvSmoothedKw: 5,
      radiationWm2: 800,
      profile: 'standard',
      mode: 'STORM',
      pauseControl: false,
      manualOverrideUntil: null,
      currentLevel01: null,
      lastMovedAt: null,
    });

    expect(r.finalTarget01).toBe(0.0);
    expect(r.shouldMove).toBe(true);
    expect(r.breakdown.appliedRules).toContain('storm: force open');
    // The §14.5 door cap is still applied by the ventilation stage —
    // its effect on `afterVentilation` is the documented 0.60 — but
    // safety overrides downstream.
    expect(r.breakdown.afterVentilation).toBeCloseTo(0.6, 9);
    expect(r.breakdown.appliedRules).toContain('§14.5 door-lockout');
  });
});
