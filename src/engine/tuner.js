// Placing and scaling the sparkle template by hand.
//
// A video watermark is described by a base box plus tweaks:
//   { gain, offsetX, offsetY, sizeScale }
// Removal is always confined to the sparkle's own shape, so only the logo
// pixels are ever altered — never the picture around them.
//
// Ported from the upstream web app to OffscreenCanvas, so it runs in a worker
// as well as in a page.

import { removeWatermark } from './blendModes.js';
import { makeCanvas } from './canvas.js';

export const MAX_ALPHA = 0.99;

/** A little breathing room around the mark, so soft edges are covered too. */
export function getRoi(width, height, wm) {
    const pad = Math.round(wm.size * 0.6);
    const x = Math.max(0, wm.x - pad);
    const y = Math.max(0, wm.y - pad);
    return {
        x,
        y,
        width: Math.min(width - x, wm.width + pad * 2),
        height: Math.min(height - y, wm.height + pad * 2),
    };
}

/** Apply the user's offset and scale tweaks to a base box, keeping it in frame. */
export function resolveBox(base, width, height, opts = {}) {
    const sizeScale = opts.sizeScale || 1;
    const size = Math.max(8, Math.min(Math.round(base.size * sizeScale), Math.min(width, height)));
    return {
        size,
        x: Math.max(0, Math.min(base.x + Math.round(opts.offsetX || 0), width - size)),
        y: Math.max(0, Math.min(base.y + Math.round(opts.offsetY || 0), height - size)),
        width: size,
        height: size,
    };
}

/** The sparkle's transparency, scaled to `wm.size` and placed inside `roi`. */
export function buildAlpha(sparkle, roi, wm, gain = 1) {
    const count = roi.width * roi.height;
    const alphaMap = new Float32Array(count);
    const offX = wm.x - roi.x;
    const offY = wm.y - roi.y;

    const { ctx } = makeCanvas(wm.size, wm.size);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(sparkle, 0, 0, wm.size, wm.size);
    const { data } = ctx.getImageData(0, 0, wm.size, wm.size);

    for (let row = 0; row < wm.size; row++) {
        for (let col = 0; col < wm.size; col++) {
            const target = (offY + row) * roi.width + (offX + col);
            if (target < 0 || target >= count) continue;
            const source = (row * wm.size + col) * 4;
            const a = (Math.max(data[source], data[source + 1], data[source + 2]) / 255) * gain;
            alphaMap[target] = a > 0 ? Math.min(a, MAX_ALPHA) : 0;
        }
    }
    return alphaMap;
}

/** Clean one full frame in place. Returns the box and region it worked on. */
export function cleanFrame(sparkle, imageData, width, height, base, opts = {}) {
    const wm = resolveBox(base, width, height, opts);
    const roi = getRoi(width, height, wm);
    const alpha = buildAlpha(sparkle, roi, wm, opts.gain ?? 1);
    removeWatermark(imageData, alpha, { x: roi.x, y: roi.y, width: roi.width, height: roi.height });
    return { wm, roi };
}
