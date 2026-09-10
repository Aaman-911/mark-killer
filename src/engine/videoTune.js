// Working out where the Veo watermark is, and how strong it is, from a frame.
//
// Videos are re-encoded after the watermark is composited, so its position
// drifts a little with resolution and its alpha is no longer the exact value
// baked into the reference image. Rather than make the user find both by
// dragging sliders, this searches for them.

import { scoreBox } from './detect.js';
import { buildAlpha, resolveBox, MAX_ALPHA } from './tuner.js';
import { makeCanvas } from './canvas.js';

/** Veo places a larger mark than the still-image pipeline does. */
export function getVeoWatermark(width, height) {
    const base = Math.min(width, height);
    const size = Math.max(24, Math.min(Math.round(base / 15), base));
    const margin = Math.round(base / 10);
    return {
        size,
        x: Math.max(0, width - margin - size),
        y: Math.max(0, height - margin - size),
        width: size,
        height: size,
    };
}

function template(sparkle, size) {
    const { ctx } = makeCanvas(size, size);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(sparkle, 0, 0, size, size);
    const { data } = ctx.getImageData(0, 0, size, size);
    const map = new Float32Array(size * size);
    for (let i = 0; i < map.length; i++) {
        map[i] = Math.max(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]) / 255;
    }
    return map;
}

/**
 * How much white was mixed in, judged from the frame itself.
 *
 * Under the sparkle: seen = a·g·255 + (1 − a·g)·original. Taking the pixels the
 * template says are clear as a stand-in for `original`, every strongly marked
 * pixel gives one estimate of g; the median of those is the answer.
 */
function estimateGain(imageData, alpha, box) {
    let clearSum = 0, clearCount = 0;
    const luma = (p) => 0.2126 * imageData.data[p] + 0.7152 * imageData.data[p + 1] + 0.0722 * imageData.data[p + 2];

    for (let row = 0; row < box.height; row++) {
        for (let col = 0; col < box.width; col++) {
            if (alpha[row * box.width + col] > 0.03) continue;
            clearSum += luma(((box.y + row) * imageData.width + (box.x + col)) * 4);
            clearCount++;
        }
    }
    if (!clearCount) return 1;
    const background = clearSum / clearCount;
    if (255 - background < 8) return 1; // an almost-white frame tells us nothing

    const estimates = [];
    for (let row = 0; row < box.height; row++) {
        for (let col = 0; col < box.width; col++) {
            const a = alpha[row * box.width + col];
            if (a < 0.35) continue;
            const seen = luma(((box.y + row) * imageData.width + (box.x + col)) * 4);
            const g = (seen - background) / (a * (255 - background));
            if (Number.isFinite(g) && g > 0) estimates.push(g);
        }
    }
    if (!estimates.length) return 1;

    estimates.sort((a, b) => a - b);
    const median = estimates[Math.floor(estimates.length / 2)];
    return Math.min(MAX_ALPHA, Math.max(0.15, median));
}

/**
 * Search a small grid of offsets and sizes around the expected Veo position for
 * the placement that best matches the sparkle, then measure its strength.
 *
 * @returns {{gain:number, offsetX:number, offsetY:number, sizeScale:number,
 *            score:number, box:object}}
 */
export function autoFit(sparkle, imageData, width, height) {
    const base = getVeoWatermark(width, height);
    const step = Math.max(2, Math.round(base.size / 12));

    let best = null;
    for (const sizeScale of [0.75, 0.85, 1, 1.15, 1.3]) {
        const size = Math.max(8, Math.round(base.size * sizeScale));
        const map = template(sparkle, size);
        for (let dy = -6; dy <= 2; dy++) {
            for (let dx = -6; dx <= 2; dx++) {
                const offsetX = dx * step;
                const offsetY = dy * step;
                const box = resolveBox(base, width, height, { offsetX, offsetY, sizeScale });
                if (box.size !== size) continue;
                const score = scoreBox(imageData, map, box);
                if (!best || score > best.score) best = { score, offsetX, offsetY, sizeScale, box };
            }
        }
    }

    const alpha = buildAlpha(sparkle, best.box, best.box, 1);
    const local = new Float32Array(best.box.width * best.box.height);
    // buildAlpha places the mark inside a roi; here roi === box, so it lines up.
    local.set(alpha);

    return { ...best, gain: estimateGain(imageData, local, best.box) };
}
