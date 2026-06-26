/**
 * Heat Shield — notification service (smart-shading-notifications Task 7.2/7.3).
 *
 * Turns engine state transitions into resident messages, deduplicates them so
 * a steady state never spams, and routes each message to the MessageStore
 * (always) and the TelegramSender (when enabled). Per-event toggles in
 * `notifications.events` gate which transitions actually produce a message.
 *
 * The service is fed *transitions* by the orchestrator (the shading FSM and
 * the contact watcher only emit on change), and additionally guards against
 * consecutive duplicates per window so a re-asserted state cannot double-post.
 *
 * Module rules: no fs of its own (it delegates to the injected store), no
 * direct global fetch (delegates to `sendTelegram`). Clock + id generator are
 * injectable for deterministic tests.
 */

import { randomUUID } from 'node:crypto';

import type {
  Message,
  MessageKind,
} from '../../shared/message-schema.js';
import type { NotificationEvents, TelegramConfig } from '../../shared/types.js';
import type { MessageStore } from '../persistence/messages.js';

import { sendTelegram, type SendTelegramOptions } from './telegram.js';

/** Engine transition kinds the orchestrator can report. */
export type ShadingEventKind =
  | 'shade.activated'
  | 'shade.released'
  | 'venting.suggested'
  | 'window.opened'
  | 'window.closed';

/** One engine transition for a specific window. */
export interface ShadingEvent {
  kind: ShadingEventKind;
  windowId: string;
  /** Human label for the window (room + window), used in the message copy. */
  label?: string;
}

interface MessageTemplate {
  kind: MessageKind;
  title: string;
  body: string;
  /** Whether the matching per-event toggle is on. */
  enabledKey: keyof NotificationEvents;
}

/** Notification language (installation-wide; default German). */
export type NotificationLang = 'de' | 'en';

function templateFor(event: ShadingEvent, lang: NotificationLang): MessageTemplate {
  const where = event.label !== undefined && event.label.length > 0
    ? ` (${event.label})`
    : '';
  if (lang === 'en') {
    switch (event.kind) {
      case 'shade.activated':
        return {
          kind: 'close',
          title: 'Heat protection active',
          body: `The shutter${where} is closing to protect against heat.`,
          enabledKey: 'close',
        };
      case 'shade.released':
        return {
          kind: 'open',
          title: 'Shutter opening',
          body: `No direct sun anymore – the shutter${where} is opening again.`,
          enabledKey: 'open',
        };
      case 'venting.suggested':
        return {
          kind: 'ventilate',
          title: 'Airing recommended',
          body: `It is cooler outside – now would be a good moment to air${where}.`,
          enabledKey: 'ventilate',
        };
      case 'window.opened':
        return {
          kind: 'ventilate',
          title: 'Airing detected',
          body: `Window${where} opened – automation pauses for this window until it is closed again.`,
          enabledKey: 'ventilate',
        };
      case 'window.closed':
        return {
          kind: 'info',
          title: 'Window closed',
          body: `Window${where} closed – shading control is active again.`,
          enabledKey: 'ventilate',
        };
    }
  }
  switch (event.kind) {
    case 'shade.activated':
      return {
        kind: 'close',
        title: 'Hitzeschutz aktiv',
        body: `Der Rollladen${where} fährt zum Schutz vor Hitze herunter.`,
        enabledKey: 'close',
      };
    case 'shade.released':
      return {
        kind: 'open',
        title: 'Rollladen öffnet',
        body: `Keine direkte Sonne mehr – der Rollladen${where} fährt wieder hoch.`,
        enabledKey: 'open',
      };
    case 'venting.suggested':
      return {
        kind: 'ventilate',
        title: 'Lüften empfohlen',
        body: `Es ist draußen kühler – jetzt wäre ein guter Moment zum Lüften${where}.`,
        enabledKey: 'ventilate',
      };
    case 'window.opened':
      return {
        kind: 'ventilate',
        title: 'Lüften erkannt',
        body: `Fenster${where} geöffnet – die Automatik pausiert für dieses Fenster, bis es wieder geschlossen ist.`,
        enabledKey: 'ventilate',
      };
    case 'window.closed':
      return {
        kind: 'info',
        title: 'Fenster geschlossen',
        body: `Fenster${where} geschlossen – die Beschattungssteuerung ist wieder aktiv.`,
        enabledKey: 'ventilate',
      };
  }
}

