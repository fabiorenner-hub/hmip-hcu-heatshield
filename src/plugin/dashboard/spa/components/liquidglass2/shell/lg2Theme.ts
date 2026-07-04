/**
 * Heat Shield — "Liquid Glass V2" theme system (ui-v2-release, Task 2).
 *
 * Extracted verbatim from `liquidGlass2Overview.tsx` so the whole v2 design can
 * share ONE appearance config across every page and the app-wide shell. Pure
 * TypeScript: types, the persisted `theme` signal, presets (built-in + custom),
 * colour maths and the `themeStyle()` CSS-variable builder. No JSX, no i18n —
 * label tuples are `[de, en]` and translated at the render edge.
 *
 * Persistence keys are unchanged (`heatshield.lg2.theme.v3`,
 * `heatshield.lg2.customPresets.v1`) so existing user themes keep loading.
 */

import { signal } from '@preact/signals';

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export type Scheme = 'auto' | 'light' | 'dark';
export type GlassKind = 'frost' | 'graphite';
export type RadiusKind = 'sharp' | 'std' | 'round';
export type FillKind = 'color' | 'gradient' | 'image' | 'url';

/**
 * Configurable semantic colour palette. The accent is a separate, prominent
 * control; this palette drives the STATUS hues used across the UI — risk tones
 * (low = success, high = danger), ok/warn/error dots, freshness, chart series.
 * Emitted as `--lg2-green/-red/-blue/-yellow` (overriding the Apple defaults).
 */
export interface Lg2Palette {
  success: string; // "Gering"/ok/executing — green
  warning: string; // warn/attention — amber
  danger: string; // "Hoch"/blocked/error — red
  info: string; // forecast/water/neutral accent — blue
}

export const DEFAULT_PALETTE: Lg2Palette = {
  success: '#30d158',
  warning: '#ff9f0a',
  danger: '#ff453a',
  info: '#0a84ff',
};

/**
 * A fully configurable surface fill, shared by the demo background AND the outer
 * frame. `color`/`gradient` are self-contained; `image` references a generated
 * PNG in /assets/lg2; `url` takes any external image. `opacity` dims image/url.
 */
export interface Fill {
  kind: FillKind;
  color: string; // solid colour
  gradFrom: string; // gradient start colour
  gradTo: string; // gradient end colour
  gradAngle: number; // gradient angle (deg)
  image: string; // image key into LG2_IMAGES
  url: string; // custom image URL
  opacity: number; // 0..1 layer opacity (transparency)
  blur: number; // px background blur (soft-focus wallpaper)
}

export interface Lg2Theme {
  preset: string;
  accent: string;
  scheme: Scheme;
  glass: GlassKind;
  blur: number; // px 0..40
  sat: number; // saturation percent 100..200
  alpha: number; // glass translucency 0.12..0.85
  radius: RadiusKind;
  bevel: boolean; // frosted edge bevel
  liquid: boolean; // real "liquid glass": refract the wallpaper + specular edges
  lite: boolean; // no blur (performance)
  preblur: boolean; // pre-blur the wallpaper ONCE (canvas) instead of per-card backdrop-filter (performance, same look)
  // "High FPS Mode": a master switch plus granular, individually-toggleable
  // micro-optimizations. All keep the look identical (or near-identical). Only
  // applied when `fps` (master) is on AND the individual flag is on.
  fps: boolean; // master High FPS Mode
  fpsNoNestedBlur: boolean; // #1 drop redundant backdrop-filter on chips/buttons sitting on a blurred card
  fpsContentVis: boolean; // #4 content-visibility: skip painting off-screen list rows
  fpsContain: boolean; // #5 contain: layout style on cards (isolate recalc)
  fpsPauseHidden: boolean; // #6 pause CSS animations while the tab is hidden
  fpsLiteBevel: boolean; // #7 lighter card bevel (fewer stacked shadows)
  fpsNoSpecular: boolean; // #8 drop the ::before specular rim (mask-composite) on cards
  gap: number; // px spacing between tiles 8..28
  contour: number; // border/contour strength 0..1
  sheen: boolean; // specular glass sheen
  iconTiles: boolean; // app-icon style: neutral gradient tile behind every category glyph (off = normal accent-tinted symbols)
  iconTilesAccent: boolean; // icon tile gradient in the ACCENT colour instead of the neutral black/white gradient
  iconGlyphShadow: boolean; // drop-shadow under the icon glyph (inside the tile)
  elevation: number; // shadow depth 0..1
  accentAuto: boolean; // derive accent from weather/mode
  navTile: boolean; // wrap nav links in a glass tile
  navRail: boolean; // compact icon-only nav rail (VisionOS style)
  hover: string; // hover fill colour ('auto' = scheme-based)
  background: Fill; // demo wallpaper
  frameAuto: boolean; // frame mirrors the main background (default), just darker
  frame: Fill; // outer side frame fill when frameAuto is off
  frameShadow: boolean; // drop shadow cast by the main area onto the frame
  frameDarken: number; // 0..100 % extra darkening applied to the frame
  palette: Lg2Palette; // configurable semantic status colours
}

