/**
 * Heat Shield — "Garten" primary view (Blueprint Phase 7).
 *
 * Wraps the existing irrigation content (`IrrigationTab`) with a hero primary
 * statement answering "must I water today?": no watering needed / watering
 * planned / safety block / incomplete data — plus water balance, soil moisture,
 * daily budget, next check and expected rain. Derived from the live irrigation
 * snapshot; nothing invented.
 */

import { h, Fragment, type JSX } from 'preact';

import { IrrigationTab } from './irrigation.js';
import { snapshot } from '../store.js';
import { t } from '../i18n.js';
import type { IrrigationInfo } from '../types.js';

interface RoutableProps {
  path?: string;
  default?: boolean;
}

function avg(nums: number[]): number | null {
  const v = nums.filter((n) => Number.isFinite(n));
  return v.length === 0 ? null : Math.round(v.reduce((a, b) => a + b, 0) / v.length);
}

interface Head {
  tone: 'calm' | 'active' | 'alert';
  title: string;
}

function heroHead(irr: IrrigationInfo): Head {
  if (!irr.enabled) {
    return { tone: 'calm', title: t('Bewässerung ist ausgeschaltet', 'Irrigation is turned off') };
  }
  if (irr.error !== null) {
    return { tone: 'alert', title: t('Datenproblem — bitte Diagnose prüfen', 'Data problem — please check diagnostics') };
  }
  const blocked = irr.zones.find((z) => z.blockedBy !== null);
  if (blocked !== undefined) {
    return { tone: 'alert', title: t(`Sicherheitssperre aktiv (${blocked.blockedBy})`, `Safety block active (${blocked.blockedBy})`) };
  }
  const planned = irr.zones.some((z) => z.nextWateringTs !== null) || irr.plan.some((p) => p.enabled && !p.done);
  if (planned) {
    return { tone: 'active', title: t('Bewässerung geplant', 'Watering planned') };
  }
  return { tone: 'calm', title: t('Keine Bewässerung erforderlich', 'No watering needed') };
}

/** Soonest next-watering timestamp across zones, or null. */
function nextCheck(irr: IrrigationInfo): string | null {
  const ts = irr.zones
    .map((z) => z.nextWateringTs)
    .filter((v): v is string => v !== null)
    .map((v) => Date.parse(v))
    .filter((n) => Number.isFinite(n));
  if (ts.length === 0) return null;
  const soonest = Math.min(...ts);
  const d = new Date(soonest);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function GartenHero(): JSX.Element | null {
  const snap = snapshot.value;
  const irr = snap?.irrigation;
  if (irr === undefined) return null;
  const head = heroHead(irr);
  const soil = avg(irr.zones.map((z) => z.availablePct));
  const budgetMin = Math.round(irr.totalSecondsUsedToday / 60);
  const next = nextCheck(irr);

  return (
    <section class={`lagekarte lagekarte--${head.tone}`} data-testid="garten-hero" data-tone={head.tone}>
      <h2 class="lagekarte__headline">{head.title}</h2>
      <div class="lagekarte__facts">
        <Fact
          label={t('Wasserbilanz heute', 'Water balance today')}
          value={
            irr.rainTodayMm === null && irr.et0TodayMm === null
              ? '–'
              : t(
                  `Regen ${irr.rainTodayMm ?? 0} / Bedarf ${irr.et0TodayMm ?? 0} mm`,
                  `Rain ${irr.rainTodayMm ?? 0} / need ${irr.et0TodayMm ?? 0} mm`,
                )
          }
        />
        <Fact label={t('Ø Bodenfeuchte', 'Avg. soil moisture')} value={soil === null ? '–' : `${soil} %`} />
        <Fact label={t('Tagesbudget genutzt', 'Daily budget used')} value={`${budgetMin} min`} />
        <Fact
          label={t('Nächste Prüfung', 'Next check')}
          value={next ?? t('offen', 'open')}
        />
        <Fact
          label={t('Erwarteter Regen', 'Expected rain')}
          value={irr.rainForecastMm === null ? '–' : `${irr.rainForecastMm} mm`}
        />
      </div>
    </section>
  );
}

function Fact(props: { label: string; value: string }): JSX.Element {
  return (
    <div class="lagekarte__fact">
      <span class="lagekarte__fact-label">{props.label}</span>
      <span class="lagekarte__fact-value">{props.value}</span>
    </div>
  );
}

export function GartenView(_props: RoutableProps): JSX.Element {
  return (
    <Fragment>
      <GartenHero />
      <IrrigationTab />
    </Fragment>
  );
}
