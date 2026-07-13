/**
 * Heat Shield — SPA display version.
 *
 * Single string shown in the header next to the brand. Bumped in lockstep
 * with `package.json` / Dockerfile during a release. Kept as a static const
 * (rather than read from the snapshot) so the version is visible immediately
 * on load, before any `/api/state` round-trip.
 */
export const APP_VERSION = '2.0.26';