export interface NotificationServiceDeps {
  store: MessageStore;
  /** Live Telegram config (token may be blank/disabled). */
  telegram: TelegramConfig;
  /** Per-event enable toggles. */
  events: NotificationEvents;
  /** Notification language (installation-wide). Defaults to German. */
  language?: NotificationLang;
  /** Injectable clock. Defaults to `() => new Date()`. */
  now?: () => Date;
  /** Injectable id generator. Defaults to `randomUUID`. */
  idGen?: () => string;
  /** Telegram transport options (fetch injection for tests). */
  telegramOptions?: SendTelegramOptions;
  /** Optional logger; never receives the bot token. */
  logger?: (level: 'info' | 'warn', msg: string, ctx?: Record<string, unknown>) => void;
}

/**
 * Builds + routes notifications. One instance per plugin process; the
 * orchestrator calls {@link process} once per cycle with the transitions it
 * observed.
 */
export class NotificationService {
  private readonly store: MessageStore;

  private readonly telegram: TelegramConfig;

  private readonly events: NotificationEvents;

  private readonly language: NotificationLang;

  private readonly now: () => Date;

  private readonly idGen: () => string;

  private readonly telegramOptions: SendTelegramOptions | undefined;

  private readonly logger:
    | ((level: 'info' | 'warn', msg: string, ctx?: Record<string, unknown>) => void)
    | undefined;

  /** Last emitted event kind per window — consecutive-duplicate guard. */
  private readonly lastKindByWindow = new Map<string, ShadingEventKind>();

  constructor(deps: NotificationServiceDeps) {
    this.store = deps.store;
    this.telegram = deps.telegram;
    this.events = deps.events;
    this.language = deps.language ?? 'de';
    this.now = deps.now ?? ((): Date => new Date());
    this.idGen = deps.idGen ?? ((): string => randomUUID());
    this.telegramOptions = deps.telegramOptions;
    this.logger = deps.logger;
  }

  /**
   * Process a batch of engine transitions. Same-kind transitions observed in
   * the same cycle are **grouped into a single message** (the user does not
   * want one notification per window). Returns the messages actually created
   * (after toggle gating + per-window dedup). Each created message is appended
   * to the store and, when Telegram is enabled, sent best-effort.
   */
  async process(events: readonly ShadingEvent[]): Promise<Message[]> {
    // Per-window consecutive-duplicate guard: drop a transition whose kind
    // equals the last one we saw for that window (no real state change).
    const survivors: ShadingEvent[] = [];
    for (const event of events) {
      if (this.lastKindByWindow.get(event.windowId) === event.kind) {
        continue;
      }
      this.lastKindByWindow.set(event.windowId, event.kind);
      survivors.push(event);
    }

    // Group surviving events by kind, preserving first-seen order so the
    // emitted message order is deterministic.
    const order: ShadingEventKind[] = [];
    const byKind = new Map<ShadingEventKind, ShadingEvent[]>();
    for (const e of survivors) {
      const list = byKind.get(e.kind);
      if (list === undefined) {
        byKind.set(e.kind, [e]);
        order.push(e.kind);
      } else {
        list.push(e);
      }
    }

    const created: Message[] = [];
    for (const kind of order) {
      const group = byKind.get(kind)!;
      const tpl = templateFor(group[0]!, this.language);
      if (!this.events[tpl.enabledKey]) {
        continue;
      }
      const { title, body } = this.composeGroup(kind, group);
      const message: Message = {
        id: this.idGen(),
        ts: this.now().toISOString(),
        kind: tpl.kind,
        title,
        body,
        read: false,
      };
      await this.store.append(message);
      created.push(message);
      await this.deliverTelegram(message);
    }
    return created;
  }

