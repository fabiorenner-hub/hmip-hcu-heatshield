/**
 * Heat Shield — dashboard internationalization (DE/EN).
 *
 * Per-device language: `auto` (default) resolves from the browser language,
 * with German as the fallback; explicit `de` / `en` override it. The choice is
 * persisted in localStorage and changed from Einstellungen → Darstellung &
 * Sprache.
 *
 * Strings are translated inline via `t(de, en)` — the German source string and
 * its English counterpart side by side. `t` reads the reactive `lang` signal,
 * so every component that calls it re-renders automatically when the language
 * changes. Server/engine-generated German strings are mapped to English by
 * {@link tServer} (a finite lookup + a few parametric patterns), so the full
 * UI — including decision reasons and labels — is localized.
 */

import { signal } from '@preact/signals';

export type Lang = 'de' | 'en';
export type LangPref = 'auto' | 'de' | 'en';

const STORAGE_KEY = 'heatshield.lang';

function detectBrowserLang(): Lang {
  try {
    const nav = typeof navigator !== 'undefined' ? navigator : null;
    const raw = (nav?.language ?? (nav?.languages?.[0] ?? 'de')).toLowerCase();
    return raw.startsWith('en') ? 'en' : 'de'; // German is the fallback
  } catch {
    return 'de';
  }
}

function loadPref(): LangPref {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'de' || v === 'en' || v === 'auto') return v;
  } catch {
    /* ignore */
  }
  return 'auto';
}

function resolve(pref: LangPref): Lang {
  return pref === 'auto' ? detectBrowserLang() : pref;
}

/** The user's preference (`auto` | `de` | `en`). */
export const langPref = signal<LangPref>(loadPref());
/** The resolved active language (`de` | `en`). Reactive. */
export const lang = signal<Lang>(resolve(langPref.value));

/** Change the language preference (persisted, updates the active language). */
export function setLangPref(pref: LangPref): void {
  langPref.value = pref;
  try {
    localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    /* ignore */
  }
  lang.value = resolve(pref);
  try {
    if (typeof document !== 'undefined') document.documentElement.lang = lang.value;
  } catch {
    /* ignore */
  }
}

/** Inline translation: returns `en` when the active language is English, else `de`. */
export function t(de: string, en: string): string {
  return lang.value === 'en' ? en : de;
}

/** BCP-47 locale for `Intl` formatting. */
export function locale(): string {
  return lang.value === 'en' ? 'en-US' : 'de-DE';
}

/** Locale-aware number formatting (24 h + °C stay; only separators localize). */
export function fmtNum(n: number, opts?: Intl.NumberFormatOptions): string {
  if (!Number.isFinite(n)) return '–';
  return n.toLocaleString(locale(), opts);
}

/** Locale-aware HH:mm time. */
export function fmtTime(ts: number | string | Date): string {
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return '–';
  return d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', hour12: false });
}

// ---------------------------------------------------------------------------
// Server/engine string translation (A=ii).
//
// The engine produces German reason/label strings that travel in the snapshot.
// We translate them at the render boundary: exact matches first, then a small
// set of parametric patterns that keep the embedded numbers/values.
// ---------------------------------------------------------------------------

