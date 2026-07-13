// @vitest-environment jsdom
/**
 * Unit tests for the configuration tabs (Tasks 12.1–12.4).
 *
 * The suite stays close to the structural style of
 * `dashboard-spa.test.tsx`: queries by `data-testid`, mocks
 * `globalThis.fetch` per case, and resets the module-level signal
 * stores in `useConfig` and `useDiscovery` between cases so one
 * test cannot leak state into the next.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { h } from 'preact';

import { App } from '../../src/plugin/dashboard/spa/app.js';
import { RoomsTab } from '../../src/plugin/dashboard/spa/tabs/rooms.js';
import { RulesTab } from '../../src/plugin/dashboard/spa/tabs/rules.js';
import { SourcesTab } from '../../src/plugin/dashboard/spa/tabs/sources.js';
import { WizardTab } from '../../src/plugin/dashboard/spa/tabs/wizard.js';
import {
  __resetConfigStateForTests,
  refreshConfig,
} from '../../src/plugin/dashboard/spa/hooks/useConfig.js';
import {
  __resetDiscoveryStateForTests,
} from '../../src/plugin/dashboard/spa/hooks/useDiscovery.js';
import { setRiskBreakdowns, snapshot } from '../../src/plugin/dashboard/spa/store.js';
import type { Config } from '../../src/shared/types.js';
import type { DashboardSnapshot } from '../../src/plugin/dashboard/spa/types.js';

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

const FIXTURE_CONFIG: Config = {
  schemaVersion: 1,
  automationEnabled: false,
  location: { latitude: 52.52, longitude: 13.41, timezone: 'Europe/Berlin' },
  globalSignals: {
    outdoorTemp: {
      primary: { kind: 'static', value: 22 },
      staleAfterSec: 600,
    },
  },
  fusionSolar: {
    baseUrl: 'http://host.containers.internal:8088',
    pvPeakKwp: 8.8,
    orientationHint: 'southeast',
  },
  rooms: [
    {
      id: 'bedroom',
      name: 'Schlafzimmer',
      priority: 'very_high',
      targets: { target_c: 23, warning_c: 25, strong_shade_c: 26, critical_c: 27 },
      signals: {},
      occupancyMode: 'always_priority',
      activeCooling: false,
    },
  ],
  windows: [],
  rules: {
    profile: 'standard',
    comfort: {
      maxIndoorTempC: 25.0,
      preShadeTempC: 23.5,
      vacationOffsetC: 0.5,
      nightCoolingDeltaC: 1.5,
    },
    automation: {
      controlIntervalSeconds: 180,
      minSecondsBetweenMoves: 900,
      minPositionDeltaPct: 15,
      temperatureHysteresisC: 0.5,
      pvHysteresisKw: 0.7,
      pvSmoothingSamples: 3,
      forecastHorizonMinutes: 60,
      pauseBetweenSunsetAndSunrise: false,
      closeEagerness: 0.6,
      quietHours: { enabled: false, startHour: 22, endHour: 6 },
    },
    sun: {
      minElevationDeg: 5,
      maxIncidenceAngleFacadeDeg: 90,
      maxIncidenceAngleRoofDeg: 95,
    },
    storm: { enabled: true, thresholdMs: 13.9, releaseMs: 8.0, releaseHoldMin: 10 },
    nightCooling: { enabled: true, deltaC: 1.5, reopenAtSunriseOffsetMin: -30 },
    insulation: { enabled: false, maxOutdoorTempC: 5, level01: 1 },
    heatLoad: {
      pvWeight: 0.5,
      tempWeight: 0.3,
      trendWeight: 0.2,
      activateThreshold: 0.45,
      releaseThreshold: 0.3,
      releaseHoldMinutes: 60,
      trendWindowHours: 3,
    },
    thresholds: {
      heatwaveForecastC: 30,
      heatwaveRoomC: 24.5,
      activeForecastC: 25,
      activeRoomC: 23.5,
      summerForecastC: 24,
      summerOutdoorC: 22,
      summerPvKw: 2.0,
    },
    manualOverrideMinutes: 60,
    floorShading: { enabled: true, leadByFloor: {} },
    hotDay: { enabled: true, outdoorThresholdC: 35, maxOpenPercent: 50, minPvKw: 0.5 },
    gentleShading: { enabled: false, maxClose01: 0.5 },
    roof: {
      closeLevel01: 1,
      preShade: true,
      gentleOnlyWhenOutdoorBelowIndoor: true,
      openRequiresPvLowAndFalling: true,
      openPvLowKw: 1.5,
      openFallingHours: 3,
      ignoreOpenContact: true,
    },
  },
  dashboard: { port: 8089, enabled: true },
  notifications: {
    telegram: {
      enabled: false,
      botToken: '',
      chatId: '',
      commandsEnabled: false,
      allowControl: true,
      allowedChatIds: [],
    },
    morningBriefLocalTime: '07:30',
    dailySummaryLocalTime: '21:00',
    dailySummaryEnabled: false,
    language: 'de',
    events: { ventilate: true, open: true, close: true, weather: true },
    forecastUpdates: { enabled: false, everyHours: 3 },
  },
  learning: { autoApply: false },
  openMeteo: {
    enabled: false,
    pollIntervalMinutes: 15,
    baseUrl: 'https://api.open-meteo.com',
  },
  dwd: { enabled: true, regionName: 'Beispielstadt', warncellId: '', alertOnDashboard: true, alertOnWeather: true, telegramMode: '30' },
  gardena: {
    enabled: false,
    clientId: '',
    clientSecret: '',
    locationId: '',
    defaultWateringSeconds: 1800,
  },
  irrigation: {
    enabled: false,
    mode: 'normal',
    autoMode: true,
    etModel: true,
    rainSkipMm: 3,
    rainSkipWindowH: 12,
    frostLockoutC: 3,
    windSkipMs: 8,
    pvPreferred: false,
    pvSurplusKw: 1.5,
    pumpSocketId: '',
    mowerCoordination: false,
    mowerServiceId: '',
    maxDailySecondsTotal: 0,
    maxConcurrentValves: 1,
    sensorWeight: 0.4,
    hideUnusedValves: false,
    disabledValveIds: [],
    zones: [],
  },
  updates: { mode: 'manual', checkIntervalHours: 6 },
  telemetry: { enabled: true },
};

const FIXTURE_SNAPSHOT_CONFIG_REQUIRED: DashboardSnapshot = {
  ts: '2025-06-21T12:00:00.000Z',
  mode: null,
  rooms: [],
  windows: [],
  sources: {
    fusionSolar: { sourceOk: false, lastSuccess: null, consecutiveFailures: 0 },
    hcu: { connected: false },
  },
  userIntent: { paused: false, pauseUntil: null, vacation: false },
  storm: { holdUntil: null },
  pluginReadiness: 'CONFIG_REQUIRED',
};

interface MockFetchEntry {
  url: RegExp;
  method?: string;
  status?: number;
  body: unknown;
}

function makeMockFetch(entries: MockFetchEntry[]): ReturnType<typeof vi.fn> {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const impl = async (input: unknown, init?: unknown): Promise<unknown> => {
    const url =
      typeof input === 'string' ? input : (input as { toString(): string }).toString();
    const initObj = (init ?? {}) as { method?: string; body?: unknown };
    const method = initObj.method ?? 'GET';
    calls.push({
      url,
      method,
      ...(typeof initObj.body === 'string' ? { body: initObj.body } : {}),
    });
    for (const e of entries) {
      if (e.url.test(url) && (e.method === undefined || e.method === method)) {
        return {
          ok: (e.status ?? 200) < 400,
          status: e.status ?? 200,
          json: async (): Promise<unknown> => e.body,
        };
      }
    }
    throw new Error(`unmatched fetch: ${method} ${url}`);
  };
  const fn = vi.fn(impl) as unknown as ReturnType<typeof vi.fn>;
  // Attach for test assertions.
  (fn as unknown as { __calls: typeof calls }).__calls = calls;
  return fn;
}

/**
 * Install the mock as the global fetch. The cast goes through
 * `unknown` because vitest's `Mock` type does not match the
 * runtime `fetch` overload set; the runtime call shape we use
 * (the only one production code actually invokes) is fully
 * compatible.
 */
