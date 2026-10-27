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

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import sharp from 'sharp';
import { readPsd } from './psd.mjs';
import { capOutline, textRotation } from './engine/islands.mjs';
import { tagProfile } from './engine/tags.mjs';
import { PROFILE_SCHEMA } from './profile.mjs';
import { sectionAt } from './frame.mjs';

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

/**
 * A profile from a template: one texture, `texture` as the game names the
 * file, sized as the template is, with a panel per island.
 *
 * Where an island sits on the car is a person's to state, and `nose` states
 * it: the template is a plan view, the car seen from above with its sides
 * folded out, nose at the sheet's `top` or `bottom`. Then each panel gets a
 * proposed `plan` place, read off the sheet: across the car by its distance
 * from the layout's middle, along it by its height on the sheet. Islands
 * mirrored about that middle are mirror pairs. Panels are named and tagged by
 * that place, as a model's are by where it measures them. A flank laid out
 * flat is an elevation drawn into a plan, so its place is the layout's and
 * not the car's, and is recorded as proposed for that reason.
 *
 * Without `nose`, which a side-on template like the Chevette's needs, the
 * panels are numbered by size and have no place, and the profile says so.
 *
 * How a flank is laid in a plan varies too: the Porsche 991's are drawn with
 * the sill towards the middle of the sheet, the Corolla's with the roofline.
 * `flankTop: 'inward' | 'outward'` says which, and every side panel then gets
 * the axes a model would have measured for it, `uAxis` and `vAxis`, and from
 * them its `textRotation` and whether it is `reflected`, so lettering reads
 * along the car and a placement mirrors onto the far flank the right way
 * round. Without it, a flank's lettering keeps the sheet's own orientation.
 *
 * Nor can a template say what is seen, and nearly every rule of a portable
 * design asks for `visible`. An island of `seenArea` of the sheet or more is
 * proposed as seen, `visibleBy: 'size'`: the doors, bonnet and roof a design
 * means, at the cost of a mirror under it and an undertray over it, for a
 * person to correct.
 */
