/**
 * Happy-path tests for `parseConfig`.
 *
 * These cases verify that:
 *   1. A truly minimal config (only the fields without documented defaults)
 *      parses cleanly and ends up with every documented default from
 *      design.md / regelwerk §19 applied.
 *   2. A realistic config that mirrors design.md §Data Models survives a
 *      JSON round-trip through `parseConfig`.
 *   3. All four `SourceRef` discriminator variants (`static`, `hmip`,
 *      `fusion`, `openmeteo`) are exercised at least once in this file.
 */

import { describe, expect, it } from 'vitest';

import { parseConfig } from '../../src/shared/schema.js';
import {
  validMinimalConfig,
  validRealisticConfig,
} from '../_fixtures/config.js';

describe('parseConfig — minimal valid config', () => {
  it('accepts a config with only the truly required fields', () => {
    expect(() => parseConfig(validMinimalConfig())).not.toThrow();
  });

  it('applies all comfort defaults from regelwerk §19', () => {
    const parsed = parseConfig(validMinimalConfig());

    expect(parsed.rules.comfort.maxIndoorTempC).toBe(25);
    expect(parsed.rules.comfort.preShadeTempC).toBe(23.5);
    expect(parsed.rules.comfort.nightCoolingDeltaC).toBe(1.5);
  });

  it('applies all automation defaults from regelwerk §19', () => {
    const parsed = parseConfig(validMinimalConfig());

    expect(parsed.rules.automation.controlIntervalSeconds).toBe(180);
    expect(parsed.rules.automation.minSecondsBetweenMoves).toBe(900);
    expect(parsed.rules.automation.minPositionDeltaPct).toBe(15);
    expect(parsed.rules.automation.temperatureHysteresisC).toBe(0.5);
    expect(parsed.rules.automation.pvHysteresisKw).toBe(0.7);
    expect(parsed.rules.automation.pvSmoothingSamples).toBe(3);
    expect(parsed.rules.automation.forecastHorizonMinutes).toBe(60);
  });

  it('applies all sun-geometry defaults', () => {
    const parsed = parseConfig(validMinimalConfig());

    expect(parsed.rules.sun.minElevationDeg).toBe(5);
    expect(parsed.rules.sun.maxIncidenceAngleFacadeDeg).toBe(90);
    expect(parsed.rules.sun.maxIncidenceAngleRoofDeg).toBe(95);
  });

  it('applies storm defaults (Requirement 7.3)', () => {
    const parsed = parseConfig(validMinimalConfig());

    expect(parsed.rules.storm.thresholdMs).toBe(13.9);
    expect(parsed.rules.storm.releaseMs).toBe(8.0);
    expect(parsed.rules.storm.releaseHoldMin).toBe(10);
  });

  it('applies night-cooling defaults', () => {
    const parsed = parseConfig(validMinimalConfig());

    expect(parsed.rules.nightCooling.enabled).toBe(true);
    expect(parsed.rules.nightCooling.deltaC).toBe(1.5);
    expect(parsed.rules.nightCooling.reopenAtSunriseOffsetMin).toBe(-30);
  });

  it('applies heat-load defaults (smart-shading Task 11.1)', () => {
    const parsed = parseConfig(validMinimalConfig());

    expect(parsed.rules.heatLoad.pvWeight).toBe(0.5);
    expect(parsed.rules.heatLoad.tempWeight).toBe(0.3);
    expect(parsed.rules.heatLoad.trendWeight).toBe(0.2);
    expect(parsed.rules.heatLoad.activateThreshold).toBe(0.45);
    expect(parsed.rules.heatLoad.releaseThreshold).toBe(0.3);
    expect(parsed.rules.heatLoad.releaseHoldMinutes).toBe(60);
    expect(parsed.rules.heatLoad.trendWindowHours).toBe(3);
  });

  it('applies notification defaults with Telegram disabled (Req 8)', () => {
    const parsed = parseConfig(validMinimalConfig());

    expect(parsed.notifications.telegram.enabled).toBe(false);
    expect(parsed.notifications.telegram.botToken).toBe('');
    expect(parsed.notifications.telegram.chatId).toBe('');
    expect(parsed.notifications.telegram.commandsEnabled).toBe(false);
    expect(parsed.notifications.telegram.allowControl).toBe(true);
    expect(parsed.notifications.telegram.allowedChatIds).toEqual([]);
    expect(parsed.notifications.morningBriefLocalTime).toBe('07:30');
    expect(parsed.notifications.forecastUpdates).toEqual({
      enabled: false,
      everyHours: 3,
    });
    expect(parsed.notifications.events).toEqual({
      ventilate: true,
      open: true,
      close: true,
      weather: true,
    });
  });

  it('applies insulation defaults (disabled, 5 °C, full close)', () => {
    const parsed = parseConfig(validMinimalConfig());

    expect(parsed.rules.insulation).toEqual({
      enabled: false,
      maxOutdoorTempC: 5,
      level01: 1,
    });
  });

  it('applies learning + daily-summary defaults (auto-apply off)', () => {
    const parsed = parseConfig(validMinimalConfig());

    expect(parsed.learning.autoApply).toBe(false);
    expect(parsed.notifications.dailySummaryEnabled).toBe(false);
    expect(parsed.notifications.dailySummaryLocalTime).toBe('21:00');
  });

  it('applies direct OpenMeteo HTTP defaults (disabled, 15 min)', () => {
    const parsed = parseConfig(validMinimalConfig());

    expect(parsed.openMeteo).toEqual({
      enabled: false,
      pollIntervalMinutes: 15,
      baseUrl: 'https://api.open-meteo.com',
    });
  });

  it('accepts an openmeteo_http source binding', () => {
    const cfg = validMinimalConfig() as Record<string, unknown>;
    cfg.globalSignals = {
      outdoorTemp: {
        primary: { kind: 'openmeteo_http', field: 'temperature' },
        staleAfterSec: 600,
      },
    };
    const parsed = parseConfig(cfg);
    expect(parsed.globalSignals.outdoorTemp.primary).toEqual({
      kind: 'openmeteo_http',
      field: 'temperature',
    });
  });

  it('rejects a malformed morningBriefLocalTime', () => {
    const cfg = validMinimalConfig() as Record<string, unknown>;
    cfg.notifications = { morningBriefLocalTime: '7:5' };
    expect(() => parseConfig(cfg)).toThrow();
  });

  it('applies the top-level rules defaults (profile, manualOverrideMinutes)', () => {
    const parsed = parseConfig(validMinimalConfig());

    expect(parsed.rules.profile).toBe('standard');
    expect(parsed.rules.manualOverrideMinutes).toBe(60);
  });

  it('applies the FusionSolar defaults', () => {
    const parsed = parseConfig(validMinimalConfig());

    expect(parsed.fusionSolar.baseUrl).toBe('http://host.containers.internal:8088');
    expect(parsed.fusionSolar.pvPeakKwp).toBe(8.8);
    expect(parsed.fusionSolar.orientationHint).toBe('southeast');
  });

  it('applies the dashboard defaults', () => {
    const parsed = parseConfig(validMinimalConfig());

    expect(parsed.dashboard.port).toBe(8089);
    expect(parsed.dashboard.enabled).toBe(true);
  });

  it('defaults rooms and windows arrays to empty', () => {
    const parsed = parseConfig(validMinimalConfig());

    expect(parsed.rooms).toEqual([]);
    expect(parsed.windows).toEqual([]);
  });

  it('applies the SignalBinding staleAfterSec default of 600', () => {
    const parsed = parseConfig(validMinimalConfig());

    expect(parsed.globalSignals.outdoorTemp.staleAfterSec).toBe(600);
  });
});

