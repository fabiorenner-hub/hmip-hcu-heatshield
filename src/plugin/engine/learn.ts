/**
 * Heat Shield — Phase-2 lernlogik (Tasks 14.1 / 14.2).
 *
 * The learning loop reads the engine's NDJSON history (decision
 * records produced by `engine/orchestrator.ts`) plus a stream of
 * room temperature samples, aggregates them into a per-room /
 * per-day "effective shade gain" metric, and turns the rolling
 * window of metrics into UI-facing recommendations.
 *
 * Steering (mirrored from `design.md` §22 and Requirements 10.1–10.3):
 *
 *   - The aggregation answers "how much °C/h did shading actually
 *     subtract from the room's natural temperature rise?" by
 *     comparing the slope of `tempC` in the 60 min BEFORE the first
 *     shading event of the day to the slope in the 60 min AFTER.
 *   - When `effective_shade_gain < 0.3 °C/h` over five consecutive
 *     days, the dashboard surfaces a recommendation to lift the
 *     `windows[*].sunPrelookMinutes` by 30 min.
 *   - **Lerncode darf NIE selbst in die Konfiguration schreiben.**
 *     This module produces patch *descriptions*. Applying a patch is
 *     a separate, user-confirmed round-trip via the dashboard apply
 *     endpoint (`POST /api/learn/recommendations/:id/apply`), which
 *     the boot module wires to the existing `PUT /api/config` path.
 *
 * Module rules (mirrored from sibling engine modules):
 *   - Pure functions, no fs, no logging, no Connect-API artefacts.
 *   - Strict TS, ESM, `.js` import suffixes.
 *   - Same inputs → same outputs; tests pin a deterministic UTC
 *     `now` for the recommendations layer.
 */

import type { HistoryRecord } from '../persistence/history.js';
import type {
  Config,
  DecisionRecord,
  Window,
} from '../../shared/types.js';

// ---------------------------------------------------------------------------
// Public types.
// ---------------------------------------------------------------------------

/**
 * One row of the daily aggregation, per (room, local-date) pair.
 *
 *   - `date` is the local-time calendar date in `yyyy-mm-dd`. The
 *     timezone is supplied via `options.timezone`; we never persist
 *     UTC dates because the dashboard / regelwerk reasons about
 *     "today" in the user's local time.
 *   - `firstShadeTimeIso` is the UTC ISO timestamp of the first
 *     decision record on that day where any of the room's windows
 *     crossed `finalTarget >= 0.5`. `null` when the day saw no
 *     shading event.
 *   - `preShadeRiseCph` / `postShadeRiseCph` are temperature rise
 *     rates in `°C / h`, computed as the least-squares slope of
 *     `tempC` over the 60 min before / after the first shade
 *     moment. `null` when the window held fewer than two samples
 *     (no slope possible).
 *   - `effectiveShadeGain = preShadeRiseCph − postShadeRiseCph`. A
 *     positive value means shading helped (post slope is shallower
 *     than pre slope); zero / negative means the shade did not
 *     observably improve the trajectory. `null` when either side is
 *     `null` or the day had no shading event.
 *   - `samplesPre` / `samplesPost` are the count of temperature
 *     samples used for each side. `0` when no samples were in the
 *     respective 60-min window (or no shading event).
 */
export interface DailyShadeMetrics {
  date: string;
  roomId: string;
  preShadeRiseCph: number | null;
  postShadeRiseCph: number | null;
  effectiveShadeGain: number | null;
  firstShadeTimeIso: string | null;
  samplesPre: number;
  samplesPost: number;
}

/**
 * Options for {@link aggregateDailyMetrics}.
 *
 *   - `timezone` is an IANA TZ identifier (e.g. `Europe/Berlin`)
 *     used to derive the local-date bucket and to find the
 *     local-day windows for the per-room sample slicing.
 *   - `windowsByRoom` resolves the cluster of windows that belong to
 *     a given room. The orchestrator's decision record is keyed by
 *     `windowId`; this map lets the aggregation locate the room's
 *     windows without reaching into the full Config.
 */
export interface AggregateDailyMetricsOptions {
  timezone: string;
  windowsByRoom: Record<string, string[]>;
}

