/**
 * Heat Shield — "Systemzustand" (Blueprint Phase 9 friendly system-health view).
 *
 * A calm, card-based health surface that answers "is everything ok?" at a
 * glance — as opposed to the raw technical `DiagnosticsTab` (decision log,
 * connect log, dry-run). It reads ONLY the live snapshot (`/api/state`) that
 * every tab already consumes; no new endpoints, no actuator path.
 *
 * Sections:
 *   1. Overall health headline (traffic-light: ok / warn / down) derived from
 *      HCU connection + plugin readiness + snapshot freshness.
 *   2. Connection cards — HCU WebSocket, FusionSolar source (last success,
 *      consecutive failures).
 *   3. Plugin state — readiness, automation lever, data age.
 *   4. Signal freshness — one row per resolved global signal with its
 *      fresh/soon/stale/unknown state.
 *   5. Inventory — rooms / windows counts.
 *   6. Link to the full Diagnose tab for the technical detail.
 */

import { h, Fragment, type JSX } from 'preact';

import { snapshot } from '../store.js';
import { t, fmtTime } from '../i18n.js';
import type { DashboardSnapshot, SignalValue } from '../types.js';

interface RoutableProps {
  path?: string;
  default?: boolean;
}

type Health = 'ok' | 'warn' | 'down';

const STALE_MINUTES = 15;

function ageMinutes(ts: string): number | null {
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? Math.max(0, Math.round((Date.now() - ms) / 60000)) : null;
}

function ageLabel(min: number | null): string {
  if (min === null) return '–';
  if (min < 1) return t('aktuell', 'live');
  return t(`vor ${min} min`, `${min} min ago`);
}

/** Overall health from connection + readiness + freshness. */
function overallHealth(snap: DashboardSnapshot): Health {
  const connected = snap.sources?.hcu?.connected !== false;
  const age = ageMinutes(snap.ts);
  const stale = age !== null && age >= STALE_MINUTES;
  if (!connected || snap.pluginReadiness === 'ERROR') return 'down';
  if (stale || snap.pluginReadiness === 'CONFIG_REQUIRED') return 'warn';
  return 'ok';
}

function healthCopy(h: Health): { title: string; note: string; cls: string } {
  switch (h) {
    case 'ok':
      return {
        title: t('Alles in Ordnung', 'Everything is fine'),
        note: t('Verbindung steht, Daten sind aktuell.', 'Connected, data is up to date.'),
        cls: 'sys-health--ok',
      };
    case 'warn':
      return {
        title: t('Eingeschränkt', 'Degraded'),
        note: t('Etwas braucht Aufmerksamkeit – Details unten.', 'Something needs attention — details below.'),
        cls: 'sys-health--warn',
      };
    case 'down':
    default:
      return {
        title: t('Nicht verbunden', 'Not connected'),
        note: t('Die Verbindung zur HCU fehlt oder das Plugin meldet einen Fehler.', 'The HCU connection is missing or the plugin reports an error.'),
        cls: 'sys-health--down',
      };
  }
}

function Dot(props: { ok: boolean | 'warn' }): JSX.Element {
  const cls = props.ok === 'warn' ? 'sys-dot--warn' : props.ok ? 'sys-dot--ok' : 'sys-dot--down';
  return <span class={`sys-dot ${cls}`} aria-hidden="true" />;
}

const SIGNAL_LABELS: Record<string, { de: string; en: string }> = {
  outdoorTemp: { de: 'Außentemperatur', en: 'Outdoor temperature' },
  pvPower: { de: 'PV-Leistung', en: 'PV power' },
  windSpeed: { de: 'Windgeschwindigkeit', en: 'Wind speed' },
  radiation: { de: 'Sonnenstrahlung', en: 'Solar radiation' },
  forecastMaxTemp: { de: 'Prognose Max-Temp.', en: 'Forecast max temp.' },
  forecastCloudCover: { de: 'Prognose Bewölkung', en: 'Forecast cloud cover' },
};

function signalStateCopy(s: SignalValue['state']): { label: string; cls: string; ok: boolean | 'warn' } {
  switch (s) {
    case 'fresh':
      return { label: t('aktuell', 'fresh'), cls: 'q--good', ok: true };
    case 'soon':
      return { label: t('bald veraltet', 'ageing'), cls: 'q--fair', ok: 'warn' };
    case 'stale':
      return { label: t('veraltet', 'stale'), cls: 'q--coarse', ok: false };
    case 'unknown':
    default:
      return { label: t('unbekannt', 'unknown'), cls: 'q--none', ok: 'warn' };
  }
}

function readinessCopy(r: DashboardSnapshot['pluginReadiness']): string {
  switch (r) {
    case 'READY':
      return t('Bereit', 'Ready');
    case 'CONFIG_REQUIRED':
      return t('Konfiguration nötig', 'Configuration required');
    case 'ERROR':
    default:
      return t('Fehler', 'Error');
  }
}

