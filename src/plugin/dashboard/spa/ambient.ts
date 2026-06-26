/**
 * Heat Shield — ambient dashboard background (V1.2).
 *
 * Pure helper that turns the current sun elevation + weather into a CSS
 * background value. When the ambient mode is on, the whole dashboard sits on
 * this dynamic gradient and the glass surfaces let it shine through, so the UI
 * "breathes" with the time of day and the weather. Deterministic + testable.
 */

/** Bands of the day used to pick a palette. */
export type AmbientPhase = 'night' | 'dawn' | 'day' | 'storm';

export function ambientPhase(elevationDeg: number, storm: boolean): AmbientPhase {
  if (storm) return 'storm';
  if (elevationDeg < -6) return 'night';
  if (elevationDeg < 8) return 'dawn';
  return 'day';
}

/**
 * Build the CSS `background` value for the whole dashboard. Two layers: a soft
 * radial "sky glow" near the top plus a vertical gradient. `cloud01` (0..1)
 * desaturates the daytime palette toward overcast grey.
 */
export function ambientBackground(
  elevationDeg: number,
  cloud01: number,
  storm: boolean,
): string {
  const phase = ambientPhase(elevationDeg, storm);
  const cloudy = Number.isFinite(cloud01) && cloud01 > 0.6;

  switch (phase) {
    case 'storm':
      return [
        'radial-gradient(120% 80% at 50% -10%, rgba(90,110,140,0.16), transparent 60%)',
        'linear-gradient(180deg, #0e141d 0%, #080c12 55%, #04060a 100%)',
      ].join(', ');
    case 'night':
      return [
        'radial-gradient(90% 60% at 70% -10%, rgba(60,85,150,0.16), transparent 55%)',
        'linear-gradient(180deg, #04060f 0%, #060a18 60%, #080c1f 100%)',
      ].join(', ');
    case 'dawn':
      return cloudy
        ? [
            'radial-gradient(110% 70% at 50% -10%, rgba(120,120,140,0.16), transparent 60%)',
            'linear-gradient(180deg, #0c1322 0%, #23263a 55%, #3c2e36 100%)',
          ].join(', ')
        : [
            'radial-gradient(110% 70% at 60% -8%, rgba(255,170,100,0.22), transparent 55%)',
            'linear-gradient(180deg, #0a1424 0%, #221f3c 50%, #6e3f2c 100%)',
          ].join(', ');
    case 'day':
      return cloudy
        ? [
            'radial-gradient(120% 70% at 50% -10%, rgba(150,165,185,0.16), transparent 60%)',
            'linear-gradient(180deg, #141d2b 0%, #29384b 55%, #3f5468 100%)',
          ].join(', ')
        : [
            'radial-gradient(120% 70% at 60% -10%, rgba(255,205,120,0.20), transparent 55%)',
            'linear-gradient(180deg, #07203f 0%, #173a5e 55%, #336184 100%)',
          ].join(', ');
  }
}

const AMBIENT_KEY = 'heatshield.ambient.v1';

/** Load the ambient toggle (default: off — the calm lighter theme is default). */
export function loadAmbient(): boolean {
  try {
    return window.localStorage.getItem(AMBIENT_KEY) === 'true';
  } catch {
    return false;
  }
}

export function saveAmbient(on: boolean): void {
  try {
    window.localStorage.setItem(AMBIENT_KEY, on ? 'true' : 'false');
  } catch {
    /* ignore */
  }
}
