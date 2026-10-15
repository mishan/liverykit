// ---------------------------------------------------------------------------
// DDS, encoded in JavaScript: BC1 (DXT1) and BC3 (DXT5) with a full mip chain.
//
// This was ImageMagick, called as a subprocess, and every way it failed was
// quiet: it wrote a DX10 header AC ignores if asked wrongly, a chain of one
// level when it could not parse the mip define, and picked DXT1 from the
// image's alpha whatever compression was asked for. It was also the one
// thing liverykit needed installed that npm does not install, which on
// Windows, where the game is, meant a PATH to get right. The format is small
// enough to write here, and the decoder both renderers already share
// (src/ui/dds.js) checks it.
// ---------------------------------------------------------------------------

/** The next mip level: each texel the average of the 2x2 above it. */
export function halve(pixels, width, height) {
  const w = Math.max(1, width >> 1), h = Math.max(1, height >> 1);
  const sx = width > 1 ? 2 : 1, sy = height > 1 ? 2 : 1;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (let dy = 0; dy < sy; dy++) for (let dx = 0; dx < sx; dx++) {
          sum += pixels[((y * sy + dy) * width + (x * sx + dx)) * 4 + c];
        }
        out[(y * w + x) * 4 + c] = Math.round(sum / (sx * sy));
      }
    }
  }
  return { pixels: out, width: w, height: h };
}

const to565 = (r, g, b) => (Math.round(r * 31 / 255) << 11) | (Math.round(g * 63 / 255) << 5) | Math.round(b * 31 / 255);
const from565 = (c) => {
  const r = (c >> 11) & 31, g = (c >> 5) & 63, b = c & 31;
  return [(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)];
};
const clamp = (v) => Math.max(0, Math.min(255, v));

// A block of one color is common — a livery's flat fields — and its nearest
// 5:6:5 color is often a visible step off. Two endpoints whose two-thirds
// point lands on it come much closer, so for every 8-bit value, the pair
// that does best, per channel width: the single-color tables other encoders
// keep for the same reason.
const expand = (v, bits) => (bits === 5 ? (v << 3) | (v >> 2) : (v << 2) | (v >> 4));
const singleColor = (bits) => [...Array(256)].map((_, v) => {
  let best = [0, 0], bestD = Infinity;
  for (let a = 0; a < 1 << bits; a++) {
    for (let b = 0; b < 1 << bits; b++) {
      const d = Math.abs(Math.trunc((2 * expand(a, bits) + expand(b, bits)) / 3) - v);
      if (d < bestD) { bestD = d; best = [a, b]; }
    }
  }
  return best;
});
const ONE5 = singleColor(5), ONE6 = singleColor(6);

/**
 * One 4x4 block's color, as BC1's 8 bytes: two 5:6:5 endpoints and sixteen
 * 2-bit indices. Endpoints along the block's principal axis, then refitted by
 * least squares to the indices that chose them; the better of the two is kept.
 */
function colorBlock(px, out, at) {
  if (px.every((v, i) => i % 4 === 3 || v === px[i & 3])) {
    const [r, g, b] = [px[0], px[1], px[2]];
    let c0 = (ONE5[r][0] << 11) | (ONE6[g][0] << 5) | ONE5[b][0];
    let c1 = (ONE5[r][1] << 11) | (ONE6[g][1] << 5) | ONE5[b][1];
    let idx = 0xAAAAAAAA;                                   // every texel the two-thirds point
    if (c0 < c1) { [c0, c1] = [c1, c0]; idx = 0xFFFFFFFF; } // the same point, counted from the other end
    if (c0 === c1) idx = 0;
    out.writeUInt16LE(c0, at);
    out.writeUInt16LE(c1, at + 2);
    out.writeUInt32LE(idx, at + 4);
    return;
  }
  let mr = 0, mg = 0, mb = 0;
  for (let i = 0; i < 16; i++) { mr += px[i * 4]; mg += px[i * 4 + 1]; mb += px[i * 4 + 2]; }
  mr /= 16; mg /= 16; mb /= 16;
  let crr = 0, crg = 0, crb = 0, cgg = 0, cgb = 0, cbb = 0;
  for (let i = 0; i < 16; i++) {
    const r = px[i * 4] - mr, g = px[i * 4 + 1] - mg, b = px[i * 4 + 2] - mb;
    crr += r * r; crg += r * g; crb += r * b; cgg += g * g; cgb += g * b; cbb += b * b;
  }
  let ax = [1, 1, 1];
  for (let k = 0; k < 6; k++) {
    const n = [crr * ax[0] + crg * ax[1] + crb * ax[2], crg * ax[0] + cgg * ax[1] + cgb * ax[2], crb * ax[0] + cgb * ax[1] + cbb * ax[2]];
    const len = Math.hypot(...n);
    if (len < 1e-9) break;
    ax = n.map((v) => v / len);
  }
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < 16; i++) {
    const t = (px[i * 4] - mr) * ax[0] + (px[i * 4 + 1] - mg) * ax[1] + (px[i * 4 + 2] - mb) * ax[2];
    if (t < lo) lo = t; if (t > hi) hi = t;
  }
  const end = (t) => [clamp(mr + ax[0] * t), clamp(mg + ax[1] * t), clamp(mb + ax[2] * t)];

  const fit = (c0, c1) => {
    if (c0 < c1) [c0, c1] = [c1, c0];
    const p0 = from565(c0), p1 = from565(c1);
    const pal = [p0, p1, p0.map((v, k) => (2 * v + p1[k]) / 3), p0.map((v, k) => (v + 2 * p1[k]) / 3)];
    let idx = 0, err = 0;
    const choice = [];
    for (let i = 15; i >= 0; i--) {
      let best = 0, bestD = Infinity;
      const n = c0 === c1 ? 1 : 4;
      for (let j = 0; j < n; j++) {
        const d = (px[i * 4] - pal[j][0]) ** 2 + (px[i * 4 + 1] - pal[j][1]) ** 2 + (px[i * 4 + 2] - pal[j][2]) ** 2;
        if (d < bestD) { bestD = d; best = j; }
      }
      choice[i] = best; err += bestD;
      idx = (idx << 2) | best;
    }
    return { c0, c1, idx: idx >>> 0, err, choice };
  };

  let best = fit(to565(...end(hi)), to565(...end(lo)));
  // Least squares: the endpoints that best explain the indices just chosen,
  // and again from the indices those choose, while it keeps helping.
  const w = [1, 0, 2 / 3, 1 / 3];
  for (let pass = 0; pass < 4; pass++) {
    let aa = 0, bb = 0, ab = 0; const ax0 = [0, 0, 0], bx1 = [0, 0, 0];
    for (let i = 0; i < 16; i++) {
      const a = w[best.choice[i]], b = 1 - a;
      aa += a * a; bb += b * b; ab += a * b;
      for (let k = 0; k < 3; k++) { ax0[k] += a * px[i * 4 + k]; bx1[k] += b * px[i * 4 + k]; }
    }
    const det = aa * bb - ab * ab;
    if (Math.abs(det) < 1e-9) break;
    const e0 = ax0.map((v, k) => clamp((bb * v - ab * bx1[k]) / det));
    const e1 = bx1.map((v, k) => clamp((aa * v - ab * ax0[k]) / det));
    const again = fit(to565(...e0), to565(...e1));
    if (again.err >= best.err) break;
    best = again;
  }
  out.writeUInt16LE(best.c0, at);
  out.writeUInt16LE(best.c1, at + 2);
  out.writeUInt32LE(best.idx, at + 4);
}