/** Selectable generated backdrops (served from /assets/lg2/<key>.png). */
export const LG2_IMAGES: Array<{ key: string; label: [string, string] }> = [
  { key: 'bg-house', label: ['Haus', 'House'] },
  { key: 'room', label: ['Wohnraum', 'Living room'] },
  { key: 'bg-nature', label: ['Natur', 'Nature'] },
  { key: 'bg-modern', label: ['Modern', 'Modern'] },
  { key: 'bg-abstract', label: ['Abstrakt', 'Abstract'] },
  { key: 'bg-ocean', label: ['Ocean', 'Ocean'] },
  { key: 'bg-sunset', label: ['Sunset', 'Sunset'] },
  { key: 'bg-nebula', label: ['Nebula', 'Nebula'] },
  { key: 'bg-mono', label: ['Mono', 'Mono'] },
  { key: 'bg-frost', label: ['Frost', 'Frost'] },
  { key: 'backdrop', label: ['Aurora', 'Aurora'] },
];

/** Build a Fill with sensible defaults, overriding the given fields. */
function mkFill(over: Partial<Fill>): Fill {
  return {
    kind: 'gradient', color: '#0a84ff',
    gradFrom: '#0b1a2e', gradTo: '#05070c', gradAngle: 160,
    image: 'bg-house', url: '', opacity: 0.55, blur: 0, ...over,
  };
}

// Default = the "Zuhause" (Home) look: frosted glass over the living-room photo,
// Apple-white auto-accent, soft-focused (pre-blurred) wallpaper, slim icon rail,
// High FPS Mode on, no icon tiles / no icon shadow. Officially saved baseline
// for "Liquid Glass V2" (matches the `glass` preset) — the default for every
// fresh installation.
export const DEFAULT_THEME: Lg2Theme = {
  preset: 'glass', accent: '#ffffff', scheme: 'dark', glass: 'frost',
  blur: 30, sat: 150, alpha: 0.13, radius: 'round', bevel: true, liquid: false, lite: false, preblur: true,
  fps: true, fpsNoNestedBlur: true, fpsContentVis: true, fpsContain: true,
  fpsPauseHidden: true, fpsLiteBevel: true, fpsNoSpecular: true,
  gap: 16, contour: 0.5, sheen: true, iconTiles: false, iconTilesAccent: true, iconGlyphShadow: false, elevation: 0.7,
  accentAuto: true, navTile: true, navRail: false, hover: 'auto',
  background: mkFill({ kind: 'image', image: 'bg-house', opacity: 0.74, blur: 8 }),
  frameAuto: true,
  frame: mkFill({ kind: 'image', image: 'bg-house', opacity: 1 }),
  frameShadow: true, frameDarken: 58,
  palette: { ...DEFAULT_PALETTE },
};
const THEME_KEY = 'heatshield.lg2.theme.v3';
export const ACCENTS = ['#ff9f0a', '#0a84ff', '#35d6e7', '#30d158', '#bf5af2', '#ff375f', '#ffd60a', '#9fb0c2'];

/** An image background + a matching, darker image frame (same picture). */
function imgBgFrame(key: string, opacity: number, darken: number): Partial<Lg2Theme> {
  return {
    background: mkFill({ kind: 'image', image: key, opacity }),
    frameAuto: true,
    frame: mkFill({ kind: 'image', image: key, opacity: 1 }),
    frameShadow: true, frameDarken: darken,
  };
}

/**
 * Build a COMPLETE preset patch. Every visual property is set explicitly, so
 * switching presets always yields a clean, fully-defined look with NO leftover
 * values from the previously active theme. Callers spread `imgBgFrame(...)` (or
 * a gradient background) into `over` to set the wallpaper + matching frame.
 */
