/**
 * PNG view export (building-model-editor Phase 5). Rasterises an on-screen SVG
 * (the floor-plan canvas or the 3D twin) to a PNG the user can download.
 *
 * Split into a PURE, unit-testable serialisation step and a browser-only
 * rasterisation step:
 *   - {@link serializeSvgForExport} clones the SVG, strips underlay `<image>`
 *     layers BY DEFAULT (privacy + avoids canvas cross-origin tainting), pins an
 *     explicit size/viewBox + xmlns, and paints an opaque background. No canvas,
 *     no network — runs in jsdom.
 *   - {@link rasterizeSvgToPng} draws the serialised SVG onto a 2× canvas and
 *     returns a PNG blob (browser only).
 *   - {@link downloadBlob} triggers a client download.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

export interface SvgExportOptions {
  /** Output width in CSS px (before {@link scale}). */
  width: number;
  /** Output height in CSS px (before {@link scale}). */
  height: number;
  /**
   * Keep underlay `<image>` layers. Default `false`: they are removed so the
   * export never leaks a source floor-plan/scan and never taints the canvas.
   */
  includeUnderlays?: boolean;
  /** Opaque background colour (default matches the dark app surface). */
  background?: string;
}

/**
 * Serialise an SVG element into a standalone, self-contained SVG string. Clones
 * the node so the live DOM is untouched. Pure (DOM only) → testable in jsdom.
 */
export function serializeSvgForExport(svg: SVGSVGElement, opts: SvgExportOptions): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', SVG_NS);
  clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
  clone.setAttribute('width', String(opts.width));
  clone.setAttribute('height', String(opts.height));
  if (!clone.hasAttribute('viewBox')) {
    clone.setAttribute('viewBox', `0 0 ${opts.width} ${opts.height}`);
  }
  if (opts.includeUnderlays !== true) {
    clone.querySelectorAll('image').forEach((n) => n.remove());
  }
  // Opaque background first so the PNG is not transparent.
  const rect = (clone.ownerDocument ?? document).createElementNS(SVG_NS, 'rect');
  rect.setAttribute('x', '0');
  rect.setAttribute('y', '0');
  rect.setAttribute('width', '100%');
  rect.setAttribute('height', '100%');
  rect.setAttribute('fill', opts.background ?? '#05070d');
  clone.insertBefore(rect, clone.firstChild);
  return new XMLSerializer().serializeToString(clone);
}

/** Rasterise a serialised SVG string into a PNG blob (browser only). */
export async function rasterizeSvgToPng(
  svgString: string,
  opts: { width: number; height: number; scale?: number },
): Promise<Blob> {
  const scale = opts.scale ?? 2;
  const svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);
  try {
    const img = new Image();
    img.width = opts.width;
    img.height = opts.height;
    await new Promise<void>((resolve, reject) => {
      img.onload = (): void => resolve();
      img.onerror = (): void => reject(new Error('svg image load failed'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(opts.width * scale));
    canvas.height = Math.max(1, Math.round(opts.height * scale));
    const ctx = canvas.getContext('2d');
    if (ctx === null) throw new Error('no 2d context');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const out = await new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'));
    if (out === null) throw new Error('toBlob failed');
    return out;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Trigger a client-side download of a blob under `filename`. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * Convenience: serialise + rasterise + download an SVG element as a PNG.
 * Best-effort; the caller surfaces any rejection.
 */
export async function exportSvgAsPng(
  svg: SVGSVGElement,
  filename: string,
  opts: SvgExportOptions & { scale?: number },
): Promise<void> {
  const str = serializeSvgForExport(svg, opts);
  const png = await rasterizeSvgToPng(str, { width: opts.width, height: opts.height, scale: opts.scale ?? 2 });
  downloadBlob(png, filename);
}
