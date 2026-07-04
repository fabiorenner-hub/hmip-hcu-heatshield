/**
 * Heat Shield dashboard — mobile bottom navigation (Gate 2 slice G2.3).
 *
 * Touch-first 5-target bottom nav for the phone shell (blueprint §5.2): four
 * primary destinations + a "Mehr" sheet holding the rest. This is a SEPARATE
 * mobile layout, not a compressed desktop — it groups the shipped routes
 * (DEC-C2 option c) without renaming any of them.
 *
 * Rendered only by `App` when `mobileUiV2` is on AND the viewport is
 * phone-class, so it is inert by default.
 */

import { h, Fragment, type JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { route } from 'preact-router';

import { Icon, type IconName } from '../icons.js';
import { t } from '../../i18n.js';

interface NavTarget {
  href: string;
  label: string;
  labelEn: string;
  icon: IconName;
  testId: string;
}

/** Four primary phone destinations (blueprint IA). */
const PRIMARY: NavTarget[] = [
  { href: '/uebersicht', label: 'Übersicht', labelEn: 'Overview', icon: 'haus', testId: 'mnav-uebersicht' },
  { href: '/raeume', label: 'Räume', labelEn: 'Rooms', icon: 'thermometer', testId: 'mnav-raeume' },
  { href: '/vorhersage', label: 'Vorhersage', labelEn: 'Forecast', icon: 'forecast', testId: 'mnav-vorhersage' },
  { href: '/garten', label: 'Garten', labelEn: 'Garden', icon: 'tropfen', testId: 'mnav-garten' },
];

/** Everything else lives behind "Mehr". */
const MORE: NavTarget[] = [
  { href: '/automatik', label: 'Automatik', labelEn: 'Automation', icon: 'automation', testId: 'mnav-automatik' },
  { href: '/warnungen', label: 'Warnungen', labelEn: 'Warnings', icon: 'warnung', testId: 'mnav-warnungen' },
  { href: '/einstellungen', label: 'Einstellungen', labelEn: 'Settings', icon: 'einstellungen', testId: 'mnav-einstellungen' },
];

export interface MobileNavProps {
  currentUrl: string;
  /** Notified after navigation so the shell can sync its active-url state. */
  onNavigate?: (url: string) => void;
}

export function MobileNav(props: MobileNavProps): JSX.Element {
  const [moreOpen, setMoreOpen] = useState(false);

  // A11y (G2.4): close the "Mehr" sheet on Escape while it is open.
  useEffect(() => {
    if (!moreOpen) return undefined;
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
      return undefined;
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMoreOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [moreOpen]);

  const go = (href: string): void => {
    route(href, true);
    props.onNavigate?.(href);
    setMoreOpen(false);
  };

  const isActive = (href: string): boolean =>
    props.currentUrl === href || (href === '/uebersicht' && props.currentUrl === '/');

  const moreActive = MORE.some((m) => isActive(m.href));

  return (
    <>
      {moreOpen && (
        <div
          class="mobile-more"
          role="dialog"
          aria-label={t('Mehr', 'More')}
          data-testid="mobile-more-sheet"
        >
          <button
            type="button"
            class="mobile-more__backdrop"
            aria-label={t('Schließen', 'Close')}
            onClick={(): void => setMoreOpen(false)}
          />
          <div class="mobile-more__sheet">
            {MORE.map((m) => (
              <button
                key={m.href}
                type="button"
                class={`mobile-more__item${isActive(m.href) ? ' mobile-more__item--active' : ''}`}
                data-testid={m.testId}
                aria-current={isActive(m.href) ? 'page' : undefined}
                onClick={(): void => go(m.href)}
              >
                <Icon name={m.icon} />
                <span>{t(m.label, m.labelEn)}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <nav class="mobile-nav" role="navigation" aria-label={t('Hauptnavigation', 'Primary')} data-testid="mobile-nav">
        {PRIMARY.map((tg) => (
          <button
            key={tg.href}
            type="button"
            class={`mobile-nav__item${isActive(tg.href) ? ' mobile-nav__item--active' : ''}`}
            data-testid={tg.testId}
            aria-current={isActive(tg.href) ? 'page' : undefined}
            onClick={(): void => go(tg.href)}
          >
            <Icon name={tg.icon} class="mobile-nav__icon" />
            <span class="mobile-nav__label">{t(tg.label, tg.labelEn)}</span>
          </button>
        ))}
        <button
          type="button"
          class={`mobile-nav__item${moreActive || moreOpen ? ' mobile-nav__item--active' : ''}`}
          data-testid="mnav-more"
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
          onClick={(): void => setMoreOpen((v) => !v)}
        >
          <Icon name="einstellungen" class="mobile-nav__icon" />
          <span class="mobile-nav__label">{t('Mehr', 'More')}</span>
        </button>
      </nav>
    </>
  );
}