function preset(over: Partial<Lg2Theme> & { accent: string }): Partial<Lg2Theme> {
  return {
    scheme: 'dark', glass: 'frost', blur: 22, sat: 150, alpha: 0.16,
    radius: 'round', bevel: true, liquid: false, lite: false, preblur: false,
    fps: true, fpsNoNestedBlur: true, fpsContentVis: true, fpsContain: true,
    fpsPauseHidden: true, fpsLiteBevel: true, fpsNoSpecular: true, gap: 16, contour: 0.5,
    sheen: true, iconTiles: true, iconTilesAccent: true, iconGlyphShadow: false, elevation: 0.7, accentAuto: false, navTile: true,
    navRail: true, hover: 'auto', frameAuto: true, frameShadow: true,
    frameDarken: 55, palette: { ...DEFAULT_PALETTE },
    ...over,
  };
}

/**
 * Ten curated, richly varied appearance presets (Frosted-Glass family). Each is
 * a full theme: it varies glass kind, scheme (incl. a light option), accent,
 * blur, saturation, translucency, corner radius, bevel, sheen, elevation, gap,
 * nav style and its own generated wallpaper + matching frame. Plus a utility
 * "Performance" (Lite, no blur) entry.
 */
export const PRESETS: Array<{ id: string; label: [string, string]; patch: Partial<Lg2Theme> }> = [
  // 0 — Glass (DEFAULT): frosted glass over a soft-focused living-room photo,
  // white auto-accent, pre-blurred wallpaper, no icon tiles, High FPS on.
  { id: 'glass', label: ['Glass', 'Glass'], patch: preset({
    accent: '#ffffff', accentAuto: true, glass: 'frost', scheme: 'dark',
    blur: 30, sat: 150, alpha: 0.13, radius: 'round', bevel: true, elevation: 0.7,
    navRail: false, preblur: true, iconTiles: false,
    background: mkFill({ kind: 'image', image: 'bg-house', opacity: 0.74, blur: 8 }),
    frameAuto: true, frame: mkFill({ kind: 'image', image: 'bg-house', opacity: 1 }),
    frameShadow: true, frameDarken: 58 }) },
  // 0b — White: bright minimal LIGHT theme — near-white surfaces, slate accent, flat.
  { id: 'white', label: ['White', 'White'], patch: preset({
    accent: '#9fb0c2', accentAuto: false, glass: 'frost', scheme: 'light',
    blur: 14, sat: 130, alpha: 0.16, radius: 'round', bevel: true, contour: 0.5,
    sheen: true, elevation: 0.1, gap: 16, navTile: true, navRail: true, hover: 'auto',
    background: mkFill({ kind: 'color', color: '#ffffff', opacity: 0.55 }),
    frameAuto: true, frame: mkFill({ kind: 'color', color: '#05070d', opacity: 0.55 }),
    frameShadow: true, frameDarken: 40 }) },
  // 1 — Home: frosted glass over a dark living-room interior, Apple-blue, slim rail.
  { id: 'home', label: ['Zuhause', 'Home'], patch: preset({
    accent: '#0a84ff', glass: 'frost', scheme: 'dark', blur: 30, sat: 150, alpha: 0.13,
    radius: 'round', bevel: true, elevation: 0.7, navRail: true, ...imgBgFrame('bg-house', 0.74, 58) }) },
  // 2 — Frosted: bright, airy LIGHT theme — clean ice-blue frost, soft shadows.
  { id: 'frost', label: ['Frosted', 'Frosted'], patch: preset({
    accent: '#0a84ff', glass: 'frost', scheme: 'light', blur: 18, sat: 125, alpha: 0.5,
    radius: 'round', bevel: true, contour: 0.4, elevation: 0.45, gap: 16, navRail: true,
    ...imgBgFrame('bg-frost', 0.9, 18) }) },
  // 3 — Mono: minimal graphite, neutral slate accent, crisp square corners, no bevel.
  { id: 'mono', label: ['Mono', 'Mono'], patch: preset({
    iconTilesAccent: false, accent: '#9fb0c2', glass: 'graphite', scheme: 'dark', blur: 16, sat: 108, alpha: 0.5,
    radius: 'sharp', bevel: false, sheen: false, contour: 0.35, elevation: 0.5, gap: 14,
    navRail: false, navTile: true, ...imgBgFrame('bg-mono', 0.4, 55) }) },
  // 4 — Nature: frosted glass over botanical green foliage, fresh green accent.
  { id: 'nature', label: ['Natur', 'Nature'], patch: preset({
    iconTilesAccent: false, accent: '#30d158', glass: 'frost', scheme: 'dark', blur: 20, sat: 160, alpha: 0.16,
    radius: 'round', bevel: true, elevation: 0.7, gap: 16, navRail: true,
    ...imgBgFrame('bg-nature', 0.55, 55) }) },
  // 5 — Modern: architectural graphite, cool blue, sharp edges, deep elevation.
  { id: 'modern', label: ['Modern', 'Modern'], patch: preset({
    iconTilesAccent: false, accent: '#4a8cff', glass: 'graphite', scheme: 'dark', blur: 24, sat: 140, alpha: 0.32,
    radius: 'sharp', bevel: false, sheen: true, contour: 0.6, elevation: 0.85, gap: 18,
    navRail: true, ...imgBgFrame('bg-modern', 0.5, 55) }) },
  // 6 — Abstract: vivid fluid colour field, violet accent, glossy frosted glass.
  { id: 'abstract', label: ['Abstrakt', 'Abstract'], patch: preset({
    iconTilesAccent: false, accent: '#bf5af2', glass: 'frost', scheme: 'dark', blur: 24, sat: 178, alpha: 0.18,
    radius: 'round', bevel: true, sheen: true, elevation: 0.75, gap: 16,
    ...imgBgFrame('bg-abstract', 0.6, 55) }) },
  // 7 — Ocean: teal/cyan aurora, cool frosted glass.
  { id: 'ocean', label: ['Ocean', 'Ocean'], patch: preset({
    iconTilesAccent: false, accent: '#35d6e7', glass: 'frost', scheme: 'dark', blur: 18, sat: 150, alpha: 0.16,
    radius: 'round', bevel: true, ...imgBgFrame('bg-ocean', 0.5, 55) }) },
  // 8 — Sunset: warm amber dusk, rich graphite glass.
  { id: 'sunset', label: ['Sunset', 'Sunset'], patch: preset({
    accent: '#ff8c42', glass: 'graphite', scheme: 'dark', blur: 22, sat: 170, alpha: 0.4,
    radius: 'std', bevel: true, ...imgBgFrame('bg-sunset', 0.5, 55) }) },
  // 9 — Nebula: cosmic violet/magenta glow, frosted glass.
  { id: 'nebula', label: ['Nebula', 'Nebula'], patch: preset({
    accent: '#ff375f', glass: 'frost', scheme: 'dark', blur: 20, sat: 165, alpha: 0.18,
    radius: 'round', bevel: true, ...imgBgFrame('bg-nebula', 0.5, 55) }) },
  // 10 — Aurora: abstract amber+cyan aurora backdrop, Apple-blue accent, airy glass.
  { id: 'aurora', label: ['Aurora', 'Aurora'], patch: preset({
    accent: '#0a84ff', glass: 'frost', scheme: 'dark', blur: 26, sat: 155, alpha: 0.15,
    radius: 'round', bevel: true, elevation: 0.7, ...imgBgFrame('backdrop', 0.6, 55) }) },
  // Utility — Performance: Lite (no blur), opaque glass, amber; for low-end devices.
  { id: 'perf', label: ['Performance', 'Performance'], patch: preset({
    accent: '#ff9f0a', glass: 'graphite', scheme: 'dark', lite: true, blur: 0, sat: 120,
    alpha: 0.72, radius: 'std', bevel: false, sheen: false, ...imgBgFrame('bg-mono', 0.35, 55) }) },
];

