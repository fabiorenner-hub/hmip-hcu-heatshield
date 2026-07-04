/**
 * Thermal knowledge model — entity / variable catalog (thermal-load-engine).
 *
 * Machine-readable data dictionary derived from the non-normative
 * "Normen-KI" package (Wissensmodell.json + Variablenkatalog.csv). It is the
 * schema backbone the README recommends: a separate, versioned registry with
 * per-field provenance, feeding EvidenceRecord / Assumption / CalculationRun /
 * ValidationResult so answers can be layered into "normativ belegt / Erklärung
 * / Annahme".
 *
 * Reference data only — pure, no I/O, no zod. NOT re-exported from the thermal
 * index (kept out of the SPA bundle); imported directly where needed. Contains
 * NO licensed normative values; every field requires provenance to be filled.
 */

export interface CatalogField {
  name: string;
  /** Unit or type ('°C', 'm²', 'm³', 'ISO 8601', or 'projektabhängig'). */
  unit: string;
  /** Provenance (source/evidence) required before use — always true here. */
  provenanceRequired: true;
}

export interface CatalogEntity {
  name: string;
  description: string;
  fields: CatalogField[];
}

function f(name: string, unit = 'projektabhängig'): CatalogField {
  return { name, unit, provenanceRequired: true };
}

/** The 22 entities of the non-normative knowledge model. */
export const KNOWLEDGE_ENTITIES: readonly CatalogEntity[] = [
  { name: 'Project', description: 'Projekt- und Vertragskontext', fields: ['project_id', 'country', 'jurisdiction', 'calculation_purpose', 'standard_profile_id', 'client_requirements', 'author', 'reviewer'].map((x) => f(x)) },
  { name: 'StandardProfile', description: 'Gebündelte Versionen und Korrekturen', fields: [f('profile_id'), f('effective_date', 'ISO 8601'), f('documents'), f('amendments'), f('national_annexes'), f('parameter_set_hash'), f('status')] },
  { name: 'Building', description: 'Gebäudebezogene Stammdaten', fields: ['building_id', 'address', 'altitude', 'orientation', 'gross_geometry', 'air_tightness', 'exposure_class'].map((x) => f(x)) },
  { name: 'UsageUnit', description: 'Nutzungseinheit, insbesondere für Wohnungslüftung', fields: [f('unit_id'), f('building_id'), f('area', 'm²'), f('volume', 'm³'), f('occupancy'), f('thermal_protection_class'), f('ventilation_concept_required')] },
  { name: 'Zone', description: 'Thermische oder lüftungstechnische Zone', fields: [f('zone_id'), f('type'), f('design_temperature_heating', '°C'), f('cooling_setpoint', '°C'), f('pressure_regime'), f('schedule_set')] },
  { name: 'Room', description: 'Raum als primäre Auslegungseinheit', fields: [f('room_id'), f('zone_id'), f('name'), f('area', 'm²'), f('volume', 'm³'), f('height'), f('usage'), f('design_temperatures', '°C'), f('adjacencies')] },
  { name: 'Surface', description: 'Fläche zwischen zwei Randbereichen', fields: [f('surface_id'), f('room_id'), f('boundary_type'), f('area', 'm²'), f('orientation'), f('tilt'), f('construction_id'), f('opening_ids')] },
  { name: 'Construction', description: 'Schichtaufbau und thermische Kennwerte', fields: ['construction_id', 'layers', 'u_value', 'heat_capacity', 'density', 'conductivity', 'source', 'validity'].map((x) => f(x)) },
  { name: 'ThermalBridge', description: 'Lineare oder punktförmige Wärmebrücke', fields: ['bridge_id', 'type', 'length_or_count', 'psi_or_chi', 'source', 'adjacent_boundaries'].map((x) => f(x)) },
  { name: 'GroundContact', description: 'Erdreichberührtes Bauteil', fields: [f('ground_id'), f('area', 'm²'), f('perimeter'), f('depth'), f('insulation_geometry'), f('soil_parameters'), f('equivalent_u_method')] },
  { name: 'Opening', description: 'Fenster, Tür oder große Öffnung', fields: [f('opening_id'), f('surface_id'), f('area', 'm²'), f('u_value'), f('g_value'), f('frame_fraction'), f('shading_system'), f('airflow_characteristic')] },
  { name: 'VentilationSystem', description: 'Freie oder ventilatorgestützte Lüftung', fields: ['system_id', 'system_type', 'supply_rooms', 'exhaust_rooms', 'design_flows', 'heat_recovery', 'fan_heat', 'frost_control'].map((x) => f(x)) },
  { name: 'AirflowPath', description: 'Gerichtete Luftströmung zwischen Knoten', fields: ['path_id', 'from_node', 'to_node', 'flow_type', 'flow_rate_or_curve', 'pressure_exponent', 'schedule'].map((x) => f(x)) },
  { name: 'WeatherData', description: 'Heiz- oder Kühllast-Wetterdatensatz', fields: [f('weather_id'), f('source'), f('location'), f('altitude'), f('design_outdoor_temperature', '°C'), f('time_series'), f('solar_components'), f('version')] },
  { name: 'InternalGain', description: 'Personen, Beleuchtung, Geräte und Prozesse', fields: ['gain_id', 'room_id', 'gain_type', 'sensible_convective', 'sensible_radiative', 'latent', 'schedule_id', 'source'].map((x) => f(x)) },
  { name: 'Schedule', description: 'Zeitprofil', fields: ['schedule_id', 'time_basis', 'values', 'interpolation', 'timezone', 'holiday_calendar'].map((x) => f(x)) },
  { name: 'HVACSystem', description: 'Heiz-, Kühl-, Lüftungs- und Flächensysteme', fields: ['hvac_id', 'served_rooms', 'capacity', 'delivery_type', 'supply_conditions', 'control_id', 'availability'].map((x) => f(x)) },
  { name: 'Control', description: 'Regelstrategie', fields: [f('control_id'), f('controlled_variable'), f('setpoint_schedule', '°C'), f('deadband'), f('limits'), f('priority'), f('solver_coupling')] },
  { name: 'CalculationRun', description: 'Unveränderlicher Berechnungslauf', fields: [f('run_id'), f('profile_id'), f('input_snapshot_hash'), f('software_version'), f('solver_version'), f('timestamp', 'ISO 8601'), f('results'), f('qa_status')] },
  { name: 'EvidenceRecord', description: 'Nachweis der Herkunft eines Werts', fields: ['evidence_id', 'object_id', 'field', 'value', 'unit', 'source_type', 'document', 'clause_or_table', 'entered_by', 'verified_by'].map((x) => f(x)) },
  { name: 'Assumption', description: 'Explizite Annahme oder Ersatzwert', fields: ['assumption_id', 'scope', 'value', 'reason', 'impact', 'approval', 'expiry'].map((x) => f(x)) },
  { name: 'ValidationResult', description: 'Ergebnis einer Prüfregel', fields: ['validation_id', 'rule_id', 'severity', 'object_id', 'message', 'measured_value', 'threshold', 'resolution'].map((x) => f(x)) },
] as const;

export function entityByName(name: string): CatalogEntity | undefined {
  return KNOWLEDGE_ENTITIES.find((e) => e.name === name);
}

/** The three answer layers the package recommends for every reported value. */
export type AnswerLayer = 'normativ_belegt' | 'fachliche_erklaerung' | 'annahme';
export const ANSWER_LAYERS: readonly AnswerLayer[] = ['normativ_belegt', 'fachliche_erklaerung', 'annahme'];
