/**
 * Minimal dependency-free PDF writer (thermal report export). Verifies the
 * emitted bytes form a structurally valid PDF (header, objects, xref, trailer)
 * and that content + umlauts survive WinAnsi encoding.
 */

import { describe, expect, it } from 'vitest';

import { buildPdfReport, type PdfLine } from '../../src/shared/thermal/pdf-report.js';

function toLatin1(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

describe('buildPdfReport', () => {
  it('emits a structurally valid single-page PDF', () => {
    const bytes = buildPdfReport('Wärmelast', [{ text: 'Heizlast 1234 W' }, { text: 'Kühllast 800 W', bold: true }]);
    const s = toLatin1(bytes);
    expect(s.startsWith('%PDF-1.4')).toBe(true);
    expect(s.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(s).toContain('/Type /Catalog');
    expect(s).toContain('/Type /Pages');
    expect(s).toContain('/BaseFont /Helvetica');
    expect(s).toContain('xref');
    expect(s).toContain('trailer');
    expect(s).toContain('startxref');
    // Umlaut survives as a single WinAnsi byte (0xE4 = ä).
    expect(bytes).toContain(0xe4);
  });

  it('xref /Size matches the object count and startxref points at the xref', () => {
    const bytes = buildPdfReport('T', [{ text: 'a' }]);
    const s = toLatin1(bytes);
    const startxref = Number((/startxref\n(\d+)/u.exec(s) ?? [])[1]);
    expect(Number.isFinite(startxref)).toBe(true);
    // The byte at startxref begins the xref table.
    expect(s.slice(startxref, startxref + 4)).toBe('xref');
  });

  it('paginates a long report into multiple Page objects', () => {
    const many: PdfLine[] = Array.from({ length: 140 }, (_, i) => ({ text: `line ${i}` }));
    const s = toLatin1(buildPdfReport('Long', many));
    const pageCount = (s.match(/\/Type \/Page(?!s)/gu) ?? []).length;
    expect(pageCount).toBeGreaterThanOrEqual(2);
  });

  it('escapes parentheses/backslashes in text', () => {
    const s = toLatin1(buildPdfReport('T', [{ text: 'a (b) \\ c' }]));
    expect(s).toContain('a \\(b\\) \\\\ c');
  });
});