/**
 * One temperature sample for the room used in the pre/post slope
 * computation. The orchestrator's snapshot already produces values
 * in this shape — the boot module replays them from the historical
 * snapshot stream / NDJSON history into this aggregation entry.
 */
export interface RoomTempSample {
  ts: string;
  roomId: string;
  tempC: number;
}

/**
 * One recommendation surfaced to the user. The `suggestedConfigPatch`
 * is informational — it lets the SPA render `current → suggested`
 * without applying anything. The actual apply round-trip happens via
 * `POST /api/learn/recommendations/:id/apply`, which the boot
 * module routes through the existing `PUT /api/config` path so the
 * persisted change is still validated by `safeParseConfig`.
 */
export interface LearningRecommendation {
  id: string;
  roomId: string;
  severity: 'info' | 'warn';
  title: string;
  message: string;
  createdAt: string;
  suggestedConfigPatch?: {
    path: (string | number)[];
    from: unknown;
    to: unknown;
  };
}

/**
 * Top-level snapshot of the learning state. The dashboard server
 * publishes this through `GET /api/learn/snapshot`.
 */
export interface LearningSnapshot {
  metrics: DailyShadeMetrics[];
  recommendations: LearningRecommendation[];
  computedAt: string;
}

/**
 * Options for {@link deriveRecommendations}.
 *
 *   - `now` is the wall-clock instant used to stamp `createdAt` on
 *     emitted recommendations. Tests pin a deterministic UTC value.
 *   - `minDays` is the rolling-window length (default 5) for both
 *     branches: the warn streak counter uses `>= minDays`, and the
 *     info recommendation averages `effective_shade_gain` over the
 *     same `minDays`-sized recent window.
 */
export interface DeriveRecommendationsOptions {
  now: Date;
  minDays: number;
}

// ---------------------------------------------------------------------------
// Constants — design.md §22 thresholds.
// ---------------------------------------------------------------------------

/**
 * Warn threshold: rooms where the effective shade gain drops below
 * this value over `minDays` consecutive days are flagged as
 * "shading does not seem to help" and we suggest a longer
 * pre-look horizon.
 */
const WARN_GAIN_CPH = 0.3;

/**
 * Info threshold: rooms whose average gain over the same rolling
 * window exceeds this value get a positive "shading is clearly
 * working" note. No patch.
 */
const INFO_GAIN_CPH = 0.5;

/**
 * Ramp size applied to `sunPrelookMinutes` by the warn
 * recommendation. The schema's documented range is `[15, 120]`
 * (`WindowSchema.sunPrelookMinutes`); the patch caps at 120 so the
 * suggestion never lands in a state that `safeParseConfig` would
 * reject.
 */
const PRELOOK_BUMP_MIN = 30;
const PRELOOK_CAP_MIN = 120;

/**
 * Window length for the pre/post temperature slope. 60 min mirrors
 * the AC: "60 min BEFORE / AFTER that moment".
 */
const SLOPE_WINDOW_MIN = 60;

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

/**
 * Aggregate one row per `(roomId, local-date)` pair across the
 * supplied history records and temperature samples.
 *
 * The "first shade moment" for a room on a given day is the
 * earliest decision record on that day where any of the room's
 * windows produced `finalTarget >= 0.5`. If no such record exists
 * for the day but the room has at least one temperature sample on
 * that day, an empty row is still emitted with all metrics `null`
 * and `samplesPre / samplesPost = 0`. The downstream
 * {@link deriveRecommendations} treats such rows as "no signal":
 * they neither extend the streak counter nor break it.
 *
 * The slopes are least-squares regressions on `(hours, tempC)`.
 * Two samples are sufficient (the regression collapses to the
 * connecting line); fewer than two samples in the respective
 * 60-min window produce `null` for that side and propagate to
 * `effectiveShadeGain`.
 */
