/**
 * Heat Shield — static source adapter tests (Task 5.3).
 *
 * The static source is a pure value carrier: the only behaviour
 * worth verifying is that it stamps `observedAt` from the caller's
 * `now`, that it always reports `ok: true` / `usedFallback: false`,
 * and that the cloned `observedAt` cannot be mutated through the
 * caller's reference.
 */

import { describe, expect, it } from 'vitest';

import {
  createStaticSource,
  resolveStatic,
} from '../../src/plugin/sources/static.js';

describe('resolveStatic', () => {
  it('returns the literal value with observedAt equal to the input timestamp', () => {
    const now = new Date('2026-06-21T10:00:00.000Z');
    const result = resolveStatic({ kind: 'static', value: 19.5 }, now);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(19.5);
      expect(result.usedFallback).toBe(false);
      expect(result.observedAt.getTime()).toBe(now.getTime());
    }
  });

  it('clones observedAt so caller mutations do not leak into the result', () => {
    // Use a mutable Date intentionally; the static resolver must not
    // hand the same reference back.
    const now = new Date('2026-06-21T10:00:00.000Z');
    const originalMs = now.getTime();

    const result = resolveStatic({ kind: 'static', value: 42 }, now);

    // Mutate the caller's Date after we have a result.
    now.setUTCFullYear(2099);

    expect(result.ok).toBe(true);
    if (result.ok) {
      // The result's observedAt is a clone — still pointing at the
      // original instant.
      expect(result.observedAt.getTime()).toBe(originalMs);
      expect(result.observedAt).not.toBe(now);
    }
  });
});

describe('createStaticSource', () => {
  it('exposes the captured value via the readonly `value` property', () => {
    const src = createStaticSource(42);
    expect(src.value).toBe(42);
  });

  it('resolve(now) returns the captured value with the supplied timestamp', () => {
    const src = createStaticSource(42);
    const now = new Date('2026-06-21T10:00:00.000Z');
    const result = src.resolve(now);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(42);
      expect(result.usedFallback).toBe(false);
      expect(result.observedAt.getTime()).toBe(now.getTime());
    }
  });

  it('resolve clones observedAt independently per call', () => {
    const src = createStaticSource(7.25);
    const now = new Date('2026-06-21T10:00:00.000Z');
    const a = src.resolve(now);
    const b = src.resolve(now);

    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      // Different Date instances per call so no shared aliasing.
      expect(a.observedAt).not.toBe(b.observedAt);
      expect(a.observedAt.getTime()).toBe(b.observedAt.getTime());
      expect(a.observedAt.getTime()).toBe(now.getTime());
    }
  });
});
