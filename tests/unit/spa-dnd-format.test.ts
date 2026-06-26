/**
 * Unit tests for the DnD payload codec and the formatting helpers
 * (Tasks 5.4 / 2.2). The DnD roundtrip is Property 3 from design.md.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  parseDnd,
  serializeDnd,
  type DndPayload,
} from '../../src/plugin/dashboard/spa/hooks/useDeviceDnd.js';
import {
  formatSignal,
  stalenessDot,
} from '../../src/plugin/dashboard/spa/format.js';

describe('DnD payload codec', () => {
  it('round-trips every valid payload (Property 3)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<DndPayload['kind']>('shutter', 'tempSensor', 'contact'),
        fc.string({ minLength: 1 }),
        (kind, deviceId) => {
          const p: DndPayload = { kind, deviceId };
          const back = parseDnd(serializeDnd(p));
          expect(back).toEqual(p);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('decodes a bare deviceId string as a shutter (legacy format)', () => {
    expect(parseDnd('abc-123')).toEqual({ kind: 'shutter', deviceId: 'abc-123' });
  });

  it('returns null for empty input', () => {
    expect(parseDnd('')).toBeNull();
  });

  it('returns null for a JSON object with an unknown kind', () => {
    expect(parseDnd(JSON.stringify({ kind: 'bogus', deviceId: 'x' }))).toBeNull();
  });
});

describe('formatSignal', () => {
  it('formats a number with unit and rounding', () => {
    expect(formatSignal(22.456, '°C')).toBe('22.5 °C');
    expect(formatSignal(1234, 'W/m²', 0)).toBe('1234 W/m²');
  });

  it('returns an em-dash for null/undefined/non-finite', () => {
    expect(formatSignal(null, '°C')).toBe('–');
    expect(formatSignal(undefined, '°C')).toBe('–');
    expect(formatSignal(Number.NaN, '°C')).toBe('–');
  });
});

describe('stalenessDot', () => {
  it('maps each state to a css modifier and German label', () => {
    expect(stalenessDot('fresh')).toEqual({
      cssClass: 'staleness-dot staleness-dot--fresh',
      label: 'aktuell',
    });
    expect(stalenessDot('stale').label).toBe('veraltet');
    expect(stalenessDot(undefined)).toEqual({
      cssClass: 'staleness-dot staleness-dot--unknown',
      label: 'unbekannt',
    });
  });
});
