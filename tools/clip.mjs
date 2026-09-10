// The source of a small in-page script that builds a test video with the Veo
// sparkle blended into every frame. Shared by the e2e suite and the studio
// preview, so both exercise the same fixture.

export const BUILD_CLIP = `(async (width, height, frames, frameRate) => {
    const url = (p) => chrome.runtime.getURL(p);
    const [{ Engine }, mb, { getVeoWatermark }, { buildAlpha }] = await Promise.all([
        import(url('src/engine/engine.js')),
        import(url('vendor/mediabunny.mjs')),
        import(url('src/engine/videoTune.js')),
        import(url('src/engine/tuner.js')),
    ]);

    const sparkle = (await Engine.create()).bg96;
    const box = getVeoWatermark(width, height);
    const alpha = buildAlpha(sparkle, box, box, 1);

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const target = new mb.BufferTarget();
    const output = new mb.Output({ format: new mb.Mp4OutputFormat(), target });
    const source = new mb.CanvasSource(canvas, { codec: 'avc', bitrate: mb.QUALITY_HIGH, keyFrameInterval: 1 });
    output.addVideoTrack(source, { frameRate });
    await output.start();

    for (let f = 0; f < frames; f++) {
        const img = ctx.createImageData(width, height);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const i = (y * width + x) * 4;
                img.data[i] = Math.round(120 + 110 * Math.sin((x + f * 6) / 34));
                img.data[i + 1] = Math.round(120 + 110 * Math.cos((y - f * 3) / 41));
                img.data[i + 2] = Math.round(120 + 90 * Math.sin((x + y) / 60));
                img.data[i + 3] = 255;
            }
        }
        for (let row = 0; row < box.height; row++) {
            for (let col = 0; col < box.width; col++) {
                const a = Math.min(alpha[row * box.width + col], 0.99);
                const p = ((box.y + row) * width + (box.x + col)) * 4;
                for (let c = 0; c < 3; c++) img.data[p + c] = Math.round(a * 255 + (1 - a) * img.data[p + c]);
            }
        }
        ctx.putImageData(img, 0, 0);
        await source.add(f / frameRate, 1 / frameRate);
    }
    source.close();
    await output.finalize();

    const bytes = new Uint8Array(target.buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
})`;
