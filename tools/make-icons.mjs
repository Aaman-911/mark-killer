// Generates the extension icons. No image libraries — just a tiny PNG writer
// on top of Node's built-in zlib, so the repo stays dependency-free.
//
//   node tools/make-icons.mjs
//
// The mark is the four-pointed sparkle: |u|^0.5 + |v|^0.5 <= 1.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodePng } from './png.mjs';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
const SIZES = [16, 32, 48, 128];
const SUPERSAMPLE = 4;

const BG_TOP = [49, 46, 129];    // indigo-900
const BG_BOTTOM = [79, 70, 229]; // indigo-600

/* ----------------------------------------------------------------- draw */

function insideRoundedSquare(x, y, size, radius) {
    const dx = Math.max(radius - x, 0, x - (size - radius));
    const dy = Math.max(radius - y, 0, y - (size - radius));
    return dx * dx + dy * dy <= radius * radius;
}

function insideSparkle(x, y, size) {
    const r = size * 0.34;
    const u = Math.abs(x - size / 2) / r;
    const v = Math.abs(y - size / 2) / r;
    return Math.sqrt(u) + Math.sqrt(v) <= 1;
}

function render(size) {
    const rgba = Buffer.alloc(size * size * 4);
    const radius = size * 0.22;
    const step = 1 / SUPERSAMPLE;
    const samples = SUPERSAMPLE * SUPERSAMPLE;

    for (let py = 0; py < size; py++) {
        for (let px = 0; px < size; px++) {
            let bg = 0, fg = 0;
            for (let sy = 0; sy < SUPERSAMPLE; sy++) {
                for (let sx = 0; sx < SUPERSAMPLE; sx++) {
                    const x = px + (sx + 0.5) * step;
                    const y = py + (sy + 0.5) * step;
                    if (!insideRoundedSquare(x, y, size, radius)) continue;
                    bg++;
                    if (insideSparkle(x, y, size)) fg++;
                }
            }

            const coverage = bg / samples;
            const sparkle = fg / samples;
            const t = py / Math.max(1, size - 1);
            const o = (py * size + px) * 4;

            for (let c = 0; c < 3; c++) {
                const base = BG_TOP[c] + (BG_BOTTOM[c] - BG_TOP[c]) * t;
                const mix = coverage > 0 ? sparkle / coverage : 0;
                rgba[o + c] = Math.round(base * (1 - mix) + 255 * mix);
            }
            rgba[o + 3] = Math.round(coverage * 255);
        }
    }
    return rgba;
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
    const file = join(OUT_DIR, `icon-${size}.png`);
    writeFileSync(file, encodePng(size, size, render(size)));
    console.log(`wrote ${file}`);
}
