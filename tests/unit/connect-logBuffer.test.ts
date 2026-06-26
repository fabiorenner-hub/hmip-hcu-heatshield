/**
 * Unit tests for `src/plugin/connect/logBuffer.ts` (Task 13.2).
 */

import { describe, expect, it } from 'vitest';

import { ConnectLogBuffer } from '../../src/plugin/connect/logBuffer.js';

describe('ConnectLogBuffer', () => {
  it('respects the configured capacity and evicts oldest entries (FIFO)', () => {
    const buf = new ConnectLogBuffer({ capacity: 1000 });
    for (let i = 0; i < 1500; i += 1) {
      buf.append('info', `msg-${i}`, { i });
    }
    expect(buf.length).toBe(1000);
    const all = buf.entries();
    expect(all.length).toBe(1000);
    // Oldest-first ordering: the first 500 entries were evicted, so
    // the kept window starts at i=500.
    expect(all[0]?.msg).toBe('msg-500');
    expect(all[all.length - 1]?.msg).toBe('msg-1499');
    // ctx is preserved.
    expect(all[0]?.ctx).toEqual({ i: 500 });
  });

  it('returns entries in oldest-first order when not yet full', () => {
    const buf = new ConnectLogBuffer({ capacity: 10 });
    buf.append('info', 'a');
    buf.append('warn', 'b');
    buf.append('error', 'c');
    const entries = buf.entries();
    expect(entries.map((e) => e.msg)).toEqual(['a', 'b', 'c']);
    expect(entries[0]?.level).toBe('info');
    expect(entries[1]?.level).toBe('warn');
    expect(entries[2]?.level).toBe('error');
  });

  it('returns oldest-first across the wrap-around boundary', () => {
    const buf = new ConnectLogBuffer({ capacity: 3 });
    buf.append('info', 'a');
    buf.append('info', 'b');
    buf.append('info', 'c');
    buf.append('info', 'd');
    buf.append('info', 'e');
    expect(buf.entries().map((e) => e.msg)).toEqual(['c', 'd', 'e']);
  });

  it('clear() empties the buffer and entries() returns []', () => {
    const buf = new ConnectLogBuffer({ capacity: 100 });
    for (let i = 0; i < 50; i += 1) {
      buf.append('warn', `m${i}`);
    }
    expect(buf.length).toBe(50);
    buf.clear();
    expect(buf.length).toBe(0);
    expect(buf.entries()).toEqual([]);
  });

  it('uses an injected clock for deterministic timestamps', () => {
    const fixed = new Date('2026-06-21T12:00:00.000Z');
    const buf = new ConnectLogBuffer({ capacity: 5, now: () => fixed });
    buf.append('info', 'hello', { source: 'test' });
    const entry = buf.entries()[0];
    expect(entry?.ts).toBe('2026-06-21T12:00:00.000Z');
    expect(entry?.msg).toBe('hello');
    expect(entry?.ctx).toEqual({ source: 'test' });
  });

  it('shallow-clones ctx so post-append mutation does not leak in', () => {
    const buf = new ConnectLogBuffer({ capacity: 5 });
    const ctx: Record<string, unknown> = { a: 1 };
    buf.append('info', 'hello', ctx);
    ctx['a'] = 999;
    const entry = buf.entries()[0];
    expect(entry?.ctx).toEqual({ a: 1 });
  });

  it('asLogger is callable as a ConnectLogger', () => {
    const buf = new ConnectLogBuffer({ capacity: 5 });
    buf.asLogger('info', 'wired');
    buf.asLogger('warn', 'oops', { code: 42 });
    const entries = buf.entries();
    expect(entries.map((e) => e.msg)).toEqual(['wired', 'oops']);
    expect(entries[1]?.ctx).toEqual({ code: 42 });
  });

  it('falls back to the default capacity when given a non-positive value', () => {
    const buf = new ConnectLogBuffer({ capacity: 0 });
    for (let i = 0; i < 1200; i += 1) {
      buf.append('info', `m${i}`);
    }
    // Default is 1000.
    expect(buf.length).toBe(1000);
  });
});
