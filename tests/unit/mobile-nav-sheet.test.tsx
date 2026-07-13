// @vitest-environment jsdom
/**
 * Mobile bottom-nav "Mehr" sheet — Apple-style Liquid-Glass rework.
 *
 * Locks in the richer overflow sheet: it exposes the utility destinations
 * (Automatik, Einstellungen, Nachrichten, Hilfe, Darstellung, Updates) plus a
 * Basis/Experte view toggle, and the primary bar still carries exactly five
 * tap targets with an active pill on the current route.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, fireEvent } from '@testing-library/preact';
import { h } from 'preact';

import { App } from '../../src/plugin/dashboard/spa/app.js';
import { setFlag } from '../../src/plugin/dashboard/spa/featureFlags.js';
import { snapshot } from '../../src/plugin/dashboard/spa/store.js';
import { expertMode, setExpertMode } from '../../src/plugin/dashboard/spa/expertMode.js';

function setWidth(px: number): void {
  Object.defineProperty(window, 'innerWidth', { value: px, configurable: true, writable: true });
}

beforeEach(() => {
  setWidth(375);
  setFlag('mobileUiV2', true);
});

afterEach(() => {
  cleanup();
  snapshot.value = null;
  setExpertMode(false);
  try { window.localStorage.clear(); } catch { /* ignore */ }
  setWidth(1024);
});

describe('mobile nav — Mehr sheet (liquid glass rework)', () => {
  it('marks the active primary tab with the active class', () => {
    const { container } = render(<App initialUrl="/raeume" />);
    const raeume = container.querySelector('[data-testid="mnav-raeume"]');
    expect(raeume).not.toBeNull();
    expect(raeume!.classList.contains('mobile-nav__item--active')).toBe(true);
    // Icon pill wrapper is present for the springy active indicator.
    expect(raeume!.querySelector('.mobile-nav__ico')).not.toBeNull();
  });

  it('exposes the utility destinations and a Basis/Experte toggle in the sheet', () => {
    const { container } = render(<App initialUrl="/uebersicht" />);
    fireEvent.click(container.querySelector('[data-testid="mnav-more"]') as HTMLButtonElement);

    const sheet = container.querySelector('[data-testid="mobile-more-sheet"]');
    expect(sheet).not.toBeNull();
    for (const id of ['mnav-automatik', 'mnav-einstellungen', 'mnav-messages', 'mnav-hilfe', 'mnav-darstellung', 'mnav-updates']) {
      expect(sheet!.querySelector(`[data-testid="${id}"]`)).not.toBeNull();
    }
    // Basis/Experte segmented control.
    expect(sheet!.querySelectorAll('.mobile-more__segbtn')).toHaveLength(2);
  });

  it('toggles expert mode from the sheet segmented control', () => {
    expect(expertMode.value).toBe(false);
    const { container } = render(<App initialUrl="/uebersicht" />);
    fireEvent.click(container.querySelector('[data-testid="mnav-more"]') as HTMLButtonElement);
    const seg = container.querySelectorAll('.mobile-more__segbtn');
    fireEvent.click(seg[1] as HTMLButtonElement); // "Experte"
    expect(expertMode.value).toBe(true);
  });
});
