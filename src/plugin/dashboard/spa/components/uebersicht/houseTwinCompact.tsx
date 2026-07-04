/**
 * Heat Shield — Übersicht HouseTwinCompact (uebersicht-rework, Task 7).
 *
 * A compact wrapper around the existing {@link HouseDigitalTwin}. Keeps the
 * sun-arc + rooms and the scrub interaction (which only recomputes a local
 * preview — never a control call), plus a "back to now" reset. On phones the
 * underlying twin already collapses to a room list.
 */

import { h, type JSX } from 'preact';

import { t } from '../../i18n.js';
import { HouseDigitalTwin } from '../dashboard/houseDigitalTwin.js';
import { riskBreakdowns } from '../../store.js';
import type { DashboardSnapshot } from '../../types.js';

export function HouseTwinCompact(props: {
  snapshot: DashboardSnapshot;
  latitude: number;
  longitude: number;
  now?: Date;
  scrubAt: Date | null;
  onScrub: (t: Date | null) => void;
}): JSX.Element {
  const now = props.now ?? new Date();
  return (
    <section class="hs-twin" data-testid="house-twin-compact">
      <HouseDigitalTwin
        snapshot={props.snapshot}
        latitude={props.latitude}
        longitude={props.longitude}
        now={now}
        scrubAt={props.scrubAt}
        onScrub={(tSim): void => props.onScrub(tSim)}
        riskByWindow={riskBreakdowns.value}
      />
      {props.scrubAt !== null && (
        <button
          type="button"
          class="hs-twin__reset"
          data-testid="twin-scrub-reset"
          onClick={(): void => props.onScrub(null)}
        >
          {t('Zurück zu „Jetzt“', 'Back to “now”')}
        </button>
      )}
    </section>
  );
}
