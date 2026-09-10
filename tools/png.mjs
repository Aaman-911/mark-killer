// Minimal PNG reader for the test rig only. Handles the 8-bit greyscale,
// RGB and RGBA images this project ships. Node's zlib does the inflating.

import { inflateSync, deflateSync } from 'node:zlib';

const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

function paeth(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    return pb <= pc ? b : c;
}

export function decodePng(buffer) {
    let offset = 8;
    let width = 0, height = 0, depth = 0, colourType = 0;
    const idat = [];

    while (offset < buffer.length) {
        const length = buffer.readUInt32BE(offset);
        const type = buffer.toString('ascii', offset + 4, offset + 8);
        const data = buffer.subarray(offset + 8, offset + 8 + length);
        offset += 12 + length;

        if (type === 'IHDR') {
            width = data.readUInt32BE(0);
            height = data.readUInt32BE(4);
            depth = data[8];
            colourType = data[9];
            if (depth !== 8) throw new Error(`unsupported bit depth ${depth}`);
            if (!(colourType in CHANNELS)) throw new Error(`unsupported colour type ${colourType}`);
        } else if (type === 'IDAT') {
            idat.push(data);
        } else if (type === 'IEND') {
            break;
        }
    }

    const channels = CHANNELS[colourType];
    const stride = width * channels;
    const raw = inflateSync(Buffer.concat(idat));
    const pixels = Buffer.alloc(stride * height);

    for (let y = 0; y < height; y++) {
        const filter = raw[y * (stride + 1)];
        const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
        for (let x = 0; x < stride; x++) {
            const a = x >= channels ? pixels[y * stride + x - channels] : 0;
            const b = y > 0 ? pixels[(y - 1) * stride + x] : 0;
            const c = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels] : 0;
            let value = line[x];
            if (filter === 1) value += a;
            else if (filter === 2) value += b;
            else if (filter === 3) value += (a + b) >> 1;
            else if (filter === 4) value += paeth(a, b, c);
            pixels[y * stride + x] = value & 0xff;
        }
    }

    // Normalise everything to RGBA so callers have one shape to deal with.
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        const s = i * channels, d = i * 4;
        if (channels === 1) { rgba[d] = rgba[d + 1] = rgba[d + 2] = pixels[s]; rgba[d + 3] = 255; }
        else if (channels === 2) { rgba[d] = rgba[d + 1] = rgba[d + 2] = pixels[s]; rgba[d + 3] = pixels[s + 1]; }
        else if (channels === 3) { rgba[d] = pixels[s]; rgba[d + 1] = pixels[s + 1]; rgba[d + 2] = pixels[s + 2]; rgba[d + 3] = 255; }
        else { rgba[d] = pixels[s]; rgba[d + 1] = pixels[s + 1]; rgba[d + 2] = pixels[s + 2]; rgba[d + 3] = pixels[s + 3]; }
    }

    return { width, height, data: rgba, colourType };
}

/* --------------------------------------------------------------- writing */

const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c;
    }
    return table;
})();

export function crc32(buf) {
    let c = 0xffffffff;
    for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

export function chunk(type, data) {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
}

export function encodePng(width, height, rgba) {
    const raw = Buffer.alloc((width * 4 + 1) * height);
    for (let y = 0; y < height; y++) {
        raw[y * (width * 4 + 1)] = 0; // filter: none
        rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
    }

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;  // bit depth
    ihdr[9] = 6;  // colour type: RGBA

    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}