function loadTheme(): Lg2Theme {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    if (raw !== null) {
      const p = JSON.parse(raw) as Partial<Lg2Theme>;
      return {
        ...DEFAULT_THEME, ...p,
        background: { ...DEFAULT_THEME.background, ...(p.background ?? {}) },
        frame: { ...DEFAULT_THEME.frame, ...(p.frame ?? {}) },
        palette: { ...DEFAULT_PALETTE, ...(p.palette ?? {}) },
      };
    }
  } catch { /* ignore */ }
  return DEFAULT_THEME;
}
export const theme = signal<Lg2Theme>(loadTheme());
function saveTheme(): void {
  try { localStorage.setItem(THEME_KEY, JSON.stringify(theme.value)); } catch { /* ignore */ }
}
/**
 * Manual tweak. When editing a SAVED custom preset (`preset` is a `custom-…`
 * id) the id is KEPT so the user can over-save it (the stored copy stays until
 * they hit "Überspeichern"). Editing a built-in preset detaches to `'custom'`.
 */
export function tweak(patch: Partial<Lg2Theme>): void {
  const cur = theme.value.preset;
  const nextPreset = cur.startsWith('custom-') ? cur : 'custom';
  theme.value = { ...theme.value, ...patch, preset: nextPreset };
  saveTheme();
}
export function applyPreset(id: string): void {
  const p = PRESETS.find((x) => x.id === id);
  if (p === undefined) return;
  theme.value = { ...theme.value, ...p.patch, preset: id };
  saveTheme();
}

