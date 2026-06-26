/**
 * Sad-path tests for `parseConfig` / `safeParseConfig`.
 *
 * Each case mutates a *fresh* copy of the realistic fixture (so we are
 * isolating one violation at a time) and asserts that:
 *   - `parseConfig` throws a `ZodError`,
 *   - or for the safeParse cases, that `result.success === false` and the
 *     first issue's `path` breadcrumb points exactly at the offending field.
 *
 * The point of the second style is that the error is *usable* by the
 * dashboard / wizard, not just a generic throw.
 */

import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import {
  parseConfig,
  safeParseConfig,
} from '../../src/shared/schema.js';
import { validRealisticConfig } from '../_fixtures/config.js';

/**
 * Helper that asserts the thrown error is a real `ZodError`. We do not
 * rely on `toThrow(ZodError)` alone because Zod v4 throws `ZodRealError`
 * which still passes `instanceof ZodError`.
 */
function expectZodError(fn: () => unknown): ZodError {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ZodError);
  return caught as ZodError;
}

describe('parseConfig — required-field violations', () => {
  it('throws when schemaVersion is missing entirely', () => {
    const config = validRealisticConfig();
    delete config['schemaVersion'];

    expectZodError(() => parseConfig(config));
  });

  it('throws when schemaVersion is the wrong literal (0)', () => {
    const config = validRealisticConfig();
    config['schemaVersion'] = 0;

    expectZodError(() => parseConfig(config));
  });

  it('throws when globalSignals.outdoorTemp is missing', () => {
    const config = validRealisticConfig();
    const globalSignals = config['globalSignals'] as Record<string, unknown>;
    delete globalSignals['outdoorTemp'];

    expectZodError(() => parseConfig(config));
  });

  it('throws when a static SourceRef is missing its value field', () => {
    const config = validRealisticConfig();
    config['globalSignals'] = {
      outdoorTemp: {
        // `static` discriminator without the required `value` field.
        primary: { kind: 'static' },
      },
    };

    expectZodError(() => parseConfig(config));
  });
});

describe('parseConfig — windows[] field violations', () => {
  it('throws when orientationDeg is 360 (above max 359)', () => {
    const config = validRealisticConfig();
    const windows = config['windows'] as Array<Record<string, unknown>>;
    windows[0]!['orientationDeg'] = 360;

    expectZodError(() => parseConfig(config));
  });

  it('throws when orientationDeg is -1 (below min 0)', () => {
    const config = validRealisticConfig();
    const windows = config['windows'] as Array<Record<string, unknown>>;
    windows[0]!['orientationDeg'] = -1;

    expectZodError(() => parseConfig(config));
  });

  it('throws when sunPrelookMinutes is 10 (below min 15)', () => {
    const config = validRealisticConfig();
    const windows = config['windows'] as Array<Record<string, unknown>>;
    windows[0]!['sunPrelookMinutes'] = 10;

    expectZodError(() => parseConfig(config));
  });

  it('throws when window.type is an unknown enum value', () => {
    const config = validRealisticConfig();
    const windows = config['windows'] as Array<Record<string, unknown>>;
    windows[0]!['type'] = 'pergola';

    expectZodError(() => parseConfig(config));
  });
});

describe('parseConfig — rules[] field violations', () => {
  it('throws when controlIntervalSeconds is below the Requirement 12.1 floor (180)', () => {
    const config = validRealisticConfig();
    const rules = config['rules'] as Record<string, unknown>;
    const automation = rules['automation'] as Record<string, unknown>;
    automation['controlIntervalSeconds'] = 60;

    expectZodError(() => parseConfig(config));
  });

  it('throws when sun.minElevationDeg is negative (below min 0)', () => {
    const config = validRealisticConfig();
    const rules = config['rules'] as Record<string, unknown>;
    const sun = rules['sun'] as Record<string, unknown>;
    sun['minElevationDeg'] = -5;

    expectZodError(() => parseConfig(config));
  });
});

describe('parseConfig — rooms[] field violations', () => {
  it('throws when room.priority is an unknown enum value', () => {
    const config = validRealisticConfig();
    const rooms = config['rooms'] as Array<Record<string, unknown>>;
    rooms[0]!['priority'] = 'huge';

    expectZodError(() => parseConfig(config));
  });
});

describe('safeParseConfig — error breadcrumbs are usable', () => {
  it('reports the missing globalSignals.outdoorTemp at the right path', () => {
    const config = validRealisticConfig();
    const globalSignals = config['globalSignals'] as Record<string, unknown>;
    delete globalSignals['outdoorTemp'];

    const result = safeParseConfig(config);

    expect(result.success).toBe(false);
    if (result.success) return; // narrow for TS, never reached.
    expect(result.error.issues.length).toBeGreaterThan(0);
    expect(result.error.issues[0]!.path).toEqual([
      'globalSignals',
      'outdoorTemp',
    ]);
  });

  it('reports the orientationDeg violation at windows[0].orientationDeg', () => {
    const config = validRealisticConfig();
    const windows = config['windows'] as Array<Record<string, unknown>>;
    windows[0]!['orientationDeg'] = 360;

    const result = safeParseConfig(config);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]!.path).toEqual([
      'windows',
      0,
      'orientationDeg',
    ]);
  });
});
