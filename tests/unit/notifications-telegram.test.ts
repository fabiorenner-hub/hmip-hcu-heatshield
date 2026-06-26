/**
 * Tests for the Telegram sender (`src/plugin/notifications/telegram.ts`,
 * Task 8). `fetch` is mocked; no network access.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  maskToken,
  sendTelegram,
  type FetchLike,
} from '../../src/plugin/notifications/telegram.js';
import type { TelegramConfig } from '../../src/shared/types.js';

const ENABLED: TelegramConfig = {
  enabled: true,
  botToken: '123456:AAEhBOweik9bQ',
  chatId: '99',
};

describe('maskToken', () => {
  it('keeps the bot id prefix and last 4 chars, masks the middle', () => {
    expect(maskToken('123456:AAEhBOweik9bQ')).toBe('123456:••••k9bQ');
  });

  it('returns empty for an empty token', () => {
    expect(maskToken('')).toBe('');
  });

  it('masks a short secret without leaking it', () => {
    expect(maskToken('123:ab')).toBe('123:••••');
  });

  it('never contains the full secret', () => {
    const masked = maskToken('123456:SUPERSECRETVALUE');
    expect(masked).not.toContain('SUPERSECRET');
  });
});

describe('sendTelegram — gating', () => {
  it('no-ops when disabled', async () => {
    const fetchMock = vi.fn();
    const res = await sendTelegram(
      { enabled: false, botToken: 'x', chatId: 'y' },
      'hi',
      { fetchImpl: fetchMock as unknown as FetchLike },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBe('disabled');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('no-ops when token or chatId is blank', async () => {
    const fetchMock = vi.fn();
    const res = await sendTelegram(
      { enabled: true, botToken: '', chatId: '' },
      'hi',
      { fetchImpl: fetchMock as unknown as FetchLike },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBe('not_configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('sendTelegram — transport', () => {
  it('posts to the bot sendMessage endpoint and returns ok on 200', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => 'ok',
    }));
    const res = await sendTelegram(ENABLED, 'hallo welt', {
      fetchImpl: fetchMock as unknown as FetchLike,
    });
    expect(res.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      'https://api.telegram.org/bot123456:AAEhBOweik9bQ/sendMessage',
    );
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({
      chat_id: '99',
      text: 'hallo welt',
    });
  });

  it('returns ok:false with an http_ error on a non-2xx response', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    }));
    const res = await sendTelegram(ENABLED, 'x', {
      fetchImpl: fetchMock as unknown as FetchLike,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('http_401');
  });

  it('swallows a network rejection (never throws)', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const res = await sendTelegram(ENABLED, 'x', {
      fetchImpl: fetchMock as unknown as FetchLike,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('ECONNREFUSED');
  });
});
