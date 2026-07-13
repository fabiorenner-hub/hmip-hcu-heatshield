/**
 * Tests for the two-way Telegram bot
 * (`src/plugin/notifications/telegramBot.ts`) and command registry
 * (`src/plugin/notifications/telegramCommands.ts`). `fetch` is mocked.
 */

import { describe, expect, it } from 'vitest';

import {
  parseCommand,
  TelegramBot,
  type TelegramCommand,
} from '../../src/plugin/notifications/telegramBot.js';
import { buildTelegramCommands } from '../../src/plugin/notifications/telegramCommands.js';
import type { FetchLike } from '../../src/plugin/notifications/telegram.js';
import type { TelegramConfig } from '../../src/shared/types.js';

function cfg(over: Partial<TelegramConfig> = {}): TelegramConfig {
  return {
    enabled: true,
    botToken: '123:ABC',
    chatId: '42',
    commandsEnabled: true,
    allowControl: true,
    allowedChatIds: [],
    ...over,
  };
}

/** Build a fetch mock that serves one batch of updates then empties. */
function mkFetch(updates: unknown[]): {
  fetchImpl: FetchLike;
  sends: Array<{ chat_id: string; text: string }>;
} {
  let served = false;
  const sends: Array<{ chat_id: string; text: string }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    if (url.includes('/getUpdates')) {
      const body = served
        ? { ok: true, result: [] }
        : { ok: true, result: updates };
      served = true;
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    }
    if (url.includes('/sendMessage')) {
      sends.push(JSON.parse(init?.body ?? '{}') as { chat_id: string; text: string });
      return { ok: true, status: 200, text: async () => 'ok' };
    }
    if (url.includes('/answerCallbackQuery')) {
      return { ok: true, status: 200, text: async () => 'ok' };
    }
    throw new Error(`unexpected url ${url}`);
  };
  return { fetchImpl, sends };
}

function msg(chatId: number, text: string, updateId = 1): unknown {
  return { update_id: updateId, message: { message_id: 1, chat: { id: chatId }, text } };
}

const STATUS_CMD: TelegramCommand = {
  name: 'status',
  description: 'status',
  run: () => 'OK-STATUS',
};
const PAUSE_CMD: TelegramCommand = {
  name: 'pause',
  description: 'pause',
  control: true,
  run: () => 'PAUSED',
};

describe('parseCommand', () => {
  it('parses a bare command', () => {
    expect(parseCommand('/status')).toEqual({ name: 'status', args: '' });
  });

  it('parses a command with arguments', () => {
    expect(parseCommand('/set morgenzeit 07:30')).toEqual({
      name: 'set',
      args: 'morgenzeit 07:30',
    });
  });

  it('strips a @botname mention and lowercases', () => {
    expect(parseCommand('/Status@HeatShieldBot')).toEqual({ name: 'status', args: '' });
  });

  it('returns null for non-commands', () => {
    expect(parseCommand('hallo bot')).toBeNull();
    expect(parseCommand('')).toBeNull();
  });
});

