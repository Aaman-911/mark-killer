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
                position: fixed; display: none; align-items: center; gap: 9px;
                padding: 5px 15px 5px 5px; border: 1px solid rgba(255,255,255,.16);
                border-radius: 999px;
                font: 600 14px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
                letter-spacing: .2px; color: #fff; cursor: pointer; pointer-events: auto;
                background: rgba(18,18,24,.72);
                -webkit-backdrop-filter: blur(12px) saturate(140%);
                backdrop-filter: blur(12px) saturate(140%);
                box-shadow: 0 6px 22px rgba(0,0,0,.38), inset 0 1px 0 rgba(255,255,255,.10);
                transition: background .15s ease, transform .15s ease;
            }
            .btn:hover { background: rgba(30,30,40,.86); transform: translateY(-1px); }
            .btn:active { transform: translateY(0); }
            .btn[data-busy="true"] { opacity: .75; cursor: progress; transform: none; }
            .mark {
                display: inline-flex; align-items: center; justify-content: center;
                width: 26px; height: 26px; border-radius: 50%;
                background: rgba(255,255,255,.15); font-size: 14px; line-height: 1;
            }
            .btn[data-busy="true"] .mark { animation: pulse 1s ease-in-out infinite; }
            @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .45; } }
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
        <button class="btn" type="button"><span class="mark">&#10022;</span><span class="label">Clean</span></button>
        <div class="toasts"></div>
    `;

    (document.body || document.documentElement).appendChild(host);

    ui = {
        host,
        button: root.querySelector('.btn'),
        label: root.querySelector('.label'),
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
    // Centred near the top of the image, clamped so it stays on screen.
    const width = button.offsetWidth;
    const left = r.left + (r.width - width) / 2;
    button.style.left = `${Math.min(Math.max(8, left), window.innerWidth - width - 8)}px`;
    button.style.top = `${Math.min(Math.max(8, r.top + 12), window.innerHeight - button.offsetHeight - 8)}px`;
}

function hideButton() {
    if (!ui) return;
    ui.button.style.display = 'none';
    ui.button.dataset.busy = 'false';
    ui.label.textContent = 'Clean';
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
    ui.label.textContent = 'Working…';
    try {
        await chrome.runtime.sendMessage({ type: 'clean-image', src });
    } catch (err) {
        toast('error', `Could not reach the extension: ${err.message}`);
    } finally {
        if (ui) {
            ui.button.dataset.busy = 'false';
            ui.label.textContent = 'Clean';
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

/* ------------------------------------------------- streaming a blob out */

// A blob: URL only resolves inside the page that created it, so the video page
// cannot fetch one itself. It opens a port here and we send the bytes over in
// chunks — base64, because extension messages carry JSON, not binary.
const CHUNK = 512 * 1024;

chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'gwr-video') return;

    port.onMessage.addListener(async (msg) => {
        if (msg?.type !== 'read') return;
        try {
            const res = await fetch(msg.src, { credentials: 'include' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const blob = await res.blob();
            const buffer = new Uint8Array(await blob.arrayBuffer());

            for (let offset = 0; offset < buffer.length; offset += CHUNK) {
                const slice = buffer.subarray(offset, offset + CHUNK);
                let binary = '';
                for (let i = 0; i < slice.length; i++) binary += String.fromCharCode(slice[i]);
                port.postMessage({ type: 'chunk', data: btoa(binary) });
            }
            port.postMessage({ type: 'done', mime: blob.type || 'video/mp4' });
        } catch (err) {
            port.postMessage({ type: 'error', error: err.message });
        }
    });
});

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
