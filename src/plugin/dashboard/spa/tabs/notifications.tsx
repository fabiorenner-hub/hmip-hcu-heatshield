/**
 * Heat Shield — "Benachrichtigungen" settings tab.
 *
 * Self-contained Telegram + notification configuration, moved out of the
 * Automation (rules) tab into its own Einstellungen tile. Edits auto-save
 * (debounced) through `useConfig`; the "Telegram-Test senden" button flushes
 * the draft first and then calls `POST /api/notifications/test`.
 */

import { h, type JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import type { Config } from '../../../../shared/types.js';
import { useConfig } from '../hooks/useConfig.js';
import { t } from '../i18n.js';

interface RoutableProps {
  path?: string;
}

const DEFAULT_NOTIFICATIONS: NonNullable<Config['notifications']> = {
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

export function NotificationsTab(_props: RoutableProps): JSX.Element {
  const cfg = useConfig();
  const [draftConfig, setDraftConfig] = useState<Config | null>(null);
  const [telegramTest, setTelegramTest] = useState<string | null>(null);

  useEffect(() => {
    if (cfg.config.value !== null && draftConfig === null) {
      setDraftConfig(cfg.config.value);
    }
  }, [cfg.config.value]);

  // Auto-save after a short idle; deep-equality guard prevents a save loop
  // once the server echoes the persisted config back.
  useEffect(() => {
    if (draftConfig === null || cfg.config.value === null) {
      return;
    }
    if (JSON.stringify(draftConfig) !== JSON.stringify(cfg.config.value)) {
      cfg.scheduleSave(draftConfig);
    }
  }, [draftConfig]);

  const patchNotifications = (
    mutate: (
      n: NonNullable<Config['notifications']>,
    ) => NonNullable<Config['notifications']>,
  ): void => {
    setDraftConfig((prev) => {
      if (prev === null) {
        return prev;
      }
      const current = prev.notifications ?? DEFAULT_NOTIFICATIONS;
      return { ...prev, notifications: mutate(current) };
    });
  };

  const handleTelegramTest = async (): Promise<void> => {
    setTelegramTest(t('Sende…', 'Sending…'));
    if (draftConfig !== null) {
      await cfg.save(draftConfig);
    }
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
  };

  if (draftConfig === null) {
    return (
      <section class="module-panel tab-notifications" data-testid="tab-notifications">
        <header class="module-panel__head">
          <h1>{t('Benachrichtigungen', 'Notifications')}</h1>
        </header>
        <p class="module-panel__hint">{t('Lade Konfiguration…', 'Loading configuration…')}</p>
      </section>
    );
  }

  const n = draftConfig.notifications;

  return (
    <section class="module-panel tab-notifications" data-testid="tab-notifications">
      <header class="module-panel__head">
        <h1>{t('Benachrichtigungen', 'Notifications')}</h1>
        <span class="module-panel__badge" data-testid="notifications-autosave">
          {cfg.loading.value ? t('Speichert…', 'Saving…') : t('Automatisch gespeichert', 'Auto-saved')}
        </span>
      </header>
      <p class="module-panel__intro">
        {t(
          'Push-Hinweise und der interaktive Bot laufen über Telegram. Richte den Bot einmal ein, wähle aus, worüber du informiert werden möchtest, und teste die Verbindung.',
          'Push notifications and the interactive bot run via Telegram. Set up the bot once, choose what you want to be informed about, and test the connection.',
        )}
      </p>

      <article class="module-panel__card" data-testid="notif-telegram-card">
        <h2>{t('Telegram-Bot', 'Telegram bot')}</h2>
        <p class="tab-rules__hint">
          {t('Einrichten:', 'Setup:')} 1) {t('In Telegram', 'In Telegram, open')}{' '}
          <strong>@BotFather</strong> {t('öffnen,', '')}{' '}
          <code>/newbot</code> {t('senden, Namen vergeben → du erhältst den', 'send, assign a name → you receive the')}{' '}
          <strong>{t('Bot-Token', 'bot token')}</strong> ({t('Form', 'form')} <code>123456:ABC-DEF…</code>). 2){' '}
          {t('Deinem neuen Bot eine beliebige Nachricht schreiben.', 'Send any message to your new bot.')} 3){' '}
          {t('Deine', 'Read your')}{' '}
          <strong>{t('Chat-ID', 'chat ID')}</strong> {t('über', 'via')} <strong>@userinfobot</strong> {t('auslesen.', '.')}{' '}
          {t(
            'Beides hier eintragen, „Telegram aktiv" anhaken und unten testen. Für den interaktiven Bot „Chat-Befehle aktiv" einschalten und im Chat',
            'Enter both here, tick "Telegram active" and test below. For the interactive bot, enable "Chat commands active" and, in the chat, send',
          )}{' '}
          <code>/hilfe</code> {t('senden.', '.')}
        </p>
        <label class="tab-rules__check">
          <input
            type="checkbox"
            data-testid="notif-telegram-enabled"
            checked={n?.telegram.enabled ?? false}
            onChange={(e): void => {
              const on = (e.currentTarget as HTMLInputElement).checked;
              patchNotifications((c) => ({
                ...c,
                telegram: { ...c.telegram, enabled: on },
              }));
            }}
          />
          <span>{t('Telegram aktiv', 'Telegram active')}</span>
        </label>
        <label class="tab-rules__field">
          <span>{t('Bot-Token', 'Bot token')}</span>
          <input
            type="text"
            data-testid="notif-telegram-token"
            value={n?.telegram.botToken ?? ''}
            placeholder={t('123456:ABC… (maskiert angezeigt)', '123456:ABC… (shown masked)')}
            onInput={(e): void => {
              const v = (e.currentTarget as HTMLInputElement).value;
              patchNotifications((c) => ({
                ...c,
                telegram: { ...c.telegram, botToken: v },
              }));
            }}
          />
        </label>
        <label class="tab-rules__field">
          <span>{t('Chat-ID', 'Chat ID')}</span>
          <input
            type="text"
            data-testid="notif-telegram-chat"
            value={n?.telegram.chatId ?? ''}
            onInput={(e): void => {
              const v = (e.currentTarget as HTMLInputElement).value;
              patchNotifications((c) => ({
                ...c,
                telegram: { ...c.telegram, chatId: v },
              }));
            }}
          />
        </label>
        <label class="tab-rules__check">
          <input
            type="checkbox"
            data-testid="notif-telegram-commands"
            checked={n?.telegram.commandsEnabled ?? false}
            onChange={(e): void => {
              const on = (e.currentTarget as HTMLInputElement).checked;
              patchNotifications((c) => ({
                ...c,
                telegram: { ...c.telegram, commandsEnabled: on },
              }));
            }}
          />
          <span>{t('Chat-Befehle aktiv (Bot reagiert auf /status, /wetter …)', 'Chat commands active (bot responds to /status, /wetter …)')}</span>
        </label>
        <label class="tab-rules__check">
          <input
            type="checkbox"
            data-testid="notif-telegram-control"
            checked={n?.telegram.allowControl ?? true}
            onChange={(e): void => {
              const on = (e.currentTarget as HTMLInputElement).checked;
              patchNotifications((c) => ({
                ...c,
                telegram: { ...c.telegram, allowControl: on },
              }));
            }}
          />
          <span>{t('Steuerbefehle erlauben (/pause, /urlaub, /set …)', 'Allow control commands (/pause, /urlaub, /set …)')}</span>
        </label>
        <label class="tab-rules__field">
          <span>{t('Weitere erlaubte Chat-IDs (kommagetrennt)', 'Additional allowed chat IDs (comma-separated)')}</span>
          <input
            type="text"
            data-testid="notif-telegram-allowed"
            value={(n?.telegram.allowedChatIds ?? []).join(', ')}
            placeholder={t('z. B. 111111, 222222', 'e.g. 111111, 222222')}
            onInput={(e): void => {
              const raw = (e.currentTarget as HTMLInputElement).value;
              const ids = raw
                .split(',')
                .map((s) => s.trim())
                .filter((s) => s.length > 0);
              patchNotifications((c) => ({
                ...c,
                telegram: { ...c.telegram, allowedChatIds: ids },
              }));
            }}
          />
        </label>
        <div class="tab-rules__telegram-test">
          <button
            type="button"
            data-testid="notif-telegram-test"
            onClick={(): void => {
              void handleTelegramTest();
            }}
          >
            {t('Telegram-Test senden', 'Send Telegram test')}
          </button>
          {telegramTest !== null && (
            <span
              class="tab-rules__telegram-test-status"
              data-testid="notif-telegram-test-status"
            >
              {telegramTest}
            </span>
          )}
        </div>
      </article>

      <article class="module-panel__card" data-testid="notif-events-card">
        <h2>{t('Ereignisse & Zeitpläne', 'Events & schedules')}</h2>
        <label class="tab-rules__field">
          <span>{t('Morgen-Briefing Uhrzeit', 'Morning briefing time')}</span>
          <input
            type="time"
            data-testid="notif-morning-time"
            value={n?.morningBriefLocalTime ?? '07:30'}
            onInput={(e): void => {
              const v = (e.currentTarget as HTMLInputElement).value;
              patchNotifications((c) => ({ ...c, morningBriefLocalTime: v }));
            }}
          />
        </label>
        <div class="tab-rules__event-toggles">
          {(['ventilate', 'open', 'close', 'weather'] as const).map((key) => {
            const labels: Record<typeof key, string> = {
              ventilate: t('Lüften', 'Ventilate'),
              open: t('Öffnen', 'Open'),
              close: t('Schließen', 'Close'),
              weather: t('Wetter', 'Weather'),
            };
            return (
              <label key={key} class="tab-rules__check">
                <input
                  type="checkbox"
                  data-testid={`notif-event-${key}`}
                  checked={n?.events[key] ?? true}
                  onChange={(e): void => {
                    const on = (e.currentTarget as HTMLInputElement).checked;
                    patchNotifications((c) => ({
                      ...c,
                      events: { ...c.events, [key]: on },
                    }));
                  }}
                />
                <span>{labels[key]}</span>
              </label>
            );
          })}
        </div>
        <label class="tab-rules__check">
          <input
            type="checkbox"
            data-testid="notif-daily-summary-enabled"
            checked={n?.dailySummaryEnabled ?? false}
            onChange={(e): void => {
              const on = (e.currentTarget as HTMLInputElement).checked;
              patchNotifications((c) => ({ ...c, dailySummaryEnabled: on }));
            }}
          />
          <span>{t('Täglicher Abend-Rückblick', 'Daily evening summary')}</span>
        </label>
        <label class="tab-rules__field">
          <span>{t('Rückblick Uhrzeit', 'Summary time')}</span>
          <input
            type="time"
            data-testid="notif-daily-summary-time"
            value={n?.dailySummaryLocalTime ?? '21:00'}
            onInput={(e): void => {
              const v = (e.currentTarget as HTMLInputElement).value;
              patchNotifications((c) => ({ ...c, dailySummaryLocalTime: v }));
            }}
          />
        </label>
      </article>

      <article class="module-panel__card" data-testid="notif-forecast-card">
        <h2>{t('Regelmäßige Wetter-Updates', 'Regular weather updates')}</h2>
        <label class="tab-rules__check">
          <input
            type="checkbox"
            data-testid="notif-forecast-enabled"
            checked={n?.forecastUpdates?.enabled ?? false}
            onChange={(e): void => {
              const on = (e.currentTarget as HTMLInputElement).checked;
              patchNotifications((c) => ({
                ...c,
                forecastUpdates: { ...c.forecastUpdates, enabled: on },
              }));
            }}
          />
          <span>{t('Wetter-Updates senden', 'Send weather updates')}</span>
        </label>
        <label class="tab-rules__field">
          <span>{t('Alle … Stunden', 'Every … hours')}</span>
          <input
            type="number"
            min={1}
            max={24}
            step={1}
            data-testid="notif-forecast-hours"
            value={n?.forecastUpdates?.everyHours ?? 3}
            onInput={(e): void => {
              const v = Number.parseInt(
                (e.currentTarget as HTMLInputElement).value,
                10,
              );
              if (Number.isFinite(v)) {
                patchNotifications((c) => ({
                  ...c,
                  forecastUpdates: {
                    ...c.forecastUpdates,
                    everyHours: Math.min(24, Math.max(1, v)),
                  },
                }));
              }
            }}
          />
        </label>
      </article>

      {cfg.saveError.value !== null && (
        <div class="tab-rules__error" data-testid="notifications-save-error">
          <strong>{cfg.saveError.value.error.message}</strong>
        </div>
      )}
    </section>
  );
}
