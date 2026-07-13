/**
 * Heat Shield — Telegram command registry.
 *
 * Defines the bot's command surface as data and binds each to an injected
 * context function. The context (in `index.ts`) owns the engine/config
 * access; this module owns the command names, German help text, and the
 * read-vs-control classification the bot uses for authorization.
 */

import type { TelegramCommand } from './telegramBot.js';

/** Injected query + control actions the commands call. All return reply text. */
export interface TelegramCommandContext {
  /** Current mode + feels-like + per-window targets. */
  statusText: () => string;
  /** Today's weather/forecast brief. */
  forecastText: () => string;
  /** Rooms with current temperatures. */
  roomsText: () => string;
  /** Pause automation for `minutes` (null = until next local midnight). */
  pause: (minutes: number | null) => string;
  /** Resume automation. */
  resume: () => string;
  /** Toggle vacation intent. */
  setVacation: (on: boolean) => string;
  /** Toggle the master automation lever. */
  setAutomation: (on: boolean) => string;
  /** Set a named setting (`key` + raw value string). */
  setParam: (key: string, value: string) => string;
  /**
   * Answer a pending "should the shutter re-close after your manual change?"
   * question. `yes` releases the manual override so automation resumes;
   * `no` keeps the shutter held at the user's position for another window.
   */
  confirmReclose: (yes: boolean) => string;
}

function parseOnOff(arg: string): boolean | null {
  const a = arg.trim().toLowerCase();
  if (['on', 'an', 'ein', '1', 'true', 'ja'].includes(a)) {
    return true;
  }
  if (['off', 'aus', '0', 'false', 'nein'].includes(a)) {
    return false;
  }
  return null;
}

/**
 * Build the full command list bound to `ctx`. The `/hilfe` command is appended
 * last and lists every other command's name + description.
 */
export function buildTelegramCommands(
  ctx: TelegramCommandContext,
): TelegramCommand[] {
  const commands: TelegramCommand[] = [
    {
      name: 'status',
      description: 'Aktueller Modus, gefühlte Wärme und Rollladen-Ziele',
      run: () => ctx.statusText(),
    },
    {
      name: 'wetter',
      aliases: ['forecast', 'vorhersage'],
      description: 'Wetter-/Tagesvorschau',
      run: () => ctx.forecastText(),
    },
    {
      name: 'raeume',
      aliases: ['räume', 'rooms', 'zimmer'],
      description: 'Räume mit aktuellen Temperaturen',
      run: () => ctx.roomsText(),
    },
    {
      name: 'pause',
      description: 'Automatik pausieren — optional /pause <Minuten>',
      control: true,
      run: (args) => {
        const trimmed = args.trim();
        if (trimmed.length === 0) {
          return ctx.pause(null);
        }
        const min = Number.parseInt(trimmed, 10);
        if (!Number.isFinite(min) || min <= 0) {
          return 'Bitte eine positive Minutenzahl angeben, z. B. /pause 120.';
        }
        return ctx.pause(min);
      },
    },
    {
      name: 'weiter',
      aliases: ['resume', 'fortsetzen'],
      description: 'Automatik wieder aufnehmen',
      control: true,
      run: () => ctx.resume(),
    },
    {
      name: 'urlaub',
      aliases: ['vacation'],
      description: 'Urlaubsmodus an/aus — /urlaub an | aus',
      control: true,
      run: (args) => {
        const v = parseOnOff(args);
        if (v === null) {
          return 'Bitte „an" oder „aus" angeben, z. B. /urlaub an.';
        }
        return ctx.setVacation(v);
      },
    },
    {
      name: 'automatik',
      aliases: ['automation'],
      description: 'Master-Automatik an/aus — /automatik an | aus',
      control: true,
      run: (args) => {
        const v = parseOnOff(args);
        if (v === null) {
          return 'Bitte „an" oder „aus" angeben, z. B. /automatik an.';
        }
        return ctx.setAutomation(v);
      },
    },
    {
      name: 'set',
      aliases: ['setze'],
      description:
        'Einstellung ändern — /set <name> <wert>. /set hilfe zeigt die Namen.',
      control: true,
      run: (args) => {
        const trimmed = args.trim();
        const sp = trimmed.search(/\s/u);
        const key = (sp === -1 ? trimmed : trimmed.slice(0, sp)).toLowerCase();
        const value = sp === -1 ? '' : trimmed.slice(sp + 1).trim();
        if (key.length === 0) {
          return ctx.setParam('hilfe', '');
        }
        return ctx.setParam(key, value);
      },
    },
  ];

  commands.push({
    name: 'ja',
    aliases: ['yes', 'j'],
    description: 'Rückfrage bestätigen — Rollladen darf wieder schließen',
    control: true,
    run: () => ctx.confirmReclose(true),
  });

  commands.push({
    name: 'nein',
    aliases: ['no', 'n'],
    description: 'Rückfrage ablehnen — Rollladen bleibt offen (Position halten)',
    control: true,
    run: () => ctx.confirmReclose(false),
  });

  commands.push({
    name: 'menu',
    aliases: ['menü'],
    description: 'Schnellzugriff-Tasten anzeigen',
    menu: true,
    run: () => 'Schnellzugriff:',
  });

  commands.push({
    name: 'hilfe',
    aliases: ['help', 'start'],
    description: 'Diese Hilfe anzeigen',
    menu: true,
    run: () => {
      const lines = ['🛡 *Heat Shield* — Befehle:'];
      for (const c of commands) {
        const lock = c.control === true ? ' 🔧' : '';
        lines.push(`/${c.name}${lock} — ${c.description}`);
      }
      lines.push('', '🔧 = Steuerbefehl (ändert Einstellungen).');
      return lines.join('\n');
    },
  });

  return commands;
}
