// Cleaning the Veo sparkle out of a video, frame by frame, on this machine.
//
// mediabunny demuxes the input and muxes the output; the browser's own
// WebCodecs encoder and decoder do the codec work. Audio is copied across
// untouched rather than re-encoded.
//
// Adapted from the upstream web app's videoEngine.js.

import * as mb from '../../vendor/mediabunny.mjs';
import { removeWatermark } from './blendModes.js';
import { buildAlpha, getRoi, resolveBox } from './tuner.js';
import { getVeoWatermark } from './videoTune.js';

export const VIDEO_DEFAULTS = { gain: 0.6, offsetX: 0, offsetY: 0, sizeScale: 1 };

export function isVideoSupported() {
    return typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined';
}

/** Can this browser actually write H.264 locally? */
export async function canEncode() {
    if (!isVideoSupported()) return false;
    if (typeof mb.canEncodeVideo !== 'function') return true;
    return mb.canEncodeVideo('avc');
}

/** Open a video and report what is inside it, without decoding all of it. */
export async function inspect(source) {
    const input = new mb.Input({ source: new mb.BlobSource(source), formats: mb.ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack();
    if (!track) {
        input.dispose?.();
        throw new Error('No decodable video track was found in this file.');
    }

    const width = track.displayWidth ?? track.codedWidth;
    const height = track.displayHeight ?? track.codedHeight;
    const duration = await input.computeDuration().catch(() => 0);

    let frameRate = 30;
    try {
        const stats = await track.computePacketStats(120);
        if (stats?.averagePacketRate) frameRate = Math.round(stats.averagePacketRate);
    } catch { /* keep the default */ }

    return { input, track, width, height, duration, frameRate };
}

/** One decoded frame, for the preview. `at` is in seconds. */
export async function grabFrame(source, at = 0) {
    const { input, track, width, height, duration } = await inspect(source);
    try {
        const sink = new mb.VideoSampleSink(track);
        const sample = await sink.getSample(Math.min(at, Math.max(0, duration - 0.05)));
        if (!sample) throw new Error('Could not decode a frame from this video.');

        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        sample.draw(ctx, 0, 0, width, height);
        sample.close();

        return { imageData: ctx.getImageData(0, 0, width, height), width, height, duration };
    } finally {
        input.dispose?.();
    }
}

/**
 * Clean a whole video.
 *
 * @param {Blob|File} source
 * @param {ImageBitmap} sparkle the 96px reference image
 * @param {object} opts { gain, offsetX, offsetY, sizeScale, onProgress, signal }
 * @returns {Promise<{blob:Blob, width:number, height:number, frames:number, audio:boolean}>}
 */
export async function cleanVideo(source, sparkle, opts = {}) {
    const onProgress = opts.onProgress || (() => {});
    const signal = opts.signal;
    const gain = opts.gain ?? VIDEO_DEFAULTS.gain;

    if (!(await canEncode())) {
        throw new Error('This browser cannot encode H.264 video locally. Chrome or Edge on desktop can.');
    }

    const { input, track, width, height, duration, frameRate } = await inspect(source);

    const base = getVeoWatermark(width, height);
    const wm = resolveBox(base, width, height, opts);
    const roi = getRoi(width, height, wm);
    const alpha = buildAlpha(sparkle, roi, wm, gain);
    const region = { x: 0, y: 0, width: roi.width, height: roi.height };

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const target = new mb.BufferTarget();
    const output = new mb.Output({ format: new mb.Mp4OutputFormat(), target });
    const videoSource = new mb.CanvasSource(canvas, {
        codec: 'avc',
        bitrate: mb.QUALITY_HIGH,
        keyFrameInterval: 2,
        sizeChangeBehavior: 'passThrough',
    });
    output.addVideoTrack(videoSource, { frameRate });

    // Audio is copied packet for packet, so it never loses quality.
    let audioSource = null;
    let audioTrack = null;
    let audioConfig = null;
    try {
        audioTrack = await input.getPrimaryAudioTrack();
        if (audioTrack) {
            const codec = await audioTrack.getCodec();
            audioConfig = await audioTrack.getDecoderConfig().catch(() => null);
            if (codec && audioConfig) {
                audioSource = new mb.EncodedAudioPacketSource(codec);
                output.addAudioTrack(audioSource);
            }
        }
    } catch {
        audioSource = null;
    }

    const stop = () => {
        if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    };

    await output.start();

    const fallbackDuration = frameRate > 0 ? 1 / frameRate : 1 / 30;
    const sink = new mb.VideoSampleSink(track);
    let first = null;
    let last = -1;
    let frames = 0;

    try {
        for await (const sample of sink.samples()) {
            stop();
            if (first === null) first = sample.timestamp;

            let timestamp = sample.timestamp - first;
            if (!(timestamp >= 0)) timestamp = 0;
            if (timestamp <= last) timestamp = last + fallbackDuration;
            const length = Number.isFinite(sample.duration) && sample.duration > 0
                ? sample.duration
                : fallbackDuration;
            last = timestamp;

            sample.draw(ctx, 0, 0, width, height);
            sample.close();

            const patch = ctx.getImageData(roi.x, roi.y, roi.width, roi.height);
            removeWatermark(patch, alpha, region);
            ctx.putImageData(patch, roi.x, roi.y);

            await videoSource.add(timestamp, length);
            frames++;
            if (duration) onProgress({ progress: Math.min(0.99, timestamp / duration), frames });
        }
        videoSource.close();

        if (audioSource) {
            try {
                const offset = first ?? 0;
                const packets = new mb.EncodedPacketSink(audioTrack);
                let isFirst = true;
                let lastAudio = -1;
                for await (const packet of packets.packets()) {
                    stop();
                    let timestamp = packet.timestamp - offset;
                    if (timestamp < 0) continue;
                    if (timestamp <= lastAudio) timestamp = lastAudio + 1e-6;
                    lastAudio = timestamp;

                    const outgoing = timestamp !== packet.timestamp && typeof packet.clone === 'function'
                        ? packet.clone({ timestamp })
                        : packet;
                    await audioSource.add(outgoing, isFirst && audioConfig ? { decoderConfig: audioConfig } : undefined);
                    isFirst = false;
                }
            } catch (err) {
                if (err?.name === 'AbortError') throw err;
                console.warn('Audio could not be copied across; exporting video only.', err);
            } finally {
                audioSource.close();
            }
        }

        await output.finalize();
    } finally {
        input.dispose?.();
    }

    if (!target.buffer) throw new Error('The export produced no output.');

    onProgress({ progress: 1, frames });
    return {
        blob: new Blob([target.buffer], { type: 'video/mp4' }),
        width,
        height,
        frames,
        audio: Boolean(audioSource),
    };
}
