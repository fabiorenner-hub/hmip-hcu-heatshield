/**
 * Stacked horizontal risk bar (Task 11.2).
 *
 * Renders one `<div>` per risk factor, sized by `factor[i] *
 * weight[i]`. The eight factor names are taken from the engine's
 * `risk.ts` and rendered in the same canonical order so the
 * dashboard reads consistently across browsers and across reloads.
 *
 * When no breakdown is available (e.g. before the first
 * `cycle.completed` event) the bar collapses to an empty track.
 */

import { h, type JSX } from 'preact';

import { t } from '../i18n.js';
import type { RiskFactorName, WindowRiskBreakdown } from '../types.js';

const FACTOR_ORDER: RiskFactorName[] = [
  'sunFactor',
  'roomTempFactor',
  'windowTypeFactor',
  'forecastTempFactor',
  'pvFactor',
  'radiationFactor',
  'outdoorTempFactor',
  'priorityFactor',
];

const FACTOR_COLORS: Record<RiskFactorName, string> = {
  sunFactor: '#f4b400',
  roomTempFactor: '#db4437',
  windowTypeFactor: '#9c27b0',
  forecastTempFactor: '#3f51b5',
  pvFactor: '#0f9d58',
  radiationFactor: '#ff9800',
  outdoorTempFactor: '#4285f4',
  priorityFactor: '#8e8e8e',
};

const FACTOR_LABELS: Record<RiskFactorName, () => string> = {
  sunFactor: (): string => t('Sonne', 'Sun'),
  roomTempFactor: (): string => t('Raum °C', 'Room °C'),
  windowTypeFactor: (): string => t('Fenstertyp', 'Window type'),
  forecastTempFactor: (): string => t('Vorhersage °C', 'Forecast °C'),
  pvFactor: (): string => t('PV', 'PV'),
  radiationFactor: (): string => t('Strahlung', 'Radiation'),
  outdoorTempFactor: (): string => t('Außen °C', 'Outdoor °C'),
  priorityFactor: (): string => t('Priorität', 'Priority'),
};

export interface RiskBarProps {
  breakdown: WindowRiskBreakdown | null;
}

export function RiskBar(props: RiskBarProps): JSX.Element {
  const breakdown = props.breakdown;
  const segments = FACTOR_ORDER.map((name) => {
    const factor = breakdown?.factors[name] ?? 0;
    const weight = breakdown?.weights[name] ?? 0;
    const widthPct = clamp01(factor) * clamp01(weight) * 100;
    return { name, factor, weight, widthPct };
  });

  const risk = breakdown?.risk ?? 0;

  return (
    <div class="risk-bar" data-testid="risk-bar">
      <div class="risk-bar__track" role="img" aria-label={`${t('Risiko', 'Risk')} ${risk.toFixed(2)}`}>
        {segments.map((s) => (
          <div
            key={s.name}
            class="risk-bar__segment"
            data-factor={s.name}
            style={{
              width: `${s.widthPct.toFixed(1)}%`,
              background: FACTOR_COLORS[s.name],
            }}
            title={`${FACTOR_LABELS[s.name]()}: factor=${s.factor.toFixed(2)}, weight=${s.weight.toFixed(2)}`}
          />
        ))}
      </div>
      <span class="risk-bar__total" data-testid="risk-total">
        {risk.toFixed(2)}
      </span>
    </div>
  );
}

function clamp01(n: number): number {
  if (!Number.isFinite(n) || n <= 0) {
    return 0;
  }
  if (n >= 1) {
    return 1;
  }
  return n;
}
