import { calculateAlphaMap } from './alphaMap.js';
import { removeWatermark } from './blendModes.js';
import { getWatermarkInfo, getCompactWatermarkInfo } from './geometry.js';
import { makeCanvas, bitmapToImageData, imageDataToBlob } from './canvas.js';
import { scoreBox } from './detect.js';

// Below this correlation we say "no watermark here" and leave the image alone,
// rather than quietly damaging a clean picture.
export const DETECT_THRESHOLD = 0.35;

export class Engine {
    constructor(bg48, bg96) {
        this.bg48 = bg48;
        this.bg96 = bg96;
        this.templates = new Map();
    }

    static async create() {
        const load = async (name) => {
            const res = await fetch(chrome.runtime.getURL(`assets/${name}`));
            if (!res.ok) throw new Error(`cannot load ${name}: HTTP ${res.status}`);
            return createImageBitmap(await res.blob());
        };
        const [bg48, bg96] = await Promise.all([load('bg_48.png'), load('bg_96.png')]);
        return new Engine(bg48, bg96);
    }

    // Sparkle alpha template at an arbitrary size. The 48px reference is used
    // verbatim at 48px so the classic path stays byte-for-byte identical to
    // upstream; every other size is scaled from the 96px reference.
    template(size) {
        if (this.templates.has(size)) return this.templates.get(size);

        const { ctx } = makeCanvas(size, size);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        const source = size === 48 ? this.bg48 : this.bg96;
        ctx.drawImage(source, 0, 0, size, size);

        const map = calculateAlphaMap(ctx.getImageData(0, 0, size, size));
        this.templates.set(size, map);
        return map;
    }

    // Every watermark placement Gemini is known to use, scored against the
    // actual pixels. Best score wins.
    candidates(width, height) {
        const boxes = [
            { name: 'classic', box: getWatermarkInfo(width, height) },
            { name: 'compact', box: getCompactWatermarkInfo(width, height) },
        ];
        return boxes.filter(({ box }) =>
            box.x >= 0 && box.y >= 0 &&
            box.x + box.width <= width &&
            box.y + box.height <= height &&
            box.width >= 8);
    }

    /** Score an image without touching it. Used by the hover button. */
    async inspect(blob) {
        const bitmap = await createImageBitmap(blob);
        const { imageData } = bitmapToImageData(bitmap);
        const { width, height } = bitmap;
        bitmap.close();

        let best = null;
        for (const { name, box } of this.candidates(width, height)) {
            const score = scoreBox(imageData, this.template(box.size), box);
            if (!best || score > best.score) best = { variant: name, score, box };
        }
        return {
            detected: Boolean(best) && best.score >= DETECT_THRESHOLD,
            score: best ? best.score : 0,
            variant: best ? best.variant : null,
            width,
            height,
        };
    }

    /**
     * Clean one image.
     * @param {Blob} blob source image
     * @returns {Promise<{detected:boolean, score:number, variant:string|null,
     *                    box:object|null, blob:Blob, width:number, height:number}>}
     */
    async clean(blob) {
        const bitmap = await createImageBitmap(blob);
        const { imageData, ctx } = bitmapToImageData(bitmap);
        const { width, height } = bitmap;
        bitmap.close();

        let best = null;
        for (const { name, box } of this.candidates(width, height)) {
            const alpha = this.template(box.size);
            const score = scoreBox(imageData, alpha, box);
            if (!best || score > best.score) best = { name, box, alpha, score };
        }

        if (!best || best.score < DETECT_THRESHOLD) {
            return {
                detected: false,
                score: best ? best.score : 0,
                variant: null,
                box: null,
                blob,
                width,
                height,
            };
        }

        removeWatermark(imageData, best.alpha, best.box);

        return {
            detected: true,
            score: best.score,
            variant: best.name,
            box: best.box,
            blob: await imageDataToBlob(ctx, imageData, 'image/png'),
            width,
            height,
        };
    }
}
