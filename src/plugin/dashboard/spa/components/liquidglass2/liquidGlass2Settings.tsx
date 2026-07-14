/**
 * Heat Shield — "Liquid Glass V2" native settings pages (ui-v2-release, Task 5).
 *
 * Content-only pages rendered into the shared shell:
 *   - LiquidGlass2Darstellung  (/darstellung) — UI version + appearance
 *     configurator + language + ambient + notification language + alert mode +
 *     preview flags (full parity with the v1 AppearanceTab).
 *   - LiquidGlass2Einstellungen (/einstellungen) — the settings hub as lg2 cards.
 *   - LiquidGlass2Warnungen     (/warnungen) — the severe-weather alert center.
 *
 * All controls reuse the shipped signals/hooks; no new data sources. Text is
 * bilingual and values degrade honestly.
 */

import { h, Fragment, type JSX } from 'preact';
import { useState } from 'preact/hooks';
import { route } from 'preact-router';

import { t, langPref, setLangPref, fmtTime, locale, type LangPref } from '../../i18n.js';
import { ambientEnabled, setAmbientEnabled } from '../../ambient.js';
import { getFlag, setFlag, type FeatureFlag } from '../../featureFlags.js';
import { useConfig } from '../../hooks/useConfig.js';
import { snapshot } from '../../store.js';
import { SETTINGS_LINKS } from '../../navModel.js';
import type { Config } from '../../../../../shared/types.js';
import type { WeatherWarning } from '../../types.js';
import { Seg } from './shell/lg2Primitives.js';
import { ConfigPanel } from './shell/lg2ConfigPanel.js';

interface RoutableProps {
  path?: string;
}

/** Small labelled switch using the existing lg2 toggle styling. */
function Toggle(props: { on: boolean; onToggle: () => void; testId?: string; disabled?: boolean }): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.on}
      class={`lg2-toggle${props.on ? ' lg2-toggle--on' : ''}`}
      data-testid={props.testId}
      disabled={props.disabled === true}
      onClick={props.onToggle}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* Darstellung & Sprache                                                      */
/* -------------------------------------------------------------------------- */

const PREVIEW_FLAGS: Array<{ flag: FeatureFlag; de: string; en: string; hintDe: string; hintEn: string }> = [
  { flag: 'buildingStudioV2', de: 'Gebäude-Studio (Grundriss-Editor)', en: 'Building Studio (floor-plan editor)', hintDe: 'Zeichne Wände, Räume und Stockwerke. Erscheint unter Einstellungen.', hintEn: 'Draw walls, rooms and storeys. Appears under Settings.' },
  { flag: 'premiumUiV2', de: 'Premium-Desktop-Shell', en: 'Premium desktop shell', hintDe: 'Seitenleisten-Layout ab Tablet-Breite.', hintEn: 'Sidebar layout at tablet width and up.' },
  { flag: 'mobileUiV2', de: 'Mobile Touch-Navigation', en: 'Mobile touch navigation', hintDe: '5-Punkt-Leiste unten auf Smartphone-Breite.', hintEn: '5-item bottom bar at phone width.' },
];

const LANG_OPTIONS: Array<[LangPref, string]> = [
  ['auto', 'AUTO'],
  ['de', 'Deutsch'],
  ['en', 'English'],
];

