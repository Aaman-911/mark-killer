// Canvas helpers that work in BOTH a service worker and a normal extension
// page. The upstream project used `document.createElement('canvas')`, which
// does not exist in an MV3 service worker, so everything here goes through
// OffscreenCanvas instead.

export function makeCanvas(width, height) {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    return { canvas, ctx };
}

export function bitmapToImageData(bitmap) {
    const { canvas, ctx } = makeCanvas(bitmap.width, bitmap.height);
    ctx.drawImage(bitmap, 0, 0);
    return { imageData: ctx.getImageData(0, 0, bitmap.width, bitmap.height), canvas, ctx };
}

export function imageDataToBlob(ctx, imageData, type = 'image/png') {
    ctx.putImageData(imageData, 0, 0);
    return ctx.canvas.convertToBlob({ type });
}
