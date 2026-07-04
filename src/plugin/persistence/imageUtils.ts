/**
 * Heat Shield — image utilities for Building Studio underlays (BME-03).
 *
 * Pure Node Buffer parsing — no image library (keeps the plugin dependency-
 * light). Supports PNG + JPEG (the formats floor-plan scans/photos arrive in):
 *
 *   - {@link parseDataUrl}       — decode a `data:` URL into { mediaType, bytes }.
 *   - {@link imageDimensions}    — read intrinsic width/height from the header.
 *   - {@link stripImageMetadata} — drop non-essential metadata (EXIF, text,
 *     timestamps, comments) before persistence, keeping the pixels + the chunks
 *     needed to render correctly.
 *
 * No fs, no network, no logging.
 */

export interface DecodedDataUrl {
  mediaType: string;
  bytes: Buffer;
}

const ALLOWED_MEDIA = new Set(['image/png', 'image/jpeg']);

/** Whether a media type is an accepted underlay raster. */
export function isAllowedUnderlayMedia(mediaType: string): boolean {
  return ALLOWED_MEDIA.has(mediaType);
}

/** Decode a `data:<media>;base64,<payload>` URL. Returns null when malformed. */
export function parseDataUrl(dataUrl: string): DecodedDataUrl | null {
  const m = /^data:([a-z]+\/[a-z0-9.+-]+);base64,(.+)$/is.exec(dataUrl);
  if (m === null) return null;
  const mediaType = (m[1] ?? '').toLowerCase();
  try {
    const bytes = Buffer.from(m[2] ?? '', 'base64');
    if (bytes.length === 0) return null;
    return { mediaType, bytes };
  } catch {
    return null;
  }
}

export interface Dimensions {
  width: number;
  height: number;
}

function pngDimensions(b: Buffer): Dimensions | null {
  // 8-byte signature, then IHDR chunk: len(4) "IHDR"(4) width(4) height(4)…
  if (b.length < 24) return null;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i += 1) if (b[i] !== sig[i]) return null;
  if (b.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function jpegDimensions(b: Buffer): Dimensions | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let pos = 2;
  while (pos + 9 < b.length) {
    if (b[pos] !== 0xff) {
      pos += 1;
      continue;
    }
    const marker = b[pos + 1] as number;
    // Standalone markers without a length payload.
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      pos += 2;
      continue;
    }
    const segLen = b.readUInt16BE(pos + 2);
    // SOF0..SOF15 (baseline/progressive), excluding DHT(C4)/JPG(C8)/DAC(CC).
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      // Segment: len(2) precision(1) height(2) width(2)
      return { height: b.readUInt16BE(pos + 5), width: b.readUInt16BE(pos + 7) };
    }
    pos += 2 + segLen;
  }
  return null;
}

/** Intrinsic dimensions for a PNG/JPEG buffer, or null if unreadable. */
export function imageDimensions(bytes: Buffer, mediaType: string): Dimensions | null {
  if (mediaType === 'image/png') return pngDimensions(bytes);
  if (mediaType === 'image/jpeg') return jpegDimensions(bytes);
  return null;
}

// ---------------------------------------------------------------------------
// Metadata stripping.
// ---------------------------------------------------------------------------

// PNG chunks worth keeping for correct rendering; everything else (tEXt, iTXt,
// zTXt, tIME, eXIf, …) is dropped.
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'bKGD', 'pHYs', 'sBIT']);

function stripPng(b: Buffer): Buffer {
  if (b.length < 8) return b;
  const out: Buffer[] = [b.subarray(0, 8)];
  let pos = 8;
  while (pos + 8 <= b.length) {
    const len = b.readUInt32BE(pos);
    const type = b.toString('ascii', pos + 4, pos + 8);
    const total = 12 + len;
    if (pos + total > b.length) break;
    if (PNG_KEEP.has(type)) out.push(b.subarray(pos, pos + total));
    pos += total;
    if (type === 'IEND') break;
  }
  return Buffer.concat(out);
}

// JPEG app/comment segments carrying metadata: APP1 (EXIF/XMP), APP13 (IPTC),
// COM (comment). Dropped; everything else (JFIF, quant/huffman tables, frame,
// scan) is preserved verbatim.
const JPEG_DROP = new Set([0xe1, 0xed, 0xfe]);

function stripJpeg(b: Buffer): Buffer {
  if (b.length < 2 || b[0] !== 0xff || b[1] !== 0xd8) return b;
  const out: Buffer[] = [b.subarray(0, 2)];
  let pos = 2;
  while (pos + 4 <= b.length) {
    if (b[pos] !== 0xff) {
      // Unexpected byte — bail out and keep the remainder verbatim.
      out.push(b.subarray(pos));
      return Buffer.concat(out);
    }
    const marker = b[pos + 1] as number;
    if (marker === 0xda) {
      // Start of scan — entropy-coded data follows to EOI; copy the rest.
      out.push(b.subarray(pos));
      return Buffer.concat(out);
    }
    if (marker >= 0xd0 && marker <= 0xd7) {
      out.push(b.subarray(pos, pos + 2));
      pos += 2;
      continue;
    }
    const segLen = b.readUInt16BE(pos + 2);
    const total = 2 + segLen;
    if (pos + total > b.length) break;
    if (!JPEG_DROP.has(marker)) out.push(b.subarray(pos, pos + total));
    pos += total;
  }
  return Buffer.concat(out);
}

/** Strip non-essential metadata from a PNG/JPEG buffer. Unknown types pass through. */
export function stripImageMetadata(bytes: Buffer, mediaType: string): Buffer {
  if (mediaType === 'image/png') return stripPng(bytes);
  if (mediaType === 'image/jpeg') return stripJpeg(bytes);
  return bytes;
}
