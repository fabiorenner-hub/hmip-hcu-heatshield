/**
 * Heat Shield — Alert-Mode "Katastrophenschutz-Zentrale" (Wetter + Beschattung).
 *
 * Temporarily shown whenever an active DWD severe-weather warning of level ≥ 3
 * (Rot/Violett) is present (`snapshot.weatherAlert.active`). Goal: protect and
 * inform the residents — a hard-to-miss, pulsing alert panel with the official
 * warning(s) + behavioural advice (DWD `instruction`), the live safety metrics
 * the user asked for (thunderstorm, wind, precipitation), a 15-minute
 * precipitation outlook and — on the start page — a compact rain radar.
 *
 * Pure presentational; reads the shared snapshot signal. Renders `null` when no
 * alert is active so it costs nothing in normal operation.
 */

import { h, type JSX } from 'preact';

import { snapshot } from '../../store.js';
import { useConfig } from '../../hooks/useConfig.js';
import { t, fmtTime, fmtNum } from '../../i18n.js';
import type { WeatherWarning } from '../../types.js';
import { RadarMap } from './radarMap.js';
import { PrecipOutlook } from './precipOutlook.js';

/** DWD level → colour + bilingual label. */
function levelMeta(level: number): { color: string; label: () => string } {
  switch (level) {
    case 4:
      return { color: '#a855f7', label: (): string => t('Extrem (Violett)', 'Extreme (violet)') };
    case 3:
      return { color: '#ef4444', label: (): string => t('Unwetter (Rot)', 'Severe (red)') };
    case 2:
      return { color: '#f59e0b', label: (): string => t('Markant (Orange)', 'Moderate (orange)') };
    default:
      return { color: '#eab308', label: (): string => t('Wetterwarnung (Gelb)', 'Minor (yellow)') };
  }
}

function isThunder(w: WeatherWarning): boolean {
  return /gewitter|blitz|thunder/i.test(`${w.event} ${w.headline}`);
}

export function AlertCenter(props: {
  latitude: number;
  longitude: number;
  /** Which surface this instance lives on — gated by the per-tab settings toggle. */
  surface: 'dashboard' | 'weather';
  /** Show the compact rain radar (start page only; the Wetter tab already has one). */
  showRadar?: boolean;
}): JSX.Element | null {
  const snap = snapshot.value;
  const { config } = useConfig();
  const alert = snap?.weatherAlert;
  if (alert === undefined || !alert.active) {
    return null;
  }
  // Per-tab visibility toggle (Einstellungen → Darstellung). Telegram + the
  // open-window safety warnings are independent of this display toggle.
  const dwd = config.value?.dwd;
  if (dwd !== undefined) {
    if (props.surface === 'dashboard' && dwd.alertOnDashboard === false) return null;
    if (props.surface === 'weather' && dwd.alertOnWeather === false) return null;
  }
  const meta = levelMeta(alert.maxLevel);
  const warnings = [...alert.warnings].sort((a, b) => b.level - a.level);

  // Live safety metrics (permanently shown during the alert).
  const thunder = alert.warnings.some(isThunder);
  const windMs = snap?.environment?.windMs?.value ?? null;
  const windKmh = windMs !== null ? Math.round(windMs * 3.6) : null;
  const precip = snap?.precipNowcast ?? [];
  const precip2hMm =
    precip.length > 0 ? Math.round(precip.reduce((s, p) => s + p.precipMm, 0) * 10) / 10 : null;
  const precipPeak =
    precip.length > 0 ? Math.round(Math.max(...precip.map((p) => p.precipMm)) * 10) / 10 : null;

  return (
    <section
      class="alert-center"
      data-testid="alert-center"
      data-level={alert.maxLevel}
      style={{ '--alert-color': meta.color } as JSX.CSSProperties}
      role="alert"
      aria-live="assertive"
    >
      <header class="alert-center__head">
        <span class="alert-center__siren" aria-hidden="true">
          ⚠
        </span>
        <div class="alert-center__headline">
          <span class="alert-center__title">
            {t('Katastrophenschutz · Unwetterwarnung', 'Emergency mode · severe-weather warning')}
          </span>
          <span class="alert-center__sub">
            {meta.label()} · {alert.region} ·{' '}
            {t('aktualisiert', 'updated')} {fmtTime(alert.updatedTs)}
          </span>
        </div>
      </header>

      {/* Live safety metrics the resident must see at a glance. */}
      <div class="alert-center__metrics" data-testid="alert-metrics">
        <div class={`alert-metric${thunder ? ' alert-metric--hot' : ''}`}>
          <span class="alert-metric__icon" aria-hidden="true">⚡</span>
          <span class="alert-metric__label">{t('Gewitter', 'Thunderstorm')}</span>
          <span class="alert-metric__value">
            {thunder ? t('aktiv', 'active') : t('keins', 'none')}
          </span>
        </div>
        <div class="alert-metric">
          <span class="alert-metric__icon" aria-hidden="true">💨</span>
          <span class="alert-metric__label">{t('Wind', 'Wind')}</span>
          <span class="alert-metric__value">
            {windKmh === null ? '–' : `${windKmh} km/h`}
          </span>
        </div>
        <div class={`alert-metric${precip2hMm !== null && precip2hMm > 0.5 ? ' alert-metric--hot' : ''}`}>
          <span class="alert-metric__icon" aria-hidden="true">🌧</span>
          <span class="alert-metric__label">{t('Niederschlag · 2 h', 'Precip · 2 h')}</span>
          <span class="alert-metric__value">
            {precip2hMm === null ? '–' : `${fmtNum(precip2hMm)} mm`}
          </span>
          {precipPeak !== null && precipPeak > 0 && (
            <span class="alert-metric__hint">
              {t('Spitze', 'peak')} {fmtNum(precipPeak)} mm/15min
            </span>
          )}
        </div>
      </div>

      {/* Official warning(s) with behavioural advice. */}
      <ul class="alert-center__warnings">
        {warnings.map((w, i) => {
          const wm = levelMeta(w.level);
          return (
            <li
              key={`${w.event}-${w.start ?? i}`}
              class="alert-warning"
              style={{ '--alert-color': wm.color } as JSX.CSSProperties}
            >
              <div class="alert-warning__head">
                <span class="alert-warning__badge">{wm.label()}</span>
                <span class="alert-warning__event">
                  {w.headline.length > 0 ? w.headline : w.event}
                </span>
                {w.end !== null && (
                  <span class="alert-warning__until">
                    {t('bis', 'until')} {fmtTime(w.end)}
                  </span>
                )}
              </div>
              {w.instruction.length > 0 && (
                <p class="alert-warning__instruction">{w.instruction}</p>
              )}
              {w.instruction.length === 0 && w.description.length > 0 && (
                <p class="alert-warning__instruction">{w.description}</p>
              )}
            </li>
          );
        })}
      </ul>

      {/* 15-minute precipitation outlook (high-res during the alert). */}
      <PrecipOutlook />

      {/* Compact rain radar — start page only (the Wetter tab has the full one). */}
      {props.showRadar === true && (
        <div class="alert-center__radar" data-testid="alert-radar">
          <RadarMap latitude={props.latitude} longitude={props.longitude} />
        </div>
      )}

      <p class="alert-center__foot">
        {t(
          'Quelle: Deutscher Wetterdienst (DWD). Lage-Updates per Telegram alle 30 Minuten, bis die Warnung aufgehoben ist.',
          'Source: German Weather Service (DWD). Situation updates via Telegram every 30 minutes until the warning is lifted.',
        )}
      </p>
    </section>
  );
}
