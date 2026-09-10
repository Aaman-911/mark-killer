// Handing a video from the popup to the thing that exports it.
//
// The popup panel is destroyed the moment it loses focus, so the export runs
// in an offscreen document instead. Both live on the same extension origin, so
// IndexedDB is the cheapest way to pass a file between them — no copying it
// through a message as base64.

const DB_NAME = 'mark-killer';
const STORE = 'jobs';
export const JOB_KEY = 'video-in';
export const OUT_KEY = 'video-out';

function open() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains(STORE)) {
                request.result.createObjectStore(STORE);
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function run(mode, work) {
    return open().then((db) => new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = work(tx.objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        tx.oncomplete = () => db.close();
    }));
}

export const putBlob = (key, blob) => run('readwrite', (s) => s.put(blob, key));
export const getBlob = (key) => run('readonly', (s) => s.get(key));
export const dropBlob = (key) => run('readwrite', (s) => s.delete(key));

/* ------------------------------------------------------------------ state */

// Job state lives in chrome.storage, which only the service worker and the
// pages can reach — an offscreen document is given chrome.runtime and nothing
// else, so it reports progress by message and never touches this.
export const JOB_STATE = 'videoJob';

export async function readJob() {
    const { [JOB_STATE]: job } = await chrome.storage.local.get(JOB_STATE);
    return job || null;
}

export function writeJob(job) {
    return chrome.storage.local.set({ [JOB_STATE]: job });
}

export function clearJob() {
    return chrome.storage.local.remove(JOB_STATE);
}
