/**
 * Manual control panel for the Live tab.
 *
 * Scene buttons (alle auf / Halbschatten / alle zu) plus a per-window slider
 * for direct manual moves. Posts through `useControl`; the engine handles
 * manual-override semantics on its next cycle.
 */

import { h, type JSX } from 'preact';
import { useState } from 'preact/hooks';

import { useControl } from '../hooks/useControl.js';
import { windowDisplayName } from '../format.js';
import type { DashboardSnapshotWindow } from '../types.js';

export interface ControlPanelProps {
  windows: DashboardSnapshotWindow[];
}

const SCENES: ReadonlyArray<{ label: string; level01: number; testId: string }> = [
  { label: 'Alle auf', level01: 0, testId: 'scene-open' },
  { label: 'Halbschatten', level01: 0.5, testId: 'scene-half' },
  { label: 'Alle zu', level01: 1, testId: 'scene-close' },
];

export function ControlPanel(props: ControlPanelProps): JSX.Element {
  const control = useControl();
  const ids = props.windows.map((w) => w.id);
  // Local slider positions per window (percent), seeded from current level.
  const [pos, setPos] = useState<Record<string, number>>({});

  const posFor = (w: DashboardSnapshotWindow): number => {
    const local = pos[w.id];
    if (local !== undefined) {
      return local;
    }
    return Math.round((w.currentLevel01 ?? 0) * 100);
  };

  return (
    <section class="control-panel" data-testid="control-panel">
      <header class="control-panel__head">
        <h3>Manuelle Steuerung</h3>
        {control.busy.value && <span class="control-panel__busy">…</span>}
      </header>

      <div class="control-panel__scenes" data-testid="control-scenes">
        {SCENES.map((s) => (
          <button
            key={s.testId}
            type="button"
            class="control-panel__scene-btn"
            data-testid={s.testId}
            disabled={control.busy.value || ids.length === 0}
            onClick={(): void => {
              void control.applyScene(ids, s.level01);
            }}
          >
            {s.label}
          </button>
        ))}
      </div>

      {control.lastError.value !== null && (
        <p class="control-panel__error" data-testid="control-error">
          Fehler: {control.lastError.value}
        </p>
      )}

      <ul class="control-panel__windows">
        {props.windows.map((w) => {
          const p = posFor(w);
          return (
            <li key={w.id} class="control-panel__window" data-testid={`control-window-${w.id}`}>
              <span class="control-panel__window-name">{windowDisplayName(w)}</span>
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={p}
                data-testid={`control-slider-${w.id}`}
                onInput={(e): void => {
                  const v = Number.parseInt((e.currentTarget as HTMLInputElement).value, 10);
                  setPos((prev) => ({ ...prev, [w.id]: Number.isFinite(v) ? v : 0 }));
                }}
              />
              <output class="control-panel__window-pct">{p}%</output>
              <button
                type="button"
                class="control-panel__apply"
                data-testid={`control-apply-${w.id}`}
                disabled={control.busy.value}
                onClick={(): void => {
                  void control.setShutter(w.id, p / 100);
                }}
              >
                Fahren
              </button>
            </li>
          );
        })}
        {props.windows.length === 0 && (
          <li class="control-panel__empty">Keine Fenster konfiguriert.</li>
        )}
      </ul>
    </section>
  );
}
