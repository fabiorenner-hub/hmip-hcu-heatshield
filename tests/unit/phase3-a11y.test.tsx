// @vitest-environment jsdom
/**
 * App-shell a11y (Blueprint Phase 3): skip link + main landmark + labelled nav,
 * migrated to the v2-only shell (ui-v2-release).
 *
 * The v2 "Liquid Glass" sidebar is now the sole chrome. Two of the three Phase-3
 * a11y guarantees are still met by the v2 shell and are asserted here against
 * the v2 markup:
 *   - a <main> landmark for the page content, and
 *   - a labelled primary navigation (the sidebar `lg2-nav` carries an aria-label).
 *
 * The THIRD guarantee — a keyboard "skip to content" link that targets the main
 * landmark — is currently MISSING from the v2 shell (see the note on the last
 * test). It lived only in the retired v1 top-header chrome (`app.tsx`), so it no
 * longer renders. Per the migration rules this is reported as a genuine v2 a11y
 * gap rather than papered over: the assertion is kept intact so the regression
 * stays visible until the skip link is restored in `Lg2Shell`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import { h } from 'preact';

import { App } from '../../src/plugin/dashboard/spa/app.js';
import { snapshot } from '../../src/plugin/dashboard/spa/store.js';

afterEach(() => {
  cleanup();
  snapshot.value = null;
  document.body.classList.remove('ui-v2', 'lg2-demo-open');
});

describe('app shell a11y (v2)', () => {
  it('renders a <main> landmark for the page content', () => {
    const { container } = render(<App initialUrl="/beschattung" />);
    const main = container.querySelector('main');
    expect(main).not.toBeNull();
    expect(main!.tagName.toLowerCase()).toBe('main');
  });

  it('labels the primary (sidebar) navigation', () => {
    const { container } = render(<App initialUrl="/beschattung" />);
    // The v2 sidebar's primary nav carries an accessible label.
    const nav = container.querySelector('[data-testid="lg2-sidebar"] nav');
    expect(nav).not.toBeNull();
    expect(nav!.getAttribute('aria-label')).not.toBeNull();
  });

  it('renders a skip link targeting the main landmark', () => {
    // GENUINE V2 A11Y GAP (reported, not papered over):
    // The v2 shell (Lg2Shell) does not render a "skip to content" link or an
    // id="main-content" target. This keyboard-a11y affordance existed only in
    // the retired v1 chrome. This assertion is intentionally left asserting the
    // required behaviour so the regression stays visible; fixing it requires a
    // change in src/ (Lg2Shell) which is out of scope for a test-only migration.
    const { container } = render(<App initialUrl="/beschattung" />);
    const skip = container.querySelector('[data-testid="skip-link"]') as HTMLAnchorElement | null;
    expect(skip).not.toBeNull();
    expect(skip!.getAttribute('href')).toBe('#main-content');
    const main = container.querySelector('#main-content');
    expect(main).not.toBeNull();
    expect(main!.tagName.toLowerCase()).toBe('main');
  });
});