describe('parseConfig — realistic config from design.md', () => {
  it('accepts the realistic example without errors', () => {
    expect(() => parseConfig(validRealisticConfig())).not.toThrow();
  });

  it('preserves both rooms with their full RoomTargets', () => {
    const parsed = parseConfig(validRealisticConfig());

    expect(parsed.rooms).toHaveLength(2);
    const bedroom = parsed.rooms.find((r) => r.id === 'schlafzimmer');
    const office = parsed.rooms.find((r) => r.id === 'arbeitszimmer');

    expect(bedroom).toBeDefined();
    expect(office).toBeDefined();
    expect(bedroom?.targets).toEqual({
      target_c: 22,
      warning_c: 24,
      strong_shade_c: 25.5,
      critical_c: 27,
    });
    expect(office?.targets).toEqual({
      target_c: 22.5,
      warning_c: 24.5,
      strong_shade_c: 26,
      critical_c: 27.5,
    });
  });

  it('preserves both windows including the SO-Dachfenster and the SO-Fassaden-Tür', () => {
    const parsed = parseConfig(validRealisticConfig());

    expect(parsed.windows).toHaveLength(2);
    const roofWindow = parsed.windows.find(
      (w) => w.id === 'schlafzimmer-dach-so',
    );
    const door = parsed.windows.find(
      (w) => w.id === 'arbeitszimmer-fassade-so-tuer',
    );

    expect(roofWindow?.type).toBe('roof_window');
    expect(roofWindow?.orientationDeg).toBe(135);
    expect(roofWindow?.isDoor).toBe(false);

    expect(door?.type).toBe('facade');
    expect(door?.isDoor).toBe(true);
    expect(door?.lockoutProtection).toBe(true);
    expect(door?.canMoveWhenOpen).toBe(false);
  });

  it('round-trips cleanly through JSON.parse(JSON.stringify(parsed))', () => {
    const parsed = parseConfig(validRealisticConfig());
    const reparsed = parseConfig(JSON.parse(JSON.stringify(parsed)));

    expect(reparsed).toEqual(parsed);
  });

  it('exercises all four SourceRef discriminator variants', () => {
    const parsed = parseConfig(validRealisticConfig());
    const observedKinds = new Set<string>();

    // Walk every SignalBinding in the parsed config and collect the kinds.
    const collect = (binding: { primary: { kind: string }; fallback?: { kind: string } } | undefined): void => {
      if (!binding) return;
      observedKinds.add(binding.primary.kind);
      if (binding.fallback) observedKinds.add(binding.fallback.kind);
    };

    collect(parsed.globalSignals.outdoorTemp);
    collect(parsed.globalSignals.pvPower);
    collect(parsed.globalSignals.windSpeed);
    for (const room of parsed.rooms) {
      collect(room.signals.indoorTemp);
      collect(room.signals.illumination);
    }

    expect(observedKinds).toEqual(
      new Set(['static', 'hmip', 'fusion', 'openmeteo']),
    );
  });
});

