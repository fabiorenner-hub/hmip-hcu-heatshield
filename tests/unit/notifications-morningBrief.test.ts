/**
 * Tests for the morning brief scheduler
 * (`src/plugin/notifications/morningBrief.ts`, Task 9).
 *
 * Verifies the once-per-local-day idempotency and the timing gate.
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MorningBriefScheduler,
} from '../../src/plugin/notifications/morningBrief.js';
import { NotificationService } from '../../src/plugin/notifications/service.js';
import { MessageStore } from '../../src/plugin/persistence/messages.js';
import type { NotificationEvents, TelegramConfig } from '../../src/shared/types.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'heat-shield-brief-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const EVENTS: NotificationEvents = {
  ventilate: true,
  open: true,
  close: true,
  weather: true,
};
const TELEGRAM_OFF: TelegramConfig = { enabled: false, botToken: '', chatId: '' };

async function mkService(): Promise<{ service: NotificationService; store: MessageStore }> {
  const store = new MessageStore({ messagesPath: path.join(tmpDir, 'm.ndjson') });
  await store.load();
  let id = 0;
  const service = new NotificationService({
    store,
    telegram: TELEGRAM_OFF,
    events: EVENTS,
    idGen: () => `id-${(id += 1)}`,
  });
  return { service, store };
}

function brief(): { title: string; body: string } {
  return { title: 'Wetter heute', body: 'Sonnig, bis 30 °C.' };
}

describe('MorningBriefScheduler', () => {
  it('does not send before the configured local time', async () => {
    const { service, store } = await mkService();
    const sched = new MorningBriefScheduler({
      localTime: '07:30',
      timezone: 'Europe/Berlin',
      markerPath: path.join(tmpDir, 'brief.json'),
      // 05:00 UTC = 07:00 Berlin (before 07:30)
      now: () => new Date('2026-06-22T05:00:00.000Z'),
    });
    await sched.load();
    expect(await sched.maybeSend(service, brief)).toBe(false);
    expect(store.list()).toHaveLength(0);
  });

  it('sends once after the configured time and not again the same day', async () => {
    const { service, store } = await mkService();
    const sched = new MorningBriefScheduler({
      localTime: '07:30',
      timezone: 'Europe/Berlin',
      markerPath: path.join(tmpDir, 'brief.json'),
      // 06:00 UTC = 08:00 Berlin (after 07:30)
      now: () => new Date('2026-06-22T06:00:00.000Z'),
    });
    await sched.load();

    expect(await sched.maybeSend(service, brief)).toBe(true);
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]!.kind).toBe('weather');

    // Second call same day → no send.
    expect(await sched.maybeSend(service, brief)).toBe(false);
    expect(store.list()).toHaveLength(1);
  });

  it('is idempotent across a restart via the persisted marker', async () => {
    const { service, store } = await mkService();
    const markerPath = path.join(tmpDir, 'brief.json');
    const now = (): Date => new Date('2026-06-22T06:00:00.000Z');

    const sched1 = new MorningBriefScheduler({
      localTime: '07:30',
      timezone: 'Europe/Berlin',
      markerPath,
      now,
    });
    await sched1.load();
    expect(await sched1.maybeSend(service, brief)).toBe(true);

    // Fresh scheduler (simulated restart) reads the marker and skips.
    const sched2 = new MorningBriefScheduler({
      localTime: '07:30',
      timezone: 'Europe/Berlin',
      markerPath,
      now,
    });
    await sched2.load();
    expect(sched2.getLastBriefDay()).toBe('2026-06-22');
    expect(await sched2.maybeSend(service, brief)).toBe(false);
    expect(store.list()).toHaveLength(1);
  });

  it('sends again on the next local day', async () => {
    const { service, store } = await mkService();
    const markerPath = path.join(tmpDir, 'brief.json');

    const day1 = new MorningBriefScheduler({
      localTime: '07:30',
      timezone: 'Europe/Berlin',
      markerPath,
      now: () => new Date('2026-06-22T06:00:00.000Z'),
    });
    await day1.load();
    expect(await day1.maybeSend(service, brief)).toBe(true);

    const day2 = new MorningBriefScheduler({
      localTime: '07:30',
      timezone: 'Europe/Berlin',
      markerPath,
      now: () => new Date('2026-06-23T06:00:00.000Z'),
    });
    await day2.load();
    expect(await day2.maybeSend(service, brief)).toBe(true);
    expect(store.list()).toHaveLength(2);
  });

  it('skips without burning the marker when buildBrief returns null', async () => {
    const { service } = await mkService();
    const sched = new MorningBriefScheduler({
      localTime: '07:30',
      timezone: 'Europe/Berlin',
      markerPath: path.join(tmpDir, 'brief.json'),
      now: () => new Date('2026-06-22T06:00:00.000Z'),
    });
    await sched.load();
    expect(await sched.maybeSend(service, () => null)).toBe(false);
    expect(sched.getLastBriefDay()).toBeNull();
  });
});
