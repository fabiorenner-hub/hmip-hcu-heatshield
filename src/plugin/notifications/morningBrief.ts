/**
 * Heat Shield — morning brief scheduler (smart-shading-notifications Task 9).
 *
 * Sends one daily weather/day-ahead preview at a configured local time
 * (Requirement 8.3). Idempotency is guaranteed by a persisted "last brief
 * day" marker keyed on the **local** calendar date (timezone from
 * `config.location`), so a restart or a second cycle on the same day never
 * double-sends, and a DST shift cannot trigger a duplicate.
 *
 * The scheduler does not know how to build the brief content — the caller
 * passes a `buildBrief` callback that turns the current forecast snapshot
 * into `{ title, body }` (or `null` to skip when no data is available). The
 * scheduler owns only the timing + idempotency.
 *
 * The marker is persisted to a tiny JSON file (`/data/morning-brief.json`)
 * via the shared atomic writer.
 */

import { promises as fs } from 'node:fs';

import { atomicWriteJson } from '../persistence/_atomic.js';
import type { NotificationService } from './service.js';

export const DEFAULT_MORNING_BRIEF_MARKER_PATH = '/data/morning-brief.json';

export interface MorningBriefContent {
  title: string;
  body: string;
}

export interface MorningBriefDeps {
  /** Local time-of-day "HH:MM" (24h) at which the brief is sent. */
  localTime: string;
  /** IANA timezone from `config.location.timezone`. */
  timezone: string;
  /** Marker file path; defaults to `/data/morning-brief.json`. */
  markerPath?: string;
  /** Injectable clock. Defaults to `() => new Date()`. */
  now?: () => Date;
}

interface MarkerFile {
  lastBriefDay: string | null;
}

function parseHhMm(hhmm: string): number {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/u.exec(hhmm);
  if (m === null) {
    return 7 * 60 + 30; // safe default 07:30 if misconfigured
  }
  return Number.parseInt(m[1]!, 10) * 60 + Number.parseInt(m[2]!, 10);
}

/** Local wall-clock day string `YYYY-MM-DD` and minutes-of-day in `timezone`. */
function localDayAndMinutes(
  instant: Date,
  timezone: string,
): { day: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(instant);
  let year = '';
  let month = '';
  let day = '';
  let hour = 0;
  let minute = 0;
  for (const p of parts) {
    switch (p.type) {
      case 'year':
        year = p.value;
        break;
      case 'month':
        month = p.value;
        break;
      case 'day':
        day = p.value;
        break;
      case 'hour':
        hour = Number.parseInt(p.value, 10) % 24;
        break;
      case 'minute':
        minute = Number.parseInt(p.value, 10);
        break;
      default:
        break;
    }
  }
  return { day: `${year}-${month}-${day}`, minutes: hour * 60 + minute };
}

/**
 * Daily morning-brief scheduler. Construct once, `await load()` on boot, then
 * call `maybeSend(...)` each cycle; it sends at most once per local day.
 */
export class MorningBriefScheduler {
  private readonly localTimeMinutes: number;

  private readonly timezone: string;

  private readonly markerPath: string;

  private readonly now: () => Date;

  private lastBriefDay: string | null = null;

  constructor(deps: MorningBriefDeps) {
    this.localTimeMinutes = parseHhMm(deps.localTime);
    this.timezone = deps.timezone;
    this.markerPath = deps.markerPath ?? DEFAULT_MORNING_BRIEF_MARKER_PATH;
    this.now = deps.now ?? ((): Date => new Date());
  }

  /** Rehydrate the marker from disk (best-effort; missing/corrupt → null). */
  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.markerPath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<MarkerFile>;
      this.lastBriefDay =
        typeof parsed.lastBriefDay === 'string' ? parsed.lastBriefDay : null;
    } catch {
      this.lastBriefDay = null;
    }
  }

  /** The persisted "last sent" local day, or null. */
  getLastBriefDay(): string | null {
    return this.lastBriefDay;
  }

  /**
   * Send the morning brief if the local time has reached the configured
   * time and it has not yet been sent today. Returns `true` iff a brief was
   * sent this call. `buildBrief` is only invoked when the timing gate passes;
   * returning `null` from it skips sending without burning the day marker.
   */
  async maybeSend(
    service: NotificationService,
    buildBrief: () => MorningBriefContent | null,
  ): Promise<boolean> {
    const { day, minutes } = localDayAndMinutes(this.now(), this.timezone);
    if (this.lastBriefDay === day) {
      return false;
    }
    if (minutes < this.localTimeMinutes) {
      return false;
    }
    const content = buildBrief();
    if (content === null) {
      return false;
    }
    await service.emit('weather', content.title, content.body, 'weather');
    this.lastBriefDay = day;
    await this.persistMarker();
    return true;
  }

  private async persistMarker(): Promise<void> {
    const payload: MarkerFile = { lastBriefDay: this.lastBriefDay };
    await atomicWriteJson(this.markerPath, payload);
  }
}
