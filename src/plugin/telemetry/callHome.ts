/**
 * Heat Shield — anonymous call-home (install analytics).
 *
 * Sends ONE best-effort ping shortly after startup so the maintainer can see
 * how many installations run which version. Privacy-preserving by design:
 *   - the only identifier is `installId` = salted SHA-256 of the HCU SGTIN
 *     (stable + unique PER INSTALLATION, but NOT reversible to the serial),
 *   - no auth token, no location, no room/device data is ever sent,
 *   - HTTPS only, fixed endpoint, ≤ 5 s timeout, failures are swallowed,
 *   - disabled entirely when `config.telemetry.enabled` is false (opt-out).
 *
 * Pure payload construction is separated from the network send so it is unit-
 * testable without a socket.
 */

import { createHash } from 'node:crypto';

/** Fixed call-home endpoint (maintainer's server). Not user-configurable. */
export const TELEMETRY_ENDPOINT = 'https://hcu.fabiorenner.de/ingest.php';

/** Salt so the install id cannot be reversed to the raw SGTIN by rainbow table. */
const INSTALL_ID_SALT = 'heatshield-telemetry-v1';

export interface CallHomePayload {
  readonly schema: 1;
  readonly event: 'start';
  readonly installId: string;
  readonly pluginId: string;
  readonly coreVersion: string;
  readonly otaVersion: string;
  readonly buildId: string | null;
  readonly arch: string;
  readonly lang: string;
  readonly ts: string;
}

/** Stable, non-reversible install id from the HCU SGTIN. */
export function installIdFor(sgtin: string): string {
  return createHash('sha256').update(`${INSTALL_ID_SALT}|${sgtin.trim()}`).digest('hex');
}

export interface CallHomeInputs {
  readonly sgtin: string | null;
  readonly pluginId: string;
  readonly coreVersion: string;
  readonly otaVersion: string;
  readonly buildId: string | null;
  readonly arch: string;
  readonly lang: string;
  readonly now: Date;
}

/**
 * Build the ping payload. Returns null when no stable SGTIN is available
 * (remote-dev / smoke) so the caller skips the ping entirely.
 */
export function buildCallHomePayload(i: CallHomeInputs): CallHomePayload | null {
  if (i.sgtin === null || i.sgtin.trim().length === 0) return null;
  return {
    schema: 1,
    event: 'start',
    installId: installIdFor(i.sgtin),
    pluginId: i.pluginId,
    coreVersion: i.coreVersion,
    otaVersion: i.otaVersion,
    buildId: i.buildId,
    arch: i.arch,
    lang: i.lang,
    ts: i.now.toISOString(),
  };
}

export interface SendCallHomeDeps {
  readonly fetchImpl?: (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
  ) => Promise<{ ok: boolean; status: number }>;
  readonly timeoutMs?: number;
  readonly logger?: (level: 'info' | 'warn', msg: string, ctx?: Record<string, unknown>) => void;
}

/**
 * POST the payload to {@link TELEMETRY_ENDPOINT}. Best-effort: never throws,
 * never logs secrets (the payload carries none). Returns true on a 2xx.
 */
export async function sendCallHome(payload: CallHomePayload, deps: SendCallHomeDeps = {}): Promise<boolean> {
  const timeoutMs = deps.timeoutMs ?? 5000;
  const fetchImpl =
    deps.fetchImpl ??
    ((globalThis as { fetch: SendCallHomeDeps['fetchImpl'] }).fetch as NonNullable<SendCallHomeDeps['fetchImpl']>);
  if (typeof fetchImpl !== 'function') return false;
  try {
    const res = await fetchImpl(TELEMETRY_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'heatshield-callhome' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      deps.logger?.('info', 'call-home non-2xx', { status: res.status });
      return false;
    }
    deps.logger?.('info', 'call-home ok', { coreVersion: payload.coreVersion, otaVersion: payload.otaVersion });
    return true;
  } catch (err) {
    // Offline / DNS / timeout — telemetry is best-effort, swallow.
    deps.logger?.('info', 'call-home skipped', { error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}