export function LiquidGlass2Darstellung(_props: RoutableProps): JSX.Element {
  const { config, scheduleSave } = useConfig();
  const [cfgOpen, setCfgOpen] = useState(false);
  const [, force] = useState(0);
  const c = config.value;
  const notifLang = c?.notifications?.language ?? 'de';
  const alertOnDashboard = c?.dwd?.alertOnDashboard ?? true;
  const alertOnWeather = c?.dwd?.alertOnWeather ?? true;

  const setNotifLang = (value: 'de' | 'en'): void => {
    if (c === null) return;
    scheduleSave({ ...c, notifications: { ...c.notifications, language: value } });
  };
  const setAlert = (patch: Partial<Config['dwd']>): void => {
    if (c === null) return;
    scheduleSave({ ...c, dwd: { ...c.dwd, ...patch } });
  };

  return (
    <main class="lg2-main lg2-settings" data-testid="liquid-glass2-darstellung">
      <header class="lg2-header">
        <div>
          <h1 class="lg2-header__title">{t('Darstellung & Sprache', 'Appearance & Language')}</h1>
          <p class="lg2-header__sub">{t('Design, Sprache und Hintergrund', 'Design, language and background')}</p>
        </div>
      </header>

      <section class="lg2-card">
        <h3 class="lg2-card__title">{t('Design anpassen', 'Customise design')}</h3>
        <p class="lg2-settings__hint">
          {t('Hintergrund, Glas, Farben, Presets — global für alle v2-Seiten.',
            'Background, glass, colours, presets — global across all v2 pages.')}
        </p>
        <button type="button" class="lg2-settings__btn" data-testid="lg2-open-appearance"
          onClick={(): void => setCfgOpen(true)}>
          {t('Darstellung öffnen', 'Open appearance')}
        </button>
      </section>

      <section class="lg2-card" data-testid="lg2-language">
        <h3 class="lg2-card__title">{t('Sprache', 'Language')}</h3>
        <p class="lg2-settings__hint">
          {t('AUTO folgt der Browsersprache (Deutsch als Fallback). Gilt für dieses Gerät.',
            'AUTO follows the browser language (German fallback). Applies to this device.')}
        </p>
        <Seg<LangPref> value={langPref.value} options={LANG_OPTIONS} onChange={(v): void => setLangPref(v)} />
      </section>

      <section class="lg2-card">
        <h3 class="lg2-card__title">{t('Hintergrund (Ambient)', 'Background (ambient)')}</h3>
        <div class="lg2-settings__row">
          <span>{t('Dynamischer Tag/Nacht-Hintergrund je nach Sonnenstand und Wetter', 'Dynamic day/night background based on sun position and weather')}</span>
          <Toggle on={ambientEnabled.value} testId="lg2-ambient-toggle"
            onToggle={(): void => setAmbientEnabled(!ambientEnabled.value)} />
        </div>
      </section>

      <section class="lg2-card">
        <h3 class="lg2-card__title">{t('Sprache der Benachrichtigungen', 'Notification language')}</h3>
        <p class="lg2-settings__hint">
          {t('Sprache der Telegram-Nachrichten (installationsweit).', 'Language of Telegram messages (installation-wide).')}
        </p>
        <Seg<'de' | 'en'> value={notifLang}
          options={[['de', 'Deutsch'], ['en', 'English']]}
          onChange={(v): void => setNotifLang(v)} />
      </section>

      <section class="lg2-card" data-testid="lg2-alert-mode">
        <h3 class="lg2-card__title">{t('Alert-Modus (Unwetter)', 'Alert mode (severe weather)')}</h3>
        <label class="lg2-field">
          <span class="lg2-field__label">{t('Ort für Unwetterwarnungen (DWD)', 'Location for severe-weather warnings (DWD)')}</span>
          <input type="text" class="lg2-field__input" data-testid="lg2-dwd-region"
            value={c?.dwd?.regionName ?? ''} placeholder="Berlin" disabled={c === null}
            onChange={(e): void => setAlert({ regionName: (e.currentTarget as HTMLInputElement).value.trim() })} />
        </label>
        <div class="lg2-settings__row">
          <span>{t('Auf der Startseite anzeigen', 'Show on the start page')}</span>
          <Toggle on={alertOnDashboard} disabled={c === null}
            onToggle={(): void => setAlert({ alertOnDashboard: !alertOnDashboard })} />
        </div>
        <div class="lg2-settings__row">
          <span>{t('Im Wetter-/Vorhersage-Bereich anzeigen', 'Show in the weather/forecast area')}</span>
          <Toggle on={alertOnWeather} disabled={c === null}
            onToggle={(): void => setAlert({ alertOnWeather: !alertOnWeather })} />
        </div>
        <label class="lg2-field">
          <span class="lg2-field__label">{t('Unwetterwarnung per Telegram', 'Severe-weather warning via Telegram')}</span>
          <select class="lg2-field__input" data-testid="lg2-dwd-telegram"
            value={c?.dwd?.telegramMode ?? '30'} disabled={c === null}
            onChange={(e): void => setAlert({ telegramMode: (e.currentTarget as HTMLSelectElement).value as Config['dwd']['telegramMode'] })}>
            <option value="off">{t('Aus', 'Off')}</option>
            <option value="changes">{t('Nur Änderungen', 'Changes only')}</option>
            <option value="30">{t('Alle 30 Minuten', 'Every 30 minutes')}</option>
            <option value="60">{t('Alle 60 Minuten', 'Every 60 minutes')}</option>
            <option value="90">{t('Alle 90 Minuten', 'Every 90 minutes')}</option>
          </select>
        </label>
      </section>

      <section class="lg2-card" data-testid="lg2-preview-flags">
        <h3 class="lg2-card__title">{t('Vorschau-Funktionen', 'Preview features')}</h3>
        <p class="lg2-settings__hint">
          {t('Experimentelle Funktionen pro Gerät. Die Seite lädt danach neu.', 'Experimental features per device. The page reloads afterwards.')}
        </p>
        {PREVIEW_FLAGS.map((f) => (
          <div class="lg2-settings__row" key={f.flag}>
            <span>{t(f.de, f.en)}<br /><small class="lg2-settings__hint">{t(f.hintDe, f.hintEn)}</small></span>
            <Toggle on={getFlag(f.flag)} testId={`lg2-flag-${f.flag}`}
              onToggle={(): void => { setFlag(f.flag, !getFlag(f.flag)); force((n) => n + 1); setTimeout(() => window.location.reload(), 150); }} />
          </div>
        ))}
      </section>

      {cfgOpen && <ConfigPanel onClose={(): void => setCfgOpen(false)} />}
    </main>
  );
}

