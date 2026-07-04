/**
 * Heat Shield — "Liquid Glass V2" appearance configurator (ui-v2-release, Task 2).
 *
 * The global Appearance panel (`.lg2-cfg`): presets (built-in + custom, with
 * save/delete), accent, glass style, background/frame fills, radius, blur,
 * saturation, opacity, contour, elevation, spacing and toggles. Extracted
 * verbatim from `liquidGlass2Overview.tsx`; it mutates the shared `theme`
 * signal from `lg2Theme.ts`, so changes apply globally across every v2 page.
 *
 * The panel itself uses a SOLID surface + fixed text colours (see the `.lg2-cfg`
 * rules in liquid-glass2.css) so it stays legible regardless of the theme.
 */

import { h, Fragment, type JSX } from 'preact';
import { useState } from 'preact/hooks';

import { t } from '../../../i18n.js';
import { Seg } from './lg2Primitives.js';
import {
  ACCENTS,
  DEFAULT_PALETTE,
  LG2_IMAGES,
  applyCustomPreset,
  applyPreset,
  customPresets,
  deleteCustomPreset,
  exportThemeJson,
  importThemeJson,
  PRESETS,
  saveCurrentAsPreset,
  theme,
  tweak,
  updateCustomPreset,
  type Fill,
  type FillKind,
  type GlassKind,
  type Lg2Palette,
  type RadiusKind,
  type Scheme,
} from './lg2Theme.js';

/** One granular High-FPS sub-toggle row (label + switch + optional hint). */
function FpsRow(props: { label: string; hint?: string; on: boolean; set: (v: boolean) => void; testId: string }): JSX.Element {
  return (
    <div class="lg2-cfg__fpsrow">
      <div class="lg2-cfg__row">
        <span class="lg2-cfg__label" style={{ marginBottom: 0 }}>{props.label}</span>
        <button type="button" role="switch" aria-checked={props.on} class={`lg2-toggle${props.on ? ' lg2-toggle--on' : ''}`}
          data-testid={props.testId} onClick={(): void => props.set(!props.on)} />
      </div>
      {props.hint !== undefined && <p class="lg2-cfg__fpshint">{props.hint}</p>}
    </div>
  );
}

/** Reusable editor for a configurable Fill (colour / gradient / image / URL).
 *  `extras` adds transparency + blur sliders (used for the background). */
