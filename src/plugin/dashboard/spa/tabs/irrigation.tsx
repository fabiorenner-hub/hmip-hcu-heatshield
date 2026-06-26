/**
 * Heat Shield — "Bewässerung" / "Irrigation" tab.
 *
 * Rain/precipitation focus + the live irrigation zones and Gardena sensors.
 * Open-Meteo forecast is fetched client-side (CORS, no key). Fully bilingual
 * via the inline `t(de, en)` helper.
 */

import { h, type JSX } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';

import { ExpandableChart, type ChartSeries } from '../components/lineChart.js';
import { IrrigationZones } from '../components/dashboard/irrigationZones.js';
import { useConfig } from '../hooks/useConfig.js';
import { snapshot } from '../store.js';
import { t, fmtNum, fmtTime } from '../i18n.js';

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

function mm(v: number): string {
  return `${fmtNum(v, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} mm`;
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
    nextRain === undefined ? t('kein Regen in 24 h', 'no rain in 24 h') : fmtTime(nextRain.t);

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
    return pts.length >= 2 ? [{ label: t('Niederschlag', 'Precipitation'), color: '#38bdf8', points: pts }] : [];
  }, [next24]);

  const probSeries: ChartSeries[] = useMemo(() => {
    const pts = next24
      .filter((p) => Number.isFinite(p.t) && p.prob !== null)
      .map((p) => ({ t: p.t, v: p.prob as number }));
    return pts.length >= 2 ? [{ label: t('Regenwahrscheinlichkeit', 'Rain probability'), color: '#818cf8', points: pts }] : [];
  }, [next24]);

  const dailySeries: ChartSeries[] = useMemo(() => {
    const pts = (data?.daily ?? [])
      .filter((d) => Number.isFinite(d.t) && d.sum !== null)
      .map((d) => ({ t: d.t, v: d.sum as number }));
    return pts.length >= 2 ? [{ label: t('Tagessumme', 'Daily total'), color: '#0ea5e9', points: pts }] : [];
  }, [data]);

  const kpi = (label: string, value: string, testId: string, cls = ''): JSX.Element => (
    <article class={`module-panel__card ${cls}`} data-testid={testId}>
      <h3>{label}</h3>
      <p class="module-panel__metric">{value}</p>
    </article>
  );

  return (
    <section class="module-panel tab-irrigation" data-testid="tab-irrigation">
      <header class="module-panel__head">
        <h1>{t('Bewässerung', 'Irrigation')}</h1>
        <span class="module-panel__badge">{t('Regen · Niederschlag · Gewitter', 'Rain · Precipitation · Thunderstorms')}</span>
      </header>
      <p class="module-panel__intro">
        {t(
          'Niederschlags-Fokus für die Garten-Bewässerung: aktuelle und erwartete Regenmengen, Regenwahrscheinlichkeit und Gewitterrisiko, plus die Zonen-Steuerung und Gardena-Sensoren.',
          'Precipitation focus for garden irrigation: current and expected rainfall, rain probability and thunderstorm risk, plus zone control and Gardena sensors.',
        )}
      </p>

      <article class="module-panel__card irr-auto-toggle" data-testid="irr-auto-toggle">
        <div class="irr-auto-toggle__row">
          <div>
            <h3>{t('Automatische Bewässerung', 'Automatic irrigation')}</h3>
            <p class="module-panel__hint">
              {autoEnabled
                ? t(
                    'Die Automatik steuert die Ventile bedarfsgerecht nach Wasserbilanz und Wetter.',
                    'Automation controls the valves on demand based on the water balance and weather.',
                  )
                : t(
                    'Automatik ist aus – Ventile lassen sich nur manuell starten.',
                    'Automation is off – valves can only be started manually.',
                  )}
            </p>
          </div>
          <label class="irr-switch" title={t('Automatik ein/aus', 'Automation on/off')}>
            <input
              type="checkbox"
              data-testid="irr-auto-switch"
              checked={autoEnabled}
              disabled={config.value === null}
              onChange={(e): void => toggleAuto((e.currentTarget as HTMLInputElement).checked)}
            />
            <span class="irr-switch__track" aria-hidden="true" />
            <span class="irr-switch__label">{autoEnabled ? t('An', 'On') : t('Aus', 'Off')}</span>
          </label>
        </div>
      </article>

      {error && data === null && (
        <p class="module-panel__hint">{t('Wetterdaten konnten nicht geladen werden.', 'Weather data could not be loaded.')}</p>
      )}

      {snapshot.value?.irrigation !== undefined && (
        <IrrigationZones info={snapshot.value.irrigation} />
      )}

      <div class="irrigation__kpis">
        {kpi(
          t('Niederschlag jetzt', 'Precipitation now'),
          data?.precipNow === null || data?.precipNow === undefined ? '–' : mm(data.precipNow),
          'irr-precip-now',
        )}
        {kpi(t('Summe nächste 24 h', 'Sum next 24 h'), mm(sum24), 'irr-sum-24')}
        {kpi(t('Max. Regenwahrsch. 24 h', 'Max rain prob. 24 h'), `${Math.round(maxProb24)} %`, 'irr-prob-24')}
        {kpi(t('Nächster Regen', 'Next rain'), nextRainLabel, 'irr-next-rain')}
        {kpi(
          t('Gewitterrisiko (12 h)', 'Thunderstorm risk (12 h)'),
          thunderSoon ? t('ja ⚡', 'yes ⚡') : t('nein', 'no'),
          'irr-thunder',
          thunderSoon ? 'irrigation__thunder' : '',
        )}
      </div>

      <div class="irrigation__charts">
        <article class="module-panel__card">
          <h3>{t('Niederschlag · nächste 24 h', 'Precipitation · next 24 h')}</h3>
          {precipSeries.length > 0 ? (
            <ExpandableChart
              title={t('Niederschlag · nächste 24 h', 'Precipitation · next 24 h')}
              series={precipSeries}
              unit="mm"
              nowT={now}
            />
          ) : (
            <p class="module-panel__hint">{t('Keine Niederschlagsdaten.', 'No precipitation data.')}</p>
          )}
        </article>
        <article class="module-panel__card">
          <h3>{t('Regenwahrscheinlichkeit · 24 h', 'Rain probability · 24 h')}</h3>
          {probSeries.length > 0 ? (
            <ExpandableChart
              title={t('Regenwahrscheinlichkeit · nächste 24 h', 'Rain probability · next 24 h')}
              series={probSeries}
              unit="%"
              nowT={now}
            />
          ) : (
            <p class="module-panel__hint">{t('Keine Daten.', 'No data.')}</p>
          )}
        </article>
        <article class="module-panel__card">
          <h3>{t('Niederschlag · 7 Tage', 'Precipitation · 7 days')}</h3>
          {dailySeries.length > 0 ? (
            <ExpandableChart
              title={t('Niederschlag · Tagessummen (7 Tage)', 'Precipitation · daily totals (7 days)')}
              series={dailySeries}
              unit="mm"
            />
          ) : (
            <p class="module-panel__hint">{t('Keine Daten.', 'No data.')}</p>
          )}
        </article>
      </div>

      <GardenaSensors />
    </section>
  );
}