export function SystemView(_props: RoutableProps): JSX.Element {
  const snap = snapshot.value;
  if (snap === null) {
    return (
      <section class="module-panel" data-testid="tab-system">
        <div class="module-panel__head">
          <h1>{t('Systemzustand', 'System health')}</h1>
        </div>
        <p class="module-panel__hint">{t('Lade Systemdaten …', 'Loading system data …')}</p>
      </section>
    );
  }

  const health = overallHealth(snap);
  const copy = healthCopy(health);
  const age = ageMinutes(snap.ts);
  const hcuConnected = snap.sources?.hcu?.connected !== false;
  const fs = snap.sources?.fusionSolar;
  const signals = snap.signals;

  return (
    <section class="module-panel" data-testid="tab-system">
      <div class="module-panel__head">
        <h1>{t('Systemzustand', 'System health')}</h1>
        <span class="module-panel__badge" data-testid="sys-badge">
          {copy.title}
        </span>
      </div>

      <section class={`sys-health ${copy.cls}`} data-testid="sys-health" data-health={health}>
        <h2 class="sys-health__title">{copy.title}</h2>
        <p class="sys-health__note">{copy.note}</p>
      </section>

      <div class="module-panel__cards">
        <article class="module-panel__card" data-testid="sys-card-hcu">
          <h3>
            <Dot ok={hcuConnected} /> {t('HCU-Verbindung', 'HCU connection')}
          </h3>
          <p class="module-panel__metric">{hcuConnected ? t('Verbunden', 'Connected') : t('Getrennt', 'Disconnected')}</p>
          <p class="module-panel__hint">
            {t('Live-WebSocket zur Home Control Unit.', 'Live WebSocket to the Home Control Unit.')}
          </p>
        </article>

        <article class="module-panel__card" data-testid="sys-card-fusionsolar">
          <h3>
            <Dot ok={fs === undefined ? 'warn' : fs.sourceOk ? true : fs.consecutiveFailures > 3 ? false : 'warn'} />{' '}
            {t('FusionSolar (PV)', 'FusionSolar (PV)')}
          </h3>
          <p class="module-panel__metric">
            {fs === undefined ? t('nicht gebunden', 'not bound') : fs.sourceOk ? t('OK', 'OK') : t('gestört', 'faulty')}
          </p>
          <p class="module-panel__hint">
            {fs === undefined
              ? t('Keine PV-Quelle konfiguriert.', 'No PV source configured.')
              : t(
                  `Letzter Erfolg: ${fs.lastSuccess === null ? '–' : fmtTime(fs.lastSuccess)} · Fehler in Folge: ${fs.consecutiveFailures}`,
                  `Last success: ${fs.lastSuccess === null ? '–' : fmtTime(fs.lastSuccess)} · consecutive failures: ${fs.consecutiveFailures}`,
                )}
          </p>
        </article>

        <article class="module-panel__card" data-testid="sys-card-readiness">
          <h3>
            <Dot ok={snap.pluginReadiness === 'READY' ? true : snap.pluginReadiness === 'ERROR' ? false : 'warn'} />{' '}
            {t('Plugin-Status', 'Plugin state')}
          </h3>
          <p class="module-panel__metric">{readinessCopy(snap.pluginReadiness)}</p>
          <p class="module-panel__hint">
            {t(
              `Automatik: ${snap.automationEnabled === false ? 'aus' : 'ein'} · Datenstand: ${ageLabel(age)}`,
              `Automation: ${snap.automationEnabled === false ? 'off' : 'on'} · data age: ${ageLabel(age)}`,
            )}
          </p>
        </article>

        <article class="module-panel__card" data-testid="sys-card-inventory">
          <h3>{t('Umfang', 'Inventory')}</h3>
          <p class="module-panel__metric">
            {t(`${snap.rooms.length} Räume · ${snap.windows.length} Fenster`, `${snap.rooms.length} rooms · ${snap.windows.length} windows`)}
          </p>
          <p class="module-panel__hint">{t('Vom Plugin verwaltete Räume und Rollläden.', 'Rooms and shutters managed by the plugin.')}</p>
        </article>
      </div>

      {signals !== undefined && (
        <section class="rooms-section" data-testid="sys-signals">
          <h2 class="rooms-section__title">{t('Datenquellen (Aktualität)', 'Data sources (freshness)')}</h2>
          <ul class="vent-rooms__list">
            {(Object.keys(SIGNAL_LABELS) as Array<keyof typeof signals>).map((key) => {
              const sig = signals[key];
              if (sig === undefined) return null;
              const state = signalStateCopy(sig.state);
              const meta = SIGNAL_LABELS[key];
              if (meta === undefined) return null;
              return (
                <li key={key} class={`vent-room ${state.cls}`} data-testid={`sys-signal-${key}`}>
                  <span class="vent-room__name">{t(meta.de, meta.en)}</span>
                  <span class="vent-room__headline">
                    <Dot ok={state.ok} /> {state.label}
                  </span>
                  <span class="vent-room__detail">
                    {sig.bound === false
                      ? t('keine Quelle zugewiesen', 'no source assigned')
                      : t(`Stand: ${sig.ts === null ? '–' : fmtTime(sig.ts)}`, `As of: ${sig.ts === null ? '–' : fmtTime(sig.ts)}`)}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <p class="module-panel__hint" data-testid="sys-diag-link">
        {t('Technische Details, Logs und Selbsttests findest du unter ', 'Technical details, logs and self-tests are under ')}
        <a href="/diagnostics">{t('Diagnose', 'Diagnostics')}</a>.
      </p>
    </section>
  );
}
