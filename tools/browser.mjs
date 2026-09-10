// Finding a browser that will actually load an unpacked extension.
//
// Branded Google Chrome refuses: "--disable-extensions-except is not allowed
// in Google Chrome, ignoring". So this looks for an unbranded build — Chrome
// for Testing or Chromium — in the caches Puppeteer and Playwright use.

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const INSTALL_HINT = [
    'No unbranded Chrome build found.',
    'Branded Google Chrome ignores --load-extension, so this needs',
    'Chrome for Testing or Chromium. Install one with:',
    '  npx @puppeteer/browsers install chrome@stable',
    'then re-run, or point CHROME_PATH at an existing build.',
];

export function findBrowser() {
    const candidates = [process.env.CHROME_PATH].filter(Boolean);

    for (const [dir, app] of [
        [join(homedir(), '.cache/puppeteer/chrome'), 'Google Chrome for Testing'],
        [join(homedir(), 'Library/Caches/ms-playwright'), 'Chromium'],
    ]) {
        if (!existsSync(dir)) continue;
        for (const build of readdirSync(dir).sort().reverse()) {
            for (const arch of ['chrome-mac-arm64', 'chrome-mac-x64', 'chrome-linux64', 'chrome-mac', 'chrome-linux']) {
                candidates.push(join(dir, build, arch, `${app}.app/Contents/MacOS/${app}`));
                candidates.push(join(dir, build, arch, app.toLowerCase().replace(/ /g, '-')));
            }
        }
    }

    return candidates.find((p) => p && existsSync(p)) || null;
}

// The id Chrome derives for an unpacked extension is a hash of its path.
export async function extensionId(root) {
    const { createHash } = await import('node:crypto');
    return [...createHash('sha256').update(root).digest().subarray(0, 16)]
        .flatMap((b) => [b >> 4, b & 15])
        .map((n) => String.fromCharCode(97 + n))
        .join('');
}

export const LAUNCH_FLAGS = (root, profile, port) => [
    '--headless=new',
    '--enable-unsafe-extension-debugging',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    `--load-extension=${root}`,
    `--disable-extensions-except=${root}`,
];
