// @vitest-environment jsdom
/**
 * Mobile touch-first shell.
 *
 * The Apple-style bottom nav is now the DEFAULT at narrow widths (phones +
 * compact tablets, < 840px) where the vertical sidebar would otherwise collapse
 * into a cramped, cut-off all-tabs bar. The `mobileUiV2` flag additionally
 * forces it on wider tablet/desktop windows (everything below full desktop),
 * but it never activates at full desktop width. The bar exposes five targets
 * (4 primary + Mehr).
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

describe('mobile shell (automatic at narrow widths)', () => {
  it('is ON by default at phone width and shows 5 nav targets (no flag)', () => {
    const { container } = render(<App initialUrl="/beschattung" />);
    expect(container.querySelector('.app')!.classList.contains('app--mobile')).toBe(true);
    const nav = container.querySelector('[data-testid="mobile-nav"]');
    expect(nav).not.toBeNull();
    expect(nav!.querySelectorAll('.mobile-nav__item')).toHaveLength(5);
  });

  it('is ON by default at compact-tablet width (no flag)', () => {
    setWidth(700);
    const { container } = render(<App initialUrl="/beschattung" />);
    expect(container.querySelector('.app')!.classList.contains('app--mobile')).toBe(true);
    expect(container.querySelector('[data-testid="mobile-nav"]')).not.toBeNull();
  });

  it('is OFF at expanded-tablet width without the flag', () => {
    setWidth(1024);
    const { container } = render(<App initialUrl="/beschattung" />);
    expect(container.querySelector('.app')!.classList.contains('app--mobile')).toBe(false);
    expect(container.querySelector('[data-testid="mobile-nav"]')).toBeNull();
  });

  it('the flag extends it to expanded-tablet width', () => {
    setFlag('mobileUiV2', true);
    setWidth(1024);
    const { container } = render(<App initialUrl="/beschattung" />);
    expect(container.querySelector('.app')!.classList.contains('app--mobile')).toBe(true);
    expect(container.querySelector('[data-testid="mobile-nav"]')).not.toBeNull();
  });

  it('never activates at full desktop width, even with the flag', () => {
    setFlag('mobileUiV2', true);
    setWidth(1440);
    const { container } = render(<App initialUrl="/beschattung" />);
    expect(container.querySelector('.app')!.classList.contains('app--mobile')).toBe(false);
    expect(container.querySelector('[data-testid="mobile-nav"]')).toBeNull();
  });

  it('opens the "Mehr" sheet and closes it on Escape (a11y)', async () => {
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
