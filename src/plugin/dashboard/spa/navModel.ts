/**
 * Heat Shield — shared navigation model (ui-v2-release, Task 3).
 *
 * Single source of truth for the top-level product modules, the conditional
 * Warnungen destination and the route→module "active" mapping. Both chromes use
 * it: the v1 top header nav (`app.tsx`) and the v2 sidebar (`shell/lg2Shell`),
 * so a route highlights the same module regardless of the active design.
 */

import type { IconName } from './components/icons.js';

/** Top-level product module (predictive-control-dashboard Requirement 7). */
export interface ModuleDef {
  href: string;
  label: string;
  labelEn: string;
  testId: string;
  /** Inline icon name (see components/icons.tsx). */
  icon: IconName;
}

export const MODULES: ModuleDef[] = [
  { href: '/uebersicht', label: 'Übersicht', labelEn: 'Overview', testId: 'nav-module-uebersicht', icon: 'haus' },
  { href: '/raeume', label: 'Räume', labelEn: 'Rooms', testId: 'nav-module-raeume', icon: 'thermometer' },
  { href: '/vorhersage', label: 'Vorhersage', labelEn: 'Forecast', testId: 'nav-module-vorhersage', icon: 'forecast' },
  { href: '/garten', label: 'Garten', labelEn: 'Garden', testId: 'nav-module-garten', icon: 'tropfen' },
  { href: '/automatik', label: 'Automatik', labelEn: 'Automation', testId: 'nav-module-automatik', icon: 'automation' },
  { href: '/einstellungen', label: 'Einstellungen', labelEn: 'Settings', testId: 'nav-module-einstellungen', icon: 'einstellungen' },
];

/**
 * Warnungen is a CONDITIONAL primary destination (blueprint §9): only shown in
 * the nav while a severe-weather alert is active; otherwise reachable via the
 * global badge / `/warnungen`.
 */
export const WARNINGS_MODULE: ModuleDef = {
  href: '/warnungen',
  label: 'Warnungen',
  labelEn: 'Warnings',
  testId: 'nav-module-warnungen',
  icon: 'warnung',
};

/**
 * Maps each top-level module to the set of routes that should paint it as
 * active. The legacy config tabs (`/rooms`, `/sources`, …) live under the
 * Einstellungen module; `/history` is reachable both as the Verlauf tab and the
 * Forecast module; `/rules` powers the Automation module.
 */
export const MODULE_ROUTE_MAP: Record<string, string[]> = {
  '/uebersicht': ['/', '', '/uebersicht', '/beschattung', '/live'],
  '/raeume': ['/raeume', '/lueftung', '/klima'],
  '/vorhersage': ['/vorhersage', '/forecast', '/history'],
  '/garten': ['/garten', '/bewaesserung'],
  '/automatik': ['/automatik', '/automation', '/rules'],
  '/warnungen': ['/warnungen'],
  '/einstellungen': [
    '/einstellungen',
    '/rooms',
    '/sources',
    '/wizard',
    '/diagnostics',
    '/system',
    '/building',
    '/logs-debug',
    '/darstellung',
    '/benachrichtigungen',
    '/bewaesserung-einstellungen',
    '/messages',
    '/updates',
    '/hilfe',
  ],
};

export function isModuleActive(currentUrl: string, href: string): boolean {
  const routes = MODULE_ROUTE_MAP[href] ?? [href];
  return routes.includes(currentUrl);
}

/** Sub-navigation entry shown inside the Einstellungen hub (v1 + v2). */
export interface SettingsLink {
  href: string;
  label: string;
  labelEn: string;
  description: string;
  descriptionEn: string;
  testId: string;
}

export const SETTINGS_LINKS: SettingsLink[] = [
  {
    href: '/rooms',
    label: 'Räume & Fenster',
    labelEn: 'Rooms & Windows',
    description: 'Räume, Stockwerke, Rollläden und Sensoren zuordnen.',
    descriptionEn: 'Assign rooms, floors, shutters and sensors.',
    testId: 'settings-link-rooms',
  },
  {
    href: '/sources',
    label: 'Quellen',
    labelEn: 'Sources',
    description: 'Signalquellen (HMIP, FusionSolar, Wetter) binden und testen.',
    descriptionEn: 'Bind and test signal sources (HMIP, FusionSolar, weather).',
    testId: 'settings-link-sources',
  },
  {
    href: '/wizard',
    label: 'Einrichtungs-Assistent',
    labelEn: 'Setup wizard',
    description: 'Standort, Quellen und Räume Schritt für Schritt einrichten.',
    descriptionEn: 'Set up location, sources and rooms step by step.',
    testId: 'settings-link-wizard',
  },
  {
    href: '/darstellung',
    label: 'Darstellung & Sprache',
    labelEn: 'Appearance & Language',
    description: 'Sprache (AUTO/DE/EN), Ambient-Hintergrund und Benachrichtigungssprache.',
    descriptionEn: 'Language (AUTO/DE/EN), ambient background and notification language.',
    testId: 'settings-link-appearance',
  },
  {
    href: '/diagnostics',
    label: 'Diagnose',
    labelEn: 'Diagnostics',
    description: 'Verbindungsstatus, Logs und Selbsttests einsehen.',
    descriptionEn: 'Connection status, logs and self-tests.',
    testId: 'settings-link-diagnostics',
  },
  {
    href: '/system',
    label: 'Systemzustand',
    labelEn: 'System health',
    description: 'Verbindung, Datenquellen und Aktualität auf einen Blick.',
    descriptionEn: 'Connection, data sources and freshness at a glance.',
    testId: 'settings-link-system',
  },
  {
    href: '/logs-debug',
    label: 'Logs & Debug',
    labelEn: 'Logs & Debug',
    description: 'Alle Logs (Connect, Entscheidungen), Roh-Daten und umfangreiche Debug-Werkzeuge.',
    descriptionEn: 'All logs (Connect, decisions), raw data and extensive debug tools.',
    testId: 'settings-link-logs-debug',
  },
  {
    href: '/benachrichtigungen',
    label: 'Benachrichtigungen',
    labelEn: 'Notifications',
    description: 'Telegram-Bot, Morgen-Briefing, Abend-Rückblick und Wetter-Updates.',
    descriptionEn: 'Telegram bot, morning brief, evening summary and weather updates.',
    testId: 'settings-link-notifications',
  },
  {
    href: '/bewaesserung-einstellungen',
    label: 'Bewässerung',
    labelEn: 'Irrigation',
    description: 'Zonen, Pflanzen-/Boden-Profile, Gardena-Ventile, ET-Modell und Budgets.',
    descriptionEn: 'Zones, plant/soil profiles, Gardena valves, ET model and budgets.',
    testId: 'settings-link-irrigation',
  },
  {
    href: '/messages',
    label: 'Nachrichten',
    labelEn: 'Messages',
    description: 'Hinweise und Empfehlungen des Plugins durchsehen.',
    descriptionEn: 'Review the plugin\u2019s hints and recommendations.',
    testId: 'settings-link-messages',
  },
  {
    href: '/updates',
    label: 'Updates',
    labelEn: 'Updates',
    description: 'Version, Build und Changelog dieser Installation.',
    descriptionEn: 'Version, build and changelog of this installation.',
    testId: 'settings-link-updates',
  },
  {
    href: '/hilfe',
    label: 'Hilfe',
    labelEn: 'Help',
    description: 'Alle Funktionen im Überblick mit einer kurzen Erklärung.',
    descriptionEn: 'All functions at a glance with a short explanation.',
    testId: 'settings-link-help',
  },
];
