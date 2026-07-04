// @vitest-environment jsdom
/**
 * 3D preview (digital-twin-renderer T-02/T-04). Renders the SVG projection and
 * the accessible scene tree from a model with geometry.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, fireEvent } from '@testing-library/preact';
import { h } from 'preact';

import { Twin3D } from '../../src/plugin/dashboard/spa/components/building/twin3d.js';
import { newBuildingModel, newEditorState, addWall, addSpace, defaultEditorContext } from '../../src/shared/building-editor.js';
import type { BuildingModel } from '../../src/shared/building-model.js';

function squareModel(): BuildingModel {
  const ctx = defaultEditorContext();
  let state = newEditorState(newBuildingModel(ctx, { latitude: 52.5, longitude: 13.4, timezone: 'Europe/Berlin' }));
  state = addWall(ctx, state, { axis: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }, { x: 0, y: 0 }] });
  state = addSpace(ctx, state, { name: 'Raum', polygon: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }] });
  return state.model;
}

afterEach(cleanup);

describe('Twin3D', () => {
  it('renders projected polygons and the accessible scene tree', () => {
    const { container } = render(<Twin3D model={squareModel()} />);
    const svg = container.querySelector('[data-testid="twin3d-canvas"]');
    expect(svg).not.toBeNull();
    expect(svg!.querySelectorAll('polygon').length).toBeGreaterThan(0);
    expect(container.querySelector('[data-testid="twin3d-tree"]')).not.toBeNull();
  });

  it('shows an empty hint when there is no geometry', () => {
    const ctx = defaultEditorContext();
    const empty = newBuildingModel(ctx, { latitude: 52.5, longitude: 13.4, timezone: 'Europe/Berlin' });
    const { container } = render(<Twin3D model={empty} />);
    expect(container.querySelector('[data-testid="twin3d-empty"]')).not.toBeNull();
  });

  it('sun preview: toggling the sun reveals the time control, and midday casts a sun indicator', () => {
    const { container } = render(<Twin3D model={squareModel()} />);
    // Off by default → no time control, no indicator.
    expect(container.querySelector('[data-testid="twin3d-suntime"]')).toBeNull();
    expect(container.querySelector('[data-testid="twin3d-sun-indicator"]')).toBeNull();
    // Toggle sun on.
    fireEvent.click(container.querySelector('[data-testid="twin3d-sun"]') as HTMLElement);
    const slider = container.querySelector('[data-testid="twin3d-suntime"]');
    expect(slider).not.toBeNull();
    // Midday at lat 52.5 → sun is well above the horizon → indicator + shadows.
    fireEvent.input(slider as HTMLElement, { target: { value: '720' } });
    expect(container.querySelector('[data-testid="twin3d-sun-readout"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="twin3d-sun-indicator"]')).not.toBeNull();
  });

  it('section cut: toggling reveals the height control and clipping keeps polygons', () => {
    const { container } = render(<Twin3D model={squareModel()} />);
    expect(container.querySelector('[data-testid="twin3d-clip-height"]')).toBeNull();
    fireEvent.click(container.querySelector('[data-testid="twin3d-clip"]') as HTMLElement);
    const slider = container.querySelector('[data-testid="twin3d-clip-height"]');
    expect(slider).not.toBeNull();
    // Cut low (0.5 m) → walls survive as clipped polygons, roof/ceiling above are gone.
    fireEvent.input(slider as HTMLElement, { target: { value: '0.5' } });
    expect(container.querySelector('[data-testid="twin3d-clip-readout"]')).not.toBeNull();
    const svg = container.querySelector('[data-testid="twin3d-canvas"]');
    expect(svg!.querySelectorAll('polygon').length).toBeGreaterThan(0);
  });

  it('room-state overlay: toggle appears with data and shows a legend', () => {
    const { container } = render(
      <Twin3D model={squareModel()} roomStates={[{ name: 'Raum', tone: 'hot', tempC: 28.4 }]} />,
    );
    // Toggle present because room-state data was supplied.
    const toggle = container.querySelector('[data-testid="twin3d-roomstate"]');
    expect(toggle).not.toBeNull();
    // Off by default → no legend.
    expect(container.querySelector('[data-testid="twin3d-roomstate-legend"]')).toBeNull();
    fireEvent.click(toggle as HTMLElement);
    expect(container.querySelector('[data-testid="twin3d-roomstate-legend"]')).not.toBeNull();
  });

  it('room-state overlay: no toggle when there is no live room data', () => {
    const { container } = render(<Twin3D model={squareModel()} />);
    expect(container.querySelector('[data-testid="twin3d-roomstate"]')).toBeNull();
  });
});
