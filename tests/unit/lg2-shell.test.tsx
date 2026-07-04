// @vitest-environment jsdom
/**
 * Liquid Glass V2 app-wide shell chrome (ui-v2-release, Task 3).
 *
 * Verifies the sidebar is the sole v2 navigation: canonical module nav with
 * URL-derived active state, version badge, message bell, freshness chip,
 * automation lever, Basic/Expert switch and the conditional Warnungen entry.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import { h } from 'preact';

import { Lg2Shell } from '../../src/plugin/dashboard/spa/components/liquidglass2/shell/lg2Shell.js';
import { snapshot } from '../../src/plugin/dashboard/spa/store.js';
import { setExpertMode } from '../../src/plugin/dashboard/spa/expertMode.js';
import type { DashboardSnapshot } from '../../src/plugin/dashboard/spa/types.js';

afterEach(() => {
  cleanup();
  snapshot.value = null;
  setExpertMode(false);
});

describe('Lg2Shell chrome', () => {
  it('renders the sidebar with all canonical modules and chrome', () => {
    const { container } = render(
      <Lg2Shell currentUrl="/raeume"><main class="lg2-main" /></Lg2Shell>,
    );
    expect(container.querySelector('[data-testid="lg2-sidebar"]')).not.toBeNull();
    for (const id of ['nav-module-uebersicht', 'nav-module-raeume', 'nav-module-vorhersage', 'nav-module-garten', 'nav-module-automatik', 'nav-module-einstellungen']) {
      expect(container.querySelector(`[data-testid="${id}"]`)).not.toBeNull();
    }
    expect(container.querySelector('[data-testid="lg2-version"]')).not.toBeNull();
    // Messages live in the sidebar foot; the automation lever moved to the
    // Übersicht/Automatik page headers (not the sidebar).
    expect(container.querySelector('[data-testid="lg2-messages"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="lg2-automation-lever"]')).toBeNull();
    expect(container.querySelector('[data-testid="lg2-mode-switch"]')).not.toBeNull();
  });

  it('marks the module matching the current URL as active', () => {
    const { container } = render(
      <Lg2Shell currentUrl="/vorhersage"><main /></Lg2Shell>,
    );
    const active = container.querySelector('.lg2-nav__item--active');
    expect(active?.getAttribute('data-testid')).toBe('nav-module-vorhersage');
  });

  it('adds the app-wide ui-v2 body class while mounted', () => {
    render(<Lg2Shell currentUrl="/uebersicht"><main /></Lg2Shell>);
    expect(document.body.classList.contains('ui-v2')).toBe(true);
  });

  it('hides the Warnungen entry unless an alert is active', () => {
    const { container } = render(
      <Lg2Shell currentUrl="/uebersicht"><main /></Lg2Shell>,
    );
    expect(container.querySelector('[data-testid="nav-module-warnungen"]')).toBeNull();
  });

  it('shows the Warnungen entry when a weather alert is active', () => {
    snapshot.value = { weatherAlert: { active: true } } as unknown as DashboardSnapshot;
    const { container } = render(
      <Lg2Shell currentUrl="/uebersicht"><main /></Lg2Shell>,
    );
    expect(container.querySelector('[data-testid="nav-module-warnungen"]')).not.toBeNull();
  });

  it('applies the expert-scroll class on the shell root only in expert mode (Task 9.1)', () => {
    setExpertMode(false);
    const basic = render(<Lg2Shell currentUrl="/uebersicht"><main /></Lg2Shell>);
    expect(basic.container.querySelector('.lg2-demo.lg2-expert-on')).toBeNull();
    cleanup();

    setExpertMode(true);
    const expert = render(<Lg2Shell currentUrl="/uebersicht"><main /></Lg2Shell>);
    expect(expert.container.querySelector('.lg2-demo.lg2-expert-on')).not.toBeNull();
  });
});