describe('parseConfig — 0.1.4 master switch + room floor', () => {
  it('defaults automationEnabled to false (configure-in-peace)', () => {
    const parsed = parseConfig(validMinimalConfig());
    expect(parsed.automationEnabled).toBe(false);
  });

  it('honours an explicit automationEnabled: true', () => {
    const parsed = parseConfig({ ...validMinimalConfig(), automationEnabled: true });
    expect(parsed.automationEnabled).toBe(true);
  });

  it('accepts an optional free-form room floor', () => {
    const cfg = {
      ...validMinimalConfig(),
      rooms: [
        {
          id: 'schlafzimmer',
          name: 'Schlafzimmer',
          floor: 'OG',
          priority: 'very_high',
          targets: {
            target_c: 23,
            warning_c: 25,
            strong_shade_c: 26,
            critical_c: 27,
          },
        },
      ],
    };
    const parsed = parseConfig(cfg);
    expect(parsed.rooms[0]?.floor).toBe('OG');
  });

  it('leaves floor undefined when omitted', () => {
    const cfg = {
      ...validMinimalConfig(),
      rooms: [
        {
          id: 'flur',
          name: 'Flur',
          priority: 'low',
          targets: {
            target_c: 23,
            warning_c: 25,
            strong_shade_c: 26,
            critical_c: 27,
          },
        },
      ],
    };
    const parsed = parseConfig(cfg);
    expect(parsed.rooms[0]?.floor).toBeUndefined();
  });
});
