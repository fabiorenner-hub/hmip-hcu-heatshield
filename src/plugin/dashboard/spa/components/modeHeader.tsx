/**
 * Mode header (Task 11.4).
 *
 * Renders the engine's current mode as a coloured banner with:
 *   - the mode name + a contextual icon (wrench for MAINTENANCE,
 *     warning for STORM, …),
 *   - the next-cycle countdown derived from
 *     `controlIntervalSeconds`, and
 *   - the SSE connection state pill.
 *
 * STORM uses a blinking dark-red background per the design brief;
 * the blink is driven by a CSS keyframe so the component stays
 * pure.
 */

import { h, type JSX } from 'preact';

import { CONNECTION_LABELS_DE, MODE_LABELS_DE } from '../format.js';
import type { ConnectionState } from '../store.js';
import type { Mode } from '../types.js';

const MODE_ICONS: Record<Mode, string> = {
  NORMAL: '·',
  SUMMER_WATCH: '☀︎',
  ACTIVE_HEAT_PROTECTION: '🛡',
  HEATWAVE: '🔥',
  NIGHT_COOLING: '🌙',
  STORM: '⚠',
  VACATION: '✈︎',
  MAINTENANCE: '🔧',
};

export interface ModeHeaderProps {
  mode: Mode | null;
  connection: ConnectionState;
  /** Seconds until the next engine cycle, or `null` if unknown. */
  nextCycleInSeconds: number | null;
  /** Optional storm warning copy (e.g. wind speed). */
  stormSubtitle?: string;
}

export function ModeHeader(props: ModeHeaderProps): JSX.Element {
  const mode: Mode = props.mode ?? 'NORMAL';
  const icon = MODE_ICONS[mode];
  const label = MODE_LABELS_DE[mode] ?? mode;

  return (
    <header
      class={`mode-header mode-header--${mode.toLowerCase()}`}
      data-mode={mode}
      data-testid="mode-header"
    >
      <div class="mode-header__primary">
        <span class="mode-header__icon" aria-hidden="true">
          {icon}
        </span>
        <h2 class="mode-header__label">{label}</h2>
        {mode === 'STORM' && (
          <span class="mode-header__warning" data-testid="storm-warning">
            {props.stormSubtitle ?? 'Sturmschutz aktiv'}
          </span>
        )}
      </div>
      <div class="mode-header__meta">
        {props.nextCycleInSeconds !== null && (
          <span class="mode-header__cycle" data-testid="cycle-countdown">
            nächster Zyklus in {Math.max(0, Math.round(props.nextCycleInSeconds))}s
          </span>
        )}
        <span
          class={`mode-header__pill mode-header__pill--${props.connection}`}
          data-testid="connection-state"
        >
          {CONNECTION_LABELS_DE[props.connection] ?? props.connection}
        </span>
      </div>
    </header>
  );
}
