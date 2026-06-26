/**
 * Heat Shield — German legends for the Automatik-Logik info affordance
 * (predictive-control-dashboard Requirement 17).
 *
 * Plain data (no Preact) so it can be reused by the card and unit-tested.
 * Explains what each FSM mode means and how the Komfort/Hitzeindex 0–10
 * buckets map to a human label.
 */

import type { Mode } from '../../types.js';

/** One-line German explanation per engine mode. */
export const MODE_LEGEND_DE: Record<Mode, string> = {
  NORMAL: 'Normalbetrieb – keine besondere Hitzelage, Rollläden folgen dem Komfort.',
  SUMMER_WATCH: 'Sommer-Beobachtung – erhöhte Aufmerksamkeit, vorausschauendes Verschatten beginnt.',
  ACTIVE_HEAT_PROTECTION: 'Aktiver Hitzeschutz – Räume werden aktiv verschattet, um Aufheizen zu vermeiden.',
  HEATWAVE: 'Hitzewelle – maximaler Schutz, konsequentes Schließen der besonnten Fassaden.',
  NIGHT_COOLING: 'Nachtkühlung – Rollläden öffnen nachts, um kühle Luft hereinzulassen.',
  STORM: 'Sturm – höchste Priorität: Rollläden fahren in die sichere Position.',
  VACATION: 'Urlaub – Anwesenheit wird simuliert, Schutz läuft konservativ weiter.',
  MAINTENANCE: 'Wartung – Automatik pausiert, manuelle Eingriffe haben Vorrang.',
};

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

/** Komfort/Hitzeindex 0–10 buckets (Requirement 17, 8.5). */
export const HEAT_INDEX_BUCKETS: HeatIndexBucket[] = [
  { from: 0, to: 3, label: 'kühl' },
  { from: 3, to: 5, label: 'komfortabel' },
  { from: 5, to: 7, label: 'wärmer' },
  { from: 7, to: 8.5, label: 'warm / belastend' },
  { from: 8.5, to: 10, label: 'kritisch' },
];

/** German label for a heat-index value on the 0–10 scale. */
export function heatIndexLabel(value0to10: number): string {
  const v = Math.max(0, Math.min(10, value0to10));
  for (const b of HEAT_INDEX_BUCKETS) {
    if (v < b.to || (b.to === 10 && v <= 10)) {
      return b.label;
    }
  }
  return 'kritisch';
}
