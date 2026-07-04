/**
 * Heat Shield — Übersicht NextActionStrip (uebersicht-rework, Task 6).
 *
 * Answers "what will Heat Shield do next?" with the single next planned move:
 * time · room/facade · direction · reason · target, plus a count of further
 * planned actions and a deep link to the full plan (Automatik). Pure/
 * presentational; the deep link navigates, it never issues a control call.
 */

import { h, Fragment, type JSX } from 'preact';
import { route } from 'preact-router';

import { t, tServer, fmtTime } from '../../i18n.js';
import { compassLabel } from '../../format.js';
import type { DashboardSnapshot, FacadeKey } from '../../types.js';
import { futurePlannedActions } from './uebersichtModel.js';

const FACADE_DEG: Record<FacadeKey, number> = { N: 0, E: 90, S: 180, W: 270 };

/** Resolve a human room label + facade for a window id from the snapshot. */
function roomForWindow(
  snap: DashboardSnapshot,
  windowId: string,
): { name: string; facade: FacadeKey | null } {
  const rd = (snap.roomsDetail ?? []).find((r) => r.windowId === windowId);
  if (rd !== undefined) return { name: rd.name, facade: rd.facade };
  const w = (snap.windows ?? []).find((x) => x.id === windowId);
  return { name: w?.name ?? t('Fenster', 'Window'), facade: null };
}

export function NextActionStrip(props: {
  snapshot: DashboardSnapshot;
  now?: Date;
}): JSX.Element {
  const snap = props.snapshot;
  const future = futurePlannedActions(snap, props.now ?? new Date());
  const next = future[0] ?? null;

  if (next === null) {
    return (
      <section class="hs-next hs-next--empty" data-testid="next-action-strip">
        <span class="hs-next__eyebrow">{t('Als Nächstes', 'Up next')}</span>
        <p class="hs-next__empty" data-testid="next-action-empty">
          {t('Keine Fahrt geplant.', 'No move planned.')}
        </p>
      </section>
    );
  }

  const { name, facade } = roomForWindow(snap, next.windowId);
  const closing = next.targetPercent >= 50;
  const dir = closing ? t('Schließen', 'Close') : t('Öffnen', 'Open');
  const facadeLabel = facade !== null ? compassLabel(FACADE_DEG[facade]) : null;
  const more = future.length - 1;

  return (
    <section class="hs-next" data-testid="next-action-strip" data-state={next.state}>
      <span class="hs-next__eyebrow">{t('Als Nächstes', 'Up next')}</span>
      <div class="hs-next__row">
        <span class="hs-next__time" data-testid="next-action-time">
          {fmtTime(next.scheduledTs)}
        </span>
        <span class="hs-next__where">
          {name}
          {facadeLabel !== null && <span class="hs-next__facade"> · {facadeLabel}</span>}
        </span>
        <span class={`hs-next__dir hs-next__dir--${closing ? 'close' : 'open'}`}>
          {dir} <span class="hs-next__target">→ {Math.round(next.targetPercent)} %</span>
        </span>
      </div>
      <p class="hs-next__reason" data-testid="next-action-reason">
        {tServer(next.reason)}
      </p>
      <div class="hs-next__foot">
        {more > 0 && (
          <span class="hs-next__more" data-testid="next-action-more">
            {t(`${more} weitere geplant`, `${more} more planned`)}
          </span>
        )}
        <button
          type="button"
          class="hs-next__link"
          data-testid="next-action-details"
          onClick={(): void => {
            route('/automatik');
          }}
        >
          {t('Alle Aktionen anzeigen', 'Show all actions')}
        </button>
      </div>
    </section>
  );
}
