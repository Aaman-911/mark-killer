// The video page. Opened from the right-click menu on a video, or from the
// toolbar popup. Long-lived on purpose: a popup would be torn down mid-export.

import { Engine } from './engine/engine.js';
import { cleanFrame, resolveBox, getRoi } from './engine/tuner.js';
import { autoFit, getVeoWatermark } from './engine/videoTune.js';
import { cleanVideo, grabFrame, isVideoSupported, canEncode, VIDEO_DEFAULTS } from './engine/videoEngine.js';
import { downloadFilename } from './lib/naming.js';

const els = {
    title: document.getElementById('title'),
    topline: document.getElementById('topline'),
    fitNote: document.getElementById('fit-note'),
    intake: document.getElementById('intake'),
    intakeNote: document.getElementById('intake-note'),
    drop: document.getElementById('drop'),
    picker: document.getElementById('picker'),
    workspace: document.getElementById('workspace'),
    preview: document.getElementById('preview'),
    zoom: document.getElementById('zoom'),
    showOriginal: document.getElementById('show-original'),
    time: document.getElementById('time'),
    meta: document.getElementById('meta'),
    autofit: document.getElementById('autofit'),
    process: document.getElementById('process'),
    cancel: document.getElementById('cancel'),
    progressWrap: document.getElementById('progress-wrap'),
    barFill: document.getElementById('bar-fill'),
    progressText: document.getElementById('progress-text'),
    result: document.getElementById('result'),
    resultVideo: document.getElementById('result-video'),
    resultNote: document.getElementById('result-note'),
    save: document.getElementById('save'),
    error: document.getElementById('error'),
};

const SLIDERS = ['gain', 'offsetX', 'offsetY', 'sizeScale'];
const state = {
    file: null,
    sourceName: 'video',
    sparkle: null,
    frame: null,        // { imageData, width, height, duration }
    settings: { ...VIDEO_DEFAULTS },
    controller: null,
    output: null,
};

/* ------------------------------------------------------------- helpers */

function fail(message) {
    els.error.textContent = message;
    els.error.hidden = false;
}

function clearError() {
    els.error.hidden = true;
}

