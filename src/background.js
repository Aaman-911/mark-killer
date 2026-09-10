import { Engine } from './engine/engine.js';
import { downloadFilename, bytesToBase64, base64ToBytes } from './lib/naming.js';

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

// Video is cleaned on its own page, not here: an export runs for minutes and a
// service worker is not allowed to live that long.
function openStudio(srcUrl, tabId) {
    const url = new URL(chrome.runtime.getURL(STUDIO_PAGE));
    if (srcUrl) url.searchParams.set('src', srcUrl);
    if (tabId !== undefined) url.searchParams.set('tab', String(tabId));
    return chrome.tabs.create({ url: url.toString() });
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

/* -------------------------------------------------------------- messages */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'clean-image') {
        handleImage(msg.src, sender.tab?.id).then(sendResponse);
        return true;
    }
    if (msg?.type === 'open-studio') {
        openStudio(msg.src, msg.tabId)
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
