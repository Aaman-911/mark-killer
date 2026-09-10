// The video controls, rendered wherever they are needed: inside the toolbar
// panel, and inside the standalone window used as a fallback.
//
// Only the preview work happens here. The export itself is handed to an
// offscreen document, because this panel is destroyed the moment it loses
// focus and an export runs for minutes.

import { Engine } from './engine/engine.js';
import { cleanFrame, resolveBox, getRoi } from './engine/tuner.js';
import { autoFit, getVeoWatermark } from './engine/videoTune.js';
import { grabFrame, isVideoSupported, canEncode, VIDEO_DEFAULTS } from './engine/videoEngine.js';
import { putBlob, readJob, clearJob, JOB_KEY } from './lib/jobstore.js';

const SLIDERS = [
    ['gain', 'Strength', 0.1, 1, 0.01],
    ['offsetX', 'Left / right', -120, 120, 1],
    ['offsetY', 'Up / down', -120, 120, 1],
    ['sizeScale', 'Size', 0.4, 2, 0.01],
];

const TEMPLATE = `
<div class="vv">
  <section class="vv-intake">
    <label class="vv-drop checker" tabindex="0">
      <span class="vv-drop-mark">&#9654;</span>
      <span class="vv-drop-title">Drop a video</span>
      <span class="vv-drop-hint tiny muted">or click to choose &mdash; MP4, WebM, MOV</span>
      <input class="vv-picker" type="file" accept="video/*" hidden />
    </label>
    <p class="vv-note tiny muted" hidden></p>
  </section>

  <section class="vv-work" hidden>
    <div class="vv-frame checker">
      <canvas class="vv-preview"></canvas>
      <figure class="vv-closeup">
        <canvas class="vv-zoom"></canvas>
        <figcaption class="eyebrow">the corner</figcaption>
      </figure>
    </div>

    <div class="vv-stagebar">
      <label class="vv-toggle tiny"><input type="checkbox" class="vv-original" /> original</label>
      <input type="range" class="vv-time" min="0" max="100" value="10" />
      <span class="vv-meta num tiny muted"></span>
    </div>

    <p class="vv-fit tiny muted"></p>
    <div class="vv-sliders"></div>

    <button type="button" class="vv-go btn-mark">Clean the video</button>
    <button type="button" class="vv-stop btn-quiet" hidden>Stop</button>

    <div class="vv-progress" hidden>
      <div class="vv-bar"><div class="vv-fill"></div></div>
      <p class="vv-progress-text num tiny muted"></p>
    </div>

    <p class="vv-error tiny" hidden></p>
  </section>
</div>`;