/* -------------------------------------------------------------------------- */
/* Einstellungen hub                                                          */
/* -------------------------------------------------------------------------- */

export function LiquidGlass2Einstellungen(_props: RoutableProps): JSX.Element {
  const links = getFlag('buildingStudioV2')
    ? [
        ...SETTINGS_LINKS,
        { href: '/building', label: 'Gebäude-Studio', labelEn: 'Building Studio', description: 'Grundriss-Editor (Vorschau): Wände, Räume und Stockwerke zeichnen.', descriptionEn: 'Floor-plan editor (preview): draw walls, rooms and storeys.', testId: 'settings-link-building' },
      ]
    : SETTINGS_LINKS;
  return (
    <main class="lg2-main lg2-settings" data-testid="liquid-glass2-einstellungen">
      <header class="lg2-header">
        <div>
          <h1 class="lg2-header__title">{t('Einstellungen', 'Settings')}</h1>
          <p class="lg2-header__sub">{t('Konfiguration und Diagnose', 'Configuration and diagnostics')}</p>
        </div>
      </header>
      <div class="lg2-settings__grid" data-testid="lg2-settings-grid">
        {links.map((l) => (
          <button type="button" class="lg2-settings__card" key={l.href}
            data-testid={l.testId} onClick={(): void => { route(l.href); }}>
            <span class="lg2-settings__card-title">{t(l.label, l.labelEn)}</span>
            <span class="lg2-settings__card-desc">{t(l.description, l.descriptionEn)}</span>
          </button>
        ))}
      </div>
    </main>
  );
}

/* -------------------------------------------------------------------------- */
/* Warnungen                                                                  */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* DWD level styling + warning-kind mapping                                    */
/* -------------------------------------------------------------------------- */

interface LevelStyle { color: string; badge: [string, string]; eyebrow: [string, string]; }
/** Official DWD warning tiers: 1 gelb · 2 orange · 3 rot · 4 violett; heat = rosa/lila. */
function levelStyle(level: number, heat: boolean): LevelStyle {
  if (heat) return { color: '#e05fae', badge: ['Hitze', 'Heat'], eyebrow: ['Amtliche Hitzewarnung', 'Official heat warning'] };
  if (level >= 4) return { color: '#a855f7', badge: ['Extrem', 'Extreme'], eyebrow: ['Warnung vor extremem Unwetter', 'Extreme severe-weather warning'] };
  if (level >= 3) return { color: '#ef4444', badge: ['Hoch', 'High'], eyebrow: ['Amtliche Unwetterwarnung', 'Official severe-weather warning'] };
  if (level >= 2) return { color: '#ff8c1a', badge: ['Markant', 'Significant'], eyebrow: ['Warnung vor markantem Wetter', 'Significant-weather warning'] };
  return { color: '#f5c518', badge: ['Warnung', 'Advisory'], eyebrow: ['Amtliche Warnung', 'Official warning'] };
}

