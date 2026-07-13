/**
 * Heat Shield — OTA manager (runtime orchestrator).
 *
 * Ties the pure OTA modules to the running server: exposes status for the
 * Updates tab, performs manual/auto checks against GitHub Releases, installs a
 * verified, core-compatible payload and requests a restart so the bootstrap
 * loader picks it up. Best-effort throughout: offline/rate-limit never blocks.
 *
 * Never logs secrets. The update source is the fixed repo in `github.ts`.
 */

import { fetchLatestRelease, findOtaAssets, type FetchLike } from './github.js';
import { parseManifestJson, type OtaManifest } from './manifest.js';
import { installBundle, type InstallResult } from './installer.js';
import { readOtaState } from './state.js';
import { isNewer, isAtLeast } from './semver.js';

export type UpdateMode = 'manual' | 'auto';

export type LastResult =
  | 'installed'
  | 'already-current'
  | 'refused-core'
  | 'verify-failed'
  | 'offline'
  | 'quarantined'
  | null;

export interface OtaStatus {
  coreVersion: string;
  otaVersion: string;
  otaActive: boolean;
  latest: string | null;
  updateAvailable: boolean;
  requiresCore: boolean;
  mode: UpdateMode;
  checkIntervalHours: number;
  lastCheck: string | null;
  lastResult: LastResult;
}

export interface OtaManagerDeps {
  readonly dataDir: string;
  readonly coreVersion: string;
  readonly getMode: () => UpdateMode;
  readonly getIntervalHours: () => number;
  readonly requestRestart: () => void;
  readonly fetchImpl?: FetchLike;
  readonly publicKeyPem?: string | undefined;
  readonly now?: () => Date;
  readonly logger?: (level: 'info' | 'warn', msg: string, ctx?: Record<string, unknown>) => void;
}

interface CheckOutcome {
  latest: string | null;
  manifest: OtaManifest | null;
  updateAvailable: boolean;
  requiresCore: boolean;
  result: LastResult;
}

function defaultFetch(): FetchLike {
  const g = globalThis as { fetch: (i: string, o?: unknown) => Promise<unknown> };
  return ((input: string, init?: unknown) => g.fetch(input, init)) as unknown as FetchLike;
}

export class OtaManager {
  private readonly deps: OtaManagerDeps;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;
  private lastCheck: string | null = null;
  private lastResult: LastResult = null;
  private cachedLatest: string | null = null;
  private cachedRequiresCore = false;
  private cachedUpdateAvailable = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  public constructor(deps: OtaManagerDeps) {
    this.deps = deps;
    this.fetchImpl = deps.fetchImpl ?? defaultFetch();
    this.now = deps.now ?? ((): Date => new Date());
  }

  /** Current running payload version (loader-provided env), else core. */
  private otaVersion(): string {
    return process.env['HEATSHIELD_OTA_VERSION'] ?? this.deps.coreVersion;
  }

  private otaActive(): boolean {
    return process.env['HEATSHIELD_OTA_ACTIVE'] === '1';
  }

  public getStatus(): OtaStatus {
    return {
      coreVersion: this.deps.coreVersion,
      otaVersion: this.otaVersion(),
      otaActive: this.otaActive(),
      latest: this.cachedLatest,
      updateAvailable: this.cachedUpdateAvailable,
      requiresCore: this.cachedRequiresCore,
      mode: this.deps.getMode(),
      checkIntervalHours: this.deps.getIntervalHours(),
      lastCheck: this.lastCheck,
      lastResult: this.lastResult,
    };
  }

