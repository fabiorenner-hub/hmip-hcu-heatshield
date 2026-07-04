// @vitest-environment jsdom
/**
 * AppShell + unified routing (ui-v2-release, Task 4).
 *
 * One canonical route set renders EITHER the v1 top-header chrome or the v2
 * left-sidebar shell, chosen purely by the `uiVersion` signal. Verifies the
 * design switch on the same route, the v1-content fallback inside the v2 shell,
 * and Property 2 ("exactly one chrome" — never both at once).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import { h } from 'preact';

import { App } from '../../src/plugin/dashboard/spa/app.js';
import { setUiVersion } from '../../src/plugin/dashboard/spa/uiVersion.js';
import { snapshot } from '../../src/plugin/dashboard/spa/store.js';

afterEach(() => {
  cleanup();
  snapshot.value = null;
  setUiVersion('v1');
  document.body.classList.remove('ui-v2', 'lg2-demo-open');
});

describe('AppShell design switch', () => {
  it('renders the v1 top-header chrome by default', () => {
    setUiVersion('v1');
    const { container } = render(<App initialUrl="/raeume" />);
    expect(container.querySelector('[data-testid="app-header"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="nav-module-raeume"]')).not.toBeNull();
    // Exactly one chrome: no v2 sidebar in v1.
    expect(container.querySelector('[data-testid="lg2-sidebar"]')).toBeNull();
    expect(container.querySelector('[data-testid="app-uiv2"]')).toBeNull();
  });

  it('renders the v2 sidebar shell for a native v2 page', () => {
    setUiVersion('v2');
    const { container } = render(<App initialUrl="/raeume" />);
    expect(container.querySelector('[data-testid="app-uiv2"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="lg2-sidebar"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="liquid-glass2-raeume"]')).not.toBeNull();
    // Exactly one chrome: no v1 top header in v2.
    expect(container.querySelector('[data-testid="app-header"]')).toBeNull();
  });

  it('falls back to the v1 content inside the v2 shell for pages without a v2 variant', () => {
    setUiVersion('v2');
    const { container } = render(<App initialUrl="/system" />);
    expect(container.querySelector('[data-testid="lg2-sidebar"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="lg2-fallback"]')).not.toBeNull();
    // Still no v1 top header — the sidebar is the sole chrome.
    expect(container.querySelector('[data-testid="app-header"]')).toBeNull();
  });

  it('uses the v2 overview for the canonical /uebersicht route', () => {
    setUiVersion('v2');
    const { container } = render(<App initialUrl="/uebersicht" />);
    expect(container.querySelector('[data-testid="liquid-glass2-overview"]')).not.toBeNull();
  });
});

describe('native v2 settings pages (no fallback)', () => {
  it('renders the native v2 Darstellung page with the UI switch', () => {
    setUiVersion('v2');
    const { container } = render(<App initialUrl="/darstellung" />);
    expect(container.querySelector('[data-testid="liquid-glass2-darstellung"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="lg2-uiversion"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="lg2-fallback"]')).toBeNull();
  });

  it('renders the native v2 Einstellungen hub grid', () => {
    setUiVersion('v2');
    const { container } = render(<App initialUrl="/einstellungen" />);
    expect(container.querySelector('[data-testid="liquid-glass2-einstellungen"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="lg2-settings-grid"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="lg2-fallback"]')).toBeNull();
  });

  it('renders the native v2 Warnungen page (calm state without an alert)', () => {
    setUiVersion('v2');
    snapshot.value = null;
    const { container } = render(<App initialUrl="/warnungen" />);
    expect(container.querySelector('[data-testid="liquid-glass2-warnungen"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="lg2-warnungen-empty"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="lg2-fallback"]')).toBeNull();
  });

  it('renders native warning cards when an alert is active (Task fix)', () => {
    setUiVersion('v2');
    snapshot.value = {
      weatherAlert: {
        active: true, maxLevel: 3, region: 'Berlin', updatedTs: '',
        warnings: [{ level: 3, event: 'STURMBÖEN', headline: 'Amtliche WARNUNG vor STURMBÖEN', description: 'Sturmböen bis 70 km/h.', instruction: 'Objekte sichern.', start: null, end: null }],
      },
    } as unknown as import('../../src/plugin/dashboard/spa/types.js').DashboardSnapshot;
    const { container } = render(<App initialUrl="/warnungen" />);
    // Graphical redesign: severe warning renders the hero + list rows.
    expect(container.querySelector('[data-testid="lg2-warnhero"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="lg2-warnrow"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="lg2-warnungen-empty"]')).toBeNull();
  });

  it('keeps these pages on v1 chrome in v1 mode', () => {
    setUiVersion('v1');
    const { container } = render(<App initialUrl="/darstellung" />);
    expect(container.querySelector('[data-testid="tab-appearance"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="liquid-glass2-darstellung"]')).toBeNull();
  });
});

describe('v2 fallback skin (Task 5.4) covers the remaining settings pages', () => {
  const FALLBACK_ROUTES = [
    '/rooms', '/sources', '/diagnostics', '/system', '/logs-debug',
    '/benachrichtigungen', '/bewaesserung-einstellungen', '/messages', '/updates', '/hilfe',
  ];
  for (const r of FALLBACK_ROUTES) {
    it(`renders ${r} inside the v2 sidebar shell via the skinned fallback`, () => {
      setUiVersion('v2');
      snapshot.value = null;
      const { container } = render(<App initialUrl={r} />);
      expect(container.querySelector('[data-testid="lg2-sidebar"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="lg2-fallback"]')).not.toBeNull();
      // Sole chrome: no v1 top header leaks into v2.
      expect(container.querySelector('[data-testid="app-header"]')).toBeNull();
    });
  }

  it('renders the native v2 setup wizard (not the fallback) for /wizard', () => {
    setUiVersion('v2');
    snapshot.value = null;
    const { container } = render(<App initialUrl="/wizard" />);
    expect(container.querySelector('[data-testid="lg2-sidebar"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="lg2-wizard"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="lg2-fallback"]')).toBeNull();
    expect(container.querySelector('[data-testid="app-header"]')).toBeNull();
  });

  it('reaches the Building Studio in v2 (expert access via fallback, Task 9.4)', () => {
    setUiVersion('v2');
    snapshot.value = null;
    const { container } = render(<App initialUrl="/building" />);
    expect(container.querySelector('[data-testid="lg2-sidebar"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="lg2-fallback"]')).not.toBeNull();
  });
});
