/**
 * Thermal knowledge model — non-normative scaffold (thermal-load-engine).
 *
 * Encodes the STATUS-CLASS taxonomy, the formula registry (the physics/frame
 * relations the Quick Estimate v1 engine actually uses), the standards metadata
 * and the G1–G8 conformity gates — mirroring the user-provided knowledge model.
 *
 * IMPORTANT: `conformity_claim = "none"`. No proprietary norm/VDI text or tables
 * are reproduced. Licences for DIN/VDI content are held (DEC-008), so the
 * licence gate G1 is met — but the actual licensed NORM-PARAM tables have not
 * yet been captured as evidence, and validation (G6) + qualified approval (G8)
 * are still open, so the engine still claims NO conformity (LLM policy: "no
 * conformity without gates"; "never invent normative values"). Pure data +
 * helpers; no I/O, no zod.
 */

export type StatusClass = 'PHYS' | 'FRAME' | 'NORM-PARAM' | 'ILLUSTRATIVE' | 'IMPLEMENTATION';

export const STATUS_CLASSES: Record<StatusClass, string> = {
  PHYS: 'Allgemeine physikalische Beziehung',
  FRAME: 'Methodische Struktur eines Regelwerks; Details editionsabhängig',
  'NORM-PARAM': 'Benötigt lizenzierte normative Parameter oder Tabellen',
  ILLUSTRATIVE: 'Nur Erklärung/Plausibilität, nicht für Konformitätsergebnis',
  IMPLEMENTATION: 'Software- oder numerische Form, fachlich zu validieren',
};

export interface FormulaRef {
  id: string;
  name: string;
  statusClass: StatusClass;
  /** Which engine module realises it. */
  module: string;
}

/** The registry subset the Quick Estimate v1 engine implements. */
export const FORMULA_REGISTRY: readonly FormulaRef[] = [
  { id: 'PHY-HT-001', name: 'Stationärer Wärmestrom durch ein Bauteil', statusClass: 'PHYS', module: 'heating-load' },
  { id: 'PHY-HT-002', name: 'Transmissionswärmetransferkoeffizient', statusClass: 'PHYS', module: 'heating-load' },
  { id: 'HL-001', name: 'Grundstruktur Raumheizlast', statusClass: 'FRAME', module: 'heating-load' },
  { id: 'HL-010', name: 'Transmissionsanteil über Pfade', statusClass: 'FRAME', module: 'heating-load' },
  { id: 'HL-011', name: 'Temperaturanpassungsfaktor', statusClass: 'FRAME', module: 'heating-load' },
  { id: 'HL-020', name: 'Lüftungswärmestrom', statusClass: 'PHYS', module: 'heating-load' },
  { id: 'HL-021', name: 'Lüftungswärmetransferkoeffizient', statusClass: 'PHYS', module: 'heating-load' },
  { id: 'HL-022', name: 'Volumenstrom aus Luftwechsel', statusClass: 'PHYS', module: 'heating-load' },
  { id: 'HL-023', name: 'Zulufttemperatur bei WRG (idealisiert)', statusClass: 'ILLUSTRATIVE', module: 'heating-load' },
  { id: 'HL-030', name: 'Wiederaufheizleistung (kapazitiv)', statusClass: 'ILLUSTRATIVE', module: 'heating-load' },
  { id: 'HL-040', name: 'Gebäudeaggregation', statusClass: 'FRAME', module: 'heating-load' },
  { id: 'VENT-001', name: 'Druck-Volumenstrom-Kennlinie', statusClass: 'PHYS', module: 'ventilation-1946-6' },
  { id: 'VENT-002', name: 'Infiltrationsmodell (Struktur)', statusClass: 'FRAME', module: 'ventilation-1946-6' },
  { id: 'VENT-003', name: 'Lüftungsstufe (parametrische Form)', statusClass: 'FRAME', module: 'ventilation-1946-6' },
  { id: 'CL-010', name: 'Solare Transmission durch transparente Fläche', statusClass: 'PHYS', module: 'cooling-estimate' },
  { id: 'CL-011', name: 'Sensible Außenluftlast', statusClass: 'PHYS', module: 'cooling-estimate' },
  { id: 'CL-012', name: 'Latente Außenluftlast', statusClass: 'PHYS', module: 'cooling-estimate' },
  { id: 'CL-030', name: 'Operative Temperatur', statusClass: 'PHYS', module: 'cooling-estimate' },
  { id: 'CL-040', name: 'Kühllastanforderung bei Solltemperatur', statusClass: 'ILLUSTRATIVE', module: 'cooling-estimate' },
  { id: 'CL-050', name: 'Gebäude-Spitzenlast', statusClass: 'FRAME', module: 'index' },
] as const;

