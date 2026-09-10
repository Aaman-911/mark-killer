// Unit tests: the maths the extension runs on, and the download naming.
//
// Forward-blends a known watermark onto a synthetic picture, then asks the
// real engine modules to take it back off.
//
//   node tools/test.mjs
//
// This covers the reverse-alpha-blend algebra, the watermark geometry and the
// detector. It does not cover Chrome's own image scaling — tools/e2e.mjs runs
// the extension inside a real headless Chrome for that.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodePng } from './png.mjs';
import { calculateAlphaMap } from '../src/engine/alphaMap.js';
import { removeWatermark } from '../src/engine/blendModes.js';
import { getWatermarkInfo, getCompactWatermarkInfo } from '../src/engine/geometry.js';
import { scoreBox } from '../src/engine/detect.js';
import { downloadFilename, bytesToBase64, base64ToBytes } from '../src/lib/naming.js';
import { getVeoWatermark } from '../src/engine/videoTune.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DETECT_THRESHOLD = 0.35;
const MAX_ALPHA = 0.99;

const bg48 = decodePng(readFileSync(join(ROOT, 'assets/bg_48.png')));
const bg96 = decodePng(readFileSync(join(ROOT, 'assets/bg_96.png')));

let failures = 0;
function check(name, pass, detail) {
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
    if (!pass) failures++;
}

/* ------------------------------------------------------------- helpers */

// Bilinear resample, standing in for the browser's smoothed drawImage.
function resample(src, size) {
    const out = new Uint8ClampedArray(size * size * 4);
    const scale = src.width / size;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const sx = Math.min(src.width - 1, (x + 0.5) * scale - 0.5);
            const sy = Math.min(src.height - 1, (y + 0.5) * scale - 0.5);
            const x0 = Math.max(0, Math.floor(sx)), y0 = Math.max(0, Math.floor(sy));
            const x1 = Math.min(src.width - 1, x0 + 1), y1 = Math.min(src.height - 1, y0 + 1);
            const fx = sx - x0, fy = sy - y0;
            for (let c = 0; c < 4; c++) {
                const p00 = src.data[(y0 * src.width + x0) * 4 + c];
                const p10 = src.data[(y0 * src.width + x1) * 4 + c];
                const p01 = src.data[(y1 * src.width + x0) * 4 + c];
                const p11 = src.data[(y1 * src.width + x1) * 4 + c];
                const top = p00 + (p10 - p00) * fx;
                const bottom = p01 + (p11 - p01) * fx;
                out[(y * size + x) * 4 + c] = Math.round(top + (bottom - top) * fy);
            }
        }
    }
    return { width: size, height: size, data: out };
}

function template(size) {
    if (size === 48) return calculateAlphaMap(bg48);
    if (size === 96) return calculateAlphaMap(bg96);
    return calculateAlphaMap(resample(bg96, size));
}

// A deterministic picture with real structure, so the test is not measuring
// the reconstruction of a flat colour.
function synthesise(width, height) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            data[i] = (x * 7 + y * 3) % 256;
            data[i + 1] = Math.round(128 + 100 * Math.sin(x / 23) * Math.cos(y / 31));
            data[i + 2] = (x * x + y * y) % 256;
            data[i + 3] = 255;
        }
    }
    return { width, height, data };
}

function applyWatermark(image, alpha, box) {
    const out = { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) };
    for (let row = 0; row < box.height; row++) {
        for (let col = 0; col < box.width; col++) {
            const a = Math.min(alpha[row * box.width + col], MAX_ALPHA);
            const p = ((box.y + row) * image.width + (box.x + col)) * 4;
            for (let c = 0; c < 3; c++) {
                out.data[p + c] = Math.round(a * 255 + (1 - a) * image.data[p + c]);
            }
        }
    }
    return out;
}

function maxError(a, b, box) {
    let worst = 0;
    for (let row = 0; row < box.height; row++) {
        for (let col = 0; col < box.width; col++) {
            const p = ((box.y + row) * a.width + (box.x + col)) * 4;
            for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(a.data[p + c] - b.data[p + c]));
        }
    }
    return worst;
}

function bestCandidate(image) {
    const boxes = [
        { name: 'classic', box: getWatermarkInfo(image.width, image.height) },
        { name: 'compact', box: getCompactWatermarkInfo(image.width, image.height) },
    ].filter(({ box }) => box.x >= 0 && box.y >= 0 && box.width >= 8 &&
        box.x + box.width <= image.width && box.y + box.height <= image.height);

    let best = null;
    for (const { name, box } of boxes) {
        const alpha = template(box.size);
        const score = scoreBox(image, alpha, box);
        if (!best || score > best.score) best = { name, box, alpha, score };
    }
    return best;
}

