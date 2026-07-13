/**
 * Heat Shield — "Liquid Glass V2" System-health page (lg2-native).
 *
 * A calm, glass-card health surface answering "is everything ok?" at a glance,
 * mirroring the full scope of the v1 `SystemView` (tabs/system.tsx) but in a
 * dedicated lg2 layout with its own `lg2-sys-*` classes and only `--lg2-*`
 * tokens. Reads ONLY the live snapshot (`/api/state`) — no new endpoints, no
 * actuator path.
 *
 * Scope (no function loss vs. v1):
 *   1. Overall traffic-light headline (HCU connection + pluginReadiness +
 *      snapshot freshness).
 *   2. Cards — HCU WebSocket, FusionSolar source, plugin state, inventory.
 *   3. Data-source freshness — one row per resolved global signal.
 *   4. Link to the full Diagnose tab for technical detail.
 */

import { h, Fragment, type JSX } from 'preact';

import { snapshot } from '../../store.js';
import { t, fmtTime } from '../../i18n.js';
import { Icon } from '../icons.js';
import type { DashboardSnapshot, SignalValue } from '../../types.js';

interface RoutableProps {
  path?: string;
}

type Health = 'ok' | 'warn' | 'down';
type DotState = boolean | 'warn';

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

/** Overall health from connection + readiness + freshness (v1 parity). */
function overallHealth(snap: DashboardSnapshot): Health {
  const connected = snap.sources?.hcu?.connected !== false;
  const age = ageMinutes(snap.ts);
  const stale = age !== null && age >= STALE_MINUTES;
  if (!connected || snap.pluginReadiness === 'ERROR') return 'down';
  if (stale || snap.pluginReadiness === 'CONFIG_REQUIRED') return 'warn';
  return 'ok';
}

function healthCopy(health: Health): { title: string; note: string } {
  switch (health) {
    case 'ok':
      return {
        title: t('Alles in Ordnung', 'Everything is fine'),
        note: t('Verbindung steht, Daten sind aktuell.', 'Connected, data is up to date.'),
      };
    case 'warn':
      return {
        title: t('Eingeschränkt', 'Degraded'),
        note: t('Etwas braucht Aufmerksamkeit – Details unten.', 'Something needs attention — details below.'),
      };
    case 'down':
    default:
      return {
        title: t('Nicht verbunden', 'Not connected'),
        note: t(
          'Die Verbindung zur HCU fehlt oder das Plugin meldet einen Fehler.',
          'The HCU connection is missing or the plugin reports an error.',
        ),
      };
  }
}

function toneClass(state: DotState): string {
  return state === 'warn' ? 'lg2-sys-dot--warn' : state ? 'lg2-sys-dot--ok' : 'lg2-sys-dot--down';
}

function Dot(props: { state: DotState }): JSX.Element {
  return <span class={`lg2-sys-dot ${toneClass(props.state)}`} aria-hidden="true" />;
}

const SIGNAL_LABELS: Record<string, { de: string; en: string }> = {
  outdoorTemp: { de: 'Außentemperatur', en: 'Outdoor temperature' },
  pvPower: { de: 'PV-Leistung', en: 'PV power' },
  windSpeed: { de: 'Windgeschwindigkeit', en: 'Wind speed' },
  radiation: { de: 'Sonnenstrahlung', en: 'Solar radiation' },
  forecastMaxTemp: { de: 'Prognose Max-Temp.', en: 'Forecast max temp.' },
  forecastCloudCover: { de: 'Prognose Bewölkung', en: 'Forecast cloud cover' },
};

