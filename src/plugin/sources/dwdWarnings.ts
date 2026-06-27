/**
 * Heat Shield — DWD (Deutscher Wetterdienst) severe-weather warnings source.
 *
 * Reads the OFFICIAL DWD warnings feed (option b): the per-Warncell JSON at
 * `warnapp_landkreise/json/warnings.json`. That file is JSONP — the body is
 * `warnWetter.loadWarnings({...});` — so we strip the wrapper before parsing.
 *
 * A Warncell-ID identifies the region. Rather than hard-coding one, we resolve
 * the configured region NAME (e.g. "Beispielstadt") to its Warncell-ID through the
 * official `cap_warncellids_csv` mapping (cached 24 h). An explicit
 * `warncellId` in the config short-circuits the lookup.
 *
 * Pure-ish: the only side effect is the outbound HTTPS GET (dependency-injected
 * `fetchFn`). No fs, no logging, no Connect artifacts. Caching is in-module so
 * the dashboard route can poll cheaply.
 */

const WARNINGS_URL =
  'https://www.dwd.de/DWD/warnungen/warnapp_landkreise/json/warnings.json';
const WARNCELL_CSV_URL =
  'https://www.dwd.de/DE/leistungen/opendata/help/warnungen/cap_warncellids_csv.csv?__blob=publicationFile&v=3';

const WARNINGS_TTL_MS = 5 * 60_000; // 5 min — DWD updates warnings ~every 5 min.
const CSV_TTL_MS = 24 * 3_600_000; // 24 h — the warncell list rarely changes.

export interface DwdWarning {
  /** DWD severity level 1 (gelb) … 4 (violett). */
  readonly level: number;
  readonly event: string;
  readonly headline: string;
  readonly description: string;
  readonly instruction: string;
  /** Epoch ms (start/end of the warning), or null when not provided. */
  readonly start: number | null;
  readonly end: number | null;
  readonly regionName: string;
  /** True for a "Vorabinformation" (advance notice), not an active warning. */
  readonly preliminary: boolean;
}

export interface DwdWarningsResult {
  readonly cellId: string | null;
  readonly regionName: string;
  /** Feed timestamp (epoch ms) reported by DWD. */
  readonly time: number | null;
  readonly warnings: ReadonlyArray<DwdWarning>;
}

export interface DwdWarningsOptions {
  /** Explicit Warncell-ID; when set the CSV name lookup is skipped. */
  readonly warncellId?: string;
  /** Region name to resolve to a Warncell-ID (e.g. "Beispielstadt"). */
  readonly regionName: string;
  readonly fetchFn?: typeof globalThis.fetch;
  readonly now?: () => number;
}

interface CacheEntry<T> {
  value: T;
  at: number;
}

let warningsCache: CacheEntry<{ time: number | null; byCell: Map<string, DwdWarning[]> }> | null =
  null;
let csvCache: CacheEntry<Map<string, string>> | null = null; // lowercase name → cellId

/** Strip the `warnWetter.loadWarnings( … );` JSONP wrapper to raw JSON text. */
export function stripJsonp(body: string): string {
  const open = body.indexOf('{');
  const close = body.lastIndexOf('}');
  if (open === -1 || close === -1 || close < open) {
    throw new Error('DWD warnings: no JSON object found in JSONP body');
  }
  return body.slice(open, close + 1);
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function asNumberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Parse the DWD warnings JSON into a cell→warnings map. */
export function parseWarnings(json: unknown): {
  time: number | null;
  byCell: Map<string, DwdWarning[]>;
} {
  const root = (json ?? {}) as Record<string, unknown>;
  const time = asNumberOrNull(root['time']);
  const byCell = new Map<string, DwdWarning[]>();

  const ingest = (container: unknown, preliminary: boolean): void => {
    if (typeof container !== 'object' || container === null) return;
    for (const [cellId, raw] of Object.entries(container as Record<string, unknown>)) {
      if (!Array.isArray(raw)) continue;
      const list = byCell.get(cellId) ?? [];
      for (const w of raw) {
        if (typeof w !== 'object' || w === null) continue;
        const o = w as Record<string, unknown>;
        list.push({
          level: asNumberOrNull(o['level']) ?? 1,
          event: asString(o['event']),
          headline: asString(o['headline']),
          description: asString(o['description']),
          instruction: asString(o['instruction']),
          start: asNumberOrNull(o['start']),
          end: asNumberOrNull(o['end']),
          regionName: asString(o['regionName']),
          preliminary,
        });
      }
      byCell.set(cellId, list);
    }
  };

  ingest(root['warnings'], false);
  ingest(root['vorabInformation'], true);
  return { time, byCell };
}

/** Parse the `;`-separated Warncell CSV into a lowercase-name → cellId map. */
export function parseWarncellCsv(csv: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = csv.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.length === 0) continue;
    const cols = line.split(';');
    if (cols.length < 2) continue;
    const id = (cols[0] ?? '').trim();
    const name = (cols[1] ?? '').trim();
    if (i === 0 && /warncellid/i.test(id)) continue; // header
    if (!/^\d+$/.test(id) || name.length === 0) continue;
    const key = name.toLowerCase();
    // First occurrence wins (the CSV lists the most specific cells first).
    if (!out.has(key)) out.set(key, id);
  }
  return out;
}

