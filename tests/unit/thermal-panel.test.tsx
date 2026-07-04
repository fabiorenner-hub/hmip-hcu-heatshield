// @vitest-environment jsdom
/**
 * Thermal Load results panel (thermal-load-engine, Quick Estimate v1). Renders
 * the client-side estimate from a model with a room and asserts the heating /
 * ventilation / cooling tables + disclaimer appear.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, fireEvent, waitFor } from '@testing-library/preact';
import { h } from 'preact';

import { ThermalPanel } from '../../src/plugin/dashboard/spa/components/building/thermalPanel.js';
import { newBuildingModel, newEditorState, addWall, addSpace, defaultEditorContext } from '../../src/shared/building-editor.js';
import type { BuildingModel } from '../../src/shared/building-model.js';

function roomModel(): BuildingModel {
  const ctx = defaultEditorContext();
  let state = newEditorState(newBuildingModel(ctx, { latitude: 52.5, longitude: 13.4, timezone: 'Europe/Berlin' }));
  state = addWall(ctx, state, { axis: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 4 }, { x: 0, y: 4 }, { x: 0, y: 0 }] });
  state = addSpace(ctx, state, { name: 'Wohnen', polygon: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 4 }, { x: 0, y: 4 }] });
  return state.model;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  try { localStorage.clear(); } catch { /* jsdom */ }
});

