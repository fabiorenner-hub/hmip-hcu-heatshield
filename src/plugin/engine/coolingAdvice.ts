/**
 * Heat Shield — active-cooling advice (predictive-control-dashboard, Klima
 * module / catalog C2).
 *
 * Pure, deterministic: same inputs → same output (property-testable). Decides
 * whether running an active cooler (AC / fan on a HmIP switch) is worthwhile
 * right now, gated on PV surplus so cooling preferentially uses self-produced
 * solar power (Eigenverbrauch) rather than grid import.
 *
 * Advisory only — the plugin does not switch a cooler on its own here; the
 * recommendation surfaces in the Klima module and can be pushed as a
 * notification. A future active-control feature can consume the same function.
 *
 * Module rules: pure, no fs/logging/Connect artefacts/globals; strict TS, ESM,
 * `.js` import suffixes.
 */

export type CoolAdviceLevel =
  | 'cool_now' // hot indoors AND PV surplus → cool on solar power
  | 'cool_grid' // hot indoors but no PV surplus → cooling needs grid power
  | 'precool' // not yet hot, but strong PV surplus + heat ahead → pre-cool
  | 'no_cooling' // comfortable → no cooling needed
  | 'neutral'; // not enough data

export interface CoolAdviceInputs {
  /** Measured indoor temperature (°C), or null when unknown. */
  readonly indoorTempC: number | null;
  /** Upper comfort temperature (°C) — above it, cooling is desirable. */
  readonly comfortMaxC: number;
  /** Pre-cool trigger (°C); between this and comfortMax, pre-cooling on surplus. */
  readonly preCoolC: number;
  /** Estimated PV surplus in kW (generation minus house load), or null. */
  readonly pvSurplusKw: number | null;
  /** Minimum surplus (kW) to count as "PV available" for cooling. */
  readonly pvSurplusThresholdKw: number;
  /** Whether heat protection is active (mode ∈ {ACTIVE_HEAT_PROTECTION, HEATWAVE}). */
  readonly heatModeActive: boolean;
  /** Forecast daily max (°C), or null. Enables forecast-driven pre-cooling (V1.8). */
  readonly forecastMaxC?: number | null;
  /** Forecast max ≥ this counts as "heat ahead" for pre-cooling. Default 25. */
  readonly forecastHotC?: number;
}

export interface CoolAdvice {
  readonly level: CoolAdviceLevel;
  readonly headline: string;
  readonly detail: string;
  /** PV surplus used for the decision (kW), or null when unknown. */
  readonly pvSurplusKw: number | null;
}

function f1(n: number): string {
  return (Math.round(n * 10) / 10).toString();
}

/**
 * Compute the cooling advice. Precedence:
 *   1. No indoor reading → neutral.
 *   2. Indoor above comfort: cool now if PV surplus ≥ threshold, else flag that
 *      cooling would need grid power.
 *   3. Indoor in the pre-cool band with strong surplus and heat ahead → pre-cool.
 *   4. Otherwise no cooling needed.
 */
export function coolingAdvice(inp: CoolAdviceInputs): CoolAdvice {
  const indoor = inp.indoorTempC;
  const surplus = inp.pvSurplusKw;
  if (indoor === null || !Number.isFinite(indoor)) {
    return {
      level: 'neutral',
      headline: 'Keine Empfehlung',
      detail: 'Keine Innentemperatur verfügbar.',
      pvSurplusKw: surplus,
    };
  }
  const haveSurplus =
    surplus !== null && Number.isFinite(surplus) && surplus >= inp.pvSurplusThresholdKw;
  const surplusText =
    surplus !== null && Number.isFinite(surplus) ? `${f1(surplus)} kW PV-Überschuss` : 'kein PV-Wert';

  if (indoor > inp.comfortMaxC) {
    if (haveSurplus) {
      return {
        level: 'cool_now',
        headline: 'Jetzt kühlen (Solarstrom)',
        detail: `Innen ${f1(indoor)} °C über Komfort – ${surplusText} deckt die Kühlung.`,
        pvSurplusKw: surplus,
      };
    }
    return {
      level: 'cool_grid',
      headline: 'Kühlen nur mit Netzstrom',
      detail: `Innen ${f1(indoor)} °C über Komfort, aber ${surplusText} – Kühlen würde Netzstrom kosten.`,
      pvSurplusKw: surplus,
    };
  }

  // "Heat ahead" is true in an active heat mode OR when the day's forecast max
  // crosses the hot threshold (V1.8 — forecast-driven pre-cooling).
  const forecastHot =
    inp.forecastMaxC !== null &&
    inp.forecastMaxC !== undefined &&
    Number.isFinite(inp.forecastMaxC) &&
    inp.forecastMaxC >= (inp.forecastHotC ?? 25);
  if (indoor >= inp.preCoolC && haveSurplus && (inp.heatModeActive || forecastHot)) {
    return {
      level: 'precool',
      headline: 'Vorkühlen mit Überschuss',
      detail: `Innen ${f1(indoor)} °C, Hitze erwartet und ${surplusText} – jetzt mit Solarstrom vorkühlen.`,
      pvSurplusKw: surplus,
    };
  }

  return {
    level: 'no_cooling',
    headline: 'Keine Kühlung nötig',
    detail: `Innen ${f1(indoor)} °C liegt im Komfortbereich.`,
    pvSurplusKw: surplus,
  };
}
