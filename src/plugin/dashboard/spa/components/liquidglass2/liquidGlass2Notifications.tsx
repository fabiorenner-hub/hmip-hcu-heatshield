/**
 * Heat Shield — "Liquid Glass V2" Benachrichtigungen (route `/benachrichtigungen`).
 *
 * lg2-native rework of the v1 `NotificationsTab`. Reuses the v1 DATA layer
 * (`useConfig` + the debounced auto-save, `POST /api/notifications/test`) but is
 * an own lg2 component built from `--lg2-*` tokens and own `lg2-*` classes — it
 * does NOT embed the v1 tab and carries no `--hs-*`/`--color-*` or v1 classes.
 *
 * Full v1 functional scope (no feature loss):
 *   - Telegram: enabled, bot token, chat ID, chat commands, control commands,
 *     additional allowed chat IDs, and the "Telegram-Test senden" button that
 *     flushes the draft first and calls `POST /api/notifications/test`.
 *   - Events & schedules: morning briefing time, per-event toggles
 *     (ventilate/open/close/weather), daily evening summary + its time.
 *   - Regular weather updates: enabled + every-N-hours.
 *
 * Bilingual throughout, honest `–`/empty degradation.
 */

import { h, type JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import type { Config } from '../../../../../shared/types.js';
import { useConfig } from '../../hooks/useConfig.js';
import { t } from '../../i18n.js';

interface RoutableProps {
  path?: string;
}

type Notifications = NonNullable<Config['notifications']>;

/** v1 default block — used whenever `config.notifications` is still undefined. */
const DEFAULT_NOTIFICATIONS: Notifications = {
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
};

const EVENT_KEYS = ['ventilate', 'open', 'close', 'weather'] as const;

export function LiquidGlass2Notifications(_props: RoutableProps): JSX.Element {
  const cfg = useConfig();
  const [draft, setDraft] = useState<Config | null>(null);
  const [telegramTest, setTelegramTest] = useState<string | null>(null);

  useEffect(() => {
    if (cfg.config.value !== null && draft === null) setDraft(cfg.config.value);
  }, [cfg.config.value]);

  // Auto-save after a short idle; the deep-equality guard prevents a save loop
  // once the server echoes the persisted config back.
  useEffect(() => {
    if (draft === null || cfg.config.value === null) return;
    if (JSON.stringify(draft) !== JSON.stringify(cfg.config.value)) cfg.scheduleSave(draft);
  }, [draft]);

  const patch = (mutate: (n: Notifications) => Notifications): void => {
    setDraft((prev) => {
      if (prev === null) return prev;
      const current = prev.notifications ?? DEFAULT_NOTIFICATIONS;
      return { ...prev, notifications: mutate(current) };
    });
  };

  const runTelegramTest = (): void => {
    setTelegramTest(t('Sende…', 'Sending…'));
    void (async (): Promise<void> => {
      if (draft !== null) await cfg.save(draft);
      try {
        const res = await fetch('/api/notifications/test', { method: 'POST' });
        if (res.status === 503) {
          setTelegramTest(t('Nicht verfügbar (Plugin-Boot).', 'Unavailable (plugin boot).'));
          return;
        }
        const json = (await res.json()) as { ok: boolean; error?: string };
        setTelegramTest(
          json.ok
            ? t('Gesendet ✅', 'Sent ✅')
            : t(`Fehler: ${json.error ?? 'unbekannt'}`, `Error: ${json.error ?? 'unknown'}`),
        );
      } catch {
        setTelegramTest(t('Netzwerkfehler', 'Network error'));
      }
    })();
  };

  if (draft === null) {
    return (
      <main class="lg2-main lg2-notif" data-testid="liquid-glass2-notifications">
        <header class="lg2-header">
          <div><h1 class="lg2-header__title">{t('Benachrichtigungen', 'Notifications')}</h1></div>
        </header>
        <div class="lg2-card lg2-notif__empty">{t('Konfiguration wird geladen…', 'Loading configuration…')}</div>
      </main>
    );
  }

  const n = draft.notifications;
  const eventLabel = (key: (typeof EVENT_KEYS)[number]): string => {
    switch (key) {
      case 'ventilate': return t('Lüften', 'Ventilate');
      case 'open': return t('Öffnen', 'Open');
      case 'close': return t('Schließen', 'Close');
      case 'weather': return t('Wetter', 'Weather');
      default: return key;
    }
  };

  return (
    <main class="lg2-main lg2-notif" data-testid="liquid-glass2-notifications">
      <header class="lg2-header">
        <div>
          <h1 class="lg2-header__title">{t('Benachrichtigungen', 'Notifications')}</h1>
          <p class="lg2-header__sub">{t('Telegram-Bot, Ereignisse und Zeitpläne', 'Telegram bot, events and schedules')}</p>
        </div>
        <span class="lg2-notif__autosave" data-testid="lg2-notif-autosave">
          {cfg.loading.value ? t('Speichert…', 'Saving…') : t('Automatisch gespeichert', 'Auto-saved')}
        </span>
      </header>

      {cfg.saveError.value !== null && (
        <div class="lg2-card lg2-notif__error" data-testid="lg2-notif-save-error">
          {cfg.saveError.value.error.message}
        </div>
      )}

      {/* Telegram */}
      <section class="lg2-card lg2-notif__card" data-testid="lg2-notif-telegram">
        <h2 class="lg2-card__title">{t('Telegram-Bot', 'Telegram bot')}</h2>
        <p class="lg2-form__hint">
          {t(
            'Einrichten: 1) In Telegram @BotFather öffnen, /newbot senden, Namen vergeben → du erhältst den Bot-Token (Form 123456:ABC-DEF…). 2) Deinem neuen Bot eine beliebige Nachricht schreiben. 3) Deine Chat-ID über @userinfobot auslesen. Beides hier eintragen, „Telegram aktiv" anhaken und unten testen. Für den interaktiven Bot „Chat-Befehle aktiv" einschalten und im Chat /hilfe senden.',
            'Setup: 1) In Telegram open @BotFather, send /newbot, assign a name → you receive the bot token (form 123456:ABC-DEF…). 2) Send any message to your new bot. 3) Read your chat ID via @userinfobot. Enter both here, tick "Telegram active" and test below. For the interactive bot, enable "Chat commands active" and send /hilfe in the chat.',
          )}
        </p>

        <ToggleRow on={n?.telegram.enabled ?? false} testId="lg2-notif-telegram-enabled"
          label={t('Telegram aktiv', 'Telegram active')}
          onToggle={(on): void => patch((c) => ({ ...c, telegram: { ...c.telegram, enabled: on } }))} />

        <TextField label={t('Bot-Token', 'Bot token')} value={n?.telegram.botToken ?? ''}
          testId="lg2-notif-telegram-token"
          placeholder={t('123456:ABC… (maskiert angezeigt)', '123456:ABC… (shown masked)')}
          onInput={(v): void => patch((c) => ({ ...c, telegram: { ...c.telegram, botToken: v } }))} />

        <TextField label={t('Chat-ID', 'Chat ID')} value={n?.telegram.chatId ?? ''}
          testId="lg2-notif-telegram-chat"
          onInput={(v): void => patch((c) => ({ ...c, telegram: { ...c.telegram, chatId: v } }))} />

        <ToggleRow on={n?.telegram.commandsEnabled ?? false} testId="lg2-notif-telegram-commands"
          label={t('Chat-Befehle aktiv', 'Chat commands active')}
          hint={t('Bot reagiert auf /status, /wetter …', 'Bot responds to /status, /wetter …')}
          onToggle={(on): void => patch((c) => ({ ...c, telegram: { ...c.telegram, commandsEnabled: on } }))} />

        <ToggleRow on={n?.telegram.allowControl ?? true} testId="lg2-notif-telegram-control"
          label={t('Steuerbefehle erlauben', 'Allow control commands')}
          hint={t('/pause, /urlaub, /set …', '/pause, /urlaub, /set …')}
          onToggle={(on): void => patch((c) => ({ ...c, telegram: { ...c.telegram, allowControl: on } }))} />

        <TextField label={t('Weitere erlaubte Chat-IDs (kommagetrennt)', 'Additional allowed chat IDs (comma-separated)')}
          value={(n?.telegram.allowedChatIds ?? []).join(', ')}
          testId="lg2-notif-telegram-allowed"
          placeholder={t('z. B. 111111, 222222', 'e.g. 111111, 222222')}
          onInput={(raw): void => {
            const ids = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
            patch((c) => ({ ...c, telegram: { ...c.telegram, allowedChatIds: ids } }));
          }} />

        <div class="lg2-form__test">
          <button type="button" class="lg2-btn" data-testid="lg2-notif-telegram-test"
            onClick={runTelegramTest}>
            {t('Telegram-Test senden', 'Send Telegram test')}
          </button>
          {telegramTest !== null && (
            <span class="lg2-form__status" data-testid="lg2-notif-telegram-test-status">{telegramTest}</span>
          )}
        </div>
      </section>

      {/* Events & schedules */}
      <section class="lg2-card lg2-notif__card" data-testid="lg2-notif-events">
        <h2 class="lg2-card__title">{t('Ereignisse & Zeitpläne', 'Events & schedules')}</h2>

        <TextField label={t('Morgen-Briefing Uhrzeit', 'Morning briefing time')} type="time"
          value={n?.morningBriefLocalTime ?? '07:30'} testId="lg2-notif-morning-time"
          onInput={(v): void => patch((c) => ({ ...c, morningBriefLocalTime: v }))} />

        <div class="lg2-notif__events" data-testid="lg2-notif-event-toggles">
          {EVENT_KEYS.map((key) => (
            <ToggleRow key={key} on={n?.events[key] ?? true} testId={`lg2-notif-event-${key}`}
              label={eventLabel(key)}
              onToggle={(on): void => patch((c) => ({ ...c, events: { ...c.events, [key]: on } }))} />
          ))}
        </div>

        <ToggleRow on={n?.dailySummaryEnabled ?? false} testId="lg2-notif-daily-summary-enabled"
          label={t('Täglicher Abend-Rückblick', 'Daily evening summary')}
          onToggle={(on): void => patch((c) => ({ ...c, dailySummaryEnabled: on }))} />

        <TextField label={t('Rückblick Uhrzeit', 'Summary time')} type="time"
          value={n?.dailySummaryLocalTime ?? '21:00'} testId="lg2-notif-daily-summary-time"
          onInput={(v): void => patch((c) => ({ ...c, dailySummaryLocalTime: v }))} />
      </section>

      {/* Regular weather updates */}
      <section class="lg2-card lg2-notif__card" data-testid="lg2-notif-forecast">
        <h2 class="lg2-card__title">{t('Regelmäßige Wetter-Updates', 'Regular weather updates')}</h2>

        <ToggleRow on={n?.forecastUpdates?.enabled ?? false} testId="lg2-notif-forecast-enabled"
          label={t('Wetter-Updates senden', 'Send weather updates')}
          onToggle={(on): void => patch((c) => ({ ...c, forecastUpdates: { ...c.forecastUpdates, enabled: on } }))} />

        <NumField label={t('Alle … Stunden', 'Every … hours')} value={n?.forecastUpdates?.everyHours ?? 3}
          min={1} max={24} step={1} testId="lg2-notif-forecast-hours"
          onChange={(v): void => patch((c) => ({
            ...c,
            forecastUpdates: { ...c.forecastUpdates, everyHours: Math.min(24, Math.max(1, Math.round(v))) },
          }))} />
      </section>
    </main>
  );
}

/* -------------------------------------------------------------------------- */
/* lg2 form primitives (shared lg2-form__* classes)                           */
/* -------------------------------------------------------------------------- */

function ToggleRow(props: {
  on: boolean;
  label: string;
  hint?: string;
  testId?: string;
  onToggle: (on: boolean) => void;
}): JSX.Element {
  return (
    <div class="lg2-form__row">
      <span class="lg2-form__row-text">
        <span class="lg2-form__row-label">{props.label}</span>
        {props.hint !== undefined && <span class="lg2-form__row-hint">{props.hint}</span>}
      </span>
      <button type="button" role="switch" aria-checked={props.on}
        class={`lg2-toggle${props.on ? ' lg2-toggle--on' : ''}`}
        {...(props.testId !== undefined ? { 'data-testid': props.testId } : {})}
        onClick={(): void => props.onToggle(!props.on)} />
    </div>
  );
}

function TextField(props: {
  label: string;
  value: string;
  type?: string;
  placeholder?: string;
  testId?: string;
  onInput: (v: string) => void;
}): JSX.Element {
  return (
    <label class="lg2-form__field">
      <span class="lg2-form__label">{props.label}</span>
      <input type={props.type ?? 'text'} class="lg2-form__control" value={props.value}
        {...(props.placeholder !== undefined ? { placeholder: props.placeholder } : {})}
        {...(props.testId !== undefined ? { 'data-testid': props.testId } : {})}
        onInput={(e): void => props.onInput((e.currentTarget as HTMLInputElement).value)} />
    </label>
  );
}

function NumField(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  testId?: string;
  onChange: (v: number) => void;
}): JSX.Element {
  return (
    <label class="lg2-form__num">
      <span class="lg2-form__label">{props.label}</span>
      <span class="lg2-form__num-box">
        <input type="number" min={props.min} max={props.max} step={props.step} value={props.value}
          {...(props.testId !== undefined ? { 'data-testid': props.testId } : {})}
          onInput={(e): void => {
            const v = Number.parseFloat((e.currentTarget as HTMLInputElement).value);
            if (Number.isFinite(v)) props.onChange(v);
          }} />
        {props.unit !== undefined && props.unit !== '' && <em>{props.unit}</em>}
      </span>
    </label>
  );
}
