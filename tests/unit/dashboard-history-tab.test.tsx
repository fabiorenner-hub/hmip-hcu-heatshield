// @vitest-environment jsdom
/**
 * Unit tests for the Verlauf (history) tab and the SVG LineChart
 * component (Wave 3 history charts).
 *
 * The HistoryTab fetches `GET /api/trends?seconds=` on mount and renders
 * two charts. We stub `globalThis.fetch` and assert the SVG series paths
 * appear once data resolves, and that the range buttons re-fetch.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor, fireEvent } from '@testing-library/preact';
import { h } from 'preact';

import { LineChart } from '../../src/plugin/dashboard/spa/components/lineChart.js';
import { HistoryTab } from '../../src/plugin/dashboard/spa/tabs/history.js';
import { snapshot } from '../../src/plugin/dashboard/spa/store.js';

interface TrendSample {
  ts: string;
  key: string;
  value: number;
}

function trendResponse(samples: TrendSample[]): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ samples }),
  } as unknown as Response;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  snapshot.value = null;
});

describe('LineChart component', () => {
  it('renders an empty state when no finite points exist', () => {
    const { getByTestId } = render(
      <LineChart series={[{ label: 'X', color: '#fff', points: [] }]} unit="°C" />,
    );
    expect(getByTestId('line-chart-empty')).toBeTruthy();
  });

  it('renders one path per series with data', () => {
    const { getByTestId } = render(
      <LineChart
        series={[
          {
            label: 'Außen',
            color: '#fff',
            points: [
              { t: 1_000, v: 20 },
              { t: 2_000, v: 22 },
            ],
          },
        ]}
        unit="°C"
      />,
    );
    const path = getByTestId('line-chart-series-Außen') as unknown as SVGPathElement;
    expect(path.getAttribute('d')).toMatch(/^M/u);
  });
});

describe('HistoryTab', () => {
  it('fetches trends on mount and renders the temperature + PV charts', async () => {
    const samples: TrendSample[] = [
      { ts: '2026-06-21T12:00:00.000Z', key: 'outdoor', value: 22 },
      { ts: '2026-06-21T12:03:00.000Z', key: 'outdoor', value: 23 },
      { ts: '2026-06-21T12:00:00.000Z', key: 'pv', value: 4.1 },
    ];
    const fetchMock = vi.fn(async () => trendResponse(samples));
    vi.stubGlobal('fetch', fetchMock);

    const { getByTestId, getAllByTestId } = render(<HistoryTab />);

    await waitFor(() => {
      expect(getAllByTestId('line-chart').length).toBeGreaterThanOrEqual(1);
    });
    expect(getByTestId('tab-history')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/trends?seconds=86400',
      expect.anything(),
    );
  });

  it('re-fetches with a different window when a range button is clicked', async () => {
    const fetchMock = vi.fn(async () => trendResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    const { getByTestId } = render(<HistoryTab />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    fireEvent.click(getByTestId('history-range-21600'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/trends?seconds=21600',
        expect.anything(),
      );
    });
  });
});
