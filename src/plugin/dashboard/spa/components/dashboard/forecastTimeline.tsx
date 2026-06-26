/**
 * Heat Shield — forecast timeline + "Nächste Aktionen" list
 * (predictive-control-dashboard Task 17, Requirement 11).
 *
 * Horizontal cards "Forecast – Nächste 12 Stunden" (now + 2 h steps), each
 * showing the time, a weather icon, temperature, W/m² and cloud/precip %.
 * Below, the planned actions are listed as readable rows — device/room label
 * + target % + relative ETA (e.g. "Süd-Rollläden auf 65 % in 18 min") —
 * colour-coded by category (Beschattung gold / Lüftung grün / Nachtlüftung
 * cyan / Kühlung blau / Warnung rot). Empty → "Keine geplanten Aktionen".
 */

import { Fragment, h, type JSX } from 'preact';

import type {
  DashboardSnapshot,
  FacadeKey,
  ForecastTimelineCard,
  PlannedAction,
  RoomDetail,
} from '../../types.js';
import { t, fmtTime } from '../../i18n.js';

export type ActionCategory = 'shade' | 'vent' | 'nightvent' | 'cool' | 'warn';

/** Classify a planned action into a colour category from its reason text. */
export function actionCategory(action: PlannedAction): ActionCategory {
  const r = action.reason.toLowerCase();
  if (action.state === 'blocked' || r.includes('warn') || r.includes('sturm')) {
    return 'warn';
  }
  if (r.includes('nachtl')) {
    return 'nightvent';
  }
  if (r.includes('lüft') || r.includes('luft')) {
    return 'vent';
  }
  if (r.includes('kühl') || r.includes('kuhl')) {
    return 'cool';
  }
  return 'shade';
}

const FACADE_ADJ: Record<FacadeKey, [de: string, en: string]> = {
  N: ['Nord', 'North'],
  E: ['Ost', 'East'],
  S: ['Süd', 'South'],
  W: ['West', 'West'],
};

function clampPct(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, Math.round(v)));
}

/** Relative ETA from now to a scheduled timestamp (localized). */
export function formatEta(scheduledTs: string, now: Date): string {
  const deltaMs = Date.parse(scheduledTs) - now.getTime();
  if (!Number.isFinite(deltaMs) || deltaMs <= 60_000) {
    return t('jetzt', 'now');
  }
  const totalMin = Math.round(deltaMs / 60_000);
  if (totalMin < 60) {
    return t(`in ${totalMin} min`, `in ${totalMin} min`);
  }
  const hrs = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  return mins === 0 ? t(`in ${hrs} h`, `in ${hrs} h`) : t(`in ${hrs} h ${mins} min`, `in ${hrs} h ${mins} min`);
}

/**
 * Resolve a planned action's window id to a human label. Prefers the room +
 * facade context from `roomsDetail`, then the snapshot window name, then a
 * generic "Rollläden".
 */
export function resolveActionLabel(
  action: PlannedAction,
  rooms: RoomDetail[],
  windows: DashboardSnapshot['windows'],
): string {
  const room = rooms.find((r) => r.nextAction?.windowId === action.windowId);
  if (room !== undefined) {
    const [de, en] = FACADE_ADJ[room.facade];
    return t(`${de}-Rollläden (${room.name})`, `${en} shutters (${room.name})`);
  }
  const win = windows.find((w) => w.id === action.windowId);
  if (win?.name !== undefined && win.name.length > 0) {
    return win.name;
  }
  return t('Rollläden', 'Shutters');
}

export function ForecastTimeline(props: {
  snapshot: DashboardSnapshot;
  now?: Date;
  /** Forecast horizon in hours (cards beyond this are hidden). Default 12. */
  hours?: number;
  /** Whether to render the "Nächste Aktionen" list below the cards. Default true. */
  showActions?: boolean;
  /** Heading prefix before "– Nächste N Stunden". Default "Forecast". */
  titlePrefix?: string;
}): JSX.Element {
  const now = props.now ?? new Date();
  const horizonH = props.hours ?? 12;
  const showActions = props.showActions ?? true;
  const titlePrefix = props.titlePrefix ?? 'Forecast';
  const allCards: ForecastTimelineCard[] = props.snapshot.forecastTimeline ?? [];
  const horizonMs = now.getTime() + horizonH * 3_600_000 + 60_000;
  const cards = allCards.filter((c, i) => i === 0 || Date.parse(c.ts) <= horizonMs);
  const actions: PlannedAction[] = props.snapshot.plannedActions ?? [];
  const rooms = props.snapshot.roomsDetail ?? [];
  const windows = props.snapshot.windows ?? [];

  // Stable chronological order for the action list.
  const sortedActions = [...actions].sort(
    (a, b) => Date.parse(a.scheduledTs) - Date.parse(b.scheduledTs),
  );

  return (
    <section class="forecast-timeline" data-testid="forecast-timeline">
      <h2 class="forecast-timeline__title">
        {titlePrefix} – {t(`Nächste ${horizonH} Stunden`, `Next ${horizonH} hours`)}
      </h2>
      {cards.length === 0 ? (
        <p class="forecast-timeline__empty">{t('warte auf Daten', 'waiting for data')}</p>
      ) : (
        <div class="forecast-timeline__track">
          {cards.map((c, i) => (
            <div
              key={c.ts}
              class={`forecast-card ${i === 0 ? 'forecast-card--now' : ''}`}
              data-testid={i === 0 ? 'forecast-card-now' : `forecast-card-${i}`}
            >
              <span class="forecast-card__time">{i === 0 ? t('Jetzt', 'Now') : fmtTime(c.ts)}</span>
              <span class="forecast-card__icon" aria-hidden="true">{c.weatherIcon}</span>
              <span class="forecast-card__temp">{Math.round(c.tempC)} °C</span>
              <span class="forecast-card__rad">{Math.round(c.radiationWm2)} W/m²</span>
              <span class="forecast-card__cloud">
                {Math.round(c.precipitationOrCloud01 * 100)} %
              </span>
            </div>
          ))}
        </div>
      )}

      {showActions && (
        <Fragment>
          <h3 class="forecast-timeline__subtitle">{t('Nächste Aktionen', 'Next actions')}</h3>
          <div class="next-actions" data-testid="next-actions">
            {sortedActions.length === 0 ? (
              <p class="next-actions__empty">{t('Keine geplanten Aktionen', 'No planned actions')}</p>
            ) : (
              <ul class="next-actions__list">
                {sortedActions.map((a) => {
                  const cat = actionCategory(a);
                  const label = resolveActionLabel(a, rooms, windows);
                  return (
                    <li
                      key={`${a.windowId}-${a.scheduledTs}`}
                      class={`action-row action--${cat}`}
                      data-testid="action-chip"
                      data-category={cat}
                      title={a.reason}
                    >
                      <span class="action-row__dot" aria-hidden="true" />
                      <span class="action-row__text">
                        {label} {t('auf', 'to')} {clampPct(a.targetPercent)} %
                      </span>
                      <span class="action-row__eta">{formatEta(a.scheduledTs, now)}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </Fragment>
      )}
    </section>
  );
}
