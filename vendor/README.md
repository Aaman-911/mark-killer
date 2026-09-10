# Vendored code

## mediabunny 1.56.1

`mediabunny.mjs` is the unmodified browser ES module bundle of
[mediabunny](https://github.com/Vanilagy/mediabunny) `1.56.1`, copied from the
npm package (`dist/bundles/mediabunny.mjs`). It demuxes and muxes MP4 around
the browser's own WebCodecs encoder and decoder, which is what makes the video
cleaning possible without a server.

It is bundled rather than fetched because Manifest V3 forbids remote code, and
it is checked in unminified so the code that ships is the code you can read.

**Licence: MPL-2.0** — see `mediabunny.LICENSE`. That licence applies to this
file only; the rest of this project is MIT.

To update: download the package from npm and copy the same file across.