export function aggregateDailyMetrics(
  records: HistoryRecord<DecisionRecord>[],
  roomTempSamples: RoomTempSample[],
  options: AggregateDailyMetricsOptions,
): DailyShadeMetrics[] {
  const tz = options.timezone;
  const windowsByRoom = options.windowsByRoom;

  // Group temperature samples by (roomId, local-date). We store
  // both an array (for slope sweeping) and the parsed Date for
  // each sample so the slope helper does not have to re-parse.
  const samplesByRoomDay = new Map<string, ParsedTempSample[]>();
  const datesByRoom = new Map<string, Set<string>>();
  for (const sample of roomTempSamples) {
    const at = new Date(sample.ts);
    if (Number.isNaN(at.getTime())) {
      continue;
    }
    const localDate = formatLocalDate(at, tz);
    const key = `${sample.roomId}\u0000${localDate}`;
    let bucket = samplesByRoomDay.get(key);
    if (bucket === undefined) {
      bucket = [];
      samplesByRoomDay.set(key, bucket);
    }
    bucket.push({ at, tempC: sample.tempC });
    let roomDates = datesByRoom.get(sample.roomId);
    if (roomDates === undefined) {
      roomDates = new Set();
      datesByRoom.set(sample.roomId, roomDates);
    }
    roomDates.add(localDate);
  }

  // Sort each bucket by timestamp once so slope helpers can binary-
  // independent walk it linearly.
  for (const bucket of samplesByRoomDay.values()) {
    bucket.sort((a, b) => a.at.getTime() - b.at.getTime());
  }

  // Index decision records by (roomId, local-date). For each
  // (roomId, date) bucket we store the chronologically first
  // record in which any of the room's windows crossed
  // `finalTarget >= 0.5`.
  const firstShadeByRoomDay = new Map<string, ParsedShadeMoment>();
  // Pre-build a windowId → roomId reverse map for fast lookup.
  const roomByWindow = new Map<string, string>();
  for (const [roomId, ids] of Object.entries(windowsByRoom)) {
    for (const id of ids) {
      roomByWindow.set(id, roomId);
    }
  }
  // Iterate records once in chronological order.
  const sortedRecords = records
    .slice()
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  for (const rec of sortedRecords) {
    const at = new Date(rec.ts);
    if (Number.isNaN(at.getTime())) {
      continue;
    }
    const localDate = formatLocalDate(at, tz);
    // Track which rooms saw shading in this single record.
    const seenRoomsInThisRecord = new Set<string>();
    for (const wd of rec.payload.windowDecisions) {
      if (wd.finalTarget < 0.5) {
        continue;
      }
      const roomId = roomByWindow.get(wd.windowId);
      if (roomId === undefined) {
        continue;
      }
      if (seenRoomsInThisRecord.has(roomId)) {
        continue;
      }
      seenRoomsInThisRecord.add(roomId);
      const key = `${roomId}\u0000${localDate}`;
      if (!firstShadeByRoomDay.has(key)) {
        firstShadeByRoomDay.set(key, { at, isoUtc: at.toISOString() });
      }
      // For each room we also want to make sure the date is in the
      // datesByRoom union so the row is emitted even when there are
      // no temp samples on that day (a stable presence guarantee).
      let roomDates = datesByRoom.get(roomId);
      if (roomDates === undefined) {
        roomDates = new Set();
        datesByRoom.set(roomId, roomDates);
      }
      roomDates.add(localDate);
    }
  }

  // Walk the union of (roomId, date) and emit one row per pair.
  const out: DailyShadeMetrics[] = [];
  for (const [roomId, dates] of datesByRoom) {
    for (const date of dates) {
      const samples =
        samplesByRoomDay.get(`${roomId}\u0000${date}`) ?? [];
      const moment = firstShadeByRoomDay.get(`${roomId}\u0000${date}`);

      if (moment === undefined) {
        out.push({
          date,
          roomId,
          preShadeRiseCph: null,
          postShadeRiseCph: null,
          effectiveShadeGain: null,
          firstShadeTimeIso: null,
          samplesPre: 0,
          samplesPost: 0,
        });
        continue;
      }

      const tMs = moment.at.getTime();
      const preSlice = sliceWindow(
        samples,
        tMs - SLOPE_WINDOW_MIN * 60_000,
        tMs,
      );
      const postSlice = sliceWindow(
        samples,
        tMs,
        tMs + SLOPE_WINDOW_MIN * 60_000,
      );

      const preSlope = leastSquaresSlope(preSlice);
      const postSlope = leastSquaresSlope(postSlice);
      const gain =
        preSlope !== null && postSlope !== null
          ? preSlope - postSlope
          : null;

      out.push({
        date,
        roomId,
        preShadeRiseCph: preSlope,
        postShadeRiseCph: postSlope,
        effectiveShadeGain: gain,
        firstShadeTimeIso: moment.isoUtc,
        samplesPre: preSlice.length,
        samplesPost: postSlice.length,
      });
    }
  }

  // Stable order: by roomId, then by date ascending.
  out.sort((a, b) => {
    if (a.roomId !== b.roomId) {
      return a.roomId < b.roomId ? -1 : 1;
    }
    return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
  });
  return out;
}