describe('TelegramBot — dispatch + auth', () => {
  it('runs an authorized command and replies', async () => {
    const { fetchImpl, sends } = mkFetch([msg(42, '/status')]);
    const bot = new TelegramBot({
      getTelegram: () => cfg(),
      commands: [STATUS_CMD],
      fetchImpl,
    });
    await bot.pollOnce();
    expect(sends).toHaveLength(1);
    expect(sends[0]!.chat_id).toBe('42');
    expect(sends[0]!.text).toBe('OK-STATUS');
  });

  it('refuses an unauthorized chat', async () => {
    const { fetchImpl, sends } = mkFetch([msg(999, '/status')]);
    const bot = new TelegramBot({
      getTelegram: () => cfg(),
      commands: [STATUS_CMD],
      fetchImpl,
    });
    await bot.pollOnce();
    expect(sends).toHaveLength(1);
    expect(sends[0]!.text).toContain('nicht autorisiert');
  });

  it('honours allowedChatIds', async () => {
    const { fetchImpl, sends } = mkFetch([msg(7, '/status')]);
    const bot = new TelegramBot({
      getTelegram: () => cfg({ chatId: '42', allowedChatIds: ['7'] }),
      commands: [STATUS_CMD],
      fetchImpl,
    });
    await bot.pollOnce();
    expect(sends[0]!.text).toBe('OK-STATUS');
  });

  it('blocks control commands when allowControl is false', async () => {
    const { fetchImpl, sends } = mkFetch([msg(42, '/pause')]);
    const bot = new TelegramBot({
      getTelegram: () => cfg({ allowControl: false }),
      commands: [PAUSE_CMD],
      fetchImpl,
    });
    await bot.pollOnce();
    expect(sends[0]!.text).toContain('deaktiviert');
  });

  it('runs control commands when allowControl is true', async () => {
    const { fetchImpl, sends } = mkFetch([msg(42, '/pause')]);
    const bot = new TelegramBot({
      getTelegram: () => cfg(),
      commands: [PAUSE_CMD],
      fetchImpl,
    });
    await bot.pollOnce();
    expect(sends[0]!.text).toBe('PAUSED');
  });

  it('replies with a hint for an unknown command', async () => {
    const { fetchImpl, sends } = mkFetch([msg(42, '/wat')]);
    const bot = new TelegramBot({
      getTelegram: () => cfg(),
      commands: [STATUS_CMD],
      fetchImpl,
    });
    await bot.pollOnce();
    expect(sends[0]!.text).toContain('Unbekannter Befehl');
  });

  it('handles an inline-button callback as a command', async () => {
    const cbUpdate = {
      update_id: 9,
      callback_query: {
        id: 'cb1',
        data: '/status',
        message: { message_id: 1, chat: { id: 42 } },
      },
    };
    const { fetchImpl, sends } = mkFetch([cbUpdate]);
    const bot = new TelegramBot({
      getTelegram: () => cfg(),
      commands: [STATUS_CMD],
      fetchImpl,
    });
    await bot.pollOnce();
    expect(sends).toHaveLength(1);
    expect(sends[0]!.text).toBe('OK-STATUS');
  });

  it('attaches the quick-action menu for menu commands', async () => {
    let sentBody: Record<string, unknown> | null = null;
    let served = false;
    const fetchImpl: FetchLike = async (url, init) => {
      if (url.includes('/getUpdates')) {
        const body = served
          ? { ok: true, result: [] }
          : { ok: true, result: [msg(42, '/menu')] };
        served = true;
        return { ok: true, status: 200, text: async () => JSON.stringify(body) };
      }
      sentBody = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
      return { ok: true, status: 200, text: async () => 'ok' };
    };
    const bot = new TelegramBot({
      getTelegram: () => cfg(),
      commands: [{ name: 'menu', description: 'm', menu: true, run: () => 'Menü' }],
      fetchImpl,
      menu: [[{ text: '📊 Status', command: '/status' }]],
    });
    await bot.pollOnce();
    expect(sentBody).not.toBeNull();
    expect(sentBody!['reply_markup']).toBeDefined();
  });

  it('advances the offset and persists it', async () => {
    const { fetchImpl } = mkFetch([msg(42, '/status', 55)]);
    const saved: number[] = [];
    const bot = new TelegramBot({
      getTelegram: () => cfg(),
      commands: [STATUS_CMD],
      fetchImpl,
      saveOffset: async (o) => {
        saved.push(o);
      },
    });
    await bot.pollOnce();
    expect(saved).toContain(56);
  });
});

describe('buildTelegramCommands', () => {
  const ctx = {
    statusText: () => 'STATUS',
    forecastText: () => 'FORECAST',
    roomsText: () => 'ROOMS',
    pause: (m: number | null) => `PAUSE:${m}`,
    resume: () => 'RESUME',
    setVacation: (on: boolean) => `VAC:${on}`,
    setAutomation: (on: boolean) => `AUTO:${on}`,
    setParam: (k: string, v: string) => `SET:${k}=${v}`,
    confirmReclose: (yes: boolean) => `RECLOSE:${yes}`,
  };

  it('includes a /hilfe command listing all commands', () => {
    const cmds = buildTelegramCommands(ctx);
    const help = cmds.find((c) => c.name === 'hilfe');
    expect(help).toBeDefined();
    const text = help!.run('', '42') as string;
    expect(text).toContain('/status');
    expect(text).toContain('/set');
  });

  it('routes /pause with a minute argument', async () => {
    const cmds = buildTelegramCommands(ctx);
    const pause = cmds.find((c) => c.name === 'pause')!;
    expect(await pause.run('120', '42')).toBe('PAUSE:120');
    expect(await pause.run('', '42')).toBe('PAUSE:null');
  });

  it('parses on/off for /urlaub', async () => {
    const cmds = buildTelegramCommands(ctx);
    const urlaub = cmds.find((c) => c.name === 'urlaub')!;
    expect(await urlaub.run('an', '42')).toBe('VAC:true');
    expect(await urlaub.run('aus', '42')).toBe('VAC:false');
  });

  it('splits /set into key and value', async () => {
    const cmds = buildTelegramCommands(ctx);
    const set = cmds.find((c) => c.name === 'set')!;
    expect(await set.run('morgenzeit 07:30', '42')).toBe('SET:morgenzeit=07:30');
  });

  it('routes /ja and /nein to the re-close confirmation (control commands)', async () => {
    const cmds = buildTelegramCommands(ctx);
    const ja = cmds.find((c) => c.name === 'ja')!;
    const nein = cmds.find((c) => c.name === 'nein')!;
    expect(ja.control).toBe(true);
    expect(nein.control).toBe(true);
    expect(await ja.run('', '42')).toBe('RECLOSE:true');
    expect(await nein.run('', '42')).toBe('RECLOSE:false');
    // Aliases resolve too (/yes, /no).
    expect(ja.aliases).toContain('yes');
    expect(nein.aliases).toContain('no');
  });
});
