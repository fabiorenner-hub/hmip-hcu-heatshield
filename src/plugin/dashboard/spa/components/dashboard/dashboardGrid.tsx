/**
 * Heat Shield — three-column dashboard grid (predictive-control-dashboard
 * Task 13, Requirement 6). Columns: 218px KPI rail / 1fr center / 443px
 * analysis rail. Houses the "Beschattung" module content.
 *
 * Sun-arc + timeline scrubbing state lives here: dragging either sets
 * `scrubAt`, which re-renders the twin + overlays + the 12 h shutter preview
 * for the simulated instant. It NEVER calls a control endpoint
 * (Requirement 10.4 / Property 18) — only local recompute.
 */

import { h, type JSX } from 'preact';
import { useState } from 'preact/hooks';
import { route } from 'preact-router';

import { AnalysisRail } from './analysisRail.js';
import { ForecastTimeline } from './forecastTimeline.js';
import { HouseDigitalTwin } from './houseDigitalTwin.js';
import { LiveMetricsRail } from './liveMetricsRail.js';
import { RoomsAndFacadesPanel } from './roomsAndFacadesPanel.js';
import { riskBreakdowns } from '../../store.js';
import { t } from '../../i18n.js';
import type { DashboardSnapshot } from '../../types.js';

export interface DashboardGridProps {
  snapshot: DashboardSnapshot | null;
  latitude: number;
  longitude: number;
  now?: Date;
}

export function DashboardGrid(props: DashboardGridProps): JSX.Element {
  const now = props.now ?? new Date();
  const [scrubAt, setScrubAt] = useState<Date | null>(null);

  if (props.snapshot === null) {
    return (
      <div class="dashboard-grid dashboard-grid--loading" data-testid="dashboard-grid">
        <div class="dashboard-skeleton" aria-hidden="true">
          <div class="skeleton skeleton--rail" />
          <div class="dashboard-skeleton__center">
            <div class="skeleton skeleton--twin" />
            <div class="skeleton skeleton--bar" />
            <div class="skeleton skeleton--cards" />
          </div>
          <div class="skeleton skeleton--rail" />
        </div>
        <p class="dashboard-grid__loading" role="status">
          {t('warte auf Daten …', 'waiting for data …')}
        </p>
      </div>
    );
  }
  const snapshot = props.snapshot;
  const risk = riskBreakdowns.value;
  const noRooms = (snapshot.roomsDetail ?? []).length === 0;

  if (noRooms) {
    return (
      <div class="dashboard-grid dashboard-grid--onboarding" data-testid="dashboard-grid">
        <OnboardingCard />
      </div>
    );
  }

  return (
    <div class="dashboard-grid" data-testid="dashboard-grid">
      <div class="dashboard-grid__col dashboard-grid__col--left" data-testid="grid-col-left">
        <LiveMetricsRail
          snapshot={snapshot}
          latitude={props.latitude}
          longitude={props.longitude}
          now={now}
        />
      </div>

      <div class="dashboard-grid__col dashboard-grid__col--center" data-testid="grid-col-center">
        <HouseDigitalTwin
          snapshot={snapshot}
          latitude={props.latitude}
          longitude={props.longitude}
          now={now}
          scrubAt={scrubAt}
          onScrub={(t): void => setScrubAt(t)}
          riskByWindow={risk}
        />
        {scrubAt !== null && (
          <button
            type="button"
            class="scrub-reset"
            data-testid="scrub-reset"
            onClick={(): void => setScrubAt(null)}
          >
            {t('Zurück zu „Jetzt“', 'Back to “Now”')}
          </button>
        )}
        <ForecastTimeline snapshot={snapshot} now={now} />
        <RoomsAndFacadesPanel snapshot={snapshot} />
      </div>

      <div class="dashboard-grid__col dashboard-grid__col--right" data-testid="grid-col-right">
        <AnalysisRail snapshot={snapshot} now={now} />
      </div>
    </div>
  );
}

/**
 * First-run empty state shown until at least one room is configured. Guides
 * the user through the three setup steps with deep links into the relevant
 * tabs, instead of presenting empty panels.
 */
function OnboardingCard(): JSX.Element {
  return (
    <section class="onboarding" data-testid="onboarding">
      <div class="onboarding__card">
        <div class="onboarding__badge" aria-hidden="true">
          🛡️
        </div>
        <h1 class="onboarding__title">{t('Willkommen bei Heat Shield', 'Welcome to Heat Shield')}</h1>
        <p class="onboarding__lead">
          {t(
            'Vorausschauender Hitzeschutz für deine Rollläden. In drei Schritten ist alles eingerichtet – danach übernimmt die Automatik.',
            'Predictive heat protection for your shutters. Everything is set up in three steps – then the automation takes over.',
          )}
        </p>
        <ol class="onboarding__steps">
          <li class="onboarding__step">
            <span class="onboarding__step-num">1</span>
            <div class="onboarding__step-body">
              <span class="onboarding__step-title">{t('Quellen verbinden', 'Connect sources')}</span>
              <span class="onboarding__step-text">
                {t('Wetter, PV und HmIP-Geräte erkennen lassen.', 'Let weather, PV and HmIP devices be detected.')}
              </span>
              <button
                type="button"
                class="onboarding__btn"
                onClick={(): void => {
                  route('/sources');
                }}
              >
                {t('Quellen öffnen', 'Open sources')}
              </button>
            </div>
          </li>
          <li class="onboarding__step">
            <span class="onboarding__step-num">2</span>
            <div class="onboarding__step-body">
              <span class="onboarding__step-title">{t('Räume & Fenster anlegen', 'Add rooms & windows')}</span>
              <span class="onboarding__step-text">
                {t('Räume mit Ausrichtung und Rollläden zuordnen.', 'Assign rooms with orientation and shutters.')}
              </span>
              <button
                type="button"
                class="onboarding__btn"
                onClick={(): void => {
                  route('/rooms');
                }}
              >
                {t('Räume anlegen', 'Add rooms')}
              </button>
            </div>
          </li>
          <li class="onboarding__step">
            <span class="onboarding__step-num">3</span>
            <div class="onboarding__step-body">
              <span class="onboarding__step-title">{t('Geführte Einrichtung', 'Guided setup')}</span>
              <span class="onboarding__step-text">
                {t('Alles auf einmal mit dem Assistenten erledigen.', 'Do everything at once with the wizard.')}
              </span>
              <button
                type="button"
                class="onboarding__btn onboarding__btn--primary"
                onClick={(): void => {
                  route('/wizard');
                }}
              >
                {t('Assistent starten', 'Start wizard')}
              </button>
            </div>
          </li>
        </ol>
      </div>
    </section>
  );
}
