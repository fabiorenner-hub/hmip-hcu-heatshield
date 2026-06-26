/**
 * Heat Shield — direct OpenMeteo HTTP source adapter (Wave 5).
 *
 * Polls the public open-meteo.com forecast API directly over HTTPS, as an
 * alternative / fallback to the HCU's OpenMeteo plugin (which surfaces
 * weather as `CLIMATE_SENSOR` devices on the Connect bus). The free API
 * needs no key. We request the handful of `current` fields the engine
 * cares about plus today's max temperature.
 *
 * Design mirrors {@link FusionSolarAdapter}: fully dependency-injected
 * (`fetchFn`, `now`), `setTimeout` recursion so polls cannot overlap, a
 * 3-strikes failure ledger, and a `getValue(field)` accessor returning the
 * latest decoded value with a local `observedAt` stamp (used for the
 * `staleAfterSec` budget).
 *
 * The default poll interval is generous (15 min): forecast/current weather
 * does not change second-to-second and the public API is rate-limited.
 *
 * Pure module rules: no fs, no Connect artifacts, no logging.
 */

import { EventEmitter } from 'node:events';

import { z } from 'zod';

import type { SourceRef } from '../../shared/types.js';

// ---------------------------------------------------------------------------
// Public field set — derived from the `openmeteo_http` SourceRef variant.
// ---------------------------------------------------------------------------

export type OpenMeteoField = Extract<
  SourceRef,
  { kind: 'openmeteo_http' }
>['field'];

const OPEN_METEO_FIELDS: readonly OpenMeteoField[] = [
  'temperature',
  'humidity',
  'cloudCover',
  'radiation',
  'windSpeed',
  'precipitation',
  'maxTempToday',
] as const;

// ---------------------------------------------------------------------------
// Internal response schema (defensive, passthrough at every level).
// ---------------------------------------------------------------------------

const ForecastResponseSchema = z.object({
  current: z
    .object({
      temperature_2m: z.number().optional(),
      relative_humidity_2m: z.number().optional(),
      apparent_temperature: z.number().optional(),
      cloud_cover: z.number().optional(),
      wind_speed_10m: z.number().optional(),
      wind_gusts_10m: z.number().optional(),
      shortwave_radiation: z.number().optional(),
      precipitation: z.number().optional(),
      weather_code: z.number().optional(),
      is_day: z.number().optional(),
      soil_temperature_6cm: z.number().optional(),
      soil_moisture_3_to_9cm: z.number().optional(),
    })
    .passthrough()
    .optional(),
  minutely_15: z
    .object({
      time: z.array(z.string()).optional(),
      temperature_2m: z.array(z.number().nullable()).optional(),
      shortwave_radiation: z.array(z.number().nullable()).optional(),
      direct_radiation: z.array(z.number().nullable()).optional(),
      precipitation: z.array(z.number().nullable()).optional(),
      weather_code: z.array(z.number().nullable()).optional(),
      is_day: z.array(z.number().nullable()).optional(),
    })
    .passthrough()
    .optional(),
  hourly: z
    .object({
      time: z.array(z.string()).optional(),
      temperature_2m: z.array(z.number().nullable()).optional(),
      apparent_temperature: z.array(z.number().nullable()).optional(),
      relative_humidity_2m: z.array(z.number().nullable()).optional(),
      cloud_cover: z.array(z.number().nullable()).optional(),
      shortwave_radiation: z.array(z.number().nullable()).optional(),
      precipitation: z.array(z.number().nullable()).optional(),
      precipitation_probability: z.array(z.number().nullable()).optional(),
      weather_code: z.array(z.number().nullable()).optional(),
      wind_speed_10m: z.array(z.number().nullable()).optional(),
      uv_index: z.array(z.number().nullable()).optional(),
      et0_fao_evapotranspiration: z.array(z.number().nullable()).optional(),
    })
    .passthrough()
    .optional(),
  daily: z
    .object({
      temperature_2m_max: z.array(z.number()).optional(),
      temperature_2m_min: z.array(z.number().nullable()).optional(),
      sunrise: z.array(z.string()).optional(),
      sunset: z.array(z.string()).optional(),
      uv_index_max: z.array(z.number().nullable()).optional(),
      precipitation_probability_max: z.array(z.number().nullable()).optional(),
      precipitation_sum: z.array(z.number().nullable()).optional(),
      et0_fao_evapotranspiration: z.array(z.number().nullable()).optional(),
    })
    .passthrough()
    .optional(),
});

