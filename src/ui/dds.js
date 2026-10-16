// ---------------------------------------------------------------------------
// DDS, decoded to plain RGBA in JavaScript.
//
// SHARED BY BOTH RENDERERS, which is the whole reason it is its own file. The
// browser needs it for the formats the GPU cannot take as blocks, and Node for
// every DDS it reads, so the two cannot disagree about a texture. Kept
// here beside `uses.js`, the other module both sides import, and served to the
// browser by name — see SERVABLE in server.mjs.
//
// No DOM and no GL: it takes an ArrayBuffer and returns pixels.
// ---------------------------------------------------------------------------

/**
 * A texture out of the archive, decoded to plain RGBA on the CPU — whatever
 * it was stored as.
 *
 * The GPU takes S3TC blocks untouched and this is the slower path, so it is
 * for the two cases where handing blocks over is not an option. The first is
 * format: a kn5 is not all DXT, and this car's carbon weave is plain 32-bit
 * BGRA while its brushed metal is 16-bit luminance — neither can go through
 * compressedTexImage2D at all. The second is mips on a file that shipped
 * none: WebGL refuses generateMipmap on a compressed texture (every S3TC
 * format, by the spec, on every driver), so a chainless DXT detail map can
 * only get a chain by being decoded first. Tiled a hundred to five hundred
 * times over, one screen pixel covers hundreds of texels and a door card
 * dissolves into crawling moire without one.
 *
 * Mostly detail maps come through here, and they are small — 128 to 512
 * square — so the four times memory RGBA costs over DXT is nothing. Whole
 * stock sheets follow when they are stored uncompressed, which on this car is
 * six of thirty-one; the rest keep their blocks and their own embedded chain.
 * See uploadBlocks, and uploadDecoded for the sheet path.
 *
 * Module scope rather than inside the viewer because it touches no GL state
 * and the formats it has to read are worth a test that does not need a GPU.
 */
