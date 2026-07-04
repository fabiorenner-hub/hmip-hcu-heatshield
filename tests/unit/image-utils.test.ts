/**
 * Image utilities for underlays (BME-03): data-URL decode, dimension reading,
 * metadata stripping. Pure Node Buffer parsing, no image library.
 */

import { describe, expect, it } from 'vitest';

import {
  parseDataUrl,
  isAllowedUnderlayMedia,
  imageDimensions,
  stripImageMetadata,
} from '../../src/plugin/persistence/imageUtils.js';

// A real 1×1 PNG.
const PNG_1x1_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=';
const PNG_1x1 = Buffer.from(PNG_1x1_B64, 'base64');

describe('parseDataUrl', () => {
  it('decodes a base64 data URL', () => {
    const d = parseDataUrl(`data:image/png;base64,${PNG_1x1_B64}`);
    expect(d).not.toBeNull();
    expect(d?.mediaType).toBe('image/png');
    expect(d?.bytes.length).toBe(PNG_1x1.length);
  });
  it('rejects malformed input', () => {
    expect(parseDataUrl('not a data url')).toBeNull();
    expect(parseDataUrl('data:image/png;base64,')).toBeNull();
  });
});

describe('isAllowedUnderlayMedia', () => {
  it('allows PNG/JPEG, rejects others', () => {
    expect(isAllowedUnderlayMedia('image/png')).toBe(true);
    expect(isAllowedUnderlayMedia('image/jpeg')).toBe(true);
    expect(isAllowedUnderlayMedia('image/webp')).toBe(false);
    expect(isAllowedUnderlayMedia('application/pdf')).toBe(false);
  });
});

describe('imageDimensions', () => {
  it('reads PNG dimensions from IHDR', () => {
    expect(imageDimensions(PNG_1x1, 'image/png')).toEqual({ width: 1, height: 1 });
  });

  it('reads JPEG dimensions from the SOF marker', () => {
    // FFD8 (SOI) + FFC0 (SOF0) len=0x11 precision=8 height=0x0010 width=0x0020 …
    const jpeg = Buffer.from([
      0xff, 0xd8,
      0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x20, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    ]);
    expect(imageDimensions(jpeg, 'image/jpeg')).toEqual({ width: 32, height: 16 });
  });
});

describe('stripImageMetadata', () => {
  it('drops PNG tEXt chunks but keeps IHDR/IDAT/IEND', () => {
    // Splice a fake tEXt chunk right after the 8-byte signature + IHDR (33 bytes).
    const headerEnd = 8 + 25; // sig(8) + IHDR chunk (len4+type4+data13+crc4 = 25)
    const text = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x04]), // length 4
      Buffer.from('tEXt', 'ascii'),
      Buffer.from([0x41, 0x42, 0x43, 0x44]), // data
      Buffer.from([0x00, 0x00, 0x00, 0x00]), // crc (not verified)
    ]);
    const withText = Buffer.concat([PNG_1x1.subarray(0, headerEnd), text, PNG_1x1.subarray(headerEnd)]);
    const stripped = stripImageMetadata(withText, 'image/png');
    expect(stripped.includes(Buffer.from('tEXt', 'ascii'))).toBe(false);
    expect(stripped.includes(Buffer.from('IDAT', 'ascii'))).toBe(true);
    expect(stripped.includes(Buffer.from('IEND', 'ascii'))).toBe(true);
    expect(stripped.length).toBeLessThan(withText.length);
  });

  it('drops JPEG APP1 (EXIF) but keeps the scan', () => {
    const jpeg = Buffer.from([
      0xff, 0xd8,
      0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, // APP1 EXIF
      0xff, 0xda, 0x00, 0x03, 0x01, // SOS
      0x12, 0x34, // entropy
      0xff, 0xd9, // EOI
    ]);
    const stripped = stripImageMetadata(jpeg, 'image/jpeg');
    // The APP1 marker (FF E1) must be gone; the SOS (FF DA) must remain.
    let hasApp1 = false;
    for (let i = 0; i + 1 < stripped.length; i += 1) {
      if (stripped[i] === 0xff && stripped[i + 1] === 0xe1) hasApp1 = true;
    }
    expect(hasApp1).toBe(false);
    expect(stripped.length).toBeLessThan(jpeg.length);
  });
});
