/**
 * Tests for the hysteresis gate in `src/plugin/engine/hysteresis.ts`
 * (Task 7.6, Regelwerk §15).
 *
 * Coverage:
 *   - safety_suppress pass-through.
 *   - First move (currentLevel01 === null) bypasses every check.
 *   - §15.2 min position delta — boundary at 15 pp (inclusive ⇒ move).
 *   - §15.1 min seconds between moves — boundary at threshold.
 *   - §15.5 PV / cloud smoothing — opening blocked, closing allowed.
 *   - Branch ordering: safety → no_change → min_seconds → pv_cloud → move.
 *
 * Style mirrors `engine-safety.test.ts`: no fixtures, no mocking.
 * Inputs are constructed inline via a small `mkInputs` helper so each
 * test reads as a single self-contained scenario.
 */

import { describe, expect, it } from 'vitest';

import { applyHysteresis, type HysteresisInputs } from '../../src/plugin/engine/hysteresis.js';

// ---------------------------------------------------------------------------
// mkInputs — benign defaults: target above current (closing), 30 min ago,
// 15 pp threshold, 900 s threshold, no safety, no PV blip.
// ---------------------------------------------------------------------------

const NOW = new Date('2025-07-15T12:00:00Z');
const THIRTY_MIN_AGO = new Date(NOW.getTime() - 30 * 60 * 1000);

