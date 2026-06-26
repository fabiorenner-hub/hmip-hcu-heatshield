/**
 * Heat Shield — two-way Telegram bot (long-polling).
 *
 * Extends the one-way notifier into a conversational interface: residents can
 * query the plugin (`/status`, `/wetter`, `/raeume`) and — when control is
 * enabled and they are authorized — change settings (`/pause`, `/urlaub`,
 * `/automatik`, `/set …`). Forecast/status pushes are scheduled separately
 * (see the cycle wiring in `index.ts`).
 *
 * ## Transport
 *
 * The HCU sits on a LAN with no public HTTPS endpoint, so a Telegram webhook
 * is not an option. We use **long-polling** via `getUpdates` (a single HTTPS
 * request that the Telegram server holds open until a message arrives or the
 * timeout elapses). The last processed `update_id + 1` is the offset; it is
 * persisted so a restart never reprocesses old commands.
 *
 * ## Security
 *
 * Commands are only honoured from the configured `chatId` or an explicit
 * `allowedChatIds` entry. Control commands additionally require
 * `telegram.allowControl`. Unauthorized chats get a single polite refusal so
 * the bot does not leak its capabilities. The bot token is never logged.
 *
 * Module rules: no fs (offset persistence is injected), strict TS, ESM.
 */

import type { TelegramConfig } from '../../shared/types.js';

import {
  answerCallbackQuery,
  getTelegramUpdates,
  sendTelegram,
  type FetchLike,
} from './telegram.js';

/** One inline-keyboard button: shown text + the command it triggers. */
export interface MenuButton {
  text: string;
  /** Command string to run on tap, e.g. `/status` or `/urlaub an`. */
  command: string;
}

/** One bot command. `run` returns the reply text (Markdown-free plain text). */
export interface TelegramCommand {
  /** Primary name without the leading slash, lowercase (e.g. `status`). */
  name: string;
  /** Optional alternative names (e.g. `wetter` ↔ `forecast`). */
  aliases?: readonly string[];
  /** One-line description shown by `/help`. */
  description: string;
  /** When true the command changes state and requires `allowControl`. */
  control?: boolean;
  /** When true, the reply carries the quick-action inline keyboard. */
  menu?: boolean;
  /** Handler: receives the trimmed argument string and the requesting chat id. */
  run: (args: string, chatId: string) => Promise<string> | string;
}

export interface TelegramBotDeps {
  /** Live telegram config (token/chatId/flags). Read fresh each poll. */
  getTelegram: () => TelegramConfig;
  /** Command registry. */
  commands: readonly TelegramCommand[];
  /** Injectable fetch (defaults to global). */
  fetchImpl?: FetchLike;
  /** Long-poll hold in seconds (default 25). */
  pollTimeoutS?: number;
  /** Load the persisted update offset on start (default → 0). */
  loadOffset?: () => Promise<number>;
  /** Persist the update offset after processing. */
  saveOffset?: (offset: number) => Promise<void>;
  /** Optional quick-action menu (rows of buttons) for `menu` commands. */
  menu?: readonly MenuButton[][];
  logger?: (level: 'info' | 'warn', msg: string, ctx?: Record<string, unknown>) => void;
}

/** Parse `/command args…` (tolerates a `@botname` suffix). `null` if not a command. */
export function parseCommand(
  text: string,
): { name: string; args: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) {
    return null;
  }
  const spaceIdx = trimmed.search(/\s/u);
  const head = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const args = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();
  // Strip leading slash and an optional @botname mention.
  const name = head.slice(1).split('@')[0]!.toLowerCase();
  return { name, args };
}

export class TelegramBot {
  private readonly deps: TelegramBotDeps;

  private offset = 0;

  private running = false;

  private inFlight: Promise<void> | null = null;

  constructor(deps: TelegramBotDeps) {
    this.deps = deps;
  }