/** One hourly forecast sample for the dashboard timeline + temperature chart. */
export interface OpenMeteoHourPoint {
  readonly ts: string; // ISO-8601
  readonly tempC: number | null;
  readonly apparentTempC: number | null;
  readonly humidity01: number | null;
  readonly cloudCover01: number | null;
  readonly radiationWm2: number | null;
  readonly precipMm: number | null;
  readonly precipProb01: number | null;
  readonly uvIndex: number | null;
  readonly windMs: number | null;
  readonly weatherCode: number | null;
  readonly et0Mm: number | null;
}

/** One 15-minute nowcast sample (near-term, high resolution). */
export interface OpenMeteoNowcastPoint {
  readonly ts: string;
  readonly tempC: number | null;
  readonly radiationWm2: number | null;
  readonly directRadiationWm2: number | null;
  readonly precipMm: number | null;
  readonly weatherCode: number | null;
  readonly isDay: boolean | null;
}

/** Daily summary used for sunrise/sunset and UV/precip extremes. */
export interface OpenMeteoDaily {
  readonly date: string;
  readonly tempMaxC: number | null;
  readonly tempMinC: number | null;
  readonly sunrise: string | null;
  readonly sunset: string | null;
  readonly uvIndexMax: number | null;
  readonly precipProbMax01: number | null;
}

export interface OpenMeteoValue {
  readonly value: number;
  readonly observedAt: Date;
}

export interface OpenMeteoStatus {
  readonly sourceOk: boolean;
  readonly lastSuccess: Date | null;
  readonly lastError: { message: string; ts: Date } | null;
  readonly consecutiveFailures: number;
}

export interface OpenMeteoAdapterOptions {
  readonly latitude: number;
  readonly longitude: number;
  readonly timezone: string;
  /** Base API URL; default `https://api.open-meteo.com`. */
  readonly baseUrl?: string;
  readonly pollIntervalMs?: number;
  readonly httpTimeoutMs?: number;
  readonly failureThreshold?: number;
  readonly fetchFn?: typeof globalThis.fetch;
  readonly now?: () => Date;
}

type OpenMeteoEvents = {
  value: [field: OpenMeteoField, value: OpenMeteoValue];
  sourceUnavailable: [error: { message: string; ts: Date }];
  sourceRecovered: [info: { ts: Date }];
};

// ---------------------------------------------------------------------------
// Adapter.
// ---------------------------------------------------------------------------

export class OpenMeteoAdapter extends EventEmitter<OpenMeteoEvents> {
  private readonly latitude: number;
  private readonly longitude: number;
  private readonly timezone: string;
  private readonly baseUrl: string;
  private readonly pollIntervalMs: number;
  private readonly httpTimeoutMs: number;
  private readonly failureThreshold: number;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly now: () => Date;

  private readonly values: Map<OpenMeteoField, OpenMeteoValue> = new Map();
  private forecastSeries: ReadonlyArray<OpenMeteoHourPoint> = [];
  private nowcastSeries: ReadonlyArray<OpenMeteoNowcastPoint> = [];
  private dailySummary: ReadonlyArray<OpenMeteoDaily> = [];
  /** Current soil temperature at 6 cm (°C), or null. */
  private soilTempC: number | null = null;
  /** Current volumetric soil moisture at 3–9 cm (m³/m³), or null. */
  private soilMoistureVol: number | null = null;
  /** Today's reference ET sum (mm), or null. */
  private et0TodayMm: number | null = null;
  /** Today's precipitation sum (mm), or null. */
  private rainTodayMm: number | null = null;

  private sourceOk = true;
  private lastSuccess: Date | null = null;
  private lastError: { message: string; ts: Date } | null = null;
  private consecutiveFailures = 0;

  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;

