// Static checks that catch the mistakes that only show up as a silent, blank
// failure once the extension is loaded: a missing file, a syntax error in a
// module Chrome never reports, or remote code that MV3's CSP will block.
//
//   node tools/check.mjs

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;

function check(name, pass, detail) {
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
    if (!pass) failures++;
}

/* ------------------------------------------------------------ manifest */

const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
check('manifest.json is valid JSON', true, `version ${manifest.version}`);
check('manifest is MV3', manifest.manifest_version === 3);

const referenced = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
    ...manifest.content_scripts.flatMap((cs) => [...(cs.js || []), ...(cs.css || [])]),
];

for (const file of [...new Set(referenced)]) {
    check(`manifest reference exists: ${file}`, existsSync(join(ROOT, file)));
}

// Pages opened at runtime rather than named in the manifest.
for (const file of ['src/studio.html', 'src/studio.css', 'src/studio.js', 'src/ui.css',
                    'src/offscreen.html', 'src/offscreen.js',
                    'src/video-view.js', 'src/video-view.css', 'src/lib/jobstore.js',
                    'vendor/mediabunny.mjs', 'vendor/mediabunny.LICENSE']) {
    check(`runtime file exists: ${file}`, existsSync(join(ROOT, file)));
}

check('reference assets are present',
    existsSync(join(ROOT, 'assets/bg_48.png')) && existsSync(join(ROOT, 'assets/bg_96.png')));

const declared = new Set(manifest.permissions);
check('asks for no permissions it does not use',
    [...declared].every((p) => ['contextMenus', 'downloads', 'storage', 'offscreen'].includes(p)),
    [...declared].join(', '));

/* ------------------------------------------------------------- sources */

function walk(dir) {
    return readdirSync(dir).flatMap((entry) => {
        const full = join(dir, entry);
        return statSync(full).isDirectory() ? walk(full) : [full];
    });
}

const sources = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'tools'))]
    .filter((f) => /\.m?js$/.test(f));

for (const file of sources) {
    const name = relative(ROOT, file);
    const text = readFileSync(file, 'utf8');

    try {
        // --check parses the file without running it, so a module that needs
        // chrome.* or OffscreenCanvas is still checked here.
        execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
        check(`parses: ${name}`, true);
    } catch (err) {
        check(`parses: ${name}`, false, String(err.stderr || err.message).split('\n').slice(0, 3).join(' ').trim());
    }

    check(`no remote code: ${name}`, !/\b(import|import\s*\()\s*['"`]https?:/.test(text));
    check(`no eval: ${name}`, !/\beval\s*\(|new\s+Function\s*\(/.test(text));
}

for (const name of ['src/popup.html', 'src/studio.html', 'src/offscreen.html']) {
    const html = readFileSync(join(ROOT, name), 'utf8');
    check(`${name} loads no remote scripts or styles`,
        !/(src|href)\s*=\s*["']https?:/i.test(html.replace(/<a\b[^>]*>/gi, '')));
    check(`${name} has no inline script`,
        !/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i.test(html));
    const styles = [...html.matchAll(/<link[^>]+href="([^"]+\.css)"/g)]
        .map((m) => readFileSync(join(ROOT, 'src', m[1]), 'utf8'))
        .join('\n');
    check(`${name} does not hide things with a display rule alone`,
        !/hidden/.test(html) || /\[hidden\]\s*{[^}]*display:\s*none/.test(styles),
        'a stylesheet display rule would beat the [hidden] attribute');
}

check('the vendored library is the only third-party code',
    readdirSync(join(ROOT, 'vendor')).filter((f) => f.endsWith('.mjs')).length === 1);

console.log(failures === 0 ? '\nall static checks passed' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
