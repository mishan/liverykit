// ---------------------------------------------------------------------------
// A livery's own images, and the region that places one.
//
// Everything else a design does is code that emits vectors, which is what makes
// it portable and readable as a diff. A sponsor's logo is not that: it is
// somebody else's artwork, it arrives as a file, and the only honest thing to
// do is put its pixels on the car. So a livery may be a folder with an
// `decals/` directory, and `decal` places what it finds there.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

import '../src/index.mjs';
import { loadDecals } from '../src/decals.mjs';
import { resolveLivery } from '../src/livery.mjs';
import { fitLiveryId } from '../src/fit.mjs';
import { renderTexture } from '../src/render.mjs';
import { resolveTreatments } from '../src/registry.mjs';

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="#0f0"/></svg>';

/** A livery folder with an decals/ directory, and whatever is asked for in it. */
async function folder(files = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'lk-decal-'));
  await mkdir(join(dir, 'decals'), { recursive: true });
  await writeFile(join(dir, 'livery.mjs'), 'export default { name: "T", folder: "t", surfaces: {} };\n');
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(dir, 'decals', name), body);
  }
  return dir;
}

const png = (w, h) => sharp({ create: { width: w, height: h, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 255 } } })
  .png().toBuffer();

test('decals are named by their file, and an SVG arrives as pixels', async () => {
  const dir = await folder({
    'sponsor.png': await png(400, 100),
    'flag.svg': SVG,
    'notes.txt': 'not an image',
  });
  const said = [];
  const decals = await loadDecals(dir, { log: (l) => said.push(l) });

  assert.deepEqual([...decals.keys()].sort(), ['flag', 'sponsor'],
    'addressed by the stem, so a design never writes an extension');
  assert.equal(decals.get('sponsor').width, 400);

  // RASTERISED AT THE DOOR. A design is a file people download from each
  // other and the editor renders the finished document as innerHTML, so
  // foreign markup inside a sheet is a way to lose — one this project has
  // already lost once. An SVG asset reaches librsvg here and nothing after it.
  const flag = decals.get('flag');
  assert.equal(flag.type, 'image/png');
  assert.ok(flag.uri.startsWith('data:image/png;base64,'));
  // And rendered at a useful size rather than at whatever the author's editor
  // wrote in the header: 120x60 would be a blur across a door.
  assert.equal(Math.max(flag.width, flag.height), 2048);
  assert.equal(flag.width / flag.height, 2, 'at its own aspect');

  assert.ok(said.some((l) => /notes\.txt/.test(l) && /skipped/.test(l)),
    'and what it would not take, it names');
});

test('two decals that a design could not tell apart are refused', async () => {
  // `logo.png` and `logo.svg` are one name to a design. Picking by sort order
  // would make which artwork lands on the car depend on a rule nobody wrote
  // down — the same failure as a case collision in a skin folder.
  const dir = await folder({ 'logo.png': await png(8, 8), 'logo.svg': SVG });
  await assert.rejects(() => loadDecals(dir), /both called "logo"/);
});

test('a single-file livery has no decals, and says which it is', async () => {
  // The folder is what gives a design somewhere of its own to keep images. A
  // single file would otherwise have to share `liveries/`, where it would find
  // every other design's artwork.
  const dir = await folder({ 'sponsor.png': await png(8, 8) });
  assert.equal((await loadDecals(null)).size, 0);

  const found = await resolveLivery(dir);
  assert.equal(found.path, join(dir, 'livery.mjs'));
  assert.equal(found.dir, dir, 'and the folder travels with it');

  // A folder with nothing to open is a mistake worth naming, not a livery
  // that resolves to its own directory and fails somewhere further on.
  const empty = await mkdtemp(join(tmpdir(), 'lk-empty-'));
  await assert.rejects(() => resolveLivery(empty), /no livery\.mjs or livery\.json/);
});

