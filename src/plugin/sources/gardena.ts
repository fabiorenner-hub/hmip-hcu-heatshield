/**
 * Heat Shield — GARDENA smart system cloud adapter.
 *
 * Direct integration with the Husqvarna/GARDENA cloud API
 * (`api.smart.gardena.dev`) so Heat Shield reads sensors and controls valves
 * itself, using the user's own Application key + secret — no separate Gardena
 * Connect plugin on the HCU required.
 *
 * API contract (verified against the official GARDENA developer API and the
 * canonical `py-smart-gardena` reference client):
 *
 *   - Auth: `POST https://api.authentication.husqvarnagroup.dev/v1/oauth2/token`
 *     `grant_type=client_credentials&client_id&client_secret` (form-encoded)
 *     → `{ access_token, expires_in }`.
 *   - API base: `https://api.smart.gardena.dev/v2`. Every request carries
 *     `Authorization: Bearer <token>`, `Authorization-Provider: husqvarna`,
 *     `X-Api-Key: <clientId>`. Writes add `Content-Type:
 *     application/vnd.api+json`.
 *   - `GET /locations` → `{ data: [{ id, type:"LOCATION", attributes }] }`.
 *   - `GET /locations/{id}` → `{ included: [{ id:"<realId>:<svc>", type,
 *     attributes }] }`. Service types: COMMON, SENSOR, VALVE, VALVE_SET,
 *     MOWER, POWER_SOCKET, DEVICE.
 *   - `POST /websocket` `{ data:{ type:"WEBSOCKET", attributes:{ locationId },
 *     id } }` → `{ data:{ attributes:{ url } } }`. Connect; messages are single
 *     service objects (incremental attribute updates) or LOCATION.
 *   - Control: `PUT /command/{valveServiceId}` `{ data:{ id, type:
 *     "VALVE_CONTROL", attributes:{ command, seconds? } } }`. HTTP 202 = ok.
 *     `START_SECONDS_TO_OVERRIDE` (with `seconds`) opens; `STOP_UNTIL_NEXT_TASK`
 *     closes.
 *
 * Attribute values are wrapped: `attributes[name] = { value, timestamp }`.
 *
 * Resilience: token auto-refresh on near-expiry and on 401; websocket
 * reconnect with capped backoff (the ws url expires after ~2 h, so a
 * reconnect re-fetches it). All network work is wrapped so a transient
 * failure never throws into the engine — `getStatus()` surfaces health.
 */

import WebSocket from 'ws';

import type { GardenaConfig } from '../../shared/types.js';

// ---------------------------------------------------------------------------
// Public normalized models.
// ---------------------------------------------------------------------------

export interface GardenaSensor {
  /** Stable device id (the part before ":" in service ids). */
  deviceId: string;
  name: string;
  soilHumidityPct: number | null;
  soilTempC: number | null;
  ambientTempC: number | null;
  lightLux: number | null;
  batteryPct: number | null;
}

export interface GardenaValve {
  /** Stable device id (the part before ":" in service ids). */
  deviceId: string;
  /** The VALVE *service* id — the exact target for control commands. */
  serviceId: string;
  name: string;
  /** Raw GARDENA activity, e.g. CLOSED / MANUAL_WATERING / SCHEDULED_WATERING. */
  activity: string | null;
  /** Derived watering state (activity contains "WATERING"). */
  on: boolean;
  batteryPct: number | null;
}

export interface GardenaStatus {
  enabled: boolean;
  connected: boolean;
  lastSuccess: string | null;
  lastError: string | null;
  sensorCount: number;
  valveCount: number;
}

export interface GardenaTestResult {
  ok: boolean;
  locations: number;
  sensors: number;
  valves: number;
  error?: string;
  /** Diagnostic: raw service inventory (type + attribute keys) per service. */
  services?: Array<{ id: string; type: string; attrs: string[] }>;
}

type Logger = (
  level: 'info' | 'warn' | 'error',
  msg: string,
  ctx?: Record<string, unknown>,
) => void;