export function decodeDds(buffer) {
  if (!buffer || buffer.byteLength < 128) return null;
  const head = new DataView(buffer);
  if (head.getUint32(0, true) !== 0x20534444) return null;      // 'DDS '
  const height = head.getUint32(12, true);
  const width = head.getUint32(16, true);
  // The DX10 extension header puts a DXGI format after the classic one, and
  // what it wraps is often the same BC1, BC2 or BC3 blocks; 257 stock
  // textures in a 254-car fleet are that. Other DXGI formats are left to the
  // caller to say it could not read.
  const fourcc = head.getUint32(84, true);
  const dxgi = fourcc === 0x30315844 && buffer.byteLength >= 148 ? head.getUint32(128, true) : null;
  const dxt = dxgi === null
    ? { 0x31545844: 1, 0x33545844: 3, 0x35545844: 5 }[fourcc]
    : { 71: 1, 72: 1, 74: 3, 75: 3, 77: 5, 78: 5 }[dxgi];
  if (!width || !height) return null;
  if (dxgi === 98 || dxgi === 99) return decodeBc7(buffer, width, height);
  if (dxgi !== null && !dxt) return null;
  const data = dxgi === null ? 128 : 148;

  // NOT everything in a kn5 is block-compressed, and assuming it was is how
  // the two most valuable detail maps on this car came back as null and
  // stayed gray: MAT_Carbon.dds, which is the actual carbon weave, is plain
  // 32-bit BGRA, and metal_detail_2.dds is 16-bit luminance-plus-alpha.
  //
  // Read through the channel MASKS rather than assuming a byte order. The
  // masks are the only thing in the header that actually says where each
  // channel lives, they cost one loop to turn into a shift, and BGRA versus
  // RGBA is otherwise a bug that looks like an art decision — a blue car.
  if (!dxt) {
    const flags = head.getUint32(80, true);
    const bits = head.getUint32(88, true);
    const luminance = (flags & 0x20000) !== 0;
    if (!(luminance || (flags & 0x40)) || bits % 8 !== 0 || bits < 8 || bits > 32) return null;

    const channel = (mask) => {
      if (!mask) return null;
      let shift = 0;
      while (!((mask >>> shift) & 1)) shift++;
      const max = mask >>> shift;
      return max ? { shift, max } : null;
    };
    const rc = channel(head.getUint32(92, true));
    const gc = luminance ? rc : channel(head.getUint32(96, true));
    const bc = luminance ? rc : channel(head.getUint32(100, true));
    const ac = channel(head.getUint32(104, true));
    if (!rc) return null;

    const bpp = bits / 8;
    if (buffer.byteLength < 128 + (width * height * bpp)) return null;
    const src = new Uint8Array(buffer, 128, width * height * bpp);
    const out = new Uint8Array(width * height * 4);
    const take = (v, ch, fallback) => (ch ? Math.round((((v & (ch.max << ch.shift)) >>> ch.shift) * 255) / ch.max) : fallback);
    for (let i = 0, o = 0; i < width * height; i++, o += bpp) {
      let v = 0;
      for (let k = 0; k < bpp; k++) v |= src[o + k] << (k * 8);
      v >>>= 0;
      const d = i * 4;
      out[d] = take(v, rc, 0);
      out[d + 1] = take(v, gc, 0);
      out[d + 2] = take(v, bc, 0);
      out[d + 3] = take(v, ac, 255);
    }
    return { width, height, pixels: out };
  }

  const blockBytes = dxt === 1 ? 8 : 16;
  const bw = Math.ceil(width / 4);
  const bh = Math.ceil(height / 4);
  if (buffer.byteLength < data + (bw * bh * blockBytes)) return null;
  const src = new Uint8Array(buffer, data, bw * bh * blockBytes);
  const out = new Uint8Array(width * height * 4);

  // Reused across every block rather than allocated per block: a 1024-square
  // texture is 65536 blocks, and four small arrays each time is how a decode
  // that should take milliseconds starts triggering garbage collection
  // pauses in the middle of a camera drag.
  const r = new Uint8Array(4);
  const g = new Uint8Array(4);
  const b = new Uint8Array(4);
  const a = new Uint8Array(8);

  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let o = (by * bw + bx) * blockBytes;
      let alphaAt = -1;

      if (dxt === 5) {
        // Two endpoints and a three-bit index per texel, with the same
        // "which endpoint is larger" trick the color block uses to pick
        // between two interpolation schemes.
        a[0] = src[o];
        a[1] = src[o + 1];
        if (a[0] > a[1]) {
          for (let i = 1; i < 7; i++) a[i + 1] = (((7 - i) * a[0]) + (i * a[1])) / 7;
        } else {
          for (let i = 1; i < 5; i++) a[i + 1] = (((5 - i) * a[0]) + (i * a[1])) / 5;
          a[6] = 0;
          a[7] = 255;
        }
        alphaAt = o + 2;
        o += 8;
      } else if (dxt === 3) {
        alphaAt = o;                      // four flat bits per texel
        o += 8;
      }

      const c0 = src[o] | (src[o + 1] << 8);
      const c1 = src[o + 2] | (src[o + 3] << 8);
      // 5:6:5 to 8:8:8 by replicating the high bits down into the low ones,
      // which is what keeps a saturated channel at 255 rather than at 248.
      const unpack = (i, v) => {
        const r5 = (v >> 11) & 31;
        const g6 = (v >> 5) & 63;
        const b5 = v & 31;
        r[i] = (r5 << 3) | (r5 >> 2);
        g[i] = (g6 << 2) | (g6 >> 4);
        b[i] = (b5 << 3) | (b5 >> 2);
      };
      unpack(0, c0);
      unpack(1, c1);
      // DXT1 hides one bit of alpha in the ORDER of its endpoints: c0 <= c1
      // means the fourth color is transparent black instead of a second
      // interpolation step. Read it the other way and every cut-out texture
      // grows a black fringe.
      const punchThrough = dxt === 1 && c0 <= c1;
      if (punchThrough) {
        r[2] = (r[0] + r[1]) / 2; g[2] = (g[0] + g[1]) / 2; b[2] = (b[0] + b[1]) / 2;
        r[3] = 0; g[3] = 0; b[3] = 0;
      } else {
        r[2] = ((2 * r[0]) + r[1]) / 3; g[2] = ((2 * g[0]) + g[1]) / 3; b[2] = ((2 * b[0]) + b[1]) / 3;
        r[3] = (r[0] + (2 * r[1])) / 3; g[3] = (g[0] + (2 * g[1])) / 3; b[3] = (b[0] + (2 * b[1])) / 3;
      }

      const bits = o + 4;
      for (let py = 0; py < 4; py++) {
        const y = (by * 4) + py;
        if (y >= height) break;           // the last block row runs off a
        for (let px = 0; px < 4; px++) {  // texture whose size is not a
          const x = (bx * 4) + px;        // multiple of four
          if (x >= width) break;
          const i = (src[bits + py] >> (px * 2)) & 3;
          const n = (py * 4) + px;
          const d = ((y * width) + x) * 4;
          out[d] = r[i];
          out[d + 1] = g[i];
          out[d + 2] = b[i];
          if (dxt === 5) {
            // A three-bit field straddles a byte boundary five times in
            // every block, hence the second read rather than a lookup table.
            const at = n * 3;
            const byteAt = alphaAt + (at >> 3);
            const shift = at & 7;
            let v = src[byteAt] >> shift;
            if (shift > 5) v |= src[byteAt + 1] << (8 - shift);
            out[d + 3] = a[v & 7];
          } else if (dxt === 3) {
            out[d + 3] = ((src[alphaAt + (n >> 1)] >> ((n & 1) * 4)) & 15) * 17;
          } else {
            out[d + 3] = punchThrough && i === 3 ? 0 : 255;
          }
        }
      }
    }
  }
  return { width, height, pixels: out };
}

