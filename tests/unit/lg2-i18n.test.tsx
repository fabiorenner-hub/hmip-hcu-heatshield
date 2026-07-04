// @vitest-environment jsdom
/**
 * Bilingual (DE/EN) coverage of the v2 chrome + pages (ui-v2-release, Task 7).
 *
 * The whole Liquid Glass V2 surface must react to the per-device language
 * signal — no hard-coded monolingual strings. We drive `langPref` and assert
 * the sidebar nav + a native v2 page swap language accordingly.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import { h } from 'preact';

import { App } from '../../src/plugin/dashboard/spa/app.js';
import { setUiVersion } from '../../src/plugin/dashboard/spa/uiVersion.js';
import { setLangPref } from '../../src/plugin/dashboard/spa/i18n.js';
import { snapshot } from '../../src/plugin/dashboard/spa/store.js';

afterEach(() => {
  cleanup();
  snapshot.value = null;
  setUiVersion('v1');
  setLangPref('auto');
  document.body.classList.remove('ui-v2', 'lg2-demo-open');
});

describe('v2 chrome is bilingual', () => {
  it('renders the v2 sidebar nav in English when langPref = en', () => {
    setUiVersion('v2');
    setLangPref('en');
    const { container } = render(<App initialUrl="/uebersicht" />);
    const nav = container.querySelector('[data-testid="nav-module-uebersicht"]');
    expect(nav?.textContent).toContain('Overview');
    expect(nav?.textContent).not.toContain('Übersicht');
  });

  it('renders the v2 sidebar nav in German when langPref = de', () => {
    setUiVersion('v2');
    setLangPref('de');
    const { container } = render(<App initialUrl="/uebersicht" />);
    const nav = container.querySelector('[data-testid="nav-module-uebersicht"]');
    expect(nav?.textContent).toContain('Übersicht');
  });

  it('translates the native v2 Darstellung page title (EN)', () => {
    setUiVersion('v2');
    setLangPref('en');
    const { container } = render(<App initialUrl="/darstellung" />);
    const en = container.querySelector('[data-testid="liquid-glass2-darstellung"] .lg2-header__title');
    expect(en?.textContent).toBe('Appearance & Language');
  });

  it('translates the native v2 Darstellung page title (DE)', () => {
    setUiVersion('v2');
    setLangPref('de');
    const { container } = render(<App initialUrl="/darstellung" />);
    const de = container.querySelector('[data-testid="liquid-glass2-darstellung"] .lg2-header__title');
    expect(de?.textContent).toBe('Darstellung & Sprache');
  });
});
