/**
 * Heat Shield — full technical automation explanation (V1.8, Automation tab).
 *
 * This is the deep, calculation-level "why" view the Automation tab shows
 * below the status card. It is deliberately far more technical than the
 * Beschattung ⓘ panel: it walks the mode-FSM decision cascade with the live
 * measurements vs. the configured thresholds, then shows the per-window risk
 * computation (factor × weight = contribution → Σ risk → ladder target →
 * final target after caps/safety), and finally the global gates.
 *
 * Pure presentational: reads the shared `riskBreakdowns` signal + the passed
 * snapshot and config. No fetching.
 */

import { h, type JSX } from 'preact';

import { riskBreakdowns } from '../../store.js';
import { formatWindKmh } from '../../format.js';
import { t } from '../../i18n.js';
import type { Config } from '../../../../../shared/types.js';
import type { DashboardSnapshot, RiskFactorName } from '../../types.js';

const FACTOR_ORDER: RiskFactorName[] = [
  'sunFactor',
  'roomTempFactor',
  'windowTypeFactor',
  'forecastTempFactor',
  'pvFactor',
  'radiationFactor',
  'outdoorTempFactor',
  'priorityFactor',
];

const FACTOR_LABELS_DE: Record<RiskFactorName, string> = {
  sunFactor: 'Sonne (Einfallswinkel × Höhe)',
  roomTempFactor: 'Raumtemperatur (target→critical)',
  windowTypeFactor: 'Fenstertyp (Dach=1)',
  forecastTempFactor: 'Tagesprognose (24→32 °C)',
  pvFactor: 'PV-Leistung (über Ausrichtung)',
  radiationFactor: 'Strahlung (100→800 W/m²)',
  outdoorTempFactor: 'Außentemperatur (22→32 °C)',
  priorityFactor: 'Raum-Priorität',
};

const FACTOR_LABELS_EN: Record<RiskFactorName, string> = {
  sunFactor: 'Sun (incidence angle × elevation)',
  roomTempFactor: 'Room temperature (target→critical)',
  windowTypeFactor: 'Window type (roof=1)',
  forecastTempFactor: 'Daily forecast (24→32 °C)',
  pvFactor: 'PV power (by orientation)',
  radiationFactor: 'Radiation (100→800 W/m²)',
  outdoorTempFactor: 'Outdoor temperature (22→32 °C)',
  priorityFactor: 'Room priority',
};

/** Bilingual risk-factor label. */
function factorLabel(fk: RiskFactorName): string {
  return t(FACTOR_LABELS_DE[fk], FACTOR_LABELS_EN[fk]);
}

function f(v: number | null | undefined, digits = 1): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '–' : v.toFixed(digits);
}

function pct(v01: number): string {
  return `${Math.round(Math.max(0, Math.min(1, v01)) * 100)} %`;
}