export async function mountVideoView(container) {
    container.innerHTML = TEMPLATE;
    const q = (cls) => container.querySelector(`.${cls}`);

    const el = {
        intake: q('vv-intake'), drop: q('vv-drop'), picker: q('vv-picker'), note: q('vv-note'),
        work: q('vv-work'), preview: q('vv-preview'), zoom: q('vv-zoom'),
        original: q('vv-original'), time: q('vv-time'), meta: q('vv-meta'),
        fit: q('vv-fit'), sliders: q('vv-sliders'),
        go: q('vv-go'), stop: q('vv-stop'),
        progress: q('vv-progress'), fill: q('vv-fill'), progressText: q('vv-progress-text'),
        error: q('vv-error'),
    };

    const state = { file: null, name: 'video', frame: null, sparkle: null, settings: { ...VIDEO_DEFAULTS } };
    const inputs = new Map();

    /* ------------------------------------------------------------ chrome */

    const fail = (message) => { el.error.textContent = message; el.error.hidden = false; };
    const clear = () => { el.error.hidden = true; };
    const bytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);
    const clock = (s) => (Number.isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : '');

    /* ----------------------------------------------------------- sliders */

    for (const [key, label, min, max, step] of SLIDERS) {
        const wrap = document.createElement('label');
        wrap.className = 'vv-slider';
        wrap.innerHTML = `<span>${label}</span><output class="num"></output>`;
        const input = document.createElement('input');
        Object.assign(input, { type: 'range', min, max, step });
        input.addEventListener('input', () => {
            state.settings[key] = Number(input.value);
            syncSliders();
            draw();
        });
        wrap.append(input);
        el.sliders.append(wrap);
        inputs.set(key, { input, output: wrap.querySelector('output') });
    }

    function syncSliders() {
        for (const [key] of SLIDERS) {
            const { input, output } = inputs.get(key);
            input.value = state.settings[key];
            output.textContent = key === 'gain' ? Number(state.settings[key]).toFixed(2)
                : key === 'sizeScale' ? `${Number(state.settings[key]).toFixed(2)}×`
                : `${Math.round(state.settings[key])}px`;
        }
    }

    /* ----------------------------------------------------------- preview */

    function draw() {
        const { frame, settings, sparkle } = state;
        if (!frame) return;

        const { width, height } = frame;
        el.preview.width = width;
        el.preview.height = height;
        const ctx = el.preview.getContext('2d', { willReadFrequently: true });

        const working = new ImageData(new Uint8ClampedArray(frame.imageData.data), width, height);
        const base = getVeoWatermark(width, height);
        const wm = resolveBox(base, width, height, settings);
        const roi = getRoi(width, height, wm);

        if (!el.original.checked) cleanFrame(sparkle, working, width, height, base, settings);
        ctx.putImageData(working, 0, 0);

        ctx.strokeStyle = 'rgba(242, 180, 65, .95)';
        ctx.lineWidth = Math.max(1, Math.round(Math.min(width, height) / 400));
        ctx.strokeRect(wm.x + .5, wm.y + .5, wm.width, wm.height);

        const side = Math.max(roi.width, roi.height);
        el.zoom.width = side;
        el.zoom.height = side;
        const zoom = el.zoom.getContext('2d');
        zoom.imageSmoothingEnabled = false;
        zoom.drawImage(el.preview, roi.x, roi.y, roi.width, roi.height,
            (side - roi.width) / 2, (side - roi.height) / 2, roi.width, roi.height);

        el.meta.textContent = `${width}×${height}  ${clock(frame.duration)}  ${wm.size}px`;
    }

    function runAutoFit() {
        if (!state.frame) return;
        const { imageData, width, height } = state.frame;
        const found = autoFit(state.sparkle, imageData, width, height);
        state.settings = {
            gain: Number(found.gain.toFixed(2)),
            offsetX: found.offsetX,
            offsetY: found.offsetY,
            sizeScale: Number(found.sizeScale.toFixed(2)),
        };
        syncSliders();
        draw();

        const match = Math.round(Math.max(0, Math.min(1, found.score)) * 100);
        el.fit.textContent = match >= 60
            ? `Found the sparkle, ${match}% match. Nudge it below if the corner still looks off.`
            : `Only a ${match}% match — check the corner before exporting.`;
    }

    /* -------------------------------------------------------------- load */

    async function load(file, label) {
        clear();
        state.file = file;
        state.name = label || file.name || 'video';
        el.intake.hidden = true;
        el.work.hidden = false;

        try {
            state.frame = await grabFrame(file, 0.5);
        } catch (err) {
            el.intake.hidden = false;
            el.work.hidden = true;
            fail(err.message);
            return;
        }

        el.time.max = String(Math.max(1, Math.floor((state.frame.duration || 1) * 10)));
        el.time.value = String(Math.min(5, Number(el.time.max)));
        runAutoFit();
    }

    /* ------------------------------------------------------------ export */

    function paint(job) {
        if (!job) return;
        const working = job.stage === 'working';
        el.progress.hidden = false;
        el.go.disabled = working;
        el.stop.hidden = !working;

        if (working) {
            el.fill.style.width = `${Math.round((job.progress || 0) * 100)}%`;
            el.progressText.textContent = `${Math.round((job.progress || 0) * 100)}%  ${job.frames || 0} frames`;
        } else if (job.stage === 'done') {
            el.fill.style.width = '100%';
            el.progressText.textContent =
                `Saved. ${job.frames} frames, ${bytes(job.bytes)}, ${job.audio ? 'audio kept' : 'no audio'}, ${job.seconds}s.`;
        } else if (job.stage === 'stopped') {
            el.fill.style.width = '0%';
            el.progressText.textContent = 'Stopped. Nothing was saved.';
        } else if (job.stage === 'failed') {
            el.fill.style.width = '0%';
            el.progressText.textContent = '';
            fail(job.error || 'The export failed.');
        }
    }

    el.go.addEventListener('click', async () => {
        if (!state.file) return;
        clear();
        el.go.disabled = true;
        el.progress.hidden = false;
        el.progressText.textContent = 'Handing it over…';

        try {
            await putBlob(JOB_KEY, state.file);
            const reply = await chrome.runtime.sendMessage({
                type: 'start-export',
                name: state.name,
                settings: state.settings,
            });
            if (reply === undefined) {
                // Nothing answered: the background worker is not running the
                // same build as this panel, or it failed to start.
                throw new Error('The background worker did not answer. Reload the extension '
                    + `on chrome://extensions (this panel is v${chrome.runtime.getManifest().version}).`);
            }
            if (!reply.ok) throw new Error(reply.error || 'The export could not be started.');
            el.progressText.textContent = 'Decoding…';
            el.stop.hidden = false;
        } catch (err) {
            el.go.disabled = false;
            fail(err.message);
        }
    });

    el.stop.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'stop-export' }));

    chrome.runtime.onMessage.addListener((msg) => {
        if (msg?.type === 'video-job') paint(msg.job);
        return false;
    });

    /* ------------------------------------------------------------ intake */

    el.picker.addEventListener('change', () => { if (el.picker.files[0]) load(el.picker.files[0]); });
    el.drop.addEventListener('click', () => el.picker.click());
    el.drop.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.picker.click(); }
    });
    ['dragenter', 'dragover'].forEach((t) =>
        el.drop.addEventListener(t, (e) => { e.preventDefault(); el.drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((t) =>
        el.drop.addEventListener(t, (e) => { e.preventDefault(); el.drop.classList.remove('over'); }));
    el.drop.addEventListener('drop', (e) => {
        const file = [...e.dataTransfer.files].find((f) => f.type.startsWith('video/'));
        if (file) load(file);
    });

    el.original.addEventListener('change', draw);

    let scrub = null;
    el.time.addEventListener('input', () => {
        clearTimeout(scrub);
        scrub = setTimeout(async () => {
            try {
                state.frame = await grabFrame(state.file, Number(el.time.value) / 10);
                draw();
            } catch (err) { fail(err.message); }
        }, 180);
    });

    /* ----------------------------------------- a video handed over by the page */

    // A blob: URL only resolves inside the page that made it, so that page
    // streams the bytes back over a port.
    function readFromTab(tabId, src) {
        return new Promise((resolve, reject) => {
            const port = chrome.tabs.connect(tabId, { name: 'gwr-video' });
            const chunks = [];
            let total = 0;
            port.onMessage.addListener((msg) => {
                if (msg.type === 'chunk') {
                    const binary = atob(msg.data);
                    const buffer = new Uint8Array(binary.length);
                    for (let i = 0; i < binary.length; i++) buffer[i] = binary.charCodeAt(i);
                    chunks.push(buffer);
                    total += buffer.length;
                    el.note.hidden = false;
                    el.note.textContent = `Reading from the page… ${bytes(total)}`;
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

    async function takePending(src, tabId) {
        el.note.hidden = false;
        el.note.textContent = 'Fetching the video…';
        try {
            const blob = src.startsWith('blob:')
                ? await readFromTab(tabId, src)
                : await (await fetch(src, { credentials: 'include' })).blob();
            const name = decodeURIComponent(src.split('/').pop().split('?')[0]) || 'video';
            el.note.hidden = true;
            await load(new File([blob], name, { type: blob.type || 'video/mp4' }), name);
        } catch (err) {
            el.note.textContent = `Could not fetch that video (${err.message}). Drop the file here instead.`;
        }
    }

    /* -------------------------------------------------------------- boot */

    if (!isVideoSupported() || !(await canEncode())) {
        fail('This browser cannot encode H.264 video locally. Chrome or Edge on desktop can.');
        el.go.disabled = true;
    }

    state.sparkle = (await Engine.create()).bg96;
    paint(await readJob());

    return {
        takePending,
        load,
        clearProgress: () => clearJob(),
    };
}
