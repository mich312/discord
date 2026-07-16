// Generate the PWA icon set (public/icons/*.png) from the brand glyph —
// a registration mark holding three modules, signal yellow on carbon.
// The glyph is pure rectangles, so the PNGs are rasterized right here with
// node's zlib: no canvas, no image dependency, reproducible output.
// Run once (outputs are committed): node scripts/gen-icons.mjs
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const WELL = [0x0e, 0x0e, 0x0f]; // --well (carbon)
const ACCENT = [0xe5, 0xc2, 0x35]; // --accent (signal yellow)

// --- minimal PNG encoder (8-bit RGB, no alpha) ------------------------------
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function png(size, pixels /* size*size*3 RGB */) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  const raw = Buffer.alloc(size * (1 + size * 3));
  for (let y = 0; y < size; y++) {
    // filter byte 0 (None) + scanline
    pixels.copy(raw, y * (1 + size * 3) + 1, y * size * 3, (y + 1) * size * 3);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- the glyph, drawn in the 24-unit viewBox of QuorumGlyph ------------------
function drawIcon(size, glyphScale) {
  const px = Buffer.alloc(size * size * 3);
  const fill = (x0, y0, x1, y1, [r, g, b]) => {
    x0 = Math.max(0, Math.round(x0));
    y0 = Math.max(0, Math.round(y0));
    x1 = Math.min(size, Math.round(x1));
    y1 = Math.min(size, Math.round(y1));
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const i = (y * size + x) * 3;
        px[i] = r;
        px[i + 1] = g;
        px[i + 2] = b;
      }
  };
  fill(0, 0, size, size, WELL);

  // glyph occupies glyphScale of the tile, centered; u maps viewBox units
  const g = size * glyphScale;
  const o = (size - g) / 2;
  const u = g / 24;
  const rect = (x, y, w, h, c) => fill(o + x * u, o + y * u, o + (x + w) * u, o + (y + h) * u, c);

  // outer registration mark: stroked rect (3,3)-(21,21), stroke 1.5
  const s = Math.max(1, 1.5 * u);
  fill(o + 3 * u - s / 2, o + 3 * u - s / 2, o + 21 * u + s / 2, o + 3 * u + s / 2, ACCENT); // top
  fill(o + 3 * u - s / 2, o + 21 * u - s / 2, o + 21 * u + s / 2, o + 21 * u + s / 2, ACCENT); // bottom
  fill(o + 3 * u - s / 2, o + 3 * u - s / 2, o + 3 * u + s / 2, o + 21 * u + s / 2, ACCENT); // left
  fill(o + 21 * u - s / 2, o + 3 * u - s / 2, o + 21 * u + s / 2, o + 21 * u + s / 2, ACCENT); // right

  // the three modules — the smallest quorum
  rect(6.5, 6.5, 4.4, 4.4, ACCENT);
  rect(13.1, 6.5, 4.4, 4.4, ACCENT);
  rect(9.8, 13.1, 4.4, 4.4, ACCENT);
  return png(size, px);
}

const outDir = fileURLToPath(new URL('../public/icons', import.meta.url));
mkdirSync(outDir, { recursive: true });
// Regular icons breathe a little; the maskable one keeps the glyph inside
// the ~80% safe zone so launcher masks (circles, squircles) never clip it.
writeFileSync(`${outDir}/icon-192.png`, drawIcon(192, 0.78));
writeFileSync(`${outDir}/icon-512.png`, drawIcon(512, 0.78));
writeFileSync(`${outDir}/maskable-512.png`, drawIcon(512, 0.55));
writeFileSync(`${outDir}/apple-touch-icon.png`, drawIcon(180, 0.7));
console.log('wrote public/icons/{icon-192,icon-512,maskable-512,apple-touch-icon}.png');