export async function profileFromTemplate(path, { id = null, name = '', texture, role = 'body', nose = null, flankTop = null, layer, minArea, seenArea = 0.01, log = () => {} } = {}) {
  if (!texture) throw new Error('a template profile needs the texture file the game reads this sheet as, which the game\'s own files name');
  if (flankTop !== null && !['inward', 'outward'].includes(flankTop)) throw new Error(`flankTop is "inward" or "outward", the way a flank's top edge faces on the sheet, not ${JSON.stringify(flankTop)}`);
  if (flankTop && !nose) throw new Error('flankTop says how flanks are laid in a plan view, so it needs nose to say the template is one');
  if (nose !== null && !['top', 'bottom'].includes(nose)) throw new Error(`nose is "top" or "bottom", the end of the sheet the car's nose is drawn at, not ${JSON.stringify(nose)}`);
  const data = await readFile(path);
  const t = await readTemplate(data, { path: basename(String(path)), layer });
  const { islands, notes } = sheetIslands(t.drawn, t.width, t.height, { minArea });
  log(`  ${islands.length} islands on ${t.layer === null ? 'the image' : `layer ${JSON.stringify(t.layer)}`}`);
  for (const n of notes) log(`  ${n}`);

  const panels = {};
  if (nose) {
    const { beyond, unpaired } = placeOnPlan(islands, nose);
    if (beyond) log(`  ${beyond} island(s) lie beyond the car's span on the sheet and are placed at its edge`);
    if (unpaired) log(`  ${unpaired} island(s) off the middle found no mirror image across it`);
    const counts = new Map();
    for (const isl of islands) {
      const { x, along } = isl.mid;
      const base = `${Math.abs(x) < 0.18 ? 'centre' : x > 0 ? 'left' : 'right'}_${sectionAt(along)}`;
      const seen = counts.get(base) ?? 0;
      counts.set(base, seen + 1);
      isl.name = seen ? `${base}_${seen + 1}` : base;
    }
    for (const isl of islands) if (isl.mirror) isl.mirrorOf = isl.mirror.name;
    if (flankTop) orientFlanks(islands, nose, flankTop);
    else log('  no flankTop was given, so lettering on the flanks keeps the sheet\'s orientation');
  } else {
    islands.forEach((isl, n) => { isl.name = `island_${n + 1}`; });
    log('  no nose was given, so the panels have no place on the car and no side or section to be found by');
  }
  panels[role] = Object.fromEntries(islands.map((i) => [i.name, {
    rect: i.rect.map(r5),
    confidence: 'proposed',
    ...(i.plan ? { plan: i.plan } : {}),
    ...(i.mirrorOf ? { mirrorOf: i.mirrorOf } : {}),
    ...(i.uAxis ? { uAxis: i.uAxis, vAxis: i.vAxis, ...(i.textRotation !== null ? { textRotation: i.textRotation } : {}), ...(i.reflected ? { reflected: true } : {}) } : {}),
    ...(i.uvArea >= seenArea ? { visibleBy: 'size' } : {}),
    outline: i.outline,
  }]));

  const profile = {
    schemaVersion: PROFILE_SCHEMA,
    id: id ?? basename(String(path)).replace(/\.[^.]+$/, ''),
    name,
    calibration: {
      method: 'template',
      source: basename(String(path)),
      template: { bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') },
      ...(t.layer !== null ? { layer: t.layer } : {}),
      date: new Date().toISOString().slice(0, 10),
      uvSet: 0,
      ...(nose ? { plan: { nose, ...(flankTop ? { flankTop } : {}), from: 'stated' } } : {}),
    },
    textures: { [role]: { file: texture, width: t.width, height: t.height } },
    doNotPaint: [],
    panels,
  };
  tagProfile(profile);
  return profile;
}

const r5 = (v) => Math.round(v * 1e5) / 1e5;

/**
 * Each island's `plan`, `mid` and mirror, measured against the islands that
 * are the car: those of a hundredth of the sheet or more, whose span is its
 * width and length. A strip of spare parts along the sheet's foot would
 * otherwise stretch the car to reach it. A sheet with none that big is all
 * small parts, and they are the car. Returns how many islands lie beyond the
 * car and how many off its middle have no mirror.
 */
function placeOnPlan(islands, nose) {
  const sized = islands.filter((i) => i.uvArea >= 0.01);
  const big = sized.length ? sized : islands;
  const u0 = Math.min(...big.map((i) => i.rect[0])), u1 = Math.max(...big.map((i) => i.rect[0] + i.rect[2]));
  const v0 = Math.min(...big.map((i) => i.rect[1])), v1 = Math.max(...big.map((i) => i.rect[1] + i.rect[3]));
  const axis = (u0 + u1) / 2, half = (u1 - u0) / 2 || 1, length = (v1 - v0) || 1;
  // Seen from above with the nose up, the car's left is on the sheet's left.
  const flip = nose === 'top' ? -1 : 1;
  // Small parts beyond the car's span are placed at its edge.
  let clamped = false;
  const clamp = (v, lo) => { const c = Math.min(1, Math.max(lo, v)); clamped ||= Math.abs(c - v) > 1e-9; return c; };
  const across = (u) => r3(clamp(flip * (u - axis) / half, -1));
  const along = (v) => r3(clamp(nose === 'top' ? 1 - (v - v0) / length : (v - v0) / length, 0));
  let beyond = 0;
  for (const i of islands) {
    const [x, y, w, h] = i.rect;
    clamped = false;
    i.plan = { across: [across(x), across(x + w)].sort((a, b) => a - b), along: [along(y), along(y + h)].sort((a, b) => a - b) };
    i.mid = { x: (i.plan.across[0] + i.plan.across[1]) / 2, along: (i.plan.along[0] + i.plan.along[1]) / 2 };
    if (clamped) beyond++;
  }
  // A mirror is the island whose middle reflected about the car's is this
  // one's, to a hundredth of the car's width and length, of the same size to a
  // tenth. Off the middle only: an island on it is its own reflection.
  for (const a of islands) {
    if (a.mirror || Math.abs(a.mid.x) < 0.05) continue;
    const b = islands.find((b) => b !== a && !b.mirror && Math.abs(b.mid.x + a.mid.x) < 0.02 &&
      Math.abs(b.mid.along - a.mid.along) < 0.01 && Math.abs(b.uvArea - a.uvArea) <= 0.1 * Math.max(a.uvArea, b.uvArea));
    if (b) { a.mirror = b; b.mirror = a; }
  }
  return { beyond, unpaired: islands.filter((i) => !i.mirror && Math.abs(i.mid.x) >= 0.05).length };
}

const r3 = (v) => Math.round(v * 1000) / 1000;

/**
 * A side panel's axes, in a frame with the car's left along +x, up along +y
 * and its nose along +z. Down the sheet runs towards the tail with the nose
 * at the top. Across it, a flank's top faces the middle of the sheet or away
 * from it, and the middle is +u from a flank on the sheet's left.
 */
function orientFlanks(islands, nose, flankTop) {
  for (const i of islands) {
    if (Math.abs(i.mid.x) < 0.18) continue;
    const left = i.mid.x > 0 ? 1 : -1;
    const onSheetLeft = (left > 0) === (nose === 'top');
    const topAlongU = (flankTop === 'inward') === onSheetLeft ? 1 : -1;
    i.uAxis = [0, topAlongU, 0];
    i.vAxis = [0, 0, nose === 'top' ? -1 : 1];
    const outward = [left, 0, 0];
    i.textRotation = textRotation(i.vAxis, outward);
    // As a model's island is: a sheet read right and down seen from outside
    // is a mirror image when (u, v, outward) is right-handed.
    const [u, v] = [i.uAxis, i.vAxis];
    i.reflected = (u[1] * v[2] - u[2] * v[1]) * left > 0;
  }
}

function* edge(width, height) {
  for (let x = 0; x < width; x++) { yield x; if (height > 1) yield (height - 1) * width + x; }
  for (let y = 1; y < height - 1; y++) { yield y * width; if (width > 1) yield y * width + width - 1; }
}

const share = (a) => { let c = 0; for (const v of a) if (v >= DRAWN) c++; return c / a.length; };
