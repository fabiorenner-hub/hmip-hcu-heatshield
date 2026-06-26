/**
 * Tests for the safety gate in `src/plugin/engine/safety.ts`
 * (Task 7.5, design.md §Property 6).
 *
 * Coverage:
 *   - STORM forces target=0.0 with no suppression.
 *   - STORM beats every later branch (manual override, maintenance, pause,
 *     blockedByOpenWindow).
 *   - MAINTENANCE: hold position, suppress.
 *   - pauseControl: hold position, suppress.
 *   - blockedByOpenWindow (§14.6): hold position, suppress.
 *   - manualOverrideUntil in the future: hold, suppress, rule includes ISO.
 *   - manualOverrideUntil in the past: ignored, target=baseTarget, no suppress.
 *   - No safety triggers: baseTarget passes through, empty rules.
 *   - currentLevel01=null + maintenance: suppressMove=true but target=baseTarget.
 *
 * Style mirrors `engine-ventilation.test.ts`: no fixtures, no mocking.
 * Inputs are constructed inline via a small `mkInputs` helper so each
 * test reads as a single self-contained scenario.
 */

import { describe, expect, it } from 'vitest';

import { applySafety, type SafetyInputs } from '../../src/plugin/engine/safety.js';

// ---------------------------------------------------------------------------
// mkInputs — benign defaults: NORMAL mode, no pause, no override, closed window.
// ---------------------------------------------------------------------------

const NOW = new Date('2025-07-15T12:00:00Z');

