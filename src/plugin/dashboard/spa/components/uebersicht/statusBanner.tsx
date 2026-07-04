/**
 * Heat Shield — Übersicht StatusBanner (uebersicht-rework, Task 4).
 *
 * The protection/safety status line. Slim when all is well; prominent for a
 * storm hold or an active severe-weather alert (safety precedence). Also
 * surfaces an HCU-disconnected and a CONFIG_REQUIRED state with a deep link.
 * Pure/presentational: reads the passed snapshot only.
 */

import { h, type JSX } from 'preact';
import { route } from 'preact-router';

import { t } from '../../i18n.js';
import { Icon } from '../icons.js';
import type { DashboardSnapshot } from '../../types.js';
import { dataAgeMinutes, isStormActive, primaryHeadline } from './uebersichtModel.js';

const HEADLINE_TEXT: Record<string, [string, string]> = {
  storm: ['Sturmschutz aktiv — Rollläden in Sicherheit', 'Storm protection active — shutters moved to safety'],
  alert: ['Unwetterwarnung aktiv', 'Severe-weather warning active'],
  heat: ['Hitzeschutz aktiv — Räume werden vorausschauend beschattet', 'Heat protection active — rooms are shaded predictively'],
  night: ['Nachtkühlung läuft', 'Night cooling in progress'],
  summer: ['Sommer im Blick — noch kein Hitzestress', 'Watching summer — no heat stress yet'],
  calm: ['Alles im grünen Bereich', 'All clear'],
};

function ageLabel(snap: DashboardSnapshot): string {
  const age = dataAgeMinutes(snap.ts);
  if (age === null) return '–';
  if (age < 1) return t('aktuell', 'live');
  return t(`vor ${age} min`, `${age} min ago`);
}

export function StatusBanner(props: { snapshot: DashboardSnapshot }): JSX.Element {
  const snap = props.snapshot;
  const head = primaryHeadline(snap);
  const [de, en] = HEADLINE_TEXT[head.key] ?? HEADLINE_TEXT['calm']!;
  const storm = isStormActive(snap);
  const hcuDown = snap.sources?.hcu?.connected === false;
  const configRequired = snap.pluginReadiness === 'CONFIG_REQUIRED';

  return (
    <section
      class={`hs-status hs-status--${head.tone}${storm ? ' hs-status--storm' : ''}`}
      data-testid="status-banner"
      data-tone={head.tone}
      role={head.tone === 'alert' ? 'alert' : 'status'}
    >
      <span class="hs-status__lead">
        <Icon name={head.tone === 'alert' ? 'warnung' : 'logo'} size={20} class="hs-status__icon" />
        <span class="hs-status__title">{t(de, en)}</span>
      </span>

      <span class="hs-status__meta">
        {configRequired ? (
          <button
            type="button"
            class="hs-status__action"
            data-testid="status-config-required"
            onClick={(): void => {
              route('/wizard');
            }}
          >
            {t('Einrichtung abschließen', 'Finish setup')}
          </button>
        ) : hcuDown ? (
          <span class="hs-status__warn" data-testid="status-hcu-down">
            {t('HCU nicht verbunden — letzter bekannter Stand', 'HCU disconnected — last known state')}
          </span>
        ) : (
          <span class="hs-status__hcu" data-testid="status-hcu-ok">
            {t('HCU verbunden', 'HCU connected')}
          </span>
        )}
        <span class="hs-status__age" data-testid="status-age">
          {t('Datenstand', 'Data')}: {ageLabel(snap)}
        </span>
        {snap.weatherAlert?.active === true && (
          <button
            type="button"
            class="hs-status__action hs-status__action--alert"
            data-testid="status-open-warnings"
            onClick={(): void => {
              route('/warnungen');
            }}
          >
            {t('Warnung ansehen', 'View warning')}
          </button>
        )}
      </span>
    </section>
  );
}
