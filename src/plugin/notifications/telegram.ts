/**
 * Heat Shield — Telegram sender (smart-shading-notifications Task 8).
 *
 * Sends a plain-text message through the Telegram Bot HTTP API using the
 * built-in `fetch` — no third-party library (the project is Node/TS, and the
 * Bot API is a single HTTPS POST). Telegram is the only new outbound endpoint
 * and is opt-in (`enabled`); it is the user-approved exception to the
 * otherwise-LOCAL scope.
 *
 * Design / steering constraints:
 *   - Failures are swallowed: a missing config or an unreachable endpoint
 *     returns `{ ok: false, error }` and never throws, so the cycle keeps
 *     running and the message still lands in the in-app store (Requirement
 *     8.4).
 *   - The bot token is a secret: it appears only in the request URL and is
 *     NEVER logged. {@link maskToken} produces a safe display form for the
 *     dashboard `/api/config` response (Requirement 8.5).
 */

import type { TelegramConfig } from '../../shared/types.js';

export interface TelegramSendResult {
  ok: boolean;
  error?: string;
}

/** Minimal `fetch` shape so tests can inject a mock without DOM lib types. */
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export interface SendTelegramOptions {
  /** Injectable fetch (defaults to global `fetch`). */
  fetchImpl?: FetchLike;
  /** Timeout in ms before the request is aborted. Default 8000. */
  timeoutMs?: number;
  /** Optional inline keyboard / reply markup (sent as `reply_markup`). */
  replyMarkup?: unknown;
}

/**
 * Mask a bot token for display: keep the numeric bot id prefix (before the
 * first `:`) and the last 4 characters, replace the middle with `…`.
 * An empty token returns an empty string. The result is safe to surface in
 * the dashboard and logs.
 *
 * Example: `123456:AAEhBOweik...maybe...9Z` → `123456:…9Z9Z`-style hint.
 */
export function maskToken(token: string): string {
  if (token.length === 0) {
    return '';
  }
  const colon = token.indexOf(':');
  const prefix = colon > 0 ? token.slice(0, colon + 1) : '';
  const secret = colon > 0 ? token.slice(colon + 1) : token;
  if (secret.length <= 4) {
    return `${prefix}••••`;
  }
  return `${prefix}••••${secret.slice(-4)}`;
}

/**
 * Send `text` to the configured chat. Returns `{ ok: true }` on a 2xx
 * response; otherwise `{ ok: false, error }`. Never throws.
 *
 * No-ops (returning `ok: false`) when the integration is disabled or the
 * token/chatId are blank — the caller treats that as "not configured" and
 * keeps the message in-app.
 */
export async function sendTelegram(
  cfg: TelegramConfig,
  text: string,
  options?: SendTelegramOptions,
): Promise<TelegramSendResult> {
  if (!cfg.enabled) {
    return { ok: false, error: 'disabled' };
  }
  if (cfg.botToken.length === 0 || cfg.chatId.length === 0) {
    return { ok: false, error: 'not_configured' };
  }

  const fetchImpl = options?.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
  if (fetchImpl === undefined) {
    return { ok: false, error: 'no_fetch' };
  }

  const timeoutMs = options?.timeoutMs ?? 8000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const url = `https://api.telegram.org/bot${cfg.botToken}/sendMessage`;
  try {
    const payload: Record<string, unknown> = { chat_id: cfg.chatId, text };
    if (options?.replyMarkup !== undefined) {
      payload['reply_markup'] = options.replyMarkup;
    }
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      // Read the body for diagnostics but do not leak it verbatim with the
      // token; the URL is the only place the token appears and we never log
      // the URL.
      let detail = '';
      try {
        detail = (await res.text()).slice(0, 200);
      } catch {
        detail = '';
      }
      return { ok: false, error: `http_${res.status}${detail ? `: ${detail}` : ''}` };
    }
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/** One incoming Telegram update (subset we consume). */
export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type?: string };
    from?: { id: number; username?: string };
    text?: string;
  };
  callback_query?: {
    id: string;
    data?: string;
    from?: { id: number; username?: string };
    message?: { message_id: number; chat: { id: number } };
  };
}

export interface TelegramUpdatesResult {
  ok: boolean;
  updates: TelegramUpdate[];
  error?: string;
}

/**
 * Long-poll `getUpdates`. Pass `offset = lastSeenUpdateId + 1`. Never throws;
 * on any transport/parse error returns `{ ok: false, updates: [], error }`.
 *
 * `timeoutS` is the server-side long-poll hold; the client AbortController is
 * set a few seconds beyond that so the HTTP request does not abort before the
 * server returns.
 */
export async function getTelegramUpdates(
  cfg: TelegramConfig,
  offset: number,
  options?: SendTelegramOptions & { timeoutS?: number },
): Promise<TelegramUpdatesResult> {
  if (!cfg.enabled || cfg.botToken.length === 0) {
    return { ok: false, updates: [], error: 'not_configured' };
  }
  const fetchImpl = options?.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
  if (fetchImpl === undefined) {
    return { ok: false, updates: [], error: 'no_fetch' };
  }
  const timeoutS = options?.timeoutS ?? 25;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), (timeoutS + 5) * 1000);
  const url = `https://api.telegram.org/bot${cfg.botToken}/getUpdates`;
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ offset, timeout: timeoutS, allowed_updates: ['message', 'callback_query'] }),
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, updates: [], error: `http_${res.status}` };
    }
    const raw = await res.text();
    const parsed = JSON.parse(raw) as { ok?: boolean; result?: unknown };
    if (parsed.ok !== true || !Array.isArray(parsed.result)) {
      return { ok: false, updates: [], error: 'bad_response' };
    }
    const updates: TelegramUpdate[] = [];
    for (const u of parsed.result) {
      if (
        u !== null &&
        typeof u === 'object' &&
        typeof (u as { update_id?: unknown }).update_id === 'number'
      ) {
        updates.push(u as TelegramUpdate);
      }
    }
    return { ok: true, updates };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, updates: [], error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Acknowledge a callback_query (inline-button tap) so Telegram stops the
 * button's loading spinner. Best-effort; never throws.
 */
export async function answerCallbackQuery(
  cfg: TelegramConfig,
  callbackQueryId: string,
  options?: SendTelegramOptions,
): Promise<void> {
  if (!cfg.enabled || cfg.botToken.length === 0) {
    return;
  }
  const fetchImpl = options?.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
  if (fetchImpl === undefined) {
    return;
  }
  const url = `https://api.telegram.org/bot${cfg.botToken}/answerCallbackQuery`;
  try {
    await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId }),
    });
  } catch {
    // ignore
  }
}
