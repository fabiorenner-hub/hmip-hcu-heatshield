/**
 * Heat Shield dashboard — global data-freshness / offline chip
 * (Blueprint Phase 3 / Phase 9: "Datenfrische und Offlinezustand global und
 * unaufdringlich").
 *
 * Reads the shared snapshot signal only: shows the HCU connection state and how
 * old the latest snapshot is. Shell-agnostic (renders in the header for all
 * shells). Pure/presentational.
 */

import { h, type JSX } from 'preact';

import { snapshot } from '../../store.js';
import { t } from '../../i18n.js';

/** Age (minutes) at/after which the snapshot counts as stale. */
const STALE_MINUTES = 10;

export function FreshnessChip(): JSX.Element | null {
  const snap = snapshot.value;
  if (snap === null) return null;

  const connected = snap.sources?.hcu?.connected !== false;
  const tsMs = Date.parse(snap.ts);
  const ageMin = Number.isFinite(tsMs)
    ? Math.max(0, Math.round((Date.now() - tsMs) / 60000))
    : null;
  const stale = ageMin !== null && ageMin >= STALE_MINUTES;
  const state: 'offline' | 'stale' | 'fresh' = !connected
    ? 'offline'
    : stale
      ? 'stale'
      : 'fresh';

  const label = !connected
    ? t('Offline', 'Offline')
    : ageMin === null
      ? '—'
      : ageMin < 1
        ? t('aktuell', 'live')
        : t(`vor ${ageMin} min`, `${ageMin} min ago`);

  return (
    <span
      class={`freshness freshness--${state}`}
      data-testid="freshness-chip"
      data-state={state}
      title={t('Datenfrische und Verbindung', 'Data freshness and connection')}
    >
      <span class="freshness__dot" aria-hidden="true" />
      <span class="freshness__label">{label}</span>
    </span>
  );
}