function signalStateCopy(s: SignalValue['state']): { label: string; state: DotState } {
  switch (s) {
    case 'fresh':
      return { label: t('aktuell', 'fresh'), state: true };
    case 'soon':
      return { label: t('bald veraltet', 'ageing'), state: 'warn' };
    case 'stale':
      return { label: t('veraltet', 'stale'), state: false };
    case 'unknown':
    default:
      return { label: t('unbekannt', 'unknown'), state: 'warn' };
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

function SysSkeleton(): JSX.Element {
  return (
    <Fragment>
      <header class="lg2-header">
        <div>
          <h1 class="lg2-header__title">{t('Systemzustand', 'System health')}</h1>
          <p class="lg2-header__sub">{t('Ist alles in Ordnung?', 'Is everything ok?')}</p>
        </div>
      </header>
      <div class="lg2-card lg2-sys-loading">{t('Lade Systemdaten …', 'Loading system data …')}</div>
    </Fragment>
  );
}

function SysBody(props: { snap: DashboardSnapshot }): JSX.Element {
  const { snap } = props;
  const health = overallHealth(snap);
  const copy = healthCopy(health);
  const age = ageMinutes(snap.ts);
  const hcuConnected = snap.sources?.hcu?.connected !== false;
  const fs = snap.sources?.fusionSolar;
  const signals = snap.signals;

  const fsState: DotState =
    fs === undefined ? 'warn' : fs.sourceOk ? true : fs.consecutiveFailures > 3 ? false : 'warn';
  const readyState: DotState =
    snap.pluginReadiness === 'READY' ? true : snap.pluginReadiness === 'ERROR' ? false : 'warn';

  return (
    <Fragment>
      <header class="lg2-header">
        <div>
          <h1 class="lg2-header__title">{t('Systemzustand', 'System health')}</h1>
          <p class="lg2-header__sub">{t('Ist alles in Ordnung?', 'Is everything ok?')}</p>
        </div>
        <div class="lg2-header__right">
          <span class={`lg2-headbadge lg2-headbadge--${health}`} data-testid="lg2-sys-badge">
            <Dot state={health === 'ok' ? true : health === 'warn' ? 'warn' : false} />
            {copy.title}
          </span>
        </div>
      </header>

      <section
        class={`lg2-card lg2-sys-health lg2-sys-health--${health}`}
        data-testid="lg2-sys-health"
        data-health={health}
      >
        <span class="lg2-sys-health__icon">
          <Icon name={health === 'down' ? 'warnung' : health === 'warn' ? 'automation' : 'logo'} size={26} />
        </span>
        <div>
          <h2 class="lg2-sys-health__title">{copy.title}</h2>
          <p class="lg2-sys-health__note">{copy.note}</p>
        </div>
      </section>

      <div class="lg2-sys-cards">
        <article class="lg2-card lg2-sys-card" data-testid="lg2-sys-card-hcu">
          <h3 class="lg2-sys-card__title">
            <Dot state={hcuConnected} /> {t('HCU-Verbindung', 'HCU connection')}
          </h3>
          <p class="lg2-sys-card__metric">{hcuConnected ? t('Verbunden', 'Connected') : t('Getrennt', 'Disconnected')}</p>
          <p class="lg2-sys-card__hint">
            {t('Live-WebSocket zur Home Control Unit.', 'Live WebSocket to the Home Control Unit.')}
          </p>
        </article>

        <article class="lg2-card lg2-sys-card" data-testid="lg2-sys-card-fusionsolar">
          <h3 class="lg2-sys-card__title">
            <Dot state={fsState} /> {t('FusionSolar (PV)', 'FusionSolar (PV)')}
          </h3>
          <p class="lg2-sys-card__metric">
            {fs === undefined ? t('nicht gebunden', 'not bound') : fs.sourceOk ? t('OK', 'OK') : t('gestört', 'faulty')}
          </p>
          <p class="lg2-sys-card__hint">
            {fs === undefined
              ? t('Keine PV-Quelle konfiguriert.', 'No PV source configured.')
              : t(
                  `Letzter Erfolg: ${fs.lastSuccess === null ? '–' : fmtTime(fs.lastSuccess)} · Fehler in Folge: ${fs.consecutiveFailures}`,
                  `Last success: ${fs.lastSuccess === null ? '–' : fmtTime(fs.lastSuccess)} · consecutive failures: ${fs.consecutiveFailures}`,
                )}
          </p>
        </article>

        <article class="lg2-card lg2-sys-card" data-testid="lg2-sys-card-readiness">
          <h3 class="lg2-sys-card__title">
            <Dot state={readyState} /> {t('Plugin-Status', 'Plugin state')}
          </h3>
          <p class="lg2-sys-card__metric">{readinessCopy(snap.pluginReadiness)}</p>
          <p class="lg2-sys-card__hint">
            {t(
              `Automatik: ${snap.automationEnabled === false ? 'aus' : 'ein'} · Datenstand: ${ageLabel(age)}`,
              `Automation: ${snap.automationEnabled === false ? 'off' : 'on'} · data age: ${ageLabel(age)}`,
            )}
          </p>
        </article>

        <article class="lg2-card lg2-sys-card" data-testid="lg2-sys-card-inventory">
          <h3 class="lg2-sys-card__title">
            <Icon name="haus" size={16} /> {t('Umfang', 'Inventory')}
          </h3>
          <p class="lg2-sys-card__metric">
            {t(
              `${snap.rooms.length} Räume · ${snap.windows.length} Fenster`,
              `${snap.rooms.length} rooms · ${snap.windows.length} windows`,
            )}
          </p>
          <p class="lg2-sys-card__hint">
            {t('Vom Plugin verwaltete Räume und Rollläden.', 'Rooms and shutters managed by the plugin.')}
          </p>
        </article>
      </div>

      {signals !== undefined && (
        <section class="lg2-card lg2-sys-signals" data-testid="lg2-sys-signals">
          <h3 class="lg2-card__title">{t('Datenquellen (Aktualität)', 'Data sources (freshness)')}</h3>
          <ul class="lg2-sys-siglist">
            {(Object.keys(SIGNAL_LABELS) as Array<keyof typeof signals>).map((key) => {
              const sig = signals[key];
              if (sig === undefined) return null;
              const meta = SIGNAL_LABELS[key];
              if (meta === undefined) return null;
              const state = signalStateCopy(sig.state);
              return (
                <li key={key} class="lg2-sys-signal" data-testid={`lg2-sys-signal-${key}`}>
                  <span class="lg2-sys-signal__name">{t(meta.de, meta.en)}</span>
                  <span class="lg2-sys-signal__state">
                    <Dot state={state.state} /> {state.label}
                  </span>
                  <span class="lg2-sys-signal__detail">
                    {sig.bound === false
                      ? t('keine Quelle zugewiesen', 'no source assigned')
                      : t(
                          `Stand: ${sig.ts === null ? '–' : fmtTime(sig.ts)}`,
                          `As of: ${sig.ts === null ? '–' : fmtTime(sig.ts)}`,
                        )}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <p class="lg2-sys-diaglink" data-testid="lg2-sys-diag-link">
        {t(
          'Technische Details, Logs und Selbsttests findest du unter ',
          'Technical details, logs and self-tests are under ',
        )}
        <a href="/diagnostics">{t('Diagnose', 'Diagnostics')}</a>.
      </p>
    </Fragment>
  );
}

export function LiquidGlass2System(_props: RoutableProps): JSX.Element {
  const snap = snapshot.value;
  return (
    <main class="lg2-main lg2-sys" data-testid="liquid-glass2-system">
      {snap === null ? <SysSkeleton /> : <SysBody snap={snap} />}
    </main>
  );
}
