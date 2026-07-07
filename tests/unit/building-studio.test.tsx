// @vitest-environment jsdom
/**
 * Building Studio UI smoke test (building-model-editor Phase 1). Loads a model
 * via a mocked fetch and asserts the editor renders its shell (toolbar,
 * storeys, canvas, inspector).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor, fireEvent } from '@testing-library/preact';
import { h } from 'preact';

import { BuildingStudioView } from '../../src/plugin/dashboard/spa/tabs/buildingStudio.js';
import { newBuildingModel, defaultEditorContext } from '../../src/shared/building-editor.js';
import { latestBuildingRevision } from '../../src/plugin/dashboard/spa/store.js';

const model = newBuildingModel(defaultEditorContext(), { latitude: 52.5, longitude: 13.4, timezone: 'Europe/Berlin' });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  latestBuildingRevision.value = null;
});

describe('BuildingStudioView', () => {
  it('renders the editor shell after loading the model', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => model })) as unknown as typeof fetch,
    );
    const { container } = render(<BuildingStudioView />);
    await waitFor(() => {
      expect(container.querySelector('[data-testid="building-toolbar"]')).not.toBeNull();
    });
    expect(container.querySelector('[data-testid="building-canvas"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="building-storeys"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="building-inspector"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="building-detect-rooms"]')).not.toBeNull();
    // Always-visible shell controls: view toggle, save, and the "Mehr" menu.
    expect(container.querySelector('[data-testid="building-view-2d"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="building-save"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="building-more"]')).not.toBeNull();
    // Wall-ops (split/extend/offset) are contextual — hidden with no wall selected.
    expect(container.querySelector('[data-testid="building-split"]')).toBeNull();
    // The seeded model has one storey → validation is clean.
    expect(container.querySelector('[data-testid="building-validation-ok"]')).not.toBeNull();
  });

  it('shows an error state when the load fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch,
    );
    const { container } = render(<BuildingStudioView />);
    await waitFor(() => {
      expect(container.querySelector('[data-testid="building-error"]')).not.toBeNull();
    });
  });

  it('reveals the underlay panel (empty state) when toggled', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => model })) as unknown as typeof fetch,
    );
    const { container } = render(<BuildingStudioView />);
    await waitFor(() => {
      expect(container.querySelector('[data-testid="building-more"]')).not.toBeNull();
    });
    // Secondary actions live behind the "Mehr" menu now.
    fireEvent.click(container.querySelector('[data-testid="building-more"]') as HTMLElement);
    fireEvent.click(container.querySelector('[data-testid="building-toggle-underlays"]') as HTMLElement);
    expect(container.querySelector('[data-testid="building-underlays"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="building-underlays-empty"]')).not.toBeNull();
  });

  it('renders a crop clip + crop/clear controls for an underlay with a crop polygon', async () => {
    const storeyId = model.storeys[0]?.id ?? '';
    const underlay = {
      id: 'ul1',
      storeyId,
      name: 'Plan',
      kind: 'floorplan',
      mediaType: 'image/png',
      widthPx: 200,
      heightPx: 100,
      metersPerPixel: 0.01,
      offsetXM: 0,
      offsetYM: 0,
      rotationDeg: 0,
      opacityPct: 60,
      contrastPct: 100,
      visible: true,
      locked: false,
      northAssumed: true,
      crop: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.5, y: 0.9 }],
      createdAt: 't',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (typeof url === 'string' && url.includes('/api/building/underlays')) {
          return { ok: true, status: 200, json: async () => ({ underlays: [underlay] }) };
        }
        return { ok: true, status: 200, json: async () => model };
      }) as unknown as typeof fetch,
    );
    const { container } = render(<BuildingStudioView />);
    await waitFor(() => {
      expect(container.querySelector('[data-testid="building-underlay-clip-ul1"]')).not.toBeNull();
    });
    // Cropped image references the clip path.
    const img = container.querySelector('[data-testid="building-underlay-img-ul1"]') as SVGImageElement;
    expect(img.style.clipPath).toContain('bs-underlay-clip-ul1');
    // Panel exposes Crop + Clear-crop (the latter only because a crop exists).
    fireEvent.click(container.querySelector('[data-testid="building-more"]') as HTMLElement);
    fireEvent.click(container.querySelector('[data-testid="building-toggle-underlays"]') as HTMLElement);
    expect(container.querySelector('[data-testid="building-underlay-crop-ul1"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="building-underlay-clearcrop-ul1"]')).not.toBeNull();
  });

  it('roof editor: adds a roof to the active storey and exposes type/ridge controls', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => model })) as unknown as typeof fetch,
    );
    const { container } = render(<BuildingStudioView />);
    await waitFor(() => {
      expect(container.querySelector('[data-testid="building-inspector-roof"]')).not.toBeNull();
    });
    // No roof yet → the add affordance is shown, the type select is not.
    expect(container.querySelector('[data-testid="building-roof-type"]')).toBeNull();
    fireEvent.click(container.querySelector('[data-testid="building-roof-add"]') as HTMLElement);
    // Now a roof exists → type + pitch + ridge controls appear.
    await waitFor(() => {
      expect(container.querySelector('[data-testid="building-roof-type"]')).not.toBeNull();
    });
    expect(container.querySelector('[data-testid="building-roof-pitch"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="building-roof-ridge"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="building-roof-delete"]')).not.toBeNull();
    // The seeded model has no footprint walls → no span → no section preview.
    expect(container.querySelector('[data-testid="building-roof-section"]')).toBeNull();

    // Switching to a hip keeps the ridge control; switching to flat hides pitch + ridge.
    const typeSel = container.querySelector('[data-testid="building-roof-type"]') as HTMLSelectElement;
    fireEvent.change(typeSel, { target: { value: 'flat' } });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="building-roof-pitch"]')).toBeNull();
    });
    expect(container.querySelector('[data-testid="building-roof-ridge"]')).toBeNull();
  });

  it('shows the live "changed elsewhere" banner when a newer revision is broadcast', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => model })) as unknown as typeof fetch,
    );
    const { container } = render(<BuildingStudioView />);
    await waitFor(() => {
      expect(container.querySelector('[data-testid="building-toolbar"]')).not.toBeNull();
    });
    // No banner while the loaded revision is current.
    expect(container.querySelector('[data-testid="building-stale-banner"]')).toBeNull();
    // A newer revision committed elsewhere (SSE building.revision) → banner + reload.
    latestBuildingRevision.value = model.revision + 3;
    await waitFor(() => {
      expect(container.querySelector('[data-testid="building-stale-banner"]')).not.toBeNull();
    });
    expect(container.querySelector('[data-testid="building-stale-reload"]')).not.toBeNull();
  });

  it('renders the project switcher when the projects index is available', async () => {
    const index = {
      activeId: 'default',
      projects: [
        { id: 'default', name: 'Standard', createdAt: 't', updatedAt: 't' },
        { id: 'p2', name: 'Ferienhaus', createdAt: 't', updatedAt: 't' },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (typeof url === 'string' && url.includes('/api/building/projects')) {
          return { ok: true, status: 200, json: async () => index };
        }
        return { ok: true, status: 200, json: async () => model };
      }) as unknown as typeof fetch,
    );
    const { container } = render(<BuildingStudioView />);
    await waitFor(() => {
      expect(container.querySelector('[data-testid="building-projects"]')).not.toBeNull();
    });
    const sel = container.querySelector('[data-testid="building-project-select"]') as HTMLSelectElement;
    expect(sel).not.toBeNull();
    expect(sel.querySelectorAll('option')).toHaveLength(2);
    expect(container.querySelector('[data-testid="building-project-new"]')).not.toBeNull();
    // Delete is enabled because a non-default project exists and active=default is guarded server-side;
    // for the default active project the button is disabled.
    const del = container.querySelector('[data-testid="building-project-delete"]') as HTMLButtonElement;
    expect(del.disabled).toBe(true);
  });
});
