// @vitest-environment jsdom
/**
 * PNG view export (building-model-editor Phase 5). Covers the pure
 * serialisation step: underlay `<image>` layers are stripped by default,
 * kept on request, and the output is a self-contained SVG with xmlns, an
 * explicit size and an opaque background.
 */

import { describe, expect, it } from 'vitest';

import { serializeSvgForExport } from '../../src/plugin/dashboard/spa/svgExport.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

function sampleSvg(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  const img = document.createElementNS(SVG_NS, 'image');
  img.setAttribute('href', '/api/building/underlays/abc/image');
  const poly = document.createElementNS(SVG_NS, 'polygon');
  poly.setAttribute('points', '0,0 10,0 10,10');
  svg.appendChild(img);
  svg.appendChild(poly);
  return svg as SVGSVGElement;
}

describe('serializeSvgForExport', () => {
  it('strips underlay <image> layers by default and keeps vector content', () => {
    const out = serializeSvgForExport(sampleSvg(), { width: 800, height: 600 });
    expect(out).not.toContain('<image');
    expect(out).toContain('<polygon');
    expect(out).toContain(`xmlns="${SVG_NS}"`);
    expect(out).toContain('width="800"');
    expect(out).toContain('height="600"');
    // Opaque background rect inserted.
    expect(out).toContain('<rect');
  });

  it('keeps underlays when includeUnderlays is true', () => {
    const out = serializeSvgForExport(sampleSvg(), { width: 800, height: 600, includeUnderlays: true });
    expect(out).toContain('<image');
  });

  it('does not mutate the live SVG element (works on a clone)', () => {
    const svg = sampleSvg();
    serializeSvgForExport(svg, { width: 100, height: 100 });
    // The original still has its <image> and no injected background rect.
    expect(svg.querySelectorAll('image')).toHaveLength(1);
    expect(svg.querySelector('rect')).toBeNull();
  });

  it('adds a fallback viewBox when none is present', () => {
    const out = serializeSvgForExport(sampleSvg(), { width: 320, height: 240 });
    expect(out).toContain('viewBox="0 0 320 240"');
  });
});