/**
 * Turn the rolling per-room metrics into recommendation cards.
 *
 * For each room the function walks `metrics` in descending date
 * order, **counting** the number of consecutive days where
 * `effectiveShadeGain` is defined AND `< 0.3 °C/h`. Days with
 * `effectiveShadeGain === null` are transparent: they neither
 * advance the count nor break it (the spec calls them "no signal").
 * The first day with a defined value `>= 0.3` resets the count and
 * stops the warn-branch walk.
 *
 *   - When the count reaches `minDays` and the room has at least
 *     one window in `config.windows`, a `'warn'` recommendation is
 *     emitted with a `suggestedConfigPatch` describing a
 *     `+30 min` bump on `sunPrelookMinutes` of the room's first
 *     window. The patch caps the new value at 120 (the schema's
 *     documented upper bound).
 *
 *   - Otherwise, when the average of the most recent `minDays`
 *     defined `effectiveShadeGain` values is `> 0.5 °C/h`, an
 *     `'info'` recommendation is emitted (no patch). The two
 *     branches are mutually exclusive — a room that hits the warn
 *     branch never also gets the info note.
 */
export function deriveRecommendations(
  metrics: DailyShadeMetrics[],
  config: Config,
  options: DeriveRecommendationsOptions,
): LearningRecommendation[] {
  const minDays = Math.max(1, Math.floor(options.minDays));
  const createdAt = options.now.toISOString();

  // Bucket metrics by roomId, sorted by date descending (most
  // recent first).
  const byRoom = new Map<string, DailyShadeMetrics[]>();
  for (const row of metrics) {
    let bucket = byRoom.get(row.roomId);
    if (bucket === undefined) {
      bucket = [];
      byRoom.set(row.roomId, bucket);
    }
    bucket.push(row);
  }
  for (const bucket of byRoom.values()) {
    bucket.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  }

  // Pre-compute window indices by roomId so the patch path can
  // address `windows[<idx>].sunPrelookMinutes` directly. We pick
  // the FIRST configured window of the room (lowest config-array
  // index) so two passes against the same config produce the same
  // recommendation id and patch.
  const firstWindowByRoom = new Map<
    string,
    { window: Window; index: number }
  >();
  for (let i = 0; i < config.windows.length; i += 1) {
    const w = config.windows[i];
    if (w === undefined) {
      continue;
    }
    if (!firstWindowByRoom.has(w.roomId)) {
      firstWindowByRoom.set(w.roomId, { window: w, index: i });
    }
  }

  const recs: LearningRecommendation[] = [];
  for (const [roomId, rows] of byRoom) {
    // Warn-branch walk: descending date, count consecutive defined
    // values < WARN_GAIN_CPH, skip nulls, stop at first defined
    // >= WARN_GAIN_CPH.
    let lowStreak = 0;
    let warnTripped = false;
    for (const row of rows) {
      const g = row.effectiveShadeGain;
      if (g === null) {
        continue;
      }
      if (g < WARN_GAIN_CPH) {
        lowStreak += 1;
        if (lowStreak >= minDays) {
          warnTripped = true;
          break;
        }
      } else {
        // Defined and >= threshold — break the streak.
        break;
      }
    }

    if (warnTripped) {
      const winInfo = firstWindowByRoom.get(roomId);
      const rec: LearningRecommendation = {
        id: `lowGain-${roomId}`,
        roomId,
        severity: 'warn',
        title: 'Vorausschauzeit erhöhen',
        message: `Hitzeschutz wirkt zuletzt zu schwach (effective_shade_gain < ${WARN_GAIN_CPH.toFixed(
          1,
        )} °C/h an ${minDays} Tagen). Vorschlag: Vorausschau auf 90 min anheben.`,
        createdAt,
      };
      if (winInfo !== undefined) {
        const fromValue = winInfo.window.sunPrelookMinutes;
        const toValue = Math.min(
          PRELOOK_CAP_MIN,
          fromValue + PRELOOK_BUMP_MIN,
        );
        rec.suggestedConfigPatch = {
          path: ['windows', winInfo.index, 'sunPrelookMinutes'],
          from: fromValue,
          to: toValue,
        };
      }
      recs.push(rec);
      continue;
    }

    // Info-branch: average of the most recent `minDays` defined
    // `effectiveShadeGain` values.
    const recentDefined: number[] = [];
    for (const row of rows) {
      if (row.effectiveShadeGain === null) {
        continue;
      }
      recentDefined.push(row.effectiveShadeGain);
      if (recentDefined.length >= minDays) {
        break;
      }
    }
    if (recentDefined.length >= minDays) {
      const sum = recentDefined.reduce((acc, v) => acc + v, 0);
      const avg = sum / recentDefined.length;
      if (avg > INFO_GAIN_CPH) {
        recs.push({
          id: `highGain-${roomId}`,
          roomId,
          severity: 'info',
          title: 'Hitzeschutz wirkt deutlich',
          message: `Durchschnittlicher effective_shade_gain ${avg.toFixed(
            2,
          )} °C/h über ${minDays} Tage — die aktuelle Konfiguration kühlt zuverlässig.`,
          createdAt,
        });
      }
    }
  }

  // Stable order: warns first (by roomId), then infos (by roomId).
  recs.sort((a, b) => {
    if (a.severity !== b.severity) {
      return a.severity === 'warn' ? -1 : 1;
    }
    return a.roomId < b.roomId ? -1 : a.roomId > b.roomId ? 1 : 0;
  });
  return recs;
}

