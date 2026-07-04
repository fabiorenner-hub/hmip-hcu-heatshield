// @vitest-environment jsdom
/**
 * App-shell a11y (Blueprint Phase 3): skip link + main landmark + labelled nav.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import { h } from 'preact';

import { App } from '../../src/plugin/dashboard/spa/app.js';
import { snapshot } from '../../src/plugin/dashboard/spa/store.js';

afterEach(() => {
  cleanup();
  snapshot.value = null;
});

describe('app shell a11y', () => {
  it('renders a skip link targeting the main landmark', () => {
    const { container } = render(<App initialUrl="/beschattung" />);
    const skip = container.querySelector('[data-testid="skip-link"]') as HTMLAnchorElement;
    expect(skip).not.toBeNull();
    expect(skip.getAttribute('href')).toBe('#main-content');
    const main = container.querySelector('#main-content');
    expect(main).not.toBeNull();
    expect(main!.tagName.toLowerCase()).toBe('main');
  });

  it('labels the module navigation', () => {
    const { container } = render(<App initialUrl="/beschattung" />);
    const nav = container.querySelector('[data-testid="module-nav"]');
    expect(nav!.getAttribute('aria-label')).not.toBeNull();
  });
});
