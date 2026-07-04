/**
 * Heat Shield — Übersicht onboarding (uebersicht-rework, Task 12).
 *
 * First-run empty state shown until at least one room is configured. Guides the
 * three setup steps with deep links instead of empty panels. Uses inline SVG
 * icons (no emoji) per the premium design baseline.
 */

import { h, type JSX } from 'preact';
import { route } from 'preact-router';

import { t } from '../../i18n.js';
import { Icon } from '../icons.js';

interface Step {
  num: number;
  titleDe: string;
  titleEn: string;
  textDe: string;
  textEn: string;
  ctaDe: string;
  ctaEn: string;
  href: string;
  primary?: boolean;
}

const STEPS: Step[] = [
  {
    num: 1,
    titleDe: 'Quellen verbinden',
    titleEn: 'Connect sources',
    textDe: 'Wetter, PV und HmIP-Geräte erkennen lassen.',
    textEn: 'Let weather, PV and HmIP devices be detected.',
    ctaDe: 'Quellen öffnen',
    ctaEn: 'Open sources',
    href: '/sources',
  },
  {
    num: 2,
    titleDe: 'Räume & Fenster anlegen',
    titleEn: 'Add rooms & windows',
    textDe: 'Räume mit Ausrichtung und Rollläden zuordnen.',
    textEn: 'Assign rooms with orientation and shutters.',
    ctaDe: 'Räume anlegen',
    ctaEn: 'Add rooms',
    href: '/rooms',
  },
  {
    num: 3,
    titleDe: 'Geführte Einrichtung',
    titleEn: 'Guided setup',
    textDe: 'Alles auf einmal mit dem Assistenten erledigen.',
    textEn: 'Do everything at once with the wizard.',
    ctaDe: 'Assistent starten',
    ctaEn: 'Start wizard',
    href: '/wizard',
    primary: true,
  },
];

export function OverviewOnboarding(): JSX.Element {
  return (
    <section class="hs-onboarding" data-testid="onboarding">
      <div class="hs-onboarding__card">
        <Icon name="logo" size={40} class="hs-onboarding__badge" />
        <h1 class="hs-onboarding__title">{t('Willkommen bei Heat Shield', 'Welcome to Heat Shield')}</h1>
        <p class="hs-onboarding__lead">
          {t(
            'Vorausschauender Hitzeschutz für deine Rollläden. In drei Schritten ist alles eingerichtet – danach übernimmt die Automatik.',
            'Predictive heat protection for your shutters. Everything is set up in three steps – then the automation takes over.',
          )}
        </p>
        <ol class="hs-onboarding__steps">
          {STEPS.map((s) => (
            <li key={s.num} class="hs-onboarding__step">
              <span class="hs-onboarding__step-num">{s.num}</span>
              <div class="hs-onboarding__step-body">
                <span class="hs-onboarding__step-title">{t(s.titleDe, s.titleEn)}</span>
                <span class="hs-onboarding__step-text">{t(s.textDe, s.textEn)}</span>
                <button
                  type="button"
                  class={`hs-onboarding__btn${s.primary === true ? ' hs-onboarding__btn--primary' : ''}`}
                  data-testid={`onboarding-cta-${s.num}`}
                  onClick={(): void => {
                    route(s.href);
                  }}
                >
                  {t(s.ctaDe, s.ctaEn)}
                </button>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