const SERVER_EXACT: Record<string, string> = {
  // Irrigation decision reasons / blocks
  'Zone deaktiviert': 'Zone disabled',
  'Kein Ventil zugeordnet': 'No valve assigned',
  'Sturm – Bewässerung gesperrt': 'Storm – irrigation locked',
  'Modus AUS': 'Mode OFF',
  'Kein Bedarf (über Schwelle)': 'No demand (above threshold)',
  'Mindestpause aktiv': 'Cooldown active',
  'Außerhalb des Zeitfensters': 'Outside the time window',
  'Modus skaliert auf 0': 'Mode scales to 0',
  'Tagesbudget erreicht': 'Daily budget reached',
  'Tagesbudget erreicht.': 'Daily budget reached.',
  'Mäher aktiv – warte': 'Mower active – waiting',
  'Warte auf PV-Überschuss': 'Waiting for PV surplus',
  'warte auf Zyklus': 'waiting for cycle',
  // Irrigation modes
  'Aus': 'Off',
  'Eco': 'Eco',
  'Normal': 'Normal',
  'Hitze': 'Heat',
  'Urlaub': 'Vacation',
  'Anwuchs': 'Establishment',
  // Irrigation learning notes
  'Noch keine Lerndaten.': 'No learning data yet.',
  'Warnung: Wassergabe ohne Feuchteanstieg – Emitter prüfen.':
    'Warning: water applied without a moisture rise – check the emitter.',
  // FSM mode labels (modeInfo.label)
  'Sommer-Beobachtung': 'Summer watch',
  'Aktiver Hitzeschutz': 'Active heat protection',
  'Hitzewelle': 'Heatwave',
  'Nachtkühlung': 'Night cooling',
  'Sturm': 'Storm',
  'Wartung': 'Maintenance',
  // FSM mode goals (modeInfo.goal)
  'Komfort halten, Energie sparen': 'Maintain comfort, save energy',
  'Aufkommende Hitze früh erkennen': 'Detect building heat early',
  'Räume aktiv verschatten': 'Actively shade rooms',
  'Maximaler Hitzeschutz': 'Maximum heat protection',
  'Kühle Nachtluft nutzen': 'Use cool night air',
  'Rollläden zum Schutz auffahren': 'Raise shutters for protection',
  'Schutz bei Abwesenheit': 'Protection while away',
  'Wartung – Automatik pausiert': 'Maintenance – automation paused',
  'Komfort halten': 'Maintain comfort',
  // FSM decidedBy (non-parametric)
  'Wartung: über das Dashboard aktiviert': 'Maintenance: activated via the dashboard',
  'Urlaub: Urlaubsschalter ist aktiv': 'Vacation: the vacation switch is on',
  'Komfortbetrieb: keine Hitze-, Sturm- oder Sonderbedingung aktiv':
    'Comfort operation: no heat, storm or special condition active',
  'Sturm: Haltezeit nach Windböe läuft noch': 'Storm: hold time after a gust is still running',
  // FSM factor chips (non-parametric)
  'Sturm-Haltezeit aktiv': 'Storm hold time active',
  'Rollläden werden zum Schutz aufgefahren': 'Shutters are raised for protection',
  'Automatik pausiert (Wartungsmodus)': 'Automation paused (maintenance mode)',
  'Urlaubsprofil gewählt (geht vor Hitzeschutz)':
    'Vacation profile selected (overrides heat protection)',
  'Sonne unter dem Horizont': 'Sun below the horizon',
  'Schwellwert überschritten': 'Threshold exceeded',
  'keine Messwerte verfügbar': 'no measurements available',
  'Master-Automatik aus (nur Anzeige)': 'Master automation off (display only)',
  'Urlaubsmodus': 'Vacation mode',
  // Planned shutter-move reasons (positionSelector)
  'Öffnen für Tageslicht – keine Wärmelast erwartet':
    'Opening for daylight – no heat load expected',
  'Vorausschauende Position hält Komfort über den Horizont':
    'Predictive position keeps comfort across the horizon',
  'Stärkstes Schließen, da keine Halteposition den Komfort wahrt':
    'Strongest closure, as no hold position preserves comfort',
  'Geöffnet – aktuell keine Sonnenlast, Schließen würde nicht kühlen':
    'Opened — no solar load right now, closing would not cool',
  'Öffnen zur passiven Kühlung – kühl draußen, keine Sonne':
    'Opening for passive cooling — cool outside, no sun',
  // Ventilation / cooling advice headlines
  'Keine Empfehlung': 'No recommendation',
  'Fenster schließen': 'Close the window',
  'Jetzt lüften': 'Air now',
  'Lüften möglich': 'Airing possible',
  'Geschlossen halten': 'Keep closed',
  'Jetzt kühlen (Solarstrom)': 'Cool now (solar power)',
  'Kühlen nur mit Netzstrom': 'Cooling only with grid power',
  'Vorkühlen mit Überschuss': 'Pre-cool with surplus',
  'Keine Kühlung nötig': 'No cooling needed',
  // Ventilation / cooling advice details (non-parametric)
  'Hitzeschutz aktiv – ein offenes Fenster lässt warme Luft herein.':
    'Heat protection active – an open window lets warm air in.',
  'Zu wenige Messwerte für eine Lüftungsempfehlung.':
    'Too few measurements for a ventilation recommendation.',
  'Keine Innentemperatur verfügbar.': 'No indoor temperature available.',
  // Learning recommendations (titles)
  'Vorausschauzeit erhöhen': 'Increase look-ahead time',
  'Hitzeschutz wirkt deutlich': 'Heat protection works clearly',
};

const HEAT_LABEL_EN: Record<string, string> = {
  Hitzewelle: 'Heatwave',
  'Aktiver Hitzeschutz': 'Active heat protection',
};

/** Translate the embedded PV-surplus fragment used inside cooling-advice details. */
function tSurplus(s: string): string {
  return s
    .replace(/([\d.,-]+) kW PV-Überschuss/, '$1 kW PV surplus')
    .replace('kein PV-Wert', 'no PV reading');
}

