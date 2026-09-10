// Screenshots the in-page hover button so its styling can be judged without
// installing the extension by hand.
//
//   node tools/preview-hover.mjs [out.png]
//
// Serves a watermarked test image over localhost (content scripts do not run
// on file:// unless file access is granted), loads the extension into a
// headless browser, moves the mouse over the image and takes the picture.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findBrowser, extensionId, INSTALL_HINT, LAUNCH_FLAGS } from './browser.mjs';
import { watermarkedPng } from './fixture.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(process.argv[2] || join(ROOT, 'hover-preview.png'));
const PORT = 9700 + (process.pid % 200);
const HTTP_PORT = PORT + 1;

const CHROME = findBrowser();
if (!CHROME) {
    console.log(INSTALL_HINT.join('\n'));
    process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (m) => console.log(`[preview] ${m}`);
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
const fixture = watermarkedPng(900, 600);

const page = `<!doctype html><meta charset="utf-8"><title>hover preview</title>
<style>
  body { margin: 0; background: #0b1020; }
  img { display: block; }
</style>
<img id="shot" src="/image.png" width="900" height="600" alt="watermarked test image">`;

const server = createServer((req, res) => {
    if (req.url === '/image.png') {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(fixture.png);
    } else {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page);
    }
});
await new Promise((r) => server.listen(HTTP_PORT, '127.0.0.1', r));

const profile = mkdtempSync(join(tmpdir(), 'gwr-preview-'));
const chrome = spawn(CHROME, [
    ...LAUNCH_FLAGS(ROOT, profile, PORT),
    `http://127.0.0.1:${HTTP_PORT}/`,
], { stdio: ['ignore', 'pipe', 'pipe'] });

let socket = null;
try {
    step('waiting for the page target');
    let targets = [];
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
        try {
            targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
            if (targets.some((t) => t.type === 'page' && t.url.includes(`${HTTP_PORT}`))) break;
        } catch { /* devtools is not listening yet */ }
        await sleep(250);
    }
    const target = targets.find((t) => t.type === 'page' && t.url.includes(`${HTTP_PORT}`));
    if (!target) throw new Error('the preview page never opened');

    step('attaching to the page');
    const page = talk(target);
    socket = page.socket;
    await page.opened;
    const send = page.send;

    // The hover button is limited to Gemini by default, so switch it on for
    // this throwaway profile.
    step('switching the hover button on');
    // The service worker often appears in the target list a moment after the
    // page does, so look it up freshly rather than reusing the earlier snapshot.
    let workerTarget = null;
    for (let i = 0; i < 20 && !workerTarget; i++) {
        const now = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        workerTarget = now.find((t) => t.type === 'service_worker' && t.url.includes(EXTENSION_ID));
        if (!workerTarget) await sleep(300);
    }
    if (!workerTarget) throw new Error('the extension service worker never appeared');

    const worker = talk(workerTarget);
    await worker.opened;
    await worker.send('Runtime.enable');
    // Not awaited inside the page: chrome.storage.sync can sit unresolved on a
    // throwaway profile with no account attached to it.
    await worker.send('Runtime.evaluate', {
        expression: `chrome.storage.sync.set({ hoverButton: 'all' }); 'sent'`,
    });
    await sleep(500);
    worker.socket.close();

    step('waiting for the test image');
    let point = null;
    let nudged = false;
    const ready = Date.now() + 20000;
    while (Date.now() < ready && !point) {
        const probe = await send('Runtime.evaluate', {
            expression: `(() => {
                const img = document.getElementById('shot');
                if (!img || !img.complete || !img.naturalWidth) return '';
                const r = img.getBoundingClientRect();
                return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
            })()`,
            returnByValue: true,
        });
        const value = probe.result?.result?.value;
        if (value) { point = JSON.parse(value); break; }
        if (!nudged && Date.now() > ready - 15000) {
            nudged = true;
            send('Page.navigate', { url: `http://127.0.0.1:${HTTP_PORT}/` });
        }
        await sleep(300);
    }
    if (!point) throw new Error('the test image never rendered');

    step('hovering');
    // Chrome needs a first move to establish where the pointer is; a single
    // jump from nowhere onto the image does not raise pointerover.
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4, buttons: 0 });
    await sleep(150);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, buttons: 0 });
    // The button waits for the background worker to confirm the mark is there.
    await sleep(2500);

    step('capturing');
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
    console.log(`wrote ${OUT}`);
} finally {
    step('cleaning up');
    socket?.close();
    chrome.kill('SIGKILL');
    server.closeAllConnections?.();
    server.close();
    await sleep(300);
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
