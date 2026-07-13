/**
 * Heat Shield — OTA update source: GitHub Releases (HTTPS, fixed repo).
 *
 * Resolves `releases/latest` for the hard-wired plugin repo and locates the OTA
 * assets by name:
 *   - manifest:  `ota-manifest*.json`      (small; version/minCore/sha256/...)
 *   - bundle:    `heatshield-ota-*.json`    (large; path→base64 payload file)
 *   - sha256:    `*.sha256`                 (optional secondary integrity file)
 *
 * The repo is fixed in code (mirrors the SPA's `GITHUB_REPO`); there is no
 * user-configurable update URL. Only https asset URLs are used.
 */

/** Owner/repo of this plugin (mirrors src/.../hooks/useUpdateCheck.ts). */
export const GITHUB_REPO = 'fabiorenner-hub/hmip-hcu-heatshield';
export const LATEST_RELEASE_API = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

export type FetchLike = (
  input: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string>; arrayBuffer: () => Promise<ArrayBuffer> }>;

export interface ReleaseAsset {
  readonly name: string;
  readonly url: string; // browser_download_url (https)
}

export interface LatestRelease {
  readonly tagName: string;
  readonly htmlUrl: string;
  readonly assets: ReleaseAsset[];
}

export interface OtaAssetSet {
  readonly manifest: ReleaseAsset | null;
  readonly bundle: ReleaseAsset | null;
  readonly sha256: ReleaseAsset | null;
}

/** GET releases/latest for the fixed repo. Returns null on any non-OK/parse. */
export async function fetchLatestRelease(fetchImpl: FetchLike): Promise<LatestRelease | null> {
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchImpl(LATEST_RELEASE_API, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'heatshield-ota' },
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let j: unknown;
  try {
    j = await res.json();
  } catch {
    return null;
  }
  return parseRelease(j);
}

/** Parse a GitHub `releases/latest` JSON body into {@link LatestRelease}. */
export function parseRelease(j: unknown): LatestRelease | null {
  if (j === null || typeof j !== 'object') return null;
  const obj = j as Record<string, unknown>;
  const tagName = typeof obj['tag_name'] === 'string' ? obj['tag_name'] : null;
  if (tagName === null) return null;
  const htmlUrl = typeof obj['html_url'] === 'string' ? obj['html_url'] : `https://github.com/${GITHUB_REPO}/releases`;
  const rawAssets = Array.isArray(obj['assets']) ? obj['assets'] : [];
  const assets: ReleaseAsset[] = [];
  for (const a of rawAssets) {
    if (a === null || typeof a !== 'object') continue;
    const ao = a as Record<string, unknown>;
    const name = typeof ao['name'] === 'string' ? ao['name'] : null;
    const url = typeof ao['browser_download_url'] === 'string' ? ao['browser_download_url'] : null;
    if (name !== null && url !== null && url.startsWith('https://')) {
      assets.push({ name, url });
    }
  }
  return { tagName, htmlUrl, assets };
}

/** Locate the three OTA assets in a release by filename pattern. */
export function findOtaAssets(rel: LatestRelease): OtaAssetSet {
  let manifest: ReleaseAsset | null = null;
  let bundle: ReleaseAsset | null = null;
  let sha256: ReleaseAsset | null = null;
  for (const a of rel.assets) {
    const n = a.name.toLowerCase();
    if (/^ota-manifest.*\.json$/u.test(n)) manifest = a;
    else if (n.endsWith('.sha256')) sha256 = a;
    else if (/^heatshield-ota-.*\.json$/u.test(n)) bundle = a;
  }
  return { manifest, bundle, sha256 };
}
