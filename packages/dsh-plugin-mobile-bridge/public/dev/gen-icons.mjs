#!/usr/bin/env node
/**
 * DSH Mobile icon generator — dev-only, no dependencies, no network.
 *
 * Hand-rolls PNG encoding with node:zlib and paints the icons in pure JS so the
 * repo needs no binary tooling. Reproducible: run `node dev/gen-icons.mjs`.
 *
 * Generates into ../icons/:
 *   icon-192.png, icon-512.png                 (purpose "any", rounded square)
 *   icon-maskable-192.png, icon-maskable-512.png (purpose "maskable", full bleed)
 *   apple-touch-icon-180.png                    (opaque full bleed, iOS masks it)
 *   favicon-32.png, favicon-16.png              (rounded, high-contrast glyph)
 *
 * Design: near-black blue rounded square, blue/cyan glow, terminal prompt ">_"
 * with a cyan spark — matching the shell's palette (#0b0f19 / #3b82f6 / #22d3ee).
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ICONS_DIR = join(HERE, '..', 'icons');

/* ------------------------------------------------------------------ */
/* PNG encoding (RGBA, 8-bit, filter 0)                                */
/* ------------------------------------------------------------------ */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuffer, data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ */
/* tiny drawing helpers (normalized 0..1 coordinates)                  */
/* ------------------------------------------------------------------ */

const clamp01 = (value) => (value < 0 ? 0 : value > 1 ? 1 : value);
const lerp = (a, b, t) => a + (b - a) * t;

function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** signed distance to a rounded box (negative inside) */
function sdRoundBox(px, py, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(px - cx) - halfW + radius;
  const qy = Math.abs(py - cy) - halfH + radius;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside - radius;
}

/** signed distance to a line segment with round caps */
function sdSegment(px, py, ax, ay, bx, by) {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const h = clamp01((pax * bax + pay * bay) / (bax * bax + bay * bay || 1));
  return Math.hypot(pax - bax * h, pay - bay * h);
}

/** soft radial falloff, 1 at the centre, 0 beyond radius */
function radial(px, py, cx, cy, radius) {
  const d = Math.hypot(px - cx, py - cy);
  return clamp01(1 - d / radius);
}

/* ------------------------------------------------------------------ */
/* icon painting                                                       */
/* ------------------------------------------------------------------ */

const BG_TOP = [16, 26, 47]; // #101a2f
const BG_BOTTOM = [7, 10, 18]; // #070a12
const GLOW_CYAN = [34, 211, 238];
const GLOW_BLUE = [59, 130, 246];
const CHEVRON_COLOR = [248, 250, 252]; // near-white
const UNDERSCORE_COLOR = [125, 211, 252]; // #7dd3fc
const SPARK_COLOR = [34, 211, 238]; // #22d3ee

const SUPERSAMPLE = 3;

