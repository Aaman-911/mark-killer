import { Engine } from './engine/engine.js';
import { downloadFilename, bytesToBase64, base64ToBytes } from './lib/naming.js';
import { getVeoWatermark } from './engine/videoTune.js';
import { buildAlpha } from './engine/tuner.js';
import { scoreBox } from './engine/detect.js';
import { DETECT_THRESHOLD } from './engine/engine.js';

const MENU_IMAGE = 'gemini-clean-image';
const MENU_VIDEO = 'gemini-clean-video';
const STUDIO_PAGE = 'src/studio.html';
const DEFAULT_SETTINGS = { hoverButton: 'gemini' };

let enginePromise = null;
function getEngine() {
    // The service worker can be torn down at any time, so the engine is built
    // lazily and cached only for the life of this worker.
    if (!enginePromise) {
        enginePromise = Engine.create().catch((err) => {
            enginePromise = null;
            throw err;
        });
    }
    return enginePromise;
}

/* ------------------------------------------------------------------ menu */

function installMenu() {
    chrome.contextMenus.removeAll(() => {
        chrome.contextMenus.create({
            id: MENU_IMAGE,
            title: 'Remove Gemini watermark',
            contexts: ['image'],
        });
        chrome.contextMenus.create({
            id: MENU_VIDEO,
            title: 'Remove Gemini watermark from video…',
            contexts: ['video'],
        });
    });
}

chrome.runtime.onInstalled.addListener(async () => {
    installMenu();
    const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
    await chrome.storage.sync.set({ ...DEFAULT_SETTINGS, ...stored });
});
chrome.runtime.onStartup.addListener(installMenu);

chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (!info.srcUrl) return;
    if (info.menuItemId === MENU_IMAGE) handleImage(info.srcUrl, tab?.id);
    if (info.menuItemId === MENU_VIDEO) openStudio(info.srcUrl, tab?.id);
});

/* ------------------------------------------------------------- studio */

// Video gets its own window rather than the toolbar popup, which the browser
// destroys the moment it loses focus — an export runs for minutes. A popup
// window keeps it out of the way of whatever tab you were on.
function openStudio(srcUrl, tabId) {
    const url = new URL(chrome.runtime.getURL(STUDIO_PAGE));
    if (srcUrl) url.searchParams.set('src', srcUrl);
    if (tabId !== undefined) url.searchParams.set('tab', String(tabId));
    // A panel-sized popup window, not a tab. It cannot live in the toolbar
    // popup itself: the browser destroys that the moment it loses focus, and
    // an export runs for minutes.
    return chrome.windows.create({
        url: url.toString(),
        type: 'popup',
        width: 560,
        height: 820,
        top: 60,
    });
}

/* --------------------------------------------------------------- loading */

async function blobToDataUrl(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return `data:${blob.type || 'image/png'};base64,${bytesToBase64(bytes)}`;
}

// blob: URLs belong to the page that created them and are invisible to this
// worker, and some hosts refuse a cookieless cross-origin fetch. In both cases
// the content script — which lives inside the page — can read the image for us.
async function loadViaPage(srcUrl, tabId) {
    if (tabId === undefined) throw new Error('image is not reachable from the background page');
    const reply = await chrome.tabs.sendMessage(tabId, { type: 'read-image', src: srcUrl });
    if (!reply?.ok) throw new Error(reply?.error || 'the page could not read that image');
    return new Blob([base64ToBytes(reply.data)], { type: reply.mime || 'image/png' });
}

async function loadImage(srcUrl, tabId) {
    if (srcUrl.startsWith('blob:')) return loadViaPage(srcUrl, tabId);
    try {
        const res = await fetch(srcUrl, { credentials: 'include' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.blob();
    } catch (err) {
        return loadViaPage(srcUrl, tabId);
    }
}

/* ---------------------------------------------------------------- notify */

async function notify(tabId, level, message) {
    const badge = { done: '✓', empty: '–', error: '!' }[level] || '';
    const colour = { done: '#16a34a', empty: '#64748b', error: '#dc2626' }[level] || '#64748b';
    chrome.action.setBadgeBackgroundColor({ color: colour });
    chrome.action.setBadgeText({ text: badge });
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 4000);

    if (tabId === undefined) return;
    try {
        await chrome.tabs.sendMessage(tabId, { type: 'toast', level, message });
    } catch {
        // No content script on this page (a PDF viewer, a chrome:// page, an
        // image opened directly). The badge above is the whole feedback then.
    }
}

/* ------------------------------------------------------------------ work */

async function handleImage(srcUrl, tabId) {
    try {
        const engine = await getEngine();
        const source = await loadImage(srcUrl, tabId);
        const result = await engine.clean(source);

        if (!result.detected) {
            await notify(tabId, 'empty', 'No Gemini watermark found in that image.');
            return { ok: true, detected: false, score: result.score };
        }

        await chrome.downloads.download({
            url: await blobToDataUrl(result.blob),
            filename: downloadFilename(srcUrl),
            saveAs: false,
        });

        await notify(tabId, 'done', 'Watermark removed — saved to your downloads.');
        return { ok: true, detected: true, score: result.score, variant: result.variant };
    } catch (err) {
        const message = err?.message || String(err);
        await notify(tabId, 'error', `Could not clean that image: ${message}`);
        return { ok: false, error: message };
    }
}

/* ------------------------------------------------------------ detecting */

// The hover button only appears once we know the mark is really there, so the
// page asks these two questions before showing anything.

async function detectImage(srcUrl, tabId) {
    const engine = await getEngine();
    const source = await loadImage(srcUrl, tabId);
    return engine.inspect(source);
}

// A page cannot read the pixels of a cross-origin image, but it can crop the
// current frame of a video it is already playing. It sends just that crop.
async function detectRegion(pngDataUrl, box) {
    const engine = await getEngine();
    const bitmap = await createImageBitmap(await (await fetch(pngDataUrl)).blob());

    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();

    const frame = { x: 0, y: 0, width: box.width, height: box.height, size: box.size };
    const template = buildAlpha(engine.bg96, frame, frame, 1);
    const score = scoreBox(ctx.getImageData(0, 0, canvas.width, canvas.height), template, frame);

    return { detected: score >= DETECT_THRESHOLD, score };
}

/* -------------------------------------------------------------- messages */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'clean-image') {
        handleImage(msg.src, sender.tab?.id).then(sendResponse);
        return true;
    }
    if (msg?.type === 'detect-image') {
        detectImage(msg.src, sender.tab?.id)
            .then((r) => sendResponse({ ok: true, ...r }))
            .catch((err) => sendResponse({ ok: false, error: err.message }));
        return true;
    }
    if (msg?.type === 'video-region') {
        sendResponse({ ok: true, box: getVeoWatermark(msg.width, msg.height) });
        return false;
    }
    if (msg?.type === 'detect-region') {
        detectRegion(msg.png, msg.box)
            .then((r) => sendResponse({ ok: true, ...r }))
            .catch((err) => sendResponse({ ok: false, error: err.message }));
        return true;
    }
    if (msg?.type === 'open-studio') {
        openStudio(msg.src, msg.tabId ?? sender.tab?.id)
            .then(() => sendResponse({ ok: true }))
            .catch((err) => sendResponse({ ok: false, error: err.message }));
        return true;
    }
    if (msg?.type === 'download') {
        chrome.downloads
            .download({ url: msg.url, filename: msg.filename, saveAs: false })
            .then((id) => sendResponse({ ok: true, id }))
            .catch((err) => sendResponse({ ok: false, error: err.message }));
        return true;
    }
    return false;
});
