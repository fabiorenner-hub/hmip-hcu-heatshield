/**
 * Test setup — force the dashboard language to German.
 *
 * The dashboard i18n layer (`spa/i18n.ts`) defaults to `AUTO`, which resolves
 * from `navigator.language`. Under jsdom that is `en-US`, so AUTO would render
 * the SPA in English. The existing UI assertions are written against the
 * German source strings, so we pin the persisted preference to `de` before any
 * component module (and therefore `i18n.ts`) is imported. Tests that need a
 * specific language can still call `setLangPref(...)` explicitly.
 */

try {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('heatshield.lang', 'de');
  }
} catch {
  /* node environment: no localStorage, i18n falls back to German anyway */
}