// ---------------------------------------------------------------------------
// Helpers (file-private).
// ---------------------------------------------------------------------------

interface ParsedTempSample {
  at: Date;
  tempC: number;
}

interface ParsedShadeMoment {
  at: Date;
  isoUtc: string;
}

/**
 * Slice the sorted `samples` so the result contains every entry
 * whose timestamp falls in `[startMs, endMs)` (pre-window) or
 * `[startMs, endMs]` (post-window). To keep the implementation
 * simple we use half-open `[start, end)` for both branches; the
 * "first shade moment" itself is therefore allocated to the post
 * window — exactly the behaviour the AC expects ("60 min BEFORE
 * that moment" / "60 min AFTER that moment", with the moment
 * counted as t = 0 for the post side).
 */
function sliceWindow(
  samples: ParsedTempSample[],
  startMs: number,
  endMs: number,
): ParsedTempSample[] {
  const out: ParsedTempSample[] = [];
  for (const s of samples) {
    const t = s.at.getTime();
    if (t < startMs) {
      continue;
    }
    if (t >= endMs) {
      continue;
    }
    out.push(s);
  }
  return out;
}

/**
 * Least-squares slope of `(hours, tempC)` for the supplied samples.
 * Returns `null` for fewer than two samples or when the time span
 * collapses to zero (all samples share an instant).
 *
 * Output unit: `°C / hour`.
 */
function leastSquaresSlope(
  samples: ParsedTempSample[],
): number | null {
  if (samples.length < 2) {
    return null;
  }
  const n = samples.length;
  const tBase = samples[0]!.at.getTime();
  let sumX = 0;
  let sumY = 0;
  for (const s of samples) {
    sumX += (s.at.getTime() - tBase) / (60 * 60 * 1000);
    sumY += s.tempC;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;
  let num = 0;
  let den = 0;
  for (const s of samples) {
    const x = (s.at.getTime() - tBase) / (60 * 60 * 1000);
    const dx = x - meanX;
    num += dx * (s.tempC - meanY);
    den += dx * dx;
  }
  if (den === 0) {
    return null;
  }
  return num / den;
}

/**
 * Format a UTC `Date` as the local-date `yyyy-mm-dd` string in the
 * supplied IANA timezone. Uses `Intl.DateTimeFormat` which is part
 * of the Node 20 ICU build — no extra runtime dep.
 *
 * The function is private because the date layout is an
 * implementation detail of the aggregation; downstream consumers
 * read `DailyShadeMetrics.date` without re-formatting it.
 */
function formatLocalDate(d: Date, timezone: string): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(d);
}