export function FillEditor(props: { fill: Fill; extras?: boolean; onChange: (patch: Partial<Fill>) => void }): JSX.Element {
  const f = props.fill;
  const set = props.onChange;
  return (
    <Fragment>
      <Seg<FillKind> value={f.kind} onChange={(v): void => set({ kind: v })}
        options={[['color', t('Farbe', 'Color')], ['gradient', t('Verlauf', 'Gradient')], ['image', t('Bild', 'Image')], ['url', t('URL', 'URL')]]} />
      {f.kind === 'color' && (
        <div class="lg2-cfg__row">
          <input type="color" value={f.color} onInput={(e): void => set({ color: (e.currentTarget as HTMLInputElement).value })} />
          <span class="lg2-cfg__val">{f.color}</span>
        </div>
      )}
      {f.kind === 'gradient' && (
        <Fragment>
          <div class="lg2-cfg__row">
            <input type="color" value={f.gradFrom} aria-label={t('Von', 'From')}
              onInput={(e): void => set({ gradFrom: (e.currentTarget as HTMLInputElement).value })} />
            <input type="color" value={f.gradTo} aria-label={t('Bis', 'To')}
              onInput={(e): void => set({ gradTo: (e.currentTarget as HTMLInputElement).value })} />
            <span class="lg2-cfg__val" style={{ flex: '1 1 auto', background: `linear-gradient(90deg, ${f.gradFrom}, ${f.gradTo})`, borderRadius: '6px', minHeight: '20px' }} />
          </div>
          <div class="lg2-cfg__row">
            <span class="lg2-cfg__label" style={{ marginBottom: 0 }}>{t('Winkel', 'Angle')}</span>
            <input type="range" min={0} max={360} step={5} value={f.gradAngle}
              onInput={(e): void => set({ gradAngle: Number((e.currentTarget as HTMLInputElement).value) })} />
            <span class="lg2-cfg__val">{f.gradAngle}°</span>
          </div>
        </Fragment>
      )}
      {f.kind === 'image' && (
        <div class="lg2-cfg__row">
          <select class="lg2-cfg__select" value={f.image}
            onChange={(e): void => set({ image: (e.currentTarget as HTMLSelectElement).value })}>
            {LG2_IMAGES.map((im) => (<option key={im.key} value={im.key}>{t(...im.label)}</option>))}
          </select>
        </div>
      )}
      {f.kind === 'url' && (
        <input type="text" placeholder="https://…/bild.jpg" value={f.url}
          onInput={(e): void => set({ url: (e.currentTarget as HTMLInputElement).value })} />
      )}
      {props.extras === true && (
        <Fragment>
          <div class="lg2-cfg__row">
            <span class="lg2-cfg__label" style={{ marginBottom: 0 }}>{t('Transparenz', 'Transparency')}</span>
            <input type="range" min={0} max={100} step={2} value={Math.round((1 - f.opacity) * 100)}
              onInput={(e): void => set({ opacity: 1 - Number((e.currentTarget as HTMLInputElement).value) / 100 })} />
            <span class="lg2-cfg__val">{Math.round((1 - f.opacity) * 100)} %</span>
          </div>
          <div class="lg2-cfg__row">
            <span class="lg2-cfg__label" style={{ marginBottom: 0 }}>{t('Unschärfe (Blur)', 'Blur')}</span>
            <input type="range" min={0} max={40} step={1} value={f.blur}
              onInput={(e): void => set({ blur: Number((e.currentTarget as HTMLInputElement).value) })} />
            <span class="lg2-cfg__val">{f.blur}px</span>
          </div>
        </Fragment>
      )}
    </Fragment>
  );
}

/** One palette colour row (label + swatch + hex). */
function PaletteRow(props: { label: string; value: string; onChange: (v: string) => void }): JSX.Element {
  return (
    <div class="lg2-cfg__row">
      <span class="lg2-cfg__label" style={{ marginBottom: 0, flex: '1 1 auto' }}>{props.label}</span>
      <input type="color" value={props.value} aria-label={props.label}
        onInput={(e): void => props.onChange((e.currentTarget as HTMLInputElement).value)} />
      <span class="lg2-cfg__val">{props.value}</span>
    </div>
  );
}