const SERVER_PATTERNS: Array<{ re: RegExp; en: (m: RegExpMatchArray) => string }> = [
  // Irrigation
  { re: /^Bewässern: Defizit ([\d.,]+) mm$/, en: (m) => `Watering: deficit ${m[1]} mm` },
  { re: /^Frostschutz \(([\d.,]+) °C\)$/, en: (m) => `Frost lockout (${m[1]} °C)` },
  { re: /^Boden feucht genug \((\d+) %\)$/, en: (m) => `Soil moist enough (${m[1]} %)` },
  { re: /^Es regnet \(([\d.,]+) mm\)$/, en: (m) => `Raining (${m[1]} mm)` },
  { re: /^Regen erwartet \(([\d.,]+) mm\)$/, en: (m) => `Rain expected (${m[1]} mm)` },
  { re: /^Zu windig \(([\d.,]+) m\/s\)$/, en: (m) => `Too windy (${m[1]} m/s)` },
  { re: /^Kalibriert über (\d+) Tag\(e\)\.$/, en: (m) => `Calibrated over ${m[1]} day(s).` },
  // FSM decidedBy (parametric)
  {
    re: /^Sturm: Wind ([\d.,-]+) m\/s über Schwelle ([\d.,-]+) m\/s$/,
    en: (m) => `Storm: wind ${m[1]} m/s above threshold ${m[2]} m/s`,
  },
  {
    re: /^Nachtauskühlung: Außenluft ([\d.,-]+) °C kühler als Raum ([\d.,-]+) °C$/,
    en: (m) => `Night cooling: outdoor air ${m[1]} °C cooler than room ${m[2]} °C`,
  },
  {
    re: /^(Hitzewelle|Aktiver Hitzeschutz): Tagesprognose ([\d.,-]+) °C ≥ ([\d.,-]+) °C$/,
    en: (m) => `${HEAT_LABEL_EN[m[1] as string]}: daily forecast ${m[2]} °C ≥ ${m[3]} °C`,
  },
  {
    re: /^(Hitzewelle|Aktiver Hitzeschutz): wärmster Raum ([\d.,-]+) °C ≥ ([\d.,-]+) °C$/,
    en: (m) => `${HEAT_LABEL_EN[m[1] as string]}: warmest room ${m[2]} °C ≥ ${m[3]} °C`,
  },
  {
    re: /^Sommer-Beobachtung: Tagesprognose ([\d.,-]+) °C ≥ ([\d.,-]+) °C$/,
    en: (m) => `Summer watch: daily forecast ${m[1]} °C ≥ ${m[2]} °C`,
  },
  {
    re: /^Sommer-Beobachtung: Außentemperatur ([\d.,-]+) °C ≥ ([\d.,-]+) °C$/,
    en: (m) => `Summer watch: outdoor temperature ${m[1]} °C ≥ ${m[2]} °C`,
  },
  {
    re: /^Sommer-Beobachtung: PV-Leistung ([\d.,-]+) kW > ([\d.,-]+) kW$/,
    en: (m) => `Summer watch: PV power ${m[1]} kW > ${m[2]} kW`,
  },
  // FSM factor chips (parametric)
  {
    re: /^Wind ([\d.,-]+) m\/s \(Schwelle ([\d.,-]+) m\/s\)$/,
    en: (m) => `Wind ${m[1]} m/s (threshold ${m[2]} m/s)`,
  },
  {
    re: /^Tagesprognose ([\d.,-]+) °C \(Schwelle ([\d.,-]+) °C\)$/,
    en: (m) => `Daily forecast ${m[1]} °C (threshold ${m[2]} °C)`,
  },
  {
    re: /^wärmster Raum ([\d.,-]+) °C \(Schwelle ([\d.,-]+) °C\)$/,
    en: (m) => `Warmest room ${m[1]} °C (threshold ${m[2]} °C)`,
  },
  {
    re: /^Prognose ([\d.,-]+) °C \(Schwelle ([\d.,-]+) °C\)$/,
    en: (m) => `Forecast ${m[1]} °C (threshold ${m[2]} °C)`,
  },
  {
    re: /^Außen ([\d.,-]+) °C \(Schwelle ([\d.,-]+) °C\)$/,
    en: (m) => `Outdoor ${m[1]} °C (threshold ${m[2]} °C)`,
  },
  {
    re: /^PV ([\d.,-]+) kW \(Schwelle ([\d.,-]+) kW\)$/,
    en: (m) => `PV ${m[1]} kW (threshold ${m[2]} kW)`,
  },
  { re: /^Prognose ([\d.,-]+) °C \(< ([\d.,-]+) °C\)$/, en: (m) => `Forecast ${m[1]} °C (< ${m[2]} °C)` },
  { re: /^Außen ([\d.,-]+) °C \(< ([\d.,-]+) °C\)$/, en: (m) => `Outdoor ${m[1]} °C (< ${m[2]} °C)` },
  {
    re: /^wärmster Raum ([\d.,-]+) °C \(< ([\d.,-]+) °C\)$/,
    en: (m) => `Warmest room ${m[1]} °C (< ${m[2]} °C)`,
  },
  { re: /^PV ([\d.,-]+) kW \(< ([\d.,-]+) kW\)$/, en: (m) => `PV ${m[1]} kW (< ${m[2]} kW)` },
  { re: /^Gefühlte Wärme ([\d.,-]+) %$/, en: (m) => `Perceived heat ${m[1]} %` },
  { re: /^wärmster Raum ([\d.,-]+) °C$/, en: (m) => `Warmest room ${m[1]} °C` },
  { re: /^Mindest-Differenz ([\d.,-]+) K$/, en: (m) => `Minimum difference ${m[1]} K` },
  { re: /^Außen ([\d.,-]+) °C$/, en: (m) => `Outdoor ${m[1]} °C` },
  // Ventilation advice details (parametric)
  {
    re: /^Außen ([\d.,-]+) °C ≥ innen ([\d.,-]+) °C – offenes Fenster heizt den Raum auf\.$/,
    en: (m) => `Outdoor ${m[1]} °C ≥ indoor ${m[2]} °C – an open window heats the room.`,
  },
  {
    re: /^Außen ([\d.,-]+) °C ist ([\d.,-]+) K kühler – kühle Nachtluft senkt die ([\d.,-]+) °C im Raum\.$/,
    en: (m) =>
      `Outdoor ${m[1]} °C is ${m[2]} K cooler – cool night air lowers the ${m[3]} °C in the room.`,
  },
  {
    re: /^Außen ([\d.,-]+) °C ist ([\d.,-]+) K kühler – Stoßlüften kühlt vorbeugend\.$/,
    en: (m) => `Outdoor ${m[1]} °C is ${m[2]} K cooler – burst airing cools preventively.`,
  },
  {
    re: /^Außen ([\d.,-]+) °C bringt keine Abkühlung – Fenster und Rollläden zu lassen\.$/,
    en: (m) => `Outdoor ${m[1]} °C brings no cooling – keep windows and shutters closed.`,
  },
  {
    re: /^Innen ([\d.,-]+) °C, außen ([\d.,-]+) °C – aktuell kein Lüftungsvorteil\.$/,
    en: (m) => `Indoor ${m[1]} °C, outdoor ${m[2]} °C – no ventilation benefit right now.`,
  },
  // Cooling advice details (parametric, with embedded PV-surplus fragment)
  {
    re: /^Innen ([\d.,-]+) °C über Komfort – (.+) deckt die Kühlung\.$/,
    en: (m) => `Indoor ${m[1]} °C above comfort – ${tSurplus(m[2] as string)} covers the cooling.`,
  },
  {
    re: /^Innen ([\d.,-]+) °C über Komfort, aber (.+) – Kühlen würde Netzstrom kosten\.$/,
    en: (m) =>
      `Indoor ${m[1]} °C above comfort, but ${tSurplus(m[2] as string)} – cooling would cost grid power.`,
  },
  {
    re: /^Innen ([\d.,-]+) °C, Hitze erwartet und (.+) – jetzt mit Solarstrom vorkühlen\.$/,
    en: (m) =>
      `Indoor ${m[1]} °C, heat expected and ${tSurplus(m[2] as string)} – pre-cool with solar power now.`,
  },
  {
    re: /^Innen ([\d.,-]+) °C liegt im Komfortbereich\.$/,
    en: (m) => `Indoor ${m[1]} °C is within the comfort range.`,
  },
  // Learning recommendations (messages)
  {
    re: /^Hitzeschutz wirkt zuletzt zu schwach \(effective_shade_gain < ([\d.,-]+) °C\/h an (\d+) Tagen\)\. Vorschlag: Vorausschau auf 90 min anheben\.$/,
    en: (m) =>
      `Heat protection has recently been too weak (effective_shade_gain < ${m[1]} °C/h on ${m[2]} days). Suggestion: raise look-ahead to 90 min.`,
  },
  {
    re: /^Durchschnittlicher effective_shade_gain ([\d.,-]+) °C\/h über (\d+) Tage — die aktuelle Konfiguration kühlt zuverlässig\.$/,
    en: (m) =>
      `Average effective_shade_gain ${m[1]} °C/h over ${m[2]} days — the current configuration cools reliably.`,
  },
];

/** Translate a server/engine-generated German string to the active language. */
export function tServer(s: string | null | undefined): string {
  if (s === null || s === undefined) return '';
  if (lang.value !== 'en') return s;
  const exact = SERVER_EXACT[s];
  if (exact !== undefined) return exact;
  for (const p of SERVER_PATTERNS) {
    const m = s.match(p.re);
    if (m !== null) return p.en(m);
  }
  return s; // unknown — leave as-is (German)
}

// Reflect the initial language on <html lang="…"> for a11y / correct hyphenation.
try {
  if (typeof document !== 'undefined') document.documentElement.lang = lang.value;
} catch {
  /* ignore */
}