/* User-defined presets: capture the FULL current appearance config (all options),
   persisted per-device in localStorage. Global — applies across every V2 page. */
export interface CustomPreset { id: string; name: string; theme: Lg2Theme; }
const CUSTOM_KEY = 'heatshield.lg2.customPresets.v1';
function loadCustom(): CustomPreset[] {
  try {
    const raw = localStorage.getItem(CUSTOM_KEY);
    if (raw !== null) return JSON.parse(raw) as CustomPreset[];
  } catch { /* ignore */ }
  return [];
}
export const customPresets = signal<CustomPreset[]>(loadCustom());
function persistCustom(): void {
  try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(customPresets.value)); } catch { /* ignore */ }
}
export function saveCurrentAsPreset(name: string): void {
  const clean = name.trim();
  if (clean === '') return;
  const id = `custom-${Date.now().toString(36)}`;
  const captured: Lg2Theme = { ...theme.value, preset: id };
  customPresets.value = [...customPresets.value, { id, name: clean, theme: captured }];
  persistCustom();
  theme.value = { ...theme.value, preset: id };
  saveTheme();
}
export function applyCustomPreset(id: string): void {
  const p = customPresets.value.find((x) => x.id === id);
  if (p === undefined) return;
  theme.value = { ...p.theme, preset: id };
  saveTheme();
}
export function deleteCustomPreset(id: string): void {
  customPresets.value = customPresets.value.filter((x) => x.id !== id);
  persistCustom();
  if (theme.value.preset === id) { theme.value = { ...theme.value, preset: 'custom' }; saveTheme(); }
}
/** Over-save the current appearance into an existing custom preset (keeps its
 *  name + id). Used by the "Überspeichern" button when a custom preset is the
 *  active, modified theme. */
export function updateCustomPreset(id: string): void {
  const captured: Lg2Theme = { ...theme.value, preset: id };
  let found = false;
  customPresets.value = customPresets.value.map((p) => {
    if (p.id !== id) return p;
    found = true;
    return { ...p, theme: captured };
  });
  if (!found) return;
  persistCustom();
  theme.value = captured;
  saveTheme();
}

/* -------------------------------------------------------------------------- */
/* Import / Export                                                            */
/* -------------------------------------------------------------------------- */

/** Serialise the CURRENT theme to a pretty JSON string (for export / copy). */
export function exportThemeJson(): string {
  return JSON.stringify({ kind: 'heatshield.lg2.theme', version: 1, theme: theme.value }, null, 2);
}

/**
 * Parse an exported theme JSON (either the wrapped `{kind,version,theme}` shape
 * or a bare theme object) and apply it, merged defensively over DEFAULT_THEME so
 * missing/renamed fields never break the UI. Returns `{ ok }` (with `error` on
 * failure). The imported theme becomes the active (unsaved) `'custom'` theme.
 */
export function importThemeJson(raw: string): { ok: boolean; error?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'invalid-json' };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { ok: false, error: 'not-an-object' };
  }
  const obj = parsed as Record<string, unknown>;
  const rawTheme =
    'theme' in obj && obj['theme'] !== null && typeof obj['theme'] === 'object'
      ? (obj['theme'] as Partial<Lg2Theme>)
      : (obj as Partial<Lg2Theme>);
  // Sanity: it must look like a theme (has at least a known key).
  const looksLikeTheme =
    'accent' in rawTheme || 'glass' in rawTheme || 'background' in rawTheme || 'palette' in rawTheme;
  if (!looksLikeTheme) {
    return { ok: false, error: 'not-a-theme' };
  }
  const merged: Lg2Theme = {
    ...DEFAULT_THEME,
    ...rawTheme,
    background: { ...DEFAULT_THEME.background, ...(rawTheme.background ?? {}) },
    frame: { ...DEFAULT_THEME.frame, ...(rawTheme.frame ?? {}) },
    palette: { ...DEFAULT_PALETTE, ...(rawTheme.palette ?? {}) },
    preset: 'custom',
  };
  theme.value = merged;
  saveTheme();
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* Colour maths                                                               */
/* -------------------------------------------------------------------------- */