/* --------------------------------------------------------------- cases */

function roundTrip(label, width, height, geometry, expectedVariant) {
    const original = synthesise(width, height);
    const box = geometry(width, height);
    const alpha = template(box.size);
    const marked = applyWatermark(original, alpha, box);

    const found = bestCandidate(marked);
    check(`${label}: watermark detected`,
        found.score >= DETECT_THRESHOLD, `score ${found.score.toFixed(3)}`);
    check(`${label}: right placement chosen`,
        found.name === expectedVariant, `picked ${found.name}, box ${box.size}px at ${box.x},${box.y}`);

    const cleaned = { width, height, data: new Uint8ClampedArray(marked.data) };
    removeWatermark(cleaned, found.alpha, found.box);

    const err = maxError(original, cleaned, box);
    check(`${label}: pixels restored`, err <= 2, `worst channel error ${err}/255`);

    const after = scoreBox(cleaned, found.alpha, found.box);
    check(`${label}: mark gone afterwards`,
        after < DETECT_THRESHOLD, `score ${found.score.toFixed(3)} -> ${after.toFixed(3)}`);
}

console.log('--- reverse alpha blend round trips');
roundTrip('classic 96px (1600x1600)', 1600, 1600, getWatermarkInfo, 'classic');
roundTrip('classic 48px (800x600)', 800, 600, getWatermarkInfo, 'classic');
roundTrip('compact 24px (1408x768)', 1408, 768, getCompactWatermarkInfo, 'compact');

console.log('--- false positives');
for (const [w, h] of [[1600, 1600], [800, 600], [1408, 768]]) {
    const plain = synthesise(w, h);
    const found = bestCandidate(plain);
    check(`clean ${w}x${h} image is left alone`,
        found.score < DETECT_THRESHOLD, `best score ${found.score.toFixed(3)} (${found.name})`);
}

const white = { width: 900, height: 900, data: new Uint8ClampedArray(900 * 900 * 4).fill(255) };
check('flat white image is left alone',
    bestCandidate(white).score < DETECT_THRESHOLD,
    `best score ${bestCandidate(white).score.toFixed(3)}`);

console.log('--- veo watermark geometry');
for (const [w, h] of [[1280, 720], [720, 1280], [1920, 1080], [640, 480]]) {
    const box = getVeoWatermark(w, h);
    const short = Math.min(w, h);
    check(`veo box for ${w}x${h}`,
        box.size === Math.max(24, Math.round(short / 15))
        && box.x + box.width + Math.round(short / 10) === w
        && box.y + box.height + Math.round(short / 10) === h,
        `${box.size}px at ${box.x},${box.y}`);
    check(`veo box for ${w}x${h} stays in frame`,
        box.x >= 0 && box.y >= 0 && box.x + box.width <= w && box.y + box.height <= h);
}

console.log('--- download naming');
const naming = [
    ['https://x.test/pics/sunset-01.jpg', 'mark-killer/sunset-01-clean.png'],
    ['https://x.test/pics/sunset.png?w=800&token=abc', 'mark-killer/sunset-clean.png'],
    ['https://x.test/pics/a b%20c!.jpeg', 'mark-killer/a-b-c-clean.png'],
    ['blob:https://x.test/9f2c', 'mark-killer/gemini-1700000000000-clean.png'],
    ['data:image/png;base64,AAAA', 'mark-killer/gemini-1700000000000-clean.png'],
    ['https://x.test/', 'mark-killer/gemini-1700000000000-clean.png'],
    [`https://x.test/${'y'.repeat(120)}.png`, `mark-killer/${'y'.repeat(60)}-clean.png`],
];
for (const [input, expected] of naming) {
    const actual = downloadFilename(input, 1700000000000);
    check(`names ${input.slice(0, 46)}`, actual === expected, actual);
}
check('a download name never escapes its folder',
    naming.every(([input]) => !downloadFilename(input, 1).includes('..')));

console.log('--- base64 round trip');
const sample = new Uint8Array(200000).map((_, i) => (i * 37) % 256);
const back = base64ToBytes(bytesToBase64(sample));
check('large buffers survive the round trip',
    back.length === sample.length && back.every((v, i) => v === sample[i]),
    `${sample.length} bytes`);

console.log(failures === 0 ? '\nall unit checks passed' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
