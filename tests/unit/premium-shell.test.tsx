// @vitest-environment jsdom
/**
 * Premium desktop/tablet shell (ui-v2-release).
 *
 * The v1-only `app--premium` chrome class is retired: the "Liquid Glass V2"
 * shell IS the premium shell now, and it is always what the App renders. These
 * tests verify that at tablet-or-wider width (jsdom default 1024 = tablet-up)
 * the App mounts the v2 sidebar shell (`app-uiv2` + `lg2-sidebar`) and that the
 * retired v1 `app--premium`/`app-header` chrome never appears.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import { h } from 'preact';

import { App } from '../../src/plugin/dashboard/spa/app.js';
import { snapshot } from '../../src/plugin/dashboard/spa/store.js';

afterEach(() => {
  cleanup();
  snapshot.value = null;
  try {
    window.localStorage.clear();
  } catch {
    /* ignore */
  }
  document.body.classList.remove('ui-v2', 'lg2-demo-open');
});

describe('premium (v2) shell', () => {
  it('renders the v2 Liquid Glass shell at tablet-up width', () => {
    const { container } = render(<App initialUrl="/beschattung" />);
    expect(container.querySelector('[data-testid="app-uiv2"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="lg2-sidebar"]')).not.toBeNull();
  });

  it('never renders the retired v1 premium chrome', () => {
    const { container } = render(<App initialUrl="/beschattung" />);
    const root = container.querySelector('.app');
    expect(root).not.toBeNull();
    // `app--premium` was a v1-only class; it must not appear in the v2-only UI.
    expect(root!.classList.contains('app--premium')).toBe(false);
    expect(container.querySelector('[data-testid="app-header"]')).toBeNull();
  });
});