// --- BC7 ------------------------------------------------------------------
//
// About 240 stock sheets in a 254-car fleet. Eight modes share one layout:
// endpoints for one to three subsets, optional p-bits, then indices that
// interpolate between them, with the tables the format fixes for which texel
// belongs to which subset and which texel's index drops its top bit.

// Per mode: subsets, partition bits, rotation bits, index-selection bit,
// color bits, alpha bits, a p-bit per endpoint, a p-bit per subset, index
// bits, second index bits.
const BC7_MODES = [
  [3, 4, 0, 0, 4, 0, 1, 0, 3, 0],
  [2, 6, 0, 0, 6, 0, 0, 1, 3, 0],
  [3, 6, 0, 0, 5, 0, 0, 0, 2, 0],
  [2, 6, 0, 0, 7, 0, 1, 0, 2, 0],
  [1, 0, 2, 1, 5, 6, 0, 0, 2, 3],
  [1, 0, 2, 0, 7, 8, 0, 0, 2, 2],
  [1, 0, 0, 0, 7, 7, 1, 0, 4, 0],
  [2, 6, 0, 0, 5, 5, 1, 0, 2, 0],
];
// Two subsets: bit i set means texel i is in the second.
const BC7_P2 = [0xCCCC, 0x8888, 0xEEEE, 0xECC8, 0xC880, 0xFEEC, 0xFEC8, 0xEC80, 0xC800, 0xFFEC, 0xFE80, 0xE800, 0xFFE8, 0xFF00, 0xFFF0, 0xF000,
  0xF710, 0x008E, 0x7100, 0x08CE, 0x008C, 0x7310, 0x3100, 0x8CCE, 0x088C, 0x3110, 0x6666, 0x366C, 0x17E8, 0x0FF0, 0x718E, 0x399C,
  0xAAAA, 0xF0F0, 0x5A5A, 0x33CC, 0x3C3C, 0x55AA, 0x9696, 0xA55A, 0x73CE, 0x13C8, 0x324C, 0x3BDC, 0x6996, 0xC33C, 0x9966, 0x0660,
  0x0272, 0x04E4, 0x4E40, 0x2720, 0xC936, 0x936C, 0x39C6, 0x639C, 0x9336, 0x9CC6, 0x817E, 0xE718, 0xCCF0, 0x0FCC, 0x7744, 0xEE22];
