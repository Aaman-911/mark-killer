import { Engine } from './engine/engine.js';

const dropZone = document.getElementById('drop');
const picker = document.getElementById('picker');
const results = document.getElementById('results');
const hoverSelect = document.getElementById('hover');
const videoButton = document.getElementById('video');

let enginePromise = null;
const engine = () => (enginePromise ||= Engine.create());

/* ---------------------------------------------------------------- rows */

function addRow(name) {
    results.hidden = false;
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.className = 'name';
    label.textContent = name;
    const state = document.createElement('span');
    state.className = 'state';
    state.dataset.level = 'busy';
    state.textContent = 'working…';
    li.append(label, state);
    results.append(li);
    return state;
}

/* ------------------------------------------------------------ download */

function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('could not encode the cleaned image'));
        reader.onload = () => resolve(String(reader.result));
        reader.readAsDataURL(blob);
    });
}

function outputName(file) {
    const stem = file.name.replace(/\.[^.]+$/, '').replace(/[^a-z0-9._-]+/gi, '-').slice(0, 60);
    return `gemini-watermark-remover/${stem || 'image'}-clean.png`;
}

/* --------------------------------------------------------------- files */

async function handleFiles(files) {
    const images = [...files].filter((f) => f.type.startsWith('image/'));
    if (!images.length) return;

    for (const file of images) {
        const state = addRow(file.name);
        try {
            const result = await (await engine()).clean(file);

            if (!result.detected) {
                state.dataset.level = 'empty';
                state.textContent = 'no watermark';
                continue;
            }

            const reply = await chrome.runtime.sendMessage({
                type: 'download',
                url: await blobToDataUrl(result.blob),
                filename: outputName(file),
            });
            if (!reply?.ok) throw new Error(reply?.error || 'the download was refused');

            state.dataset.level = 'done';
            state.textContent = `cleaned · ${result.variant}`;
        } catch (err) {
            state.dataset.level = 'error';
            state.textContent = 'failed';
            state.title = err?.message || String(err);
        }
    }
}

/* --------------------------------------------------------------- wiring */

picker.addEventListener('change', () => {
    handleFiles(picker.files);
    picker.value = '';
});

dropZone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); picker.click(); }
});

['dragenter', 'dragover'].forEach((type) => {
    dropZone.addEventListener(type, (e) => { e.preventDefault(); dropZone.classList.add('over'); });
});
['dragleave', 'drop'].forEach((type) => {
    dropZone.addEventListener(type, (e) => { e.preventDefault(); dropZone.classList.remove('over'); });
});
dropZone.addEventListener('drop', (e) => handleFiles(e.dataTransfer.files));

videoButton.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'open-studio' });
    window.close();
});

chrome.storage.sync.get({ hoverButton: 'gemini' }).then(({ hoverButton }) => {
    hoverSelect.value = hoverButton;
});
hoverSelect.addEventListener('change', () => {
    chrome.storage.sync.set({ hoverButton: hoverSelect.value });
});
