/**
 * Inline status banner that turns the Connect-API state diagnostics
 * returned by `POST /api/sources/discover` into a user-readable
 * one-liner. Rendered above any "Discover" button so the user can
 * tell the difference between
 *
 *   - "the HCU has no devices that match" (devices.length === 0 but
 *     connectState === 'connected' and lastError === null)
 *   - "we never reached the HCU" (connectState !== 'connected'
 *     and/or lastError is set).
 *
 * The banner stays quiet (renders nothing) until the user has run
 * discovery at least once. This keeps the wizard screen tidy on
 * first entry where there is nothing yet to report.
 */

import { h, type JSX } from 'preact';

import { t } from '../i18n.js';
import type { UseDiscoveryResult } from '../hooks/useDiscovery.js';

interface Props {
  discovery: UseDiscoveryResult;
}

export function DiscoveryStatus({ discovery }: Props): JSX.Element | null {
  const ranAtLeastOnce = discovery.lastDiscoveryAt.value !== null;
  if (!ranAtLeastOnce) return null;

  const connect = discovery.connectState.value;
  const lastError = discovery.lastError.value;
  const total = discovery.devices.value.length;
  const attempted = discovery.attemptedRefresh.value;

  let level: 'ok' | 'warn' | 'error' = 'ok';
  let line: string;

  if (connect === null) {
    // Server did not send the diagnostic fields; nothing actionable.
    return null;
  }

  if (connect === 'off') {
    level = 'error';
    line = t(
      'Das Plugin hat keine Connect-API-Verbindung zur HCU (kein /TOKEN gefunden). Discovery liefert nur den Cache und der ist leer.',
      'The plugin has no Connect-API connection to the HCU (no /TOKEN found). Discovery only returns the cache, which is empty.',
    );
  } else if (connect === 'connecting') {
    level = 'warn';
    line = t(
      'Connect-API-Socket ist noch nicht offen. Bitte gleich nochmal versuchen — die HCU baut die Verbindung gerade auf.',
      'The Connect-API socket is not open yet. Please try again shortly — the HCU is currently establishing the connection.',
    );
  } else if (lastError !== null) {
    level = 'error';
    line = t(
      `Connect-API ist verbunden, aber getSystemState ist fehlgeschlagen: ${lastError}`,
      `Connect-API is connected, but getSystemState failed: ${lastError}`,
    );
  } else if (!attempted) {
    level = 'warn';
    line = t(
      'Discovery hat den letzten Cache-Stand zurückgegeben (kein frischer getSystemState ausgelöst).',
      'Discovery returned the last cached state (no fresh getSystemState was triggered).',
    );
  } else if (total === 0) {
    level = 'warn';
    line = t(
      'getSystemState war erfolgreich, aber die HCU hat keine Geräte gemeldet. Das ist ungewöhnlich — vermutlich ein Schema-Mismatch in der Response.',
      'getSystemState succeeded, but the HCU reported no devices. That is unusual — probably a schema mismatch in the response.',
    );
  } else {
    level = 'ok';
    line = t(
      `Discovery ok: ${total} Geräte gefunden, davon ${discovery.climateSensors.value.length} Klima-Sensoren und ${discovery.openMeteo.value.length} OpenMeteo-Kandidaten.`,
      `Discovery ok: ${total} devices found, of which ${discovery.climateSensors.value.length} climate sensors and ${discovery.openMeteo.value.length} OpenMeteo candidates.`,
    );
  }

  const histogram = discovery.histogram.value;
  const tempSources = discovery.temperatureSources.value;
  const shutterSources = discovery.shutterSources.value;
  const inventory = discovery.inventory.value;
  const rawCount = discovery.rawDeviceCount.value;
  const rawHistogram = discovery.rawHistogram.value;
  const parsedCount = inventory.length;
  const parserDrops = rawCount !== null && rawCount > parsedCount;

  return (
    <div
      class={`discovery-status discovery-status--${level}`}
      data-testid="discovery-status"
      role="status"
    >
      <div class="discovery-status__line">
        <strong>{t('Status:', 'Status:')}</strong> {line}
      </div>
      {discovery.pluginBuild.value !== null && (
        <div
          class="discovery-status__line discovery-status__build"
          data-testid="discovery-build"
        >
          <strong>{t('Plugin-Build:', 'Plugin build:')}</strong> {discovery.pluginBuild.value}
        </div>
      )}
      {rawCount !== null && (
        <div
          class={`discovery-status__line discovery-status__raw discovery-status__raw--${
            parserDrops ? 'drop' : 'ok'
          }`}
          data-testid="discovery-raw-summary"
        >
          <strong>{t('Roh ↔ geparst:', 'Raw ↔ parsed:')}</strong>{' '}
          {parserDrops
            ? t(
                `Die HCU sendet ${rawCount} Geräte, aber nur ${parsedCount} überleben den Parser. ${
                  rawCount - parsedCount
                } Geräte werden verworfen — vermutlich ein Schema-Mismatch, KEIN fehlender Zugriff.`,
                `The HCU sends ${rawCount} devices, but only ${parsedCount} survive the parser. ${
                  rawCount - parsedCount
                } devices are dropped — probably a schema mismatch, NOT missing access.`,
              )
            : t(
                `${rawCount} Geräte gesendet, ${parsedCount} geparst (kein Parser-Verlust). Fehlende native Geräte sind also wirklich nicht in der getSystemState-Antwort.`,
                `${rawCount} devices sent, ${parsedCount} parsed (no parser loss). Missing native devices are therefore genuinely absent from the getSystemState response.`,
              )}
          {rawHistogram.length > 0 && (
            <span>
              {' '}
              {t('Roh-Typen:', 'Raw types:')}{' '}
              {rawHistogram
                .map((entry) => `${entry.deviceType}×${entry.count}`)
                .join(', ')}
              .
            </span>
          )}
        </div>
      )}
      <div
        class={`discovery-status__line discovery-status__shutters discovery-status__shutters--${
          shutterSources.length > 0 ? 'ok' : 'none'
        }`}
        data-testid="discovery-shutter-summary"
      >
        <strong>{t('Steuerbare Rollläden:', 'Controllable shutters:')}</strong>{' '}
        {shutterSources.length > 0
          ? t(
              `${shutterSources.length} gefunden (Geräte mit shutterLevel-Feature).`,
              `${shutterSources.length} found (devices with a shutterLevel feature).`,
            )
          : t(
              'keine gefunden. Das Plugin sieht in der HMIP-Systemansicht kein Gerät mit shutterLevel-Feature — ohne ein solches kann es keine Rollläden steuern.',
              'none found. The plugin sees no device with a shutterLevel feature in the HMIP system view — without one it cannot control any shutters.',
            )}
      </div>
      {shutterSources.length > 0 && (
        <details class="discovery-status__details">
          <summary>{t('Rollladen-Geräte', 'Shutter devices')} ({shutterSources.length})</summary>
          <ul class="discovery-status__hist">
            {shutterSources.map((d) => (
              <li key={d.deviceId}>
                <code>{d.deviceId}</code>{' '}
                {d.deviceType !== undefined && (
                  <span class="discovery-status__type">[{d.deviceType}]</span>
                )}{' '}
                {d.friendlyName !== undefined && (
                  <span class="discovery-status__name">— {d.friendlyName}</span>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
      {histogram.length > 0 && (
        <details class="discovery-status__details">
          <summary>
            {t('DeviceType-Histogramm', 'DeviceType histogram')} ({histogram.length}{' '}
            {histogram.length === 1 ? t('Typ', 'type') : t('Typen', 'types')})
          </summary>
          <ul class="discovery-status__hist">
            {histogram.map((entry) => (
              <li key={entry.deviceType}>
                <code>{entry.deviceType}</code>: <strong>{entry.count}</strong>
              </li>
            ))}
          </ul>
        </details>
      )}
      {tempSources.length > 0 && (
        <details class="discovery-status__details">
          <summary>
            {t('Temperatur-fähige Geräte', 'Temperature-capable devices')} ({tempSources.length})
          </summary>
          <ul class="discovery-status__hist">
            {tempSources.map((d) => (
              <li key={d.deviceId}>
                <code>{d.deviceId}</code>{' '}
                {d.deviceType !== undefined && (
                  <span class="discovery-status__type">[{d.deviceType}]</span>
                )}{' '}
                {d.friendlyName !== undefined && (
                  <span class="discovery-status__name">
                    — {d.friendlyName}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
      {inventory.length > 0 && (
        <details class="discovery-status__details">
          <summary>{t('Alle Geräte + Features', 'All devices + features')} ({inventory.length})</summary>
          <ul class="discovery-status__inventory">
            {inventory.map((d) => (
              <li key={d.deviceId}>
                <div>
                  <strong>{d.friendlyName ?? t('(ohne Name)', '(no name)')}</strong>{' '}
                  {d.deviceType !== undefined && (
                    <span class="discovery-status__type">
                      [{d.deviceType}]
                    </span>
                  )}
                </div>
                <div>
                  <code class="discovery-status__devid">{d.deviceId}</code>
                </div>
                <div class="discovery-status__features">
                  {d.features.length > 0 ? (
                    d.features.map((f) => {
                      const v = d.values?.[f];
                      return (
                        <span key={f} class="discovery-status__feature">
                          {f}
                          {v !== undefined && (
                            <span class="discovery-status__fval">
                              ={typeof v === 'number' ? Math.round(v * 1000) / 1000 : String(v)}
                            </span>
                          )}
                        </span>
                      );
                    })
                  ) : (
                    <em>{t('keine Features', 'no features')}</em>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
