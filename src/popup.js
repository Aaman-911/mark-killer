import { Engine } from './engine/engine.js';
import { downloadFilename } from './lib/naming.js';
import { readJob } from './lib/jobstore.js';

const home = document.getElementById('home');
const videoPanel = document.getElementById('video-panel');
const videoRoot = document.getElementById('video-root');
const dropZone = document.getElementById('drop');
const picker = document.getElementById('picker');
const results = document.getElementById('results');
const hoverSelect = document.getElementById('hover');
const videoButton = document.getElementById('video');
const backButton = document.getElementById('back');

let enginePromise = null;
const engine = () => (enginePromise ||= Engine.create());

/* ------------------------------------------------------------ the views */

let videoView = null;

async function showVideo() {
    document.body.dataset.view = 'video';
    home.hidden = true;
    videoPanel.hidden = false;

    if (!videoView) {
        const { mountVideoView } = await import('./video-view.js');
        videoView = await mountVideoView(videoRoot);
    }
    return videoView;
}

function showHome() {
    document.body.dataset.view = 'home';
    videoPanel.hidden = true;
    home.hidden = false;
}

videoButton.addEventListener('click', () => showVideo());
backButton.addEventListener('click', showHome);

/* ------------------------------------------------------------- images */

function addRow(name) {
    results.hidden = false;
    const row = document.createElement('li');
    const label = document.createElement('span');
    label.className = 'name';
    label.textContent = name;
    const state = document.createElement('span');
    state.className = 'state';
    state.dataset.level = 'busy';
    state.textContent = 'working';
    row.append(label, state);
    results.append(row);
    return state;
}

function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('could not encode the cleaned image'));
        reader.onload = () => resolve(String(reader.result));
        reader.readAsDataURL(blob);
    });
}

async function handleFiles(files) {
    const images = [...files].filter((f) => f.type.startsWith('image/'));
    if (!images.length) return;

    for (const file of images) {
        const state = addRow(file.name);
        try {
            const result = await (await engine()).clean(file);

            if (!result.detected) {
                state.dataset.level = 'empty';
                state.textContent = 'no mark';
                continue;
            }

            const reply = await chrome.runtime.sendMessage({
                type: 'download',
                url: await blobToDataUrl(result.blob),
                filename: downloadFilename(`https://local/${file.name}`),
            });
            if (!reply?.ok) throw new Error(reply?.error || 'the download was refused');

            state.dataset.level = 'done';
            state.textContent = 'cleaned';
        } catch (err) {
            state.dataset.level = 'error';
            state.textContent = 'failed';
            state.title = err?.message || String(err);
        }
    }
}

picker.addEventListener('change', () => {
    handleFiles(picker.files);
    picker.value = '';
});
dropZone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); picker.click(); }
});
['dragenter', 'dragover'].forEach((type) =>
    dropZone.addEventListener(type, (e) => { e.preventDefault(); dropZone.classList.add('over'); }));
['dragleave', 'drop'].forEach((type) =>
    dropZone.addEventListener(type, (e) => { e.preventDefault(); dropZone.classList.remove('over'); }));
dropZone.addEventListener('drop', (e) => handleFiles(e.dataTransfer.files));

/* ----------------------------------------------------------- settings */

chrome.storage.sync.get({ hoverButton: 'gemini' }).then(({ hoverButton }) => {
    hoverSelect.value = hoverButton;
});
hoverSelect.addEventListener('change', () => {
    chrome.storage.sync.set({ hoverButton: hoverSelect.value });
});

/* --------------------------------------------------------------- boot */

// Opened from the right-click menu on a video, or reopened while an export is
// still running: go straight to the video panel.
(async () => {
    const { pendingVideo } = await chrome.storage.local.get('pendingVideo');
    if (pendingVideo?.src) {
        await chrome.storage.local.remove('pendingVideo');
        const view = await showVideo();
        view.takePending(pendingVideo.src, pendingVideo.tabId);
        return;
    }

    const job = await readJob();
    if (job?.stage === 'working') await showVideo();
})();
