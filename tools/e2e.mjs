// Loads the real extension into a real headless Chrome and exercises it the
// way a user does.
//
//   node tools/e2e.mjs
//
// Two probes:
//   A. the engine, running in an extension page, against Chrome's own image
//      decoding, scaling and PNG encoding
//   B. the whole production path — a message to the service worker, which
//      fetches the image, cleans it and saves it through chrome.downloads —
//      verified by decoding the file that lands on disk

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodePng } from './png.mjs';
import { findBrowser, extensionId, INSTALL_HINT, LAUNCH_FLAGS } from './browser.mjs';
import { watermarkedPng } from './fixture.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 9333 + (process.pid % 200);

const CHROME = findBrowser();
if (!CHROME) {
    console.log(`SKIP  ${INSTALL_HINT[0]}`);
    for (const line of INSTALL_HINT.slice(1)) console.log(`      ${line}`);
    process.exit(0);
}
const EXTENSION_ID = await extensionId(ROOT);

let failures = 0;
function check(name, pass, detail) {
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
    if (!pass) failures++;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function poll(url, options = {}, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    let lastError = 'timed out';
    while (Date.now() < deadline) {
        try {
            const res = await fetch(url, options);
            if (res.ok) return res.json();
            lastError = `HTTP ${res.status}`;
        } catch (err) {
            lastError = err.message;
        }
        await sleep(200);
    }
    throw new Error(`${url}: ${lastError}`);
}

/* ------------------------------------------------------------------ cdp */

function connect(wsUrl) {
    const socket = new WebSocket(wsUrl);
    const pending = new Map();
    let nextId = 1;

    const ready = new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true });
        socket.addEventListener('error', () => reject(new Error('devtools socket failed')), { once: true });
    });

    socket.addEventListener('message', (event) => {
        const msg = JSON.parse(event.data);
        const entry = pending.get(msg.id);
        if (!entry) return;
        pending.delete(msg.id);
        msg.error ? entry.reject(new Error(msg.error.message)) : entry.resolve(msg.result);
    });

    return {
        ready,
        send(method, params = {}) {
            const id = nextId++;
            return new Promise((resolve, reject) => {
                pending.set(id, { resolve, reject });
                socket.send(JSON.stringify({ id, method, params }));
            });
        },
        close: () => socket.close(),
    };
}

async function evaluate(cdp, expression) {
    const result = await cdp.send('Runtime.evaluate', {
        expression, awaitPromise: true, returnByValue: true,
    });
    if (result.exceptionDetails) {
        const e = result.exceptionDetails;
        throw new Error(e.exception?.description || e.text);
    }
    return result.result.value;
}

// A service worker can be attachable a moment before its chrome.* bindings
// exist, which shows up as "chrome is not defined". Give it a few tries.
async function evaluateWhenReady(cdp, expression, tries = 8) {
    for (let attempt = 1; ; attempt++) {
        try {
            return await evaluate(cdp, expression);
        } catch (err) {
            if (attempt >= tries || !/chrome is not defined/.test(err.message)) throw err;
            await sleep(250);
        }
    }
}

/* ------------------------------------------------------------- probe A  */

