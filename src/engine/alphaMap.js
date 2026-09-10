export function calculateAlphaMap(bgCaptureImageData) {
    const { width, height, data } = bgCaptureImageData;
    const alphaMap = new Float32Array(width * height);
    for (let i = 0; i < alphaMap.length; i++) {
        const idx = i * 4;
        // Normalize max channel to 0-1
        alphaMap[i] = Math.max(data[idx], data[idx + 1], data[idx + 2]) / 255.0;
    }
    return alphaMap;
}