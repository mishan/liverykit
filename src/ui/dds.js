// ---------------------------------------------------------------------------
// DDS, decoded to plain RGBA in JavaScript.
//
// SHARED BY BOTH RENDERERS, which is the whole reason it is its own file. The
// browser needs it for the formats the GPU cannot take as blocks; Node needs it
// for the formats ImageMagick refuses, and those are the same formats. Kept
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
  const dxt = { 0x31545844: 1, 0x33545844: 3, 0x35545844: 5 }[head.getUint32(84, true)];
  if (!width || !height) return null;

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
  if (buffer.byteLength < 128 + (bw * bh * blockBytes)) return null;
  const src = new Uint8Array(buffer, 128, bw * bh * blockBytes);
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
