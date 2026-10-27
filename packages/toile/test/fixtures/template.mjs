// ---------------------------------------------------------------------------
// Synthetic livery templates.
//
// A publisher's template is its artwork and is not committed, any more than a
// kn5 is. These are drawn here instead, small enough to assert on exactly: a
// plan view's worth of islands, each drawn as a mesh would be, every cell
// edge, so a test can tell an island from the hundred cells it is drawn as.
// ---------------------------------------------------------------------------

export const SHEET = { width: 200, height: 300 };

/**
 * The islands, in pixels: a roof, two mirrored flanks with a notch out of
 * each (an L, so an outline that filled the notch would be wrong), a bumper,
 * and a speck too small to keep.
 */
export const ISLANDS = {
  roof: { rect: [70, 40, 60, 120] },
  left: { rect: [10, 60, 40, 180], notch: [30, 60, 20, 60] },
  right: { rect: [150, 60, 40, 180], notch: [150, 60, 20, 60] },
  bumper: { rect: [60, 250, 80, 30] },
};
export const SPECK = [100, 200, 2, 2];

const inside = ({ rect: [x, y, w, h], notch }, px, py) =>
  px >= x && px < x + w && py >= y && py < y + h &&
  !(notch && px >= notch[0] && px < notch[0] + notch[2] && py >= notch[1] && py < notch[1] + notch[3]);

/**
 * The layout as a template draws it: 1 on a line, 0 elsewhere. Lines run
 * every `cell` pixels within an island, and round its edge.
 */
export function wireframe({ cell = 6 } = {}) {
  const { width, height } = SHEET;
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    for (const isl of Object.values(ISLANDS)) {
      if (!inside(isl, x, y)) continue;
      const edge = !inside(isl, x - 1, y) || !inside(isl, x + 1, y) || !inside(isl, x, y - 1) || !inside(isl, x, y + 1);
      if (edge || (x - isl.rect[0]) % cell === 0 || (y - isl.rect[1]) % cell === 0) out[y * width + x] = 1;
    }
  }
  const [sx, sy, sw, sh] = SPECK;
  for (let y = sy; y < sy + sh; y++) for (let x = sx; x < sx + sw; x++) out[y * width + x] = 1;
  return out;
}

/** The layout as a silhouette: drawn everywhere but the islands. */
export function silhouette() {
  const { width, height } = SHEET;
  const out = new Uint8Array(width * height).fill(1);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (Object.values(ISLANDS).some((isl) => inside(isl, x, y))) out[y * width + x] = 0;
  }
  return out;
}

const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const i16 = (n) => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const block = (data) => Buffer.concat([u32(data.length), data]);
const info = (key, data) => Buffer.concat([Buffer.from('8BIM' + key, 'ascii'), block(data)]);

/** PackBits, a literal run at a time: valid, if not small. */
function packBits(row) {
  const out = [];
  for (let i = 0; i < row.length; i += 128) {
    const run = row.subarray(i, i + 128);
    out.push(Buffer.from([run.length - 1]), Buffer.from(run));
  }
  return Buffer.concat(out);
}

function channel(pixels, w, h, compression) {
  if (compression === 0) return Buffer.concat([u16(0), Buffer.from(pixels)]);
  if (compression === 1) {
    const rows = Array.from({ length: h }, (_, y) => packBits(pixels.subarray(y * w, (y + 1) * w)));
    return Buffer.concat([u16(1), ...rows.map((r) => u16(r.length)), ...rows]);
  }
  return Buffer.concat([u16(compression), Buffer.alloc(8)]);
}

/**
 * A PSD of the given layers, top first as Photoshop lists them, each
 * `{ name, alpha, visible?, compression?, group?, bbox? }` with `alpha` over the
 * whole sheet and stored cropped to `bbox` (default the whole sheet). Gray
 * color channels, since nothing reads them.
 */
export function psd(layers, { width = SHEET.width, height = SHEET.height, depth = 8, version = 1 } = {}) {
  const records = [], data = [];
  for (const l of [...layers].reverse()) {
    const [left, top, right, bottom] = l.bbox ?? [0, 0, width, height];
    const w = right - left, h = bottom - top;
    const crop = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) crop[y * w + x] = l.alpha ? l.alpha[(y + top) * width + x + left] * 255 : 0;
    const chans = [[-1, crop], [0, new Uint8Array(w * h)], [1, new Uint8Array(w * h)], [2, new Uint8Array(w * h)]]
      .map(([id, px]) => [id, channel(px, w, h, l.compression ?? 0)]);
    const latin = Buffer.from(l.name.replace(/[^\x20-\x7e]/g, '?'), 'latin1');
    const pascal = Buffer.alloc((latin.length + 4) & ~3); pascal[0] = latin.length; latin.copy(pascal, 1);
    const luni = Buffer.concat([u32(l.name.length), ...[...l.name].map((c) => u16(c.charCodeAt(0))), Buffer.alloc(2)]);
    const extra = Buffer.concat([block(Buffer.alloc(0)), block(Buffer.alloc(0)), pascal, info('luni', luni), ...(l.group ? [info('lsct', u32(1))] : [])]);
    records.push(Buffer.concat([
      u32(top), u32(left), u32(bottom), u32(right), u16(chans.length),
      ...chans.map(([id, c]) => Buffer.concat([i16(id), u32(c.length)])),
      Buffer.from('8BIMnorm', 'ascii'), Buffer.from([255, 0, l.visible === false ? 2 : 0, 0]), block(extra),
    ]));
    data.push(...chans.map(([, c]) => c));
  }
  const layerInfo = block(Buffer.concat([i16(records.length), ...records, ...data]));
  return Buffer.concat([
    Buffer.from('8BPS', 'ascii'), u16(version), Buffer.alloc(6), u16(3), u32(height), u32(width), u16(depth), u16(3),
    block(Buffer.alloc(0)), block(Buffer.alloc(0)), block(Buffer.concat([layerInfo, u32(0)])),
    u16(0), Buffer.alloc(3 * width * height),
  ]);
}