export interface GardenaAdapterOptions {
  config: GardenaConfig;
  logger?: Logger;
  now?: () => Date;
  /** Test seam for the REST calls. */
  fetchFn?: typeof globalThis.fetch;
  /** Test seam for the websocket. Defaults to the `ws` package. */
  wsFactory?: (url: string) => MinimalWs;
}

/** Minimal websocket surface the adapter uses (subset of `ws`). */
export interface MinimalWs {
  on(event: 'open' | 'message' | 'close' | 'error', cb: (arg?: unknown) => void): void;
  close(): void;
}

// ---------------------------------------------------------------------------
// Constants.
// ---------------------------------------------------------------------------

const AUTH_HOST = 'https://api.authentication.husqvarnagroup.dev';
const SMART_HOST = 'https://api.smart.gardena.dev';
const TOKEN_PATH = '/v1/oauth2/token';
const REQUEST_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Internal state.
// ---------------------------------------------------------------------------

interface ServiceEntry {
  realId: string;
  type: string;
  attributes: Record<string, { value: unknown }>;
}

// ---------------------------------------------------------------------------
// Adapter.
// ---------------------------------------------------------------------------

export class GardenaCloudAdapter {
  private readonly cfg: GardenaConfig;
  private readonly logger: Logger | null;
  private readonly now: () => Date;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly wsFactory: (url: string) => MinimalWs;

  private token: string | null = null;
  private tokenExpiresAt = 0;
  private locationId: string | null = null;
  private readonly services = new Map<string, ServiceEntry>();

  private ws: MinimalWs | null = null;
  private stopping = false;
  private started = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private wsConnected = false;

  private lastSuccess: Date | null = null;
  private lastError: string | null = null;

  public constructor(options: GardenaAdapterOptions) {
    this.cfg = options.config;
    this.logger = options.logger ?? null;
    this.now = options.now ?? ((): Date => new Date());
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.wsFactory =
      options.wsFactory ??
      ((url: string): MinimalWs =>
        new WebSocket(url) as unknown as MinimalWs);
  }

  // -------------------------------------------------------------------------
  // Lifecycle.
  // -------------------------------------------------------------------------

  /**
   * Begin the connect → load → websocket sequence. Fire-and-forget: errors are
   * captured in `getStatus().lastError` and retried via the reconnect loop.
   * No-op when the adapter is disabled or missing credentials.
   */
  public start(): void {
    if (this.started) return;
    if (!this.cfg.enabled || this.cfg.clientId === '' || this.cfg.clientSecret === '') {
      return;
    }
    this.started = true;
    this.stopping = false;
    void this.bootstrap();
  }

  public stop(): void {
    this.stopping = true;
    this.started = false;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.closeWs();
  }

  // -------------------------------------------------------------------------
  // Public reads.
  // -------------------------------------------------------------------------

  public getStatus(): GardenaStatus {
    return {
      enabled: this.cfg.enabled,
      connected: this.wsConnected,
      lastSuccess: this.lastSuccess?.toISOString() ?? null,
      lastError: this.lastError,
      sensorCount: this.listSensors().length,
      valveCount: this.listValves().length,
    };
  }

  public listSensors(): GardenaSensor[] {
    const byDevice = this.groupByDevice();
    const out: GardenaSensor[] = [];
    for (const [deviceId, svcs] of byDevice) {
      // Detect a soil/climate sensor by the presence of any of its telemetry
      // attributes on ANY service of the device — not by a fixed service-type
      // label. GARDENA has shipped soil sensors under more than one service
      // type; keying off the data is robust against that.
      const sensorSvc = svcs.find(
        (s) =>
          'soilHumidity' in s.attributes ||
          'soilTemperature' in s.attributes ||
          'ambientTemperature' in s.attributes ||
          'lightIntensity' in s.attributes,
      );
      if (sensorSvc === undefined) continue;
      const common = svcs.find((s) => s.type === 'COMMON');
      out.push({
        deviceId,
        name: attrStr(common?.attributes, 'name') ?? attrStr(sensorSvc.attributes, 'name') ?? deviceId,
        soilHumidityPct: attrNum(sensorSvc.attributes, 'soilHumidity'),
        soilTempC: attrNum(sensorSvc.attributes, 'soilTemperature'),
        ambientTempC: attrNum(sensorSvc.attributes, 'ambientTemperature'),
        lightLux: attrNum(sensorSvc.attributes, 'lightIntensity'),
        batteryPct: attrNum(common?.attributes, 'batteryLevel'),
      });
    }
    return out.sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  }

