/**
 * Tests for the MessageStore (`src/plugin/persistence/messages.ts`, Task 7.1)
 * and the NotificationService (`src/plugin/notifications/service.ts`, 7.2/7.3).
 *
 * Each test uses its own temp dir so the suite never touches `/data/`.
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MessageStore,
  DEFAULT_MESSAGES_PATH,
} from '../../src/plugin/persistence/messages.js';
import {
  NotificationService,
  type ShadingEvent,
} from '../../src/plugin/notifications/service.js';
import type { Message } from '../../src/shared/message-schema.js';
import type { NotificationEvents, TelegramConfig } from '../../src/shared/types.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'heat-shield-msgs-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function tmpMessagesPath(name = 'messages.ndjson'): string {
  return path.join(tmpDir, name);
}

function mkMessage(over: Partial<Message> = {}): Message {
  return {
    id: over.id ?? 'm1',
    ts: over.ts ?? '2026-06-22T08:00:00.000Z',
    kind: over.kind ?? 'info',
    title: over.title ?? 'Titel',
    body: over.body ?? 'Text',
    read: over.read ?? false,
  };
}

const ALL_EVENTS: NotificationEvents = {
  ventilate: true,
  open: true,
  close: true,
  weather: true,
};

const TELEGRAM_OFF: TelegramConfig = {
  enabled: false,
  botToken: '',
  chatId: '',
};

describe('MessageStore — defaults', () => {
  it('exposes the documented default path', () => {
    expect(DEFAULT_MESSAGES_PATH).toBe('/data/messages.ndjson');
  });
});

describe('MessageStore — append / list / unreadCount', () => {
  it('appends and lists in chronological order', async () => {
    const store = new MessageStore({ messagesPath: tmpMessagesPath() });
    await store.load();
    await store.append(mkMessage({ id: 'a' }));
    await store.append(mkMessage({ id: 'b' }));
    expect(store.list().map((m) => m.id)).toEqual(['a', 'b']);
    expect(store.unreadCount()).toBe(2);
  });

  it('persists across a reload', async () => {
    const p = tmpMessagesPath();
    const store1 = new MessageStore({ messagesPath: p });
    await store1.load();
    await store1.append(mkMessage({ id: 'a' }));
    await store1.append(mkMessage({ id: 'b', read: true }));

    const store2 = new MessageStore({ messagesPath: p });
    await store2.load();
    expect(store2.list().map((m) => m.id)).toEqual(['a', 'b']);
    expect(store2.unreadCount()).toBe(1);
  });

  it('skips malformed and schema-invalid lines on load', async () => {
    const p = tmpMessagesPath();
    await fs.writeFile(
      p,
      `${JSON.stringify(mkMessage({ id: 'a' }))}\n` +
        `{ not json\n` +
        `${JSON.stringify({ id: 'x', kind: 'nope' })}\n` +
        `${JSON.stringify(mkMessage({ id: 'b' }))}\n`,
      'utf8',
    );
    const store = new MessageStore({ messagesPath: p });
    await store.load();
    expect(store.list().map((m) => m.id)).toEqual(['a', 'b']);
  });
});

describe('MessageStore — markRead', () => {
  it('marks specific ids read and reduces the unread count', async () => {
    const store = new MessageStore({ messagesPath: tmpMessagesPath() });
    await store.load();
    await store.append(mkMessage({ id: 'a' }));
    await store.append(mkMessage({ id: 'b' }));
    await store.append(mkMessage({ id: 'c' }));

    const remaining = await store.markRead(['a', 'c']);
    expect(remaining).toBe(1);
    expect(store.list().find((m) => m.id === 'b')!.read).toBe(false);
  });

  it('marks all read when no ids are given, and persists the flags', async () => {
    const p = tmpMessagesPath();
    const store = new MessageStore({ messagesPath: p });
    await store.load();
    await store.append(mkMessage({ id: 'a' }));
    await store.append(mkMessage({ id: 'b' }));

    expect(await store.markRead()).toBe(0);

    const reloaded = new MessageStore({ messagesPath: p });
    await reloaded.load();
    expect(reloaded.unreadCount()).toBe(0);
  });
});

describe('NotificationService — build + route + dedup', () => {
  function mkService(over?: {
    events?: NotificationEvents;
    telegram?: TelegramConfig;
    sendImpl?: ReturnType<typeof vi.fn>;
  }): { svc: NotificationService; store: MessageStore } {
    const store = new MessageStore({ messagesPath: tmpMessagesPath() });
    let id = 0;
    const svc = new NotificationService({
      store,
      telegram: over?.telegram ?? TELEGRAM_OFF,
      events: over?.events ?? ALL_EVENTS,
      now: () => new Date('2026-06-22T08:00:00.000Z'),
      idGen: () => `id-${(id += 1)}`,
      ...(over?.sendImpl
        ? { telegramOptions: { fetchImpl: over.sendImpl as never } }
        : {}),
    });
    return { svc, store };
  }

  it('creates one message per transition with the right kind', async () => {
    const { svc, store } = mkService();
    await store.load();
    const events: ShadingEvent[] = [
      { kind: 'shade.activated', windowId: 'w1', label: 'Schlafzimmer SO' },
      { kind: 'venting.suggested', windowId: 'w2' },
    ];
    const created = await svc.process(events);
    expect(created).toHaveLength(2);
    expect(created[0]!.kind).toBe('close');
    expect(created[1]!.kind).toBe('ventilate');
    expect(store.list()).toHaveLength(2);
  });

  it('groups same-kind transitions from one cycle into a single message', async () => {
    const { svc, store } = mkService();
    await store.load();
    const created = await svc.process([
      { kind: 'shade.activated', windowId: 'w1', label: 'Wohnen – Rollo (…3612)' },
      { kind: 'shade.activated', windowId: 'w2', label: 'Küche – Rollo (…7788)' },
      { kind: 'shade.activated', windowId: 'w3', label: 'Schlafen – Rollo (…1122)' },
    ]);
    // One grouped message, not three.
    expect(created).toHaveLength(1);
    expect(store.list()).toHaveLength(1);
    expect(created[0]!.kind).toBe('close');
    expect(created[0]!.body).toContain('3 Rollläden');
    expect(created[0]!.body).toContain('Wohnen – Rollo (…3612)');
    expect(created[0]!.body).toContain('Küche – Rollo (…7788)');
    expect(created[0]!.body).toContain('Schlafen – Rollo (…1122)');
  });

  it('sends only one Telegram message for a multi-window shading cycle', async () => {
    const sendImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    const { svc, store } = mkService({
      telegram: { ...TELEGRAM_OFF, enabled: true, botToken: 't', chatId: '1' },
      sendImpl,
    });
    await store.load();
    await svc.process([
      { kind: 'shade.activated', windowId: 'w1', label: 'Wohnen' },
      { kind: 'shade.activated', windowId: 'w2', label: 'Küche' },
    ]);
    expect(sendImpl).toHaveBeenCalledTimes(1);
  });

  it('suppresses consecutive duplicate transitions for the same window', async () => {
    const { svc, store } = mkService();
    await store.load();
    await svc.process([{ kind: 'shade.activated', windowId: 'w1' }]);
    const second = await svc.process([{ kind: 'shade.activated', windowId: 'w1' }]);
    expect(second).toHaveLength(0);
    expect(store.list()).toHaveLength(1);
  });

  it('respects per-event toggles (close disabled ⇒ no shade.activated message)', async () => {
    const { svc, store } = mkService({
      events: { ventilate: true, open: true, close: false, weather: true },
    });
    await store.load();
    const created = await svc.process([
      { kind: 'shade.activated', windowId: 'w1' },
    ]);
    expect(created).toHaveLength(0);
    expect(store.list()).toHaveLength(0);
  });

  it('sends via Telegram when enabled', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => 'ok',
    }));
    const { svc, store } = mkService({
      telegram: { enabled: true, botToken: '123:ABCDEF', chatId: '42' },
      sendImpl: fetchMock,
    });
    await store.load();
    await svc.process([{ kind: 'shade.activated', windowId: 'w1' }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toContain('api.telegram.org/bot123:ABCDEF/sendMessage');
  });

  it('still stores the message when Telegram delivery fails', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('network down');
    });
    const { svc, store } = mkService({
      telegram: { enabled: true, botToken: '123:ABC', chatId: '42' },
      sendImpl: fetchMock,
    });
    await store.load();
    const created = await svc.process([{ kind: 'venting.suggested', windowId: 'w1' }]);
    expect(created).toHaveLength(1);
    expect(store.list()).toHaveLength(1);
  });
});
