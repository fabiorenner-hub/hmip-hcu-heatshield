/**
 * Heat Shield — "Bewässerung" tab.
 *
 * Focus: rain, precipitation amount and thunderstorms. Pulls the Open-Meteo
 * forecast client-side (CORS, no key) and shows precipitation KPIs, a 24 h
 * precipitation + probability view, a 7-day precipitation outlook and a
 * thunderstorm indicator. A Gardena smart-irrigation hook-up is scaffolded as
 * a "geplant" placeholder (the user has an API key; integration follows).
 */

import { h, type JSX } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';

import { ExpandableChart, type ChartSeries } from '../components/lineChart.js';
import { IrrigationZones } from '../components/dashboard/irrigationZones.js';
import { useConfig } from '../hooks/useConfig.js';
import { snapshot } from '../store.js';

interface RoutableProps {
  path?: string;
}

interface HourPoint {
  t: number;
  precip: number | null;
  prob: number | null;
  code: number | null;
}
interface DayPoint {
  t: number;
  sum: number | null;
  probMax: number | null;
}

interface IrrigationData {
  hourly: HourPoint[];
  daily: DayPoint[];
  precipNow: number | null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function isThunder(code: number | null): boolean {
  return code !== null && code >= 95;
}

export function IrrigationTab(_props: RoutableProps): JSX.Element {
  const { config, scheduleSave } = useConfig();
  const latitude = config.value?.location?.latitude ?? 52.52;
  const longitude = config.value?.location?.longitude ?? 13.41;
  const [data, setData] = useState<IrrigationData | null>(null);
  const [error, setError] = useState<boolean>(false);
  const now = Date.now();

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const url =
          'https://api.open-meteo.com/v1/forecast?latitude=' +
          encodeURIComponent(String(latitude)) +
          '&longitude=' +
          encodeURIComponent(String(longitude)) +
          '&current=precipitation' +
          '&hourly=precipitation,precipitation_probability,weather_code' +
          '&daily=precipitation_sum,precipitation_probability_max,weather_code' +
          '&timezone=auto&forecast_days=7';
        const res = await fetch(url, { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = (await res.json()) as {
          current?: Record<string, number>;
          hourly?: {
            time?: string[];
            precipitation?: Array<number | null>;
            precipitation_probability?: Array<number | null>;
            weather_code?: Array<number | null>;
          };
          daily?: {
            time?: string[];
            precipitation_sum?: Array<number | null>;
            precipitation_probability_max?: Array<number | null>;
            weather_code?: Array<number | null>;
          };
        };
        if (cancelled) return;
        const ht = j.hourly?.time ?? [];
        const hourly: HourPoint[] = ht.map((ts, i) => ({
          t: Date.parse(ts),
          precip: num(j.hourly?.precipitation?.[i]),
          prob: num(j.hourly?.precipitation_probability?.[i]),
          code: num(j.hourly?.weather_code?.[i]),
        }));
        const dt = j.daily?.time ?? [];
        const daily: DayPoint[] = dt.map((ts, i) => ({
          t: Date.parse(ts),
          sum: num(j.daily?.precipitation_sum?.[i]),
          probMax: num(j.daily?.precipitation_probability_max?.[i]),
        }));
        setData({ hourly, daily, precipNow: num(j.current?.['precipitation']) });
        setError(false);
      } catch {
        if (!cancelled) setError(true);
      }
    };
    void load();
    const id = setInterval(() => void load(), 15 * 60_000);
    return (): void => {
      cancelled = true;
      clearInterval(id);
    };
  }, [latitude, longitude]);

  const next24 = useMemo(
    () => (data?.hourly ?? []).filter((p) => p.t >= now && p.t <= now + 24 * 3600_000),
    [data, now],
  );

  const sum24 = next24.reduce((a, p) => a + (p.precip ?? 0), 0);
  const maxProb24 = next24.reduce((m, p) => Math.max(m, p.prob ?? 0), 0);
  const thunderSoon = next24
    .filter((p) => p.t <= now + 12 * 3600_000)
    .some((p) => isThunder(p.code));
  const nextRain = next24.find((p) => (p.precip ?? 0) >= 0.1 || (p.prob ?? 0) >= 50);
  const nextRainLabel =
    nextRain === undefined
      ? 'kein Regen in 24 h'
      : new Date(nextRain.t).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

  const autoEnabled = config.value?.irrigation?.enabled ?? false;
  const toggleAuto = (next: boolean): void => {
    const c = config.value;
    if (c === null) return;
    scheduleSave({ ...c, irrigation: { ...c.irrigation, enabled: next } });
  };

  const precipSeries: ChartSeries[] = useMemo(() => {
    const pts = next24
      .filter((p) => Number.isFinite(p.t) && p.precip !== null)
      .map((p) => ({ t: p.t, v: p.precip as number }));
    return pts.length >= 2 ? [{ label: 'Niederschlag', color: '#38bdf8', points: pts }] : [];
  }, [next24]);

  const probSeries: ChartSeries[] = useMemo(() => {
    const pts = next24
      .filter((p) => Number.isFinite(p.t) && p.prob !== null)
      .map((p) => ({ t: p.t, v: p.prob as number }));
    return pts.length >= 2 ? [{ label: 'Regenwahrscheinlichkeit', color: '#818cf8', points: pts }] : [];
  }, [next24]);

  const dailySeries: ChartSeries[] = useMemo(() => {
    const pts = (data?.daily ?? [])
      .filter((d) => Number.isFinite(d.t) && d.sum !== null)
      .map((d) => ({ t: d.t, v: d.sum as number }));
    return pts.length >= 2 ? [{ label: 'Tagessumme', color: '#0ea5e9', points: pts }] : [];
  }, [data]);

  const kpi = (label: string, value: string, testId: string, cls = ''): JSX.Element => (
    <article class={`module-panel__card ${cls}`} data-testid={testId}>
      <h2>{label}</h2>
      <p class="module-panel__metric">{value}</p>
    </article>
  );

  return (
    <section class="module-panel tab-irrigation" data-testid="tab-irrigation">
      <header class="module-panel__head">
        <h1>Bewässerung</h1>
        <span class="module-panel__badge">Regen · Niederschlag · Gewitter</span>
      </header>
      <p class="module-panel__intro">
        Niederschlags-Fokus für die Garten-Bewässerung: aktuelle und erwartete
        Regenmengen, Regenwahrscheinlichkeit und Gewitterrisiko. Grundlage für eine
        spätere automatische Bewässerung (Gardena).
      </p>

      <article class="module-panel__card irr-auto-toggle" data-testid="irr-auto-toggle">
        <div class="irr-auto-toggle__row">
          <div>
            <h2>Automatische Bewässerung</h2>
            <p class="module-panel__hint">
              {autoEnabled
                ? 'Die Automatik steuert die Ventile bedarfsgerecht nach Wasserbilanz und Wetter.'
                : 'Automatik ist aus – Ventile lassen sich nur manuell starten.'}
            </p>
          </div>
          <label class="irr-switch" title="Automatik ein/aus">
            <input
              type="checkbox"
              data-testid="irr-auto-switch"
              checked={autoEnabled}
              disabled={config.value === null}
              onChange={(e): void => toggleAuto((e.currentTarget as HTMLInputElement).checked)}
            />
            <span class="irr-switch__track" aria-hidden="true" />
            <span class="irr-switch__label">{autoEnabled ? 'An' : 'Aus'}</span>
          </label>
        </div>
      </article>

      {error && data === null && (
        <p class="module-panel__hint">Wetterdaten konnten nicht geladen werden.</p>
      )}

      {snapshot.value?.irrigation !== undefined && (
        <IrrigationZones info={snapshot.value.irrigation} />
      )}

      <div class="irrigation__kpis">
        {kpi(
          'Niederschlag jetzt',
          data?.precipNow === null || data?.precipNow === undefined
            ? '–'
            : `${data.precipNow.toFixed(1)} mm`,
          'irr-precip-now',
        )}
        {kpi('Summe nächste 24 h', `${sum24.toFixed(1)} mm`, 'irr-sum-24')}
        {kpi('Max. Regenwahrsch. 24 h', `${Math.round(maxProb24)} %`, 'irr-prob-24')}
        {kpi('Nächster Regen', nextRainLabel, 'irr-next-rain')}
        {kpi(
          'Gewitterrisiko (12 h)',
          thunderSoon ? 'ja ⚡' : 'nein',
          'irr-thunder',
          thunderSoon ? 'irrigation__thunder' : '',
        )}
      </div>

      <div class="irrigation__charts">
        <article class="module-panel__card">
          <h2>Niederschlag · nächste 24 h</h2>
          {precipSeries.length > 0 ? (
            <ExpandableChart
              title="Niederschlag · nächste 24 h"
              series={precipSeries}
              unit="mm"
              nowT={now}
            />
          ) : (
            <p class="module-panel__hint">Keine Niederschlagsdaten.</p>
          )}
        </article>
        <article class="module-panel__card">
          <h2>Regenwahrscheinlichkeit · 24 h</h2>
          {probSeries.length > 0 ? (
            <ExpandableChart
              title="Regenwahrscheinlichkeit · nächste 24 h"
              series={probSeries}
              unit="%"
              nowT={now}
            />
          ) : (
            <p class="module-panel__hint">Keine Daten.</p>
          )}
        </article>
        <article class="module-panel__card">
          <h2>Niederschlag · 7 Tage</h2>
          {dailySeries.length > 0 ? (
            <ExpandableChart
              title="Niederschlag · Tagessummen (7 Tage)"
              series={dailySeries}
              unit="mm"
            />
          ) : (
            <p class="module-panel__hint">Keine Daten.</p>
          )}
        </article>
      </div>

      <GardenaSensors />
    </section>
  );
}

