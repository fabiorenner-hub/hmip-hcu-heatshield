/**
 * Master "Automatik aktiv" lever, pinned in the app header.
 *
 * Heat Shield ships with automation OFF (config.automationEnabled =
 * false) so a fresh install never moves a shutter before the user
 * has finished configuring. This lever is the single, always-visible
 * control to arm/disarm the engine. While OFF the engine keeps
 * evaluating (live view, risk, decision records) but holds every
 * position — the dashboard shows MAINTENANCE.
 *
 * The lever reflects the latest snapshot's `automationEnabled` and
 * POSTs `/api/control/automation` on toggle. It optimistically shows
 * the pending state and reverts on error.
 */

import { h, type JSX } from 'preact';
import { useState } from 'preact/hooks';

import { snapshot } from '../store.js';
import { t } from '../i18n.js';

export function AutomationLever(): JSX.Element {
  const snap = snapshot.value;
  const serverValue = snap?.automationEnabled ?? false;
  const [pending, setPending] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  const enabled = pending ?? serverValue;

  const toggle = async (): Promise<void> => {
    const next = !enabled;
    setPending(next);
    setError(null);
    try {
      const res = await fetch('/api/control/automation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Fehler', 'Error'));
      setPending(null);
    }
  };

  // Once the server snapshot catches up to the pending value, clear
  // the optimistic override so the snapshot becomes the source again.
  if (pending !== null && serverValue === pending) {
    // Defer state update out of render.
    queueMicrotask(() => setPending(null));
  }

  return (
    <div
      class={`automation-lever automation-lever--${enabled ? 'on' : 'off'}`}
      data-testid="automation-lever"
      data-enabled={enabled ? 'true' : 'false'}
    >
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        class="automation-lever__btn"
        data-testid="automation-lever-btn"
        onClick={(): void => {
          void toggle();
        }}
      >
        <span class="automation-lever__track">
          <span class="automation-lever__knob" />
        </span>
        <span class="automation-lever__label">
          {enabled
            ? t('Automatik AKTIV', 'Automation ACTIVE')
            : t('Automatik AUS — Konfigurationsmodus', 'Automation OFF — configuration mode')}
        </span>
      </button>
      {error !== null && (
        <span class="automation-lever__error" data-testid="automation-lever-error">
          {error}
        </span>
      )}
    </div>
  );
}
