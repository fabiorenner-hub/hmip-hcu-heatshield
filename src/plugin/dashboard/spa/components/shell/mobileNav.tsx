/**
 * Heat Shield dashboard — mobile bottom navigation (Gate 2 slice G2.3,
 * Apple-style Liquid-Glass rework).
 *
 * Touch-first bottom tab bar for the phone shell (blueprint §5.2): a floating,
 * frosted-glass bar with four primary destinations + a "Mehr" tab that opens a
 * rich bottom sheet holding everything else (Automatik, Einstellungen,
 * Nachrichten, Warnungen, Hilfe, Darstellung, Updates) plus the Basis/Experte
 * view toggle. This is a SEPARATE mobile layout, not a compressed desktop — it
 * groups the shipped routes (DEC-C2 option c) without renaming any of them.
 *
 * Rendered only by `App` when `mobileUiV2` is on AND the viewport is
 * phone-class, so it is inert by default.
 *
 * Design goals: large touch targets (≥56px), an animated active pill behind the
 * current tab's icon, a spring-in sheet with a grab handle, safe-area insets,
 * and full `prefers-reduced-motion` support. Fully bilingual (DE/EN).
 */

import { h, Fragment, type JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { route } from 'preact-router';

import { Icon, type IconName } from '../icons.js';
import { t } from '../../i18n.js';
import { snapshot, unreadMessages } from '../../store.js';
import { expertMode, setExpertMode } from '../../expertMode.js';

interface NavTarget {
  href: string;
  label: string;
  labelEn: string;
  icon: IconName;
  testId: string;
  /** Optional short hint shown under the label inside the "Mehr" sheet. */
  hint?: string;
  hintEn?: string;
}

/** Four primary phone destinations (blueprint IA). */
const PRIMARY: NavTarget[] = [
  { href: '/uebersicht', label: 'Übersicht', labelEn: 'Overview', icon: 'haus', testId: 'mnav-uebersicht' },
  { href: '/raeume', label: 'Räume', labelEn: 'Rooms', icon: 'thermometer', testId: 'mnav-raeume' },
  { href: '/vorhersage', label: 'Vorhersage', labelEn: 'Forecast', icon: 'forecast', testId: 'mnav-vorhersage' },
  { href: '/garten', label: 'Garten', labelEn: 'Garden', icon: 'tropfen', testId: 'mnav-garten' },
];

/** Everything else lives behind "Mehr". Warnungen is appended conditionally. */
const MORE: NavTarget[] = [
  { href: '/automatik', label: 'Automatik', labelEn: 'Automation', icon: 'automation', testId: 'mnav-automatik', hint: 'Modus & Regeln', hintEn: 'Mode & rules' },
  { href: '/einstellungen', label: 'Einstellungen', labelEn: 'Settings', icon: 'einstellungen', testId: 'mnav-einstellungen', hint: 'Räume, Quellen, System', hintEn: 'Rooms, sources, system' },
  { href: '/messages', label: 'Nachrichten', labelEn: 'Messages', icon: 'glocke', testId: 'mnav-messages', hint: 'Hinweise & Empfehlungen', hintEn: 'Hints & recommendations' },
  { href: '/hilfe', label: 'Hilfe', labelEn: 'Help', icon: 'frage', testId: 'mnav-hilfe', hint: 'Funktionen erklärt', hintEn: 'Features explained' },
  { href: '/darstellung', label: 'Darstellung', labelEn: 'Appearance', icon: 'pinsel', testId: 'mnav-darstellung', hint: 'Sprache & Design', hintEn: 'Language & design' },
  { href: '/updates', label: 'Updates', labelEn: 'Updates', icon: 'forecast', testId: 'mnav-updates', hint: 'Version & Changelog', hintEn: 'Version & changelog' },
];

const WARN_TARGET: NavTarget = {
  href: '/warnungen', label: 'Warnungen', labelEn: 'Warnings', icon: 'warnung', testId: 'mnav-warnungen',
  hint: 'Aktive Wetterwarnung', hintEn: 'Active weather alert',
};

export interface MobileNavProps {
  currentUrl: string;
  /** Notified after navigation so the shell can sync its active-url state. */
  onNavigate?: (url: string) => void;
}

export function MobileNav(props: MobileNavProps): JSX.Element {
  const [moreOpen, setMoreOpen] = useState(false);
  const alertActive = snapshot.value?.weatherAlert?.active === true;
  const unread = unreadMessages.value;

  // A11y (G2.4): close the "Mehr" sheet on Escape while it is open, and lock
  // background scroll so the sheet feels like a native modal.
  useEffect(() => {
    if (!moreOpen) return undefined;
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
      return undefined;
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMoreOpen(false);
    };
    window.addEventListener('keydown', onKey);
    const prevOverflow = typeof document !== 'undefined' ? document.body.style.overflow : '';
    if (typeof document !== 'undefined') document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      if (typeof document !== 'undefined') document.body.style.overflow = prevOverflow;
    };
  }, [moreOpen]);

  const go = (href: string): void => {
    route(href, true);
    props.onNavigate?.(href);
    setMoreOpen(false);
  };

  const isActive = (href: string): boolean =>
    props.currentUrl === href || (href === '/uebersicht' && props.currentUrl === '/');

  const sheetItems = alertActive ? [WARN_TARGET, ...MORE] : MORE;
  const moreActive = sheetItems.some((m) => isActive(m.href));
  // Badge on the "Mehr" tab when an overflow destination needs attention.
  const moreBadge = (unread > 0 ? unread : 0) + (alertActive ? 1 : 0);

  return (
    <>
      {moreOpen && (
        <div
          class="mobile-more"
          role="dialog"
          aria-modal="true"
          aria-label={t('Mehr', 'More')}
          data-testid="mobile-more-sheet"
        >
          <button
            type="button"
            class="mobile-more__backdrop"
            aria-label={t('Schließen', 'Close')}
            onClick={(): void => setMoreOpen(false)}
          />
          <div class="mobile-more__sheet" role="menu">
            <div class="mobile-more__handle" aria-hidden="true" />
            <div class="mobile-more__head">
              <h2 class="mobile-more__title">{t('Mehr', 'More')}</h2>
              <button
                type="button"
                class="mobile-more__close"
                aria-label={t('Schließen', 'Close')}
                onClick={(): void => setMoreOpen(false)}
              >
                <Icon name="schliessen" size={18} />
              </button>
            </div>

            <div class="mobile-more__grid">
              {sheetItems.map((m) => {
                const active = isActive(m.href);
                const badge = m.href === '/messages' && unread > 0 ? unread : 0;
                return (
                  <button
                    key={m.href}
                    type="button"
                    role="menuitem"
                    class={`mobile-more__item${active ? ' mobile-more__item--active' : ''}`}
                    data-testid={m.testId}
                    aria-current={active ? 'page' : undefined}
                    onClick={(): void => go(m.href)}
                  >
                    <span class="mobile-more__ico">
                      <Icon name={m.icon} size={22} />
                      {badge > 0 && <span class="mobile-more__badge">{badge > 99 ? '99+' : badge}</span>}
                    </span>
                    <span class="mobile-more__text">
                      <span class="mobile-more__lbl">{t(m.label, m.labelEn)}</span>
                      {m.hint !== undefined && (
                        <span class="mobile-more__hint">{t(m.hint, m.hintEn ?? m.hint)}</span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Basis/Experte view toggle — the phone equivalent of the sidebar
                switch (the sidebar is hidden on mobile). */}
            <div class="mobile-more__viewrow">
              <span class="mobile-more__viewlbl">{t('Ansicht', 'View')}</span>
              <div class="mobile-more__seg" role="tablist" aria-label={t('Ansicht', 'View')}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={!expertMode.value}
                  class={`mobile-more__segbtn${!expertMode.value ? ' mobile-more__segbtn--on' : ''}`}
                  onClick={(): void => setExpertMode(false)}
                >
                  {t('Basis', 'Basic')}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={expertMode.value}
                  class={`mobile-more__segbtn${expertMode.value ? ' mobile-more__segbtn--on' : ''}`}
                  onClick={(): void => setExpertMode(true)}
                >
                  {t('Experte', 'Expert')}
                </button>
              </div>
            </div>
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
            <span class="mobile-nav__ico">
              <Icon name={tg.icon} class="mobile-nav__icon" />
            </span>
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
          <span class="mobile-nav__ico">
            <Icon name="mehr" class="mobile-nav__icon" />
            {moreBadge > 0 && <span class="mobile-nav__badge" data-testid="mnav-more-badge">{moreBadge > 99 ? '99+' : moreBadge}</span>}
          </span>
          <span class="mobile-nav__label">{t('Mehr', 'More')}</span>
        </button>
      </nav>
    </>
  );
}
