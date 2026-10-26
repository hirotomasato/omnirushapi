// The favicon is drawn in code, so "is it a valid image" is worth a test: a wrong CRC, a
// wrong bit depth or an unfiltered scanline all produce a file browsers silently ignore.

import assert from "node:assert/strict";
import { test } from "node:test";
import { inflateSync } from "node:zlib";
import { FAVICON_SVG, faviconPng } from "../src/favicon.js";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Chunks in order, each with its CRCs already checked by the caller. */
function chunks(png: Buffer): { type: string; payload: Buffer }[] {
  const found: { type: string; payload: Buffer }[] = [];
  let at = PNG_SIGNATURE.length;
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    const type = png.subarray(at + 4, at + 8).toString("latin1");
    found.push({ type, payload: png.subarray(at + 8, at + 8 + length) });
    at += 12 + length;
  }
  return found;
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

test("the favicon is a PNG a browser will accept", () => {
  const png = faviconPng();
  assert.ok(png.subarray(0, 8).equals(PNG_SIGNATURE), "signature");

  const parts = chunks(png);
  assert.deepEqual(
    parts.map((part) => part.type),
    ["IHDR", "IDAT", "IEND"],
  );

  const [header] = parts;
  assert.ok(header);
  assert.equal(header.payload.readUInt32BE(0), 32, "width");
  assert.equal(header.payload.readUInt32BE(4), 32, "height");
  assert.equal(header.payload[8], 8, "bit depth");
  assert.equal(header.payload[9], 6, "colour type RGBA");
});

test("every chunk carries a correct CRC", () => {
  const png = faviconPng();
  let at = PNG_SIGNATURE.length;
  let checked = 0;
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    const body = png.subarray(at + 4, at + 8 + length);
    const expected = png.readUInt32BE(at + 8 + length);
    assert.equal(crc32(body), expected, `crc of ${body.subarray(0, 4).toString("latin1")}`);
    checked += 1;
    at += 12 + length;
  }
  assert.equal(checked, 3);
});

test("the pixels say what the mark is", () => {
  const png = faviconPng();
  const idat = chunks(png).find((part) => part.type === "IDAT");
  assert.ok(idat);
  const raw = inflateSync(idat.payload);
  const stride = 32 * 4 + 1;
  assert.equal(raw.length, stride * 32, "one filter byte plus four channels per row");

  const pixel = (x: number, y: number): number[] => {
    const at = y * stride + 1 + x * 4;
    return [raw[at] ?? -1, raw[at + 1] ?? -1, raw[at + 2] ?? -1, raw[at + 3] ?? -1];
  };
  assert.deepEqual(pixel(0, 0), [0, 0, 0, 0], "the corner is outside the rounded tile");
  assert.deepEqual(pixel(31, 31), [0, 0, 0, 0]);
  assert.equal(pixel(16, 5)[3], 255, "the tile is opaque across the middle");
  assert.equal(pixel(16, 16)[0], 255, "the glyph crosses the centre in white");
  for (let y = 0; y < 32; y += 1) assert.equal(raw[y * stride], 0, "every row uses filter 0");
});

test("the vector version is a self-contained svg", () => {
  assert.match(FAVICON_SVG, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(FAVICON_SVG, /viewBox="0 0 32 32"/);
  assert.match(FAVICON_SVG, /fill="#4f46e5"/);
  assert.ok(!FAVICON_SVG.includes("<image"), "no embedded raster");
});