test('a livery folder is named by the folder, not by the file inside it', () => {
  // Every folder livery holds a file called `livery`, so the basename would
  // give them all the same identity — and a fit written for one would load
  // happily against another.
  assert.equal(fitLiveryId('/x/liveries/neon-doll/livery.mjs'), 'neon-doll');
  assert.equal(fitLiveryId('/x/liveries/neon-doll/livery.json'), 'neon-doll');
  assert.equal(fitLiveryId('/x/liveries/neon-grid.mjs'), 'neon-grid', 'and a file is still its own name');
});

/** A one-panel car, and a design that places one decal on it. */
async function drawn(region, { decals, anisotropy = 1 } = {}) {
  const profile = {
    id: 'c', name: 'C',
    textures: { body: { file: 'b.dds', width: 1000, height: 1000 } },
    panels: { body: { L: { rect: [0, 0, 1, 1], anisotropy } } },
  };
  const regionNotes = [];
  const out = renderTexture({
    profile, role: 'body', treatments: resolveTreatments(['core']), palette: {},
    rng: Math.random, font: 'sans-serif', tokens: {}, decals, regionNotes,
    regions: [{ id: 'mark', panel: 'L', at: [0, 0, 1, 0.5], ...region }],
  });
  const box = /<image href="data:([^"]+)" x="([\d.-]+)" y="([\d.-]+)" width="([\d.-]+)" height="([\d.-]+)"/.exec(out.base + out.emissive);
  return { out, regionNotes, box: box && { x: +box[2], y: +box[3], w: +box[4], h: +box[5] } };
}

