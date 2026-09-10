// Screenshots the toolbar popup at its real width.
//
//   node tools/preview-popup.mjs [out.png]

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findBrowser, extensionId, INSTALL_HINT, LAUNCH_FLAGS } from './browser.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(process.argv[2] || join(ROOT, 'popup-preview.png'));
const PORT = 9990 + (process.pid % 8);

const CHROME = findBrowser();
if (!CHROME) {
    console.log(INSTALL_HINT.join('\n'));
    process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EXTENSION_ID = await extensionId(ROOT);
const profile = mkdtempSync(join(tmpdir(), 'gwr-popup-'));
const chrome = spawn(CHROME, [...LAUNCH_FLAGS(ROOT, profile, PORT), '--force-device-scale-factor=2', 'about:blank'],
    { stdio: ['ignore', 'pipe', 'pipe'] });

let socket = null;
try {
    let target = null;
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline && !target) {
        try {
            target = await (await fetch(
                `http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(`chrome-extension://${EXTENSION_ID}/src/popup.html`)}`,
                { method: 'PUT' })).json();
        } catch { await sleep(400); }
    }
    if (!target) throw new Error('the popup page never opened');

    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => socket.addEventListener('open', r, { once: true }));
    const pending = new Map();
    let id = 0;
    socket.addEventListener('message', (e) => {
        const m = JSON.parse(e.data);
        if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    });
    const send = (method, params = {}) => new Promise((r) => {
        const n = ++id;
        pending.set(n, r);
        socket.send(JSON.stringify({ id: n, method, params }));
    });

    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 328, height: 460, deviceScaleFactor: 3, mobile: false });
    await sleep(1500);

    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
    console.log(`wrote ${OUT}`);
} finally {
    socket?.close();
    chrome.kill('SIGKILL');
    await sleep(300);
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