function renderIconPixels(size, options) {
  const opts = options || {};
  const maskable = !!opts.maskable;
  const fullBleed = !!opts.fullBleed || maskable;
  const glyphScale = opts.glyphScale || 1;
  const cornerRadius = fullBleed ? 0 : 0.22; // rounded-square for "any" icons
  const dim = size * SUPERSAMPLE;
  const target = Buffer.alloc(size * size * 4);

  // One antialiasing width in normalized coordinates (~1.2 device pixels).
  const aa = 1.25 / dim;

  for (let y = 0; y < dim; y += 1) {
    for (let x = 0; x < dim; x += 1) {
      const u = (x + 0.5) / dim;
      const v = (y + 0.5) / dim;

      // ---- background coverage -------------------------------------
      const bgCoverage = fullBleed
        ? 1
        : smoothstep(aa, -aa, sdRoundBox(u, v, 0.5, 0.5, 0.5, 0.5, cornerRadius));
      if (bgCoverage <= 0) continue;

      // base diagonal gradient
      const t = clamp01(u * 0.45 + v * 0.72);
      let r = lerp(BG_TOP[0], BG_BOTTOM[0], t);
      let g = lerp(BG_TOP[1], BG_BOTTOM[1], t);
      let b = lerp(BG_TOP[2], BG_BOTTOM[2], t);

      // ambient glows
      const cyanGlow = Math.pow(radial(u, v, 0.76, 0.2, 0.62), 1.8) * 0.34;
      const blueGlow = Math.pow(radial(u, v, 0.18, 0.86, 0.66), 1.8) * 0.3;
      r += GLOW_CYAN[0] * cyanGlow * 0.32 + GLOW_BLUE[0] * blueGlow * 0.35;
      g += GLOW_CYAN[1] * cyanGlow * 0.32 + GLOW_BLUE[1] * blueGlow * 0.35;
      b += GLOW_CYAN[2] * cyanGlow * 0.32 + GLOW_BLUE[2] * blueGlow * 0.35;

      // ---- glyph (scaled into the safe zone for maskable icons) ----
      const gu = (u - 0.5) / glyphScale + 0.5;
      const gv = (v - 0.5) / glyphScale + 0.5;

      // soft glow behind the glyph
      const glyphGlow =
        Math.pow(radial(gu, gv, 0.5, 0.5, 0.34), 2) * 0.16 +
        Math.pow(radial(gu, gv, 0.7, 0.33, 0.2), 2) * 0.2;
      r += GLOW_CYAN[0] * glyphGlow;
      g += GLOW_CYAN[1] * glyphGlow;
      b += GLOW_CYAN[2] * glyphGlow;

      // chevron ">" (two round-capped strokes)
      const strokeHalf = 0.042;
      const chevron = Math.min(
        sdSegment(gu, gv, 0.3, 0.34, 0.455, 0.5) - strokeHalf,
        sdSegment(gu, gv, 0.455, 0.5, 0.3, 0.66) - strokeHalf,
      );
      const chevronCoverage = smoothstep(aa, -aa, chevron);

      // underscore "_" next to the prompt
      const underscore =
        sdSegment(gu, gv, 0.545, 0.66, 0.735, 0.66) - strokeHalf;
      const underscoreCoverage = smoothstep(aa, -aa, underscore);

      // spark dot
      const spark = Math.hypot(gu - 0.705, gv - 0.33) - 0.052;
      const sparkCoverage = smoothstep(aa, -aa, spark);

      // ---- compose straight-alpha RGBA -----------------------------
      const glyphColorR = CHEVRON_COLOR[0];
      const glyphColorG = CHEVRON_COLOR[1];
      const glyphColorB = CHEVRON_COLOR[2];

      const underColorR = UNDERSCORE_COLOR[0];
      const underColorG = UNDERSCORE_COLOR[1];
      const underColorB = UNDERSCORE_COLOR[2];

      let outR = r;
      let outG = g;
      let outB = b;

      if (chevronCoverage > 0) {
        outR = lerp(outR, glyphColorR, chevronCoverage);
        outG = lerp(outG, glyphColorG, chevronCoverage);
        outB = lerp(outB, glyphColorB, chevronCoverage);
      }
      if (underscoreCoverage > 0) {
        outR = lerp(outR, underColorR, underscoreCoverage);
        outG = lerp(outG, underColorG, underscoreCoverage);
        outB = lerp(outB, underColorB, underscoreCoverage);
      }
      if (sparkCoverage > 0) {
        // bright cyan core with a soft halo
        const halo = Math.pow(radial(gu, gv, 0.705, 0.33, 0.16), 2) * 0.35;
        outR = lerp(outR, SPARK_COLOR[0], Math.min(1, sparkCoverage + halo));
        outG = lerp(outG, SPARK_COLOR[1], Math.min(1, sparkCoverage + halo));
        outB = lerp(outB, SPARK_COLOR[2], Math.min(1, sparkCoverage + halo));
      }

      // write premultiplied-by-coverage straight-alpha pixel
      const index = (y * dim + x) * 4;
      // accumulate into a supersampled buffer; store RGBA with alpha
      superBuffer[index] = outR;
      superBuffer[index + 1] = outG;
      superBuffer[index + 2] = outB;
      superBuffer[index + 3] = bgCoverage * 255;
    }
  }

  // downsample SUPERSAMPLE x SUPERSAMPLE -> size x size
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let sumA = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const index = ((y * SUPERSAMPLE + sy) * dim + (x * SUPERSAMPLE + sx)) * 4;
          const alpha = superBuffer[index + 3] / 255;
          sumR += superBuffer[index] * alpha;
          sumG += superBuffer[index + 1] * alpha;
          sumB += superBuffer[index + 2] * alpha;
          sumA += alpha;
        }
      }
      const samples = SUPERSAMPLE * SUPERSAMPLE;
      const alpha = sumA / samples;
      const index = (y * size + x) * 4;
      if (alpha <= 0) {
        target[index] = 0;
        target[index + 1] = 0;
        target[index + 2] = 0;
        target[index + 3] = 0;
      } else {
        target[index] = Math.round(clamp01(sumR / sumA / 255) * 255);
        target[index + 1] = Math.round(clamp01(sumG / sumA / 255) * 255);
        target[index + 2] = Math.round(clamp01(sumB / sumA / 255) * 255);
        target[index + 3] = Math.round(clamp01(alpha) * 255);
      }
    }
  }
  return target;
}

// supersampled working buffer, allocated per render (reassigned)
let superBuffer = Buffer.alloc(0);

function generate(size, options) {
  const dim = size * SUPERSAMPLE;
  superBuffer = Buffer.alloc(dim * dim * 4);
  const pixels = renderIconPixels(size, options);
  return encodePng(size, size, pixels);
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

const jobs = [
  { file: 'icon-192.png', size: 192, options: { glyphScale: 1 } },
  { file: 'icon-512.png', size: 512, options: { glyphScale: 1 } },
  { file: 'icon-maskable-192.png', size: 192, options: { maskable: true, glyphScale: 0.72 } },
  { file: 'icon-maskable-512.png', size: 512, options: { maskable: true, glyphScale: 0.72 } },
  { file: 'apple-touch-icon-180.png', size: 180, options: { fullBleed: true, glyphScale: 0.94 } },
  { file: 'favicon-32.png', size: 32, options: { glyphScale: 1.06 } },
  { file: 'favicon-16.png', size: 16, options: { glyphScale: 1.1 } },
];

mkdirSync(ICONS_DIR, { recursive: true });
for (const job of jobs) {
  const png = generate(job.size, job.options);
  const target = join(ICONS_DIR, job.file);
  writeFileSync(target, png);
  console.log(`icons: wrote ${job.file} (${job.size}x${job.size}, ${png.length} bytes)`);
}
console.log('icons: done ->', ICONS_DIR);
