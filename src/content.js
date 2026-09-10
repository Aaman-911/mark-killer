// Runs inside every page. Three jobs:
//   1. read images the background worker cannot reach on its own (blob: URLs)
//   2. show the little "clean" button when you hover a big image
//   3. show toasts for whatever the background worker just did
//
// All of its UI lives in a shadow root so page CSS cannot touch it and its
// CSS cannot touch the page.

const GEMINI_HOSTS = ['gemini.google.com', 'aistudio.google.com', 'labs.google'];
const MIN_IMAGE_SIZE = 256;

let settings = { hoverButton: 'gemini' };
let ui = null;
let hovered = null;

/* ------------------------------------------------------------------- ui */

function buildUi() {
    if (ui) return ui;

    const host = document.createElement('div');
    host.id = 'gemini-watermark-remover-root';
    host.style.cssText = 'all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;';
    const root = host.attachShadow({ mode: 'closed' });

    root.innerHTML = `
        <style>
            :host { all: initial; }
            .btn {
                position: fixed; display: none; align-items: center; gap: 6px;
                padding: 6px 10px; border: 0; border-radius: 8px;
                font: 600 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
                color: #fff; background: #1e1b4b; cursor: pointer;
                box-shadow: 0 2px 10px rgba(0,0,0,.35); pointer-events: auto;
            }
            .btn:hover { background: #312e81; }
            .btn[data-busy="true"] { opacity: .7; cursor: progress; }
            .toasts {
                position: fixed; right: 16px; bottom: 16px;
                display: flex; flex-direction: column; gap: 8px; align-items: flex-end;
            }
            .toast {
                max-width: 320px; padding: 10px 14px; border-radius: 10px;
                font: 500 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
                color: #fff; background: #1f2937; box-shadow: 0 4px 16px rgba(0,0,0,.3);
            }
            .toast[data-level="done"]  { background: #166534; }
            .toast[data-level="empty"] { background: #334155; }
            .toast[data-level="error"] { background: #991b1b; }
        </style>
        <button class="btn" type="button">✦ Clean</button>
        <div class="toasts"></div>
    `;

    (document.body || document.documentElement).appendChild(host);

    ui = {
        host,
        button: root.querySelector('.btn'),
        toasts: root.querySelector('.toasts'),
    };

    ui.button.addEventListener('click', onCleanClick);
    ui.button.addEventListener('mouseenter', () => clearTimeout(ui.hideTimer));
    ui.button.addEventListener('mouseleave', scheduleHide);
    return ui;
}

function toast(level, message) {
    const { toasts } = buildUi();
    const el = document.createElement('div');
    el.className = 'toast';
    el.dataset.level = level;
    el.textContent = message;
    toasts.appendChild(el);
    setTimeout(() => el.remove(), 5000);
}

/* --------------------------------------------------------- hover button */

function hoverEnabled() {
    if (settings.hoverButton === 'off') return false;
    if (settings.hoverButton === 'all') return true;
    return GEMINI_HOSTS.some((h) => location.hostname === h || location.hostname.endsWith(`.${h}`));
}

function bigEnough(img) {
    return img.naturalWidth >= MIN_IMAGE_SIZE && img.naturalHeight >= MIN_IMAGE_SIZE;
}

function placeButton(img) {
    const { button } = buildUi();
    const r = img.getBoundingClientRect();
    if (r.width < 80 || r.height < 40) { hideButton(); return; }
    button.style.display = 'inline-flex';
    button.style.top = `${Math.max(8, r.top + 8)}px`;
    button.style.left = `${Math.max(8, r.right - button.offsetWidth - 8)}px`;
}

function hideButton() {
    if (!ui) return;
    ui.button.style.display = 'none';
    ui.button.dataset.busy = 'false';
    ui.button.textContent = '✦ Clean';
    hovered = null;
}

function scheduleHide() {
    if (!ui) return;
    clearTimeout(ui.hideTimer);
    ui.hideTimer = setTimeout(hideButton, 350);
}

function onPointerOver(event) {
    if (!hoverEnabled()) return;
    const img = event.target;
    if (!(img instanceof HTMLImageElement) || !bigEnough(img)) return;
    clearTimeout(ui?.hideTimer);
    hovered = img;
    placeButton(img);
}

function onPointerOut(event) {
    if (event.target === hovered) scheduleHide();
}

async function onCleanClick() {
    if (!hovered || ui.button.dataset.busy === 'true') return;
    const src = hovered.currentSrc || hovered.src;
    ui.button.dataset.busy = 'true';
    ui.button.textContent = '✦ Working…';
    try {
        await chrome.runtime.sendMessage({ type: 'clean-image', src });
    } catch (err) {
        toast('error', `Could not reach the extension: ${err.message}`);
    } finally {
        if (ui) {
            ui.button.dataset.busy = 'false';
            ui.button.textContent = '✦ Clean';
        }
    }
}

/* --------------------------------------------------------- page reading */

function readImage(src) {
    return fetch(src, { credentials: 'include' })
        .then((res) => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.blob();
        })
        .then((blob) => new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(new Error('could not read the image data'));
            reader.onload = () => resolve({
                ok: true,
                mime: blob.type || 'image/png',
                data: String(reader.result).split(',')[1],
            });
            reader.readAsDataURL(blob);
        }));
}

/* ---------------------------------------------------------------- wiring */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'toast') {
        toast(msg.level, msg.message);
        sendResponse({ ok: true });
        return false;
    }
    if (msg?.type === 'read-image') {
        readImage(msg.src)
            .then(sendResponse)
            .catch((err) => sendResponse({ ok: false, error: err.message }));
        return true;
    }
    return false;
});

chrome.storage.sync.get(settings).then((stored) => { settings = { ...settings, ...stored }; });
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes.hoverButton) return;
    settings.hoverButton = changes.hoverButton.newValue;
    if (!hoverEnabled()) hideButton();
});

document.addEventListener('pointerover', onPointerOver, true);
document.addEventListener('pointerout', onPointerOut, true);
window.addEventListener('scroll', () => { if (hovered) placeButton(hovered); }, true);
window.addEventListener('resize', () => { if (hovered) placeButton(hovered); });