/** One 4x4 block's alpha, as BC3's 8 bytes: two endpoints, eight levels, 3-bit indices. */
function alphaBlock(px, out, at) {
  let a0 = 0, a1 = 255;
  for (let i = 0; i < 16; i++) { const a = px[i * 4 + 3]; if (a > a0) a0 = a; if (a < a1) a1 = a; }
  const pal = [a0, a1];
  for (let j = 1; j < 7; j++) pal.push(((7 - j) * a0 + j * a1) / 7);
  let bits = 0n;
  for (let i = 15; i >= 0; i--) {
    let best = 0, bestD = Infinity;
    for (let j = 0; j < (a0 === a1 ? 1 : 8); j++) {
      const d = Math.abs(px[i * 4 + 3] - pal[j]);
      if (d < bestD) { bestD = d; best = j; }
    }
    bits = (bits << 3n) | BigInt(best);
  }
  out[at] = a0; out[at + 1] = a1;
  for (let k = 0; k < 6; k++) out[at + 2 + k] = Number((bits >> BigInt(8 * k)) & 0xFFn);
}

/**
 * RGBA pixels as a DDS file: DXT5 when `alpha`, otherwise DXT1 and opaque,
 * with every mip level down to 1x1 — log2 of the LONGER edge, plus one.
 */
export function encodeDds(rgba, width, height, { alpha = false } = {}) {
  const levels = Math.floor(Math.log2(Math.max(width, height))) + 1;
  const block = alpha ? 16 : 8;
  const sizes = [];
  for (let l = 0, w = width, h = height; l < levels; l++, w = Math.max(1, w >> 1), h = Math.max(1, h >> 1)) {
    sizes.push(Math.ceil(w / 4) * Math.ceil(h / 4) * block);
  }
  const out = Buffer.alloc(128 + sizes.reduce((a, b) => a + b, 0));
  out.write('DDS ', 0, 'latin1');
  out.writeUInt32LE(124, 4);
  out.writeUInt32LE(0x1 | 0x2 | 0x4 | 0x1000 | 0x20000 | 0x80000, 8);    // caps, height, width, pixelformat, mipmapcount, linearsize
  out.writeUInt32LE(height, 12);
  out.writeUInt32LE(width, 16);
  out.writeUInt32LE(sizes[0], 20);
  out.writeUInt32LE(levels, 28);
  out.writeUInt32LE(32, 76);
  out.writeUInt32LE(0x4, 80);                                              // fourCC
  out.write(alpha ? 'DXT5' : 'DXT1', 84, 'latin1');
  out.writeUInt32LE(0x1000 | 0x8 | 0x400000, 108);                         // texture, complex, mipmap

  let level = { pixels: rgba, width, height };
  let at = 128;
  const px = new Uint8Array(64);
  for (let l = 0; l < levels; l++) {
    const { pixels, width: w, height: h } = level;
    for (let by = 0; by < h; by += 4) {
      for (let bx = 0; bx < w; bx += 4) {
        for (let i = 0; i < 16; i++) {
          const x = Math.min(w - 1, bx + (i & 3)), y = Math.min(h - 1, by + (i >> 2));
          const s = (y * w + x) * 4;
          px[i * 4] = pixels[s]; px[i * 4 + 1] = pixels[s + 1]; px[i * 4 + 2] = pixels[s + 2];
          px[i * 4 + 3] = alpha ? pixels[s + 3] : 255;
        }
        if (alpha) { alphaBlock(px, out, at); at += 8; }
        colorBlock(px, out, at); at += 8;
      }
    }
    if (l + 1 < levels) level = halve(pixels, w, h);
  }
  return out;
}
