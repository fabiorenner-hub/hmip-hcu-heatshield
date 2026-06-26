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
import type { DashboardSnapshot, FacadeKey, RoomDetail } from '../../types.js';

const FACADE_ORDER: FacadeKey[] = ['N', 'E', 'S', 'W'];
const FACADE_LABEL: Record<FacadeKey, string> = { N: 'NORD', E: 'OST', S: 'SÜD', W: 'WEST' };
const TREND_ARROW: Record<RoomDetail['trend'], string> = { up: '↑', down: '↓', flat: '→' };
const STATUS_LABEL: Record<string, string> = {
  recommended: 'empfohlen',
  scheduled: 'geplant',
  executing: 'läuft',
  completed: 'erledigt',
  blocked: 'blockiert',
  manuallyOverridden: 'manuell',
};

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
}): JSX.Element {
  const facades = props.snapshot.facades;
  const rooms = props.snapshot.roomsDetail ?? [];
  const strongest = strongestFacade(facades);

  return (
    <section class="rooms-panel" data-testid="rooms-panel">
      <h2 class="rooms-panel__title">Räume &amp; Fassaden</h2>

      <div class="facade-map" data-testid="facade-map">
        {FACADE_ORDER.map((k) => (
          <div
            key={k}
            class={`facade-tile ${k === strongest ? 'facade--strongest' : ''}`}
            data-facade={k}
            data-strongest={k === strongest ? 'true' : 'false'}
          >
            <span class="facade-tile__dir">{FACADE_LABEL[k]}</span>
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
              <th>Raum</th>
              <th>Fassade</th>
              <th>Rollladen</th>
              <th>Innen</th>
              <th>Trend</th>
              <th>Nächste Aktion</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rooms.length === 0 ? (
              <tr>
                <td colSpan={7} class="rooms-table__empty">warte auf Daten</td>
              </tr>
            ) : (
              rooms.map((r) => (
                <tr key={r.id} data-testid={`room-row-${r.id}`}>
                  <td class="rooms-table__room" title={r.name}>
                    {r.floor !== undefined && r.floor !== '' && (
                      <span class="rooms-table__floor">{r.floor}</span>
                    )}
                    <span class="rooms-table__room-name">{r.name}</span>
                  </td>
                  <td>{FACADE_LABEL[r.facade]}</td>
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
                        title={r.nextAction.reason}
                      >
                        {pct(r.nextAction.targetPercent)} %
                      </span>
                    )}
                  </td>
                  <td>
                    <span class={`status-pill status--${r.status}`}>
                      {STATUS_LABEL[r.status] ?? r.status}
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
