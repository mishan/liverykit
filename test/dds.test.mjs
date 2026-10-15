// ---------------------------------------------------------------------------
// The DDS encoder, checked against the decoder both renderers use.
//
// It replaced ImageMagick, whose failures here were all quiet: a DX10 header
// AC ignores, a mip chain of one from a define it could not parse, DXT1 when
// asked for DXT5. So the format is checked byte by byte, and the pictures by
// decoding them again and measuring how far they moved.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeDds, halve } from '../src/engine/dds.mjs';
import { mipCount } from '../src/engine/pipeline.mjs';
import { decodeDds } from '../src/ui/dds.js';

const image = (w, h, f) => {
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px.set(f(x, y), (y * w + x) * 4);
  return px;
};
const decode = (buf) => decodeDds(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const psnr = (a, b, channels) => {
  let se = 0, n = 0;
  for (let i = 0; i < a.length; i += 4) for (const c of channels) { se += (a[i + c] - b[i + c]) ** 2; n++; }
  return 10 * Math.log10((255 * 255) / (se / n || 1e-9));
};

test('the header is the DX9 one AC reads, with a full mip chain', () => {
  for (const [w, h, alpha, fourcc, block] of [[2048, 512, false, 'DXT1', 8], [64, 64, true, 'DXT5', 16], [4, 1024, false, 'DXT1', 8]]) {
    const dds = encodeDds(new Uint8Array(w * h * 4), w, h, { alpha });
    assert.equal(dds.toString('latin1', 0, 4), 'DDS ');
    assert.equal(dds.readUInt32LE(4), 124);
    assert.equal(dds.readUInt32LE(12), h);
    assert.equal(dds.readUInt32LE(16), w);
    assert.equal(dds.readUInt32LE(28), mipCount(w, h), `${w}x${h}: log2 of the LONGER edge, plus one`);
    assert.equal(dds.toString('latin1', 84, 88), fourcc, 'never DX10, which AC ignores');
    let size = 128;
    for (let l = 0, lw = w, lh = h; l < mipCount(w, h); l++, lw = Math.max(1, lw >> 1), lh = Math.max(1, lh >> 1)) {
      size += Math.ceil(lw / 4) * Math.ceil(lh / 4) * block;
    }
    assert.equal(dds.length, size, `${w}x${h}: every level present, nothing after`);
  }
});

test('a picture survives the round trip, color and alpha', () => {
  // A livery's kind of picture: a gradient field with a hard-edged block in
  // it. Measured at 47 dB. On real neon-grid sheets ImageMagick's DXT1 scored
  // 41 to 53, never above this encoder; the floors leave room.
  const w = 128, h = 64;
  const art = image(w, h, (x, y) => (x > 40 && x < 90 && y > 16 && y < 48
    ? [0, 240, 255, 255] : [18 + x, 32 + y, 58, Math.round(255 * x / (w - 1))]));
  const rgb = decode(encodeDds(art, w, h, { alpha: false }));
  assert.equal(rgb.width, w);
  assert.ok(psnr(art, rgb.pixels, [0, 1, 2]) > 44, `DXT1 PSNR ${psnr(art, rgb.pixels, [0, 1, 2]).toFixed(1)}`);
  assert.ok(rgb.pixels.every((v, i) => i % 4 !== 3 || v === 255), 'DXT1 without alpha is opaque');

  const rgba = decode(encodeDds(art, w, h, { alpha: true }));
  assert.ok(psnr(art, rgba.pixels, [0, 1, 2]) > 44, 'DXT5 color');
  assert.ok(psnr(art, rgba.pixels, [3]) > 50, `DXT5 alpha PSNR ${psnr(art, rgba.pixels, [3]).toFixed(1)}`);
});

test('a flat color comes back within one step of itself', () => {
  // A livery is mostly flat fields, and the nearest 5:6:5 color is up to four
  // steps off in red and blue: a visible band where two regions meet.
  let worst = 0;
  for (let v = 0; v < 256; v++) {
    const want = [v, 255 - v, (v * 7) & 255];
    const out = decode(encodeDds(image(4, 4, () => [...want, 255]), 4, 4, { alpha: false })).pixels;
    for (let i = 0; i < out.length; i += 4) for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(out[i + c] - want[c]));
  }
  assert.ok(worst <= 1, `off by ${worst}`);
});

test('each mip level is the average of the four texels above it, color weighted by alpha', () => {
  const px = image(4, 2, (x) => (x % 2 ? [200, 100, 0, 255] : [0, 100, 200, 55]));
  const { pixels, width, height } = halve(px, 4, 2);
  assert.deepEqual([width, height], [2, 1]);
  assert.deepEqual([...pixels.slice(0, 4)], [165, 100, 35, 155]);
  assert.deepEqual(halve(new Uint8Array(4 * 4), 1, 4).width, 1, 'a 1-wide level stays 1 wide');
});

test('two colors of equal brightness stay two colors', () => {
  // The block's principal axis was found by power iteration from [1, 1, 1],
  // which a red and green checker is perpendicular to: the iteration had
  // nothing to grow, every texel projected to the mean, and the edge came
  // out one muddy olive.
  const art = image(4, 4, (x, y) => ((x + y) % 2 ? [255, 0, 0, 255] : [0, 255, 0, 255]));
  const out = decode(encodeDds(art, 4, 4, { alpha: false })).pixels;
  assert.ok(psnr(art, out, [0, 1, 2]) > 40, `PSNR ${psnr(art, out, [0, 1, 2]).toFixed(1)}`);
});

test('a transparent texel lends no color to the mip level above it', () => {
  // A cut-out's clear area is usually black at alpha 0. Averaged as it is,
  // that black darkens every edge from the first mip down, and mips are what
  // the game draws at a distance.
  const px = image(2, 2, (x) => (x ? [0, 0, 0, 0] : [255, 128, 0, 255]));
  const { pixels } = halve(px, 2, 2);
  assert.deepEqual([...pixels.slice(0, 3)], [255, 128, 0], 'the color of what can be seen');
  assert.equal(pixels[3], 128, 'and half its alpha');
  assert.deepEqual([...halve(image(2, 2, () => [9, 9, 9, 0]), 2, 2).pixels], [9, 9, 9, 0], 'all clear stays as it was');
});

test('a DXT block format behind a DX10 header decodes like the classic one', () => {
  // 257 stock textures in a 254-car fleet carry the DX10 extension header
  // around a format the decoder already reads.
  const art = image(8, 8, (x, y) => [x * 30, y * 30, 128, 64 + x * 20]);
  const classic = encodeDds(art, 8, 8, { alpha: true });
  const ext = Buffer.alloc(20);
  ext.writeUInt32LE(77, 0);                       // DXGI_FORMAT_BC3_UNORM
  ext.writeUInt32LE(3, 4);                        // a 2D texture
  const dx10 = Buffer.concat([classic.subarray(0, 128), ext, classic.subarray(128)]);
  dx10.write('DX10', 84, 'latin1');
  assert.deepEqual(decode(dx10).pixels, decode(classic).pixels);
});
