/**
 * Heat Shield — "Räume" primary view (Blueprint IA, Phase 3/5-lite).
 *
 * The blueprint's fifth primary destination. It bundles everything room-centric
 * that used to live in separate tabs so nothing is lost when the IA moves to the
 * blueprint scheme:
 *   1. Room + facade comparison (reused `RoomsAndFacadesPanel`).
 *   2. Ventilation recommendation per room (formerly the "Lüftung" tab).
 *   3. Climate / active-cooling recommendation (formerly the "Klima" tab).
 *
 * Pure/presentational: reads the shared snapshot signal only. A full master/
 * detail room view with per-room forecast charts is Phase 5 proper; this view
 * is the function-preserving consolidation that the new IA needs today.
 */

import { h, type JSX } from 'preact';
import { useState } from 'preact/hooks';

import { RoomsAndFacadesPanel } from '../components/dashboard/roomsAndFacadesPanel.js';
import { RoomDetailModal } from '../components/dashboard/roomDetailModal.js';
import { TrendCard } from '../components/dashboard/trendCard.js';
import { snapshot, riskBreakdowns } from '../store.js';
import { t, tServer } from '../i18n.js';

interface RoutableProps {
  path?: string;
  default?: boolean;
}

function VentilationSection(): JSX.Element | null {
  const snap = snapshot.value;
  if (snap === null) return null;
  const windows = snap.windows ?? [];
  const openWindows = windows.filter(
    (w) => w.currentLevel01 !== null && w.currentLevel01 < 0.95,
  );
  const outdoor = snap.signals?.outdoorTemp?.value ?? null;
  const indoorTemps = (snap.rooms ?? [])
    .map((r) => r.tempC)
    .filter((v): v is number => v !== null && Number.isFinite(v));
  const indoorAvg =
    indoorTemps.length > 0
      ? Math.round((indoorTemps.reduce((a, b) => a + b, 0) / indoorTemps.length) * 10) / 10
      : null;
  const delta =
    indoorAvg !== null && outdoor !== null ? Math.round((indoorAvg - outdoor) * 10) / 10 : null;
  const vent = snap.ventilation;
  const actionRooms = (vent?.rooms ?? []).filter(
    (r) => r.level === 'air_now' || r.level === 'close_window' || r.level === 'air_possible',
  );

  return (
    <section class="rooms-section" data-testid="raeume-ventilation">
      <h2 class="rooms-section__title">{t('Lüftung', 'Ventilation')}</h2>
      {vent !== undefined && (
        <div
          class={`vent-advice vent-advice--${vent.overall.level}`}
          data-testid="vent-overall"
          data-level={vent.overall.level}
        >
          <span class="vent-advice__headline">{tServer(vent.overall.headline)}</span>
          <span class="vent-advice__detail">{tServer(vent.overall.detail)}</span>
        </div>
      )}
      <div class="module-panel__cards">
        <article class="module-panel__card" data-testid="lueftung-windows">
          <h3>{t('Fenster & Rollläden', 'Windows & shutters')}</h3>
          <p class="module-panel__metric">
            {openWindows.length}/{windows.length} {t('geöffnet', 'open')}
          </p>
        </article>
        <article class="module-panel__card" data-testid="lueftung-delta">
          <h3>{t('Temperatur-Differenz', 'Temperature difference')}</h3>
          <p class="module-panel__metric">
            {delta === null ? '–' : `${delta > 0 ? '+' : ''}${delta} K`}
          </p>
          <p class="module-panel__hint">
            {t('Innen', 'Indoor')} {indoorAvg === null ? '–' : `${indoorAvg} °C`} ·{' '}
            {t('Außen', 'Outdoor')} {outdoor === null ? '–' : `${Math.round(outdoor * 10) / 10} °C`}
          </p>
        </article>
        <TrendCard title={t('Verlauf · Innen & Außen', 'History · indoor & outdoor')} variant="temps" />
      </div>
      {vent !== undefined && vent.rooms.length > 0 && (
        <ul class="vent-rooms__list" data-testid="vent-rooms">
          {(actionRooms.length > 0 ? actionRooms : vent.rooms).map((r) => (
            <li
              key={r.id}
              class={`vent-room vent-room--${r.level}`}
              data-testid={`vent-room-${r.id}`}
              data-level={r.level}
            >
              <span class="vent-room__name">{r.name}</span>
              <span class="vent-room__headline">{tServer(r.headline)}</span>
              <span class="vent-room__detail">{tServer(r.detail)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ClimateSection(): JSX.Element | null {
  const snap = snapshot.value;
  if (snap === null) return null;
  const modeInfo = snap.modeInfo;
  const indoorTemps = (snap.rooms ?? [])
    .map((r) => r.tempC)
    .filter((v): v is number => v !== null && Number.isFinite(v));
  const indoorAvg =
    indoorTemps.length > 0
      ? Math.round((indoorTemps.reduce((a, b) => a + b, 0) / indoorTemps.length) * 10) / 10
      : null;
  const feelsLike = snap.feelsLike?.feelsLikeC ?? null;
  const cool = snap.cooling;

  return (
    <section class="rooms-section" data-testid="raeume-climate">
      <h2 class="rooms-section__title">{t('Klima', 'Climate')}</h2>
      {cool !== undefined && (
        <div
          class={`vent-advice vent-advice--cool-${cool.level}`}
          data-testid="cool-overall"
          data-level={cool.level}
        >
          <span class="vent-advice__headline">{tServer(cool.headline)}</span>
          <span class="vent-advice__detail">{tServer(cool.detail)}</span>
        </div>
      )}
      <div class="module-panel__cards">
        <article class="module-panel__card" data-testid="klima-mode">
          <h3>{t('Aktueller Modus', 'Current mode')}</h3>
          <p class="module-panel__metric">{modeInfo?.label !== undefined ? tServer(modeInfo.label) : '–'}</p>
          <p class="module-panel__hint">{modeInfo?.goal !== undefined ? tServer(modeInfo.goal) : t('warte auf Daten', 'waiting for data')}</p>
        </article>
        <article class="module-panel__card" data-testid="klima-indoor">
          <h3>{t('Innenklima', 'Indoor climate')}</h3>
          <p class="module-panel__metric">{indoorAvg === null ? '–' : `${indoorAvg} °C`}</p>
          <p class="module-panel__hint">
            {t('Gefühlt', 'Feels like')} {feelsLike === null ? '–' : `${Math.round(feelsLike * 10) / 10} °C`}.{' '}
            {t('Zielband Komfort 20–26 °C.', 'Comfort target band 20–26 °C.')}
          </p>
        </article>
        <article class="module-panel__card" data-testid="klima-pv">
          <h3>{t('PV-Überschuss', 'PV surplus')}</h3>
          <p class="module-panel__metric">
            {cool?.pvSurplusKw === null || cool?.pvSurplusKw === undefined
              ? '–'
              : `${Math.round(cool.pvSurplusKw * 10) / 10} kW`}
          </p>
        </article>
        <TrendCard title={t('PV-Leistung · Verlauf', 'PV power · history')} variant="pv" />
      </div>
    </section>
  );
}

export function RaeumeView(_props: RoutableProps): JSX.Element {
  const snap = snapshot.value;
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);

  const rooms = snap?.roomsDetail ?? [];
  const selected = rooms.find((r) => r.id === selectedRoomId) ?? null;
  const risk =
    selected?.windowId !== undefined ? riskBreakdowns.value[selected.windowId] : undefined;
  const learning = snap?.learning?.rooms.find((r) => r.id === selectedRoomId);

  return (
    <section class="module-panel" data-testid="module-raeume">
      <header class="module-panel__head">
        <h1>{t('Räume', 'Rooms')}</h1>
        <span class="module-panel__badge" data-testid="module-raeume-status">
          {t('Vergleich & Empfehlungen', 'Comparison & recommendations')}
        </span>
      </header>
      <p class="module-panel__intro">
        {t(
          'Alle Räume im Vergleich: Beschattung und Fassaden-Sonnenlast, dazu die Lüftungs- und Klima-Empfehlung pro Raum. Einen Raum anklicken für Detail, Verlauf und Lernstatus.',
          'All rooms compared: shading and facade solar load, plus the ventilation and climate recommendation per room. Click a room for detail, history and learning status.',
        )}
      </p>
      {snap !== null && (
        <RoomsAndFacadesPanel snapshot={snap} onSelectRoom={(id): void => setSelectedRoomId(id)} />
      )}
      <VentilationSection />
      <ClimateSection />
      {selected !== null && (
        <RoomDetailModal
          room={selected}
          {...(risk !== undefined ? { risk } : {})}
          {...(learning !== undefined ? { learning } : {})}
          onClose={(): void => setSelectedRoomId(null)}
        />
      )}
    </section>
  );
}