// Three subsets: texel i's subset is the i-th digit.
const BC7_P3 = [
  '0011001102212222', '0001001122112221', '0000200122112211', '0222002200110111', '0000000011221122', '0011001100220022', '0022002211111111', '0011001122112211',
  '0000000011112222', '0000111111112222', '0000111122222222', '0012001200120012', '0112011201120112', '0122012201220122', '0011011211221222', '0011200122002220',
  '0001001101121122', '0111001120012200', '0000112211221122', '0022002200221111', '0111011102220222', '0001000122212221', '0000001101220122', '0000110022102210',
  '0122012200110000', '0012001211222222', '0110122112210110', '0000011012211221', '0022110211020022', '0110011020022222', '0011012201220011', '0000200022112221',
  '0000000211221222', '0222002200120011', '0011001200220222', '0120012001200120', '0000111122220000', '0120120120120120', '0120201212010120', '0011220011220011',
  '0011112222000011', '0101010122222222', '0000000021212121', '0022112200221122', '0022001100220011', '0220122102201221', '0101222222220101', '0000212121212121',
  '0101010101012222', '0222011102220111', '0002111200021112', '0000211221122112', '0222011101110222', '0002111211120002', '0110011001102222', '0000000021122112',
  '0110011022222222', '0022001100110022', '0022112211220022', '0000000000002112', '0002000100020001', '0222122202221222', '0101222222222222', '0111201122012220',
].map((p) => Uint8Array.from(p, Number));
// The texel whose index drops its top bit, in the second and third subsets.
const BC7_A2 = [15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 2, 8, 2, 2, 8, 8, 15, 2, 8, 2, 2, 8, 8, 2, 2,
  15, 15, 6, 8, 2, 8, 15, 15, 2, 8, 2, 2, 2, 15, 15, 6, 6, 2, 6, 8, 15, 15, 2, 2, 15, 15, 15, 15, 15, 2, 2, 15];
const BC7_A3A = [3, 3, 15, 15, 8, 3, 15, 15, 8, 8, 6, 6, 6, 5, 3, 3, 3, 3, 8, 15, 3, 3, 6, 10, 5, 8, 8, 6, 8, 5, 15, 15,
  8, 15, 3, 5, 6, 10, 8, 15, 15, 3, 15, 5, 15, 15, 15, 15, 3, 15, 5, 5, 5, 8, 5, 10, 5, 10, 8, 13, 15, 12, 3, 3];
const BC7_A3B = [15, 8, 8, 3, 15, 15, 3, 8, 15, 15, 15, 15, 15, 15, 15, 8, 15, 8, 15, 3, 15, 8, 15, 8, 3, 15, 6, 10, 15, 15, 10, 8,
  15, 3, 15, 10, 10, 8, 9, 10, 6, 15, 8, 15, 3, 6, 6, 8, 15, 3, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 3, 15, 15, 8];
const BC7_WEIGHTS = [null, null, [0, 21, 43, 64], [0, 9, 18, 27, 37, 46, 55, 64],
  [0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64]];