export function ConfigPanel(props: { onClose: () => void }): JSX.Element {
  const th = theme.value;
  const [presetName, setPresetName] = useState('');
  const [importText, setImportText] = useState('');
  const [ioMsg, setIoMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const activeCustom = th.preset.startsWith('custom-')
    ? customPresets.value.find((p) => p.id === th.preset) ?? null
    : null;

  const setPalette = (patch: Partial<Lg2Palette>): void =>
    tweak({ palette: { ...theme.value.palette, ...patch } });

  const doExport = (): void => {
    const json = exportThemeJson();
    try {
      void navigator.clipboard?.writeText(json);
    } catch { /* ignore */ }
    try {
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'heatshield-theme.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { /* ignore */ }
    setIoMsg({ ok: true, text: t('Kopiert & heruntergeladen.', 'Copied & downloaded.') });
  };
  const doImport = (): void => {
    const res = importThemeJson(importText);
    if (res.ok) {
      setImportText('');
      setIoMsg({ ok: true, text: t('Theme importiert.', 'Theme imported.') });
    } else {
      setIoMsg({ ok: false, text: t('Ungültiges Theme-JSON.', 'Invalid theme JSON.') });
    }
  };
  return (
    <Fragment>
      <div class="lg2-cfg-scrim" onClick={props.onClose} />
      <aside class="lg2-cfg" role="dialog" aria-label={t('Darstellung', 'Appearance')} data-testid="lg2-config">
        <div class="lg2-cfg__head">
          <h3>{t('Darstellung', 'Appearance')}</h3>
          <button type="button" class="lg2-cfg__close" aria-label={t('Schließen', 'Close')} onClick={props.onClose}>×</button>
        </div>

        <h4 class="lg2-cfg__section">{t('Vorlagen', 'Presets')}</h4>
        <div class="lg2-cfg__group">
          <span class="lg2-cfg__label">{t('Vorlagen', 'Presets')}</span>
          <div class="lg2-presets">
            {PRESETS.map((p) => (
              <button key={p.id} type="button" class={`lg2-preset${th.preset === p.id ? ' lg2-preset--on' : ''}`}
                onClick={(): void => applyPreset(p.id)}>{t(...p.label)}</button>
            ))}
            {customPresets.value.map((p) => (
              <span key={p.id} class="lg2-preset-wrap">
                <button type="button" class={`lg2-preset${th.preset === p.id ? ' lg2-preset--on' : ''}`}
                  onClick={(): void => applyCustomPreset(p.id)}>{p.name}</button>
                <button type="button" class="lg2-preset-del" aria-label={t('Preset löschen', 'Delete preset')}
                  title={t('Preset löschen', 'Delete preset')}
                  onClick={(): void => deleteCustomPreset(p.id)}>×</button>
              </span>
            ))}
          </div>
          {activeCustom !== null && (
            <div class="lg2-cfg__row lg2-preset-save">
              <span class="lg2-cfg__label" style={{ marginBottom: 0, flex: '1 1 auto' }}>
                {t('Änderungen an', 'Changes to')} „{activeCustom.name}"
              </span>
              <button type="button" class="lg2-cfg-savebtn" data-testid="lg2-cfg-oversave"
                onClick={(): void => updateCustomPreset(activeCustom.id)}>
                {t('Überspeichern', 'Overwrite')}
              </button>
            </div>
          )}
          <div class="lg2-cfg__row lg2-preset-save">
            <input type="text" maxLength={24} placeholder={t('Eigenes Preset benennen …', 'Name your preset …')}
              value={presetName} onInput={(e): void => setPresetName((e.currentTarget as HTMLInputElement).value)} />
            <button type="button" class="lg2-cfg-savebtn" disabled={presetName.trim() === ''}
              onClick={(): void => { saveCurrentAsPreset(presetName); setPresetName(''); }}>
              {t('Speichern', 'Save')}
            </button>
          </div>
        </div>

        <h4 class="lg2-cfg__section">{t('Farbe & Schema', 'Colour & scheme')}</h4>
        <div class="lg2-cfg__group">
          <span class="lg2-cfg__label">{t('Akzentfarbe', 'Accent colour')}</span>
          <div class="lg2-cfg__row">
            <div class="lg2-swatches">
              <button type="button" class={`lg2-swatch lg2-swatch--auto${th.accentAuto ? ' lg2-swatch--on' : ''}`}
                aria-label={t('Auto (nach Wetter)', 'Auto (by weather)')} title={t('Auto (nach Wetter)', 'Auto (by weather)')}
                onClick={(): void => tweak({ accentAuto: true })}>A</button>
              {ACCENTS.map((c) => (
                <button key={c} type="button" class={`lg2-swatch${!th.accentAuto && th.accent.toLowerCase() === c ? ' lg2-swatch--on' : ''}`}
                  style={{ background: c }} aria-label={c} onClick={(): void => tweak({ accent: c, accentAuto: false })} />
              ))}
            </div>
            <input type="color" value={th.accent} onInput={(e): void => tweak({ accent: (e.currentTarget as HTMLInputElement).value, accentAuto: false })} />
          </div>
        </div>

        <div class="lg2-cfg__group">
          <span class="lg2-cfg__label">{t('Glas-Stil', 'Glass style')}</span>
          <Seg<GlassKind> value={th.glass} onChange={(v): void => tweak({ glass: v })}
            options={[['frost', t('Frost (hell)', 'Frost (light)')], ['graphite', t('Graphit (dunkel)', 'Graphite (dark)')]]} />
        </div>

        <div class="lg2-cfg__group">
          <span class="lg2-cfg__label">{t('Farbpalette (Status)', 'Colour palette (status)')}</span>
          <PaletteRow label={t('Gering / OK', 'Low / OK')} value={th.palette.success}
            onChange={(v): void => setPalette({ success: v })} />
          <PaletteRow label={t('Warnung', 'Warning')} value={th.palette.warning}
            onChange={(v): void => setPalette({ warning: v })} />
          <PaletteRow label={t('Hoch / Gefahr', 'High / Danger')} value={th.palette.danger}
            onChange={(v): void => setPalette({ danger: v })} />
          <PaletteRow label={t('Info / Prognose', 'Info / Forecast')} value={th.palette.info}
            onChange={(v): void => setPalette({ info: v })} />
          <button type="button" class="lg2-cfg__reset" style={{ marginTop: '6px' }}
            data-testid="lg2-cfg-palette-reset"
            onClick={(): void => tweak({ palette: { ...DEFAULT_PALETTE } })}>
            {t('Palette zurücksetzen', 'Reset palette')}
          </button>
        </div>

        <h4 class="lg2-cfg__section">{t('Hintergrund', 'Background')}</h4>
        <div class="lg2-cfg__group">
          <span class="lg2-cfg__label">{t('Hintergrund', 'Background')}</span>
          <FillEditor fill={th.background} extras
            onChange={(patch): void => tweak({ background: { ...theme.value.background, ...patch } })} />
        </div>

        <h4 class="lg2-cfg__section">{t('Glas, Form & Abstände', 'Glass, shape & spacing')}</h4>
        <div class="lg2-cfg__group">
          <span class="lg2-cfg__label">{t('Ecken-Radius', 'Corner radius')}</span>
          <Seg<RadiusKind> value={th.radius} onChange={(v): void => tweak({ radius: v })}
            options={[['sharp', t('Eckig', 'Sharp')], ['std', t('Standard', 'Standard')], ['round', t('Rund', 'Round')]]} />
        </div>

        <div class="lg2-cfg__group">
          <span class="lg2-cfg__label">{t('Blur-Stärke', 'Blur strength')}</span>
          <div class="lg2-cfg__row">
            <input type="range" min={0} max={40} step={2} value={th.blur} disabled={th.lite}
              onInput={(e): void => tweak({ blur: Number((e.currentTarget as HTMLInputElement).value) })} />
            <span class="lg2-cfg__val">{th.lite ? t('aus (Lite)', 'off (Lite)') : `${th.blur}px`}</span>
          </div>
        </div>

        <div class="lg2-cfg__group">
          <span class="lg2-cfg__label">{t('Sättigung', 'Saturation')}</span>
          <div class="lg2-cfg__row">
            <input type="range" min={100} max={200} step={5} value={th.sat}
              onInput={(e): void => tweak({ sat: Number((e.currentTarget as HTMLInputElement).value) })} />
            <span class="lg2-cfg__val">{th.sat} %</span>
          </div>
        </div>

        <div class="lg2-cfg__group">
          <span class="lg2-cfg__label">{t('Glas-Deckkraft', 'Glass opacity')}</span>
          <div class="lg2-cfg__row">
            <input type="range" min={0} max={85} step={2} value={Math.round(th.alpha * 100)}
              onInput={(e): void => tweak({ alpha: Number((e.currentTarget as HTMLInputElement).value) / 100 })} />
            <span class="lg2-cfg__val">{Math.round(th.alpha * 100)} %</span>
          </div>
        </div>

        <div class="lg2-cfg__group">
          <span class="lg2-cfg__label">{t('Kontur-Stärke', 'Contour')}</span>
          <div class="lg2-cfg__row">
            <input type="range" min={0} max={100} step={5} value={Math.round(th.contour * 100)}
              onInput={(e): void => tweak({ contour: Number((e.currentTarget as HTMLInputElement).value) / 100 })} />
            <span class="lg2-cfg__val">{Math.round(th.contour * 100)} %</span>
          </div>
        </div>

        <div class="lg2-cfg__group">
          <span class="lg2-cfg__label">{t('Schatten-Tiefe', 'Shadow depth')}</span>
          <div class="lg2-cfg__row">
            <input type="range" min={0} max={100} step={5} value={Math.round(th.elevation * 100)}
              onInput={(e): void => tweak({ elevation: Number((e.currentTarget as HTMLInputElement).value) / 100 })} />
            <span class="lg2-cfg__val">{Math.round(th.elevation * 100)} %</span>
          </div>
        </div>

        <div class="lg2-cfg__group">
          <span class="lg2-cfg__label">{t('Kachel-Abstand', 'Tile spacing')}</span>
          <div class="lg2-cfg__row">
            <input type="range" min={8} max={28} step={1} value={th.gap}
              onInput={(e): void => tweak({ gap: Number((e.currentTarget as HTMLInputElement).value) })} />
            <span class="lg2-cfg__val">{th.gap}px</span>
          </div>
        </div>

        <div class="lg2-cfg__group">
          <div class="lg2-cfg__row">
            <span class="lg2-cfg__label" style={{ marginBottom: 0 }}>{t('Glanz (Sheen)', 'Sheen')}</span>
            <button type="button" role="switch" aria-checked={th.sheen} class={`lg2-toggle${th.sheen ? ' lg2-toggle--on' : ''}`}
              onClick={(): void => tweak({ sheen: !th.sheen })} />
          </div>
        </div>

        <h4 class="lg2-cfg__section">{t('Symbole', 'Icons')}</h4>
        <div class="lg2-cfg__group">
          <div class="lg2-cfg__row">
            <span class="lg2-cfg__label" style={{ marginBottom: 0 }}>{t('Symbol-Kacheln', 'Icon tiles')}</span>
            <button type="button" role="switch" aria-checked={th.iconTiles} class={`lg2-toggle${th.iconTiles ? ' lg2-toggle--on' : ''}`}
              data-testid="lg2-cfg-icontiles"
              onClick={(): void => tweak({ iconTiles: !th.iconTiles })} />
          </div>
          <p class="lg2-cfg__label" style={{ marginTop: '-2px' }}>
            {t('Alle Symbole auf einer neutralen Verlaufs-Kachel („App-Icon"-Look). Aus = normale Symbole.',
              'All glyphs on a neutral gradient tile ("app icon" look). Off = normal symbols.')}
          </p>
          {th.iconTiles && (
            <Fragment>
              <div class="lg2-cfg__row">
                <span class="lg2-cfg__label" style={{ marginBottom: 0 }}>{t('Verlauf in Akzentfarbe', 'Gradient in accent colour')}</span>
                <button type="button" role="switch" aria-checked={th.iconTilesAccent} class={`lg2-toggle${th.iconTilesAccent ? ' lg2-toggle--on' : ''}`}
                  data-testid="lg2-cfg-icontiles-accent"
                  onClick={(): void => tweak({ iconTilesAccent: !th.iconTilesAccent })} />
              </div>
              <div class="lg2-cfg__row">
                <span class="lg2-cfg__label" style={{ marginBottom: 0 }}>{t('Symbol-Schatten', 'Icon shadow')}</span>
                <button type="button" role="switch" aria-checked={th.iconGlyphShadow} class={`lg2-toggle${th.iconGlyphShadow ? ' lg2-toggle--on' : ''}`}
                  data-testid="lg2-cfg-iconshadow"
                  onClick={(): void => tweak({ iconGlyphShadow: !th.iconGlyphShadow })} />
              </div>
            </Fragment>
          )}
        </div>

        <h4 class="lg2-cfg__section">{t('Navigation & Rahmen', 'Navigation & frame')}</h4>
        <div class="lg2-cfg__group">
          <div class="lg2-cfg__row">
            <span class="lg2-cfg__label" style={{ marginBottom: 0 }}>{t('Navigation als Kachel', 'Nav as tile')}</span>
            <button type="button" role="switch" aria-checked={th.navTile} class={`lg2-toggle${th.navTile ? ' lg2-toggle--on' : ''}`}
              onClick={(): void => tweak({ navTile: !th.navTile })} />
          </div>
        </div>

        <div class="lg2-cfg__group">
          <div class="lg2-cfg__row">
            <span class="lg2-cfg__label" style={{ marginBottom: 0 }}>{t('Kompakte Icon-Leiste', 'Compact icon rail')}</span>
            <button type="button" role="switch" aria-checked={th.navRail} class={`lg2-toggle${th.navRail ? ' lg2-toggle--on' : ''}`}
              onClick={(): void => tweak({ navRail: !th.navRail })} />
          </div>
        </div>

        <div class="lg2-cfg__group lg2-cfg__group--frame">
          <span class="lg2-cfg__label">{t('Rand (außen)', 'Frame (outer)')}</span>
          <div class="lg2-cfg__row">
            <span class="lg2-cfg__label" style={{ marginBottom: 0 }}>{t('Wie Hintergrund (Auto)', 'Match background (Auto)')}</span>
            <button type="button" role="switch" aria-checked={th.frameAuto} class={`lg2-toggle${th.frameAuto ? ' lg2-toggle--on' : ''}`}
              onClick={(): void => tweak({ frameAuto: !th.frameAuto })} />
          </div>
          {!th.frameAuto && (
            <FillEditor fill={th.frame}
              onChange={(patch): void => tweak({ frame: { ...theme.value.frame, ...patch } })} />
          )}
          <div class="lg2-cfg__row">
            <span class="lg2-cfg__label" style={{ marginBottom: 0 }}>{t('Abdunklung', 'Darken')}</span>
            <input type="range" min={0} max={100} step={5} value={th.frameDarken}
              onInput={(e): void => tweak({ frameDarken: Number((e.currentTarget as HTMLInputElement).value) })} />
            <span class="lg2-cfg__val">{th.frameDarken} %</span>
          </div>
          <div class="lg2-cfg__row">
            <span class="lg2-cfg__label" style={{ marginBottom: 0 }}>{t('Schlagschatten (Main)', 'Drop shadow (main)')}</span>
            <button type="button" role="switch" aria-checked={th.frameShadow} class={`lg2-toggle${th.frameShadow ? ' lg2-toggle--on' : ''}`}
              onClick={(): void => tweak({ frameShadow: !th.frameShadow })} />
          </div>
        </div>

        <div class="lg2-cfg__group">
          <span class="lg2-cfg__label">{t('Hover-Farbe', 'Hover colour')}</span>
          <div class="lg2-cfg__row">
            <button type="button" class={`lg2-preset${th.hover === 'auto' ? ' lg2-preset--on' : ''}`} onClick={(): void => tweak({ hover: 'auto' })}>{t('Auto', 'Auto')}</button>
            <input type="color" value={th.hover === 'auto' ? '#8899bb' : th.hover} onInput={(e): void => tweak({ hover: (e.currentTarget as HTMLInputElement).value })} />
          </div>
        </div>

        <div class="lg2-cfg__group">
          <div class="lg2-cfg__row">
            <span class="lg2-cfg__label" style={{ marginBottom: 0 }}>{t('Glaskante (Bevel)', 'Glass bevel')}</span>
            <button type="button" role="switch" aria-checked={th.bevel} class={`lg2-toggle${th.bevel ? ' lg2-toggle--on' : ''}`}
              onClick={(): void => tweak({ bevel: !th.bevel })} />
          </div>
          <div class="lg2-cfg__row">
            <span class="lg2-cfg__label" style={{ marginBottom: 0 }}>{t('Liquid Glass (Refraktion)', 'Liquid Glass (refraction)')}</span>
            <button type="button" role="switch" aria-checked={th.liquid} class={`lg2-toggle${th.liquid ? ' lg2-toggle--on' : ''}`}
              data-testid="lg2-cfg-liquid"
              onClick={(): void => tweak({ liquid: !th.liquid })} />
          </div>
          <p class="lg2-cfg__label" style={{ marginTop: '-2px' }}>
            {t('Bricht das Wallpaper wie eine echte Glasplatte (geringe Deckkraft empfohlen).',
              'Refracts the wallpaper like a real glass plate (low opacity recommended).')}
          </p>
        </div>

        <h4 class="lg2-cfg__section">{t('Performance', 'Performance')}</h4>
        <div class="lg2-cfg__group">
          <div class="lg2-cfg__row">
            <span class="lg2-cfg__label" style={{ marginBottom: 0 }}>{t('Lite-Modus (kein Blur)', 'Lite mode (no blur)')}</span>
            <button type="button" role="switch" aria-checked={th.lite} class={`lg2-toggle${th.lite ? ' lg2-toggle--on' : ''}`}
              onClick={(): void => tweak({ lite: !th.lite })} />
          </div>
        </div>

        <div class="lg2-cfg__group">
          <div class="lg2-cfg__row">
            <span class="lg2-cfg__label" style={{ marginBottom: 0 }}>{t('Statisches Glas (Performance)', 'Static glass (performance)')}</span>
            <button type="button" role="switch" aria-checked={th.preblur} class={`lg2-toggle${th.preblur ? ' lg2-toggle--on' : ''}`}
              data-testid="lg2-cfg-preblur"
              onClick={(): void => tweak({ preblur: !th.preblur })} />
          </div>
          <p class="lg2-cfg__label" style={{ marginTop: '-2px' }}>
            {t('Blurrt das Wallpaper einmal vor, statt live pro Karte — deutlich flüssigeres Scrollen bei nahezu gleicher Optik.',
              'Pre-blurs the wallpaper once instead of live per card — much smoother scrolling at nearly identical looks.')}
          </p>
        </div>

        <div class="lg2-cfg__group">
          <div class="lg2-cfg__row">
            <span class="lg2-cfg__label" style={{ marginBottom: 0 }}>{t('High FPS Mode', 'High FPS mode')}</span>
            <button type="button" role="switch" aria-checked={th.fps} class={`lg2-toggle${th.fps ? ' lg2-toggle--on' : ''}`}
              data-testid="lg2-cfg-fps"
              onClick={(): void => tweak({ fps: !th.fps })} />
          </div>
          <p class="lg2-cfg__label" style={{ marginTop: '-2px' }}>
            {t('Bündel an Performance-Optimierungen bei (nahezu) gleicher Optik. Jede einzeln schaltbar.',
              'A bundle of performance optimizations at (nearly) identical looks. Each individually switchable.')}
          </p>
          {th.fps && (
            <div class="lg2-cfg__fpsgroup">
              <FpsRow testId="lg2-cfg-fps-nonest" on={th.fpsNoNestedBlur} set={(v): void => tweak({ fpsNoNestedBlur: v })}
                label={t('Doppel-Blur vermeiden', 'Avoid nested blur')}
                hint={t('Kein zweiter Blur auf Chips/Buttons, die schon auf gefrostetem Glas liegen.', 'No second blur on chips/buttons already sitting on frosted glass.')} />
              <FpsRow testId="lg2-cfg-fps-cv" on={th.fpsContentVis} set={(v): void => tweak({ fpsContentVis: v })}
                label={t('Off-Screen-Listen auslassen', 'Skip off-screen lists')}
                hint={t('Nicht sichtbare Listeneinträge werden nicht gezeichnet (content-visibility).', 'List rows that are off-screen are not painted (content-visibility).')} />
              <FpsRow testId="lg2-cfg-fps-contain" on={th.fpsContain} set={(v): void => tweak({ fpsContain: v })}
                label={t('Karten-Neuberechnung isolieren', 'Isolate card recalc')}
                hint={t('Live-Updates einer Karte lösen kein Re-Layout der Nachbarn aus (contain).', 'A card update no longer re-lays-out its neighbours (contain).')} />
              <FpsRow testId="lg2-cfg-fps-pause" on={th.fpsPauseHidden} set={(v): void => tweak({ fpsPauseHidden: v })}
                label={t('Animationen im Hintergrund pausieren', 'Pause animations when hidden')}
                hint={t('CSS-Animationen stoppen, wenn der Tab nicht sichtbar ist.', 'CSS animations stop while the tab is not visible.')} />
              <FpsRow testId="lg2-cfg-fps-bevel" on={th.fpsLiteBevel} set={(v): void => tweak({ fpsLiteBevel: v })}
                label={t('Leichtere Glaskante', 'Lighter glass bevel')}
                hint={t('Karten-Kante mit 2 statt 4 Schatten-Ebenen.', 'Card edge with 2 instead of 4 shadow layers.')} />
              <FpsRow testId="lg2-cfg-fps-nospec" on={th.fpsNoSpecular} set={(v): void => tweak({ fpsNoSpecular: v })}
                label={t('Specular-Kante weglassen', 'Drop specular rim')}
                hint={t('Verzichtet auf die aufwändige Licht-Maske an der Kartenoberkante.', 'Drops the costly light mask on the card top edge.')} />
            </div>
          )}
        </div>

        <h4 class="lg2-cfg__section">{t('Anzeige', 'Display')}</h4>
        <div class="lg2-cfg__group">
          <span class="lg2-cfg__label">{t('Erscheinungsbild', 'Scheme')}</span>
          <Seg<Scheme> value={th.scheme} onChange={(v): void => tweak({ scheme: v })}
            options={[['auto', t('Auto', 'Auto')], ['light', t('Hell', 'Light')], ['dark', t('Dunkel', 'Dark')]]} />
        </div>

        <h4 class="lg2-cfg__section">{t('Import / Export', 'Import / export')}</h4>
        <div class="lg2-cfg__group">
          <p class="lg2-cfg__label" style={{ marginBottom: '6px' }}>
            {t('Aktuelles Theme als JSON sichern oder ein Theme einfügen und anwenden.',
              'Save the current theme as JSON, or paste a theme to apply it.')}
          </p>
          <div class="lg2-cfg__row">
            <button type="button" class="lg2-cfg-savebtn" data-testid="lg2-cfg-export" onClick={doExport}>
              {t('Exportieren', 'Export')}
            </button>
          </div>
          <textarea class="lg2-cfg__io" rows={4} data-testid="lg2-cfg-import-text"
            placeholder={t('Theme-JSON hier einfügen …', 'Paste theme JSON here …')}
            value={importText} onInput={(e): void => setImportText((e.currentTarget as HTMLTextAreaElement).value)} />
          <div class="lg2-cfg__row">
            <button type="button" class="lg2-cfg-savebtn" data-testid="lg2-cfg-import"
              disabled={importText.trim() === ''} onClick={doImport}>
              {t('Importieren & anwenden', 'Import & apply')}
            </button>
          </div>
          {ioMsg !== null && (
            <p class={`lg2-cfg__iomsg${ioMsg.ok ? '' : ' lg2-cfg__iomsg--err'}`}>{ioMsg.text}</p>
          )}
        </div>

        <button type="button" class="lg2-cfg__reset" onClick={(): void => applyPreset('glass')}>
          {t('Zurücksetzen', 'Reset')}
        </button>
      </aside>
    </Fragment>
  );
}