export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim());
  if (m === null) return [255, 159, 10];
  return [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)];
}
function lighten(hex: string, amt: number): string {
  const [r, g, b] = hexToRgb(hex);
  const f = (c: number): number => Math.round(c + (255 - c) * amt);
  return `rgb(${f(r)}, ${f(g)}, ${f(b)})`;
}
function resolveDark(scheme: Scheme): boolean {
  if (scheme === 'dark') return true;
  if (scheme === 'light') return false;
  try {
    return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return true;
  }
}
/** CSS `background` paint for a fill. Images use viewport-fixed cover so the
 *  demo wallpaper and the frame wallpaper line up seamlessly at the edge. */
export function fillPaint(f: Fill): string {
  switch (f.kind) {
    case 'color':
      return f.color;
    case 'gradient':
      return `linear-gradient(${f.gradAngle}deg, ${f.gradFrom}, ${f.gradTo})`;
    case 'image':
      return `url('/assets/lg2/${f.image}.png') center / cover fixed no-repeat`;
    case 'url':
      return f.url.trim() !== '' ? `url("${f.url.trim()}") center / cover fixed no-repeat` : 'transparent';
  }
}
/** Solid base colour painted behind a fill (fallback while images load). */
export function fillBase(f: Fill): string {
  if (f.kind === 'color') return f.color;
  if (f.kind === 'gradient') return f.gradTo;
  return '#05070d';
}
/** Hover fill: 'auto' → a subtle tint of the (effective) accent so it adapts to
 *  the active preset; otherwise the explicit colour at a fixed alpha. */
function hoverFill(th: Lg2Theme, accent: string): string {
  if (th.hover !== 'auto') {
    const [r, g, b] = hexToRgb(th.hover);
    return `rgba(${r}, ${g}, ${b}, 0.22)`;
  }
  const [r, g, b] = hexToRgb(accent);
  return `rgba(${r}, ${g}, ${b}, ${resolveDark(th.scheme) ? '0.18' : '0.14'})`;
}

/** Hue (0..360) of an RGB colour. */
function hueOf(r: number, g: number, b: number): number {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn), d = max - min;
  if (d === 0) return 0;
  let hh: number;
  if (max === rn) hh = ((gn - bn) / d) % 6;
  else if (max === gn) hh = (bn - rn) / d + 2;
  else hh = (rn - gn) / d + 4;
  hh *= 60;
  return hh < 0 ? hh + 360 : hh;
}
/** Pick a vivid Apple-system accent that matches a colour's hue (grey → slate). */
function accentFromColor(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  if (Math.max(r, g, b) - Math.min(r, g, b) < 22) return '#8ea6c4'; // near-grey → slate
  const hh = hueOf(r, g, b);
  if (hh < 20 || hh >= 335) return '#ff453a'; // red
  if (hh < 45) return '#ff9f0a'; // orange
  if (hh < 70) return '#ffd60a'; // yellow
  if (hh < 160) return '#30d158'; // green
  if (hh < 200) return '#35d6e7'; // cyan
  if (hh < 255) return '#0a84ff'; // blue
  if (hh < 300) return '#bf5af2'; // purple
  return '#ff375f'; // pink/magenta
}
/** Curated accent per generated backdrop image (complements the artwork). */
const IMAGE_ACCENT: Record<string, string> = {
  'bg-house': '#0a84ff', room: '#0a84ff', 'bg-ocean': '#35d6e7', 'bg-sunset': '#ff9f0a',
  'bg-nebula': '#bf5af2', 'bg-mono': '#8ea6c4', 'bg-frost': '#5ac8fa', backdrop: '#0a84ff',
};
/** Auto accent derived from the BACKGROUND so it always complements the artwork
 *  (image → curated, gradient/colour → matched hue, url → neutral blue). */
