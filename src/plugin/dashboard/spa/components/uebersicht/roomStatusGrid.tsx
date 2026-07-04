/**
 * Heat Shield — Übersicht RoomStatusGrid (uebersicht-rework, Task 10).
 *
 * One ampel card per room: name, tone (dot + text, never colour alone),
 * temperature, trend, shutter position and window state. Clicking a card
 * deep-links to /raeume. An unbound sensor shows a hint instead of a
 * fabricated temperature. Pure/presentational.
 */

import { h, type JSX } from 'preact';
import { route } from 'preact-router';

import { t, fmtNum } from '../../i18n.js';
import { StatusDot } from './primitives.js';
import { roomStatuses, type RoomStatusVM, type RoomTone } from './uebersichtModel.js';
import type { DashboardSnapshot } from '../../types.js';

const TONE_LABEL: Record<RoomTone, [string, string]> = {
  ok: ['komfortabel', 'comfortable'],
  warm: ['wird warm', 'getting warm'],
  hot: ['heiß', 'hot'],
  unknown: ['keine Daten', 'no data'],
};

const TREND_GLYPH: Record<'up' | 'down' | 'flat', string> = { up: '↑', down: '↓', flat: '→' };

function tempText(vm: RoomStatusVM): string {
  if (vm.unbound || vm.tempC === null || !Number.isFinite(vm.tempC)) return '–';
  return `${fmtNum(Math.round(vm.tempC * 10) / 10, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} °C`;
}

function RoomStatusCard(props: { room: RoomStatusVM }): JSX.Element {
  const r = props.room;
  const open = (): void => {
    route('/raeume');
  };
  return (
    <button
      type="button"
      class={`hs-room hs-room--${r.tone}`}
      data-testid={`room-status-${r.id}`}
      data-tone={r.tone}
      onClick={open}
    >
      <span class="hs-room__head">
        <span class="hs-room__name">{r.name}</span>
        <StatusDot state={r.tone} label={t(...TONE_LABEL[r.tone])} />
      </span>
      <span class="hs-room__temp" data-testid={`room-temp-${r.id}`}>
        {tempText(r)}
        <span class={`hs-room__trend hs-room__trend--${r.trend}`} aria-hidden="true">
          {TREND_GLYPH[r.trend]}
        </span>
      </span>
      <span class="hs-room__foot">
        <span class="hs-room__shutter">
          {t('Rollladen', 'Shutter')} {Math.round(r.shutterPercent)} %
        </span>
        {r.windowOpen && <span class="hs-room__window">{t('Fenster offen', 'Window open')}</span>}
        {r.unbound && (
          <span class="hs-room__hint" data-testid={`room-unbound-${r.id}`}>
            {t('Sensor nicht zugeordnet', 'Sensor unassigned')}
          </span>
        )}
        {r.stale && !r.unbound && (
          <span class="hs-room__hint">{t('Messwert veraltet', 'Reading stale')}</span>
        )}
      </span>
    </button>
  );
}

export function RoomStatusGrid(props: { snapshot: DashboardSnapshot }): JSX.Element {
  const rooms = roomStatuses(props.snapshot);
  return (
    <section class="hs-rooms" data-testid="room-status-grid">
      <header class="hs-rooms__head">
        <h2 class="hs-rooms__title">{t('Räume', 'Rooms')}</h2>
      </header>
      <div class="hs-rooms__grid">
        {rooms.map((r) => (
          <RoomStatusCard key={r.id} room={r} />
        ))}
      </div>
    </section>
  );
}