function decodeBc7(buffer, width, height) {
  const bw = Math.ceil(width / 4);
  const bh = Math.ceil(height / 4);
  if (buffer.byteLength < 148 + (bw * bh * 16)) return null;
  const src = new Uint8Array(buffer, 148, bw * bh * 16);
  const out = new Uint8Array(width * height * 4);
  // Reused across blocks, as above.
  const ends = new Uint8Array(6 * 4);
  const idx = new Uint8Array(16);
  const idx2 = new Uint8Array(16);
  const px = new Uint8Array(4);

  for (let b = 0; b < bw * bh; b++) {
    const o = b * 16;
    let bit = 0;
    const read = (n) => {
      let v = 0;
      for (let i = 0; i < n; i++, bit++) v |= ((src[o + (bit >> 3)] >> (bit & 7)) & 1) << i;
      return v;
    };
    let mode = 0;
    while (mode < 8 && !read(1)) mode++;
    const bx = (b % bw) * 4, by = Math.floor(b / bw) * 4;
    if (mode === 8) continue;                      // reserved: transparent black, as the format says
    const [ns, pb, rb, isb, cb, ab, epb, spb, ib, ib2] = BC7_MODES[mode];
    const part = read(pb), rot = read(rb), sel = read(isb);
    const n = ns * 2;
    for (let c = 0; c < 3; c++) for (let e = 0; e < n; e++) ends[e * 4 + c] = read(cb);
    for (let e = 0; e < n; e++) ends[e * 4 + 3] = ab ? read(ab) : 255;
    let cbits = cb, abits = ab;
    if (epb || spb) {
      const pbits = epb ? n : ns;
      const p = [];
      for (let i = 0; i < pbits; i++) p.push(read(1));
      for (let e = 0; e < n; e++) {
        const q = epb ? p[e] : p[e >> 1];
        for (let c = 0; c < (ab ? 4 : 3); c++) ends[e * 4 + c] = (ends[e * 4 + c] << 1) | q;
      }
      cbits++;
      if (ab) abits++;
    }
    for (let e = 0; e < n; e++) {
      for (let c = 0; c < 3; c++) { const v = ends[e * 4 + c]; ends[e * 4 + c] = (v << (8 - cbits)) | (v >> (2 * cbits - 8)); }
      if (ab) { const v = ends[e * 4 + 3]; ends[e * 4 + 3] = (v << (8 - abits)) | (v >> (2 * abits - 8)); }
    }
    for (let i = 0; i < 16; i++) {
      const anchor = i === 0 || (ns === 2 && i === BC7_A2[part]) || (ns === 3 && (i === BC7_A3A[part] || i === BC7_A3B[part]));
      idx[i] = read(anchor ? ib - 1 : ib);
    }
    if (ib2) for (let i = 0; i < 16; i++) idx2[i] = read(i === 0 ? ib2 - 1 : ib2);

    for (let i = 0; i < 16; i++) {
      const x = bx + (i & 3), y = by + (i >> 2);
      if (x >= width || y >= height) continue;
      const s = ns === 1 ? 0 : ns === 2 ? (BC7_P2[part] >> i) & 1 : BC7_P3[part][i];
      let ci = idx[i], ai = idx[i], cw = BC7_WEIGHTS[ib], aw = BC7_WEIGHTS[ib];
      if (ib2) {
        if (sel) { ci = idx2[i]; cw = BC7_WEIGHTS[ib2]; } else { ai = idx2[i]; aw = BC7_WEIGHTS[ib2]; }
      }
      const e0 = s * 8, e1 = e0 + 4;
      for (let c = 0; c < 3; c++) px[c] = ((64 - cw[ci]) * ends[e0 + c] + cw[ci] * ends[e1 + c] + 32) >> 6;
      px[3] = ab ? ((64 - aw[ai]) * ends[e0 + 3] + aw[ai] * ends[e1 + 3] + 32) >> 6 : 255;
      if (rot) { const t = px[3]; px[3] = px[rot - 1]; px[rot - 1] = t; }
      out.set(px, (y * width + x) * 4);
    }
  }
  return { width, height, pixels: out };
}
