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

import { h, type JSX, type ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { Router, Link, route, getCurrentUrl, type RouterOnChangeArgs } from 'preact-router';

import { ErrorBoundary } from './components/errorBoundary.js';
import { AutomationLever } from './components/automationLever.js';
import { MessageBell } from './components/messageBell.js';
import { AlertCenter } from './components/dashboard/alertCenter.js';
import { UebersichtView } from './components/uebersicht/uebersichtView.js';
import { LiquidGlass2Overview } from './components/liquidglass2/liquidGlass2Overview.js';
import {
  LiquidGlass2Darstellung,
  LiquidGlass2Einstellungen,
  LiquidGlass2Warnungen,
} from './components/liquidglass2/liquidGlass2Settings.js';
import { Lg2Shell } from './components/liquidglass2/shell/lg2Shell.js';
import { LiquidGlass2Raeume } from './components/liquidglass2/liquidGlass2Raeume.js';
import { LiquidGlass2Vorhersage } from './components/liquidglass2/liquidGlass2Vorhersage.js';
import { LiquidGlass2Garten } from './components/liquidglass2/liquidGlass2Garten.js';
import { LiquidGlass2Automatik } from './components/liquidglass2/liquidGlass2Automatik.js';
import { LiquidGlass2Wizard } from './components/liquidglass2/liquidGlass2Wizard.js';
import { Icon } from './components/icons.js';
import { HouseImageUpload } from './components/houseImageUpload.js';
import { useApiState } from './hooks/useApiState.js';
import { useConfig } from './hooks/useConfig.js';
import { useMessages } from './hooks/useMessages.js';
import { useStream } from './hooks/useStream.js';
import { useUpdateCheck } from './hooks/useUpdateCheck.js';
import { snapshot, unreadMessages } from './store.js';
import { getSunPosition } from './components/sunPolarPlot.js';
import { ambientBackground, ambientEnabled } from './ambient.js';
import { getFlag } from './featureFlags.js';
import { setUiVersion, uiVersion } from './uiVersion.js';
import { MODULES, WARNINGS_MODULE, isModuleActive, SETTINGS_LINKS } from './navModel.js';
import { useBreakpoint, isTabletUp, isPhone } from './responsive.js';
import { MobileNav } from './components/shell/mobileNav.js';
import { FreshnessChip } from './components/shell/freshnessChip.js';
import { APP_VERSION } from './version.js';
import { t } from './i18n.js';
import { DiagnosticsTab } from './tabs/diagnostics.js';
import { HelpTab } from './tabs/help.js';
import { RaeumeView } from './tabs/raeume.js';
import { VorhersageView } from './tabs/vorhersage.js';
import { GartenView } from './tabs/garten.js';
import { AutomatikView } from './tabs/automatik.js';
import { SystemView } from './tabs/system.js';
import { BuildingStudioView } from './tabs/buildingStudio.js';
import { ShowcaseView } from './tabs/showcase.js';
import { MessagesTab } from './tabs/messages.js';
import { NotificationsTab } from './tabs/notifications.js';
import { IrrigationSettingsTab } from './tabs/irrigationSettings.js';
import { LogsDebugTab } from './tabs/logsDebug.js';
import { AppearanceTab } from './tabs/appearance.js';
import { RoomsTab } from './tabs/rooms.js';
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

/** Redirect helper: navigate to `to` on mount (keeps old routes working). */
function Redirect(props: { to: string } & RoutableProps): null {
  useEffect(() => {
    route(props.to, true);
  }, [props.to]);
  return null;
}

/**
 * Warnungen module — the conditional primary destination (blueprint §9). Shows
 * the active severe-weather alert (AlertCenter) or a calm "no active warnings"
 * state. The per-room ventilation/climate advice lives under Räume now.
 */
function WarnungenView(_props: RoutableProps): JSX.Element {
  const { config } = useConfig();
  const loc = config.value?.location;
  const latitude = loc?.latitude ?? 52.52;
  const longitude = loc?.longitude ?? 13.41;
  const active = snapshot.value?.weatherAlert?.active === true;
  return (
    <section class="module-panel" data-testid="module-warnungen">
      <header class="module-panel__head">
        <h1>{t('Warnungen', 'Warnings')}</h1>
      </header>
      {active ? (
        <AlertCenter latitude={latitude} longitude={longitude} surface="weather" showRadar />
      ) : (
        <p class="module-panel__intro" data-testid="warnungen-empty">
          {t('Aktuell keine aktiven Wetterwarnungen.', 'No active weather warnings right now.')}
        </p>
      )}
    </section>
  );
}

/**
 * Einstellungen hub — a settings landing page with sub-navigation to the
 * legacy config tabs. Each link routes to its dedicated route (which keeps
 * working standalone); the Einstellungen module stays highlighted for all
 * of them via `MODULE_ROUTE_MAP`.
 */
function SettingsHub(_props: RoutableProps): JSX.Element {
  const uiV = uiVersion.value;
  const chooseUi = (v: 'v1' | 'v2'): void => {
    // Persist + apply globally. The AppShell (Task 4) swaps the design on the
    // CURRENT route reactively — no navigation needed. Until the unified shell
    // lands, the interim demo route keeps v2 reachable for evaluation.
    setUiVersion(v);
  };
  const links = getFlag('buildingStudioV2')
    ? [
        ...SETTINGS_LINKS,
        {
          href: '/building',
          label: 'Gebäude-Studio',
          labelEn: 'Building Studio',
          description: 'Grundriss-Editor (Vorschau): Wände, Räume und Stockwerke zeichnen.',
          descriptionEn: 'Floor-plan editor (preview): draw walls, rooms and storeys.',
          testId: 'settings-link-building',
        },
      ]
    : SETTINGS_LINKS;
  return (
    <section class="settings-hub" data-testid="settings-hub">
      <header class="settings-hub__head">
        <h1>{t('Einstellungen', 'Settings')}</h1>
        <p>{t('Konfiguration und Diagnose – wähle einen Bereich.', 'Configuration and diagnostics – pick an area.')}</p>
      </header>
      <div class="settings-hub__uiswitch" data-testid="ui-version-switch">
        <div class="settings-hub__uiswitch-text">
          <span class="settings-hub__uiswitch-title">{t('Benutzeroberfläche', 'User interface')}</span>
          <span class="settings-hub__uiswitch-hint">
            {t('v2 ist die neue „Liquid Glass"-Oberfläche. v1 ist die stabile 1.20-Oberfläche. Die Auswahl gilt sofort für die gesamte App.',
              'v2 is the new "Liquid Glass" interface. v1 is the stable 1.20 interface. The choice applies to the whole app immediately.')}
          </span>
        </div>
        <div class="settings-hub__seg" role="tablist">
          <button type="button" role="tab" aria-selected={uiV === 'v1'}
            class={`settings-hub__seg-btn${uiV === 'v1' ? ' settings-hub__seg-btn--on' : ''}`}
            onClick={(): void => chooseUi('v1')}>{t('UI v1 (1.20)', 'UI v1 (1.20)')}</button>
          <button type="button" role="tab" aria-selected={uiV === 'v2'}
            class={`settings-hub__seg-btn${uiV === 'v2' ? ' settings-hub__seg-btn--on' : ''}`}
            onClick={(): void => chooseUi('v2')}>{t('UI v2 (2.0)', 'UI v2 (2.0)')}</button>
        </div>
      </div>
      <div class="settings-hub__grid">
        {links.map((l) => (
          <RouterLink
            key={l.href}
            href={l.href}
            data-testid={l.testId}
            class="settings-hub__card"
          >
            <span class="settings-hub__card-title">{t(l.label, l.labelEn)}</span>
            <span class="settings-hub__card-desc">{t(l.description, l.descriptionEn)}</span>
          </RouterLink>
        ))}
      </div>
      <HouseImageUpload />
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Page registry — one canonical route → { v1, v2? } design variant           */
/* -------------------------------------------------------------------------- */

type PageComponent = (props: RoutableProps) => JSX.Element;

/** A canonical page and its design variants. `v2` optional → falls back to v1. */
interface PageEntry {
  v1: PageComponent;
  v2?: PageComponent;
}

/**
 * Single source of truth for the route → design mapping (ui-v2-release,
 * Requirement 3/10). v2-native pages render their own `<main class="lg2-main">`
 * content into the shared shell; pages without a native v2 variant fall back to
 * the full v1 content wrapped by `Lg2Fallback`.
 */
const PAGE_REGISTRY: Record<string, PageEntry> = {
  '/uebersicht': { v1: UebersichtView, v2: LiquidGlass2Overview },
  '/raeume': { v1: RaeumeView, v2: LiquidGlass2Raeume },
  '/vorhersage': { v1: VorhersageView, v2: LiquidGlass2Vorhersage },
  '/garten': { v1: GartenView, v2: LiquidGlass2Garten },
  '/automatik': { v1: AutomatikView, v2: LiquidGlass2Automatik },
  '/warnungen': { v1: WarnungenView, v2: LiquidGlass2Warnungen },
  '/einstellungen': { v1: SettingsHub, v2: LiquidGlass2Einstellungen },
  '/system': { v1: SystemView },
  '/building': { v1: BuildingStudioView },
  '/showcase': { v1: ShowcaseView },
  '/rooms': { v1: RoomsTab },
  '/sources': { v1: SourcesTab },
  '/wizard': { v1: WizardTab, v2: LiquidGlass2Wizard },
  '/diagnostics': { v1: DiagnosticsTab },
  '/benachrichtigungen': { v1: NotificationsTab },
  '/bewaesserung-einstellungen': { v1: IrrigationSettingsTab },
  '/messages': { v1: MessagesTab },
  '/updates': { v1: UpdatesTab },
  '/hilfe': { v1: HelpTab },
  '/logs-debug': { v1: LogsDebugTab },
  '/darstellung': { v1: AppearanceTab, v2: LiquidGlass2Darstellung },
};

/**
 * Fallback for a route that has no native v2 variant yet: render the full v1
 * page content inside the shared shell's content area (the sidebar chrome is
 * provided by the AppShell). No v1 top header — the v2 sidebar is the sole nav.
 */
function Lg2Fallback(props: { children: ComponentChildren }): JSX.Element {
  return (
    <main class="lg2-main lg2-fallback" data-testid="lg2-fallback">
      {props.children}
    </main>
  );
}

/**
 * Routed page: renders the design variant for the current `uiVersion`. Reads the
 * signal reactively, so a version switch re-renders the SAME route in the other
 * design without navigating (Requirement 1/2). Any injected preact-router props
 * are ignored — the page components read the shared snapshot signal.
 */
function Page(props: { route: string } & RoutableProps): JSX.Element {
  const entry = PAGE_REGISTRY[props.route];
  if (entry === undefined) {
    const Fallback = UebersichtView;
    return <Fallback />;
  }
  if (uiVersion.value === 'v2') {
    if (entry.v2 !== undefined) {
      const V2 = entry.v2;
      return <V2 />;
    }
    const V1 = entry.v1;
    return (
      <Lg2Fallback>
        <V1 />
      </Lg2Fallback>
    );
  }
  const V1 = entry.v1;
  return <V1 />;
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
    props.initialUrl ?? (typeof window === 'undefined' ? '/uebersicht' : getCurrentUrl() || '/uebersicht');
  const [currentUrl, setCurrentUrl] = useState<string>(initial);

  // Ambient background: the whole dashboard sits on a dynamic gradient driven
  // by sun elevation + weather, so the glass surfaces breathe with the day.
  const { config: ambientConfig } = useConfig();
  const ambient = ambientEnabled.value;
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

  // UI version (ui-v2-release): the persisted `uiVersion` signal now drives the
  // design globally via the AppShell (Task 4) — a design switch re-renders the
  // CURRENT route in the other design, so no startup redirect to a demo route
  // is needed. The former `/liquid-glass2` auto-redirect has been removed.

  // Premium desktop/tablet shell (Gate 2 G2.2) — opt-in behind `premiumUiV2`
  // and only at tablet-or-wider. Default OFF, so the shipped shell is the
  // default; this only adds a root class that scoped CSS layers a sidebar
  // layout + v2 spacing onto. DOM/routes are unchanged.
  const breakpoint = useBreakpoint();
  const premiumShell = getFlag('premiumUiV2') && isTabletUp(breakpoint);
  // Mobile touch-first shell (Gate 2 G2.3) — opt-in behind `mobileUiV2` and
  // only at phone widths. Default OFF. Adds a root class for scoped CSS and a
  // fixed 5-item bottom nav; routes/content are unchanged.
  const mobileShell = getFlag('mobileUiV2') && isPhone(breakpoint);

  // One canonical route set; each <Page> picks the v1/v2 design from `uiVersion`.
  const outlet = (
    <ErrorBoundary>
      <Router
        {...(props.initialUrl !== undefined ? { url: props.initialUrl } : {})}
        onChange={(args: RouterOnChangeArgs): void => {
          setCurrentUrl(args.url);
        }}
      >
        <Page path="/" route="/uebersicht" />
        <Page path="/uebersicht" route="/uebersicht" />
        <Page path="/raeume" route="/raeume" />
        <Page path="/vorhersage" route="/vorhersage" />
        <Page path="/garten" route="/garten" />
        <Page path="/automatik" route="/automatik" />
        <Page path="/warnungen" route="/warnungen" />
        <Page path="/einstellungen" route="/einstellungen" />
        <Page path="/system" route="/system" />
        <Page path="/building" route="/building" />
        <Page path="/showcase" route="/showcase" />
        <Page path="/rooms" route="/rooms" />
        <Page path="/sources" route="/sources" />
        <Page path="/wizard" route="/wizard" />
        <Page path="/diagnostics" route="/diagnostics" />
        <Page path="/benachrichtigungen" route="/benachrichtigungen" />
        <Page path="/bewaesserung-einstellungen" route="/bewaesserung-einstellungen" />
        <Page path="/messages" route="/messages" />
        <Page path="/updates" route="/updates" />
        <Page path="/hilfe" route="/hilfe" />
        <Page path="/logs-debug" route="/logs-debug" />
        <Page path="/darstellung" route="/darstellung" />
        {/* Backward-compatible redirects (old routes → new IA). */}
        <Redirect path="/beschattung" to="/uebersicht" />
        <Redirect path="/live" to="/uebersicht" />
        <Redirect path="/lueftung" to="/raeume" />
        <Redirect path="/klima" to="/raeume" />
        <Redirect path="/forecast" to="/vorhersage" />
        <Redirect path="/history" to="/vorhersage" />
        <Redirect path="/bewaesserung" to="/garten" />
        <Redirect path="/automation" to="/automatik" />
        <Redirect path="/rules" to="/automatik" />
        {/* Retired demo routes → canonical (ui-v2-release). */}
        <Redirect path="/liquid-glass" to="/uebersicht" />
        <Redirect path="/liquid-glass2" to="/uebersicht" />
        <Redirect path="/liquid-glass-raeume" to="/raeume" />
        <Redirect path="/liquid-glass-vorhersage" to="/vorhersage" />
        <Redirect path="/liquid-glass-garten" to="/garten" />
        <Redirect path="/liquid-glass-automatik" to="/automatik" />
      </Router>
    </ErrorBoundary>
  );

  // v2 (Liquid Glass): the left sidebar shell is the ONLY chrome — no top nav.
  if (uiVersion.value === 'v2') {
    return (
      <div class="app app--uiv2" data-testid="app-uiv2">
        <Lg2Shell currentUrl={currentUrl}>{outlet}</Lg2Shell>
      </div>
    );
  }

  // v1 (stable 1.20): top header + horizontal module nav.
  return (
    <div
      class={`app${ambient ? ' app--ambient' : ''}${premiumShell ? ' app--premium' : ''}${mobileShell ? ' app--mobile' : ''}`}
      {...(ambientStyle !== undefined ? { style: ambientStyle } : {})}
    >
      <a class="skip-link" href="#main-content" data-testid="skip-link">
        {t('Zum Inhalt springen', 'Skip to content')}
      </a>
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
                ? t(
                    `Update verfügbar: v${update.value.latest ?? ''} — zu den Updates`,
                    `Update available: v${update.value.latest ?? ''} — go to updates`,
                  )
                : t('Version & Updates', 'Version & updates')
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
        <nav class="app__modules" data-testid="module-nav" role="navigation" aria-label={t('Module', 'Modules')}>
          {MODULES.map((m) => {
            const active = isModuleActive(currentUrl, m.href);
            const isUebersicht = m.testId === 'nav-module-uebersicht';
            const badgeCount =
              (snapshot.value?.plannedActions?.filter(
                (a) => a.state !== 'manuallyOverridden' && a.state !== 'blocked',
              ).length ?? 0) + unreadMessages.value;
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
                <span class="app__module-label">{t(m.label, m.labelEn)}</span>
                {isUebersicht && badgeCount > 0 && (
                  <span class="app__module-badge" data-testid="nav-badge">
                    {badgeCount}
                  </span>
                )}
              </RouterLink>
            );
          })}
          {/* Warnungen is a conditional primary — only in the nav while active. */}
          {snapshot.value?.weatherAlert?.active === true && (
            <RouterLink
              href={WARNINGS_MODULE.href}
              data-testid={WARNINGS_MODULE.testId}
              class={`app__module app__module--warning ${isModuleActive(currentUrl, WARNINGS_MODULE.href) ? 'app__module--active' : ''}`}
              aria-current={isModuleActive(currentUrl, WARNINGS_MODULE.href) ? 'page' : undefined}
            >
              <Icon name={WARNINGS_MODULE.icon} class="app__module-icon" />
              <span class="app__module-label">{t(WARNINGS_MODULE.label, WARNINGS_MODULE.labelEn)}</span>
            </RouterLink>
          )}
        </nav>
        <div class="app__header-actions">
          <FreshnessChip />
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
      <main class="app__main" id="main-content" tabIndex={-1}>
        {outlet}
      </main>
      {mobileShell && (
        <MobileNav currentUrl={currentUrl} onNavigate={(url): void => setCurrentUrl(url)} />
      )}
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
