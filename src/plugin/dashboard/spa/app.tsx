/**
 * Top-level Preact component (Task 11.1).
 *
 * Wires up:
 *   - the tab navigation (six routes from `design.md`),
 *   - the `preact-router` Router that swaps the active tab,
 *   - the `useApiState` polling hook and the `useStream` SSE hook
 *     so every tab sees the same live data.
 *
 * The default route is `/live`. Routes that have not been
 * implemented yet (Tasks 12.* and 13) render a placeholder card so
 * the route table stays canonical.
 */

import { h, type JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { Router, Link, route, getCurrentUrl, type RouterOnChangeArgs } from 'preact-router';

import { ErrorBoundary } from './components/errorBoundary.js';
import { AutomationLever } from './components/automationLever.js';
import { MessageBell } from './components/messageBell.js';
import { DashboardGrid } from './components/dashboard/dashboardGrid.js';
import { Icon, type IconName } from './components/icons.js';
import { HouseImageUpload } from './components/houseImageUpload.js';
import { useApiState } from './hooks/useApiState.js';
import { useConfig } from './hooks/useConfig.js';
import { useMessages } from './hooks/useMessages.js';
import { useStream } from './hooks/useStream.js';
import { useUpdateCheck } from './hooks/useUpdateCheck.js';
import { snapshot, unreadMessages } from './store.js';
import { getSunPosition } from './components/sunPolarPlot.js';
import { TrendCard } from './components/dashboard/trendCard.js';
import { ambientBackground, loadAmbient, saveAmbient } from './ambient.js';
import { APP_VERSION } from './version.js';
import { DiagnosticsTab } from './tabs/diagnostics.js';
import { HelpTab } from './tabs/help.js';
import { HistoryTab } from './tabs/history.js';
import { IrrigationTab } from './tabs/irrigation.js';
import { LiveTab } from './tabs/live.js';
import { MessagesTab } from './tabs/messages.js';
import { NotificationsTab } from './tabs/notifications.js';
import { IrrigationSettingsTab } from './tabs/irrigationSettings.js';
import { LogsDebugTab } from './tabs/logsDebug.js';
import { RoomsTab } from './tabs/rooms.js';
import { RulesTab } from './tabs/rules.js';
import { SourcesTab } from './tabs/sources.js';
import { UpdatesTab } from './tabs/updates.js';
import { WizardTab } from './tabs/wizard.js';

/**
 * Session-storage key used to remember that we already auto-jumped
 * to the wizard once after seeing `pluginReadiness = CONFIG_REQUIRED`.
 * Without this guard the user would be teleported back to the
 * wizard every time they navigate away while CONFIG_REQUIRED is
 * still active.
 */
const WIZARD_AUTO_REDIRECT_KEY = 'heatshield.wizardAutoRedirected';

/** Top-level product modules (predictive-control-dashboard Requirement 7). */
interface ModuleDef {
  href: string;
  label: string;
  testId: string;
  /** Inline icon name (see components/icons.tsx). */
  icon: IconName;
}

const MODULES: ModuleDef[] = [
  { href: '/beschattung', label: 'Beschattung', testId: 'nav-module-beschattung', icon: 'beschattung' },
  { href: '/lueftung', label: 'Lüftung', testId: 'nav-module-lueftung', icon: 'lueftung' },
  { href: '/klima', label: 'Klima', testId: 'nav-module-klima', icon: 'klima' },
  { href: '/bewaesserung', label: 'Bewässerung', testId: 'nav-module-bewaesserung', icon: 'tropfen' },
  { href: '/forecast', label: 'Wetter', testId: 'nav-module-forecast', icon: 'forecast' },
  { href: '/automation', label: 'Automatik', testId: 'nav-module-automation', icon: 'automation' },
  { href: '/einstellungen', label: 'Einstellungen', testId: 'nav-module-einstellungen', icon: 'einstellungen' },
];

/**
 * Maps each top-level module to the set of routes that should paint it
 * as active. The legacy config tabs (`/rooms`, `/sources`, …) live under
 * the Einstellungen module; `/history` is reachable both as the Verlauf
 * tab and the Forecast module; `/rules` powers the Automation module.
 */
const MODULE_ROUTE_MAP: Record<string, string[]> = {
  '/beschattung': ['/', '', '/beschattung', '/live'],
  '/lueftung': ['/lueftung'],
  '/klima': ['/klima'],
  '/bewaesserung': ['/bewaesserung'],
  '/forecast': ['/forecast', '/history'],
  '/automation': ['/automation', '/rules'],
  '/einstellungen': [
    '/einstellungen',
    '/rooms',
    '/sources',
    '/wizard',
    '/diagnostics',
    '/logs-debug',
    '/benachrichtigungen',
    '/bewaesserung-einstellungen',
    '/messages',
    '/updates',
    '/hilfe',
  ],
};

function isModuleActive(currentUrl: string, href: string): boolean {
  const routes = MODULE_ROUTE_MAP[href] ?? [href];
  return routes.includes(currentUrl);
}

/**
 * Type-correct wrapper around preact-router's `Link`. The upstream
 * type only declares `HTMLAttributes<HTMLAnchorElement>`, which
 * omits `href`. Wrapping the component lets us keep the route
 * navigation behaviour while declaring the props we actually pass.
 */
type RouterLinkProps = JSX.HTMLAttributes<HTMLAnchorElement> & { href: string };
const RouterLink = Link as unknown as (props: RouterLinkProps) => JSX.Element;

export interface AppProps {
  /** Initial URL — useful for tests that drive routing without `history`. */
  initialUrl?: string;
}

/** Routable view props injected by preact-router. */
interface RoutableProps {
  path?: string;
}

/**
 * The "Beschattung" main module — the predictive control dashboard
 * (3-column grid). Reads the shared snapshot signal and the location from
 * `/api/config` (defaulting to the Beispielstadt profile until config loads).
 */
function BeschattungView(_props: RoutableProps): JSX.Element {
  const { config } = useConfig();
  const loc = config.value?.location;
  const latitude = loc?.latitude ?? 52.52;
  const longitude = loc?.longitude ?? 13.41;
  return (
    <DashboardGrid
      snapshot={snapshot.value}
      latitude={latitude}
      longitude={longitude}
    />
  );
}

/**
 * Lüftung module — read-only "geplant" panel. The automatic ventilation
 * feature is not built yet, but the card shows the live state that a
 * future ventilation logic would act on: window/shutter openings and the
 * indoor↔outdoor temperature delta that drives night-cooling/airing.
 */
function LueftungView(_props: RoutableProps): JSX.Element {
  const snap = snapshot.value;
  const windows = snap?.windows ?? [];
  const openWindows = windows.filter(
    (w) => w.currentLevel01 !== null && w.currentLevel01 < 0.95,
  );
  const outdoor = snap?.signals?.outdoorTemp?.value ?? null;
  const indoorTemps = (snap?.rooms ?? [])
    .map((r) => r.tempC)
    .filter((t): t is number => t !== null && Number.isFinite(t));
  const indoorAvg =
    indoorTemps.length > 0
      ? Math.round((indoorTemps.reduce((a, b) => a + b, 0) / indoorTemps.length) * 10) / 10
      : null;
  const delta =
    indoorAvg !== null && outdoor !== null
      ? Math.round((indoorAvg - outdoor) * 10) / 10
      : null;
  const vent = snap?.ventilation;
  const actionRooms = (vent?.rooms ?? []).filter(
    (r) => r.level === 'air_now' || r.level === 'close_window' || r.level === 'air_possible',
  );
  return (
    <section class="module-panel" data-testid="module-lueftung">
      <header class="module-panel__head">
        <h1>Lüftung</h1>
        <span class="module-panel__badge" data-testid="module-lueftung-status">
          Empfehlung
        </span>
      </header>
      <p class="module-panel__intro">
        Heat Shield steuert keine Fenster (kein Aktor), gibt aber eine
        Lüftungsempfehlung aus Innen-/Außentemperatur, Sonnenstand und
        Hitzeschutz-Modus. Nachts kühlt Querlüften, tagsüber bei Hitze besser
        geschlossen halten.
      </p>
      {vent !== undefined && (
        <div
          class={`vent-advice vent-advice--${vent.overall.level}`}
          data-testid="vent-overall"
          data-level={vent.overall.level}
        >
          <span class="vent-advice__headline">{vent.overall.headline}</span>
          <span class="vent-advice__detail">{vent.overall.detail}</span>
        </div>
      )}
      <div class="module-panel__cards">
        <article class="module-panel__card" data-testid="lueftung-windows">
          <h2>Fenster &amp; Rollläden</h2>
          <p class="module-panel__metric">
            {openWindows.length}/{windows.length} geöffnet
          </p>
          <p class="module-panel__hint">
            Ein Rollladen unter 95 % gilt als „offen" – nur sinnvoll, solange
            kein Fensterkontakt zugewiesen ist.
          </p>
        </article>
        <article class="module-panel__card" data-testid="lueftung-delta">
          <h2>Temperatur-Differenz</h2>
          <p class="module-panel__metric">
            {delta === null ? '–' : `${delta > 0 ? '+' : ''}${delta} K`}
          </p>
          <p class="module-panel__hint">
            Innen {indoorAvg === null ? '–' : `${indoorAvg} °C`} · Außen{' '}
            {outdoor === null ? '–' : `${Math.round(outdoor * 10) / 10} °C`}. Ein
            kühleres Außenklima ermöglicht Nachtlüftung.
          </p>
        </article>
        <TrendCard title="Verlauf · Innen & Außen" variant="temps" />
      </div>
      {vent !== undefined && vent.rooms.length > 0 && (
        <div class="vent-rooms" data-testid="vent-rooms">
          <h2>Räume</h2>
          <ul class="vent-rooms__list">
            {(actionRooms.length > 0 ? actionRooms : vent.rooms).map((r) => (
              <li
                key={r.id}
                class={`vent-room vent-room--${r.level}`}
                data-testid={`vent-room-${r.id}`}
                data-level={r.level}
              >
                <span class="vent-room__name">{r.name}</span>
                <span class="vent-room__headline">{r.headline}</span>
                <span class="vent-room__detail">{r.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/**
 * Klima module — read-only "geplant" panel. Active cooling is a future
 * feature; the card surfaces the current automation mode/goal and the
 * indoor comfort situation a cooling logic would target.
 */
function KlimaView(_props: RoutableProps): JSX.Element {
  const snap = snapshot.value;
  const modeInfo = snap?.modeInfo;
  const indoorTemps = (snap?.rooms ?? [])
    .map((r) => r.tempC)
    .filter((t): t is number => t !== null && Number.isFinite(t));
  const indoorAvg =
    indoorTemps.length > 0
      ? Math.round((indoorTemps.reduce((a, b) => a + b, 0) / indoorTemps.length) * 10) / 10
      : null;
  const feelsLike = snap?.feelsLike?.feelsLikeC ?? null;
  const cool = snap?.cooling;
  return (
    <section class="module-panel" data-testid="module-klima">
      <header class="module-panel__head">
        <h1>Klima</h1>
        <span class="module-panel__badge" data-testid="module-klima-status">
          Empfehlung
        </span>
      </header>
      <p class="module-panel__intro">
        Heat Shield kühlt heute passiv über die Beschattung. Diese Empfehlung
        zeigt, ob aktives Kühlen (z. B. Klimagerät an einer HmIP-Steckdose)
        lohnt — bevorzugt mit PV-Überschuss, damit der Solarstrom selbst
        genutzt wird statt Netzbezug.
      </p>
      {cool !== undefined && (
        <div
          class={`vent-advice vent-advice--cool-${cool.level}`}
          data-testid="cool-overall"
          data-level={cool.level}
        >
          <span class="vent-advice__headline">{cool.headline}</span>
          <span class="vent-advice__detail">{cool.detail}</span>
        </div>
      )}
      <div class="module-panel__cards">
        <article class="module-panel__card" data-testid="klima-mode">
          <h2>Aktueller Modus</h2>
          <p class="module-panel__metric">{modeInfo?.label ?? '–'}</p>
          <p class="module-panel__hint">{modeInfo?.goal ?? 'warte auf Daten'}</p>
        </article>
        <article class="module-panel__card" data-testid="klima-indoor">
          <h2>Innenklima</h2>
          <p class="module-panel__metric">
            {indoorAvg === null ? '–' : `${indoorAvg} °C`}
          </p>
          <p class="module-panel__hint">
            Gefühlt {feelsLike === null ? '–' : `${Math.round(feelsLike * 10) / 10} °C`}.
            Zielband Komfort 20–26 °C.
          </p>
        </article>
        <article class="module-panel__card" data-testid="klima-pv">
          <h2>PV-Überschuss</h2>
          <p class="module-panel__metric">
            {cool?.pvSurplusKw === null || cool?.pvSurplusKw === undefined
              ? '–'
              : `${Math.round(cool.pvSurplusKw * 10) / 10} kW`}
          </p>
          <p class="module-panel__hint">
            Verfügbarer Solarstrom für aktives Kühlen (Eigenverbrauch vor
            Netzbezug).
          </p>
        </article>
        <TrendCard title="Innenklima · Verlauf" variant="temps" />
        <TrendCard title="PV-Leistung · Verlauf" variant="pv" />
      </div>
    </section>
  );
}

/** Sub-navigation entries shown inside the Einstellungen hub. */
interface SettingsLink {
  href: string;
  label: string;
  description: string;
  testId: string;
}

const SETTINGS_LINKS: SettingsLink[] = [
  {
    href: '/rooms',
    label: 'Räume & Fenster',
    description: 'Räume, Stockwerke, Rollläden und Sensoren zuordnen.',
    testId: 'settings-link-rooms',
  },
  {
    href: '/sources',
    label: 'Quellen',
    description: 'Signalquellen (HMIP, FusionSolar, Wetter) binden und testen.',
    testId: 'settings-link-sources',
  },
  {
    href: '/wizard',
    label: 'Einrichtungs-Assistent',
    description: 'Standort, Quellen und Räume Schritt für Schritt einrichten.',
    testId: 'settings-link-wizard',
  },
  {
    href: '/diagnostics',
    label: 'Diagnose',
    description: 'Verbindungsstatus, Logs und Selbsttests einsehen.',
    testId: 'settings-link-diagnostics',
  },
  {
    href: '/logs-debug',
    label: 'Logs & Debug',
    description: 'Alle Logs (Connect, Entscheidungen), Roh-Daten und umfangreiche Debug-Werkzeuge.',
    testId: 'settings-link-logs-debug',
  },
  {
    href: '/benachrichtigungen',
    label: 'Benachrichtigungen',
    description: 'Telegram-Bot, Morgen-Briefing, Abend-Rückblick und Wetter-Updates.',
    testId: 'settings-link-notifications',
  },
  {
    href: '/bewaesserung-einstellungen',
    label: 'Bewässerung',
    description: 'Zonen, Pflanzen-/Boden-Profile, Gardena-Ventile, ET-Modell und Budgets.',
    testId: 'settings-link-irrigation',
  },
  {
    href: '/messages',
    label: 'Nachrichten',
    description: 'Hinweise und Empfehlungen des Plugins durchsehen.',
    testId: 'settings-link-messages',
  },
  {
    href: '/updates',
    label: 'Updates',
    description: 'Version, Build und Changelog dieser Installation.',
    testId: 'settings-link-updates',
  },
  {
    href: '/hilfe',
    label: 'Hilfe',
    description: 'Alle Funktionen im Überblick mit einer kurzen Erklärung.',
    testId: 'settings-link-help',
  },
];

/**
 * Einstellungen hub — a settings landing page with sub-navigation to the
 * legacy config tabs. Each link routes to its dedicated route (which keeps
 * working standalone); the Einstellungen module stays highlighted for all
 * of them via `MODULE_ROUTE_MAP`.
 */
function SettingsHub(_props: RoutableProps): JSX.Element {
  return (
    <section class="settings-hub" data-testid="settings-hub">
      <header class="settings-hub__head">
        <h1>Einstellungen</h1>
        <p>Konfiguration und Diagnose – wähle einen Bereich.</p>
      </header>
      <div class="settings-hub__grid">
        {SETTINGS_LINKS.map((l) => (
          <RouterLink
            key={l.href}
            href={l.href}
            data-testid={l.testId}
            class="settings-hub__card"
          >
            <span class="settings-hub__card-title">{l.label}</span>
            <span class="settings-hub__card-desc">{l.description}</span>
          </RouterLink>
        ))}
      </div>
      <HouseImageUpload />
    </section>
  );
}

export function App(props: AppProps = {}): JSX.Element {
  // Read /api/state on a 30 s timer and subscribe to /api/stream so
  // every tab sees the latest snapshot. The hooks themselves write
  // into the shared signals store; we don't need their return values.
  useApiState();
  useStream();
  // Load + keep the in-app message list/badge in sync.
  useMessages();
  // Check GitHub for a newer release than the running build.
  const update = useUpdateCheck();

  // Track the current URL so the tab nav can paint the active tab.
  const initial =
    props.initialUrl ?? (typeof window === 'undefined' ? '/live' : getCurrentUrl() || '/live');
  const [currentUrl, setCurrentUrl] = useState<string>(initial);

  // Ambient background: the whole dashboard sits on a dynamic gradient driven
  // by sun elevation + weather, so the glass surfaces breathe with the day.
  const { config: ambientConfig } = useConfig();
  const [ambient, setAmbient] = useState<boolean>(loadAmbient);
  const toggleAmbient = (): void => {
    setAmbient((v) => {
      const next = !v;
      saveAmbient(next);
      return next;
    });
  };
  const ambientStyle = ((): JSX.CSSProperties | undefined => {
    if (!ambient) return undefined;
    const loc = ambientConfig.value?.location;
    const lat = loc?.latitude ?? 52.52;
    const lon = loc?.longitude ?? 13.41;
    const sun = getSunPosition(new Date(), lat, lon);
    const snap = snapshot.value;
    const rawCloud = snap?.signals?.forecastCloudCover?.value ?? null;
    const cloud01 =
      rawCloud === null ? 0 : rawCloud > 1 ? Math.min(1, rawCloud / 100) : Math.max(0, rawCloud);
    const storm = snap?.mode === 'STORM' || snap?.storm?.holdUntil != null;
    return { background: ambientBackground(sun.elevationDeg, cloud01, storm) };
  })();

  // Auto-redirect to the wizard the first time we see
  // `pluginReadiness === 'CONFIG_REQUIRED'`. The session-storage
  // guard prevents the user from being teleported back to the
  // wizard every time they navigate away while CONFIG_REQUIRED is
  // still active. Tests that bypass sessionStorage (jsdom default)
  // still see the redirect because the snapshot signal is read
  // synchronously on mount.
  useEffect(() => {
    if (currentUrl.startsWith('/wizard')) {
      return;
    }
    const snap = snapshot.value;
    if (snap === null || snap.pluginReadiness !== 'CONFIG_REQUIRED') {
      return;
    }
    const alreadyRedirected =
      typeof sessionStorage !== 'undefined' &&
      sessionStorage.getItem(WIZARD_AUTO_REDIRECT_KEY) === 'true';
    if (alreadyRedirected) {
      return;
    }
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem(WIZARD_AUTO_REDIRECT_KEY, 'true');
    }
    route('/wizard', true);
    setCurrentUrl('/wizard');
  }, [snapshot.value]);

  return (
    <div
      class={`app${ambient ? ' app--ambient' : ''}`}
      {...(ambientStyle !== undefined ? { style: ambientStyle } : {})}
    >
      <header class="app__header" data-testid="app-header">
        <span class="app__brand">
          <Icon name="logo" size={26} class="app__logo" />
          Heat Shield
          <button
            type="button"
            class={`app__version${update.value.updateAvailable ? ' app__version--update' : ''}`}
            data-testid="app-version"
            title={
              update.value.updateAvailable
                ? `Update verfügbar: v${update.value.latest ?? ''} — zu den Updates`
                : 'Version & Updates'
            }
            onClick={(): void => {
              route('/updates', true);
              setCurrentUrl('/updates');
            }}
          >
            v{APP_VERSION}
            {update.value.updateAvailable && <span class="app__version-dot" aria-hidden="true" />}
          </button>
        </span>
        <nav class="app__modules" data-testid="module-nav" role="navigation">
          {MODULES.map((m) => {
            const active = isModuleActive(currentUrl, m.href);
            const isBeschattung = m.testId === 'nav-module-beschattung';
            const badgeCount =
              (snapshot.value?.plannedActions?.length ?? 0) + unreadMessages.value;
            return (
              <RouterLink
                key={m.href}
                href={m.href}
                data-testid={m.testId}
                class={`app__module ${active ? 'app__module--active' : ''}`}
                aria-current={active ? 'page' : undefined}
              >
                {m.icon !== undefined && (
                  <Icon name={m.icon} class="app__module-icon" />
                )}
                <span class="app__module-label">{m.label}</span>
                {isBeschattung && badgeCount > 0 && (
                  <span class="app__module-badge" data-testid="nav-badge">
                    {badgeCount}
                  </span>
                )}
              </RouterLink>
            );
          })}
        </nav>
        <div class="app__header-actions">
          <button
            type="button"
            class={`ambient-toggle${ambient ? ' ambient-toggle--on' : ''}`}
            data-testid="ambient-toggle"
            aria-pressed={ambient}
            title="Ambient-Hintergrund (Tageszeit & Wetter) ein/aus"
            onClick={toggleAmbient}
          >
            <span class="ambient-toggle__dot" aria-hidden="true" />
            Ambient
          </button>
          <MessageBell
            unread={unreadMessages.value}
            onActivate={(): void => {
              route('/messages', true);
              setCurrentUrl('/messages');
            }}
          />
          <AutomationLever />
        </div>
      </header>
      <main class="app__main">
        <ErrorBoundary>
          <Router
            {...(props.initialUrl !== undefined ? { url: props.initialUrl } : {})}
            onChange={(args: RouterOnChangeArgs): void => {
              setCurrentUrl(args.url);
            }}
          >
            <BeschattungView path="/" />
            <BeschattungView path="/beschattung" />
            <LueftungView path="/lueftung" />
            <KlimaView path="/klima" />
            <IrrigationTab path="/bewaesserung" />
            <HistoryTab path="/forecast" />
            <RulesTab path="/automation" />
            <SettingsHub path="/einstellungen" />
            <LiveTab path="/live" />
            <RoomsTab path="/rooms" />
            <SourcesTab path="/sources" />
            <RulesTab path="/rules" />
            <HistoryTab path="/history" />
            <WizardTab path="/wizard" />
            <DiagnosticsTab path="/diagnostics" />
            <NotificationsTab path="/benachrichtigungen" />
            <IrrigationSettingsTab path="/bewaesserung-einstellungen" />
            <MessagesTab path="/messages" />
            <UpdatesTab path="/updates" />
            <HelpTab path="/hilfe" />
            <LogsDebugTab path="/logs-debug" />
          </Router>
        </ErrorBoundary>
      </main>
    </div>
  );
}

/**
 * Imperative navigation helper for callers outside the component
 * tree (e.g. testing harnesses or future deep-link redirects).
 */
export function navigate(url: string): void {
  route(url, true);
}