function mkInputs(overrides: Partial<HysteresisInputs> = {}): HysteresisInputs {
  return {
    finalTarget01: 0.9,
    currentLevel01: 0.3,
    lastMovedAt: THIRTY_MIN_AGO,
    now: NOW,
    rules: {
      minSecondsBetweenMoves: 900,
      minPositionDeltaPct: 15,
    },
    suppressFromSafety: false,
    pvDroppedRecently: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// safety_suppress.
// ---------------------------------------------------------------------------

describe('applyHysteresis — safety_suppress', () => {
  it('suppressFromSafety=true → no move regardless of other inputs', () => {
    const r = applyHysteresis(
      mkInputs({
        suppressFromSafety: true,
        // Everything else would have allowed the move.
        finalTarget01: 0.95,
        currentLevel01: 0.1,
        lastMovedAt: null,
      }),
    );
    expect(r.shouldMove).toBe(false);
    expect(r.blockedBy).toBe('safety_suppress');
    expect(r.target01).toBe(0.95);
  });

  it('safety_suppress beats min_seconds, no_change, and pv_cloud', () => {
    // All four conditions present at once: safety wins.
    const recent = new Date(NOW.getTime() - 5 * 60 * 1000);
    const r = applyHysteresis(
      mkInputs({
        suppressFromSafety: true,
        finalTarget01: 0.31, // delta 1 pp, would be no_change
        currentLevel01: 0.3,
        lastMovedAt: recent, // 5 min < 15 min, would be min_seconds
        pvDroppedRecently: true, // would be pv_cloud
      }),
    );
    expect(r.blockedBy).toBe('safety_suppress');
  });
});

// ---------------------------------------------------------------------------
// First move.
// ---------------------------------------------------------------------------

describe('applyHysteresis — first move', () => {
  it('currentLevel01=null → moves regardless of delta or timing', () => {
    const r = applyHysteresis(
      mkInputs({
        currentLevel01: null,
        finalTarget01: 0.42,
        lastMovedAt: null,
      }),
    );
    expect(r.shouldMove).toBe(true);
    expect(r.blockedBy).toBeUndefined();
    expect(r.target01).toBe(0.42);
  });

  it('currentLevel01=null with recent lastMovedAt is still allowed (defensive)', () => {
    // Should be unreachable in practice, but the null check comes first
    // so a torn state file does not stick the shutter forever.
    const recent = new Date(NOW.getTime() - 30 * 1000);
    const r = applyHysteresis(
      mkInputs({
        currentLevel01: null,
        lastMovedAt: recent,
      }),
    );
    expect(r.shouldMove).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §15.2 min position delta.
// ---------------------------------------------------------------------------

describe('applyHysteresis — min position delta', () => {
  it('delta=5pp, threshold=15pp → blocked (no_change)', () => {
    const r = applyHysteresis(
      mkInputs({
        finalTarget01: 0.35,
        currentLevel01: 0.3, // delta = 5 pp
        rules: { minSecondsBetweenMoves: 900, minPositionDeltaPct: 15 },
      }),
    );
    expect(r.shouldMove).toBe(false);
    expect(r.blockedBy).toBe('no_change');
    expect(r.target01).toBe(0.35);
  });

  it('delta=16pp, threshold=15pp → moves', () => {
    const r = applyHysteresis(
      mkInputs({
        finalTarget01: 0.46,
        currentLevel01: 0.3, // delta = 16 pp
        rules: { minSecondsBetweenMoves: 900, minPositionDeltaPct: 15 },
      }),
    );
    expect(r.shouldMove).toBe(true);
    expect(r.blockedBy).toBeUndefined();
    expect(r.target01).toBe(0.46);
  });

  it('delta=15pp exactly, threshold=15pp → moves (inclusive boundary)', () => {
    const r = applyHysteresis(
      mkInputs({
        finalTarget01: 0.45,
        currentLevel01: 0.3, // delta = 15 pp exactly
        rules: { minSecondsBetweenMoves: 900, minPositionDeltaPct: 15 },
      }),
    );
    expect(r.shouldMove).toBe(true);
    expect(r.blockedBy).toBeUndefined();
  });

  it('delta=0 (target equals current) → blocked (no_change)', () => {
    const r = applyHysteresis(
      mkInputs({
        finalTarget01: 0.5,
        currentLevel01: 0.5,
      }),
    );
    expect(r.shouldMove).toBe(false);
    expect(r.blockedBy).toBe('no_change');
  });
});

// ---------------------------------------------------------------------------
// §15.1 min seconds between moves.
// ---------------------------------------------------------------------------

describe('applyHysteresis — min seconds between moves', () => {
  it('lastMoved 5min ago, threshold=900s (15min) → blocked (min_seconds)', () => {
    const recent = new Date(NOW.getTime() - 5 * 60 * 1000);
    const r = applyHysteresis(
      mkInputs({
        lastMovedAt: recent,
        rules: { minSecondsBetweenMoves: 900, minPositionDeltaPct: 15 },
      }),
    );
    expect(r.shouldMove).toBe(false);
    expect(r.blockedBy).toBe('min_seconds');
    expect(r.target01).toBe(0.9);
  });

  it('lastMoved 16min ago, threshold=900s → moves', () => {
    const past = new Date(NOW.getTime() - 16 * 60 * 1000);
    const r = applyHysteresis(
      mkInputs({
        lastMovedAt: past,
      }),
    );
    expect(r.shouldMove).toBe(true);
    expect(r.blockedBy).toBeUndefined();
  });

  it('lastMovedAt=null + delta sufficient → moves (no debounce window)', () => {
    const r = applyHysteresis(
      mkInputs({
        lastMovedAt: null,
        finalTarget01: 0.9,
        currentLevel01: 0.3,
      }),
    );
    expect(r.shouldMove).toBe(true);
  });

  it('lastMoved exactly at threshold (900s ago) → moves (inclusive boundary)', () => {
    const exactly = new Date(NOW.getTime() - 900 * 1000);
    const r = applyHysteresis(
      mkInputs({
        lastMovedAt: exactly,
      }),
    );
    expect(r.shouldMove).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §15.5 PV / cloud smoothing.
// ---------------------------------------------------------------------------

describe('applyHysteresis — pv_cloud smoothing', () => {
  it('opening (target=0.3, current=0.9) + pvDroppedRecently=true → blocked (pv_cloud), target=current', () => {
    const r = applyHysteresis(
      mkInputs({
        finalTarget01: 0.3,
        currentLevel01: 0.9,
        pvDroppedRecently: true,
      }),
    );
    expect(r.shouldMove).toBe(false);
    expect(r.blockedBy).toBe('pv_cloud');
    expect(r.target01).toBe(0.9);
  });

  it('closing (target=0.9, current=0.3) + pvDroppedRecently=true → moves anyway', () => {
    const r = applyHysteresis(
      mkInputs({
        finalTarget01: 0.9,
        currentLevel01: 0.3,
        pvDroppedRecently: true,
      }),
    );
    expect(r.shouldMove).toBe(true);
    expect(r.blockedBy).toBeUndefined();
    expect(r.target01).toBe(0.9);
  });

  it('opening + pvDroppedRecently=false → moves', () => {
    const r = applyHysteresis(
      mkInputs({
        finalTarget01: 0.3,
        currentLevel01: 0.9,
        pvDroppedRecently: false,
      }),
    );
    expect(r.shouldMove).toBe(true);
    expect(r.blockedBy).toBeUndefined();
    expect(r.target01).toBe(0.3);
  });
});

// ---------------------------------------------------------------------------
// Branch ordering.
// ---------------------------------------------------------------------------

describe('applyHysteresis — branch ordering', () => {
  it('first-move outranks min_position_delta (currentLevel01=null short-circuits)', () => {
    const r = applyHysteresis(
      mkInputs({
        currentLevel01: null,
        finalTarget01: 0.31, // tiny delta would normally block
        lastMovedAt: null,
      }),
    );
    expect(r.shouldMove).toBe(true);
  });

  it('min_position_delta outranks min_seconds', () => {
    const recent = new Date(NOW.getTime() - 60 * 1000);
    const r = applyHysteresis(
      mkInputs({
        finalTarget01: 0.31, // 1 pp delta
        currentLevel01: 0.3,
        lastMovedAt: recent, // also too recent
      }),
    );
    expect(r.blockedBy).toBe('no_change');
  });

  it('min_seconds outranks pv_cloud', () => {
    const recent = new Date(NOW.getTime() - 60 * 1000);
    const r = applyHysteresis(
      mkInputs({
        finalTarget01: 0.3, // opening
        currentLevel01: 0.9,
        lastMovedAt: recent, // too recent
        pvDroppedRecently: true, // would also block via cloud
      }),
    );
    expect(r.blockedBy).toBe('min_seconds');
  });
});