  /** Begin the long-poll loop (no-op if commands are disabled). */
  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    if (this.deps.loadOffset !== undefined) {
      try {
        this.offset = await this.deps.loadOffset();
      } catch {
        this.offset = 0;
      }
    }
    void this.loop();
  }

  stop(): void {
    this.running = false;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      const cfg = this.deps.getTelegram();
      if (!cfg.enabled || !cfg.commandsEnabled || cfg.botToken.length === 0) {
        // Bot disabled — idle a bit and re-check (config may flip on).
        await this.sleep(5000);
        continue;
      }
      try {
        await this.pollOnce();
      } catch (err) {
        this.deps.logger?.('warn', 'telegram bot poll failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        await this.sleep(3000);
      }
    }
  }

  /**
   * One getUpdates round-trip + dispatch. Public so tests can drive a single
   * cycle deterministically.
   */
  async pollOnce(): Promise<void> {
    if (this.inFlight !== null) {
      return this.inFlight;
    }
    const work = this.doPoll();
    this.inFlight = work;
    try {
      await work;
    } finally {
      this.inFlight = null;
    }
  }

  private async doPoll(): Promise<void> {
    const cfg = this.deps.getTelegram();
    const opts: Parameters<typeof getTelegramUpdates>[2] = {
      timeoutS: this.deps.pollTimeoutS ?? 25,
    };
    if (this.deps.fetchImpl !== undefined) {
      opts.fetchImpl = this.deps.fetchImpl;
    }
    const res = await getTelegramUpdates(cfg, this.offset, opts);
    if (!res.ok) {
      return;
    }
    for (const update of res.updates) {
      this.offset = Math.max(this.offset, update.update_id + 1);
      if (update.callback_query !== undefined) {
        await this.handleCallback(update.callback_query, cfg);
      } else {
        await this.handleUpdate(update, cfg);
      }
    }
    if (res.updates.length > 0 && this.deps.saveOffset !== undefined) {
      try {
        await this.deps.saveOffset(this.offset);
      } catch {
        // best-effort
      }
    }
  }

  private isAuthorized(chatId: string, cfg: TelegramConfig): boolean {
    return chatId === cfg.chatId || cfg.allowedChatIds.includes(chatId);
  }

  private async handleUpdate(
    update: { message?: { chat: { id: number }; text?: string } },
    cfg: TelegramConfig,
  ): Promise<void> {
    const msg = update.message;
    if (msg === undefined || typeof msg.text !== 'string') {
      return;
    }
    await this.dispatch(msg.text, String(msg.chat.id), cfg);
  }

  private async handleCallback(
    cb: { id: string; data?: string; message?: { chat: { id: number } } },
    cfg: TelegramConfig,
  ): Promise<void> {
    // Stop the button spinner regardless of outcome.
    const opts = this.deps.fetchImpl !== undefined ? { fetchImpl: this.deps.fetchImpl } : undefined;
    await answerCallbackQuery(cfg, cb.id, opts);
    const chatId = cb.message !== undefined ? String(cb.message.chat.id) : '';
    if (typeof cb.data !== 'string' || chatId.length === 0) {
      return;
    }
    // Button callback_data is a command line (with leading slash).
    await this.dispatch(cb.data, chatId, cfg);
  }

  /** Shared command dispatch for typed messages and button callbacks. */
  private async dispatch(text: string, chatId: string, cfg: TelegramConfig): Promise<void> {
    const parsed = parseCommand(text);
    if (parsed === null) {
      return; // not a command — ignore chit-chat
    }
    if (!this.isAuthorized(chatId, cfg)) {
      await this.reply(cfg, chatId, '⛔ Dieser Chat ist nicht autorisiert.', false);
      return;
    }
    const cmd = this.deps.commands.find(
      (c) => c.name === parsed.name || (c.aliases?.includes(parsed.name) ?? false),
    );
    if (cmd === undefined) {
      await this.reply(
        cfg,
        chatId,
        `Unbekannter Befehl: /${parsed.name}\nMit /hilfe siehst du alle Befehle.`,
        false,
      );
      return;
    }
    if (cmd.control === true && !cfg.allowControl) {
      await this.reply(cfg, chatId, 'Steuerbefehle sind deaktiviert (Regeln-Tab).', false);
      return;
    }
    let replyText: string;
    try {
      replyText = await cmd.run(parsed.args, chatId);
    } catch (err) {
      replyText = `Fehler: ${err instanceof Error ? err.message : String(err)}`;
    }
    await this.reply(cfg, chatId, replyText, cmd.menu === true);
  }

  private async reply(
    cfg: TelegramConfig,
    chatId: string,
    text: string,
    withMenu: boolean,
  ): Promise<void> {
    const opts: Parameters<typeof sendTelegram>[2] = {};
    if (this.deps.fetchImpl !== undefined) {
      opts.fetchImpl = this.deps.fetchImpl;
    }
    if (withMenu && this.deps.menu !== undefined && this.deps.menu.length > 0) {
      opts.replyMarkup = {
        inline_keyboard: this.deps.menu.map((row) =>
          row.map((b) => ({ text: b.text, callback_data: b.command })),
        ),
      };
    }
    await sendTelegram({ ...cfg, chatId }, text, opts);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