  public constructor(options: OpenMeteoAdapterOptions) {
    super();
    this.latitude = options.latitude;
    this.longitude = options.longitude;
    this.timezone = options.timezone;
    this.baseUrl = (options.baseUrl ?? 'https://api.open-meteo.com').replace(
      /\/+$/,
      '',
    );
    this.pollIntervalMs = options.pollIntervalMs ?? 15 * 60_000;
    this.httpTimeoutMs = options.httpTimeoutMs ?? 8_000;
    this.failureThreshold = options.failureThreshold ?? 3;
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? ((): Date => new Date());
  }

  public start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    void this.tick();
  }

  public async stop(): Promise<void> {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.inFlight !== null) {
      try {
        await this.inFlight;
      } catch {
        // pollOnce never throws; defensive.
      }
    }
  }

  public getValue(field: OpenMeteoField): OpenMeteoValue | null {
    return this.values.get(field) ?? null;
  }

  /** Latest hourly forecast series (next ~48 h). Empty until first poll. */
  public getForecastSeries(): ReadonlyArray<OpenMeteoHourPoint> {
    return this.forecastSeries;
  }

  /** Latest 15-minute nowcast series (near-term, high resolution). */
  public getNowcastSeries(): ReadonlyArray<OpenMeteoNowcastPoint> {
    return this.nowcastSeries;
  }

  /** Latest daily summary (sunrise/sunset, UV/precip extremes). */
  public getDailySummary(): ReadonlyArray<OpenMeteoDaily> {
    return this.dailySummary;
  }

  /** Today's reference ET sum (mm), or null. */
  public getEt0TodayMm(): number | null {
    return this.et0TodayMm;
  }

  /** Today's precipitation sum (mm), or null. */
  public getRainTodayMm(): number | null {
    return this.rainTodayMm;
  }

  /** Current soil temperature at 6 cm (°C), or null. */
  public getSoilTempC(): number | null {
    return this.soilTempC;
  }

  /** Current volumetric soil moisture at 3–9 cm (m³/m³), or null. */
  public getSoilMoistureVol(): number | null {
    return this.soilMoistureVol;
  }

  /**
   * Forward ET0 + precipitation steps (hourly) for the irrigation forecast,
   * starting at `from`. Each step carries the hour's ET0 (mm) and gross
   * precipitation (mm). Hours with no ET0 are skipped.
   */
  public getEt0ForecastSteps(
    from: Date,
  ): ReadonlyArray<{ ts: string; et0Mm: number; precipMm: number }> {
    const fromMs = from.getTime();
    const out: Array<{ ts: string; et0Mm: number; precipMm: number }> = [];
    for (const p of this.forecastSeries) {
      const t = Date.parse(p.ts);
      if (!Number.isFinite(t) || t < fromMs) continue;
      out.push({
        ts: p.ts,
        et0Mm: p.et0Mm ?? 0,
        precipMm: p.precipMm ?? 0,
      });
    }
    return out;
  }

  /**
   * Reference ET (mm) of the hour bracket containing `now`, from the hourly
   * forecast series (which includes the elapsed hours of the current day).
   * Null when no matching hour is cached.
   */
  public getCurrentHourEt0Mm(now: Date): number | null {
    const nowMs = now.getTime();
    let best: number | null = null;
    let bestDiff = Infinity;
    for (const p of this.forecastSeries) {
      const t = Date.parse(p.ts);
      if (!Number.isFinite(t)) continue;
      const diff = Math.abs(t - nowMs);
      if (diff < bestDiff && diff <= 3_600_000 && p.et0Mm !== null) {
        bestDiff = diff;
        best = p.et0Mm;
      }
    }
    return best;
  }

  /** Sum of forecast rainfall (mm) within the next `hours` hours. */
  public getForecastRainMm(from: Date, hours: number): number {
    const fromMs = from.getTime();
    const toMs = fromMs + hours * 3600_000;
    let sum = 0;
    for (const p of this.forecastSeries) {
      const t = Date.parse(p.ts);
      if (!Number.isFinite(t) || t < fromMs || t > toMs) continue;
      sum += p.precipMm ?? 0;
    }
    return sum;
  }

  public getStatus(): OpenMeteoStatus {
    return {
      sourceOk: this.sourceOk,
      lastSuccess: this.lastSuccess,
      lastError: this.lastError,
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  public async pollOnce(): Promise<void> {
    if (this.inFlight !== null) {
      return this.inFlight;
    }
    const work = this.doPoll();
    this.inFlight = work;
    try {
      await work;
    } finally {
      this.inFlight = null;
    }
  }

  /** The fully-formed forecast request URL (exposed for tests/diagnostics). */
  public buildUrl(): string {
    const params = new URLSearchParams({
      latitude: String(this.latitude),
      longitude: String(this.longitude),
      hourly:
        'temperature_2m,apparent_temperature,relative_humidity_2m,cloud_cover,shortwave_radiation,precipitation,precipitation_probability,weather_code,wind_speed_10m,uv_index,et0_fao_evapotranspiration',
      daily:
        'temperature_2m_max,temperature_2m_min,sunrise,sunset,uv_index_max,precipitation_probability_max,precipitation_sum,et0_fao_evapotranspiration',
      current:
        'temperature_2m,relative_humidity_2m,apparent_temperature,cloud_cover,wind_speed_10m,wind_gusts_10m,shortwave_radiation,precipitation,weather_code,is_day,soil_temperature_6cm,soil_moisture_3_to_9cm',
      minutely_15:
        'temperature_2m,shortwave_radiation,direct_radiation,precipitation,weather_code,is_day',
      wind_speed_unit: 'ms',
      timezone: 'GMT',
      models: 'best_match',
      forecast_days: '3',
    });
    return `${this.baseUrl}/v1/forecast?${params.toString()}`;
  }

  // -------------------------------------------------------------------------

  private async tick(): Promise<void> {
    if (!this.running) {
      return;
    }
    try {
      await this.pollOnce();
    } catch {
      // internalised
    }
    if (!this.running) {
      return;
    }
    this.timer = setTimeout(() => {
      void this.tick();
    }, this.pollIntervalMs);
  }

  private async doPoll(): Promise<void> {
    const url = this.buildUrl();
    const ac = new AbortController();
    const timeoutId = setTimeout(() => {
      ac.abort();
    }, this.httpTimeoutMs);

    try {
      let response: Response;
      try {
        response = await this.fetchFn(url, { signal: ac.signal });
      } catch (err) {
        this.recordFailure(this.describeError(err, 'fetch failed'));
        return;
      }

      if (!response.ok) {
        this.recordFailure(`HTTP ${response.status}`);
        return;
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch (err) {
        this.recordFailure(this.describeError(err, 'JSON parse failed'));
        return;
      }

      const parsed = ForecastResponseSchema.safeParse(body);
      if (!parsed.success) {
        this.recordFailure(
          `schema mismatch: ${parsed.error.issues.length} issue(s)`,
        );
        return;
      }

      this.recordSuccess(parsed.data);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private recordSuccess(
    data: z.infer<typeof ForecastResponseSchema>,
  ): void {
    const observedAt = this.now();
    const current = data.current;
    const daily = data.daily;
    const mapped: Partial<Record<OpenMeteoField, number | undefined>> = {
      temperature: current?.temperature_2m,
      humidity: current?.relative_humidity_2m,
      cloudCover: current?.cloud_cover,
      radiation: current?.shortwave_radiation,
      windSpeed: current?.wind_speed_10m,
      precipitation: current?.precipitation,
      maxTempToday: daily?.temperature_2m_max?.[0],
    };
    for (const field of OPEN_METEO_FIELDS) {
      const raw = mapped[field];
      if (typeof raw === 'number' && Number.isFinite(raw)) {
        const v: OpenMeteoValue = { value: raw, observedAt };
        this.values.set(field, v);
        this.emit('value', field, v);
      }
    }
    // Hourly forecast series for the dashboard timeline + temperature chart.
    const h = data.hourly;
    const c01 = (x: number | null | undefined): number | null =>
      typeof x === 'number' ? Math.max(0, Math.min(1, x / 100)) : null;
    const num = (x: number | null | undefined): number | null =>
      typeof x === 'number' && Number.isFinite(x) ? x : null;
    // OpenMeteo (timezone=GMT) returns timestamps without an offset, e.g.
    // "2026-06-23T11:00". Force explicit UTC so Date.parse is unambiguous
    // regardless of the container clock (the design uses UTC everywhere).
    const toUtcIso = (t: string): string => {
      if (/[zZ]$|[+-]\d\d:?\d\d$/.test(t)) {
        return new Date(t).toISOString();
      }
      return new Date(`${t}Z`).toISOString();
    };
    if (h?.time !== undefined) {
      this.forecastSeries = h.time.map((ts, i) => ({
        ts: toUtcIso(ts),
        tempC: num(h.temperature_2m?.[i]),
        apparentTempC: num(h.apparent_temperature?.[i]),
        humidity01: c01(h.relative_humidity_2m?.[i]),
        cloudCover01: c01(h.cloud_cover?.[i]),
        radiationWm2: num(h.shortwave_radiation?.[i]),
        precipMm: num(h.precipitation?.[i]),
        precipProb01: c01(h.precipitation_probability?.[i]),
        uvIndex: num(h.uv_index?.[i]),
        windMs: num(h.wind_speed_10m?.[i]),
        weatherCode: num(h.weather_code?.[i]),
        et0Mm: num(h.et0_fao_evapotranspiration?.[i]),
      }));
    }
    // 15-minute nowcast (near-term, high resolution; Central Europe).
    const m = data.minutely_15;
    if (m?.time !== undefined) {
      this.nowcastSeries = m.time.map((ts, i) => ({
        ts: toUtcIso(ts),
        tempC: num(m.temperature_2m?.[i]),
        radiationWm2: num(m.shortwave_radiation?.[i]),
        directRadiationWm2: num(m.direct_radiation?.[i]),
        precipMm: num(m.precipitation?.[i]),
        weatherCode: num(m.weather_code?.[i]),
        isDay:
          typeof m.is_day?.[i] === 'number' ? (m.is_day![i] as number) > 0 : null,
      }));
    }
    // Daily summary (sunrise/sunset, UV/precip extremes).
    const dd = data.daily;
    if (dd?.sunrise !== undefined) {
      this.dailySummary = dd.sunrise.map((sr, i) => ({
        date: sr.slice(0, 10),
        tempMaxC: num(dd.temperature_2m_max?.[i]),
        tempMinC: num(dd.temperature_2m_min?.[i]),
        sunrise: toUtcIso(sr),
        sunset: dd.sunset?.[i] !== undefined ? toUtcIso(dd.sunset[i]!) : null,
        uvIndexMax: num(dd.uv_index_max?.[i]),
        precipProbMax01: c01(dd.precipitation_probability_max?.[i]),
      }));
    }
    // Irrigation drivers: today's ET0 + precipitation sums, current soil state.
    this.et0TodayMm = num(dd?.et0_fao_evapotranspiration?.[0]);
    this.rainTodayMm = num(dd?.precipitation_sum?.[0]);
    this.soilTempC = num(current?.soil_temperature_6cm);
    this.soilMoistureVol = num(current?.soil_moisture_3_to_9cm);
    this.consecutiveFailures = 0;
    this.lastSuccess = observedAt;
    this.lastError = null;
    if (!this.sourceOk) {
      this.sourceOk = true;
      this.emit('sourceRecovered', { ts: observedAt });
    }
  }

  private recordFailure(message: string): void {
    const ts = this.now();
    this.consecutiveFailures += 1;
    this.lastError = { message, ts };
    if (this.sourceOk && this.consecutiveFailures >= this.failureThreshold) {
      this.sourceOk = false;
      this.emit('sourceUnavailable', { message, ts });
    }
  }

  private describeError(err: unknown, fallback: string): string {
    if (err instanceof Error) {
      if (err.name === 'AbortError') {
        return `timeout after ${this.httpTimeoutMs}ms`;
      }
      return err.message.length > 0 ? err.message : fallback;
    }
    return fallback;
  }
}