export function autoAccent(th: Lg2Theme): string {
  const bg = th.background;
  switch (bg.kind) {
    case 'image':
      return IMAGE_ACCENT[bg.image] ?? '#0a84ff';
    case 'gradient':
      return accentFromColor(bg.gradFrom);
    case 'color':
      return accentFromColor(bg.color);
    case 'url':
    default:
      return '#0a84ff';
  }
}
/** Readable text colour on an accent-filled surface (auto contrast). */
function onAccent(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum > 0.6 ? '#1b1305' : '#ffffff';
}
/**
 * Text + readability-scrim variables, derived from the SCHEME (stable), not a
 * wallpaper-luminance threshold. The previous approach blended the wallpaper
 * luminance and flipped light/dark text at a hard 0.52 boundary — near that
 * boundary a tiny opacity change (e.g. 0 % → 2 % glass) tipped the whole UI
 * between light and dark, and at 0 % the growing scrim looked almost black.
 *
 * Now: a dark scheme always uses LIGHT text on a DARK readability scrim; a light
 * scheme uses DARK text on a LIGHT scrim. The scrim starts at 0 for opaque glass
 * (no darkening — the glass tint carries it) and grows only as the glass becomes
 * transparent, so text stays readable at low opacity WITHOUT turning the surface
 * fully opaque. No flip, predictable behaviour at every opacity.
 */
export function textVars(th: Lg2Theme): Record<string, string> {
  const dark = resolveDark(th.scheme);
  const a = th.lite ? Math.max(th.alpha, 0.62) : th.alpha;
  // Wallpaper bleed-through 0 (opaque) … ~0.68 (fully transparent).
  const show = 1 - Math.min(1, a * 1.3 + 0.32);
  const scrim = {
    '--lg2-scrim-rgb': dark ? '8, 11, 17' : '246, 249, 252',
    // Near-zero at 0 % glass (~0.07) so the surface reads as genuinely
    // transparent — the wallpaper shows through cleanly, no milky veil. Users
    // who want a readability backing simply raise the opacity.
    '--lg2-scrim-a': Math.min(0.1, show * 0.11).toFixed(3),
  };
  const labels = dark
    ? {
      '--lg2-text': '#f4f7fb',
      '--lg2-label-1': '#f4f7fb',
      '--lg2-label-2': 'rgba(236, 241, 248, 0.76)',
      '--lg2-label-3': 'rgba(236, 241, 248, 0.54)',
      '--lg2-label-4': 'rgba(236, 241, 248, 0.36)',
    }
    : {
      '--lg2-text': '#0e1622',
      '--lg2-label-1': '#0e1622',
      '--lg2-label-2': 'rgba(14, 22, 34, 0.74)',
      '--lg2-label-3': 'rgba(14, 22, 34, 0.54)',
      '--lg2-label-4': 'rgba(14, 22, 34, 0.36)',
    };
  return { ...labels, ...scrim };
}

/* -------------------------------------------------------------------------- */
/* themeStyle — CSS-variable + root-class builder                             */
/* -------------------------------------------------------------------------- */

const RADII: Record<RadiusKind, [string, string, string, string]> = {
  sharp: ['8px', '10px', '12px', '14px'],
  std: ['12px', '18px', '24px', '28px'],
  round: ['16px', '22px', '28px', '34px'],
};
const BEVEL =
  'inset 3px 3px 0.5px -3.5px rgba(255,255,255,0.3), inset -2px -2px 0.5px -2px rgba(255,255,255,0.3), inset 0 0 8px 1px rgba(255,255,255,0.1), 0 0 2px 0 rgba(0,0,0,0.1)';
// #7 High-FPS bevel: the same bright edge feel with 2 shadows instead of 4.
const LITE_BEVEL =
  'inset 2px 2px 0.5px -2.5px rgba(255,255,255,0.3), inset 0 0 6px 1px rgba(255,255,255,0.09)';

/**
 * Build the CSS-variable style + root class list. `accent` is the EFFECTIVE
 * accent (auto-derived when accentAuto is on), so all accent tints + contrast
 * stay coherent.
 */
