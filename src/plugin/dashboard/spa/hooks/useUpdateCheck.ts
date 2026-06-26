/**
 * Update check against the public GitHub repository.
 *
 * Fetches the latest release tag from the GitHub REST API (CORS-enabled, no
 * auth, 60 req/h/IP) and compares it to the locally running {@link APP_VERSION}.
 * Exposes a shared signal so the header badge and the Updates tab can both show
 * an "update available" hint without each re-fetching.
 */

import { signal, type Signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';

import { APP_VERSION } from '../version.js';

/** GitHub owner/repo for this plugin (public). */
export const GITHUB_REPO = 'fabiorenner-hub/hmip-hcu-heatshield';
export const GITHUB_URL = `https://github.com/${GITHUB_REPO}`;
export const GITHUB_RELEASES_URL = `${GITHUB_URL}/releases`;

export interface UpdateInfo {
  /** Latest release tag from GitHub (without leading "v"), or null. */
  latest: string | null;
  /** Link to open (the release page, else the repo releases page). */
  url: string;
  /** True when the GitHub tag is newer than the running version. */
  updateAvailable: boolean;
  /** True once a check has completed (success or failure). */
  checked: boolean;
}

const sig = signal<UpdateInfo>({
  latest: null,
  url: GITHUB_RELEASES_URL,
  updateAvailable: false,
  checked: false,
});

function parseVersion(s: string): [number, number, number] {
  const parts = s.trim().replace(/^v/i, '').split('.');
  const n = (i: number): number => {
    const v = Number.parseInt(parts[i] ?? '0', 10);
    return Number.isFinite(v) ? v : 0;
  };
  return [n(0), n(1), n(2)];
}

/** True when `a` is a strictly newer semver than `b`. */
function isNewer(a: [number, number, number], b: [number, number, number]): boolean {
  for (let i = 0; i < 3; i += 1) {
    if (a[i]! > b[i]!) return true;
    if (a[i]! < b[i]!) return false;
  }
  return false;
}

let started = false;

async function runCheck(): Promise<void> {
  if (started) return;
  started = true;
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) {
      // 404 = no releases yet; just mark checked.
      sig.value = { ...sig.value, checked: true };
      return;
    }
    const j = (await res.json()) as { tag_name?: unknown; html_url?: unknown };
    const tag = typeof j.tag_name === 'string' ? j.tag_name : null;
    const url = typeof j.html_url === 'string' ? j.html_url : GITHUB_RELEASES_URL;
    const updateAvailable =
      tag !== null && isNewer(parseVersion(tag), parseVersion(APP_VERSION));
    sig.value = {
      latest: tag === null ? null : tag.replace(/^v/i, ''),
      url,
      updateAvailable,
      checked: true,
    };
  } catch {
    sig.value = { ...sig.value, checked: true };
  }
}

/** Shared signal — read directly where the hook lifecycle is not needed. */
export const updateInfo: Signal<UpdateInfo> = sig;

/** Trigger the check once (idempotent) and subscribe to the result. */
export function useUpdateCheck(): Signal<UpdateInfo> {
  useEffect(() => {
    void runCheck();
  }, []);
  return sig;
}
