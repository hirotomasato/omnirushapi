// The favicon, built in code: a rounded square with the product's N.
//
// Served as both a PNG (what a browser asks for at the conventional /favicon.ico path, and
// what every browser renders) and an SVG (crisp at any size). Drawing it here keeps a binary
// asset out of the repository and out of git history.

import { deflateSync } from "node:zlib";

const SIZE = 32;
const ACCENT = { r: 0x4f, g: 0x46, b: 0xe5 };
const GLYPH = { r: 0xff, g: 0xff, b: 0xff };

/** Distance from a point to the segment ab, used for the glyph strokes. */
function distanceToSegment(x: number, y: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lengthSquared));
  const px = ax + t * dx;
  const py = ay + t * dy;
  return Math.hypot(x - px, y - py);
}

/** Rounded-square coverage at a sub-pixel point, 0..1. */
function insideTile(x: number, y: number, radius: number): boolean {
  const near = (value: number): number => Math.max(radius, Math.min(SIZE - radius, value));
  return Math.hypot(x - near(x), y - near(y)) <= radius;
}

/** The N: two verticals and the diagonal between them. */
function onGlyph(x: number, y: number): boolean {
  const stroke = 1.9;
  return (
    distanceToSegment(x, y, 9.5, 22.5, 9.5, 9.5) <= stroke ||
    distanceToSegment(x, y, 22.5, 9.5, 22.5, 22.5) <= stroke ||
    distanceToSegment(x, y, 9.5, 9.5, 22.5, 22.5) <= stroke
  );
}

/** One RGBA pixel, supersampled 3x3 so the edges are not jagged. */
function pixel(x: number, y: number): [number, number, number, number] {
  let tile = 0;
  let glyph = 0;
  let samples = 0;
  for (const ox of [0.17, 0.5, 0.83]) {
    for (const oy of [0.17, 0.5, 0.83]) {
      samples += 1;
      const px = x + ox;
      const py = y + oy;
      if (insideTile(px, py, 7.5)) tile += 1;
      if (onGlyph(px, py)) glyph += 1;
    }
  }
  const tileAlpha = tile / samples;
  const glyphAlpha = glyph / samples;
  if (tileAlpha === 0) return [0, 0, 0, 0];
  // Blend the glyph over the tile, then the tile over nothing.
  const r = Math.round(ACCENT.r * (1 - glyphAlpha) + GLYPH.r * glyphAlpha);
  const g = Math.round(ACCENT.g * (1 - glyphAlpha) + GLYPH.g * glyphAlpha);
  const b = Math.round(ACCENT.b * (1 - glyphAlpha) + GLYPH.b * glyphAlpha);
  return [r, g, b, Math.round(255 * tileAlpha)];
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, payload: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), payload]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A 32x32 RGBA PNG of the mark. */
export function faviconPng(): Buffer {
  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
  for (let y = 0; y < SIZE; y += 1) {
    const rowStart = y * (SIZE * 4 + 1);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < SIZE; x += 1) {
      const [r, g, b, a] = pixel(x, y);
      const at = rowStart + 1 + x * 4;
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
      raw[at + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** The same mark as a vector, for browsers that prefer it. */
export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32"><rect width="32" height="32" rx="7.5" fill="#4f46e5"/><path d="M9.5 22.5V9.5l13 13v-13" fill="none" stroke="#fff" stroke-width="3.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
