// ---------------------------------------------------------------------------
// UV islands from a livery template, for a game that publishes templates and
// not its models.
//
// A template's wireframe layer is the UV layout drawn as lines: on most, every
// polygon edge; on some, only each island's outline. Either way the sheet
// outside the islands is one open region reaching the sheet's edge, and an
// island is whatever that region does not reach. So the islands are the
// complement of a flood fill from the border, and a mesh drawn edge by edge
// comes out as one island rather than a thousand cells.
//
// What it cannot know is what a model would say: where an island sits on the
// car, which way it faces, its size in meters. Those are a person's to state.
// And two islands drawn touching are one island here, which on Reiza's
// templates happened on two cars of twelve.
// ---------------------------------------------------------------------------

import sharp from 'sharp';
import { readPsd } from './psd.mjs';
import { capOutline } from './engine/islands.mjs';

/** Antialiased line edges are faint; a pixel is drawn from an eighth up. */
const DRAWN = 32;

/**
 * The template's wireframe as a drawn/undrawn mask over the whole sheet.
 *
 * A PSD is read by layer. The one used is `layer` if given, else the one
 * named UV, else the only one that looks like a wireframe: spanning the sheet
 * and mostly empty. A template's other layers are its background, fills and
 * the publisher's logos, and the hidden ones count, because a template's
 * author hid the wireframe on at least one. A PNG or other image is either
 * the layer exported on its own with transparency, or a wireframe on a plain
 * background, which is then whatever color most of the sheet's edge is.
 */
export async function readTemplate(data, { path = 'template', layer } = {}) {
  if (data.toString('ascii', 0, 4) === '8BPS') {
    const psd = readPsd(data, { path });
    const { width, height } = psd;
    const layers = psd.layers.filter((l) => !l.group);
    let chosen;
    if (layer != null) {
      chosen = layers.find((l) => l.name === layer);
      if (!chosen) throw new Error(`${path} has no layer ${JSON.stringify(layer)}; its layers are ${layers.map((l) => JSON.stringify(l.name)).join(', ')}`);
    } else {
      chosen = layers.find((l) => /^uv$/i.test(l.name.trim()));
    }
    if (!chosen) {
      const looks = layers.map((l) => ({ l, drawn: share(l.alpha()) })).filter(({ l, drawn }) => {
        const [x0, y0, x1, y1] = l.bbox;
        return drawn >= 0.01 && drawn <= 0.15 && (Math.min(x1, width) - Math.max(x0, 0)) >= 0.9 * width && (Math.min(y1, height) - Math.max(y0, 0)) >= 0.9 * height;
      });
      if (looks.length !== 1) {
        throw new Error(`${path}: ${looks.length ? `${looks.map(({ l }) => JSON.stringify(l.name)).join(' and ')} all look like` : 'none of its layers looks like'} a wireframe; name the one that is (its layers are ${layers.map((l) => JSON.stringify(l.name)).join(', ')})`);
      }
      chosen = looks[0].l;
    }
    const drawn = chosen.alpha();
    for (let i = 0; i < drawn.length; i++) drawn[i] = drawn[i] >= DRAWN ? 1 : 0;
    return { width, height, layer: chosen.name, drawn };
  }

  if (layer != null) throw new Error(`${path} is not a PSD, so it has no layer ${JSON.stringify(layer)} to choose`);
  const { data: px, info } = await sharp(data).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const drawn = new Uint8Array(width * height);
  // Transparent where the sheet is empty, judged as the background color
  // is, from the edge: one translucent pixel in an opaque image is not an
  // export of the layer on its own.
  let clearEdge = 0, edgeCount = 0;
  for (const i of edge(width, height)) { clearEdge += px[4 * i + 3] < 255; edgeCount++; }
  if (clearEdge * 2 > edgeCount) {
    for (let i = 0; i < drawn.length; i++) drawn[i] = px[4 * i + 3] >= DRAWN ? 1 : 0;
  } else {
    const counts = new Map();
    for (const i of edge(width, height)) { const k = px.readUIntBE(4 * i, 3); counts.set(k, (counts.get(k) ?? 0) + 1); }
    const bg = [...counts].sort((a, b) => b[1] - a[1])[0][0];
    const [r, g, b] = [bg >> 16, (bg >> 8) & 255, bg & 255];
    for (let i = 0; i < drawn.length; i++) {
      drawn[i] = Math.abs(px[4 * i] - r) + Math.abs(px[4 * i + 1] - g) + Math.abs(px[4 * i + 2] - b) >= 3 * DRAWN ? 1 : 0;
    }
  }
  return { width, height, layer: null, drawn };
}