  /**
   * Diagnostic: every cached service as `{ id, type, attrs }` so we can see
   * exactly what GARDENA returns (used by the test endpoint to debug missing
   * sensors). `attrs` is the list of attribute keys present.
   */
  public listRawServices(): Array<{ id: string; type: string; attrs: string[] }> {
    const out: Array<{ id: string; type: string; attrs: string[] }> = [];
    for (const [id, svc] of this.services) {
      out.push({ id, type: svc.type, attrs: Object.keys(svc.attributes) });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  public listValves(): GardenaValve[] {
    const out: GardenaValve[] = [];
    for (const [serviceId, svc] of this.services) {
      if (svc.type !== 'VALVE') continue;
      const common = this.findCommon(svc.realId);
      const activity = attrStr(svc.attributes, 'activity');
      const valveName =
        attrStr(svc.attributes, 'name') ??
        attrStr(common?.attributes, 'name') ??
        svc.realId;
      out.push({
        deviceId: svc.realId,
        serviceId,
        name: valveName,
        activity,
        on: activity !== null && /WATERING/i.test(activity),
        batteryPct: attrNum(common?.attributes, 'batteryLevel'),
      });
    }
    return out.sort((a, b) => a.serviceId.localeCompare(b.serviceId));
  }

  /** True when `serviceId` is a VALVE service known to this adapter. */
  public hasValve(serviceId: string): boolean {
    return this.services.get(serviceId)?.type === 'VALVE';
  }

  /**
   * Close every open valve except `exceptServiceId`. Used to enforce the
   * "only one valve open at a time" rule on a shared water supply before
   * opening a new one. Best-effort: failures per valve are logged, not thrown.
   */
  public async closeOtherValves(exceptServiceId: string): Promise<void> {
    const open = this.listValves().filter((v) => v.on && v.serviceId !== exceptServiceId);
    for (const v of open) {
      try {
        await this.setValve(v.serviceId, false);
      } catch (err) {
        this.log('warn', 'closeOtherValves failed', {
          serviceId: v.serviceId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Control.
  // -------------------------------------------------------------------------

  /**
   * Open (`on=true`, runs for `seconds`) or close (`on=false`) a valve.
   * `seconds` defaults to the configured `defaultWateringSeconds`.
   */
  public async setValve(
    serviceId: string,
    on: boolean,
    seconds?: number,
  ): Promise<void> {
    const duration = seconds ?? this.cfg.defaultWateringSeconds;
    await this.sendCommand(
      serviceId,
      'VALVE_CONTROL',
      on ? 'START_SECONDS_TO_OVERRIDE' : 'STOP_UNTIL_NEXT_TASK',
      on ? duration : undefined,
    );
    // Optimistically reflect the command so the dashboard updates before the
    // websocket pushes the confirming activity change.
    const svc = this.services.get(serviceId);
    if (svc !== undefined) {
      svc.attributes['activity'] = {
        value: on ? 'MANUAL_WATERING' : 'CLOSED',
      };
    }
  }

  /**
   * Switch a Gardena POWER_SOCKET (e.g. an irrigation pump) on or off via
   * `POWER_SOCKET_CONTROL` (spec/py-smart-gardena verified). `seconds`
   * defaults to the configured watering duration.
   */
  public async setPowerSocket(
    serviceId: string,
    on: boolean,
    seconds?: number,
  ): Promise<void> {
    const duration = seconds ?? this.cfg.defaultWateringSeconds;
    await this.sendCommand(
      serviceId,
      'POWER_SOCKET_CONTROL',
      on ? 'START_SECONDS_TO_OVERRIDE' : 'STOP_UNTIL_NEXT_TASK',
      on ? duration : undefined,
    );
  }

  /** Park the Gardena MOWER until its next scheduled task (`MOWER_CONTROL`). */
  public async parkMower(serviceId: string): Promise<void> {
    await this.sendCommand(serviceId, 'MOWER_CONTROL', 'PARK_UNTIL_NEXT_TASK');
  }

  /** Resume the Gardena MOWER's schedule (`START_DONT_OVERRIDE`). */
  public async resumeMower(serviceId: string): Promise<void> {
    await this.sendCommand(serviceId, 'MOWER_CONTROL', 'START_DONT_OVERRIDE');
  }

  /**
   * True when any MOWER service is currently cutting/leaving the dock — used
   * to gate watering (don't irrigate while the mower is out). When
   * `serviceId` is given, checks only that mower.
   */
  public isMowerActive(serviceId?: string): boolean {
    for (const [id, svc] of this.services) {
      if (svc.type !== 'MOWER') continue;
      if (serviceId !== undefined && id !== serviceId) continue;
      const activity = attrStr(svc.attributes, 'activity');
      if (activity !== null && /CUTTING|LEAVING|MOWING/i.test(activity)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Send a Gardena control command. `type` is the service control type
   * (`VALVE_CONTROL`, `POWER_SOCKET_CONTROL`, `MOWER_CONTROL`); `seconds` is
   * included only when defined. HTTP 202 = accepted.
   */
  private async sendCommand(
    serviceId: string,
    type: string,
    command: string,
    seconds?: number,
  ): Promise<void> {
    const attributes: Record<string, unknown> =
      seconds !== undefined ? { command, seconds } : { command };
    const body = { data: { id: `heatshield-${Date.now()}`, type, attributes } };
    await this.apiFetch(`${SMART_HOST}/v2/command/${encodeURIComponent(serviceId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/vnd.api+json' },
      body: JSON.stringify(body),
      expectStatus: 202,
    });
  }

  /**
   * One-shot connectivity test: authenticate, list locations, load the chosen
   * (or first) location's devices. Returns counts so the UI can confirm the
   * key works. Does not touch the long-lived websocket.
   */
  public async testConnection(): Promise<GardenaTestResult> {
    try {
      await this.authenticate();
      const locations = await this.fetchLocations();
      if (locations.length === 0) {
        return { ok: false, locations: 0, sensors: 0, valves: 0, error: 'Keine Location gefunden' };
      }
      const locId = this.pickLocationId(locations);
      await this.loadDevices(locId);
      return {
        ok: true,
        locations: locations.length,
        sensors: this.listSensors().length,
        valves: this.listValves().length,
        services: this.listRawServices(),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, locations: 0, sensors: 0, valves: 0, error: msg };
    }
  }

  // -------------------------------------------------------------------------
  // Bootstrap + websocket loop.
  // -------------------------------------------------------------------------

  private async bootstrap(): Promise<void> {
    try {
      await this.authenticate();
      const locations = await this.fetchLocations();
      if (locations.length === 0) {
        this.lastError = 'Keine GARDENA-Location gefunden';
        return;
      }
      this.locationId = this.pickLocationId(locations);
      await this.loadDevices(this.locationId);
      this.lastSuccess = this.now();
      await this.openWebsocket();
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.log('warn', 'gardena bootstrap failed', { error: this.lastError });
      this.scheduleReconnect();
    }
  }

  private async openWebsocket(): Promise<void> {
    if (this.stopping || this.locationId === null) return;
    const url = await this.fetchWebsocketUrl(this.locationId);
    const ws = this.wsFactory(url);
    this.ws = ws;
    ws.on('open', () => {
      this.wsConnected = true;
      this.reconnectAttempt = 0;
      this.lastSuccess = this.now();
      this.log('info', 'gardena websocket open');
    });
    ws.on('message', (data) => {
      this.handleWsMessage(data);
    });
    ws.on('close', () => {
      this.wsConnected = false;
      this.log('warn', 'gardena websocket closed');
      this.scheduleReconnect();
    });
    ws.on('error', (err) => {
      this.wsConnected = false;
      this.lastError =
        err instanceof Error ? err.message : 'websocket error';
      this.log('warn', 'gardena websocket error', { error: this.lastError });
    });
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.reconnectTimer !== null) return;
    this.reconnectAttempt += 1;
    const delayMs = Math.min(60_000, 5_000 * this.reconnectAttempt);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.closeWs();
      void this.bootstrap();
    }, delayMs);
  }

  private closeWs(): void {
    if (this.ws !== null) {
      try {
        this.ws.close();
      } catch {
        /* already gone */
      }
      this.ws = null;
    }
    this.wsConnected = false;
  }

  private handleWsMessage(data: unknown): void {
    let text: string;
    if (typeof data === 'string') {
      text = data;
    } else if (data instanceof Buffer) {
      text = data.toString('utf8');
    } else {
      text = String(data);
    }
    if (text.length === 0) return;
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg === null || typeof msg !== 'object') return;
    const obj = msg as Record<string, unknown>;
    const id = obj['id'];
    const type = obj['type'];
    if (typeof id !== 'string' || typeof type !== 'string') return;
    const realId = id.split(':')[0] ?? id;
    const attrs = obj['attributes'];
    const existing = this.services.get(id);
    const merged: ServiceEntry = existing ?? {
      realId,
      type,
      attributes: {},
    };
    if (attrs !== null && typeof attrs === 'object') {
      for (const [k, v] of Object.entries(attrs as Record<string, unknown>)) {
        if (v !== null && typeof v === 'object' && 'value' in (v as object)) {
          merged.attributes[k] = { value: (v as { value: unknown }).value };
        }
      }
    }
    this.services.set(id, merged);
  }

  // -------------------------------------------------------------------------
  // REST calls.
  // -------------------------------------------------------------------------

  private async authenticate(): Promise<void> {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
    });
    const res = await this.timedFetch(`${AUTH_HOST}${TOKEN_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) {
      throw new Error(`Authentifizierung fehlgeschlagen (HTTP ${res.status})`);
    }
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (typeof json.access_token !== 'string') {
      throw new Error('Token-Antwort ohne access_token');
    }
    this.token = json.access_token;
    const ttlSec = typeof json.expires_in === 'number' ? json.expires_in : 3600;
    this.tokenExpiresAt = this.now().getTime() + Math.max(60, ttlSec - 60) * 1000;
  }

  private async ensureToken(): Promise<void> {
    if (this.token === null || this.now().getTime() >= this.tokenExpiresAt) {
      await this.authenticate();
    }
  }

  private async fetchLocations(): Promise<Array<{ id: string; name: string }>> {
    const json = await this.apiFetchJson(`${SMART_HOST}/v2/locations`);
    const data = (json as { data?: unknown }).data;
    if (!Array.isArray(data)) return [];
    const out: Array<{ id: string; name: string }> = [];
    for (const entry of data) {
      if (entry === null || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      const id = e['id'];
      if (typeof id !== 'string') continue;
      const attrs = e['attributes'];
      const name =
        attrs !== null && typeof attrs === 'object' && typeof (attrs as Record<string, unknown>)['name'] === 'string'
          ? ((attrs as Record<string, unknown>)['name'] as string)
          : id;
      out.push({ id, name });
    }
    return out;
  }

  private pickLocationId(locations: Array<{ id: string; name: string }>): string {
    if (this.cfg.locationId !== '') {
      const match = locations.find((l) => l.id === this.cfg.locationId);
      if (match !== undefined) return match.id;
    }
    return locations[0]!.id;
  }

  private async loadDevices(locationId: string): Promise<void> {
    const json = await this.apiFetchJson(`${SMART_HOST}/v2/locations/${encodeURIComponent(locationId)}`);
    const included = (json as { included?: unknown }).included;
    if (!Array.isArray(included)) return;
    this.services.clear();
    for (const entry of included) {
      if (entry === null || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      const id = e['id'];
      const type = e['type'];
      if (typeof id !== 'string' || typeof type !== 'string') continue;
      // Store every service type — do NOT drop "unknown" types: GARDENA soil
      // sensors have shipped under varying service types, and dropping them
      // here is what hid the moisture sensor. Sensors are detected by their
      // attributes (see listSensors), valves by type === 'VALVE'.
      const realId = id.split(':')[0] ?? id;
      const attributes: Record<string, { value: unknown }> = {};
      const attrs = e['attributes'];
      if (attrs !== null && typeof attrs === 'object') {
        for (const [k, v] of Object.entries(attrs as Record<string, unknown>)) {
          if (v !== null && typeof v === 'object' && 'value' in (v as object)) {
            attributes[k] = { value: (v as { value: unknown }).value };
          }
        }
      }
      this.services.set(id, { realId, type, attributes });
    }
  }

  private async fetchWebsocketUrl(locationId: string): Promise<string> {
    const body = {
      data: {
        type: 'WEBSOCKET',
        attributes: { locationId },
        id: `heatshield-${Date.now()}`,
      },
    };
    const json = await this.apiFetchJson(`${SMART_HOST}/v2/websocket`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/vnd.api+json' },
      body: JSON.stringify(body),
    });
    const url = (json as { data?: { attributes?: { url?: unknown } } }).data?.attributes?.url;
    if (typeof url !== 'string') {
      throw new Error('Websocket-URL fehlt in der Antwort');
    }
    return url;
  }

  // -------------------------------------------------------------------------
  // Fetch helpers.
  // -------------------------------------------------------------------------

  private async apiFetchJson(
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string } = {},
  ): Promise<unknown> {
    const res = await this.apiFetch(url, init);
    return res.json();
  }

  private async apiFetch(
    url: string,
    init: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      expectStatus?: number;
    } = {},
  ): Promise<Response> {
    await this.ensureToken();
    const doFetch = async (): Promise<Response> =>
      this.timedFetch(url, {
        method: init.method ?? 'GET',
        headers: {
          Authorization: `Bearer ${this.token ?? ''}`,
          'Authorization-Provider': 'husqvarna',
          'X-Api-Key': this.cfg.clientId,
          ...(init.headers ?? {}),
        },
        ...(init.body !== undefined ? { body: init.body } : {}),
      });
    let res = await doFetch();
    if (res.status === 401) {
      // Token likely expired early — refresh once and retry.
      await this.authenticate();
      res = await doFetch();
    }
    const expected = init.expectStatus ?? 200;
    if (res.status !== expected && !(expected === 200 && res.ok)) {
      this.lastError = `GARDENA API HTTP ${res.status}`;
      throw new Error(this.lastError);
    }
    this.lastSuccess = this.now();
    this.lastError = null;
    return res;
  }

  private async timedFetch(
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await this.fetchFn(url, {
        method: init.method,
        headers: init.headers,
        ...(init.body !== undefined ? { body: init.body } : {}),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  // -------------------------------------------------------------------------
  // Model helpers.
  // -------------------------------------------------------------------------

  private groupByDevice(): Map<string, ServiceEntry[]> {
    const out = new Map<string, ServiceEntry[]>();
    for (const svc of this.services.values()) {
      const arr = out.get(svc.realId) ?? [];
      arr.push(svc);
      out.set(svc.realId, arr);
    }
    return out;
  }

  private findCommon(realId: string): ServiceEntry | undefined {
    for (const svc of this.services.values()) {
      if (svc.realId === realId && svc.type === 'COMMON') return svc;
    }
    return undefined;
  }

  private log(level: 'info' | 'warn' | 'error', msg: string, ctx?: Record<string, unknown>): void {
    if (this.logger === null) return;
    try {
      this.logger(level, msg, ctx);
    } catch {
      /* logger must never break the adapter */
    }
  }
}

// ---------------------------------------------------------------------------
// Attribute helpers.
// ---------------------------------------------------------------------------

function attrNum(
  attrs: Record<string, { value: unknown }> | undefined,
  name: string,
): number | null {
  const v = attrs?.[name]?.value;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function attrStr(
  attrs: Record<string, { value: unknown }> | undefined,
  name: string,
): string | null {
  const v = attrs?.[name]?.value;
  return typeof v === 'string' && v.length > 0 ? v : null;
}
