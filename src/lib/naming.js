// Pure helpers used by the service worker. Kept free of chrome.* and DOM APIs
// so they can be unit tested outside the browser.

export const DOWNLOAD_FOLDER = 'gemini-watermark-remover';

/**
 * Where a cleaned image should be saved, given where it came from.
 * Falls back to a timestamped name for blob:, data: and unusable URLs.
 */
export function downloadFilename(srcUrl, now = Date.now()) {
    let base = '';
    try {
        if (/^https?:/i.test(srcUrl)) {
            const path = new URL(srcUrl).pathname;
            base = decodeURIComponent(path.split('/').pop() || '');
            base = base.replace(/\.[a-z0-9]+$/i, '');
        }
    } catch { /* fall through to the timestamped name */ }

    base = base.replace(/[^a-z0-9._-]+/gi, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60);
    if (!base) base = `gemini-${now}`;
    return `${DOWNLOAD_FOLDER}/${base}-clean.png`;
}

const B64_CHUNK = 0x8000;

export function bytesToBase64(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i += B64_CHUNK) {
        out += String.fromCharCode.apply(null, bytes.subarray(i, i + B64_CHUNK));
    }
    return btoa(out);
}

export function base64ToBytes(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}
