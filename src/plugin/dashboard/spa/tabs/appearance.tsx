/**
 * Heat Shield — "Darstellung & Sprache" (Einstellungen).
 *
 * Per-device language (AUTO / Deutsch / English, AUTO follows the browser with
 * German as fallback), the ambient-background toggle (moved here from the
 * header), and the installation-wide notification (Telegram) language.
 */

import { h, type JSX } from 'preact';
import { useState } from 'preact/hooks';

import { t, langPref, setLangPref, type LangPref } from '../i18n.js';
import { ambientEnabled, setAmbientEnabled } from '../ambient.js';
import { useConfig } from '../hooks/useConfig.js';
import { getFlag, setFlag, type FeatureFlag } from '../featureFlags.js';
import type { Config } from '../../../../shared/types.js';

interface RoutableProps {
  path?: string;
}

const PREVIEW_FLAGS: Array<{ flag: FeatureFlag; de: string; en: string; hintDe: string; hintEn: string }> = [
  {
    flag: 'buildingStudioV2',
    de: 'Gebäude-Studio (Grundriss-Editor)',
    en: 'Building Studio (floor-plan editor)',
    hintDe: 'Zeichne Wände, Räume und Stockwerke. Erscheint unter Einstellungen.',
    hintEn: 'Draw walls, rooms and storeys. Appears under Settings.',
  },
  {
    flag: 'premiumUiV2',
    de: 'Premium-Desktop-Shell',
    en: 'Premium desktop shell',
    hintDe: 'Seitenleisten-Layout ab Tablet-Breite.',
    hintEn: 'Sidebar layout at tablet width and up.',
  },
  {
    flag: 'mobileUiV2',
    de: 'Mobile Touch-Navigation',
    en: 'Mobile touch navigation',
    hintDe: '5-Punkt-Leiste unten auf Smartphone-Breite.',
    hintEn: '5-item bottom bar at phone width.',
  },
];

function PreviewFeaturesCard(): JSX.Element {
  // Local mirror so the checkboxes reflect immediately; a reload applies the
  // flag app-wide (routes/nav/shells read the flag at render).
  const [, force] = useState(0);
  return (
    <article class="module-panel__card" data-testid="appearance-preview-flags">
      <h3>{t('Vorschau-Funktionen', 'Preview features')}</h3>
      <p class="module-panel__hint">
        {t(
          'Experimentelle Funktionen pro Gerät ein-/ausschalten. Die Seite lädt danach neu.',
          'Enable/disable experimental features per device. The page reloads afterwards.',
        )}
      </p>
      {PREVIEW_FLAGS.map((f) => (
        <label key={f.flag} class="tab-rules__check">
          <input
            type="checkbox"
            data-testid={`flag-${f.flag}`}
            checked={getFlag(f.flag)}
            onChange={(e): void => {
              setFlag(f.flag, (e.currentTarget as HTMLInputElement).checked);
              force((n) => n + 1);
              setTimeout(() => window.location.reload(), 150);
            }}
          />
          <span>
            {t(f.de, f.en)}
            <br />
            <small class="module-panel__hint">{t(f.hintDe, f.hintEn)}</small>
          </span>
        </label>
      ))}
    </article>
  );
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

  const alertOnDashboard = config.value?.dwd?.alertOnDashboard ?? true;
  const alertOnWeather = config.value?.dwd?.alertOnWeather ?? true;
  const setAlert = (patch: Partial<Config['dwd']>): void => {
    const c = config.value;
    if (c === null) return;
    scheduleSave({ ...c, dwd: { ...c.dwd, ...patch } });
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

      <PreviewFeaturesCard />

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

      <article class="module-panel__card" data-testid="appearance-alert-mode">
        <h3>{t('Alert-Modus (Unwetter)', 'Alert mode (severe weather)')}</h3>
        <label class="appearance-field">
          <span class="appearance-field__label">
            {t('Ort für Unwetterwarnungen (DWD)', 'Location for severe-weather warnings (DWD)')}
          </span>
          <input
            type="text"
            class="appearance-field__input"
            data-testid="dwd-region-input"
            value={config.value?.dwd?.regionName ?? ''}
            placeholder="Berlin"
            disabled={config.value === null}
            onChange={(e): void =>
              setAlert({ regionName: (e.currentTarget as HTMLInputElement).value.trim() })
            }
          />
        </label>
        <p class="module-panel__hint">
          {t(
            'Gemeinde oder Landkreis für die DWD-Warnungen (Standard: Berlin). Der Einrichtungs-Assistent schlägt den Ort automatisch aus deinen Koordinaten vor. Warnungen werden auch auf Landkreis-Ebene erkannt.',
            'Municipality or district for the DWD warnings (default: Berlin). The setup wizard suggests it automatically from your coordinates. Warnings are also detected at district level.',
          )}
        </p>
        <label class="tab-rules__check">
          <input
            type="checkbox"
            data-testid="alert-dashboard-toggle"
            checked={alertOnDashboard}
            disabled={config.value === null}
            onChange={(e): void =>
              setAlert({ alertOnDashboard: (e.currentTarget as HTMLInputElement).checked })
            }
          />
          <span>{t('Auf der Startseite (Beschattung) anzeigen', 'Show on the start page (Shading)')}</span>
        </label>
        <label class="tab-rules__check">
          <input
            type="checkbox"
            data-testid="alert-weather-toggle"
            checked={alertOnWeather}
            disabled={config.value === null}
            onChange={(e): void =>
              setAlert({ alertOnWeather: (e.currentTarget as HTMLInputElement).checked })
            }
          />
          <span>{t('Im Wetter-Tab anzeigen', 'Show on the Weather tab')}</span>
        </label>
        <label class="appearance-field">
          <span class="appearance-field__label">
            {t('Unwetterwarnung per Telegram', 'Severe-weather warning via Telegram')}
          </span>
          <select
            class="appearance-field__input"
            data-testid="dwd-telegram-mode"
            value={config.value?.dwd?.telegramMode ?? '30'}
            disabled={config.value === null}
            onChange={(e): void =>
              setAlert({
                telegramMode: (e.currentTarget as HTMLSelectElement)
                  .value as Config['dwd']['telegramMode'],
              })
            }
          >
            <option value="off">{t('Aus', 'Off')}</option>
            <option value="changes">{t('Nur Änderungen', 'Changes only')}</option>
            <option value="30">{t('Alle 30 Minuten', 'Every 30 minutes')}</option>
            <option value="60">{t('Alle 60 Minuten', 'Every 60 minutes')}</option>
            <option value="90">{t('Alle 90 Minuten', 'Every 90 minutes')}</option>
          </select>
        </label>
        <p class="module-panel__hint">
          {t(
            'Bei einer aktiven Warnung (Stufe 3+) sendet das Plugin neue/verschärfte Warnungen sofort. „Nur Änderungen" verzichtet auf periodische Lage-Updates; 30/60/90 Minuten schicken zusätzlich einen Lage-Bericht in diesem Takt bis zur Entwarnung.',
            'During an active warning (level 3+) the plugin sends new/escalated warnings immediately. "Changes only" skips the periodic situation updates; 30/60/90 minutes additionally send a situation report at that cadence until the all-clear.',
          )}
        </p>
      </article>
    </section>
  );
}
