// Builds a picture with a real Gemini sparkle blended into it, the same way
// Gemini does. Used by the test suite and the hover preview.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodePng, encodePng } from './png.mjs';
import { calculateAlphaMap } from '../src/engine/alphaMap.js';
import { getWatermarkInfo } from '../src/engine/geometry.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function pattern(width, height) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            data[i] = Math.round(128 + 110 * Math.sin(x / 40));
            data[i + 1] = Math.round(128 + 110 * Math.cos(y / 55));
            data[i + 2] = Math.round(128 + 90 * Math.sin((x + y) / 70));
            data[i + 3] = 255;
        }
    }
    return { width, height, data };
}

/**
 * A watermarked PNG. At 48px no resampling is involved, so Node and Chrome
 * agree on the template byte for byte and the round trip can be checked exactly.
 */
export function watermarkedPng(width = 800, height = 600) {
    const original = pattern(width, height);
    const box = getWatermarkInfo(width, height);
    const reference = box.size === 48 ? 'bg_48.png' : 'bg_96.png';
    const alpha = calculateAlphaMap(decodePng(readFileSync(join(ROOT, 'assets', reference))));

    const marked = new Uint8ClampedArray(original.data);
    for (let row = 0; row < box.height; row++) {
        for (let col = 0; col < box.width; col++) {
            const a = Math.min(alpha[row * box.width + col], 0.99);
            const p = ((box.y + row) * width + (box.x + col)) * 4;
            for (let c = 0; c < 3; c++) {
                marked[p + c] = Math.round(a * 255 + (1 - a) * original.data[p + c]);
            }
        }
    }

    const png = encodePng(width, height, Buffer.from(marked.buffer));
    return { width, height, box, original, png, dataUrl: `data:image/png;base64,${png.toString('base64')}` };
}
