/**
 * Heat Shield — ventilation advice (predictive-control-dashboard, Lüftung
 * module / catalog C1).
 *
 * Pure, deterministic: same inputs → same output (property-testable). Given a
 * room's indoor temperature, the outdoor temperature, the sun state and the
 * current heat mode, it decides whether the resident should air the room now,
 * keep the windows shut, or close an open window again.
 *
 * This is advisory only — the plugin never opens/closes windows (it has no
 * actuator for sashes). The recommendation surfaces in the Lüftung module and
 * can be pushed as a notification. The native shutter lockout when a sash is
 * open lives in `engine/ventilation.ts` and is unaffected by this module.
 *
 * Module rules (mirrored from sibling engine modules):
 *   - Pure: no fs, no logging, no Connect-API artefacts, no globals.
 *   - Strict TS, ESM, `.js` import suffixes.
 */

/** Advice level, ordered loosely from "act to cool" to "act to protect". */
export type VentAdviceLevel =
  | 'air_now' // open the window — cooler outside, flush heat out
  | 'air_possible' // airing would help, not urgent
  | 'close_window' // a window is open while it is warmer outside → shut it
  | 'keep_closed' // keep shut — outside is not cooler / heat is incoming
  | 'neutral'; // nothing to do / not enough data

export interface VentAdviceInputs {
  /** Whether the sun is above the horizon. */
  readonly sunIsUp: boolean;
  /** Measured indoor temperature (°C), or null when unknown. */
  readonly indoorTempC: number | null;
  /** Effective outdoor temperature (°C), or null when unknown. */
  readonly outdoorTempC: number | null;
  /** Minimum indoor−outdoor delta (K) before airing is worthwhile. */
  readonly deltaC: number;
  /** Upper comfort temperature (°C); above it, cooling is desirable. */
  readonly comfortMaxC: number;
  /** Whether heat protection is active (mode ∈ {ACTIVE_HEAT_PROTECTION, HEATWAVE}). */
  readonly heatModeActive: boolean;
  /** Whether at least one window/contact in the room is open or tilted. */
  readonly windowOpen: boolean;
}

export interface VentAdvice {
  readonly level: VentAdviceLevel;
  /** Short German headline. */
  readonly headline: string;
  /** German one-line detail with the deciding values. */
  readonly detail: string;
}

function f1(n: number): string {
  return (Math.round(n * 10) / 10).toString();
}

/**
 * Compute the ventilation advice for one room. Precedence:
 *
 *   1. Window open while it is at least as warm outside as inside → close it
 *      (especially during heat protection — warm air is flowing in).
 *   2. Sun down and outside is ≥ `deltaC` cooler than inside → air now when
 *      the room is above comfort, else airing is merely possible.
 *   3. Heat mode active and outside is not cooler → keep shut.
 *   4. Otherwise neutral.
 */
export function ventilationAdvice(inp: VentAdviceInputs): VentAdvice {
  const indoor = inp.indoorTempC;
  const outdoor = inp.outdoorTempC;

  // Need both temperatures for any temperature-driven advice.
  if (indoor === null || outdoor === null || !Number.isFinite(indoor) || !Number.isFinite(outdoor)) {
    // Without temperatures we can still warn about an open window in heat mode.
    if (inp.windowOpen && inp.heatModeActive) {
      return {
        level: 'close_window',
        headline: 'Fenster schließen',
        detail: 'Hitzeschutz aktiv – ein offenes Fenster lässt warme Luft herein.',
      };
    }
    return {
      level: 'neutral',
      headline: 'Keine Empfehlung',
      detail: 'Zu wenige Messwerte für eine Lüftungsempfehlung.',
    };
  }

  const delta = indoor - outdoor; // positive → cooler outside

  // 1. Open window while it is warmer (or equal) outside → close it.
  if (inp.windowOpen && delta <= 0) {
    return {
      level: 'close_window',
      headline: 'Fenster schließen',
      detail: `Außen ${f1(outdoor)} °C ≥ innen ${f1(indoor)} °C – offenes Fenster heizt den Raum auf.`,
    };
  }

  // 2. Cooler outside and sun down → airing helps.
  if (!inp.sunIsUp && delta >= inp.deltaC) {
    if (indoor > inp.comfortMaxC) {
      return {
        level: 'air_now',
        headline: 'Jetzt lüften',
        detail: `Außen ${f1(outdoor)} °C ist ${f1(delta)} K kühler – kühle Nachtluft senkt die ${f1(
          indoor,
        )} °C im Raum.`,
      };
    }
    return {
      level: 'air_possible',
      headline: 'Lüften möglich',
      detail: `Außen ${f1(outdoor)} °C ist ${f1(delta)} K kühler – Stoßlüften kühlt vorbeugend.`,
    };
  }

  // 3. Heat mode and not cooler outside → keep shut.
  if (inp.heatModeActive && delta < inp.deltaC) {
    return {
      level: 'keep_closed',
      headline: 'Geschlossen halten',
      detail: `Außen ${f1(outdoor)} °C bringt keine Abkühlung – Fenster und Rollläden zu lassen.`,
    };
  }

  return {
    level: 'neutral',
    headline: 'Keine Empfehlung',
    detail: `Innen ${f1(indoor)} °C, außen ${f1(outdoor)} °C – aktuell kein Lüftungsvorteil.`,
  };
}
