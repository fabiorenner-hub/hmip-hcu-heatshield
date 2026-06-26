/**
 * Shared formatting helpers for the dashboard SPA.
 *
 * Goal: show human-readable German labels everywhere, never raw
 * device UUIDs/SGTINs alone. A device is shown as
 * `"<friendlyName> (…ABCD)"` where ABCD are the last four ID chars,
 * which is what the user reads off the HMIP app / device label.
 */

import { t } from './i18n.js';

export interface DeviceLike {
  deviceId: string;
  friendlyName?: string;
  deviceType?: string;
}

/** Last 4 characters of a device id (the bit users recognise). */
export function shortId(deviceId: string): string {
  return deviceId.length <= 4 ? deviceId : deviceId.slice(-4);
}

/**
 * Clear label for a device: friendly name + last-4 id in parens.
 * Falls back to the short id when there is no friendly name.
 */
export function deviceLabel(d: DeviceLike): string {
  const tail = `(…${shortId(d.deviceId)})`;
  if (d.friendlyName !== undefined && d.friendlyName.length > 0) {
    return `${d.friendlyName} ${tail}`;
  }
  return `Gerät ${tail}`;
}

/** Compass label for an orientation in degrees (0 = N, clockwise). Bilingual. */
export function compassLabel(deg: number): string {
  const de = ['N', 'NO', 'O', 'SO', 'S', 'SW', 'W', 'NW'];
  const en = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const idx = Math.round((((deg % 360) + 360) % 360) / 45) % 8;
  return t(de[idx] ?? 'S', en[idx] ?? 'S');
}

/** Format a cached feature value for compact display. */
export function formatValue(v: string | number | boolean | undefined): string {
  if (v === undefined) return '–';
  if (typeof v === 'number') return String(Math.round(v * 1000) / 1000);
  if (typeof v === 'boolean') return v ? 'ja' : 'nein';
  return v;
}

/** German labels for the four room target temperatures. */
export const TARGET_LABELS: Record<string, string> = {
  target_c: 'Zieltemperatur',
  warning_c: 'Warnschwelle',
  strong_shade_c: 'Starke Beschattung',
  critical_c: 'Kritisch (max.)',
};

/** German labels for room priorities. */
export const PRIORITY_LABELS: Record<string, string> = {
  very_high: 'Sehr hoch',
  high: 'Hoch',
  medium: 'Mittel',
  low: 'Niedrig',
};

/** German labels for window types. */
export const WINDOW_TYPE_LABELS: Record<string, string> = {
  facade: 'Fassade',
  roof_window: 'Dachfenster',
};

/** German labels for the engine FSM modes. */
export const MODE_LABELS_DE: Record<string, string> = {
  NORMAL: 'Normal',
  SUMMER_WATCH: 'Sommer-Beobachtung',
  ACTIVE_HEAT_PROTECTION: 'Aktiver Hitzeschutz',
  HEATWAVE: 'Hitzewelle',
  NIGHT_COOLING: 'Nachtkühlung',
  STORM: 'Sturm',
  VACATION: 'Urlaub',
  MAINTENANCE: 'Wartung',
};

/** German labels for the SSE connection state pill. */
export const CONNECTION_LABELS_DE: Record<string, string> = {
  connecting: 'verbinde…',
  open: 'live',
  reconnecting: 'verbinde neu…',
  closed: 'offline',
};

/**
 * Human display name for a snapshot window. Prefers the server-built
 * "<Raum> – <Gerät> (…1234)" label; falls back to "Fenster (…1234)".
 */
export function windowDisplayName(w: { id: string; name?: string }): string {
  if (w.name !== undefined && w.name.length > 0) {
    return w.name;
  }
  return `Fenster (…${shortId(w.id)})`;
}

/** Signal-freshness states surfaced by the dashboard snapshot. */
export type StalenessState = 'fresh' | 'soon' | 'stale' | 'unknown';

/** German labels for signal freshness. */
export const STALENESS_LABELS: Record<StalenessState, string> = {
  fresh: 'aktuell',
  soon: 'bald veraltet',
  stale: 'veraltet',
  unknown: 'unbekannt',
};

/**
 * Presentation for a freshness dot: a CSS modifier + German label.
 * Reused by the sources table and the 360° overview tiles so the
 * colour semantics stay identical everywhere.
 */
export function stalenessDot(state: StalenessState | undefined): {
  cssClass: string;
  label: string;
} {
  const s: StalenessState = state ?? 'unknown';
  return { cssClass: `staleness-dot staleness-dot--${s}`, label: STALENESS_LABELS[s] };
}

/** Format a signal value with a unit, or an em-dash when absent. */
export function formatSignal(
  value: number | null | undefined,
  unit: string,
  digits = 1,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '–';
  }
  const factor = 10 ** digits;
  const rounded = Math.round(value * factor) / factor;
  return `${rounded} ${unit}`.trim();
}

/** m/s → km/h conversion factor. Wind is shown system-wide in km/h. */
export const MS_TO_KMH = 3.6;

/**
 * Format a wind speed (stored internally in m/s) as km/h — the system-wide
 * display unit for wind. Returns an em-dash when absent.
 */
export function formatWindKmh(
  ms: number | null | undefined,
  digits = 0,
): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) {
    return '–';
  }
  return formatSignal(ms * MS_TO_KMH, 'km/h', digits);
}
