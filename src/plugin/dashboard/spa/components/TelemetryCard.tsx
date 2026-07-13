/**
 * Heat Shield SPA — privacy / usage-statistics (call-home) opt-out card.
 *
 * Discloses the anonymous install ping and lets the user turn it off
 * (`config.telemetry.enabled`). Rendered in the Diagnose tab (v1 + lg2). Uses
 * token-driven `ota-*` / `tab-rules__check` classes so it fits both UIs.
 */

import { h, type JSX } from 'preact';

import { useConfig } from '../hooks/useConfig.js';
import { t } from '../i18n.js';

const PRIVACY_URL = 'https://hcu.fabiorenner.de/privacy.php';

export function TelemetryCard(): JSX.Element | null {
  const { config, scheduleSave } = useConfig();
  const cfg = config.value;
  if (cfg === null) return null;
  const enabled = cfg.telemetry?.enabled ?? true;
  const toggle = (on: boolean): void => {
    scheduleSave({ ...cfg, telemetry: { ...cfg.telemetry, enabled: on } });
  };

  return (
    <section class="module-panel__card ota-card" data-testid="telemetry-card">
      <h3>{t('Datenschutz & Nutzungsstatistik', 'Privacy & usage statistics')}</h3>
      <label class="tab-rules__check">
        <input
          type="checkbox"
          data-testid="telemetry-toggle"
          checked={enabled}
          onChange={(e): void => toggle((e.currentTarget as HTMLInputElement).checked)}
        />
        <span>
          {t(
            'Anonyme Nutzungsstatistik senden (hilft, die Weiterentwicklung zu priorisieren).',
            'Send anonymous usage statistics (helps prioritise development).',
          )}
        </span>
      </label>
      <p class="ota-note">
        {t(
          'Einmal pro Plugin-Start wird ein Ping gesendet: eine pseudonyme Installations-ID (nicht rückrechenbarer Hash der HCU-Kennung), die Version(en), Architektur und Sprache. KEINE personenbezogenen Daten, kein Standort, keine Geräte- oder Raumdaten, kein Token. Nur über HTTPS. Jederzeit hier abschaltbar.',
          'Once per plugin start a ping is sent: a pseudonymous installation id (non-reversible hash of the HCU identifier), the version(s), architecture and language. NO personal data, no location, no device or room data, no token. HTTPS only. Can be turned off here anytime.',
        )}
      </p>
      <a class="ota-linkbtn" href={PRIVACY_URL} target="_blank" rel="noopener noreferrer">
        {t('Datenschutz-Hinweis', 'Privacy notice')}
      </a>
    </section>
  );
}