export function themeStyle(th: Lg2Theme, accent: string): { style: Record<string, string>; cls: string } {
  const [r, g, b] = hexToRgb(accent);
  const bgLayer = fillPaint(th.background);
  // Specular sheen strength scales with glass opacity: at 0 % glass there is no
  // glass, so no white sheen (keeps 0 % genuinely transparent, not milky).
  const aEff = th.lite ? Math.max(th.alpha, 0.62) : th.alpha;
  const shF = Math.min(1, aEff * 1.8);
  const [rSm, rMd, rLg, rXl] = RADII[th.radius];
  const style: Record<string, string> = {
    '--lg2-orange': accent,
    '--lg2-orange-2': lighten(accent, 0.22),
    '--lg2-accent': accent,
    '--lg2-accent-rgb': `${r}, ${g}, ${b}`,
    '--lg2-on-accent': onAccent(accent),
    '--lg2-focus': `rgba(${r}, ${g}, ${b}, 0.55)`,
    '--lg2-glass-rgb': th.glass === 'frost' ? '255, 255, 255' : '46, 54, 70',
    '--lg2-glass-alpha': String(th.lite ? Math.max(th.alpha, 0.62) : th.alpha),
    // Configurable semantic palette (overrides the Apple defaults from the
    // static token block). RGB variants kept in sync for translucent tints.
    '--lg2-green': th.palette.success,
    '--lg2-green-rgb': hexToRgb(th.palette.success).join(', '),
    '--lg2-red': th.palette.danger,
    '--lg2-red-rgb': hexToRgb(th.palette.danger).join(', '),
    '--lg2-blue': th.palette.info,
    '--lg2-blue-rgb': hexToRgb(th.palette.info).join(', '),
    '--lg2-yellow': th.palette.warning,
    '--lg2-blur': `${th.lite ? 0 : th.blur}px`,
    '--lg2-blur-lg': `${th.lite ? 0 : th.blur + 10}px`,
    '--lg2-sat': String(th.sat / 100),
    '--lg2-inner':
      th.fps && th.fpsLiteBevel
        ? LITE_BEVEL
        : th.bevel
          ? BEVEL
          : 'inset 0 1px 0 rgba(255,255,255,0.2)',
    '--lg2-r-sm': rSm,
    '--lg2-r': rMd,
    '--lg2-r-lg': rLg,
    '--lg2-r-xl': rXl,
    '--lg2-icontile-glyph-shadow': th.iconGlyphShadow ? 'drop-shadow(0 1px 1px rgba(0,0,0,0.22))' : 'none',
    '--lg2-bg-layer': bgLayer,
    '--lg2-bg-opacity': String(th.background.opacity),
    '--lg2-bg-blur': `${th.background.blur}px`,
    '--lg2-aurora': '1',
    '--lg2-gap': `${th.gap}px`,
    '--lg2-hover': hoverFill(th, accent),
    '--lg2-border-alpha': String(th.contour),
    '--lg2-sheen': th.sheen
      ? `linear-gradient(145deg, rgba(255,255,255,${(0.16 * shF).toFixed(3)}) 0%, rgba(255,255,255,${(0.05 * shF).toFixed(3)}) 26%, rgba(255,255,255,0) 58%)`
      : 'none',
    '--lg2-shadow': `0 1px 2px rgba(0,0,0,${(0.3 * th.elevation).toFixed(2)}), 0 ${Math.round(10 + th.elevation * 26)}px ${Math.round(20 + th.elevation * 46)}px rgba(0,0,0,${(0.44 * th.elevation).toFixed(2)})`,
    ...textVars(th),
  };
  // Icon tiles in the accent colour: override the (otherwise neutral,
  // scheme-aware) icon-tile tokens with an accent gradient + contrast glyph.
  if (th.iconTiles && th.iconTilesAccent) {
    style['--lg2-icontile-bg'] = `linear-gradient(180deg, ${lighten(accent, 0.22)} 0%, ${accent} 100%)`;
    style['--lg2-icontile-fg'] = onAccent(accent);
    style['--lg2-icontile-edge'] = 'rgba(255, 255, 255, 0.18)';
    style['--lg2-icontile-inner'] = 'inset 0 1px 0 rgba(255, 255, 255, 0.4)';
    style['--lg2-icontile-glow'] = `0 3px 8px rgba(${r}, ${g}, ${b}, 0.35)`;
  }

  const fpsCls = th.fps
    ? (th.fpsNoNestedBlur ? ' lg2-fps-nonest' : '') +
      (th.fpsContentVis ? ' lg2-fps-cv' : '') +
      (th.fpsContain ? ' lg2-fps-contain' : '') +
      (th.fpsNoSpecular ? ' lg2-fps-nospec' : '')
    : '';
  const cls =
    `lg2-demo${th.lite ? ' lg2-lite' : ''}` +
    (th.scheme !== 'auto' ? ` lg2-scheme-${th.scheme}` : '') +
    (th.navTile ? '' : ' lg2-nav-plain') +
    (th.liquid && !th.lite ? ' lg2-liquid' : '') +
    (th.navRail ? ' lg2-nav-rail' : '') +
    (th.iconTiles ? ' lg2-icons-tile' : '') +
    fpsCls;
  return { style, cls };
}
