/**
 * DWD warnings — warncell resolution. The key behaviour: a region usually
 * resolves to the fine GEMEINDE cell (8…), but DWD issues warnings on the
 * parent LANDKREIS cell (1…). The resolver must aggregate both so an active
 * Landkreis warning is surfaced for a Gemeinde region.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  getDwdWarnings,
  candidateCells,
  _resetDwdCaches,
} from '../../src/plugin/sources/dwdWarnings.js';

function mockFetch(csv: string, warnJsonp: string): typeof globalThis.fetch {
  return (async (url: unknown): Promise<Response> => {
    const u = String(url);
    const body = u.includes('.csv') ? csv : warnJsonp;
    return { ok: true, status: 200, text: async (): Promise<string> => body } as unknown as Response;
  }) as typeof globalThis.fetch;
}

const CSV = ['Warncell-Id;Name', '899999999;Musterstadt', '199999000;Musterkreis'].join('\n');

afterEach(() => _resetDwdCaches());

describe('candidateCells', () => {
  it('derives the parent Landkreis (1…000) cell from a Gemeinde (8…) cell', () => {
    expect(candidateCells('899999999')).toEqual(['899999999', '199999000']);
  });
  it('leaves a Landkreis (1…) cell unchanged', () => {
    expect(candidateCells('199999000')).toEqual(['199999000']);
  });
});

describe('getDwdWarnings — Landkreis aggregation', () => {
  it('surfaces a Landkreis warning for a Gemeinde region', async () => {
    _resetDwdCaches();
    // Warning lives ONLY on the Landkreis cell 199999000, none on the Gemeinde.
    const warnJsonp =
      'warnWetter.loadWarnings(' +
      JSON.stringify({
        time: 1782594673000,
        warnings: {
          '199999000': [
            { level: 3, event: 'STARKES GEWITTER', headline: 'Amtliche Unwetterwarnung' },
          ],
        },
      }) +
      ');';
    const res = await getDwdWarnings({
      regionName: 'Musterstadt',
      fetchFn: mockFetch(CSV, warnJsonp),
      now: () => 1_000,
    });
    expect(res.cellId).toBe('899999999');
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]?.event).toBe('STARKES GEWITTER');
    expect(res.warnings[0]?.level).toBe(3);
  });

  it('returns empty when neither the Gemeinde nor the Landkreis cell is warned', async () => {
    _resetDwdCaches();
    const warnJsonp =
      'warnWetter.loadWarnings(' + JSON.stringify({ time: 1, warnings: {} }) + ');';
    const res = await getDwdWarnings({
      regionName: 'Musterstadt',
      fetchFn: mockFetch(CSV, warnJsonp),
      now: () => 2_000,
    });
    expect(res.warnings).toHaveLength(0);
  });
});