const PROBE_ENGINE = `(async () => {
    const { Engine, DETECT_THRESHOLD } = await import(chrome.runtime.getURL('src/engine/engine.js'));
    const engine = await Engine.create();

    function pattern(width, height) {
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const img = ctx.createImageData(width, height);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const i = (y * width + x) * 4;
                img.data[i] = (x * 7 + y * 3) % 256;
                img.data[i + 1] = Math.round(128 + 100 * Math.sin(x / 23) * Math.cos(y / 31));
                img.data[i + 2] = (x * x + y * y) % 256;
                img.data[i + 3] = 255;
            }
        }
        ctx.putImageData(img, 0, 0);
        return { canvas, ctx, img };
    }

    async function marked(label, width, height, variant) {
        const { canvas, ctx, img } = pattern(width, height);
        const pristine = new Uint8ClampedArray(img.data);
        const box = engine.candidates(width, height).find((c) => c.name === variant).box;
        const alpha = engine.template(box.size);

        for (let row = 0; row < box.height; row++) {
            for (let col = 0; col < box.width; col++) {
                const a = Math.min(alpha[row * box.width + col], 0.99);
                const p = ((box.y + row) * width + (box.x + col)) * 4;
                for (let c = 0; c < 3; c++) img.data[p + c] = Math.round(a * 255 + (1 - a) * img.data[p + c]);
            }
        }
        ctx.putImageData(img, 0, 0);

        const result = await engine.clean(await canvas.convertToBlob({ type: 'image/png' }));

        let worst = 0;
        if (result.detected) {
            const back = await createImageBitmap(result.blob);
            const out = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true });
            out.drawImage(back, 0, 0);
            const cleaned = out.getImageData(0, 0, width, height).data;
            for (let row = 0; row < box.height; row++) {
                for (let col = 0; col < box.width; col++) {
                    const p = ((box.y + row) * width + (box.x + col)) * 4;
                    for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(pristine[p + c] - cleaned[p + c]));
                }
            }
        }

        return { label, variant, box, picked: result.variant, detected: result.detected,
                 score: result.score, worst, blobType: result.blob.type, blobSize: result.blob.size };
    }

    async function untouched(label, width, height) {
        const { canvas } = pattern(width, height);
        const result = await engine.clean(await canvas.convertToBlob({ type: 'image/png' }));
        return { label, detected: result.detected, score: result.score };
    }

    return {
        threshold: DETECT_THRESHOLD,
        marked: [
            await marked('classic 96px (1600x1600)', 1600, 1600, 'classic'),
            await marked('classic 48px (800x600)', 800, 600, 'classic'),
            await marked('compact 24px (1408x768)', 1408, 768, 'compact'),
        ],
        clean: [
            await untouched('clean 1600x1600', 1600, 1600),
            await untouched('clean 800x600', 800, 600),
        ],
    };
})()`;

/* ----------------------------------------------------------------- main */

const profile = mkdtempSync(join(tmpdir(), 'gwr-profile-'));
const downloads = mkdtempSync(join(tmpdir(), 'gwr-downloads-'));

const chrome = spawn(CHROME, [...LAUNCH_FLAGS(ROOT, profile, PORT), 'about:blank'],
    { stdio: ['ignore', 'pipe', 'pipe'] });

const chromeLog = [];
chrome.stderr.on('data', (d) => chromeLog.push(String(d)));