function mkInputs(overrides: Partial<SafetyInputs> = {}): SafetyInputs {
  return {
    window: {
      type: 'facade',
      isDoor: false,
      lockoutProtection: true,
    },
    windowState: {
      manualOverrideUntil: null,
    },
    mode: 'NORMAL',
    pauseControl: false,
    baseTarget01: 0.6,
    currentLevel01: 0.5,
    blockedByOpenWindow: false,
    now: NOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// STORM.
// ---------------------------------------------------------------------------

describe('applySafety — STORM', () => {
  it('forces target=0.0 (fully open) with suppressMove=false', () => {
    const r = applySafety(
      mkInputs({
        mode: 'STORM',
        baseTarget01: 1.0,
        currentLevel01: 0.5,
      }),
    );
    expect(r.target01).toBe(0.0);
    expect(r.suppressMove).toBe(false);
    expect(r.appliedRules).toEqual(['storm: force open']);
  });

  it('STORM beats manual override', () => {
    const future = new Date(NOW.getTime() + 5 * 60 * 1000);
    const r = applySafety(
      mkInputs({
        mode: 'STORM',
        baseTarget01: 0.9,
        currentLevel01: 0.4,
        windowState: { manualOverrideUntil: future.toISOString() },
      }),
    );
    expect(r.target01).toBe(0.0);
    expect(r.suppressMove).toBe(false);
    expect(r.appliedRules).toEqual(['storm: force open']);
  });

  it('STORM beats MAINTENANCE precedence (mode=STORM wins, even though that combo is unreachable in practice)', () => {
    // determineMode never returns both STORM and MAINTENANCE, but the
    // safety gate still must order STORM first defensively.
    const r = applySafety(
      mkInputs({
        mode: 'STORM',
        pauseControl: true,
        blockedByOpenWindow: true,
        baseTarget01: 0.8,
        currentLevel01: 0.3,
      }),
    );
    expect(r.target01).toBe(0.0);
    expect(r.suppressMove).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// MAINTENANCE.
// ---------------------------------------------------------------------------

describe('applySafety — MAINTENANCE', () => {
  it('holds current position and suppresses move', () => {
    const r = applySafety(
      mkInputs({
        mode: 'MAINTENANCE',
        baseTarget01: 0.7,
        currentLevel01: 0.4,
      }),
    );
    expect(r.target01).toBe(0.4);
    expect(r.suppressMove).toBe(true);
    expect(r.appliedRules).toEqual(['maintenance: hold position']);
  });

  it('currentLevel01=null + MAINTENANCE → suppress=true but target=baseTarget (first-cycle fallback)', () => {
    const r = applySafety(
      mkInputs({
        mode: 'MAINTENANCE',
        baseTarget01: 0.7,
        currentLevel01: null,
      }),
    );
    expect(r.target01).toBe(0.7);
    expect(r.suppressMove).toBe(true);
    expect(r.appliedRules).toEqual(['maintenance: hold position']);
  });
});

// ---------------------------------------------------------------------------
// pauseControl.
// ---------------------------------------------------------------------------

describe('applySafety — pauseControl', () => {
  it('pauseControl=true holds current and suppresses', () => {
    const r = applySafety(
      mkInputs({
        pauseControl: true,
        baseTarget01: 0.8,
        currentLevel01: 0.2,
      }),
    );
    expect(r.target01).toBe(0.2);
    expect(r.suppressMove).toBe(true);
    expect(r.appliedRules).toEqual(['pause: hold position']);
  });
});

// ---------------------------------------------------------------------------
// §14.6 blockedByOpenWindow.
// ---------------------------------------------------------------------------

describe('applySafety — blockedByOpenWindow', () => {
  it('blockedByOpenWindow=true holds current and suppresses', () => {
    const r = applySafety(
      mkInputs({
        blockedByOpenWindow: true,
        baseTarget01: 0.9,
        currentLevel01: 0.55,
      }),
    );
    expect(r.target01).toBe(0.55);
    expect(r.suppressMove).toBe(true);
    expect(r.appliedRules).toEqual(['§14.6 cannot-move-when-open: hold position']);
  });
});

// ---------------------------------------------------------------------------
// Manual override.
// ---------------------------------------------------------------------------

describe('applySafety — manualOverrideUntil', () => {
  it('5min in the future → hold current, suppress, rule includes ISO timestamp', () => {
    const future = new Date(NOW.getTime() + 5 * 60 * 1000);
    const r = applySafety(
      mkInputs({
        baseTarget01: 0.9,
        currentLevel01: 0.3,
        windowState: { manualOverrideUntil: future.toISOString() },
      }),
    );
    expect(r.target01).toBe(0.3);
    expect(r.suppressMove).toBe(true);
    expect(r.appliedRules).toHaveLength(1);
    expect(r.appliedRules[0]).toContain('manual override active until');
    expect(r.appliedRules[0]).toContain(future.toISOString());
  });

  it('5min in the past → expired, baseTarget passes through', () => {
    const past = new Date(NOW.getTime() - 5 * 60 * 1000);
    const r = applySafety(
      mkInputs({
        baseTarget01: 0.6,
        currentLevel01: 0.3,
        windowState: { manualOverrideUntil: past.toISOString() },
      }),
    );
    expect(r.target01).toBe(0.6);
    expect(r.suppressMove).toBe(false);
    expect(r.appliedRules).toEqual([]);
  });

  it('windowState=null (first-time window) → no manual-override branch', () => {
    const r = applySafety(
      mkInputs({
        baseTarget01: 0.6,
        currentLevel01: 0.3,
        windowState: null,
      }),
    );
    expect(r.target01).toBe(0.6);
    expect(r.suppressMove).toBe(false);
    expect(r.appliedRules).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// No-safety fallthrough.
// ---------------------------------------------------------------------------

describe('applySafety — no safety triggers', () => {
  it('NORMAL mode, no pause, no override → baseTarget passes through, empty rules', () => {
    const r = applySafety(
      mkInputs({
        mode: 'NORMAL',
        baseTarget01: 0.42,
        currentLevel01: 0.1,
      }),
    );
    expect(r.target01).toBe(0.42);
    expect(r.suppressMove).toBe(false);
    expect(r.appliedRules).toEqual([]);
  });

  it('HEATWAVE mode (heat-protection upstream) → safety does not interfere', () => {
    const r = applySafety(
      mkInputs({
        mode: 'HEATWAVE',
        baseTarget01: 0.85,
        currentLevel01: 0.7,
      }),
    );
    expect(r.target01).toBe(0.85);
    expect(r.suppressMove).toBe(false);
    expect(r.appliedRules).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Precedence between non-STORM hold branches.
// ---------------------------------------------------------------------------

describe('applySafety — precedence ordering', () => {
  it('MAINTENANCE outranks pauseControl + blockedByOpenWindow + manual override', () => {
    const future = new Date(NOW.getTime() + 5 * 60 * 1000);
    const r = applySafety(
      mkInputs({
        mode: 'MAINTENANCE',
        pauseControl: true,
        blockedByOpenWindow: true,
        windowState: { manualOverrideUntil: future.toISOString() },
        baseTarget01: 0.7,
        currentLevel01: 0.4,
      }),
    );
    expect(r.appliedRules).toEqual(['maintenance: hold position']);
    expect(r.suppressMove).toBe(true);
  });

  it('pauseControl outranks blockedByOpenWindow + manual override', () => {
    const future = new Date(NOW.getTime() + 5 * 60 * 1000);
    const r = applySafety(
      mkInputs({
        pauseControl: true,
        blockedByOpenWindow: true,
        windowState: { manualOverrideUntil: future.toISOString() },
        currentLevel01: 0.4,
      }),
    );
    expect(r.appliedRules).toEqual(['pause: hold position']);
  });

  it('blockedByOpenWindow outranks manual override', () => {
    const future = new Date(NOW.getTime() + 5 * 60 * 1000);
    const r = applySafety(
      mkInputs({
        blockedByOpenWindow: true,
        windowState: { manualOverrideUntil: future.toISOString() },
        currentLevel01: 0.4,
      }),
    );
    expect(r.appliedRules).toEqual(['§14.6 cannot-move-when-open: hold position']);
  });
});
