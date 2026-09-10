// Screenshots the video controls with a clip actually loaded, in the toolbar
// panel where they now live.
//
//   node tools/preview-video.mjs [out.png]

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findBrowser, extensionId, INSTALL_HINT, LAUNCH_FLAGS } from './browser.mjs';
import { BUILD_CLIP } from './clip.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(process.argv[2] || join(ROOT, 'video-preview.png'));
const PORT = 9900 + (process.pid % 90);

const CHROME = findBrowser();
if (!CHROME) {
    console.log(INSTALL_HINT.join('\n'));
    process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (m) => console.log(`[studio] ${m}`);
const EXTENSION_ID = await extensionId(ROOT);

function talk(target) {
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    const pending = new Map();
    let id = 0;
    socket.addEventListener('message', (e) => {
        const m = JSON.parse(e.data);
        if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    });
    const opened = new Promise((r, j) => {
        socket.addEventListener('open', r, { once: true });
        socket.addEventListener('error', () => j(new Error('devtools socket failed')), { once: true });
    });
    const send = (method, params = {}) => new Promise((r) => {
        const n = ++id;
        pending.set(n, r);
        socket.send(JSON.stringify({ id: n, method, params }));
    });
    return { socket, opened, send };
}

const profile = mkdtempSync(join(tmpdir(), 'gwr-studio-'));
const scratch = mkdtempSync(join(tmpdir(), 'gwr-clip-'));
// The panel is 420 wide once it switches to video.
const chrome = spawn(CHROME, [...LAUNCH_FLAGS(ROOT, profile, PORT), '--window-size=460,900', 'about:blank'],
    { stdio: ['ignore', 'pipe', 'pipe'] });

let page = null;
try {
    step('waiting for the browser');
    let target = null;
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline && !target) {
        try {
            target = await (await fetch(
                `http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(`chrome-extension://${EXTENSION_ID}/src/popup.html`)}`,
                { method: 'PUT' })).json();
        } catch { await sleep(400); }
    }
    if (!target) throw new Error('the video page never opened');

    page = talk(target);
    await page.opened;
    await page.send('Runtime.enable');
    await page.send('DOM.enable');
    await sleep(1500);

    step('building a test clip');
    const built = await page.send('Runtime.evaluate', {
        expression: `(${BUILD_CLIP})(640, 480, 24, 12)`,
        awaitPromise: true,
        returnByValue: true,
    });
    if (!built.result?.result?.value) {
        throw new Error(`could not build a clip: ${JSON.stringify(built).slice(0, 300)}`);
    }
    const clipPath = join(scratch, 'veo-test-clip.mp4');
    writeFileSync(clipPath, Buffer.from(built.result.result.value, 'base64'));

    step('opening the video panel');
    await page.send('Runtime.evaluate', { expression: `document.getElementById('video').click()` });
    await sleep(2500);

    step('handing the clip to the file picker');
    const doc = await page.send('DOM.getDocument', { depth: -1 });
    const picker = await page.send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '.vv-picker' });
    if (!picker.result?.nodeId) throw new Error('the video panel never opened');
    await page.send('DOM.setFileInputFiles', { nodeId: picker.result.nodeId, files: [clipPath] });

    step('waiting for the preview');
    let ready = false;
    const until = Date.now() + 25000;
    while (Date.now() < until && !ready) {
        const probe = await page.send('Runtime.evaluate', {
            expression: `(() => { const w = document.querySelector('.vv-work');
                          return Boolean(w) && !w.hidden && document.querySelector('.vv-preview').width > 0; })()`,
            returnByValue: true,
        });
        ready = probe.result?.result?.value === true;
        if (!ready) await sleep(400);
    }
    if (!ready) throw new Error('the clip never loaded into the page');
    await sleep(1200);

    step('capturing');
    const shot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
    console.log(`wrote ${OUT}`);
} finally {
    step('cleaning up');
    page?.socket.close();
    chrome.kill('SIGKILL');
    await sleep(300);
    for (const dir of [profile, scratch]) {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
}
