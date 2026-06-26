/**
 * Clickable 8-point compass for choosing a window/shutter
 * orientation. Click a direction → the orientation (in degrees,
 * 0 = N clockwise) is reported via `onChange`. The currently
 * selected direction is highlighted and labelled.
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
  const selected = Math.round((((props.value % 360) + 360) % 360) / 45) * 45 % 360;

  return (
    <div
      class={`compass ${props.disabled === true ? 'compass--disabled' : ''}`}
      data-testid="compass-picker"
      data-value={String(props.value)}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={c} cy={c} r={r + 8} fill="#0f172a" />
        <circle cx={c} cy={c} r={r + 8} fill="none" stroke="#334155" stroke-width="2" />
        {/* pointer to the selected direction */}
        {(() => {
          const rad = ((selected - 90) * Math.PI) / 180;
          const x = c + Math.cos(rad) * r;
          const y = c + Math.sin(rad) * r;
          return <line x1={c} y1={c} x2={x} y2={y} stroke="#f59e0b" stroke-width="3" />;
        })()}
        {POINTS.map((p) => {
          const rad = ((p.deg - 90) * Math.PI) / 180;
          const x = c + Math.cos(rad) * r;
          const y = c + Math.sin(rad) * r;
          const isSel = p.deg === selected;
          return (
            <g key={p.deg}>
              <circle
                cx={x}
                cy={y}
                r={isSel ? 13 : 11}
                fill={isSel ? '#f59e0b' : '#1e293b'}
                stroke={isSel ? '#fff' : '#475569'}
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
                fill={isSel ? '#0f172a' : '#cbd5e1'}
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
        {compassLabel(props.value)} · {selected}°
      </div>
    </div>
  );
}
