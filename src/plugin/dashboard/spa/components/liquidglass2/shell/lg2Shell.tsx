/**
 * Heat Shield — "Liquid Glass V2" app-wide shell (ui-v2-release, Task 3).
 *
 * The single v2 chrome: full-bleed frame, the LEFT sidebar (the only navigation
 * in v2 — there is no top nav), the global Appearance configurator and a
 * dismissible update banner. A content slot renders the active page. Navigation
 * targets the CANONICAL routes and the active module is derived from the current
 * URL via the shared `navModel` (same "active" logic as the v1 top nav).
 *
 * Chrome parity (Requirement 4): version badge + update dot → /updates, message
 * bell + unread → /messages, freshness chip, automation lever and the
 * Basic/Expert switch all live in the sidebar. On phones the sidebar collapses
 * to the existing icon bottom-bar (liquid-glass2.css ≤820px).
 */

import { h, Fragment, type JSX, type ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { getCurrentUrl, route } from 'preact-router';

import { t, fmtTime, locale } from '../../../i18n.js';
import { APP_VERSION } from '../../../version.js';
import { expertMode, setExpertMode } from '../../../expertMode.js';
import { snapshot, unreadMessages } from '../../../store.js';
import { useUpdateCheck } from '../../../hooks/useUpdateCheck.js';
import { MODULES, WARNINGS_MODULE, isModuleActive } from '../../../navModel.js';
import { Icon } from '../../icons.js';
import { HelpGlyph } from './lg2Primitives.js';
import { ConfigPanel } from './lg2ConfigPanel.js';
import { Lg2PullToRefresh } from './lg2PullToRefresh.js';
import { theme, themeStyle, autoAccent, fillPaint, fillBase } from './lg2Theme.js';
import { usePreblurWallpaper } from './lg2Preblur.js';

/* -------------------------------------------------------------------------- */
/* Automation lever (Liquid Glass V2) — chrome element                        */
/* -------------------------------------------------------------------------- */

/**
 * Master automation on/off lever, styled for Liquid Glass V2. Reuses the same
 * contract as the app header lever: reads `snap.automationEnabled`, POSTs
 * `/api/control/automation`, optimistic + reverts on error.
 */
export function Lg2AutoLever(): JSX.Element {
  const snap = snapshot.value;
  const serverValue = snap?.automationEnabled ?? false;
  const [pending, setPending] = useState<boolean | null>(null);
  const enabled = pending ?? serverValue;
  const toggle = async (): Promise<void> => {
    const next = !enabled;
    setPending(next);
    try {
      const res = await fetch('/api/control/automation', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch { setPending(null); }
  };
  if (pending !== null && serverValue === pending) queueMicrotask(() => setPending(null));
  return (
    <button type="button" role="switch" aria-checked={enabled}
      class={`lg2-autolever${enabled ? ' lg2-autolever--on' : ''}`}
      data-testid="lg2-automation-lever"
      title={enabled
        ? t('Automatik aktiv — tippen zum Ausschalten', 'Automation active — tap to turn off')
        : t('Automatik aus — tippen zum Einschalten', 'Automation off — tap to turn on')}
      onClick={(): void => { void toggle(); }}>
      <span class="lg2-autolever__text">
        <span class="lg2-autolever__lbl">{t('Automatik', 'Automation')}</span>
        <span class="lg2-autolever__state">{enabled ? t('Aktiv', 'Active') : t('Aus', 'Off')}</span>
      </span>
      <span class="lg2-autolever__track"><span class="lg2-autolever__knob" /></span>
    </button>
  );
}

/** Message/envelope glyph (line style, matches the sidebar icon set). */
function MailGlyph(): JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <path d="M4 7l8 6 8-6" />
    </svg>
  );
}

/* -------------------------------------------------------------------------- */
/* Sidebar                                                                    */
/* -------------------------------------------------------------------------- */

function Sidebar(props: { clock: Date; currentUrl: string; onConfig: () => void }): JSX.Element {
  const url = props.currentUrl;
  const update = useUpdateCheck();
  const alertActive = snapshot.value?.weatherAlert?.active === true;
  return (
    <aside class="lg2-side" data-testid="lg2-sidebar">
      <div class="lg2-side__brand">
        <span class="lg2-side__logo"><Icon name="logo" size={22} /></span>
        <span>
          <span class="lg2-side__brand-name">HeatShield</span>
          <button
            type="button"
            class={`lg2-side__version${update.value.updateAvailable ? ' lg2-side__version--update' : ''}`}
            data-testid="lg2-version"
            title={update.value.updateAvailable
              ? t(`Update verfügbar: v${update.value.latest ?? ''} — zu den Updates`, `Update available: v${update.value.latest ?? ''} — go to updates`)
              : t('Version & Updates', 'Version & updates')}
            onClick={(): void => { route('/updates'); }}
          >
            v{APP_VERSION}
            {update.value.updateAvailable && <span class="lg2-side__version-dot" aria-hidden="true" />}
          </button>
        </span>
      </div>

      <nav class="lg2-nav" aria-label={t('Navigation', 'Navigation')}>
        {MODULES.map((m) => {
          const active = isModuleActive(url, m.href);
          return (
            <button
              key={m.href}
              type="button"
              data-testid={m.testId}
              class={`lg2-nav__item${active ? ' lg2-nav__item--active' : ''}`}
              aria-current={active ? 'page' : undefined}
              onClick={(): void => { if (!active) route(m.href); }}
            >
              <Icon name={m.icon} size={18} />
              <span>{t(m.label, m.labelEn)}</span>
            </button>
          );
        })}
        {alertActive && (
          <button
            type="button"
            data-testid={WARNINGS_MODULE.testId}
            class={`lg2-nav__item lg2-nav__item--warning${isModuleActive(url, WARNINGS_MODULE.href) ? ' lg2-nav__item--active' : ''}`}
            aria-current={isModuleActive(url, WARNINGS_MODULE.href) ? 'page' : undefined}
            onClick={(): void => { route(WARNINGS_MODULE.href); }}
          >
            <Icon name={WARNINGS_MODULE.icon} size={18} />
            <span>{t(WARNINGS_MODULE.label, WARNINGS_MODULE.labelEn)}</span>
          </button>
        )}
      </nav>

      <span class="lg2-side__spacer" />

      <div class="lg2-side__foot">
        <button type="button" class="lg2-nav__item" data-testid="lg2-messages" onClick={(): void => { route('/messages'); }}>
          <span class="lg2-nav__iconwrap">
            <MailGlyph />
            {unreadMessages.value > 0 && <span class="lg2-nav__badge" data-testid="lg2-unread">{unreadMessages.value}</span>}
          </span>
          <span>{t('Nachrichten', 'Messages')}</span>
        </button>
        <button type="button" class="lg2-nav__item" onClick={(): void => { route('/hilfe'); }}>
          <HelpGlyph />
          <span>{t('Hilfe', 'Help')}</span>
        </button>
        <button type="button" class="lg2-nav__item" data-testid="lg2-open-config" onClick={props.onConfig}>
          <Icon name="pinsel" size={18} />
          <span>{t('Darstellung', 'Appearance')}</span>
        </button>
        <button type="button" class="lg2-nav__item" data-testid="lg2-mode-switch"
          aria-pressed={expertMode.value}
          title={expertMode.value ? t('Experten-Ansicht — tippen für Basis', 'Expert view — tap for Basic') : t('Basis-Ansicht — tippen für Experte', 'Basic view — tap for Expert')}
          onClick={(): void => setExpertMode(!expertMode.value)}>
          <Icon name={expertMode.value ? 'schloss-auf' : 'schloss'} size={18} />
          <span>
            {t('Ansicht', 'View')}
            <span style={{ display: 'block', fontSize: '11.5px', color: 'var(--lg2-accent)', fontWeight: 600 }}>
              {expertMode.value ? t('Experte', 'Expert') : t('Basis', 'Basic')}
            </span>
          </span>
        </button>
      </div>
      <div class="lg2-side__clock">
        <div class="lg2-side__time">{fmtTime(props.clock)}</div>
        <div class="lg2-side__date">
          {props.clock.toLocaleDateString(locale(), { day: 'numeric', month: 'long', year: 'numeric' })}
        </div>
      </div>
    </aside>
  );
}

/* -------------------------------------------------------------------------- */
/* Update banner                                                              */
/* -------------------------------------------------------------------------- */

const UPDATE_DISMISS_KEY = 'heatshield.lg2.updateBannerDismissed';

function UpdateBanner(): JSX.Element | null {
  const update = useUpdateCheck();
  const latest = update.value.latest ?? '';
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try { return sessionStorage.getItem(UPDATE_DISMISS_KEY) === latest && latest !== ''; } catch { return false; }
  });
  if (!update.value.updateAvailable || dismissed) return null;
  const dismiss = (): void => {
    setDismissed(true);
    try { sessionStorage.setItem(UPDATE_DISMISS_KEY, latest); } catch { /* ignore */ }
  };
  return (
    <div class="lg2-updatebar" role="status" data-testid="lg2-update-banner">
      <Icon name="forecast" size={16} />
      <span>{t(`Update verfügbar: v${latest}`, `Update available: v${latest}`)}</span>
      <button type="button" class="lg2-updatebar__go" onClick={(): void => { route('/updates'); }}>
        {t('Ansehen', 'View')}
      </button>
      <button type="button" class="lg2-updatebar__x" aria-label={t('Schließen', 'Close')} onClick={dismiss}>×</button>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Shell                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * App-wide "Liquid Glass V2" shell. Wraps the active page content in the sidebar
 * chrome + frame. `currentUrl` (from the AppShell router) drives the active-nav
 * highlight; when omitted it falls back to `getCurrentUrl()` (per-mount).
 */
export function Lg2Shell(props: {
  currentUrl?: string;
  testId?: string;
  /** Legacy per-page key (ignored now that active is URL-derived). */
  active?: string;
  children: ComponentChildren;
}): JSX.Element {
  const [clock, setClock] = useState<Date>(() => new Date());
  const [cfgOpen, setCfgOpen] = useState(false);
  useEffect(() => {
    const id = setInterval(() => setClock(new Date()), 20000);
    return (): void => clearInterval(id);
  }, []);

  // Full-bleed: hide the surrounding app chrome while the v2 shell is mounted.
  // `ui-v2` is the forward-looking class; `lg2-demo-open` is kept until the CSS
  // scoping is migrated (Task 6/R11.5).
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    document.body.classList.add('lg2-demo-open', 'ui-v2');
    // Performance #6: pause CSS animations while the tab is hidden (skeleton
    // shimmer, storm/alert pulse, …) so no work happens off-screen. Invisible
    // to the user — they only ever see a visible tab.
    const onVis = (): void => {
      const tv = theme.value;
      const on = tv.fps && tv.fpsPauseHidden && document.hidden;
      document.body.classList.toggle('lg2-anim-paused', on);
    };
    document.addEventListener('visibilitychange', onVis);
    onVis();
    return (): void => {
      document.body.classList.remove('lg2-demo-open', 'ui-v2', 'lg2-anim-paused');
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  // The frame lives on `.app__main` (an ANCESTOR), so its CSS vars must be set on
  // <body> to inherit down — a descendant's inline style can't reach an ancestor.
  const th0 = theme.value;
  const d = (th0.frameDarken / 100).toFixed(3);
  const fSrc = th0.frameAuto ? th0.background : th0.frame;
  const frameBg =
    `linear-gradient(rgba(0,0,0,${d}), rgba(0,0,0,${d})), ${fillPaint(fSrc)}, ${fillBase(fSrc)}`;
  const demoShadow = th0.frameShadow
    ? '0 0 0 1px rgba(0,0,0,0.5), 0 24px 70px 12px rgba(0,0,0,0.6)'
    : 'none';
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const b = document.body.style;
    b.setProperty('--lg2-frame-bg', frameBg);
    b.setProperty('--lg2-demo-shadow', demoShadow);
    b.setProperty('--lg2-frame-base', fillBase(fSrc));
    return (): void => {
      b.removeProperty('--lg2-frame-bg');
      b.removeProperty('--lg2-demo-shadow');
      b.removeProperty('--lg2-frame-base');
    };
  }, [frameBg, demoShadow, fSrc]);

  const th = theme.value;
  const effAccent = th.accentAuto ? autoAccent(th) : th.accent;
  const { style, cls } = themeStyle(th, effAccent);
  // Performance option A: pre-blurred wallpaper. Only flip to the static-glass
  // look once the blurred image is actually ready, so there is never a frame of
  // un-frosted (sharp-through-glass) cards.
  const blurUrl = usePreblurWallpaper(th);
  const preblurOn = th.preblur && !th.lite && blurUrl !== null;
  const rootStyle = preblurOn ? { ...style, '--lg2-bg-blurred': `url("${blurUrl}")` } : style;
  const url = props.currentUrl ?? (typeof window === 'undefined' ? '/uebersicht' : getCurrentUrl() || '/uebersicht');

  // Mirror the theme's dynamic tokens onto <body> so PORTALLED surfaces (the
  // room-detail modal and the twin room popover, both portaled to <body>)
  // follow the LIVE theme — accent, glass tint, scrim, labels — instead of only
  // the static defaults from the `body.ui-v2` token block. Without this the
  // portals fall back to foreign v1 colours.
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const b = document.body.style;
    const keys = Object.keys(style).filter((k) => k.startsWith('--lg2-'));
    for (const k of keys) b.setProperty(k, String(style[k]));
    return (): void => {
      for (const k of keys) b.removeProperty(k);
    };
  }, [style]);

  return (
    <div class={`${cls}${expertMode.value ? ' lg2-expert-on' : ''}${preblurOn ? ' lg2-preblur' : ''}`} style={rootStyle as JSX.CSSProperties} data-testid={props.testId ?? 'liquid-glass2'}>
      <Lg2PullToRefresh />
      <Sidebar clock={clock} currentUrl={url} onConfig={(): void => setCfgOpen(true)} />
      {props.children}
      <UpdateBanner />
      {cfgOpen && <ConfigPanel onClose={(): void => setCfgOpen(false)} />}
    </div>
  );
}
