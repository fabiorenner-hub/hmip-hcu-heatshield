/**
 * Heat Shield — deviation detector
 * (predictive-control-dashboard Requirement 4).
 *
 * Pure: compares the measured indoor temp / heat load against the value the
 * forecast predicted for "now". An off-plan move is triggered only when the
 * absolute deviation exceeds the configured tolerance (Requirement 4.2/4.3).
 */

export interface DeviationInputs {
  readonly roomId: string;
  readonly measuredIndoorTempC: number | null;
  readonly measuredHeatLoad01: number | null;
  readonly forecastIndoorTempC: number | null;
  readonly forecastHeatLoad01: number | null;
  readonly toleranceC: number;
  readonly toleranceLoad01: number;
}

export interface DeviationResult {
  readonly roomId: string;
  readonly deviationC: number | null;
  readonly deviationLoad01: number | null;
  readonly exceedsTolerance: boolean;
  readonly triggeringValue: 'temp' | 'load' | null;
}

/**
 * Detect whether the room deviates from its forecast beyond tolerance.
 * `deviationC = measured − forecast`. `exceedsTolerance` is true iff
 * `|deviationC| > toleranceC` OR `|deviationLoad01| > toleranceLoad01`.
 */
export function detectDeviation(inputs: DeviationInputs): DeviationResult {
  const deviationC =
    inputs.measuredIndoorTempC !== null && inputs.forecastIndoorTempC !== null
      ? inputs.measuredIndoorTempC - inputs.forecastIndoorTempC
      : null;
  const deviationLoad01 =
    inputs.measuredHeatLoad01 !== null && inputs.forecastHeatLoad01 !== null
      ? inputs.measuredHeatLoad01 - inputs.forecastHeatLoad01
      : null;

  const tempExceeds =
    deviationC !== null && Math.abs(deviationC) > inputs.toleranceC;
  const loadExceeds =
    deviationLoad01 !== null &&
    Math.abs(deviationLoad01) > inputs.toleranceLoad01;

  let triggeringValue: 'temp' | 'load' | null = null;
  if (tempExceeds) {
    triggeringValue = 'temp';
  } else if (loadExceeds) {
    triggeringValue = 'load';
  }

  return {
    roomId: inputs.roomId,
    deviationC,
    deviationLoad01,
    exceedsTolerance: tempExceeds || loadExceeds,
    triggeringValue,
  };
}