const sockets = [];
try {
    const version = await poll(`http://127.0.0.1:${PORT}/json/version`);
    check('headless Chrome is up', true, version.Browser);

    const browser = connect(version.webSocketDebuggerUrl);
    sockets.push(browser);
    await browser.ready;
    await browser.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });

    let worker = null;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && !worker) {
        const targets = await poll(`http://127.0.0.1:${PORT}/json/list`);
        worker = targets.find((t) => t.type === 'service_worker' && t.url.includes(EXTENSION_ID));
        if (!worker) await sleep(300);
    }
    check('extension loaded and its service worker started', Boolean(worker),
        worker ? EXTENSION_ID : `no service worker for ${EXTENSION_ID} appeared`);
    if (!worker) throw new Error('the extension never started');

    const sw = connect(worker.webSocketDebuggerUrl);
    sockets.push(sw);
    await sw.ready;
    await sw.send('Runtime.enable');
    const listeners = await evaluateWhenReady(sw, `({
        contextMenu: chrome.contextMenus.onClicked.hasListeners(),
        message: chrome.runtime.onMessage.hasListeners(),
    })`);
    check('context menu handler registered', listeners.contextMenu);
    check('message handler registered', listeners.message);

    // An extension page: dynamic import is allowed here, unlike in a worker.
    const pageTarget = await poll(
        `http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(`chrome-extension://${EXTENSION_ID}/src/popup.html`)}`,
        { method: 'PUT' });
    const page = connect(pageTarget.webSocketDebuggerUrl);
    sockets.push(page);
    await page.ready;
    await page.send('Runtime.enable');

    console.log('--- probe A: the engine inside Chrome');
    const report = await evaluate(page, PROBE_ENGINE);
    for (const r of report.marked) {
        check(`${r.label}: watermark detected`, r.detected,
            `score ${r.score.toFixed(3)} vs threshold ${report.threshold}`);
        check(`${r.label}: right placement chosen`, r.picked === r.variant,
            `picked ${r.picked}, box ${r.box.size}px at ${r.box.x},${r.box.y}`);
        check(`${r.label}: pixels restored`, r.worst <= 2, `worst channel error ${r.worst}/255`);
        check(`${r.label}: returns a real PNG`, r.blobType === 'image/png' && r.blobSize > 0,
            `${r.blobType}, ${r.blobSize} bytes`);
    }
    for (const r of report.clean) {
        check(`${r.label} is left alone`, !r.detected, `best score ${r.score.toFixed(3)}`);
    }

    console.log('--- probe B: message to the service worker, then the saved file');
    const fixture = watermarkedPng(800, 600);
    const reply = await evaluate(page,
        `chrome.runtime.sendMessage({ type: 'clean-image', src: ${JSON.stringify(fixture.dataUrl)} })`);

    check('service worker accepted the job', reply?.ok === true, JSON.stringify(reply));
    check('service worker found the watermark', reply?.detected === true,
        reply?.score !== undefined ? `score ${Number(reply.score).toFixed(3)}, ${reply.variant}` : '');

    // Note: DevTools' download override renames the file to download.png, so
    // this suite checks the file's *contents*. The name chrome.downloads is
    // asked for is covered by the downloadFilename tests in tools/test.mjs.
    const history = await evaluate(sw, `chrome.downloads.search({ limit: 5, orderBy: ['-startTime'] })
        .then(items => items.map(i => ({ state: i.state, error: i.error, filename: i.filename, bytes: i.bytesReceived })))`);
    check('the download was accepted by Chrome', history.length > 0 && !history[0].error,
        history.length ? `${history[0].state}${history[0].error ? ' / ' + history[0].error : ''} -> ${history[0].filename}` : 'no download was recorded');

    let saved = null;
    const fileDeadline = Date.now() + 15000;
    const expected = history[0]?.filename;
    while (Date.now() < fileDeadline && !saved) {
        for (const dir of [join(downloads, 'gemini-watermark-remover'), expected ? dirname(expected) : null]) {
            if (!dir) continue;
            try {
                const done = readdirSync(dir).filter((f) => f.endsWith('.png') && statSync(join(dir, f)).size > 0);
                if (done.length) { saved = join(dir, done[0]); break; }
            } catch { /* the folder is not there yet */ }
        }
        if (!saved) await sleep(250);
    }
    check('cleaned file was written to disk', Boolean(saved), saved ? saved.replace(downloads + '/', '') : 'nothing appeared');

    if (saved) {
        const png = decodePng(readFileSync(saved));
        check('saved file is the right size', png.width === fixture.width && png.height === fixture.height,
            `${png.width}x${png.height}`);

        let worst = 0;
        const { box } = fixture;
        for (let row = 0; row < box.height; row++) {
            for (let col = 0; col < box.width; col++) {
                const p = ((box.y + row) * png.width + (box.x + col)) * 4;
                for (let c = 0; c < 3; c++) {
                    worst = Math.max(worst, Math.abs(fixture.original.data[p + c] - png.data[p + c]));
                }
            }
        }
        check('saved file has the original pixels back', worst <= 2, `worst channel error ${worst}/255`);
    }
} catch (err) {
    check('end-to-end run', false, err.message);
    if (chromeLog.length) {
        const noise = /CVDisplayLink|GPU|Fontconfig|voice_transcription/;
        const lines = chromeLog.join('').trim().split('\n').filter((l) => !noise.test(l));
        if (lines.length) console.log('\nchrome said:\n' + lines.slice(-5).join('\n'));
    }
} finally {
    sockets.forEach((s) => s.close());
    chrome.kill('SIGKILL');
    // Chrome may still be flushing its profile as it dies.
    await sleep(300);
    for (const dir of [profile, downloads]) {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
}

console.log(failures === 0 ? '\nall end-to-end checks passed' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
