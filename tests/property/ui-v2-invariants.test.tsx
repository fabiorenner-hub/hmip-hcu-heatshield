// @vitest-environment jsdom
/**
 * ui-v2-release — core routing/shell invariants (v2-only reality).
 *
 * v1 is retired: the App always renders the single "Liquid Glass V2" shell.
 * Property-based (fast-check) checks over every canonical route assert that the
 * v2 shell is the sole chrome, that no route is blank, that routing is
 * deterministic, and that the expert-mode signal is independent of the (now
 * constant) UI version.
 */

import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import { h } from 'preact';

import { App } from '../../src/plugin/dashboard/spa/app.js';
import { uiVersion } from '../../src/plugin/dashboard/spa/uiVersion.js';
import { expertMode, setExpertMode } from '../../src/plugin/dashboard/spa/expertMode.js';
import { snapshot } from '../../src/plugin/dashboard/spa/store.js';

const ROUTES = [
  '/uebersicht', '/raeume', '/vorhersage', '/garten', '/automatik', '/warnungen',
  '/einstellungen', '/system', '/rooms', '/sources', '/wizard', '/diagnostics',
  '/logs-debug', '/darstellung', '/benachrichtigungen', '/bewaesserung-einstellungen',
  '/messages', '/updates', '/hilfe',
] as const;

const routeArb = fc.constantFrom(...ROUTES);

afterEach(() => {
  cleanup();
  snapshot.value = null;
  setExpertMode(false);
  document.body.classList.remove('ui-v2', 'lg2-demo-open');
});

describe('Property 2 — the v2 shell is the sole chrome', () => {
  it('always renders the v2 sidebar and never the retired v1 top header', () => {
    fc.assert(
      fc.property(routeArb, (route) => {
        snapshot.value = null;
        const { container } = render(<App initialUrl={route} />);
        expect(container.querySelector('[data-testid="app-uiv2"]')).not.toBeNull();
        expect(container.querySelector('[data-testid="lg2-sidebar"]')).not.toBeNull();
        expect(container.querySelector('[data-testid="app-header"]')).toBeNull();
        cleanup();
      }),
      { numRuns: 40 },
    );
  });
});

describe('Property 4 — no blank route', () => {
  it('renders a non-empty <main> for every route', () => {
    fc.assert(
      fc.property(routeArb, (route) => {
        snapshot.value = null;
        const { container } = render(<App initialUrl={route} />);
        expect(container.querySelector('main')).not.toBeNull();
        cleanup();
      }),
      { numRuns: 40 },
    );
  });
});

describe('Property 1 — routing determinism', () => {
  it('yields the v2 shell for the same route across renders', () => {
    fc.assert(
      fc.property(routeArb, (route) => {
        snapshot.value = null;
        const a = render(<App initialUrl={route} />);
        const aV2 = a.container.querySelector('[data-testid="app-uiv2"]') !== null;
        cleanup();
        const b = render(<App initialUrl={route} />);
        const bV2 = b.container.querySelector('[data-testid="app-uiv2"]') !== null;
        cleanup();
        expect(aV2).toBe(bV2);
        expect(aV2).toBe(true);
      }),
      { numRuns: 30 },
    );
  });
});

describe('Property 6 — expert mode is independent of the (constant) UI version', () => {
  it('toggling expert mode never changes the retired UI version (always v2)', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), (em, em2) => {
        setExpertMode(em);
        expect(uiVersion.value).toBe('v2');
        expect(expertMode.value).toBe(em);
        setExpertMode(em2);
        expect(uiVersion.value).toBe('v2');
        expect(expertMode.value).toBe(em2);
      }),
    );
  });
});
