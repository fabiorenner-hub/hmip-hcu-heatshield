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
    line =
      'Das Plugin hat keine Connect-API-Verbindung zur HCU (kein /TOKEN gefunden). Discovery liefert nur den Cache und der ist leer.';
  } else if (connect === 'connecting') {
    level = 'warn';
    line =
      'Connect-API-Socket ist noch nicht offen. Bitte gleich nochmal versuchen — die HCU baut die Verbindung gerade auf.';
  } else if (lastError !== null) {
    level = 'error';
    line = `Connect-API ist verbunden, aber getSystemState ist fehlgeschlagen: ${lastError}`;
  } else if (!attempted) {
    level = 'warn';
    line =
      'Discovery hat den letzten Cache-Stand zurückgegeben (kein frischer getSystemState ausgelöst).';
  } else if (total === 0) {
    level = 'warn';
    line =
      'getSystemState war erfolgreich, aber die HCU hat keine Geräte gemeldet. Das ist ungewöhnlich — vermutlich ein Schema-Mismatch in der Response.';
  } else {
    level = 'ok';
    line = `Discovery ok: ${total} Geräte gefunden, davon ${discovery.climateSensors.value.length} Klima-Sensoren und ${discovery.openMeteo.value.length} OpenMeteo-Kandidaten.`;
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
        <strong>Status:</strong> {line}
      </div>
      {discovery.pluginBuild.value !== null && (
        <div
          class="discovery-status__line discovery-status__build"
          data-testid="discovery-build"
        >
          <strong>Plugin-Build:</strong> {discovery.pluginBuild.value}
        </div>
      )}
      {rawCount !== null && (
        <div
          class={`discovery-status__line discovery-status__raw discovery-status__raw--${
            parserDrops ? 'drop' : 'ok'
          }`}
          data-testid="discovery-raw-summary"
        >
          <strong>Roh ↔ geparst:</strong>{' '}
          {parserDrops
            ? `Die HCU sendet ${rawCount} Geräte, aber nur ${parsedCount} überleben den Parser. ${
                rawCount - parsedCount
              } Geräte werden verworfen — vermutlich ein Schema-Mismatch, KEIN fehlender Zugriff.`
            : `${rawCount} Geräte gesendet, ${parsedCount} geparst (kein Parser-Verlust). Fehlende native Geräte sind also wirklich nicht in der getSystemState-Antwort.`}
          {rawHistogram.length > 0 && (
            <span>
              {' '}
              Roh-Typen:{' '}
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
        <strong>Steuerbare Rollläden:</strong>{' '}
        {shutterSources.length > 0
          ? `${shutterSources.length} gefunden (Geräte mit shutterLevel-Feature).`
          : 'keine gefunden. Das Plugin sieht in der HMIP-Systemansicht kein Gerät mit shutterLevel-Feature — ohne ein solches kann es keine Rollläden steuern.'}
      </div>
      {shutterSources.length > 0 && (
        <details class="discovery-status__details">
          <summary>Rollladen-Geräte ({shutterSources.length})</summary>
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
            DeviceType-Histogramm ({histogram.length}{' '}
            {histogram.length === 1 ? 'Typ' : 'Typen'})
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
            Temperatur-fähige Geräte ({tempSources.length})
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
          <summary>Alle Geräte + Features ({inventory.length})</summary>
          <ul class="discovery-status__inventory">
            {inventory.map((d) => (
              <li key={d.deviceId}>
                <div>
                  <strong>{d.friendlyName ?? '(ohne Name)'}</strong>{' '}
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
                    <em>keine Features</em>
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