  /**
   * Build the title + body for a group of same-kind events. A single-event
   * group uses the per-window template copy; a multi-event group produces one
   * summary message listing all affected windows/rooms.
   */
  private composeGroup(
    kind: ShadingEventKind,
    group: readonly ShadingEvent[],
  ): { title: string; body: string } {
    if (group.length === 1) {
      const tpl = templateFor(group[0]!, this.language);
      return { title: tpl.title, body: tpl.body };
    }
    const labels = group
      .map((e) => (e.label !== undefined && e.label.length > 0 ? e.label : e.windowId))
      .join(', ');
    const n = group.length;
    if (this.language === 'en') {
      switch (kind) {
        case 'shade.activated':
          return {
            title: 'Heat protection active',
            body: `${n} shutters are closing to protect against heat: ${labels}.`,
          };
        case 'shade.released':
          return {
            title: 'Shutters opening',
            body: `No direct sun anymore – ${n} shutters are opening again: ${labels}.`,
          };
        case 'venting.suggested':
          return {
            title: 'Airing recommended',
            body: `It is cooler outside – air now (${n} rooms): ${labels}.`,
          };
        case 'window.opened':
          return {
            title: 'Airing detected',
            body: `${n} windows opened – automation pauses there until they are closed again: ${labels}.`,
          };
        case 'window.closed':
          return {
            title: 'Windows closed',
            body: `${n} windows closed – shading control is active again: ${labels}.`,
          };
      }
    }
    switch (kind) {
      case 'shade.activated':
        return {
          title: 'Hitzeschutz aktiv',
          body: `${n} Rollläden fahren zum Schutz vor Hitze herunter: ${labels}.`,
        };
      case 'shade.released':
        return {
          title: 'Rollläden öffnen',
          body: `Keine direkte Sonne mehr – ${n} Rollläden fahren wieder hoch: ${labels}.`,
        };
      case 'venting.suggested':
        return {
          title: 'Lüften empfohlen',
          body: `Es ist draußen kühler – jetzt lüften (${n} Räume): ${labels}.`,
        };
      case 'window.opened':
        return {
          title: 'Lüften erkannt',
          body: `${n} Fenster geöffnet – die Automatik pausiert dort, bis sie wieder geschlossen sind: ${labels}.`,
        };
      case 'window.closed':
        return {
          title: 'Fenster geschlossen',
          body: `${n} Fenster geschlossen – die Beschattungssteuerung ist wieder aktiv: ${labels}.`,
        };
    }
  }

  /**
   * Emit a standalone message not tied to a window transition (e.g. the
   * morning weather brief). Always stored; Telegram gated by `enabledKey`.
   */
  async emit(
    kind: MessageKind,
    title: string,
    body: string,
    enabledKey: keyof NotificationEvents,
  ): Promise<Message> {
    const message: Message = {
      id: this.idGen(),
      ts: this.now().toISOString(),
      kind,
      title,
      body,
      read: false,
    };
    await this.store.append(message);
    if (this.events[enabledKey]) {
      await this.deliverTelegram(message);
    }
    return message;
  }

  private async deliverTelegram(message: Message): Promise<void> {
    if (!this.telegram.enabled) {
      return;
    }
    const text = `${message.title}\n${message.body}`;
    const res = await sendTelegram(this.telegram, text, this.telegramOptions);
    if (!res.ok && this.logger !== undefined) {
      // Never logs the token — sendTelegram returns only a safe error string.
      this.logger('warn', 'telegram delivery failed', { error: res.error });
    }
  }
}
