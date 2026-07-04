/**
 * Heat Shield — Übersicht standard/expert toggle (uebersicht-rework, Task 14).
 *
 * A small segmented control that flips the persisted {@link expertMode} signal.
 * Standard = calm decision surface; Experte = extra raw values + manual
 * controls, same base hierarchy.
 */

import { h, type JSX } from 'preact';

import { t } from '../../i18n.js';
import { expertMode, setExpertMode } from '../../expertMode.js';

export function ViewModeToggle(): JSX.Element {
  const expert = expertMode.value;
  return (
    <div class="hs-viewmode seg" role="tablist" aria-label={t('Ansichtsmodus', 'View mode')} data-testid="view-mode-toggle">
      <button
        type="button"
        role="tab"
        aria-selected={!expert}
        class={`seg__btn${!expert ? ' seg__btn--active' : ''}`}
        data-testid="view-mode-standard"
        onClick={(): void => setExpertMode(false)}
      >
        {t('Standard', 'Standard')}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={expert}
        class={`seg__btn${expert ? ' seg__btn--active' : ''}`}
        data-testid="view-mode-expert"
        onClick={(): void => setExpertMode(true)}
      >
        {t('Experte', 'Expert')}
      </button>
    </div>
  );
}
