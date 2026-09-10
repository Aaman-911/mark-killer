// Where a video export actually runs.
//
// This document has no window and no interface. It exists so that closing the
// popup panel — which the browser does the moment it loses focus — cannot kill
// an export that takes minutes.
//
// An offscreen document is given chrome.runtime and nothing else: no
// chrome.storage, no chrome.downloads. So it reads and writes the video
// through IndexedDB, which is an ordinary web API, and reports everything else
// to the service worker by message.

import { Engine } from './engine/engine.js';
import { cleanVideo } from './engine/videoEngine.js';
import { getBlob, putBlob, dropBlob, JOB_KEY, OUT_KEY } from './lib/jobstore.js';

let running = null;

const say = (message) => chrome.runtime.sendMessage(message).catch(() => {});

async function exportVideo({ name, settings }) {
    const controller = new AbortController();
    running = controller;
    const started = Date.now();

    say({ type: 'export-progress', progress: 0, frames: 0, name });

    try {
        const source = await getBlob(JOB_KEY);
        if (!source) throw new Error('The video was not handed over properly. Try again.');

        const sparkle = (await Engine.create()).bg96;
        const result = await cleanVideo(source, sparkle, {
            ...settings,
            signal: controller.signal,
            onProgress: ({ progress, frames }) => say({ type: 'export-progress', progress, frames, name }),
        });

        // The bytes go through IndexedDB rather than a message: the service
        // worker reads them from there and hands them to chrome.downloads.
        await putBlob(OUT_KEY, result.blob);
        say({
            type: 'export-done',
            name,
            frames: result.frames,
            bytes: result.blob.size,
            audio: result.audio,
            seconds: Math.round((Date.now() - started) / 1000),
        });
    } catch (err) {
        say(err?.name === 'AbortError'
            ? { type: 'export-stopped', name }
            : { type: 'export-failed', name, error: err.message });
    } finally {
        running = null;
        await dropBlob(JOB_KEY).catch(() => {});
    }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'offscreen-export') {
        exportVideo(msg);
        sendResponse({ ok: true });
        return false;
    }
    if (msg?.type === 'offscreen-stop') {
        const busy = Boolean(running);
        running?.abort();
        sendResponse({ ok: true, stopping: busy });
        return false;
    }
    return false;
});
