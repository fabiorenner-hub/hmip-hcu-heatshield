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
    // The production default UI version is now v2 (Liquid Glass). The existing
    // suites assert the v1 chrome/views by default and pin v2 explicitly where
    // needed, so pin the test-suite default to v1 before any module loads.
    // (Individual tests still call setUiVersion('v2') to exercise v2.)
    localStorage.setItem('heatshield.uiVersion', 'v1');
  }
} catch {
  /* node environment: no localStorage, i18n falls back to German anyway */
}
