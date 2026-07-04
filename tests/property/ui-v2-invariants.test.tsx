// @vitest-environment jsdom
/**
 * ui-v2-release — core routing/design invariants (Task 8, design §Correctness
 * Properties). Property-based (fast-check) checks over every canonical route ×
 * both UI versions.
 */

import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import { h } from 'preact';

import { App } from '../../src/plugin/dashboard/spa/app.js';
import { uiVersion, setUiVersion, type UiVersion } from '../../src/plugin/dashboard/spa/uiVersion.js';
import { expertMode, setExpertMode } from '../../src/plugin/dashboard/spa/expertMode.js';
import { snapshot } from '../../src/plugin/dashboard/spa/store.js';

const ROUTES = [
  '/uebersicht', '/raeume', '/vorhersage', '/garten', '/automatik', '/warnungen',
  '/einstellungen', '/system', '/rooms', '/sources', '/wizard', '/diagnostics',
  '/logs-debug', '/darstellung', '/benachrichtigungen', '/bewaesserung-einstellungen',
  '/messages', '/updates', '/hilfe',
] as const;

const versionArb = fc.constantFrom<UiVersion>('v1', 'v2');
const routeArb = fc.constantFrom(...ROUTES);

afterEach(() => {
  cleanup();
  snapshot.value = null;
  setUiVersion('v1');
  setExpertMode(false);
  document.body.classList.remove('ui-v2', 'lg2-demo-open');
});

describe('Property 2 — exactly one chrome', () => {
  it('never renders both the v1 top nav and the v2 sidebar', () => {
    fc.assert(
      fc.property(routeArb, versionArb, (route, v) => {
        setUiVersion(v);
        snapshot.value = null;
        const { container } = render(<App initialUrl={route} />);
        const header = container.querySelector('[data-testid="app-header"]');
        const sidebar = container.querySelector('[data-testid="lg2-sidebar"]');
        if (v === 'v2') {
          expect(header).toBeNull();
          expect(sidebar).not.toBeNull();
        } else {
          expect(sidebar).toBeNull();
          expect(header).not.toBeNull();
        }
        cleanup();
      }),
      { numRuns: 40 },
    );
  });
});

describe('Property 4 — no blank route', () => {
  it('renders a non-empty <main> for every route in both designs', () => {
    fc.assert(
      fc.property(routeArb, versionArb, (route, v) => {
        setUiVersion(v);
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
  it('yields the same design branch for the same route + version', () => {
    fc.assert(
      fc.property(routeArb, versionArb, (route, v) => {
        setUiVersion(v);
        snapshot.value = null;
        const a = render(<App initialUrl={route} />);
        const aV2 = a.container.querySelector('[data-testid="app-uiv2"]') !== null;
        cleanup();
        const b = render(<App initialUrl={route} />);
        const bV2 = b.container.querySelector('[data-testid="app-uiv2"]') !== null;
        cleanup();
        expect(aV2).toBe(bV2);
        expect(aV2).toBe(v === 'v2');
      }),
      { numRuns: 30 },
    );
  });
});

describe('Property 6 — mode persistence across design (pure signals)', () => {
  it('setting uiVersion never mutates expertMode and vice versa', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), versionArb, (em, em2, v) => {
        setExpertMode(em);
        setUiVersion(v);
        // Switching design must not touch expert mode.
        expect(expertMode.value).toBe(em);
        // Switching expert mode must not touch the design.
        setExpertMode(em2);
        expect(uiVersion.value).toBe(v);
      }),
    );
  });
});
