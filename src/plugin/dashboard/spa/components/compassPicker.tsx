/**
 * Clickable 8-point compass for choosing a window/shutter
 * orientation. Click a direction → the orientation (in degrees,
 * 0 = N clockwise) is reported via `onChange`. The pointer follows the EXACT
 * value (not snapped), and a precise degree field below lets the user enter any
 * orientation 0–359° — the 8 points are only quick presets. This removes the
 * former ±22.5° error from snapping everything to 45° (forum request).
 */

import { h, type JSX } from 'preact';

import { compassLabel } from '../format.js';
import { t } from '../i18n.js';

interface Props {
  value: number;
  onChange: (deg: number) => void;
  disabled?: boolean;
  size?: number;
}

const POINTS: ReadonlyArray<{ deg: number; label: string }> = [
  { deg: 0, label: 'N' },
  { deg: 45, label: 'NO' },
  { deg: 90, label: 'O' },
  { deg: 135, label: 'SO' },
  { deg: 180, label: 'S' },
  { deg: 225, label: 'SW' },
  { deg: 270, label: 'W' },
  { deg: 315, label: 'NW' },
];

/** Bilingual display text for a compass point (the German label drives test ids). */
function pointDisplay(label: string): string {
  const en: Record<string, string> = {
    N: 'N',
    NO: 'NE',
    O: 'E',
    SO: 'SE',
    S: 'S',
    SW: 'SW',
    W: 'W',
    NW: 'NW',
  };
  return t(label, en[label] ?? label);
}

export function CompassPicker(props: Props): JSX.Element {
  const size = props.size ?? 120;
  const c = size / 2;
  const r = c - 16;
  // Exact, normalized orientation (0..359) — the pointer follows this, so free
  // degree values render truthfully instead of jumping to the nearest 45°.
  const actual = (((Math.round(props.value) % 360) + 360) % 360);
  const clampDeg = (v: number): number => (((Math.round(v) % 360) + 360) % 360);

  return (
    <div
      class={`compass ${props.disabled === true ? 'compass--disabled' : ''}`}
      data-testid="compass-picker"
      data-value={String(props.value)}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={c} cy={c} r={r + 8} fill="var(--color-bg)" />
        <circle cx={c} cy={c} r={r + 8} fill="none" stroke="var(--color-card-border)" stroke-width="2" />
        {/* pointer to the EXACT current direction */}
        {(() => {
          const rad = ((actual - 90) * Math.PI) / 180;
          const x = c + Math.cos(rad) * r;
          const y = c + Math.sin(rad) * r;
          return <line x1={c} y1={c} x2={x} y2={y} stroke="var(--color-accent)" stroke-width="3" />;
        })()}
        {POINTS.map((p) => {
          const rad = ((p.deg - 90) * Math.PI) / 180;
          const x = c + Math.cos(rad) * r;
          const y = c + Math.sin(rad) * r;
          const isSel = Math.abs(p.deg - actual) < 1 || Math.abs(p.deg - actual) > 359;
          return (
            <g key={p.deg}>
              <circle
                cx={x}
                cy={y}
                r={isSel ? 13 : 11}
                fill={isSel ? 'var(--color-accent)' : 'var(--color-card)'}
                stroke={isSel ? 'var(--color-text)' : 'var(--color-card-border-strong)'}
                stroke-width="1.5"
                style={props.disabled === true ? '' : 'cursor:pointer'}
                data-testid={`compass-point-${p.label}`}
                onClick={(): void => {
                  if (props.disabled !== true) props.onChange(p.deg);
                }}
              />
              <text
                x={x}
                y={y + 4}
                text-anchor="middle"
                font-size="10"
                fill={isSel ? 'var(--color-accent-contrast)' : 'var(--color-muted)'}
                style={props.disabled === true ? '' : 'cursor:pointer; user-select:none'}
                onClick={(): void => {
                  if (props.disabled !== true) props.onChange(p.deg);
                }}
              >
                {pointDisplay(p.label)}
              </text>
            </g>
          );
        })}
      </svg>
      <div class="compass__readout">
        {compassLabel(props.value)} · {actual}°
      </div>
      <label class="compass__degree">
        <span>{t('Grad', 'Degrees')}</span>
        <input
          type="number"
          min={0}
          max={359}
          step={1}
          value={String(actual)}
          disabled={props.disabled === true}
          data-testid="compass-degree-input"
          onInput={(e): void => {
            if (props.disabled === true) return;
            const raw = Number((e.currentTarget as HTMLInputElement).value);
            if (Number.isFinite(raw)) props.onChange(clampDeg(raw));
          }}
        />
        <span aria-hidden="true">°</span>
      </label>
    </div>
  );
}
