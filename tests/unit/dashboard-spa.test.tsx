// @vitest-environment jsdom
/**
 * Unit tests for the dashboard SPA components (Tasks 11.1–11.4).
 *
 * The suite uses `@testing-library/preact` against a JSDOM
 * environment. We keep the assertions structural — DOM attributes,
 * counts, viewBox shapes — rather than visual, so the tests stay
 * stable across CSS tweaks during the design pass that lands later.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import { h } from 'preact';

import { App } from '../../src/plugin/dashboard/spa/app.js';
import { ModeHeader } from '../../src/plugin/dashboard/spa/components/modeHeader.js';
import { RiskBar } from '../../src/plugin/dashboard/spa/components/riskBar.js';
import { SunPolarPlot } from '../../src/plugin/dashboard/spa/components/sunPolarPlot.js';
import { WindowCard } from '../../src/plugin/dashboard/spa/components/windowCard.js';
import {
  setRiskBreakdowns,
  snapshot,
} from '../../src/plugin/dashboard/spa/store.js';
import type {
  DashboardSnapshot,
  WindowRiskBreakdown,
} from '../../src/plugin/dashboard/spa/types.js';

const FIXTURE_SNAPSHOT: DashboardSnapshot = {
  ts: '2025-06-21T12:00:00.000Z',
  mode: 'NORMAL',
  rooms: [],
  windows: [
    {
      id: 'w1',
      currentLevel01: 0.5,
      manualOverrideUntil: null,
      lastDecisionMode: 'NORMAL',
    },
  ],
  sources: {
    fusionSolar: {
      sourceOk: true,
      lastSuccess: '2025-06-21T12:00:00.000Z',
      consecutiveFailures: 0,
    },
    hcu: { connected: true },
  },
  userIntent: { paused: false, pauseUntil: null, vacation: false },
  storm: { holdUntil: null },
  pluginReadiness: 'READY',
};

afterEach(() => {
  cleanup();
  // Reset shared signal store between cases so fixtures don't leak.
  snapshot.value = null;
  setRiskBreakdowns([]);
});

describe('App tab nav (v2 sidebar)', () => {
  it('renders the primary modules with Übersicht active on /', () => {
    snapshot.value = FIXTURE_SNAPSHOT;
    const { container } = render(<App initialUrl="/" />);
    const modules = container.querySelectorAll('[data-testid^="nav-module-"]');
    // 6 primary; Warnungen only appears when an alert is active.
    expect(modules.length).toBe(6);
    // The v2 sidebar marks the active module with `lg2-nav__item--active`.
    const uebersicht = container.querySelector('[data-testid="nav-module-uebersicht"]');
    expect(uebersicht?.className).toContain('lg2-nav__item--active');
    const raeume = container.querySelector('[data-testid="nav-module-raeume"]');
    expect(raeume?.className).not.toContain('lg2-nav__item--active');
  });

  it('declares every top-level module', () => {
    snapshot.value = FIXTURE_SNAPSHOT;
    const { container } = render(<App initialUrl="/" />);
    const expectedModules = [
      'nav-module-uebersicht',
      'nav-module-raeume',
      'nav-module-vorhersage',
      'nav-module-garten',
      'nav-module-automatik',
      'nav-module-einstellungen',
    ];
    for (const id of expectedModules) {
      expect(container.querySelector(`[data-testid="${id}"]`)).not.toBeNull();
    }
  });
});

describe('App module routing (native v2 pages, active-module map)', () => {
  it('keeps the primary modules with their icons', () => {
    snapshot.value = FIXTURE_SNAPSHOT;
    const { container } = render(<App initialUrl="/uebersicht" />);
    const modules = container.querySelectorAll('[data-testid^="nav-module-"]');
    expect(modules.length).toBe(6);
    // Each v2 sidebar nav item renders its inline icon (one <svg> per module).
    expect(container.querySelectorAll('[data-testid^="nav-module-"] svg').length).toBe(6);
  });

  it('routes /vorhersage to the native v2 forecast page and highlights Vorhersage', () => {
    snapshot.value = FIXTURE_SNAPSHOT;
    const { container } = render(<App initialUrl="/vorhersage" />);
    expect(container.querySelector('[data-testid="liquid-glass2-vorhersage"]')).not.toBeNull();
    expect(
      container.querySelector('[data-testid="nav-module-vorhersage"]')?.className,
    ).toContain('lg2-nav__item--active');
  });

  it('routes /automatik to the native v2 Automatik page and highlights Automatik', () => {
    snapshot.value = FIXTURE_SNAPSHOT;
    const { container } = render(<App initialUrl="/automatik" />);
    expect(container.querySelector('[data-testid="liquid-glass2-automatik"]')).not.toBeNull();
    expect(
      container.querySelector('[data-testid="nav-module-automatik"]')?.className,
    ).toContain('lg2-nav__item--active');
  });

  it('routes /einstellungen to the native v2 settings hub with sub-links', () => {
    snapshot.value = FIXTURE_SNAPSHOT;
    const { container } = render(<App initialUrl="/einstellungen" />);
    expect(container.querySelector('[data-testid="liquid-glass2-einstellungen"]')).not.toBeNull();
    for (const id of [
      'settings-link-rooms',
      'settings-link-sources',
      'settings-link-wizard',
      'settings-link-diagnostics',
      'settings-link-messages',
    ]) {
      expect(container.querySelector(`[data-testid="${id}"]`)).not.toBeNull();
    }
    expect(
      container.querySelector('[data-testid="nav-module-einstellungen"]')?.className,
    ).toContain('lg2-nav__item--active');
  });

  it('keeps the legacy /rooms route working under the Einstellungen highlight', () => {
    snapshot.value = FIXTURE_SNAPSHOT;
    const { container } = render(<App initialUrl="/rooms" />);
    // /rooms now renders the native v2 rooms page; the route-map keeps
    // Einstellungen highlighted.
    expect(container.querySelector('[data-testid="liquid-glass2-rooms"]')).not.toBeNull();
    expect(
      container.querySelector('[data-testid="nav-module-einstellungen"]')?.className,
    ).toContain('lg2-nav__item--active');
  });

  it('consolidates rooms, ventilation and climate under Räume', () => {
    snapshot.value = FIXTURE_SNAPSHOT;
    const { container } = render(<App initialUrl="/raeume" />);
    // Rooms/ventilation/climate are consolidated into the native v2 Räume page.
    expect(container.querySelector('[data-testid="liquid-glass2-raeume"]')).not.toBeNull();
    expect(
      container.querySelector('[data-testid="nav-module-raeume"]')?.className,
    ).toContain('lg2-nav__item--active');
  });

  it('keeps legacy routes redirect-compatible (Übersicht active for /beschattung)', () => {
    snapshot.value = FIXTURE_SNAPSHOT;
    const { container } = render(<App initialUrl="/beschattung" />);
    // MODULE_ROUTE_MAP keeps Übersicht highlighted for the legacy path while the
    // <Redirect> navigates to /uebersicht.
    expect(
      container.querySelector('[data-testid="nav-module-uebersicht"]')?.className,
    ).toContain('lg2-nav__item--active');
  });
});

describe('ModeHeader (Task 11.4)', () => {
  it('renders STORM mode with a warning icon and data-mode="STORM"', () => {
    const { container } = render(
      <ModeHeader mode="STORM" connection="open" nextCycleInSeconds={42} />,
    );
    const header = container.querySelector('[data-testid="mode-header"]');
    expect(header).not.toBeNull();
    expect(header?.getAttribute('data-mode')).toBe('STORM');
    expect(header?.className).toContain('mode-header--storm');
    const warning = container.querySelector('[data-testid="storm-warning"]');
    expect(warning).not.toBeNull();
  });

  it('shows the next-cycle countdown and connection state pill', () => {
    const { container } = render(
      <ModeHeader mode="NORMAL" connection="reconnecting" nextCycleInSeconds={120} />,
    );
    const cycle = container.querySelector('[data-testid="cycle-countdown"]');
    expect(cycle?.textContent).toContain('120');
    const conn = container.querySelector('[data-testid="connection-state"]');
    expect(conn?.textContent).toContain('verbinde neu');
  });

  it('renders the maintenance wrench icon for MAINTENANCE mode', () => {
    const { container } = render(
      <ModeHeader mode="MAINTENANCE" connection="open" nextCycleInSeconds={null} />,
    );
    const header = container.querySelector('[data-testid="mode-header"]');
    expect(header?.getAttribute('data-mode')).toBe('MAINTENANCE');
    expect(header?.className).toContain('mode-header--maintenance');
    expect(header?.textContent).toContain('🔧');
  });
});

describe('WindowCard (Task 11.2)', () => {
  it('renders the SVG shutter at the right height for currentLevel01: 0.5', () => {
    const { container } = render(
      <WindowCard
        window={{
          id: 'w1',
          currentLevel01: 0.5,
          manualOverrideUntil: null,
          lastDecisionMode: 'NORMAL',
        }}
        risk={null}
      />,
    );
    const svg = container.querySelector('[data-testid="shutter-svg"]');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('viewBox')).toBe('0 0 240 120');
    const slats = container.querySelectorAll('[data-testid="shutter-slats"] rect');
    expect(slats.length).toBe(12);
    const slatsGroup = container.querySelector('[data-testid="shutter-slats"]');
    // At 50% closed, the group is translated by -120 + 0.5 * 120 = -60px.
    const style = (slatsGroup as HTMLElement | null)?.getAttribute('style') ?? '';
    expect(style).toContain('translateY(-60px)');
  });

  it('shows the manual override badge when manualOverrideUntil is in the future', () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    const { container } = render(
      <WindowCard
        window={{
          id: 'w2',
          currentLevel01: 0,
          manualOverrideUntil: future,
          lastDecisionMode: null,
        }}
        risk={null}
      />,
    );
    expect(container.querySelector('[data-testid="manual-override-badge"]')).not.toBeNull();
  });

  it('renders current and target percentages from risk', () => {
    const breakdown: WindowRiskBreakdown = {
      windowId: 'w1',
      factors: { sunFactor: 0.5 },
      weights: { sunFactor: 0.4 },
      risk: 0.2,
      rawTarget: 0.7,
      finalTarget: 0.7,
      mode: 'ACTIVE_HEAT_PROTECTION',
    };
    const { container } = render(
      <WindowCard
        window={{
          id: 'w1',
          currentLevel01: 0.3,
          manualOverrideUntil: null,
          lastDecisionMode: 'ACTIVE_HEAT_PROTECTION',
        }}
        risk={breakdown}
      />,
    );
    const current = container.querySelector('[data-testid="current-level"]');
    const target = container.querySelector('[data-testid="target-level"]');
    expect(current?.textContent).toBe('30%');
    expect(target?.textContent).toBe('70%');
  });
});

describe('RiskBar (Task 11.2)', () => {
  it('renders 8 segments and the canonical factor order', () => {
    const breakdown: WindowRiskBreakdown = {
      windowId: 'w1',
      factors: {
        sunFactor: 0.5,
        roomTempFactor: 0.5,
      },
      weights: {
        sunFactor: 0.4,
        roomTempFactor: 0.2,
      },
      risk: 0.4,
      rawTarget: 0.6,
      finalTarget: 0.6,
      mode: 'ACTIVE_HEAT_PROTECTION',
    };
    const { container } = render(<RiskBar breakdown={breakdown} />);
    const segments = container.querySelectorAll('.risk-bar__segment');
    expect(segments.length).toBe(8);
    expect(segments[0]?.getAttribute('data-factor')).toBe('sunFactor');
    expect(segments[7]?.getAttribute('data-factor')).toBe('priorityFactor');
  });

  it('reports total width 100% when every factor and weight is 1', () => {
    const breakdown: WindowRiskBreakdown = {
      windowId: 'w1',
      factors: {
        sunFactor: 1,
        roomTempFactor: 1,
        windowTypeFactor: 1,
        forecastTempFactor: 1,
        pvFactor: 1,
        radiationFactor: 1,
        outdoorTempFactor: 1,
        priorityFactor: 1,
      },
      weights: {
        sunFactor: 0.125,
        roomTempFactor: 0.125,
        windowTypeFactor: 0.125,
        forecastTempFactor: 0.125,
        pvFactor: 0.125,
        radiationFactor: 0.125,
        outdoorTempFactor: 0.125,
        priorityFactor: 0.125,
      },
      risk: 1,
      rawTarget: 1,
      finalTarget: 1,
      mode: 'HEATWAVE',
    };
    const { container } = render(<RiskBar breakdown={breakdown} />);
    const segments = container.querySelectorAll<HTMLElement>('.risk-bar__segment');
    let total = 0;
    for (const seg of Array.from(segments)) {
      const widthMatch = (seg.getAttribute('style') ?? '').match(/width:\s*([\d.]+)%/);
      if (widthMatch?.[1] !== undefined) {
        total += Number.parseFloat(widthMatch[1]);
      }
    }
    expect(Math.round(total)).toBe(100);
  });
});

describe('SunPolarPlot (Task 11.3)', () => {
  it('renders the horizon circle and a current-position dot for daytime', () => {
    // Beispielstadt, summer noon — sun definitely above horizon.
    const noon = new Date('2025-06-21T10:00:00.000Z');
    const { container } = render(
      <SunPolarPlot latitude={52.52} longitude={13.41} now={noon} />,
    );
    expect(container.querySelector('[data-testid="sun-horizon"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="sun-dot"]')).not.toBeNull();
  });

  it('omits the current-position dot at night', () => {
    // Beispielstadt, winter midnight — sun well below horizon.
    const midnight = new Date('2025-12-21T23:00:00.000Z');
    const { container } = render(
      <SunPolarPlot latitude={52.52} longitude={13.41} now={midnight} />,
    );
    expect(container.querySelector('[data-testid="sun-dot"]')).toBeNull();
    // The dashed below-horizon trajectory should be present.
    expect(container.querySelector('[data-testid="sun-trajectory-night"]')).not.toBeNull();
  });
});
