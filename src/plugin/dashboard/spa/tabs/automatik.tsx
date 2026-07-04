/**
 * Heat Shield — "Automatik" primary view (Blueprint Phase 8).
 *
 * Four sub-tabs composed from existing, tested building blocks — no logic
 * duplicated, nothing lost:
 *   - Status        → AutomationStatusCard (next action, blockers, mode runtime)
 *   - Strategie     → RulesTab (editable profiles + live impact preview)
 *   - Simulation    → a no-actuator dry run (`POST /api/probe/run`) with a clear
 *                     simulation banner (steering: never issues setShutterLevel)
 *   - Entscheidung  → AutomationTechnical (decision cascade / decision story)
 */

import { h, Fragment, type JSX } from 'preact';
import { useState } from 'preact/hooks';

import { RulesTab } from './rules.js';
import { AutomationTechnical } from '../components/dashboard/automationTechnical.js';
import { AutomationStatusCard } from '../components/dashboard/analysisRail.js';
import { snapshot } from '../store.js';
import { useConfig } from '../hooks/useConfig.js';
import { t } from '../i18n.js';

interface RoutableProps {
  path?: string;
  default?: boolean;
}

type Sub = 'status' | 'strategie' | 'simulation' | 'entscheidung';

interface ProbeResult {
  mode: string;
  windowDecisions: Array<{ windowId: string; finalTarget: number }>;
}

function SimulationPanel(): JSX.Element {
  const [result, setResult] = useState<ProbeResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/probe/run', { method: 'POST' });
      if (!res.ok) {
        setError(`HTTP ${res.status}`);
        setResult(null);
        return;
      }
      setResult((await res.json()) as ProbeResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <section class="module-panel__card" data-testid="automatik-simulation">
      <div class="sim-banner" data-testid="sim-banner">
        {t(
          'Simulation — rechnet einen synthetischen Zyklus, ohne einen Rollladen zu fahren.',
          'Simulation — computes a synthetic cycle without moving any shutter.',
        )}
      </div>
      <button type="button" class="btn" data-testid="sim-run" disabled={loading} onClick={(): void => void run()}>
        {loading ? t('Rechne …', 'Computing …') : t('Probelauf jetzt', 'Dry run now')}
      </button>
      {error !== null && <p class="tab-rules__error" role="alert">{error}</p>}
      {result !== null && (
        <div data-testid="sim-result">
          <p>
            {t('Ergebnis-Modus:', 'Result mode:')} <strong>{result.mode}</strong>
          </p>
          <ul>
            {result.windowDecisions.map((w) => (
              <li key={w.windowId}>
                …{w.windowId.slice(-4)}: {t('Ziel', 'target')} {(w.finalTarget * 100).toFixed(0)} %
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export function AutomatikView(_props: RoutableProps): JSX.Element {
  const [sub, setSub] = useState<Sub>('status');
  const snap = snapshot.value;
  const config = useConfig().config.value;

  const tabs: Array<{ id: Sub; label: string }> = [
    { id: 'status', label: t('Status', 'Status') },
    { id: 'strategie', label: t('Strategie', 'Strategy') },
    { id: 'simulation', label: t('Simulation', 'Simulation') },
    { id: 'entscheidung', label: t('Entscheidung', 'Decision') },
  ];

  return (
    <section class="module-panel" data-testid="module-automatik">
      <header class="module-panel__head">
        <h1>{t('Automatik', 'Automation')}</h1>
      </header>

      <div class="seg" role="tablist" aria-label={t('Automatik-Bereiche', 'Automation sections')} data-testid="automatik-subnav">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={sub === tab.id}
            class={`seg__btn${sub === tab.id ? ' seg__btn--active' : ''}`}
            data-testid={`automatik-sub-${tab.id}`}
            onClick={(): void => setSub(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div class="automatik-sub" data-sub={sub}>
        {sub === 'status' && (
          snap !== null ? <AutomationStatusCard snapshot={snap} /> : <p class="module-panel__hint">{t('warte auf Daten', 'waiting for data')}</p>
        )}
        {sub === 'strategie' && <RulesTab />}
        {sub === 'simulation' && <SimulationPanel />}
        {sub === 'entscheidung' && (
          snap !== null && config !== null ? (
            <AutomationTechnical snapshot={snap} config={config} />
          ) : (
            <p class="module-panel__hint">{t('warte auf Daten', 'waiting for data')}</p>
          )
        )}
      </div>
    </section>
  );
}