export interface StandardMeta {
  id: string;
  title: string;
  role: string;
}

export const STANDARDS: readonly StandardMeta[] = [
  { id: 'DIN_EN_12831_1_2017', title: 'DIN EN 12831-1:2017-09', role: 'Europäischer methodischer Rahmen (Heizlast)' },
  { id: 'DIN_TS_12831_1_2020', title: 'DIN/TS 12831-1:2020-04', role: 'Nationales Anwendungsprofil Deutschland' },
  { id: 'DIN_1946_6_2019', title: 'DIN 1946-6:2019-12', role: 'Wohnungslüftung: Konzept + Volumenströme' },
  { id: 'VDI_2078_2015', title: 'VDI 2078:2015-06', role: 'Kühllast / operative Temperatur (Kern VDI 6007)' },
] as const;

export type GateState = 'met' | 'partial' | 'blocked' | 'na';

export interface ConformityGate {
  id: string;
  name: string;
  state: GateState;
  note: string;
}

/**
 * Gate status for the non-normative Quick Estimate v1 profile. The
 * license/validation/approval gates are BLOCKED by construction — so the
 * overall conformity claim is `none`.
 */
export const QUICK_ESTIMATE_GATES: readonly ConformityGate[] = [
  { id: 'G1', name: 'Lizenz', state: 'met', note: 'Lizenzen für DIN/VDI-Inhalte vorhanden (DEC-008). Nutzung im Software-/KI-Kontext zulässig.' },
  { id: 'G2', name: 'Version', state: 'met', note: 'Profil quick-estimate-v1 ist in sich vollständig und versioniert.' },
  { id: 'G3', name: 'Eingabe', state: 'partial', note: 'Eingaben aus Geometrie + Profil-Defaults; lizenzierte NORM-PARAM-Tabellen (Klimadaten, ψ-Katalog, DIN-1946-6-/VDI-2078-Parameter) noch nicht als Evidence eingepflegt.' },
  { id: 'G4', name: 'Verfahren', state: 'met', note: 'Zweck = transparente Plausibilitätsschätzung; Methode passt dazu.' },
  { id: 'G5', name: 'Berechnung', state: 'met', note: 'Deterministisch, keine Solverfehler; Wertebereichs-/Regressionstests bestanden.' },
  { id: 'G6', name: 'Validierung', state: 'blocked', note: 'Keine lizenzierten Referenzfälle geprüft.' },
  { id: 'G7', name: 'Nachweis', state: 'partial', note: 'Bericht enthält Herkunft, Zwischenwerte, Disclaimer; kein vollständiger Normnachweis.' },
  { id: 'G8', name: 'Freigabe', state: 'blocked', note: 'Bestätigung durch qualifizierte Person erforderlich (nicht für nicht-normative Schätzung).' },
] as const;

export interface ConformityStatus {
  /** Overall claim — always `none` for the non-normative profile. */
  claim: 'none';
  gates: ConformityGate[];
  /** Ids of gates that are not yet met (blocked or partial). */
  openGates: string[];
}

export function quickEstimateConformity(): ConformityStatus {
  const gates = QUICK_ESTIMATE_GATES.map((g) => ({ ...g }));
  return {
    claim: 'none',
    gates,
    openGates: gates.filter((g) => g.state !== 'met' && g.state !== 'na').map((g) => g.id),
  };
}

/** Formula ids used by the engine (for the result's methodRefs). */
export function methodRefIds(): string[] {
  return FORMULA_REGISTRY.map((f) => f.id);
}