/** Gardena sensor section — live soil-moisture / temperature / light cards. */
function GardenaSensors(): JSX.Element {
  const snap = snapshot.value;
  const gardena = snap?.gardena;
  const sensors = gardena?.sensors ?? [];

  return (
    <div class="gardena-wrap">
      <article class="module-panel__card gardena-card" data-testid="gardena-sensors-card">
        <h3>
          {t('Gardena-Sensoren', 'Gardena sensors')}
          <span class="gardena-card__badge gardena-card__badge--live">
            {gardena?.cloud === true
              ? gardena.connected === true
                ? 'live · cloud'
                : 'cloud'
              : 'live'}
          </span>
        </h3>

        {sensors.length === 0 ? (
          <p class="module-panel__hint">
            {gardena?.error != null && gardena.error !== ''
              ? `${t('Verbindung', 'Connection')}: ${gardena.error}`
              : t(
                  'Noch kein Gardena-Sensor sichtbar. Verbinde dein Gardena-Konto unter Einstellungen → Bewässerung. Bodenfeuchte-Sensoren erscheinen dann automatisch.',
                  'No Gardena sensor visible yet. Connect your Gardena account under Settings → Irrigation. Soil-moisture sensors then appear automatically.',
                )}
          </p>
        ) : (
          <div class="gardena__sensors" data-testid="gardena-sensors">
            {sensors.map((s) => (
              <article key={s.deviceId} class="gardena-sensor">
                <h3>{s.name}</h3>
                <dl class="gardena-sensor__grid">
                  <div>
                    <dt>{t('Bodenfeuchte', 'Soil moisture')}</dt>
                    <dd>{s.soilMoisturePct === null ? '–' : `${Math.round(s.soilMoisturePct)} %`}</dd>
                  </div>
                  <div>
                    <dt>{t('Bodentemperatur', 'Soil temperature')}</dt>
                    <dd>{s.soilTempC === null ? '–' : `${fmtNum(s.soilTempC, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} °C`}</dd>
                  </div>
                  <div>
                    <dt>{t('Licht', 'Light')}</dt>
                    <dd>{s.lux === null ? '–' : `${Math.round(s.lux)} lx`}</dd>
                  </div>
                  {s.batteryPct != null && (
                    <div>
                      <dt>{t('Batterie', 'Battery')}</dt>
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