/**
 * The islands of a drawn mask, largest first: { rect, uvArea, outline } in
 * sheet fractions, as `findIslands` gives them for a model, with notes on
 * what was left out.
 *
 * Usually the edge of the sheet is undrawn and the islands are drawn on it.
 * A template whose layer is a silhouette, opaque everywhere but the islands,
 * has its edge drawn instead, and is read the other way round. Anything under
 * `minArea` of the sheet is a speck: a bolt, a badge, a stray mark.
 */
export function sheetIslands(drawn, width, height, { minArea = 1e-4 } = {}) {
  const n = width * height;
  let onEdge = 0, edgeCount = 0;
  for (const i of edge(width, height)) { onEdge += drawn[i]; edgeCount++; }
  const outside = onEdge * 2 > edgeCount ? 1 : 0;

  // Outside is flooded 4-connected and islands labeled 8-connected, so a
  // diagonal step between two antialiased line pixels is a wall to the
  // outside and a join within an island, which is what a line drawn at a
  // slant means.
  const label = new Int32Array(n);            // 0 unvisited, -1 outside, >0 island
  let stack = new Int32Array(1 << 16), top = 0;
  const push = (i) => { if (top === stack.length) { const s = new Int32Array(stack.length * 2); s.set(stack); stack = s; } stack[top++] = i; };
  for (const i of edge(width, height)) if (drawn[i] === outside && !label[i]) { label[i] = -1; push(i); }
  while (top) {
    const i = stack[--top], x = i % width;
    for (const j of [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, i - width, i + width]) {
      if (j >= 0 && j < n && !label[j] && drawn[j] === outside) { label[j] = -1; push(j); }
    }
  }

  const found = [];
  for (let s = 0; s < n; s++) {
    if (label[s]) continue;
    const id = found.length + 1;
    let count = 0, x0 = width, x1 = 0, y0 = height, y1 = 0;
    label[s] = id; push(s);
    while (top) {
      const i = stack[--top], x = i % width, y = (i - x) / width;
      count++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
        const j = yy * width + xx;
        if (!label[j]) { label[j] = id; push(j); }
      }
    }
    found.push({ id, start: s, count, box: [x0, y0, x1, y1] });
  }

  const islands = [];
  let specks = 0;
  for (const f of found) {
    if (f.count < minArea * n) { specks++; continue; }
    const [x0, y0, x1, y1] = f.box;
    islands.push({
      rect: [x0 / width, y0 / height, (x1 + 1 - x0) / width, (y1 + 1 - y0) / height],
      uvArea: f.count / n,
      outline: capOutline(trace(label, width, height, f.id, f.start).map(([x, y]) => [(x + 0.5) / width, (y + 0.5) / height])),
    });
  }
  const notes = [];
  if (outside) notes.push('the layer is drawn all round the sheet\'s edge, so it is read as a silhouette: the islands are where it is clear');
  if (specks) notes.push(`${specks} speck(s) under ${minArea * 100}% of the sheet are left out`);
  if (!islands.length) notes.push('no islands were found: the layer is empty, or drawn everywhere');
  return { islands: islands.sort((a, b) => b.uvArea - a.uvArea), notes };
}

/**
 * An island's outer boundary, pixel by pixel, by Moore-neighbor tracing from
 * its first pixel in scan order, which is on that boundary with nothing of the
 * island above or to its left.
 */
function trace(label, width, height, id, start) {
  const DX = [-1, -1, 0, 1, 1, 1, 0, -1], DY = [0, -1, -1, -1, 0, 1, 1, 1];  // clockwise from west
  const inside = (x, y) => x >= 0 && y >= 0 && x < width && y < height && label[y * width + x] === id;
  const sx = start % width, sy = (start - sx) / width;
  const out = [];
  let x = sx, y = sy, from = 0, first = -1;
  for (;;) {
    let k = 0;
    while (k < 8 && !inside(x + DX[(from + k) % 8], y + DY[(from + k) % 8])) k++;
    if (k === 8) return [[sx, sy]];           // a single pixel
    const d = (from + k) % 8;
    // Back at the start and about to leave it the way it first left: a
    // one-pixel neck passes through the start twice, and only this is done.
    if (x === sx && y === sy) { if (d === first) return out; if (first < 0) first = d; }
    out.push([x, y]);
    x += DX[d]; y += DY[d];
    // The next search starts at the last outside pixel this one looked at,
    // seen from where the walk now is.
    from = (d + (d % 2 ? 5 : 6)) % 8;
  }
}

function* edge(width, height) {
  for (let x = 0; x < width; x++) { yield x; if (height > 1) yield (height - 1) * width + x; }
  for (let y = 1; y < height - 1; y++) { yield y * width; if (width > 1) yield y * width + width - 1; }
}

const share = (a) => { let c = 0; for (const v of a) if (v >= DRAWN) c++; return c / a.length; };
