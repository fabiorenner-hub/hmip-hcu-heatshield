/**
 * Heat Shield — OTA semantic-version comparison (pure).
 *
 * Server-side counterpart to the SPA's `useUpdateCheck` version compare. Handles
 * `vX.Y.Z` and `X.Y.Z` (optional `v` prefix, ignores any build/pre-release
 * suffix after the patch number). No external dependency.
 */

/** Parse a version string into `[major, minor, patch]`. Missing parts → 0. */
export function parseSemver(v: string): [number, number, number] {
  const cleaned = v.trim().replace(/^v/iu, '');
  // Take only the leading `X.Y.Z` (drop `+build` / `-pre` tails).
  const core = cleaned.split(/[-+]/u)[0] ?? '';
  const parts = core.split('.');
  const num = (s: string | undefined): number => {
    const n = Number.parseInt(s ?? '0', 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };
  return [num(parts[0]), num(parts[1]), num(parts[2])];
}

/** −1 if a<b, 0 if equal, 1 if a>b. */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i += 1) {
    const x = pa[i]!;
    const y = pb[i]!;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

/** True when `a` is strictly newer than `b`. */
export function isNewer(a: string, b: string): boolean {
  return compareSemver(a, b) > 0;
}

/** True when `a` is at least (>=) `b`. */
export function isAtLeast(a: string, b: string): boolean {
  return compareSemver(a, b) >= 0;
}
