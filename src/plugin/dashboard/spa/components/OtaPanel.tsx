/**
 * Heat Shield SPA — OTA update panel (shared by the v1 + lg2 Updates tabs).
 *
 * Shows BOTH versions (Core/Image and OTA/Payload) + the latest available
 * version, an Auto/Manual switch (installation-wide `config.updates.mode`), a
 * "check now" button, and — depending on state — either a "Jetzt aktualisieren"
 * button (manual + OTA available) or a regular-update banner (the new version
 * needs a newer core → .tar.gz via HCUweb). Uses token-driven `ota-*` classes
 * styled in styles.css so it renders in both v1 and v2.
 */

import { h, Fragment, type JSX } from 'preact';

import { useOtaStatus } from '../hooks/useOtaStatus.js';
import { useConfig } from '../hooks/useConfig.js';
import { GITHUB_RELEASES_URL } from '../hooks/useUpdateCheck.js';
import { t } from '../i18n.js';

export function OtaPanel(): JSX.Element | null {
  const ota = useOtaStatus();
  const { config, scheduleSave } = useConfig();
  const s = ota.status;

  // OTA not wired (503) → render nothing (dev/test/older core).
  if (s === null) return null;

  const setMode = (mode: 'manual' | 'auto'): void => {
    const cfg = config.value;
    if (cfg === null) return;
    scheduleSave({ ...cfg, updates: { ...cfg.updates, mode } });
  };

  const setChannel = (channel: 'stable' | 'experimental'): void => {
    const cfg = config.value;
    if (cfg === null) return;
    scheduleSave({ ...cfg, updates: { ...cfg.updates, channel } });
  };

  const mode = config.value?.updates?.mode ?? s.mode;
  const channel = config.value?.updates?.channel ?? s.channel ?? 'stable';

  return (
    <article class="module-panel__card ota-card" data-testid="ota-panel">
      <h3>{t('Automatische Updates (OTA)', 'Over-the-air updates (OTA)')}</h3>

      <div class="ota-versions">
        <div class="ota-ver" data-testid="ota-core">
          <span class="ota-ver__label">{t('Kern (Image)', 'Core (image)')}</span>
          <span class="ota-ver__value">v{s.coreVersion}</span>
        </div>
        <div class="ota-ver" data-testid="ota-payload">
          <span class="ota-ver__label">{t('OTA (Payload)', 'OTA (payload)')}</span>
          <span class="ota-ver__value">
            v{s.otaVersion}
            {s.otaActive ? <span class="ota-ver__tag">OTA</span> : null}
          </span>
        </div>
        <div class="ota-ver" data-testid="ota-latest">
          <span class="ota-ver__label">{t('Neueste', 'Latest')}</span>
          <span class="ota-ver__value">{s.latest !== null ? `v${s.latest}` : '—'}</span>
        </div>
      </div>

      <div class="ota-mode" role="group" aria-label={t('Update-Modus', 'Update mode')}>
        <span class="ota-mode__label">{t('Modus', 'Mode')}</span>
        <div class="ota-seg">
          <button type="button" class={`ota-seg__btn${mode === 'manual' ? ' ota-seg__btn--on' : ''}`}
            data-testid="ota-mode-manual" aria-pressed={mode === 'manual'}
            onClick={(): void => setMode('manual')}>{t('Manuell', 'Manual')}</button>
          <button type="button" class={`ota-seg__btn${mode === 'auto' ? ' ota-seg__btn--on' : ''}`}
            data-testid="ota-mode-auto" aria-pressed={mode === 'auto'}
            onClick={(): void => setMode('auto')}>{t('Automatisch', 'Automatic')}</button>
        </div>
      </div>

      <div class="ota-mode" role="group" aria-label={t('Update-Kanal', 'Update channel')}>
        <span class="ota-mode__label">{t('Kanal', 'Channel')}</span>
        <div class="ota-seg">
          <button type="button" class={`ota-seg__btn${channel === 'stable' ? ' ota-seg__btn--on' : ''}`}
            data-testid="ota-channel-stable" aria-pressed={channel === 'stable'}
            onClick={(): void => setChannel('stable')}>{t('Stabil', 'Stable')}</button>
          <button type="button" class={`ota-seg__btn${channel === 'experimental' ? ' ota-seg__btn--on' : ''}`}
            data-testid="ota-channel-experimental" aria-pressed={channel === 'experimental'}
            onClick={(): void => setChannel('experimental')}>{t('Experimentell', 'Experimental')}</button>
        </div>
      </div>
      {channel === 'experimental' && (
        <p class="ota-note" data-testid="ota-channel-note">
          {t(
            'Experimenteller Kanal: dieses Gerät erhält Test-Builds (GitHub-Vorabversionen) mit gleicher Versionsnummer + Build-Kennung, ohne Changelog. Andere Nutzer im Kanal „Stabil" bekommen sie nicht.',
            'Experimental channel: this device receives test builds (GitHub prereleases) with the same version number + build tag, without a changelog. Users on the "Stable" channel do not get them.',
          )}
          {s.experimentalBuild ? ` ${t('Aktuell läuft ein Testbuild.', 'A test build is currently running.')}` : ''}
        </p>
      )}

      {s.requiresCore ? (
        <div class="ota-banner ota-banner--core" data-testid="ota-requires-core">
          <p>
            {t(
              `Die neueste Version (v${s.latest ?? ''}) benötigt ein Kern-Update. Bitte das .tar.gz aus den Releases über HCUweb installieren.`,
              `The latest version (v${s.latest ?? ''}) needs a core update. Please install the .tar.gz from the releases via HCUweb.`,
            )}
          </p>
          <a class="irr-btn" href={GITHUB_RELEASES_URL} target="_blank" rel="noopener noreferrer">
            {t('Releases öffnen', 'Open releases')}
          </a>
        </div>
      ) : s.updateAvailable ? (
        <div class="ota-banner ota-banner--available" data-testid="ota-available">
          <p>{t(`OTA-Update verfügbar: v${s.latest ?? ''}.`, `OTA update available: v${s.latest ?? ''}.`)}</p>
          {mode === 'manual' ? (
            <button type="button" class="irr-btn" data-testid="ota-install" disabled={ota.phase !== 'idle'}
              onClick={(): void => { ota.installTracked(); }}>
              {ota.phase !== 'idle' ? t('Update läuft…', 'Updating…') : t('Jetzt aktualisieren', 'Update now')}
            </button>
          ) : (
            <p class="ota-note">{t('Wird automatisch installiert.', 'Will be installed automatically.')}</p>
          )}
        </div>
      ) : (
        <p class="ota-note" data-testid="ota-current">
          {mode === 'auto'
            ? t(`Prüft automatisch alle ${s.checkIntervalHours} h.`, `Checks automatically every ${s.checkIntervalHours} h.`)
            : t('Kein OTA-Update verfügbar.', 'No OTA update available.')}
        </p>
      )}

      {ota.phase !== 'idle' && (
        <div class={`ota-progress ota-progress--${ota.phase}`} data-testid="ota-progress" role="status" aria-live="polite">
          <div class="ota-progress__steps">
            {([
              ['installing', t('Installieren', 'Installing')],
              ['restarting', t('Neustart', 'Restarting')],
              ['done', t('Fertig', 'Done')],
            ] as const).map(([key, label], i) => {
              const order: Record<string, number> = { installing: 0, restarting: 1, done: 2, error: 1 };
              const cur = order[ota.phase] ?? 0;
              const state = ota.phase === 'error' && i >= cur ? 'err' : i < cur ? 'past' : i === cur ? 'now' : 'todo';
              return (
                <span key={key} class={`ota-progress__step ota-progress__step--${state}`} data-testid={`ota-step-${key}`}>
                  {label}
                </span>
              );
            })}
          </div>
          {(ota.phase === 'installing' || ota.phase === 'restarting') && (
            <div class="ota-progress__bar" aria-hidden="true"><span /></div>
          )}
          <ul class="ota-progress__log" data-testid="ota-progress-log">
            {ota.progressLog.map((line, i) => (<li key={i}>{line}</li>))}
          </ul>
          {ota.phase === 'error' && (
            <button type="button" class="ota-linkbtn" data-testid="ota-progress-reload"
              onClick={(): void => { try { globalThis.location?.reload(); } catch { /* ignore */ } }}>
              {t('Seite neu laden', 'Reload page')}
            </button>
          )}
        </div>
      )}

      <div class="ota-actions">
        <button type="button" class="ota-linkbtn" data-testid="ota-check" disabled={ota.busy || ota.phase === 'installing' || ota.phase === 'restarting'}
          onClick={(): void => { void ota.check(); }}>
          {ota.busy ? t('Prüfe…', 'Checking…') : t('Jetzt prüfen', 'Check now')}
        </button>
        {ota.error !== null && <span class="ota-err">{ota.error}</span>}
      </div>
    </article>
  );
}
