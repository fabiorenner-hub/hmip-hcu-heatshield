/**
 * Heat Shield — "Darstellung & Sprache" (Einstellungen).
 *
 * Per-device language (AUTO / Deutsch / English, AUTO follows the browser with
 * German as fallback), the ambient-background toggle (moved here from the
 * header), and the installation-wide notification (Telegram) language.
 */

import { h, type JSX } from 'preact';

import { t, langPref, setLangPref, type LangPref } from '../i18n.js';
import { ambientEnabled, setAmbientEnabled } from '../ambient.js';
import { useConfig } from '../hooks/useConfig.js';
import type { Config } from '../../../../shared/types.js';

interface RoutableProps {
  path?: string;
}

const LANG_OPTIONS: Array<{ value: LangPref; label: string }> = [
  { value: 'auto', label: 'AUTO' },
  { value: 'de', label: 'Deutsch' },
  { value: 'en', label: 'English' },
];

export function AppearanceTab(_props: RoutableProps): JSX.Element {
  const { config, scheduleSave } = useConfig();
  const notifLang = config.value?.notifications?.language ?? 'de';

  const setNotifLang = (value: 'de' | 'en'): void => {
    const c = config.value;
    if (c === null) return;
    const next: Config = {
      ...c,
      notifications: { ...c.notifications, language: value },
    };
    scheduleSave(next);
  };

  return (
    <section class="module-panel tab-appearance" data-testid="tab-appearance">
      <header class="module-panel__head">
        <h1>{t('Darstellung & Sprache', 'Appearance & Language')}</h1>
        <span class="module-panel__badge">{t('Sprache · Hintergrund', 'Language · Background')}</span>
      </header>
      <p class="module-panel__intro">
        {t(
          'Sprache des Dashboards (pro Gerät), Hintergrund-Stimmung und die Sprache der Benachrichtigungen.',
          'Dashboard language (per device), background mood, and the language of notifications.',
        )}
      </p>

      <article class="module-panel__card" data-testid="appearance-language">
        <h3>{t('Sprache', 'Language')}</h3>
        <p class="module-panel__hint">
          {t(
            'AUTO folgt der Browsersprache; ist sie nicht Deutsch, wird Englisch genutzt. Deutsch ist der Fallback. Gilt für dieses Gerät.',
            'AUTO follows your browser language; if it is not German, English is used. German is the fallback. Applies to this device.',
          )}
        </p>
        <div class="seg" role="tablist" aria-label={t('Sprache wählen', 'Choose language')}>
          {LANG_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              role="tab"
              aria-selected={langPref.value === o.value}
              class={`seg__btn${langPref.value === o.value ? ' seg__btn--active' : ''}`}
              data-testid={`lang-${o.value}`}
              onClick={(): void => setLangPref(o.value)}
            >
              {o.label}
            </button>
          ))}
        </div>
      </article>

      <article class="module-panel__card" data-testid="appearance-ambient">
        <h3>{t('Hintergrund (Ambient)', 'Background (ambient)')}</h3>
        <label class="tab-rules__check">
          <input
            type="checkbox"
            data-testid="ambient-toggle"
            checked={ambientEnabled.value}
            onChange={(e): void => setAmbientEnabled((e.currentTarget as HTMLInputElement).checked)}
          />
          <span>
            {t(
              'Dynamischer Tag/Nacht-Hintergrund je nach Sonnenstand und Wetter',
              'Dynamic day/night background based on sun position and weather',
            )}
          </span>
        </label>
      </article>

      <article class="module-panel__card" data-testid="appearance-notif-language">
        <h3>{t('Sprache der Benachrichtigungen', 'Notification language')}</h3>
        <p class="module-panel__hint">
          {t(
            'Sprache der Telegram-Nachrichten (gilt für die ganze Installation, unabhängig vom Gerät).',
            'Language of Telegram messages (installation-wide, independent of the device).',
          )}
        </p>
        <div class="seg">
          {(['de', 'en'] as const).map((v) => (
            <button
              key={v}
              type="button"
              class={`seg__btn${notifLang === v ? ' seg__btn--active' : ''}`}
              data-testid={`notif-lang-${v}`}
              disabled={config.value === null}
              onClick={(): void => setNotifLang(v)}
            >
              {v === 'de' ? 'Deutsch' : 'English'}
            </button>
          ))}
        </div>
      </article>
    </section>
  );
}