function formatSeconds(value) {
    if (!Number.isFinite(value)) return '';
    const minutes = Math.floor(value / 60);
    const seconds = Math.round(value % 60);
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatSize(bytes) {
    const mb = bytes / (1024 * 1024);
    return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

/* ------------------------------------------------------------- preview */

function drawPreview() {
    const { frame, settings, sparkle } = state;
    if (!frame) return;

    const { width, height } = frame;
    els.preview.width = width;
    els.preview.height = height;
    const ctx = els.preview.getContext('2d', { willReadFrequently: true });

    const working = new ImageData(new Uint8ClampedArray(frame.imageData.data), width, height);
    const base = getVeoWatermark(width, height);
    const wm = resolveBox(base, width, height, settings);
    const roi = getRoi(width, height, wm);

    if (!els.showOriginal.checked) cleanFrame(sparkle, working, width, height, base, settings);
    ctx.putImageData(working, 0, 0);

    // Outline where the removal is confined to.
    ctx.strokeStyle = 'rgba(242, 180, 65, .95)';
    ctx.lineWidth = Math.max(1, Math.round(Math.min(width, height) / 400));
    ctx.strokeRect(wm.x + .5, wm.y + .5, wm.width, wm.height);

    // Close-up, so small changes are actually visible.
    const zoomCtx = els.zoom.getContext('2d');
    const side = Math.max(roi.width, roi.height);
    els.zoom.width = side;
    els.zoom.height = side;
    zoomCtx.imageSmoothingEnabled = false;
    zoomCtx.fillStyle = '#000';
    zoomCtx.fillRect(0, 0, side, side);
    zoomCtx.drawImage(els.preview, roi.x, roi.y, roi.width, roi.height,
        (side - roi.width) / 2, (side - roi.height) / 2, roi.width, roi.height);

    els.meta.textContent = `${width}×${height}  ${formatSeconds(frame.duration)}  mark ${wm.size}px @ ${wm.x},${wm.y}`;
}

function syncSliders() {
    for (const key of SLIDERS) {
        const input = document.getElementById(key);
        input.value = state.settings[key];
        const out = document.getElementById(`${key}-out`);
        out.textContent = key === 'gain' ? Number(state.settings[key]).toFixed(2)
            : key === 'sizeScale' ? `${Number(state.settings[key]).toFixed(2)}×`
            : `${Math.round(state.settings[key])}px`;
    }
}

async function showFrameAt(seconds) {
    state.frame = await grabFrame(state.file, seconds);
    drawPreview();
}

function runAutoFit() {
    if (!state.frame) return;
    const { imageData, width, height } = state.frame;
    const fit = autoFit(state.sparkle, imageData, width, height);
    state.settings = {
        gain: Number(fit.gain.toFixed(2)),
        offsetX: fit.offsetX,
        offsetY: fit.offsetY,
        sizeScale: Number(fit.sizeScale.toFixed(2)),
    };
    syncSliders();
    drawPreview();

    const confidence = Math.round(Math.max(0, Math.min(1, fit.score)) * 100);
    els.fitNote.textContent = confidence >= 60
        ? `Found the sparkle, ${confidence}% match. Adjust below if the corner still looks off.`
        : `Only a ${confidence}% match — this clip may not carry the mark. Check the corner before exporting.`;
}

/* ---------------------------------------------------------------- load */

async function load(file, label) {
    clearError();
    state.file = file;
    state.sourceName = label || file.name || 'video';

    els.intake.hidden = true;
    els.workspace.hidden = false;
    els.title.textContent = state.sourceName;
    els.topline.textContent = 'Nothing is uploaded.';

    try {
        await showFrameAt(0.5);
    } catch (err) {
        els.intake.hidden = false;
        els.workspace.hidden = true;
        fail(err.message);
        return;
    }

    els.time.max = String(Math.max(1, Math.floor((state.frame.duration || 1) * 10)));
    els.time.value = String(Math.min(5, Number(els.time.max)));
    runAutoFit();
}

/* ------------------------------------------------------------- exports */

async function process() {
    clearError();
    state.controller = new AbortController();
    els.process.disabled = true;
    els.cancel.hidden = false;
    els.result.hidden = true;
    els.progressWrap.hidden = false;
    els.barFill.style.width = '0%';
    els.progressText.textContent = 'Decoding…';

    const started = Date.now();
    try {
        const output = await cleanVideo(state.file, state.sparkle, {
            ...state.settings,
            signal: state.controller.signal,
            onProgress: ({ progress, frames }) => {
                els.barFill.style.width = `${Math.round(progress * 100)}%`;
                els.progressText.textContent = `${Math.round(progress * 100)}%  ${frames} frames`;
            },
        });

        state.output = output;
        els.resultVideo.src = URL.createObjectURL(output.blob);
        els.resultNote.textContent = `${output.frames} frames, ${formatSize(output.blob.size)}, `
            + `${output.audio ? 'audio copied across' : 'no audio track'}, `
            + `${Math.round((Date.now() - started) / 1000)}s.`;
        els.result.hidden = false;
        els.progressText.textContent = 'Done.';
        els.topline.textContent = 'Cleaned. Save it below.';
    } catch (err) {
        if (err?.name === 'AbortError') {
            els.progressText.textContent = 'Stopped. Nothing was saved.';
        } else {
            fail(err.message);
            els.progressWrap.hidden = true;
        }
    } finally {
        state.controller = null;
        els.process.disabled = false;
        els.cancel.hidden = true;
    }
}

async function save() {
    if (!state.output) return;
    const name = downloadFilename(`https://local/${state.sourceName}`).replace(/\.png$/, '.mp4');
    await chrome.downloads.download({
        url: URL.createObjectURL(state.output.blob),
        filename: name,
        saveAs: false,
    });
    els.resultNote.textContent += ' Saved to your downloads.';
}

/* ------------------------------------------- reading a page's blob URL */

// A blob: URL belongs to the page that made it, so the page has to read it for
// us. The content script streams the bytes back in chunks over a port.
function readFromTab(tabId, src) {
    return new Promise((resolve, reject) => {
        const port = chrome.tabs.connect(tabId, { name: 'gwr-video' });
        const chunks = [];
        let total = 0;

        port.onMessage.addListener((msg) => {
            if (msg.type === 'chunk') {
                const binary = atob(msg.data);
                const bytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                chunks.push(bytes);
                total += bytes.length;
                els.intakeNote.hidden = false;
                els.intakeNote.textContent = `Reading from the page… ${formatSize(total)}`;
            } else if (msg.type === 'done') {
                port.disconnect();
                resolve(new Blob(chunks, { type: msg.mime || 'video/mp4' }));
            } else if (msg.type === 'error') {
                port.disconnect();
                reject(new Error(msg.error));
            }
        });
        port.onDisconnect.addListener(() => reject(new Error('The page stopped responding.')));
        port.postMessage({ type: 'read', src });
    });
}

/* -------------------------------------------------------------- wiring */

els.picker.addEventListener('change', () => {
    if (els.picker.files[0]) load(els.picker.files[0]);
});
els.drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); els.picker.click(); }
});
['dragenter', 'dragover'].forEach((type) =>
    els.drop.addEventListener(type, (e) => { e.preventDefault(); els.drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((type) =>
    els.drop.addEventListener(type, (e) => { e.preventDefault(); els.drop.classList.remove('over'); }));
els.drop.addEventListener('drop', (e) => {
    const file = [...e.dataTransfer.files].find((f) => f.type.startsWith('video/'));
    if (file) load(file);
});

for (const key of SLIDERS) {
    document.getElementById(key).addEventListener('input', (e) => {
        state.settings[key] = Number(e.target.value);
        syncSliders();
        drawPreview();
    });
}

els.showOriginal.addEventListener('change', drawPreview);
els.autofit.addEventListener('click', runAutoFit);
els.process.addEventListener('click', process);
els.cancel.addEventListener('click', () => state.controller?.abort());
els.save.addEventListener('click', save);

let scrubTimer = null;
els.time.addEventListener('input', () => {
    clearTimeout(scrubTimer);
    scrubTimer = setTimeout(async () => {
        try {
            await showFrameAt(Number(els.time.value) / 10);
        } catch (err) {
            fail(err.message);
        }
    }, 180);
});

/* ---------------------------------------------------------------- boot */

async function boot() {
    if (!isVideoSupported() || !(await canEncode())) {
        fail('This browser cannot encode H.264 video locally. Chrome or Edge on desktop can.');
        els.process.disabled = true;
    }

    state.sparkle = (await Engine.create()).bg96;

    const params = new URLSearchParams(location.search);
    const src = params.get('src');
    const tabId = Number(params.get('tab'));

    if (!src) return;
    els.intakeNote.hidden = false;
    els.intakeNote.textContent = 'Fetching the video…';

    try {
        const blob = src.startsWith('blob:')
            ? await readFromTab(tabId, src)
            : await (await fetch(src, { credentials: 'include' })).blob();
        const name = decodeURIComponent(src.split('/').pop().split('?')[0]) || 'video';
        await load(new File([blob], name, { type: blob.type || 'video/mp4' }), name);
    } catch (err) {
        els.intakeNote.hidden = false;
        els.intakeNote.textContent = `Could not fetch that video (${err.message}). Drop the file here instead.`;
    }
}

boot();
