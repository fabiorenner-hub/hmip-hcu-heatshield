/**
 * Minimal dependency-free PDF writer (thermal-load-engine report export).
 *
 * Emits a valid multi-page PDF 1.4 using the base-14 Helvetica / Helvetica-Bold
 * fonts with WinAnsiEncoding (so German umlauts + ° render). No external
 * library, no CDN, no font embedding — keeps the LOCAL/small-bundle constraint.
 * Pure: takes a title + typed lines, returns the PDF bytes. Non-normative
 * content only (the caller passes the estimate text + disclaimer).
 */

export interface PdfLine {
  text: string;
  bold?: boolean;
  /** Extra vertical gap before this line, in multiples of the line height. */
  gapBefore?: number;
}

const PAGE_W = 595; // A4 @ 72 dpi
const PAGE_H = 842;
const MARGIN = 50;
const LEADING = 14;
const BODY_SIZE = 10;
const BOLD_SIZE = 11;
const LINES_PER_PAGE = Math.floor((PAGE_H - 2 * MARGIN) / LEADING);

/** Escape a string for a PDF literal and drop non-WinAnsi (>0xFF) chars. */
function pdfEscape(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 32;
    if (code > 0xff) { out += '?'; continue; }
    if (ch === '(' || ch === ')' || ch === '\\') out += `\\${ch}`;
    else out += ch;
  }
  return out;
}

/** One page's content stream from a slice of lines. */
function contentStream(lines: PdfLine[]): string {
  const parts: string[] = ['BT', `${MARGIN} ${PAGE_H - MARGIN} Td`, `${LEADING} TL`];
  let first = true;
  for (const ln of lines) {
    const gap = ln.gapBefore ?? 0;
    for (let g = 0; g < gap; g += 1) parts.push('T*');
    const font = ln.bold === true ? '/F2' : '/F1';
    const size = ln.bold === true ? BOLD_SIZE : BODY_SIZE;
    parts.push(`${font} ${size} Tf`);
    // First line: no leading advance; subsequent: T* moves down one line.
    if (!first) parts.push('T*');
    parts.push(`(${pdfEscape(ln.text)}) Tj`);
    first = false;
  }
  parts.push('ET');
  return parts.join('\n');
}

/** Build a PDF document from a title + body lines. Returns the raw bytes. */
export function buildPdfReport(title: string, body: PdfLine[]): Uint8Array {
  const all: PdfLine[] = [{ text: title, bold: true }, ...body];
  // Paginate.
  const pages: PdfLine[][] = [];
  for (let i = 0; i < all.length; i += LINES_PER_PAGE) pages.push(all.slice(i, i + LINES_PER_PAGE));
  if (pages.length === 0) pages.push([{ text: title, bold: true }]);

  // Object numbering: 1 Catalog, 2 Pages, 3 Font, 4 FontBold, then per page
  // (content, page). Page objects collected for the Pages /Kids array.
  const objects: string[] = [];
  const pageObjNums: number[] = [];
  const firstPageObj = 5;
  for (let p = 0; p < pages.length; p += 1) pageObjNums.push(firstPageObj + p * 2 + 1);

  objects[1] = '<</Type /Catalog /Pages 2 0 R>>';
  objects[2] = `<</Type /Pages /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${pages.length}>>`;
  objects[3] = '<</Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding>>';
  objects[4] = '<</Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding>>';

  for (let p = 0; p < pages.length; p += 1) {
    const contentNum = firstPageObj + p * 2;
    const pageNum = pageObjNums[p] as number;
    const stream = contentStream(pages[p] as PdfLine[]);
    objects[contentNum] = `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`;
    objects[pageNum] =
      `<</Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
      `/Resources <</Font <</F1 3 0 R /F2 4 0 R>>>> /Contents ${contentNum} 0 R>>`;
  }

  // Serialise with a byte-accurate xref (Latin-1: 1 char = 1 byte).
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  const maxObj = objects.length - 1;
  for (let n = 1; n <= maxObj; n += 1) {
    const body = objects[n];
    if (body === undefined) continue;
    offsets[n] = pdf.length;
    pdf += `${n} 0 obj\n${body}\nendobj\n`;
  }
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${maxObj + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (let n = 1; n <= maxObj; n += 1) {
    const off = offsets[n] ?? 0;
    pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<</Size ${maxObj + 1} /Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF`;

  // Encode as Latin-1 (WinAnsi) — every char is ≤ 0xFF after pdfEscape.
  const bytes = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i += 1) bytes[i] = pdf.charCodeAt(i) & 0xff;
  return bytes;
}