export function AutomationTechnical(props: {
  snapshot: DashboardSnapshot;
  config: Config;
}): JSX.Element {
  const snap = props.snapshot;
  const cfg = props.config;
  const sig = snap.signals;
  const th = cfg.rules.thresholds;
  const rooms = snap.roomsDetail ?? [];
  const risk = riskBreakdowns.value;

  const outdoor = sig?.outdoorTemp.value ?? null;
  const forecast = sig?.forecastMaxTemp.value ?? null;
  const pv = sig?.pvPower.value ?? null;
  const wind = sig?.windSpeed.value ?? null;
  const warmestRoomC = rooms.reduce<number | null>((best, r) => {
    if (r.indoorTempC === null) return best;
    return best === null || r.indoorTempC > best ? r.indoorTempC : best;
  }, null);

  const activeMode = snap.modeInfo?.id ?? snap.mode ?? null;

  // ---- Mode-FSM cascade rows -------------------------------------------
  const cascade: Array<{ mode: string; label: string; cond: string; ist: string }> = [
    {
      mode: 'STORM',
      label: t('Sturm', 'Storm'),
      cond: `${t('Wind >', 'Wind >')} ${formatWindKmh(cfg.rules.storm.thresholdMs)} ${t('(oder Halt aktiv)', '(or hold active)')}`,
      ist: `${t('Wind', 'Wind')} ${formatWindKmh(wind)}`,
    },
    { mode: 'MAINTENANCE', label: t('Wartung', 'Maintenance'), cond: t('Dashboard-Schalter', 'Dashboard switch'), ist: '—' },
    {
      mode: 'VACATION',
      label: t('Urlaub', 'Vacation'),
      cond: t('Urlaubsschalter', 'Vacation switch'),
      ist: snap.userIntent?.vacation ? t('an', 'on') : t('aus', 'off'),
    },
    {
      mode: 'NIGHT_COOLING',
      label: t('Nachtauskühlung', 'Night cooling'),
      cond: `${t('Sonne unten & Außen ≥', 'Sun down & outdoor ≥')} ${f(cfg.rules.nightCooling.deltaC)} ${t('K kühler als Raum', 'K cooler than room')}`,
      ist: `${t('Außen', 'Outdoor')} ${f(outdoor)} °C / ${t('Raum', 'Room')} ${f(warmestRoomC)} °C`,
    },
    {
      mode: 'HEATWAVE',
      label: t('Hitzewelle', 'Heatwave'),
      cond: `${t('Prognose ≥', 'Forecast ≥')} ${f(th.heatwaveForecastC)} °C ${t('oder Raum ≥', 'or room ≥')} ${f(th.heatwaveRoomC)} °C`,
      ist: `${t('Prognose', 'Forecast')} ${f(forecast)} °C / ${t('Raum', 'Room')} ${f(warmestRoomC)} °C`,
    },
    {
      mode: 'ACTIVE_HEAT_PROTECTION',
      label: t('Aktiver Hitzeschutz', 'Active heat protection'),
      cond: `${t('Prognose ≥', 'Forecast ≥')} ${f(th.activeForecastC)} °C ${t('oder Raum ≥', 'or room ≥')} ${f(th.activeRoomC)} °C`,
      ist: `${t('Prognose', 'Forecast')} ${f(forecast)} °C / ${t('Raum', 'Room')} ${f(warmestRoomC)} °C`,
    },
    {
      mode: 'SUMMER_WATCH',
      label: t('Sommer-Beobachtung', 'Summer watch'),
      cond: `${t('Prognose ≥', 'Forecast ≥')} ${f(th.summerForecastC)} °C, ${t('Außen ≥', 'outdoor ≥')} ${f(th.summerOutdoorC)} °C ${t('oder PV >', 'or PV >')} ${f(th.summerPvKw)} kW`,
      ist: `${t('Prognose', 'Forecast')} ${f(forecast)} °C / ${t('Außen', 'Outdoor')} ${f(outdoor)} °C / PV ${f(pv)} kW`,
    },
    { mode: 'NORMAL', label: t('Normal', 'Normal'), cond: t('Fallback', 'Fallback'), ist: '—' },
  ];

  const windows = cfg.windows;

  return (
    <section class="auto-tech" data-testid="automation-technical">
      <h3 class="auto-tech__title">{t('Technische Erklärung (Live-Berechnung)', 'Technical explanation (live calculation)')}</h3>
      <p class="auto-tech__intro">
        {t(
          'Diese Ansicht zeigt Schritt für Schritt mit echten Zahlen, wie der aktuelle Modus zustande kommt und wie daraus pro Fenster der Rollo-Zielwert berechnet wird. Reihenfolge der Pipeline:',
          'This view shows step by step, with real numbers, how the current mode is determined and how each window’s shutter target is derived from it. Pipeline order:',
        )}{' '}
        <code>
          {t(
            'Modus → Risiko/Prognose → Sonderregeln → Lüftung → Sicherheit → Stauschutz-Cap → Hysterese',
            'Mode → risk/forecast → special rules → ventilation → safety → heat-trap cap → hysteresis',
          )}
        </code>
        .
      </p>

      <h4 class="auto-tech__h4">{t('1 · Modus-Entscheidungskaskade (erster Treffer gewinnt)', '1 · Mode decision cascade (first match wins)')}</h4>
      <table class="auto-tech__table" data-testid="auto-tech-cascade">
        <thead>
          <tr>
            <th>{t('Modus', 'Mode')}</th>
            <th>{t('Bedingung', 'Condition')}</th>
            <th>{t('Istwert', 'Actual')}</th>
            <th>{t('Status', 'Status')}</th>
          </tr>
        </thead>
        <tbody>
          {cascade.map((row) => {
            const active = activeMode === row.mode;
            return (
              <tr key={row.mode} class={active ? 'auto-tech__row--active' : ''}>
                <td>{row.label}</td>
                <td>{row.cond}</td>
                <td>{row.ist}</td>
                <td>{active ? t('✓ aktiv', '✓ active') : '–'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <h4 class="auto-tech__h4">{t('2 · Risiko → Rollo-Zielwert pro Fenster', '2 · Risk → shutter target per window')}</h4>
      {windows.length === 0 ? (
        <p class="auto-tech__muted">{t('Keine Fenster konfiguriert.', 'No windows configured.')}</p>
      ) : (
        windows.map((w) => {
          const b = risk[w.id];
          const room = cfg.rooms.find((r) => r.id === w.roomId);
          const roomName = room?.name ?? w.roomId;
          if (b === undefined) {
            return (
              <div class="auto-tech__win" key={w.id}>
                <h5>{roomName} · {t('Rollladen', 'Shutter')} …{w.id.slice(-4)}</h5>
                <p class="auto-tech__muted">{t('Noch keine Risiko-Daten (warte auf Zyklus).', 'No risk data yet (waiting for cycle).')}</p>
              </div>
            );
          }
          return (
            <div class="auto-tech__win" key={w.id} data-testid={`auto-tech-win-${w.id}`}>
              <h5>
                {roomName} · {t('Rollladen', 'Shutter')} …{w.id.slice(-4)}{' '}
                <span class="auto-tech__win-meta">
                  ({w.type === 'roof_window' ? t('Dachfenster', 'Roof window') : t('Fassade', 'Facade')} · {Math.round(w.orientationDeg)}°)
                </span>
              </h5>
              <table class="auto-tech__table auto-tech__table--factors">
                <thead>
                  <tr>
                    <th>{t('Faktor', 'Factor')}</th>
                    <th>{t('Wert', 'Value')}</th>
                    <th>{t('Gewicht', 'Weight')}</th>
                    <th>{t('Beitrag', 'Contribution')}</th>
                  </tr>
                </thead>
                <tbody>
                  {FACTOR_ORDER.map((fk) => {
                    const fv = b.factors[fk] ?? 0;
                    const wv = b.weights[fk] ?? 0;
                    return (
                      <tr key={fk}>
                        <td>{factorLabel(fk)}</td>
                        <td>{f(fv, 2)}</td>
                        <td>{f(wv, 2)}</td>
                        <td>{f(fv * wv, 3)}</td>
                      </tr>
                    );
                  })}
                  <tr class="auto-tech__row--sum">
                    <td colSpan={3}>{t('Σ Risiko-Score', 'Σ risk score')}</td>
                    <td>{f(b.risk, 3)}</td>
                  </tr>
                </tbody>
              </table>
              <ul class="auto-tech__chain">
                <li>
                  {t('Risiko', 'Risk')} {f(b.risk, 3)} → {t('Risiko-Stufe (Leiter) =', 'risk level (ladder) =')}{' '}
                  <b>{pct(b.rawTarget)}</b>
                </li>
                <li>
                  {t(
                    'nach Sonderregeln / Sicherheit / Stauschutz-Cap (Fassade max 95 %) → Endziel',
                    'after special rules / safety / heat-trap cap (facade max 95 %) → final target',
                  )}{' '}
                  <b>{pct(b.finalTarget)}</b>
                </li>
                <li>
                  {t('aktueller Modus:', 'current mode:')} <b>{b.mode ?? activeMode ?? '–'}</b> ·{' '}
                  {t(
                    'der Stauschutz-Cap verhindert ein vollständiges Schließen der Fassade (Hitzestau).',
                    'the heat-trap cap prevents the facade from fully closing (heat build-up).',
                  )}
                </li>
              </ul>
            </div>
          );
        })
      )}

      <h4 class="auto-tech__h4">{t('3 · Globale Sperren & Parameter', '3 · Global locks & parameters')}</h4>
      <dl class="auto-tech__gates" data-testid="auto-tech-gates">
        <ExplainGate label={t('Automatik aktiv', 'Automation active')} value={cfg.automationEnabled ? t('ja', 'yes') : t('NEIN (hält Positionen)', 'NO (holds positions)')} />
        <ExplainGate label={t('Pausiert', 'Paused')} value={snap.userIntent?.paused ? t('ja', 'yes') : t('nein', 'no')} />
        <ExplainGate label={t('Urlaub', 'Vacation')} value={snap.userIntent?.vacation ? t('ja', 'yes') : t('nein', 'no')} />
        <ExplainGate label={t('Sturm-Halt bis', 'Storm hold until')} value={snap.storm?.holdUntil ?? '—'} />
        <ExplainGate
          label={t('Ruhezeit', 'Quiet hours')}
          value={
            cfg.rules.automation.quietHours?.enabled === true
              ? `${cfg.rules.automation.quietHours.startHour}–${cfg.rules.automation.quietHours.endHour} ${t('Uhr', 'h')}`
              : t('aus', 'off')
          }
        />
        <ExplainGate label={t('Zyklusintervall', 'Cycle interval')} value={`${cfg.rules.automation.controlIntervalSeconds} s`} />
        <ExplainGate label={t('Mindestpause zwischen Fahrten', 'Min. pause between moves')} value={`${cfg.rules.automation.minSecondsBetweenMoves} s`} />
        <ExplainGate label={t('Mindest-Positionsänderung', 'Min. position change')} value={`${cfg.rules.automation.minPositionDeltaPct} %`} />
        <ExplainGate
          label={t('Schließ-Eile (Faktor)', 'Closing eagerness (factor)')}
          value={f(cfg.rules.automation.closeEagerness ?? 1, 2)}
        />
      </dl>
    </section>
  );
}

function ExplainGate(props: { label: string; value: string }): JSX.Element {
  return (
    <div class="auto-tech__gate">
      <dt>{props.label}</dt>
      <dd>{props.value}</dd>
    </div>
  );
}