/**
 * Gardena sensor section — shows the live soil-moisture / soil-temperature /
 * light sensor cards from the snapshot's `gardena` block. Valve control lives
 * entirely in the zone cards above (one control surface); valves are assigned
 * and enabled/disabled under Einstellungen → Bewässerung.
 */
function GardenaSensors(): JSX.Element {
  const snap = snapshot.value;
  const gardena = snap?.gardena;
  const sensors = gardena?.sensors ?? [];

  return (
    <div class="gardena-wrap">
      <article class="module-panel__card gardena-card" data-testid="gardena-sensors-card">
        <h2>
          Gardena-Sensoren
          <span class="gardena-card__badge gardena-card__badge--live">
            {gardena?.cloud === true
              ? gardena.connected === true
                ? 'live · cloud'
                : 'cloud'
              : 'live'}
          </span>
        </h2>

        {sensors.length === 0 ? (
          <p class="module-panel__hint">
            {gardena?.error != null && gardena.error !== ''
              ? `Verbindung: ${gardena.error}`
              : 'Noch kein Gardena-Sensor sichtbar. Verbinde dein Gardena-Konto unter Einstellungen → Bewässerung. Bodenfeuchte-Sensoren erscheinen dann automatisch.'}
          </p>
        ) : (
          <div class="gardena__sensors" data-testid="gardena-sensors">
            {sensors.map((s) => (
              <article key={s.deviceId} class="gardena-sensor">
                <h3>{s.name}</h3>
                <dl class="gardena-sensor__grid">
                  <div>
                    <dt>Bodenfeuchte</dt>
                    <dd>{s.soilMoisturePct === null ? '–' : `${Math.round(s.soilMoisturePct)} %`}</dd>
                  </div>
                  <div>
                    <dt>Bodentemperatur</dt>
                    <dd>{s.soilTempC === null ? '–' : `${s.soilTempC.toFixed(1)} °C`}</dd>
                  </div>
                  <div>
                    <dt>Licht</dt>
                    <dd>{s.lux === null ? '–' : `${Math.round(s.lux)} lx`}</dd>
                  </div>
                  {s.batteryPct != null && (
                    <div>
                      <dt>Batterie</dt>
                      <dd>{Math.round(s.batteryPct)} %</dd>
                    </div>
                  )}
                </dl>
              </article>
            ))}
          </div>
        )}
      </article>
    </div>
  );
}
