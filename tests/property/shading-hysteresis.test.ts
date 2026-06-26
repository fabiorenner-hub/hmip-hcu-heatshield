/**
 * Property-based tests for the shading FSM (Task 3.3).
 *
 * Subject: `src/plugin/engine/shadingState.ts` — `nextShadeState`.
 *
 * Correctness Property 2 (design.md): once a shaded window's load drops to or
 * below the release threshold, it stays `shaded` for at least
 * `releaseHoldMinutes` (as long as direct sun persists) before releasing.
 *
 * Validates: Requirements 3.1, 3.2, 3.4
 */

import fc from 'fast-check';
import { describe, it, expect } from 'vitest';

import {
  nextShadeState,
  type WindowShadeRuntime,
} from '../../src/plugin/engine/shadingState.js';

const ORIGIN = Date.UTC(2026, 5, 22, 8, 0, 0);

describe('nextShadeState — Property 2 (release hysteresis hold)', () => {
  it('keeps shaded below release while the hold time has not elapsed (sun on)', () => {
    fc.assert(
      fc.property(
        // belowReleaseSince offset (minutes ago) and hold time
        fc.integer({ min: 0, max: 600 }), // elapsed minutes since drop
        fc.integer({ min: 1, max: 240 }), // releaseHoldMinutes
        fc.double({ min: 0.31, max: 1, noNaN: true }), // activate above release
        fc.double({ min: 0, max: 0.3, noNaN: true }), // load at/below release
        (elapsed, hold, activate, load01) => {
          const release = 0.3;
          fc.pre(activate > release);
          const belowSinceMs = ORIGIN - elapsed * 60_000;
          const prev: WindowShadeRuntime = {
            state: 'shaded',
            shadedSince: new Date(belowSinceMs - 60_000).toISOString(),
            belowReleaseSince: new Date(belowSinceMs).toISOString(),
          };
          const next = nextShadeState({
            prev,
            now: new Date(ORIGIN),
            load01,
            hasDirectSun: true,
            activateThreshold: activate,
            releaseThreshold: release,
            releaseHoldMinutes: hold,
          });
          if (elapsed < hold) {
            expect(next.state).toBe('shaded');
          } else {
            expect(next.state).toBe('open');
          }
        },
      ),
    );
  });

  it('always releases immediately when the sun is off, regardless of timers', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.integer({ min: 1, max: 240 }),
        (load01, hold) => {
          const prev: WindowShadeRuntime = {
            state: 'shaded',
            shadedSince: new Date(ORIGIN - 120 * 60_000).toISOString(),
            belowReleaseSince: new Date(ORIGIN).toISOString(),
          };
          const next = nextShadeState({
            prev,
            now: new Date(ORIGIN),
            load01,
            hasDirectSun: false,
            activateThreshold: 0.45,
            releaseThreshold: 0.3,
            releaseHoldMinutes: hold,
          });
          expect(next.state).toBe('open');
        },
      ),
    );
  });
});