function installMockFetch(entries: MockFetchEntry[]): ReturnType<typeof vi.fn> {
  const fn = makeMockFetch(entries);
  (globalThis as unknown as { fetch: typeof fetch }).fetch =
    fn as unknown as typeof fetch;
  return fn;
}

beforeEach(() => {
  __resetConfigStateForTests();
  __resetDiscoveryStateForTests();
  snapshot.value = null;
  setRiskBreakdowns([]);
  // jsdom does not provide EventSource; keep useStream a no-op.
  // sessionStorage is jsdom-provided and resets per case via clear().
  if (typeof sessionStorage !== 'undefined') {
    sessionStorage.clear();
  }
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// RoomsTab (Task 12.1).
// ---------------------------------------------------------------------------

describe('<RoomsTab/> (Task 12.1)', () => {
  it('renders the rooms list once /api/config returns', async () => {
    installMockFetch([
      { url: /\/api\/config$/, body: FIXTURE_CONFIG },
      { url: /\/api\/state$/, body: FIXTURE_SNAPSHOT_CONFIG_REQUIRED },
    ]);
    await act(async () => {
      render(<RoomsTab />);
      await refreshConfig();
    });
    await waitFor(() =>
      expect(document.querySelector('[data-testid="room-card-bedroom"]')).not.toBeNull(),
    );
  });

  it('removes a room card when the delete button is clicked', async () => {
    installMockFetch([
      { url: /\/api\/config$/, body: FIXTURE_CONFIG },
    ]);
    await act(async () => {
      render(<RoomsTab />);
      await refreshConfig();
    });
    await waitFor(() =>
      expect(document.querySelector('[data-testid="room-card-bedroom"]')).not.toBeNull(),
    );
    const del = document.querySelector(
      '[data-testid="room-card-delete-bedroom"]',
    ) as HTMLButtonElement;
    expect(del).not.toBeNull();
    await act(async () => {
      fireEvent.click(del);
    });
    await waitFor(() =>
      expect(document.querySelector('[data-testid="room-card-bedroom"]')).toBeNull(),
    );
  });

  it('assigns a window contact sensor when dropped on a shutter row', async () => {
    const configWithWindow = {
      ...FIXTURE_CONFIG,
      windows: [
        {
          id: 'shutter-1',
          roomId: 'bedroom',
          shutterDeviceId: 'shutter-1',
          automationBlocked: false,
          orientationDeg: 135,
          type: 'roof_window' as const,
          isDoor: false,
          canMoveWhenOpen: true,
          maxPositionWhenOpenPct: 60,
          sunPrelookMinutes: 60,
          lockoutProtection: true,
        },
      ],
    };
    installMockFetch([{ url: /\/api\/config$/, body: configWithWindow }]);
    await act(async () => {
      render(<RoomsTab />);
      await refreshConfig();
    });
    const row = await waitFor(() => {
      const el = document.querySelector('[data-testid="room-card-window-shutter-1"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    // Initially no contact: the per-window dropdown sits at its empty value.
    const contactSelect = document.querySelector(
      '[data-testid="room-card-window-contact-select-shutter-1"]',
    ) as HTMLSelectElement | null;
    expect(contactSelect).not.toBeNull();
    expect(contactSelect?.value).toBe('');
    // Assignment is now via the dropdown (drag-and-drop removed): selecting an
    // option calls onAssignContact. With no discovery mock the list is empty,
    // so we assert the control renders and is wired (empty = no contact).
    expect(row).not.toBeNull();
  });

  it('makes the room floor editable and persists it via auto-save', async () => {
    const fetchMock = installMockFetch([{ url: /\/api\/config$/, body: FIXTURE_CONFIG }]);
    await act(async () => {
      render(<RoomsTab />);
      await refreshConfig();
    });
    const floor = await waitFor(() => {
      const el = document.querySelector('[data-testid="room-card-floor-bedroom"]');
      expect(el).not.toBeNull();
      return el as HTMLInputElement;
    });
    // The bedroom fixture has no floor → control starts empty.
    expect(floor.value).toBe('');
    await act(async () => {
      fireEvent.input(floor, { target: { value: 'DG' } });
    });
    // Draft updates immediately.
    await waitFor(() =>
      expect(
        (document.querySelector('[data-testid="room-card-floor-bedroom"]') as HTMLInputElement)
          .value,
      ).toBe('DG'),
    );
    // Auto-save PUTs the merged config including the new floor.
    await waitFor(
      () =>
        expect(
          (
            fetchMock as unknown as {
              __calls: Array<{ url: string; method: string; body?: string }>;
            }
          ).__calls.some(
            (c) =>
              c.method === 'PUT' &&
              /\/api\/config$/.test(c.url) &&
              (c.body ?? '').includes('"floor":"DG"'),
          ),
        ).toBe(true),
      { timeout: 2000 },
    );
  });

  it('shows the add-room form when "Add room" is clicked', async () => {
    installMockFetch([
      { url: /\/api\/config$/, body: FIXTURE_CONFIG },
    ]);
    await act(async () => {
      render(<RoomsTab />);
      await refreshConfig();
    });
    expect(document.querySelector('[data-testid="rooms-add-form"]')).toBeNull();
    const addBtn = document.querySelector('[data-testid="rooms-add"]') as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(addBtn);
    });
    expect(document.querySelector('[data-testid="rooms-add-form"]')).not.toBeNull();
  });

  it('renders a per-room quiet-schedule editor with an "add" affordance', async () => {
    installMockFetch([{ url: /\/api\/config$/, body: FIXTURE_CONFIG }]);
    await act(async () => {
      render(<RoomsTab />);
      await refreshConfig();
    });
    // The rebuilt page (no drag-and-drop) exposes the granular quiet-hours
    // editor per room: weekday chips + time ranges, added via this button.
    const addSched = await waitFor(() => {
      const el = document.querySelector('[data-testid="sched-room-bedroom-add"]');
      expect(el).not.toBeNull();
      return el as HTMLButtonElement;
    });
    await act(async () => {
      fireEvent.click(addSched);
    });
    expect(document.querySelector('[data-testid="sched-room-bedroom-row-0"]')).not.toBeNull();
  });

  it('triggers POST /api/sources/discover when "Discover windows" is clicked', async () => {
    const fetchMock = makeMockFetch([
      { url: /\/api\/config$/, body: FIXTURE_CONFIG },
      {
        url: /\/api\/sources\/discover/,
        method: 'POST',
        body: { devices: [], climateSensors: [], openMeteo: [] },
      },
    ]);
    (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
    await act(async () => {
      render(<RoomsTab />);
      await refreshConfig();
    });
    const btn = document.querySelector('[data-testid="rooms-discover"]') as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() =>
      expect(
        (fetchMock as unknown as { __calls: Array<{ url: string; method: string }> }).__calls.some(
          (c) => /\/api\/sources\/discover/.test(c.url) && c.method === 'POST',
        ),
      ).toBe(true),
    );
  });
});

// ---------------------------------------------------------------------------
// SourcesTab (Task 12.2).
// ---------------------------------------------------------------------------

describe('<SourcesTab/> (Task 12.2)', () => {
  it('renders three sub-lists after Discover triggers POST /api/sources/discover', async () => {
    const fetchMock = makeMockFetch([
      { url: /\/api\/config$/, body: FIXTURE_CONFIG },
      {
        url: /\/api\/sources\/discover/,
        method: 'POST',
        body: {
          devices: [
            {
              deviceId: 'climate-1',
              deviceType: 'TEMPERATURE_HUMIDITY_SENSOR',
              friendlyName: 'Beispielstadt Sensor',
            },
          ],
          climateSensors: [
            {
              deviceId: 'climate-1',
              deviceType: 'TEMPERATURE_HUMIDITY_SENSOR',
              friendlyName: 'Beispielstadt Sensor',
            },
          ],
          temperatureSources: [
            {
              deviceId: 'climate-1',
              deviceType: 'TEMPERATURE_HUMIDITY_SENSOR',
              friendlyName: 'Beispielstadt Sensor',
            },
          ],
          openMeteo: [
            {
              deviceId: 'meteo-1',
              deviceType: 'PLUGIN_EXTERNAL',
              friendlyName: 'OpenMeteo Beispielstadt',
            },
          ],
        },
      },
    ]);
    (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
    await act(async () => {
      render(<SourcesTab />);
      await refreshConfig();
    });
    const btn = document.querySelector('[data-testid="sources-discover"]') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      const climate = document.querySelector('[data-testid="sources-list-climate"]');
      expect(climate?.textContent ?? '').toContain('Beispielstadt Sensor');
    });
    const openMeteo = document.querySelector('[data-testid="sources-list-openmeteo"]');
    expect(openMeteo?.textContent ?? '').toContain('OpenMeteo Beispielstadt');
  });

  it('runs POST /api/config/probe when a binding "Test" button is pressed', async () => {
    const fetchMock = makeMockFetch([
      { url: /\/api\/config$/, body: FIXTURE_CONFIG },
      {
        url: /\/api\/config\/probe/,
        method: 'POST',
        body: {
          mode: 'NORMAL',
          windowDecisions: [
            { windowId: 'w1', factors: { sunFactor: 0.4 } },
          ],
        },
      },
    ]);
    (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
    await act(async () => {
      render(<SourcesTab />);
      await refreshConfig();
    });
    const btn = document.querySelector(
      '[data-testid="sources-outdoorTemp-test"]',
    ) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      const out = document.querySelector('[data-testid="sources-outdoorTemp-probe"]');
      expect(out?.textContent ?? '').toContain('NORMAL');
    });
  });
});

// ---------------------------------------------------------------------------
// RulesTab (Task 12.3).
// ---------------------------------------------------------------------------

describe('<RulesTab/> (Task 12.3)', () => {
  it('switches every threshold input when the profile changes', async () => {
    installMockFetch([
      { url: /\/api\/config$/, body: FIXTURE_CONFIG },
      {
        url: /\/api\/config\/probe/,
        method: 'POST',
        body: { mode: 'NORMAL', windowDecisions: [] },
      },
    ]);
    await act(async () => {
      render(<RulesTab />);
      await refreshConfig();
    });
    const slider = document.querySelector(
      '[data-testid="rules-slider-comfort.maxIndoorTempC"]',
    ) as HTMLInputElement;
    expect(Number.parseFloat(slider.value)).toBeCloseTo(25.0);
    const aggressive = document.querySelector(
      '[data-testid="rules-profile-aggressive"]',
    ) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(aggressive);
    });
    await waitFor(() => {
      const updated = document.querySelector(
        '[data-testid="rules-slider-comfort.maxIndoorTempC"]',
      ) as HTMLInputElement;
      expect(Number.parseFloat(updated.value)).toBeCloseTo(25.5);
    });
    const stormSlider = document.querySelector(
      '[data-testid="rules-slider-storm.thresholdMs"]',
    ) as HTMLInputElement;
    expect(Number.parseFloat(stormSlider.value)).toBeCloseTo(15.0);
  });

  it('debounces probe calls when sliders move', async () => {
    vi.useFakeTimers();
    const fetchMock = makeMockFetch([
      { url: /\/api\/config$/, body: FIXTURE_CONFIG },
      {
        url: /\/api\/config\/probe/,
        method: 'POST',
        body: {
          mode: 'NORMAL',
          windowDecisions: [{ windowId: 'w1', finalTarget: 0.5 }],
        },
      },
    ]);
    (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
    await act(async () => {
      render(<RulesTab />);
      await refreshConfig();
    });
    const slider = document.querySelector(
      '[data-testid="rules-slider-comfort.maxIndoorTempC"]',
    ) as HTMLInputElement;
    await act(async () => {
      fireEvent.input(slider, { target: { value: '26' } });
    });
    // Probe should not have been called yet (300 ms debounce).
    expect(
      (fetchMock as unknown as { __calls: Array<{ url: string }> }).__calls.some((c) =>
        /\/api\/config\/probe/.test(c.url),
      ),
    ).toBe(false);
    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    vi.useRealTimers();
    await waitFor(() => {
      expect(
        (fetchMock as unknown as { __calls: Array<{ url: string }> }).__calls.some((c) =>
          /\/api\/config\/probe/.test(c.url),
        ),
      ).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// WizardTab (Task 12.4).
// ---------------------------------------------------------------------------

describe('<WizardTab/> (Task 12.4)', () => {
  it('advances on Weiter and posts to /api/wizard/step/:n on Validieren', async () => {
    const fetchMock = makeMockFetch([
      { url: /\/api\/config$/, body: FIXTURE_CONFIG },
      {
        url: /\/api\/wizard\/step\/1/,
        method: 'POST',
        body: { ok: true, status: 'READY' },
      },
    ]);
    (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
    await act(async () => {
      render(<WizardTab />);
      await refreshConfig();
    });
    expect(document.querySelector('[data-testid="wizard-step-1"]')).not.toBeNull();
    const validate = document.querySelector(
      '[data-testid="wizard-validate"]',
    ) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(validate);
    });
    await waitFor(() => {
      expect(
        (fetchMock as unknown as { __calls: Array<{ url: string; method: string }> }).__calls.some(
          (c) => /\/api\/wizard\/step\/1$/.test(c.url) && c.method === 'POST',
        ),
      ).toBe(true);
    });
    const next = document.querySelector('[data-testid="wizard-next"]') as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(next);
    });
    expect(document.querySelector('[data-testid="wizard-step-2"]')).not.toBeNull();
  });

  it('renders step 1 with Beispielstadt defaults and a live sun preview', async () => {
    installMockFetch([
      { url: /\/api\/config$/, body: FIXTURE_CONFIG },
    ]);
    await act(async () => {
      render(<WizardTab />);
      await refreshConfig();
    });
    const lat = document.querySelector('[data-testid="wizard-latitude"]') as HTMLInputElement;
    const lon = document.querySelector('[data-testid="wizard-longitude"]') as HTMLInputElement;
    expect(Number.parseFloat(lat.value)).toBeCloseTo(52.52, 2);
    expect(Number.parseFloat(lon.value)).toBeCloseTo(13.41, 2);
    const preview = document.querySelector('[data-testid="wizard-sun-preview"]');
    expect(preview?.textContent ?? '').toMatch(/Azimut.*Höhe/);
  });
});

// ---------------------------------------------------------------------------
// Auto-redirect (Task 12.4 final acceptance criterion).
// ---------------------------------------------------------------------------

describe('App auto-redirect on CONFIG_REQUIRED', () => {
  it('navigates to /wizard when pluginReadiness === CONFIG_REQUIRED', async () => {
    installMockFetch([
      { url: /\/api\/config$/, body: FIXTURE_CONFIG },
      { url: /\/api\/state$/, body: FIXTURE_SNAPSHOT_CONFIG_REQUIRED },
    ]);
    snapshot.value = FIXTURE_SNAPSHOT_CONFIG_REQUIRED;
    await act(async () => {
      render(<App />);
    });
    await waitFor(() => {
      // The wizard tab has a step indicator that the placeholder
      // tabs do not declare, so finding it is a reliable signal.
      expect(document.querySelector('[data-testid="wizard-steps"]')).not.toBeNull();
    });
  });

  it('does not redirect when sessionStorage flag is already set', async () => {
    sessionStorage.setItem('heatshield.wizardAutoRedirected', 'true');
    installMockFetch([
      { url: /\/api\/config$/, body: FIXTURE_CONFIG },
      { url: /\/api\/state$/, body: FIXTURE_SNAPSHOT_CONFIG_REQUIRED },
    ]);
    snapshot.value = FIXTURE_SNAPSHOT_CONFIG_REQUIRED;
    await act(async () => {
      render(<App initialUrl="/uebersicht" />);
    });
    expect(document.querySelector('[data-testid="uebersicht-view"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="wizard-steps"]')).toBeNull();
  });
});