type WarnKind = 'storm' | 'rain' | 'wind' | 'heat' | 'snow' | 'ice' | 'fog' | 'sun';
/** Classify a warning by its event/headline text → hero image + glyph + heat flag. */
function warnKind(text: string): { kind: WarnKind; hero: string; heat: boolean } {
  const s = (text || '').toLowerCase();
  if (/gewitter|thunder|blitz/.test(s)) return { kind: 'storm', hero: 'severe-thunderstorm-city', heat: false };
  if (/regen|niederschlag|rain|dauerregen/.test(s)) return { kind: 'rain', hero: 'warn-rain', heat: false };
  if (/wind|böe|boe|sturm|orkan|gust/.test(s)) return { kind: 'wind', hero: 'warn-wind', heat: false };
  if (/hitze|heat|heiß|heiss/.test(s)) return { kind: 'heat', hero: 'warn-heat', heat: true };
  if (/uv/.test(s)) return { kind: 'heat', hero: 'warn-heat', heat: true };
  if (/schnee|snow|schneefall/.test(s)) return { kind: 'snow', hero: 'warn-snow', heat: false };
  if (/glätte|glatt|glatteis|eis|frost|ice/.test(s)) return { kind: 'ice', hero: 'warn-ice', heat: false };
  if (/nebel|fog|sicht/.test(s)) return { kind: 'fog', hero: 'warn-fog', heat: false };
  return { kind: 'sun', hero: 'warn-clear', heat: false };
}

/** Compact weather glyph for the warning badges (line style, matches icon set). */
function WarnGlyph(props: { kind: WarnKind; size?: number }): JSX.Element {
  const s = props.size ?? 22;
  const cloud = <path d="M7 17.5h9a3.4 3.4 0 0 0 .2-6.8A4.9 4.9 0 0 0 7 10a3.9 3.9 0 0 0 0 7.5z" />;
  const g: Record<WarnKind, JSX.Element> = {
    storm: <Fragment>{cloud}<path d="M12 15l-2 3.2h3L11 22" /></Fragment>,
    rain: <Fragment>{cloud}<path d="M9 20l-1 2M13 20l-1 2M17 20l-1 2" /></Fragment>,
    wind: <path d="M3 9h11a2.5 2.5 0 1 0-2.5-2.5M3 13h15a2.7 2.7 0 1 1-2.7 2.7M3 17h9a2.2 2.2 0 1 1-2.2 2.2" />,
    heat: <Fragment><circle cx="12" cy="12" r="4.2" /><path d="M12 3v2.4M12 18.6V21M3 12h2.4M18.6 12H21M5.6 5.6l1.7 1.7M17.7 17.7l-1.7-1.7M18.4 5.6L16.7 7.3M6.3 16.7l-1.7 1.7" /></Fragment>,
    snow: <Fragment>{cloud}<path d="M9 21v.01M13 21v.01M11 20v.01M15 20v.01" /></Fragment>,
    ice: <path d="M12 3v18M4.5 7.5l15 9M19.5 7.5l-15 9M12 6l-2.4 2.4M12 6l2.4 2.4M12 18l-2.4-2.4M12 18l2.4-2.4" />,
    fog: <Fragment>{cloud}<path d="M6 20h12M8 22h9" /></Fragment>,
    sun: <Fragment><circle cx="12" cy="12" r="4.2" /><path d="M12 3v2.4M12 18.6V21M3 12h2.4M18.6 12H21M5.6 5.6l1.7 1.7M17.7 17.7l-1.7-1.7M18.4 5.6L16.7 7.3M6.3 16.7l-1.7 1.7" /></Fragment>,
  };
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      {g[props.kind]}
    </svg>
  );
}

/** Small calendar glyph for the validity timestamps. */
function CalGlyph(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="3.5" y="5" width="17" height="16" rx="2.5" /><path d="M3.5 9.5h17M8 3v4M16 3v4" />
    </svg>
  );
}

function fmtStamp(s: string | null | undefined): string {
  if (s === null || s === undefined) return '–';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '–';
  return `${d.toLocaleDateString(locale(), { day: '2-digit', month: '2-digit', year: 'numeric' })} ${fmtTime(d)}`;
}

/* -------------------------------------------------------------------------- */
/* Hero (top, most severe) + list rows                                         */
/* -------------------------------------------------------------------------- */