test('a decal is placed at the aspect the artwork has ON THE CAR', async () => {
  const dir = await folder({ 'sponsor.png': await png(400, 100) });
  const decals = await loadDecals(dir);

  // The region is 1000x500 texels and the artwork is 4:1, so `contain` fits it
  // to the full width and a quarter of that in height.
  const square = await drawn({ treatment: 'decal', image: 'sponsor' }, { decals });
  assert.deepEqual(square.box, { x: 0, y: 125, w: 1000, h: 250 });

  // ANISOTROPY IS THE WHOLE TRICK. A square of texture lands twice as wide as
  // tall on this panel, so artwork fitted to its own pixel ratio would come
  // out stretched by exactly that. Half the width, and it reads as 4:1 on the
  // car rather than 8:1.
  const stretched = await drawn({ treatment: 'decal', image: 'sponsor' }, { decals, anisotropy: 2 });
  assert.equal(stretched.box.w / stretched.box.h, 2, 'two in texels, four on the car');
  assert.equal(stretched.box.w, 1000, 'still as wide as it can be');

  // `stretch` is the deliberate opposite: fill the region and never mind.
  const filled = await drawn({ treatment: 'decal', image: 'sponsor', fit: 'stretch' }, { decals });
  assert.deepEqual(filled.box, { x: 0, y: 0, w: 1000, h: 500 });

  // `cover` fills it the other way — bigger than the region — and is clipped
  // to it, because artwork past a region's edge is artwork on another panel.
  const covered = await drawn({ treatment: 'decal', image: 'sponsor', fit: 'cover' }, { decals });
  assert.ok(covered.box.h >= 500 && covered.box.w >= 1000, `covers: ${JSON.stringify(covered.box)}`);
  assert.match(covered.out.base, /<clipPath id="lk-decal-[^"]+"><rect x="0" y="0" width="1000" height="500"\/><\/clipPath>/);
  assert.match(covered.out.base, /<g clip-path="url\(#lk-decal-/);
});

test('a decal that names no asset draws nothing and says so', async () => {
  const dir = await folder({ 'sponsor.png': await png(8, 8) });
  const decals = await loadDecals(dir);

  // The failure this project is arranged against: a region that renders as
  // nothing is indistinguishable on the car from a design that paints nothing
  // there, and the difference is the whole point of the region.
  const missing = await drawn({ treatment: 'decal', image: 'nope' }, { decals });
  assert.equal(missing.box, null);
  assert.equal(missing.regionNotes.length, 1);
  assert.equal(missing.regionNotes[0].status, 'no-decal');
  assert.match(missing.regionNotes[0].text, /mark: no decal called "nope"/);
  assert.match(missing.regionNotes[0].text, /sponsor/, 'and lists what the livery does carry');

  const unnamed = await drawn({ treatment: 'decal' }, { decals });
  assert.equal(unnamed.box, null);
  assert.match(unnamed.regionNotes[0].text, /no "image" was named/);

  // A design with no folder at all gets the same treatment, not a crash.
  const nowhere = await drawn({ treatment: 'decal', image: 'sponsor' }, { decals: new Map() });
  assert.equal(nowhere.box, null);
  assert.match(nowhere.regionNotes[0].text, /nothing in it/);
});

test('a decal can glow, and can be turned down', async () => {
  const dir = await folder({ 'sponsor.png': await png(40, 10) });
  const decals = await loadDecals(dir);

  const glowing = await drawn({ treatment: 'decal', image: 'sponsor', glow: true }, { decals });
  assert.match(glowing.out.base, /<image /, 'the artwork is still on the car');
  assert.match(glowing.out.emissive, /<image /, 'and it lights');

  const faint = await drawn({ treatment: 'decal', image: 'sponsor', opacity: 0.4 }, { decals });
  assert.match(faint.out.base, /opacity="0.4"/);
  const solid = await drawn({ treatment: 'decal', image: 'sponsor', opacity: 1 }, { decals });
  assert.ok(!/opacity=/.test(solid.out.base), 'and full opacity says nothing rather than saying 1');
});

test('a decal is measured by the pixels that reach the document, not by the file', async () => {
  // THE FILE ON DISK IS NOT THE COST. An SVG has no pixels until this
  // rasterises it, and 194 bytes of `feTurbulence` at 2048 square measures 15
  // MB of PNG — every byte of which is then base64'd into every document that
  // draws it, including the whole-car preview the editor re-renders on each
  // frame of a drag. The cap was read off the source file, so that asset
  // sailed through it.
  //
  // A flat green 120x60 SVG is enough to show the shape of it here: 120 bytes
  // in, 38 KB of pixels out, and the second number is the one that matters.
  const dir = await folder({ 'flag.svg': SVG, 'sponsor.png': await png(400, 100) });
  const said = [];
  const decals = await loadDecals(dir, { log: (l) => said.push(l), maxBytes: 8 * 1024 });

  assert.deepEqual([...decals.keys()], ['sponsor'], 'the small PNG is fine; the SVG is not');
  const why = said.find((l) => /flag\.svg/.test(l));
  assert.ok(why, 'and it is reported rather than quietly missing');
  assert.match(why, /rasterises to/, 'saying it is the pixels, not the file');
  assert.match(why, /2048/, 'and what it rasterised to');
  assert.match(why, /skipped/);

  // The cheap early-out on the source file still stands, for a file nobody
  // wants to read at all.
  const big = await folder({ 'huge.png': Buffer.alloc(9 * 1024) });
  const heard = [];
  assert.equal((await loadDecals(big, { log: (l) => heard.push(l), maxBytes: 8 * 1024 })).size, 0);
  assert.ok(heard.some((l) => /huge\.png/.test(l) && /skipped/.test(l)));
});

test('a livery can be resolved by name without being told where the liveries are', async () => {
  // `root` is how the CLI says where it keeps them, and it was required in
  // practice and optional in the signature: called without it, `join(undefined,
  // ...)` throws a TypeError from inside node:path — an exported helper that
  // works only for its one caller.
  const { path, dir } = await resolveLivery('neon-grid');
  assert.match(path, /liveries[\\/]neon-grid\.mjs$/);
  assert.equal(dir, null, 'a single-file livery has no folder of its own');

  // And the answer is the same one the CLI gets when it does say.
  const told = await resolveLivery('neon-grid', { root: new URL('..', import.meta.url).pathname });
  assert.equal(told.path, path);
});
