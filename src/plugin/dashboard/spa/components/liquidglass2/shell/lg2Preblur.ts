/**
 * Heat Shield — "Liquid Glass V2" pre-blurred wallpaper (performance option A).
 *
 * When the user enables "Statisches Glas", we blur the wallpaper ONCE on the
 * client (an offscreen <canvas>, GPU-accelerated) and hand the result back as a
 * data-URL. The CSS then paints that pre-blurred image behind the translucent
 * glass tint of each card via `background-attachment: fixed` — visually almost
 * identical to `backdrop-filter: blur(...)`, but WITHOUT the per-frame Gaussian
 * blur that makes long, glassy lists janky on weak GPUs (e.g. the HCU).
 *
 * Runs only while the option is on, and only regenerates when the wallpaper,
 * blur radius or scheme actually change. Fails gracefully: on any error (e.g. a
 * cross-origin custom image that taints the canvas) it returns `null`, and the
 * shell keeps the normal live-blur look — no broken state.
 */

import { useEffect, useState } from 'preact/hooks';

import type { Fill, Lg2Theme } from './lg2Theme.js';

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = (): void => resolve(img);
    img.onerror = (): void => reject(new Error('image load failed'));
    img.src = src;
  });
}

/**
 * Produce a small, pre-blurred JPEG data-URL of the wallpaper described by
 * `fill`. Downscaled (the blur hides the low resolution) so it stays tiny and
 * fast. Returns `null` when it cannot be produced.
 */
async function generateBlurredWallpaper(fill: Fill, blurPx: number): Promise<string | null> {
  if (typeof document === 'undefined') return null;
  const W = 640;
  const H = 400;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return null;

  try {
    if (fill.kind === 'image' || fill.kind === 'url') {
      const src = fill.kind === 'image' ? `/assets/lg2/${fill.image}.png` : fill.url.trim();
      if (src === '') return null;
      const img = await loadImage(src);
      const scale = Math.max(W / img.width, H / img.height);
      const dw = img.width * scale;
      const dh = img.height * scale;
      ctx.filter = `blur(${blurPx}px)`;
      ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
      ctx.filter = 'none';
    } else if (fill.kind === 'color') {
      ctx.fillStyle = fill.color;
      ctx.fillRect(0, 0, W, H);
    } else {
      // gradient
      const rad = (fill.gradAngle * Math.PI) / 180;
      const dx = Math.cos(rad);
      const dy = Math.sin(rad);
      const g = ctx.createLinearGradient(W / 2 - (dx * W) / 2, H / 2 - (dy * H) / 2, W / 2 + (dx * W) / 2, H / 2 + (dy * H) / 2);
      g.addColorStop(0, fill.gradFrom);
      g.addColorStop(1, fill.gradTo);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }
    return canvas.toDataURL('image/jpeg', 0.82);
  } catch {
    return null;
  }
}

/**
 * Reactive hook: returns the pre-blurred wallpaper data-URL while the `preblur`
 * option is on (and not in Lite mode, which already drops all blur), otherwise
 * `null`. Regenerates only when the relevant theme inputs change.
 */
export function usePreblurWallpaper(th: Lg2Theme): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const bg = th.background;
  const active = th.preblur && !th.lite;
  const key = [
    active,
    bg.kind,
    bg.image,
    bg.url,
    bg.gradFrom,
    bg.gradTo,
    bg.gradAngle,
    bg.color,
    th.blur,
  ].join('|');

  useEffect(() => {
    if (!active) {
      setUrl(null);
      return undefined;
    }
    let cancelled = false;
    // Canvas blur on a downscaled image reads stronger than the same px on a
    // full-size backdrop, so scale the radius down to match the live look.
    const blurPx = Math.max(6, Math.round((th.blur || 20) * 0.5));
    void generateBlurredWallpaper(bg, blurPx).then((u) => {
      if (!cancelled) setUrl(u);
    });
    return (): void => {
      cancelled = true;
    };
  }, [key]);

  return url;
}