async function loadWarnings(
  fetchFn: typeof globalThis.fetch,
  now: () => number,
): Promise<{ time: number | null; byCell: Map<string, DwdWarning[]> }> {
  const t = now();
  if (warningsCache !== null && t - warningsCache.at < WARNINGS_TTL_MS) {
    return warningsCache.value;
  }
  const res = await fetchFn(WARNINGS_URL, { headers: { Accept: 'text/javascript, */*' } });
  if (!res.ok) throw new Error(`DWD warnings HTTP ${res.status}`);
  const body = await res.text();
  const parsed = parseWarnings(JSON.parse(stripJsonp(body)));
  warningsCache = { value: parsed, at: t };
  return parsed;
}

/**
 * Candidate warncell IDs to check for a resolved cell. DWD issues most
 * warnings on the LANDKREIS cell (`1xxxxxxxx`), while a region name often
 * resolves to the finer GEMEINDE cell (`8DDDDD###`) which is then empty in the
 * `warnapp_landkreise` feed. We therefore also derive the parent Landkreis cell
 * `1` + <5-digit Kreis> + `000` (the Kreis digits are shared, e.g. Gemeinde
 * `812063080` → Landkreis `112063000`) and aggregate warnings from both.
 */
export function candidateCells(cellId: string): string[] {
  const out = [cellId];
  const m = /^8(\d{5})\d{3}$/u.exec(cellId);
  if (m !== null) {
    const landkreis = `1${m[1]}000`;
    if (!out.includes(landkreis)) {
      out.push(landkreis);
    }
  }
  return out;
}

async function resolveCellId(
  regionName: string,
  fetchFn: typeof globalThis.fetch,
  now: () => number,
): Promise<string | null> {
  const t = now();
  if (csvCache === null || t - csvCache.at >= CSV_TTL_MS) {
    const res = await fetchFn(WARNCELL_CSV_URL, { headers: { Accept: 'text/csv, */*' } });
    if (!res.ok) throw new Error(`DWD warncell CSV HTTP ${res.status}`);
    csvCache = { value: parseWarncellCsv(await res.text()), at: t };
  }
  const map = csvCache.value;
  const needle = regionName.trim().toLowerCase();
  if (needle.length === 0) return null;
  // Exact match first, then a "contains" fallback (e.g. "Stadt Beispielstadt").
  const exact = map.get(needle);
  if (exact !== undefined) return exact;
  for (const [name, id] of map) {
    if (name.includes(needle)) return id;
  }
  return null;
}

/**
 * Fetch the active DWD warnings for the configured region. Resolves the
 * Warncell-ID (explicit override or CSV name lookup), reads the warnings feed,
 * and returns the normalized list for that cell. Throws on network/parse
 * failure so the caller can surface a 502.
 */
export async function getDwdWarnings(
  opts: DwdWarningsOptions,
): Promise<DwdWarningsResult> {
  const fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
  const now = opts.now ?? ((): number => Date.now());
  const cellId =
    opts.warncellId !== undefined && opts.warncellId.trim().length > 0
      ? opts.warncellId.trim()
      : await resolveCellId(opts.regionName, fetchFn, now);

  const { time, byCell } = await loadWarnings(fetchFn, now);
  // Aggregate the resolved cell + its parent Landkreis cell, de-duplicated:
  // DWD usually warns on the Landkreis cell, not the finer Gemeinde cell.
  const warnings: DwdWarning[] = [];
  if (cellId !== null) {
    const seen = new Set<string>();
    for (const c of candidateCells(cellId)) {
      for (const w of byCell.get(c) ?? []) {
        const k = `${w.event}|${w.level}|${w.start ?? ''}|${w.end ?? ''}`;
        if (!seen.has(k)) {
          seen.add(k);
          warnings.push(w);
        }
      }
    }
  }
  return { cellId, regionName: opts.regionName, time, warnings };
}

/** Test/diagnostic hook: clear the in-module caches. */
export function _resetDwdCaches(): void {
  warningsCache = null;
  csvCache = null;
}
