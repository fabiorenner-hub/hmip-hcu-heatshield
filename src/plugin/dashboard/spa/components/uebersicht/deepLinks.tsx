/**
 * Heat Shield — Übersicht deep links (uebersicht-rework, Task 11).
 *
 * Consistent jump-off points to the specialist tabs. The Warnungen link only
 * appears while a severe-weather alert is active. Pure/presentational.
 */

import { h, type JSX } from 'preact';
import { route } from 'preact-router';

import { t } from '../../i18n.js';
import { Icon, type IconName } from '../icons.js';

interface DeepLink {
  href: string;
  de: string;
  en: string;
  icon: IconName;
  testId: string;
}

const LINKS: DeepLink[] = [
  { href: '/raeume', de: 'Räume', en: 'Rooms', icon: 'thermometer', testId: 'deep-raeume' },
  { href: '/vorhersage', de: 'Vorhersage', en: 'Forecast', icon: 'forecast', testId: 'deep-vorhersage' },
  { href: '/automatik', de: 'Automatik', en: 'Automation', icon: 'automation', testId: 'deep-automatik' },
];

export function OverviewDeepLinks(props: { showWarnings: boolean }): JSX.Element {
  const links = props.showWarnings
    ? [...LINKS, { href: '/warnungen', de: 'Warnungen', en: 'Warnings', icon: 'warnung' as IconName, testId: 'deep-warnungen' }]
    : LINKS;
  return (
    <nav class="hs-deeplinks" data-testid="overview-deeplinks" aria-label={t('Weiter zu', 'Continue to')}>
      {links.map((l) => (
        <button
          key={l.href}
          type="button"
          class="hs-deeplink"
          data-testid={l.testId}
          onClick={(): void => {
            route(l.href);
          }}
        >
          <Icon name={l.icon} size={20} class="hs-deeplink__icon" />
          <span class="hs-deeplink__label">{t(l.de, l.en)}</span>
        </button>
      ))}
    </nav>
  );
}