function WarnHero(props: { w: WeatherWarning }): JSX.Element {
  const w = props.w;
  const k = warnKind(w.event !== '' ? w.event : w.headline);
  const st = levelStyle(w.level, k.heat);
  return (
    <section class="lg2-warnhero" data-testid="lg2-warnhero"
      style={{ '--warn': st.color, '--warn-img': `url("/assets/hero/${k.hero}.png")` } as JSX.CSSProperties}>
      <div class="lg2-warnhero__photo" aria-hidden="true" />
      <div class="lg2-warnhero__scrim" aria-hidden="true" />
      <div class="lg2-warnhero__inner">
        <span class="lg2-warnhero__icon"><WarnGlyph kind={k.kind} size={26} /></span>
        <div class="lg2-warnhero__text">
          <span class="lg2-warnhero__eyebrow">{t(...st.eyebrow)}</span>
          <h2 class="lg2-warnhero__title">{w.headline || w.event}</h2>
          {w.description !== '' && <p class="lg2-warnhero__desc">{w.description}</p>}
          <div class="lg2-warnhero__times">
            <div><span>{t('Gültig von', 'Valid from')}</span><b><CalGlyph /> {fmtStamp(w.start)}</b></div>
            <div><span>{t('Gültig bis', 'Valid until')}</span><b><CalGlyph /> {fmtStamp(w.end)}</b></div>
          </div>
        </div>
        <div class="lg2-warnhero__stufe">
          <span>{t('Stufe', 'Level')}</span>
          <b>{w.level}</b>
          <em>{t(...st.badge)}</em>
        </div>
      </div>
    </section>
  );
}

function WarnRow(props: { w: WeatherWarning }): JSX.Element {
  const w = props.w;
  const k = warnKind(w.event !== '' ? w.event : w.headline);
  const st = levelStyle(w.level, k.heat);
  return (
    <div class="lg2-warnrow" data-testid="lg2-warnrow" style={{ '--warn': st.color } as JSX.CSSProperties}>
      <span class="lg2-warnrow__icon"><WarnGlyph kind={k.kind} size={24} /></span>
      <div class="lg2-warnrow__body">
        <b class="lg2-warnrow__name">{w.event !== '' ? w.event : w.headline}</b>
        {w.description !== '' && <span class="lg2-warnrow__desc">{w.description}</span>}
      </div>
      <span class="lg2-warnrow__until">{w.end !== null ? t(`Gültig bis ${fmtTime(new Date(w.end))}`, `Until ${fmtTime(new Date(w.end))}`) : '\u00a0'}</span>
      <span class="lg2-warnrow__pill">{t(`Stufe ${w.level}`, `Level ${w.level}`)}</span>
    </div>
  );
}

/** Green all-clear hero when no warning is active. */
function AllClearHero(): JSX.Element {
  return (
    <section class="lg2-warnhero lg2-warnhero--clear" data-testid="lg2-warnungen-empty"
      style={{ '--warn': '#34c759', '--warn-img': 'url("/assets/hero/warn-clear.png")' } as JSX.CSSProperties}>
      <div class="lg2-warnhero__photo" aria-hidden="true" />
      <div class="lg2-warnhero__scrim" aria-hidden="true" />
      <div class="lg2-warnhero__inner">
        <span class="lg2-warnhero__icon"><WarnGlyph kind="sun" size={26} /></span>
        <div class="lg2-warnhero__text">
          <span class="lg2-warnhero__eyebrow">{t('Keine amtliche Warnung', 'No official warning')}</span>
          <h2 class="lg2-warnhero__title">{t('Keine Wetterwarnung aktiv', 'No weather warning active')}</h2>
          <p class="lg2-warnhero__desc">{t('Es werden keine wetterbedingten Gefährdungen erwartet.', 'No weather-related hazards are expected.')}</p>
        </div>
      </div>
    </section>
  );
}

export function LiquidGlass2Warnungen(_props: RoutableProps): JSX.Element {
  const alert = snapshot.value?.weatherAlert;
  const active = alert?.active === true;
  const warnings = (active ? (alert.warnings ?? []) : []).slice().sort((a, b) => b.level - a.level);
  const top = warnings[0] ?? null;
  return (
    <main class="lg2-main lg2-warn" data-testid="liquid-glass2-warnungen">
      <header class="lg2-header">
        <div>
          <h1 class="lg2-header__title">{t('Warnungen', 'Warnings')}</h1>
          <p class="lg2-header__sub">{t('Aktuelle Wetterwarnungen und Sicherheitshinweise', 'Current weather warnings and safety notices')}</p>
        </div>
      </header>

      {top === null ? (
        <AllClearHero />
      ) : (
        <Fragment>
          <WarnHero w={top} />
          <h2 class="lg2-warn__section">{t('Aktive Warnungen', 'Active warnings')}</h2>
          <div class="lg2-warn__list">
            {warnings.map((w, i) => <WarnRow key={`${w.event}-${w.start}-${i}`} w={w} />)}
          </div>
        </Fragment>
      )}
    </main>
  );
}
