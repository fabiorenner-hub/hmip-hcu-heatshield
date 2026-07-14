// @vitest-environment jsdom
/**
 * AppShell + unified routing (v2-only reality, ui-v2-release).
 *
 * The classic v1 chrome is retired: one canonical route set always renders the
 * v2 left-sidebar "Liquid Glass" shell. Every canonical route now has a NATIVE
 * v2 page (no more `lg2-fallback`), and the v1↔v2 switch no longer exists. These
 * tests verify each route renders its native v2 page inside the sidebar shell
 * and that the retired v1 top-header chrome (`app-header`) never appears.
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

describe('AppShell (v2 sidebar is the sole chrome)', () => {
  it('renders the v2 sidebar shell for a native v2 page', () => {
    const { container } = render(<App initialUrl="/raeume" />);
    expect(container.querySelector('[data-testid="app-uiv2"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="lg2-sidebar"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="nav-module-raeume"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="liquid-glass2-raeume"]')).not.toBeNull();
    // Exactly one chrome: no retired v1 top header.
    expect(container.querySelector('[data-testid="app-header"]')).toBeNull();
  });

  it('renders a native v2 page for /building (no fallback wrapper)', () => {
    const { container } = render(<App initialUrl="/building" />);
    expect(container.querySelector('[data-testid="lg2-sidebar"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="liquid-glass2-building"]')).not.toBeNull();
    // Every route is native now — the legacy fallback wrapper is gone.
    expect(container.querySelector('[data-testid="lg2-fallback"]')).toBeNull();
    expect(container.querySelector('[data-testid="app-header"]')).toBeNull();
  });

  it('uses the v2 overview for the canonical /uebersicht route', () => {
    const { container } = render(<App initialUrl="/uebersicht" />);
    expect(container.querySelector('[data-testid="liquid-glass2-overview"]')).not.toBeNull();
  });
});

describe('native v2 settings pages (no fallback)', () => {
  it('renders the native v2 Darstellung page', () => {
    const { container } = render(<App initialUrl="/darstellung" />);
    expect(container.querySelector('[data-testid="liquid-glass2-darstellung"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="lg2-fallback"]')).toBeNull();
    // The retired v1 appearance tab and the v1↔v2 switch no longer exist.
    expect(container.querySelector('[data-testid="tab-appearance"]')).toBeNull();
  });

  it('renders the native v2 Einstellungen hub grid', () => {
    const { container } = render(<App initialUrl="/einstellungen" />);
    expect(container.querySelector('[data-testid="liquid-glass2-einstellungen"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="lg2-settings-grid"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="lg2-fallback"]')).toBeNull();
  });

  it('renders the native v2 Warnungen page (calm state without an alert)', () => {
    snapshot.value = null;
    const { container } = render(<App initialUrl="/warnungen" />);
    expect(container.querySelector('[data-testid="liquid-glass2-warnungen"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="lg2-warnungen-empty"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="lg2-fallback"]')).toBeNull();
  });

  it('renders native warning cards when an alert is active', () => {
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

  it('renders the v2 Darstellung page (v1 chrome is retired, not selectable)', () => {
    // The v1↔v2 switch is gone; there is no "v1 mode" to fall back to.
    const { container } = render(<App initialUrl="/darstellung" />);
    expect(container.querySelector('[data-testid="liquid-glass2-darstellung"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="app-header"]')).toBeNull();
  });
});

describe('every canonical route is native v2 (no lg2-fallback)', () => {
  it('renders /building inside the v2 sidebar shell as a native page', () => {
    snapshot.value = null;
    const { container } = render(<App initialUrl="/building" />);
    expect(container.querySelector('[data-testid="lg2-sidebar"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="liquid-glass2-building"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="lg2-fallback"]')).toBeNull();
    // Sole chrome: no v1 top header leaks into v2.
    expect(container.querySelector('[data-testid="app-header"]')).toBeNull();
  });

  it('renders the native v2 Updates page for /updates', () => {
    snapshot.value = null;
    const { container } = render(<App initialUrl="/updates" />);
    expect(container.querySelector('[data-testid="liquid-glass2-updates"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="lg2-fallback"]')).toBeNull();
  });

  it('renders the native v2 setup wizard for /wizard', () => {
    snapshot.value = null;
    const { container } = render(<App initialUrl="/wizard" />);
    expect(container.querySelector('[data-testid="lg2-sidebar"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="lg2-wizard"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="lg2-fallback"]')).toBeNull();
    expect(container.querySelector('[data-testid="app-header"]')).toBeNull();
  });

  it('reaches the Building Studio in v2 as a native page', () => {
    snapshot.value = null;
    const { container } = render(<App initialUrl="/building" />);
    expect(container.querySelector('[data-testid="lg2-sidebar"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="liquid-glass2-building"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="lg2-fallback"]')).toBeNull();
  });
});
