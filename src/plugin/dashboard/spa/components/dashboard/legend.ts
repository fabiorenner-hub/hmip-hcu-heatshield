/**
 * Heat Shield — bilingual legends for the Automatik-Logik info affordance
 * (predictive-control-dashboard Requirement 17).
 *
 * Plain data (no Preact) so it can be reused by the card and unit-tested.
 * Explains what each FSM mode means and how the Komfort/Hitzeindex 0–10
 * buckets map to a human label.
 *
 * The labels are language-dependent, so they are produced by builder
 * functions that read the reactive `t(de, en)` helper. Call them inside a
 * component render (or memo keyed on `lang`) so the legend re-renders when the
 * language changes.
 */

import { t } from '../../i18n.js';
import type { Mode } from '../../types.js';

/** One-line explanation per engine mode, in the active language. */
export function buildModeLegend(): Record<Mode, string> {
  return {
    NORMAL: t(
      'Normalbetrieb – keine besondere Hitzelage, Rollläden folgen dem Komfort.',
      'Normal operation – no notable heat situation, shutters follow comfort.',
    ),
    SUMMER_WATCH: t(
      'Sommer-Beobachtung – erhöhte Aufmerksamkeit, vorausschauendes Verschatten beginnt.',
      'Summer watch – heightened attention, predictive shading begins.',
    ),
    ACTIVE_HEAT_PROTECTION: t(
      'Aktiver Hitzeschutz – Räume werden aktiv verschattet, um Aufheizen zu vermeiden.',
      'Active heat protection – rooms are actively shaded to prevent heat build-up.',
    ),
    HEATWAVE: t(
      'Hitzewelle – maximaler Schutz, konsequentes Schließen der besonnten Fassaden.',
      'Heatwave – maximum protection, consistently closing the sunlit facades.',
    ),
    NIGHT_COOLING: t(
      'Nachtkühlung – Rollläden öffnen nachts, um kühle Luft hereinzulassen.',
      'Night cooling – shutters open at night to let cool air in.',
    ),
    STORM: t(
      'Sturm – höchste Priorität: Rollläden fahren in die sichere Position.',
      'Storm – highest priority: shutters move to the safe position.',
    ),
    VACATION: t(
      'Urlaub – Anwesenheit wird simuliert, Schutz läuft konservativ weiter.',
      'Vacation – presence is simulated, protection continues conservatively.',
    ),
    MAINTENANCE: t(
      'Wartung – Automatik pausiert, manuelle Eingriffe haben Vorrang.',
      'Maintenance – automation paused, manual interventions take precedence.',
    ),
  };
}

/** Ordered list of modes for a stable legend rendering. */
export const MODE_ORDER: Mode[] = [
  'NORMAL',
  'SUMMER_WATCH',
  'ACTIVE_HEAT_PROTECTION',
  'HEATWAVE',
  'NIGHT_COOLING',
  'STORM',
  'VACATION',
  'MAINTENANCE',
];

export interface HeatIndexBucket {
  /** Inclusive lower bound on the 0–10 scale. */
  from: number;
  /** Exclusive upper bound (inclusive at 10 for the last bucket). */
  to: number;
  label: string;
}

/** Komfort/Hitzeindex 0–10 buckets (Requirement 17, 8.5), in the active language. */
export function buildHeatIndexBuckets(): HeatIndexBucket[] {
  return [
    { from: 0, to: 3, label: t('kühl', 'cool') },
    { from: 3, to: 5, label: t('komfortabel', 'comfortable') },
    { from: 5, to: 7, label: t('wärmer', 'warmer') },
    { from: 7, to: 8.5, label: t('warm / belastend', 'warm / straining') },
    { from: 8.5, to: 10, label: t('kritisch', 'critical') },
  ];
}

/** Label for a heat-index value on the 0–10 scale, in the active language. */
export function heatIndexLabel(value0to10: number): string {
  const v = Math.max(0, Math.min(10, value0to10));
  for (const b of buildHeatIndexBuckets()) {
    if (v < b.to || (b.to === 10 && v <= 10)) {
      return b.label;
    }
  }
  return t('kritisch', 'critical');
}
