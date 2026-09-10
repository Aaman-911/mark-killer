// Is the Gemini sparkle actually present in this box?
//
// The watermark is a white overlay, so inside the sparkle box the pixels that
// the template says are opaque should be brighter than the pixels the template
// says are transparent. We measure that as a Pearson correlation between the
// template alpha and the pixel luma. A real watermark scores high; a random
// bright corner does not, because it will not match the sparkle's exact shape.

const LUMA_R = 0.2126, LUMA_G = 0.7152, LUMA_B = 0.0722;

export function scoreBox(imageData, alphaTemplate, box) {
    const { x, y, width, height } = box;
    const n = width * height;
    if (n === 0) return 0;

    let sumA = 0, sumL = 0;
    const luma = new Float32Array(n);

    for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
            const i = row * width + col;
            const p = ((y + row) * imageData.width + (x + col)) * 4;
            const l = LUMA_R * imageData.data[p] + LUMA_G * imageData.data[p + 1] + LUMA_B * imageData.data[p + 2];
            luma[i] = l;
            sumL += l;
            sumA += alphaTemplate[i];
        }
    }

    const meanA = sumA / n, meanL = sumL / n;
    let cov = 0, varA = 0, varL = 0;
    for (let i = 0; i < n; i++) {
        const da = alphaTemplate[i] - meanA;
        const dl = luma[i] - meanL;
        cov += da * dl;
        varA += da * da;
        varL += dl * dl;
    }

    if (varA === 0 || varL === 0) return 0;
    return cov / Math.sqrt(varA * varL);
}
