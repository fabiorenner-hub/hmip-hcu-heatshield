/**
 * Per-window live card (Task 11.2).
 *
 * Renders the SVG shutter animation, the current/target percentage
 * pair, and the stacked risk bar. The SVG is built from `SLAT_COUNT`
 * horizontal slats stacked top-down inside a 240×120 viewBox; the
 * group containing the slats translates downward as the shutter
 * closes (level01 = 1) and back up to the top as it opens (level01
 * = 0). A 1.5 s CSS transition smooths the animation on every
 * level change.
 *
 * Manual override is shown as a small badge next to the title when
 * `manualOverrideUntil` is in the future.
 */

import { h, type JSX } from 'preact';

import { MODE_LABELS_DE, windowDisplayName } from '../format.js';
import type { DashboardSnapshotWindow, WindowRiskBreakdown } from '../types.js';

import { RiskBar } from './riskBar.js';

const VIEWBOX_W = 240;
const VIEWBOX_H = 120;
const SLAT_COUNT = 12;
const SLAT_HEIGHT = VIEWBOX_H / SLAT_COUNT;

export interface WindowCardProps {
  window: DashboardSnapshotWindow;
  /** Risk breakdown from the most recent cycle, when available. */
  risk: WindowRiskBreakdown | null;
  /** Now-clock used to evaluate `manualOverrideUntil`. Defaults to `new Date()`. */
  now?: Date;
}

export function WindowCard(props: WindowCardProps): JSX.Element {
  const w = props.window;
  const now = props.now ?? new Date();
  const currentLevel01 = clamp01(w.currentLevel01 ?? 0);
  const targetLevel01 = clamp01(props.risk?.finalTarget ?? currentLevel01);

  // The slats group is `SLAT_COUNT * SLAT_HEIGHT` tall, anchored at
  // `y = -VIEWBOX_H` when fully open and `y = 0` when fully closed.
  const slatsTranslateY = -VIEWBOX_H + currentLevel01 * VIEWBOX_H;

  const overrideActive =
    w.manualOverrideUntil !== null && new Date(w.manualOverrideUntil).getTime() > now.getTime();

  const hasRisk = props.risk !== null;
  const movingUp = targetLevel01 < currentLevel01 - 0.005;
  const movingDown = targetLevel01 > currentLevel01 + 0.005;
  const arrow = movingDown ? '↓ schließt' : movingUp ? '↑ öffnet' : '· hält';

  return (
    <article class="window-card" data-window-id={w.id}>
      <header class="window-card__header">
        <h3 class="window-card__title">{windowDisplayName(w)}</h3>
        {overrideActive && (
          <span class="window-card__badge" data-testid="manual-override-badge" title="Manuelle Übersteuerung aktiv">
            Manuell
          </span>
        )}
        {w.lastDecisionMode !== null && (
          <span class="window-card__mode" data-mode={w.lastDecisionMode}>
            {MODE_LABELS_DE[w.lastDecisionMode] ?? w.lastDecisionMode}
          </span>
        )}
      </header>

      <svg
        class="window-card__svg"
        viewBox={`0 0 ${VIEWBOX_W} ${VIEWBOX_H}`}
        role="img"
        aria-label={`Rollladen zu ${(currentLevel01 * 100).toFixed(0)} Prozent geschlossen`}
        data-testid="shutter-svg"
      >
        <defs>
          <linearGradient id={`sky-${w.id}`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stop-color="#a8d4ff" />
            <stop offset="100%" stop-color="#e6f3ff" />
          </linearGradient>
        </defs>
        {/* Sky background */}
        <rect x={0} y={0} width={VIEWBOX_W} height={VIEWBOX_H} fill={`url(#sky-${w.id})`} />
        {/* Shutter slats group, translated by current level. */}
        <g
          class="window-card__slats"
          data-testid="shutter-slats"
          style={{
            transform: `translateY(${slatsTranslateY}px)`,
            transition: 'transform 1.5s ease-in-out',
          }}
        >
          {Array.from({ length: SLAT_COUNT }).map((_unused, i) => (
            <rect
              key={i}
              x={0}
              y={i * SLAT_HEIGHT}
              width={VIEWBOX_W}
              height={SLAT_HEIGHT - 1}
              fill="#5a4a3a"
              stroke="#3d2f24"
              stroke-width={0.5}
            />
          ))}
        </g>
      </svg>

      <div class="window-card__levels" data-testid="window-card-levels">
        <span class="window-card__level-block">
          <span class="window-card__level-label">Aktuell</span>
          <span class="window-card__level-value" data-testid="current-level">
            {(currentLevel01 * 100).toFixed(0)}%
          </span>
        </span>
        <span class="window-card__level-arrow">{arrow}</span>
        <span class="window-card__level-block">
          <span class="window-card__level-label">Ziel</span>
          <span class="window-card__level-value" data-testid="target-level">
            {(targetLevel01 * 100).toFixed(0)}%
          </span>
        </span>
      </div>

      {hasRisk ? (
        <RiskBar breakdown={props.risk} />
      ) : (
        <p class="window-card__norisk">Noch keine aktuelle Bewertung.</p>
      )}
    </article>
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
