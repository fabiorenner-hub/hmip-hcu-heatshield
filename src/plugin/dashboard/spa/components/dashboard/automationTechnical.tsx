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

const FACTOR_LABELS: Record<RiskFactorName, string> = {
  sunFactor: 'Sonne (Einfallswinkel × Höhe)',
  roomTempFactor: 'Raumtemperatur (target→critical)',
  windowTypeFactor: 'Fenstertyp (Dach=1)',
  forecastTempFactor: 'Tagesprognose (24→32 °C)',
  pvFactor: 'PV-Leistung (über Ausrichtung)',
  radiationFactor: 'Strahlung (100→800 W/m²)',
  outdoorTempFactor: 'Außentemperatur (22→32 °C)',
  priorityFactor: 'Raum-Priorität',
};

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
  const t = cfg.rules.thresholds;
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
      label: 'Sturm',
      cond: `Wind > ${formatWindKmh(cfg.rules.storm.thresholdMs)} (oder Halt aktiv)`,
      ist: `Wind ${formatWindKmh(wind)}`,
    },
    { mode: 'MAINTENANCE', label: 'Wartung', cond: 'Dashboard-Schalter', ist: '—' },
    { mode: 'VACATION', label: 'Urlaub', cond: 'Urlaubsschalter', ist: snap.userIntent?.vacation ? 'an' : 'aus' },
    {
      mode: 'NIGHT_COOLING',
      label: 'Nachtauskühlung',
      cond: `Sonne unten & Außen ≥ ${f(cfg.rules.nightCooling.deltaC)} K kühler als Raum`,
      ist: `Außen ${f(outdoor)} °C / Raum ${f(warmestRoomC)} °C`,
    },
    {
      mode: 'HEATWAVE',
      label: 'Hitzewelle',
      cond: `Prognose ≥ ${f(t.heatwaveForecastC)} °C oder Raum ≥ ${f(t.heatwaveRoomC)} °C`,
      ist: `Prognose ${f(forecast)} °C / Raum ${f(warmestRoomC)} °C`,
    },
    {
      mode: 'ACTIVE_HEAT_PROTECTION',
      label: 'Aktiver Hitzeschutz',
      cond: `Prognose ≥ ${f(t.activeForecastC)} °C oder Raum ≥ ${f(t.activeRoomC)} °C`,
      ist: `Prognose ${f(forecast)} °C / Raum ${f(warmestRoomC)} °C`,
    },
    {
      mode: 'SUMMER_WATCH',
      label: 'Sommer-Beobachtung',
      cond: `Prognose ≥ ${f(t.summerForecastC)} °C, Außen ≥ ${f(t.summerOutdoorC)} °C oder PV > ${f(t.summerPvKw)} kW`,
      ist: `Prognose ${f(forecast)} °C / Außen ${f(outdoor)} °C / PV ${f(pv)} kW`,
    },
    { mode: 'NORMAL', label: 'Normal', cond: 'Fallback', ist: '—' },
  ];

  const windows = cfg.windows;

  return (
    <section class="auto-tech" data-testid="automation-technical">
      <h3 class="auto-tech__title">Technische Erklärung (Live-Berechnung)</h3>
      <p class="auto-tech__intro">
        Diese Ansicht zeigt Schritt für Schritt mit echten Zahlen, wie der
        aktuelle Modus zustande kommt und wie daraus pro Fenster der Rollo-Zielwert
        berechnet wird. Reihenfolge der Pipeline: <code>Modus → Risiko/Prognose →
        Sonderregeln → Lüftung → Sicherheit → Stauschutz-Cap → Hysterese</code>.
      </p>

      <h4 class="auto-tech__h4">1 · Modus-Entscheidungskaskade (erster Treffer gewinnt)</h4>
      <table class="auto-tech__table" data-testid="auto-tech-cascade">
        <thead>
          <tr>
            <th>Modus</th>
            <th>Bedingung</th>
            <th>Istwert</th>
            <th>Status</th>
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
                <td>{active ? '✓ aktiv' : '–'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <h4 class="auto-tech__h4">2 · Risiko → Rollo-Zielwert pro Fenster</h4>
      {windows.length === 0 ? (
        <p class="auto-tech__muted">Keine Fenster konfiguriert.</p>
      ) : (
        windows.map((w) => {
          const b = risk[w.id];
          const room = cfg.rooms.find((r) => r.id === w.roomId);
          const roomName = room?.name ?? w.roomId;
          if (b === undefined) {
            return (
              <div class="auto-tech__win" key={w.id}>
                <h5>{roomName} · Rollladen …{w.id.slice(-4)}</h5>
                <p class="auto-tech__muted">Noch keine Risiko-Daten (warte auf Zyklus).</p>
              </div>
            );
          }
          return (
            <div class="auto-tech__win" key={w.id} data-testid={`auto-tech-win-${w.id}`}>
              <h5>
                {roomName} · Rollladen …{w.id.slice(-4)}{' '}
                <span class="auto-tech__win-meta">
                  ({w.type === 'roof_window' ? 'Dachfenster' : 'Fassade'} · {Math.round(w.orientationDeg)}°)
                </span>
              </h5>
              <table class="auto-tech__table auto-tech__table--factors">
                <thead>
                  <tr>
                    <th>Faktor</th>
                    <th>Wert</th>
                    <th>Gewicht</th>
                    <th>Beitrag</th>
                  </tr>
                </thead>
                <tbody>
                  {FACTOR_ORDER.map((fk) => {
                    const fv = b.factors[fk] ?? 0;
                    const wv = b.weights[fk] ?? 0;
                    return (
                      <tr key={fk}>
                        <td>{FACTOR_LABELS[fk]}</td>
                        <td>{f(fv, 2)}</td>
                        <td>{f(wv, 2)}</td>
                        <td>{f(fv * wv, 3)}</td>
                      </tr>
                    );
                  })}
                  <tr class="auto-tech__row--sum">
                    <td colSpan={3}>Σ Risiko-Score</td>
                    <td>{f(b.risk, 3)}</td>
                  </tr>
                </tbody>
              </table>
              <ul class="auto-tech__chain">
                <li>
                  Risiko {f(b.risk, 3)} → Risiko-Stufe (Leiter) ={' '}
                  <b>{pct(b.rawTarget)}</b>
                </li>
                <li>
                  nach Sonderregeln / Sicherheit / Stauschutz-Cap (Fassade max 95 %) →
                  Endziel <b>{pct(b.finalTarget)}</b>
                </li>
                <li>
                  aktueller Modus: <b>{b.mode ?? activeMode ?? '–'}</b> · der Stauschutz-Cap
                  verhindert ein vollständiges Schließen der Fassade (Hitzestau).
                </li>
              </ul>
            </div>
          );
        })
      )}

      <h4 class="auto-tech__h4">3 · Globale Sperren &amp; Parameter</h4>
      <dl class="auto-tech__gates" data-testid="auto-tech-gates">
        <ExplainGate label="Automatik aktiv" value={cfg.automationEnabled ? 'ja' : 'NEIN (hält Positionen)'} />
        <ExplainGate label="Pausiert" value={snap.userIntent?.paused ? 'ja' : 'nein'} />
        <ExplainGate label="Urlaub" value={snap.userIntent?.vacation ? 'ja' : 'nein'} />
        <ExplainGate label="Sturm-Halt bis" value={snap.storm?.holdUntil ?? '—'} />
        <ExplainGate
          label="Ruhezeit"
          value={
            cfg.rules.automation.quietHours?.enabled === true
              ? `${cfg.rules.automation.quietHours.startHour}–${cfg.rules.automation.quietHours.endHour} Uhr`
              : 'aus'
          }
        />
        <ExplainGate label="Zyklusintervall" value={`${cfg.rules.automation.controlIntervalSeconds} s`} />
        <ExplainGate label="Mindestpause zwischen Fahrten" value={`${cfg.rules.automation.minSecondsBetweenMoves} s`} />
        <ExplainGate label="Mindest-Positionsänderung" value={`${cfg.rules.automation.minPositionDeltaPct} %`} />
        <ExplainGate
          label="Schließ-Eile (Faktor)"
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
