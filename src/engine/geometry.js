// Pure (DOM-free) watermark geometry. Shared by the browser image engine and
// the Cloudflare Worker MCP server.
//
// Gemini places the visible sparkle watermark in the bottom-right corner:
//   - 96px logo with a 64px margin for images larger than 1024×1024
//   - 48px logo with a 32px margin otherwise
// Newer Gemini images use a noticeably smaller mark tucked into the
// bottom-right corner. Measured on a 1408x768 sample: a 24px sparkle with a
// 48px margin — i.e. size = shortSide/32 and margin = shortSide/16, so this
// scales with the image instead of using fixed pixel offsets.
export function getCompactWatermarkInfo(width, height) {
    const base = Math.min(width, height);
    const size = Math.max(8, Math.round(base / 32));
    const margin = Math.round(base / 16);

    return {
        size,
        x: Math.max(0, width - margin - size),
        y: Math.max(0, height - margin - size),
        width: size,
        height: size,
    };
}

export function getWatermarkInfo(width, height) {
    const isLarge = width > 1024 && height > 1024;
    const size = isLarge ? 96 : 48;
    const margin = isLarge ? 64 : 32;

    return {
        size,
        x: width - margin - size,
        y: height - margin - size,
        width: size,
        height: size,
    };
}