  /**
   * Resolve the latest release + manifest and classify it against the running
   * payload and the core version. Pure w.r.t. side effects except caching.
   */
  public async check(): Promise<CheckOutcome> {
    this.lastCheck = this.now().toISOString();
    const rel = await fetchLatestRelease(this.fetchImpl);
    if (rel === null) {
      this.lastResult = 'offline';
      return { latest: this.cachedLatest, manifest: null, updateAvailable: false, requiresCore: false, result: 'offline' };
    }
    const assets = findOtaAssets(rel);
    if (assets.manifest === null || assets.bundle === null) {
      // Release exists but carries no OTA payload (core-only release).
      this.cachedLatest = rel.tagName.replace(/^v/iu, '');
      this.cachedUpdateAvailable = false;
      this.cachedRequiresCore = false;
      return { latest: this.cachedLatest, manifest: null, updateAvailable: false, requiresCore: false, result: null };
    }
    let manifest: OtaManifest | null = null;
    try {
      const res = await this.fetchImpl(assets.manifest.url, { headers: { 'User-Agent': 'heatshield-ota' } });
      if (res.ok) manifest = parseManifestJson(await res.text());
    } catch {
      manifest = null;
    }
    if (manifest === null) {
      this.lastResult = 'offline';
      return { latest: this.cachedLatest, manifest: null, updateAvailable: false, requiresCore: false, result: 'offline' };
    }

    const state = await readOtaState(this.deps.dataDir);
    const quarantined = state.quarantined.includes(manifest.version);
    const requiresCore = !isAtLeast(this.deps.coreVersion, manifest.minCoreVersion);
    const newer = isNewer(manifest.version, this.otaVersion());
    const updateAvailable = newer && !requiresCore && !quarantined;

    this.cachedLatest = manifest.version.replace(/^v/iu, '');
    this.cachedRequiresCore = newer && requiresCore;
    this.cachedUpdateAvailable = updateAvailable;

    let result: LastResult = null;
    if (!newer) result = 'already-current';
    else if (requiresCore) result = 'refused-core';
    else if (quarantined) result = 'quarantined';
    this.lastResult = result;

    return { latest: this.cachedLatest, manifest, updateAvailable, requiresCore: this.cachedRequiresCore, result };
  }

  /** Manual/auto install path: check, then install if eligible, then restart. */
  public async install(): Promise<{ status: OtaStatus; result: InstallResult | { ok: false; reason: LastResult; detail: string } }> {
    const outcome = await this.check();
    if (outcome.manifest === null || !outcome.updateAvailable) {
      const reason: LastResult = outcome.result ?? 'already-current';
      return { status: this.getStatus(), result: { ok: false, reason, detail: `not eligible: ${reason}` } };
    }
    const rel = await fetchLatestRelease(this.fetchImpl);
    const assets = rel !== null ? findOtaAssets(rel) : { manifest: null, bundle: null, sha256: null };
    if (assets.bundle === null) {
      this.lastResult = 'offline';
      return { status: this.getStatus(), result: { ok: false, reason: 'offline', detail: 'bundle asset missing' } };
    }
    const res = await installBundle(
      {
        dataDir: this.deps.dataDir,
        fetchImpl: this.fetchImpl,
        ...(this.deps.publicKeyPem !== undefined ? { publicKeyPem: this.deps.publicKeyPem } : {}),
        logger: (lvl, msg) => this.deps.logger?.(lvl, msg),
      },
      { manifest: outcome.manifest, bundle: assets.bundle, sha256: assets.sha256 },
    );
    if (res.ok) {
      this.lastResult = 'installed';
      this.deps.logger?.('info', `OTA ${res.version} installed; requesting restart`);
      // Give the HTTP response a tick to flush before exiting.
      setTimeout(() => this.deps.requestRestart(), 500);
    } else {
      this.lastResult = res.reason === 'verify-failed' ? 'verify-failed' : this.lastResult;
    }
    return { status: this.getStatus(), result: res };
  }

  /** Start the periodic auto-check loop (no-op in manual mode; re-reads mode each tick). */
  public start(): void {
    if (this.timer !== null) return;
    const tick = (): void => {
      void this.autoTick().catch(() => undefined);
    };
    const intervalMs = Math.max(1, this.deps.getIntervalHours()) * 3_600_000;
    this.timer = setInterval(tick, intervalMs);
    // Best-effort initial check shortly after boot.
    setTimeout(tick, 30_000);
  }

  public stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async autoTick(): Promise<void> {
    if (this.deps.getMode() !== 'auto') {
      // Still refresh status so the UI shows "update available" in manual mode.
      await this.check();
      return;
    }
    await this.install();
  }
}