describe('ThermalPanel', () => {
  it('renders heating/ventilation/cooling tables + disclaimer for a model with rooms', () => {
    const { container } = render(<ThermalPanel model={roomModel()} />);
    expect(container.querySelector('[data-testid="thermal-disclaimer"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="thermal-heating-table"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="thermal-vent-table"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="thermal-cooling-table"]')).not.toBeNull();
    // Dynamic RC design-day cooling table + peak readout.
    expect(container.querySelector('[data-testid="thermal-dynamic-table"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="thermal-dynamic-peak"]')?.textContent).toContain(':00');
    // Design-day chart (canvas) + accessible hourly table (24 rows).
    expect(container.querySelector('[data-testid="thermal-dynamic-chart"]')).not.toBeNull();
    const hourly = container.querySelector('[data-testid="thermal-dynamic-daychart"] tbody');
    expect(hourly?.querySelectorAll('tr').length).toBe(24);
    // One room row + export buttons.
    expect(container.querySelectorAll('[data-testid^="thermal-room-"]').length).toBe(1);
    expect(container.querySelector('[data-testid="thermal-export-json"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="thermal-export-csv"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="thermal-export-pdf"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="thermal-quality"]')).not.toBeNull();
  });

  it('shows an empty hint when the model has no rooms', () => {
    const ctx = defaultEditorContext();
    const empty = newBuildingModel(ctx, { latitude: 52.5, longitude: 13.4, timezone: 'Europe/Berlin' });
    const { container } = render(<ThermalPanel model={empty} />);
    expect(container.querySelector('[data-testid="thermal-empty"]')).not.toBeNull();
  });

  it('setup editor: toggling reveals assumptions and a colder design temp raises the load', () => {
    const { container } = render(<ThermalPanel model={roomModel()} />);
    const totalCell = (): number => {
      const row = container.querySelector('[data-testid^="thermal-room-"]') as HTMLElement;
      const strong = row.querySelector('td:nth-child(4) strong') as HTMLElement;
      return parseFloat((strong.textContent ?? '0').replace(/[^\d.]/g, ''));
    };
    const before = totalCell();
    // Setup hidden by default.
    expect(container.querySelector('[data-testid="thermal-setup"]')).toBeNull();
    fireEvent.click(container.querySelector('[data-testid="thermal-toggle-setup"]') as HTMLElement);
    expect(container.querySelector('[data-testid="thermal-setup"]')).not.toBeNull();
    // Lower the design outdoor temperature → larger ΔT → larger heating load.
    fireEvent.input(container.querySelector('[data-testid="thermal-set-outdoor"]') as HTMLElement, { target: { value: '-20' } });
    expect(totalCell()).toBeGreaterThan(before);
  });

  it('save snapshot posts the estimate and shows the persisted list', async () => {
    const store: Array<{ id: string; savedAt: string; modelRevision: number; buildingHeatingW: number; buildingCoolingW: number }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string }) => {
      if (url === '/api/building/thermal/snapshots' && (init?.method ?? 'GET') === 'POST') {
        store.push({ id: 'snap-1', savedAt: '2026-07-01T10:00:00.000Z', modelRevision: 1, buildingHeatingW: 500, buildingCoolingW: 300 });
        return { ok: true, status: 200, json: async () => store[store.length - 1] };
      }
      if (url === '/api/building/thermal/snapshots') {
        return { ok: true, status: 200, json: async () => ({ snapshots: store }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }) as unknown as typeof fetch);

    const { container } = render(<ThermalPanel model={roomModel()} />);
    // No snapshots table initially (empty list).
    await waitFor(() => {
      expect(container.querySelector('[data-testid="thermal-save-snapshot"]')).not.toBeNull();
    });
    fireEvent.click(container.querySelector('[data-testid="thermal-save-snapshot"]') as HTMLElement);
    await waitFor(() => {
      expect(container.querySelector('[data-testid="thermal-snapshots"]')).not.toBeNull();
    });
    expect(container.querySelectorAll('[data-testid^="thermal-snapshot-"]').length).toBe(1);
  });

  it('compares a saved snapshot against the current estimate', async () => {
    const snapEstimate = {
      profile: 'quick-estimate-v1',
      modelRevision: 1,
      inputHash: 'x',
      heating: { buildingTotalW: 100, sumOfRoomsW: 120 },
      cooling: { buildingPeakW: 50 },
    };
    const store = [{ id: 'snap-1', savedAt: '2026-07-01T10:00:00.000Z', modelRevision: 1, buildingHeatingW: 100, buildingCoolingW: 50 }];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/building/thermal/snapshots/snap-1') {
        return { ok: true, status: 200, json: async () => ({ estimate: snapEstimate }) };
      }
      if (url === '/api/building/thermal/snapshots') {
        return { ok: true, status: 200, json: async () => ({ snapshots: store }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }) as unknown as typeof fetch);

    const { container } = render(<ThermalPanel model={roomModel()} />);
    await waitFor(() => {
      expect(container.querySelector('[data-testid="thermal-compare-snap-1"]')).not.toBeNull();
    });
    fireEvent.click(container.querySelector('[data-testid="thermal-compare-snap-1"]') as HTMLElement);
    await waitFor(() => {
      expect(container.querySelector('[data-testid="thermal-comparison"]')).not.toBeNull();
    });
    // Delta cells render (current room load ≫ the tiny 100 W snapshot).
    expect(container.querySelector('[data-testid="thermal-cmp-heating"]')?.textContent).toContain('%');
    fireEvent.click(container.querySelector('[data-testid="thermal-compare-close"]') as HTMLElement);
    await waitFor(() => {
      expect(container.querySelector('[data-testid="thermal-comparison"]')).toBeNull();
    });
  });

  it('scenario presets: removing shading raises the cooling peak', () => {
    const { container } = render(<ThermalPanel model={roomModel()} />);
    const coolingPeak = (): number => {
      const cell = container.querySelector('[data-testid="thermal-cooling-table"] td strong') as HTMLElement;
      return parseFloat((cell.textContent ?? '0').replace(/[^\d.]/g, ''));
    };
    fireEvent.click(container.querySelector('[data-testid="thermal-toggle-setup"]') as HTMLElement);
    fireEvent.click(container.querySelector('[data-testid="thermal-preset-shade-on"]') as HTMLElement);
    const shaded = coolingPeak();
    fireEvent.click(container.querySelector('[data-testid="thermal-preset-shade-off"]') as HTMLElement);
    expect(coolingPeak()).toBeGreaterThan(shaded);
  });

  it('named scenarios: save, apply is immutable, delete', () => {
    const { container } = render(<ThermalPanel model={roomModel()} />);
    const heatingTotal = (): number => {
      const strong = container.querySelector('[data-testid^="thermal-room-"] td:nth-child(4) strong') as HTMLElement;
      return parseFloat((strong.textContent ?? '0').replace(/[^\d.]/g, ''));
    };
    fireEvent.click(container.querySelector('[data-testid="thermal-toggle-setup"]') as HTMLElement);
    // Save the current (default) assumptions as "A".
    fireEvent.input(container.querySelector('[data-testid="thermal-scenario-name"]') as HTMLElement, { target: { value: 'A' } });
    fireEvent.click(container.querySelector('[data-testid="thermal-scenario-save"]') as HTMLElement);
    const baseline = heatingTotal();
    const savedRow = container.querySelector('[data-testid^="thermal-scenario-apply-"]') as HTMLElement;
    expect(savedRow).not.toBeNull();
    // Now change the design temperature (load rises), then re-apply "A" → back to baseline.
    fireEvent.input(container.querySelector('[data-testid="thermal-set-outdoor"]') as HTMLElement, { target: { value: '-25' } });
    expect(heatingTotal()).toBeGreaterThan(baseline);
    fireEvent.click(savedRow);
    expect(heatingTotal()).toBeCloseTo(baseline, 1);
    // Delete removes it.
    fireEvent.click(container.querySelector('[data-testid^="thermal-scenario-delete-"]') as HTMLElement);
    expect(container.querySelector('[data-testid="thermal-scenarios-empty"]')).not.toBeNull();
  });

  it('scenario preset: night ventilation lowers the cooling peak (cool outdoor + high air change)', () => {
    const { container } = render(<ThermalPanel model={roomModel()} />);
    const coolingPeak = (): number => {
      const cell = container.querySelector('[data-testid="thermal-cooling-table"] td strong') as HTMLElement;
      return parseFloat((cell.textContent ?? '0').replace(/[^\d.]/g, ''));
    };
    fireEvent.click(container.querySelector('[data-testid="thermal-toggle-setup"]') as HTMLElement);
    fireEvent.click(container.querySelector('[data-testid="thermal-preset-shade-off"]') as HTMLElement);
    const base = coolingPeak();
    fireEvent.click(container.querySelector('[data-testid="thermal-preset-night-vent"]') as HTMLElement);
    expect(coolingPeak()).toBeLessThan(base);
  });
});
