/**
 * Heat Shield — rooms & facades panel (predictive-control-dashboard Task 18,
 * Requirement 12).
 *
 * A facade-exposure tile row (clean "OST 73 %" cards, strongest highlighted)
 * plus a room table: room, facade, shutter % + bar, indoor temp, trend arrow,
 * next action and status. The table is width-constrained (table-layout:fixed +
 * a min-width:0 scroll wrapper) so it can never slide under the right rail.
 */

import { h, type JSX } from 'preact';

import { actionCategory } from './forecastTimeline.js';
import { t, tServer } from '../../i18n.js';
import type { DashboardSnapshot, FacadeKey, RoomDetail } from '../../types.js';

const FACADE_ORDER: FacadeKey[] = ['N', 'E', 'S', 'W'];
const FACADE_LABEL_DE: Record<FacadeKey, string> = { N: 'NORD', E: 'OST', S: 'SÜD', W: 'WEST' };
const FACADE_LABEL_EN: Record<FacadeKey, string> = { N: 'NORTH', E: 'EAST', S: 'SOUTH', W: 'WEST' };
const TREND_ARROW: Record<RoomDetail['trend'], string> = { up: '↑', down: '↓', flat: '→' };

/** Bilingual facade label (Nord/Ost/Süd/West → North/East/South/West). */
function facadeLabel(k: FacadeKey): string {
  return t(FACADE_LABEL_DE[k], FACADE_LABEL_EN[k]);
}

const STATUS_LABEL_DE: Record<string, string> = {
  recommended: 'empfohlen',
  scheduled: 'geplant',
  executing: 'läuft',
  completed: 'erledigt',
  blocked: 'blockiert',
  manuallyOverridden: 'manuell',
};
const STATUS_LABEL_EN: Record<string, string> = {
  recommended: 'recommended',
  scheduled: 'scheduled',
  executing: 'running',
  completed: 'done',
  blocked: 'blocked',
  manuallyOverridden: 'manual',
};

/** Bilingual planned-action status label. */
function statusLabel(status: string): string {
  const de = STATUS_LABEL_DE[status];
  const en = STATUS_LABEL_EN[status];
  return de !== undefined && en !== undefined ? t(de, en) : status;
}

/** Clamp a percent into a sane 0–100 integer for display. */
function pct(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, Math.round(v)));
}

/**
 * Determine the strongest facade with a deterministic tie-break
 * (N→E→S→W order). Property 17.
 */
export function strongestFacade(facades?: {
  N: number;
  E: number;
  S: number;
  W: number;
}): FacadeKey | null {
  if (facades === undefined) {
    return null;
  }
  let best: FacadeKey = 'N';
  for (const k of FACADE_ORDER) {
    if (facades[k] > facades[best]) {
      best = k;
    }
  }
  return best;
}

export function RoomsAndFacadesPanel(props: {
  snapshot: DashboardSnapshot;
  /** When provided, room rows become clickable and call this with the room id. */
  onSelectRoom?: (roomId: string) => void;
}): JSX.Element {
  const facades = props.snapshot.facades;
  const rooms = props.snapshot.roomsDetail ?? [];
  const strongest = strongestFacade(facades);
  const selectable = props.onSelectRoom !== undefined;

  return (
    <section class="rooms-panel" data-testid="rooms-panel">
      <h2 class="rooms-panel__title">{t('Räume & Fassaden', 'Rooms & facades')}</h2>

      <div class="facade-map" data-testid="facade-map">
        {FACADE_ORDER.map((k) => (
          <div
            key={k}
            class={`facade-tile ${k === strongest ? 'facade--strongest' : ''}`}
            data-facade={k}
            data-strongest={k === strongest ? 'true' : 'false'}
          >
            <span class="facade-tile__dir">{facadeLabel(k)}</span>
            <span class="facade-tile__pct">{facades ? `${pct(facades[k])} %` : '– %'}</span>
          </div>
        ))}
      </div>

      <div class="rooms-table-wrap">
        <table class="rooms-table" data-testid="rooms-table">
          <colgroup>
            <col class="rooms-table__col-room" />
            <col class="rooms-table__col-facade" />
            <col class="rooms-table__col-shutter" />
            <col class="rooms-table__col-temp" />
            <col class="rooms-table__col-trend" />
            <col class="rooms-table__col-action" />
            <col class="rooms-table__col-status" />
          </colgroup>
          <thead>
            <tr>
              <th>{t('Raum', 'Room')}</th>
              <th>{t('Fassade', 'Facade')}</th>
              <th>{t('Rollladen', 'Shutter')}</th>
              <th>{t('Innen', 'Indoor')}</th>
              <th>{t('Trend', 'Trend')}</th>
              <th>{t('Nächste Aktion', 'Next action')}</th>
              <th>{t('Status', 'Status')}</th>
            </tr>
          </thead>
          <tbody>
            {rooms.length === 0 ? (
              <tr>
                <td colSpan={7} class="rooms-table__empty">{t('warte auf Daten', 'waiting for data')}</td>
              </tr>
            ) : (
              rooms.map((r) => (
                <tr
                  key={r.id}
                  data-testid={`room-row-${r.id}`}
                  class={selectable ? 'rooms-table__row--clickable' : undefined}
                  {...(selectable
                    ? {
                        role: 'button',
                        tabIndex: 0,
                        'aria-label': r.name,
                        onClick: (): void => props.onSelectRoom?.(r.id),
                        onKeyDown: (e: KeyboardEvent): void => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            props.onSelectRoom?.(r.id);
                          }
                        },
                      }
                    : {})}
                >
                  <td class="rooms-table__room" title={r.name}>
                    {r.floor !== undefined && r.floor !== '' && (
                      <span class="rooms-table__floor">{r.floor}</span>
                    )}
                    <span class="rooms-table__room-name">{r.name}</span>
                  </td>
                  <td>{facadeLabel(r.facade)}</td>
                  <td>
                    <div class="shutter-bar" data-testid="shutter-bar">
                      <div
                        class="shutter-bar__fill"
                        style={{ width: `${pct(r.shutterPercent)}%` }}
                      />
                      <span class="shutter-bar__pct">{pct(r.shutterPercent)} %</span>
                    </div>
                  </td>
                  <td>{r.indoorTempC === null ? '–' : `${r.indoorTempC} °C`}</td>
                  <td class={`trend trend--${r.trend}`} data-testid="trend-arrow">
                    {TREND_ARROW[r.trend]}
                  </td>
                  <td>
                    {r.nextAction === null ? (
                      <span class="rooms-table__noaction">–</span>
                    ) : (
                      <span
                        class={`action-chip action--${actionCategory(r.nextAction)}`}
                        data-category={actionCategory(r.nextAction)}
                        title={tServer(r.nextAction.reason)}
                      >
                        {pct(r.nextAction.targetPercent)} %
                      </span>
                    )}
                  </td>
                  <td>
                    <span class={`status-pill status--${r.status}`}>
                      {statusLabel(r.status)}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
