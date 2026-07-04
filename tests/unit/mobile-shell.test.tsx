// @vitest-environment jsdom
/**
 * Mobile touch-first shell (Gate 2 G2.3).
 *
 * Verifies the `app--mobile` root class + bottom nav appear only when
 * `mobileUiV2` is on AND the viewport is phone-class, and that the bottom nav
 * exposes five targets (4 primary + Mehr).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, fireEvent, act } from '@testing-library/preact';
import { h } from 'preact';

import { App } from '../../src/plugin/dashboard/spa/app.js';
import { setFlag } from '../../src/plugin/dashboard/spa/featureFlags.js';
import { snapshot } from '../../src/plugin/dashboard/spa/store.js';

function setWidth(px: number): void {
  Object.defineProperty(window, 'innerWidth', { value: px, configurable: true, writable: true });
}

beforeEach(() => {
  setWidth(375); // large-phone width
});

afterEach(() => {
  cleanup();
  snapshot.value = null;
  try {
    window.localStorage.clear();
  } catch {
    /* ignore */
  }
  setWidth(1024);
});

describe('mobile shell toggle', () => {
  it('is OFF by default even at phone width', () => {
    const { container } = render(<App initialUrl="/beschattung" />);
    expect(container.querySelector('.app')!.classList.contains('app--mobile')).toBe(false);
    expect(container.querySelector('[data-testid="mobile-nav"]')).toBeNull();
  });

  it('is ON with mobileUiV2 at phone width and shows 5 nav targets', () => {
    setFlag('mobileUiV2', true);
    const { container } = render(<App initialUrl="/beschattung" />);
    expect(container.querySelector('.app')!.classList.contains('app--mobile')).toBe(true);
    const nav = container.querySelector('[data-testid="mobile-nav"]');
    expect(nav).not.toBeNull();
    expect(nav!.querySelectorAll('.mobile-nav__item')).toHaveLength(5);
  });

  it('does NOT activate at tablet width even with the flag on', () => {
    setFlag('mobileUiV2', true);
    setWidth(1024);
    const { container } = render(<App initialUrl="/beschattung" />);
    expect(container.querySelector('.app')!.classList.contains('app--mobile')).toBe(false);
  });

  it('opens the "Mehr" sheet and closes it on Escape (a11y)', async () => {
    setFlag('mobileUiV2', true);
    const { container } = render(<App initialUrl="/beschattung" />);
    const moreBtn = container.querySelector('[data-testid="mnav-more"]') as HTMLButtonElement;
    expect(moreBtn).not.toBeNull();

    fireEvent.click(moreBtn);
    expect(container.querySelector('[data-testid="mobile-more-sheet"]')).not.toBeNull();
    expect(moreBtn.getAttribute('aria-expanded')).toBe('true');

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(container.querySelector('[data-testid="mobile-more-sheet"]')).toBeNull();
  });
});
