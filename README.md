# Mark Killer

*by Aman Dixit*

Right-click any image or video in your browser and remove the visible Gemini ✦
sparkle watermark. The cleaned file lands in your downloads folder. Nothing is
uploaded: the whole thing runs inside the extension, on your machine.

This is a Chrome/Edge (Manifest V3) port of the
[gemini-watermark-remover](https://github.com/dearabhin/gemini-watermark-remover)
web app by Abhin Krishna. The maths is unchanged — the same reverse alpha
blending, the same alpha reference images. What is new is that it works on
images that are already on a page, without downloading and re-uploading them.

---

## What it does

* **Right-click → "Remove Gemini watermark"** on any image, on any site.
* **Hover button that only appears when there is something to remove.** Hover a
  large image or video and the extension checks it first — the pill shows up
  only if the sparkle is actually there, so ordinary pictures are left alone.
  On `gemini.google.com` and `aistudio.google.com` by default; you can switch it
  to every site, or off.
* **Drag and drop** local files into the toolbar popup, several at a time.
* **Checks before it edits.** If the sparkle is not actually there, the image is
  left alone and you are told so, rather than having clean pixels mangled.
* **Handles the awkward cases** a web page cannot: cross-origin images (no
  tainted canvas) and `blob:` URLs, which is what Gemini itself serves.

* **Videos too.** Veo clips are decoded, cleaned frame by frame and re-encoded
  locally, with the original audio copied across untouched. See *Video* below.

## Install

The extension is not on the Chrome Web Store (see *Distribution*). Load it
yourself:

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → choose this folder

That is it — there is no build step. The source that ships is the source you
read.

## How the removal works

Gemini composites its watermark with ordinary alpha blending:

```
final = α · white + (1 − α) · original
```

α is known: it is baked into the two reference images in `assets/`. So the
original pixel is just algebra:

```
original = (final − α · white) / (1 − α)
```

No AI, no inpainting, no guessing. Where α is small the pixel is barely touched;
where α approaches 1 the division is clamped, so a fully opaque pixel cannot
blow up. Only the pixels under the sparkle are ever written.

**Finding the sparkle.** Gemini uses two placements: a 96px mark with a 64px
margin on images larger than 1024×1024, a 48px mark with a 32px margin
otherwise, plus a newer compact mark that scales with the image (short
side ÷ 32). The extension scores each candidate box by correlating the sparkle
template against the actual pixel brightness, and takes the best one. Below a
correlation of 0.35 it concludes there is no watermark and does nothing.

## Video

Right-click a video → **Remove Gemini watermark from video…**, or open the
toolbar popup and choose *Clean a video…*. Either way the work happens in its
own window rather than the toolbar popup, which the browser destroys the moment
it loses focus — an export runs for minutes. A separate window also keeps it out
of the way of the tab you were on.

The video mark is bigger than the one on stills (roughly short side ÷ 15, at a
tenth of the short side from the corner) and re-encoding leaves its strength
slightly different from the reference, so the page opens with an **auto-fit**:
it searches nearby positions and sizes for the best match to the sparkle, then
measures how much white was actually mixed in. Four sliders — strength,
horizontal, vertical, size — let you correct it by hand, with a live preview and
a close-up of the corner so you can see what changed. `show original` flips
between before and after.

Then **Clean the video**: every frame is decoded, the sparkle is subtracted from
its own box only, and the frames are re-encoded to H.264 MP4. Audio packets are
copied across without being re-encoded, so the sound is bit-for-bit the original.
Progress is shown per frame and **Cancel** stops it properly.

Video needs a browser that can encode H.264 locally — desktop Chrome and Edge
can; the page says so plainly if yours cannot. Re-encoding is lossy, so the
picture outside the watermark is very slightly recompressed. That is unavoidable
without a lossless intermediate, and it is why the still-image path (which is
exact) is kept separate.

## Layout

```
manifest.json          MV3 manifest
src/
  background.js        service worker: context menu, fetching, cleaning, saving
  content.js           in-page hover button, toasts, blob: URL reader
  ui.css               the palette and type both pages share
  popup.html/.css/.js  toolbar popup: drag and drop, settings
  studio.html/.css/.js the video page: preview, fit controls, export
  engine/
    geometry.js        where the watermark sits on a still
    alphaMap.js        reference image  ->  transparency map
    blendModes.js      the reverse alpha blend itself
    detect.js          is the sparkle actually there?
    canvas.js          OffscreenCanvas helpers (a service worker has no DOM)
    engine.js          ties the above together
    tuner.js           placing and scaling the sparkle by hand
    videoTune.js       Veo geometry, and finding the mark in a frame
    videoEngine.js     decode -> clean -> re-encode, with audio passthrough
  lib/naming.js        download naming and base64, kept pure for testing
vendor/                mediabunny (MPL-2.0), bundled — see vendor/README.md
assets/                bg_48.png, bg_96.png — the alpha references
icons/                 generated by tools/make-icons.mjs
tools/                 tests and the icon generator
```

Plain ES modules throughout. No framework, no bundler, no build step. The one
third-party library, mediabunny, is checked in unminified under `vendor/`
because MV3 forbids fetching code at runtime; `package.json` exists only to hold
the scripts.

## Permissions, and why each one is needed

| Permission | Why |
|---|---|
| `contextMenus` | the right-click entry |
| `downloads` | saving the cleaned PNG |
| `storage` | remembering the hover-button setting |
| `<all_urls>` | fetching the image you right-clicked, whatever site it is on, and showing the hover button |

There is no analytics, no network call to anything but the image you picked, and
no remote code — MV3's CSP forbids it and `tools/check.mjs` enforces it.

## Tests

```bash
npm run verify
```

* `tools/check.mjs` — every file the manifest names exists, every module parses,
  nothing loads remote code or calls `eval`.
* `tools/test.mjs` — stamps a real sparkle onto a synthetic picture, then checks
  the engine takes it back off to within 1/255 per channel; checks clean images
  are left alone; checks download naming.
* `tools/e2e.mjs` — loads the extension into a real headless browser, runs the
  engine there, sends the service worker a real job and decodes the file it saves
  to disk, then builds a watermarked H.264 clip, runs the whole video pipeline
  over it and checks the sparkle no longer correlates with the picture.

To look at the in-page hover button without installing anything:

```bash
npm run preview          # the hover button   -> hover-preview.png
npm run preview:popup    # the toolbar popup  -> popup-preview.png
npm run preview:studio   # the video window   -> studio-preview.png
```

**The e2e suite and the preview need an unbranded browser.** Google Chrome now refuses
`--load-extension` ("`--disable-extensions-except` is not allowed in Google
Chrome, ignoring"), so the suite looks for Chrome for Testing or Chromium in the
Puppeteer and Playwright caches and skips with an explanation if it finds
neither. To install one:

```bash
npx @puppeteer/browsers install chrome@stable
```

## Not done yet

* **Firefox.** MV3 differs there and `OffscreenCanvas` in a background script is
  weaker. Nothing here is deliberately Chrome-only, but it is untested.
* **A Gemini-specific button.** The hover button is generic on purpose: it does
  not depend on Gemini's DOM, which changes without notice.

## Distribution

Loading it unpacked is fine, and free.

Publishing is a different question. The Chrome Web Store charges a **one-time
$5 developer registration fee** — free for the people who install it, not free
for you — and a listing whose stated purpose is removing another company's
watermark is likely to draw review attention there, since the reviewer is
Google. Edge Add-ons costs nothing to register and applies similar policies with
a different reviewer. Firefox AMO is more permissive still, but nothing here is
tested on Firefox.

The part with real exposure is not the arithmetic: `assets/bg_48.png` and
`bg_96.png` are reproductions of Google's own mark. Two things genuinely count
in the other direction — this removes only the visible sparkle, leaving SynthID
untouched, and it never sends anything anywhere. Decide deliberately.

## Credits and licence

MIT, except `vendor/mediabunny.mjs`, which is MPL-2.0 and unmodified.

The algorithm, the alpha references and the engine modules come from
[dearabhin/gemini-watermark-remover](https://github.com/dearabhin/gemini-watermark-remover)
(MIT), which credits
[allenk/GeminiWatermarkTool](https://github.com/allenk/GeminiWatermarkTool) for
the image algorithm and
[GargantuaX/gemini-watermark-remover](https://github.com/GargantuaX/gemini-watermark-remover)
for the video pipeline. See [LICENSE](LICENSE).

This removes the **visible** sparkle only. It does not touch SynthID, the
invisible watermark Google also embeds. For personal and educational use;
respect other people's terms and copyrights.
