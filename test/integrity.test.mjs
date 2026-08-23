// These tests deliberately cover the failures that are SILENT — the ones that
// install cleanly, log nothing, and are only discovered by staring at a car in
// the showroom wondering why it looks stock. Rendering bugs announce themselves;
// these don't.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { mipCount } from '../src/engine/pipeline.mjs';
import { validateProfile, resolveRect, panel, texture } from '../src/profile.mjs';
import { makeProbes, gridShape } from '../src/engine/uvgrid.mjs';
import { makeZip } from '../src/engine/zip.mjs';
import { definePack, registerPack, unregisterPack, resolveTreatments } from '../src/registry.mjs';
import { renderTexture } from '../src/render.mjs';
import { buildKn5 } from './fixtures/kn5.mjs';
import '../src/index.mjs';

const profile = {
  id: 'test_car',
  textures: {
    body: { file: 'Body_D.dds', width: 2048, height: 2048, alpha: false },
    strip: { file: 'Strip_D.dds', width: 2048, height: 512, alpha: false },
  },
  panels: {
    body: {
      flank: { rect: [0.0, 0.0, 0.4, 0.2], safe: [0.0, 0.0, 0.4, 0.17], anisotropy: 1.39 },
      nose: { rect: [0.1, 0.25, 0.3, 0.5] },
    },
  },
};

test('mip chain length follows the LONGER edge', () => {
  // Getting this wrong ships a car that shimmers badly at distance. A 2048x512
  // texture needs 12 levels, not the 10 that log2(512)+1 would give.
  assert.equal(mipCount(2048, 2048), 12);
  assert.equal(mipCount(2048, 512), 12);
  assert.equal(mipCount(1024, 512), 11);
  assert.equal(mipCount(512, 2048), 12);
});

test('profile rejects case-colliding filenames', () => {
  // One file on NTFS: the second to extract silently overwrites the first.
  assert.throws(() => validateProfile({
    id: 'x',
    textures: {
      a: { file: 'Suit_DIFF.dds', width: 1024, height: 1024 },
      b: { file: 'SUIT_DIFF.dds', width: 1024, height: 1024 },
    },
  }), /case-colliding/i);
});

test('profile rejects rectangles that leave the texture', () => {
  assert.throws(() => validateProfile({
    id: 'x',
    textures: { body: { file: 'a.dds', width: 64, height: 64 } },
    panels: { body: { p: { rect: [0.8, 0, 0.4, 1] } } },
  }), /past the texture edge/);
});

test('profile rejects panels on an unknown texture role', () => {
  assert.throws(() => validateProfile({
    id: 'x',
    textures: { body: { file: 'a.dds', width: 64, height: 64 } },
    panels: { bodywork: { p: { rect: [0, 0, 1, 1] } } },
  }), /unknown texture role/);
});

test('panel-relative coordinates resolve against the panel rect', () => {
  const whole = resolveRect(profile, 'body', { panel: 'flank' });
  assert.deepEqual(
    [whole.x, whole.y, whole.w, whole.h],
    [0.0, 0.0, 0.4, 0.2]
  );

  // Rear half of the nose panel.
  const half = resolveRect(profile, 'body', { panel: 'nose', at: [0.5, 0, 0.5, 1] });
  assert.deepEqual(
    [half.x, half.y, half.w, half.h],
    [0.25, 0.25, 0.15, 0.5]
  );
});

test('a safe area checks but does NOT change the coordinate basis', () => {
  // If `safe` rescaled `at`, every coordinate in a livery would shift meaning
  // depending on whether the car profile happened to declare one.
  const r = resolveRect(profile, 'body', { panel: 'flank', at: [0, 0, 1, 1], safe: false });
  assert.equal(r.h, 0.2, 'basis must stay the full rect, not the safe rect');
});

test('anisotropy is carried through for text pre-compensation', () => {
  assert.equal(resolveRect(profile, 'body', { panel: 'flank' }).anisotropy, 1.39);
  assert.equal(resolveRect(profile, 'body', { panel: 'nose' }).anisotropy, 1);
  assert.equal(resolveRect(profile, 'body', { at: [0, 0, 1, 1] }).anisotropy, 1);
});

test('an unknown panel name throws instead of silently covering everything', () => {
  // Falling back to the whole texture here would reproduce exactly the failure
  // mode this library exists to prevent.
  assert.throws(() => panel(profile, 'body', 'sidepod'), /no panel "sidepod"/);
  assert.throws(() => texture(profile, 'wing'), /no texture role "wing"/);
});

test('probe candidates may not differ only in case', () => {
  assert.throws(() => makeProbes(['Tire_D.dds', 'TIRE_D.dds']), /differ only in case/);
  assert.equal(makeProbes(['Tire_D.dds', 'Tire.dds']).length, 2);
});

test('grid stays roughly square in texel space on non-square textures', () => {
  assert.deepEqual(gridShape(2048, 2048, 20), { cols: 20, rows: 20 });
  assert.deepEqual(gridShape(2048, 512, 20), { cols: 20, rows: 5 });
  assert.deepEqual(gridShape(1024, 512, 40), { cols: 40, rows: 20 });
});

test('unknown treatments and packs fail loudly', () => {
  assert.throws(() => resolveTreatments(['no-such-pack']), /Unknown pack/);
  assert.throws(() => definePack('bad', { thing: 'not a function' }), /not a function/);
});

test('the ZIP writer produces an archive the OS can read', async () => {
  const data = Buffer.from('hello livery');
  const zip = makeZip([{ name: 'content/cars/x/skins/y/a.txt', data }]);
  assert.equal(zip.subarray(0, 4).toString('latin1'), 'PK\x03\x04');
  assert.ok(zip.includes(Buffer.from('content/cars/x/skins/y/a.txt')));
  // End of central directory record must be present or nothing will open it.
  assert.ok(zip.includes(Buffer.from('PK\x05\x06', 'latin1')));
});

test('the shipped car profile is valid', async () => {
  const p = JSON.parse(await readFile(new URL('../cars/rss_formula_rss_4.json', import.meta.url), 'utf8'));
  assert.doesNotThrow(() => validateProfile(p, 'rss_formula_rss_4.json'));
  // Every panel must sit inside its texture and name a real role.
  for (const [role, panels] of Object.entries(p.panels)) {
    assert.ok(p.textures[role], `panels for unknown role ${role}`);
    for (const [name, def] of Object.entries(panels)) {
      assert.ok(Array.isArray(def.rect), `${role}.${name} has no rect`);
      assert.ok(def.confidence, `${role}.${name} should state a confidence level`);
    }
  }
});

test('the example livery only references panels that exist', async () => {
  const livery = (await import('../liveries/neon-grid.mjs')).default;
  const p = JSON.parse(await readFile(new URL('../cars/rss_formula_rss_4.json', import.meta.url), 'utf8'));
  const treatments = resolveTreatments(livery.packs);

  for (const [role, spec] of Object.entries(livery.paint)) {
    assert.ok(p.textures[role], `livery paints unknown role "${role}"`);
    for (const region of spec.regions) {
      assert.ok(treatments.has(region.treatment), `unknown treatment "${region.treatment}"`);
      if (region.panel) assert.doesNotThrow(() => panel(p, role, region.panel));
    }
  }
});

test('grid cells stay square on PORTRAIT textures too', () => {
  // Deriving rows from cols and clamping gave a 512x2048 texture 20x20 cells
  // that were 4:1 in texel space, defeating the point of a square cell.
  assert.deepEqual(gridShape(512, 2048, 20), { cols: 5, rows: 20 });
  assert.deepEqual(gridShape(2048, 512, 20), { cols: 20, rows: 5 });
});

test('a zero pitch or cell does not hang the renderer', () => {
  // Callers derive these from region height, so a thin region rounds them to
  // zero and the drawing loops stop advancing. This used to hang forever.
  const thin = { id: 't', textures: { body: { file: 'b.dds', width: 1024, height: 1024 } },
    panels: { body: { trim: { rect: [0, 0, 1, 0.01] } } } };
  for (const treatment of ['scanlines', 'halftone']) {
    assert.doesNotThrow(() => renderTexture({
      profile: thin, role: 'body', regions: [{ treatment, panel: 'trim' }],
      treatments: resolveTreatments(['core']), palette: {}, rng: Math.random,
      font: 'sans-serif', tokens: {},
    }));
  }
});

test('registering the same pack object twice is a no-op, a different one is not', () => {
  const a = definePack('dup-test', { x: () => ({ base: '', emissive: '' }) });
  const b = definePack('dup-test', { y: () => ({ base: '', emissive: '' }) });
  registerPack(a);
  assert.doesNotThrow(() => registerPack(a), 'same object should be idempotent');
  assert.throws(() => registerPack(b), /already registered/);
  assert.doesNotThrow(() => registerPack(b, { overwrite: true }));
  unregisterPack('dup-test');
});

test('a profile may not ship both spellings of a case-colliding pair', () => {
  assert.throws(() => validateProfile({
    id: 'x',
    textures: {
      a: { file: 'Suit_D.dds', width: 64, height: 64 },
      b: { file: 'suit_d.DDS', width: 64, height: 64 },
    },
    caseCollisions: [['Suit_D.dds', 'suit_d.DDS']],
  }), /one file on Windows|case-colliding/i);
});

test('mip chain length is an integer the encoder can actually honour', () => {
  // A fractional define makes ImageMagick write a chain length of 1 — no error,
  // exit 0, and a car that shimmers at distance. Ceil is equally wrong: 3000px
  // halves to 1px in 12 steps, and asking for 13 is rejected the same way.
  for (const n of [2048, 3000, 1500, 640, 100]) {
    assert.ok(Number.isInteger(mipCount(n, n)), `${n} gave a fraction`);
    const maxLevels = Math.floor(Math.log2(n)) + 1;
    assert.ok(mipCount(n, n) <= maxLevels, `${n} asked for more levels than possible`);
  }
  assert.equal(mipCount(3000, 3000), 12);
});

// --- kn5 -------------------------------------------------------------------
// The format is reverse-engineered, so these tests lock in the layout that was
// verified byte-exact against a real 50 MB car. A synthetic file is used
// because game assets can't be committed — it exercises the structure, and the
// exact-length assertion is what catches a layout regression.

test('kn5: parses a well-formed file to the exact final byte', async () => {
  const { parseKn5Buffer } = await import('../src/engine/kn5.mjs');
  const m = parseKn5Buffer(buildKn5());
  assert.equal(m.version, 6);
  assert.equal(m.textures.length, 1, 'the type-0 null slot must not become a texture');
  assert.equal(m.textures[0].name, 'body.dds');
  assert.equal(m.materials[0].slots.txDiffuse, 'body.dds');
  assert.equal(m.meshes.length, 1);
  assert.equal(m.meshes[0].vertexCount, 3);
});

test('kn5: V is negated, because AC stores it that way', async () => {
  const { parseKn5Buffer, vertex } = await import('../src/engine/kn5.mjs');
  const m = parseKn5Buffer(buildKn5());
  // Stored v = -0.75 must surface as texture-space y = 0.25. Getting this wrong
  // flips every panel vertically and still looks plausible.
  assert.equal(Math.round(vertex(m, m.meshes[0], 0).v * 1000) / 1000, 0.25);
  assert.equal(vertex(m, m.meshes[0], 0).u, 0.25);
});

test('kn5: a truncated or trailing-byte file is rejected, not half-parsed', async () => {
  const { parseKn5Buffer } = await import('../src/engine/kn5.mjs');
  const good = buildKn5();
  assert.throws(() => parseKn5Buffer(Buffer.concat([good, Buffer.alloc(4)])), /finished at byte/);
  assert.throws(() => parseKn5Buffer(Buffer.from('nope!!'), {}), /not a kn5/);
});

test('kn5: islands carry exact rects and a real anisotropy', async () => {
  const { parseKn5Buffer, meshesUsingTexture } = await import('../src/engine/kn5.mjs');
  const { findIslands } = await import('../src/engine/islands.mjs');
  const m = parseKn5Buffer(buildKn5());
  const islands = findIslands(m, meshesUsingTexture(m, 'body.dds'), { minVertices: 1 });
  assert.equal(islands.length, 1);
  assert.deepEqual(islands[0].rect, [0.25, 0.25, 0.5, 0.5]);
  assert.ok(Number.isFinite(islands[0].anisotropy) && islands[0].anisotropy > 0);
});

test('visibility depends on where you stand, not just on the surface', async () => {
  // The whole point of a second viewpoint: a surface hidden from trackside can
  // be the one a cockpit driver stares at all race, and vice versa. If these
  // two ever agree everywhere, the cockpit pass has silently stopped working.
  const p = JSON.parse(await readFile(new URL('../cars/rss_formula_rss_4.json', import.meta.url), 'utf8'));
  const pairs = [];
  for (const panels of Object.values(p.panels)) {
    for (const def of Object.values(panels)) {
      if (def.visible !== undefined && def.visibleFromCockpit !== undefined) {
        pairs.push([def.visible, def.visibleFromCockpit]);
      }
    }
  }
  assert.ok(pairs.length > 50, 'cockpit visibility should be computed for most panels');
  assert.ok(pairs.some(([out, seat]) => out - seat > 0.5), 'expected panels visible outside but not from the seat');
  assert.ok(pairs.some(([out, seat]) => seat - out > 0.1), 'expected panels more visible from the seat than outside');
});

test('tiled UVs are clamped and flagged, never emitted out of range', async () => {
  // Tiling textures run past 0..1 on purpose. Writing the raw bounds produces a
  // rect starting at -0.006, which is not a texture coordinate.
  const p = JSON.parse(await readFile(new URL('../cars/rss_formula_rss_4.json', import.meta.url), 'utf8'));
  for (const [role, panels] of Object.entries(p.panels)) {
    for (const [name, def] of Object.entries(panels)) {
      for (const n of def.rect) {
        assert.ok(n >= 0 && n <= 1, `${role}.${name} rect out of range: ${def.rect}`);
      }
      if (def.tiled) assert.ok(Array.isArray(def.uvBounds), `${role}.${name} tiled but has no uvBounds`);
    }
  }
});

test('PNG textures are written as PNG, not forced through the DDS encoder', async () => {
  // AC binds .png textures directly. Forcing them to DDS produces a file whose
  // name can't match, and non-power-of-two sizes are refused outright — which
  // silently made the wheel faces unpaintable.
  const { isPngTexture } = await import('../src/engine/pipeline.mjs');
  assert.equal(isPngTexture('CSW_PNG.png'), true);
  assert.equal(isPngTexture('Body_D.dds'), false);
  assert.equal(isPngTexture('weird.PNG'), true);
});

test('the shipped profile records what is deliberately left stock', async () => {
  const p = JSON.parse(await readFile(new URL('../cars/rss_formula_rss_4.json', import.meta.url), 'utf8'));
  assert.ok(Array.isArray(p.leaveStock) && p.leaveStock.length,
    'a profile should say which paintable textures it recommends not painting');
  for (const e of p.leaveStock) assert.ok(e.file && e.reason, 'every entry needs a reason');
  // Nothing in leaveStock should also be painted by the example livery.
  const livery = (await import('../liveries/neon-grid.mjs')).default;
  const paintedFiles = new Set(Object.keys(livery.paint).map((r) => p.textures[r]?.file));
  for (const e of p.leaveStock) {
    assert.ok(!paintedFiles.has(e.file), `${e.file} is both painted and marked leave-stock`);
  }
});

/**
 * A solid triangulated panel at `z`, dense enough to voxelise without gaps.
 * `cols`/`rows` grid, two triangles per cell.
 */
function panelMesh(name, z, normalZ, cols = 20, rows = 20, half = 0.35) {
  const verts = [];
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      const x = (c / cols - 0.5) * half * 2;
      const y = (r / rows) * half * 2;
      verts.push([x, y, z, 0, 0, normalZ, c / cols, -(r / rows), 0, 0, 0]);
    }
  }
  const indices = [];
  const at = (c, r) => r * (cols + 1) + c;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      indices.push(at(c, r), at(c + 1, r), at(c, r + 1));
      indices.push(at(c + 1, r), at(c + 1, r + 1), at(c, r + 1));
    }
  }
  return { name, verts, indices };
}

test('cockpitEye respects which way the model calls forward', async () => {
  // The eye sits BACK from the steering wheel. On a model where +Z is rearward
  // that offset has to flip, or the eye lands out in front of the car and every
  // cockpit visibility number is meaningless.
  const { parseKn5Buffer } = await import('../src/engine/kn5.mjs');
  const { cockpitEye } = await import('../src/engine/visibility.mjs');
  const m = parseKn5Buffer(buildKn5({ extraMeshes: [panelMesh('RSS4_Steer_M', 0.4, 1)] }));

  const fwd = cockpitEye(m, { front: 1 });
  const rev = cockpitEye(m, { front: -1 });
  assert.equal(fwd.from, 'RSS4_Steer_M');
  assert.ok(fwd.z < 0.4, `+Z forward: eye should sit behind the wheel, got ${fwd.z}`);
  assert.ok(rev.z > 0.4, `-Z forward: eye should sit the other side, got ${rev.z}`);
  assert.ok(Math.abs((fwd.z - 0.4) + (rev.z - 0.4)) < 1e-6, 'offsets should mirror exactly');
});

test('cockpit visibility respects occluders between panel and eye', async () => {
  // Locks in the mechanism. It does NOT pin the exact step budget: the march
  // used to stop ~3 cm short of the eye, and no scene I could build made that
  // change the answer — an occluder has to be within 3 cm of the eyeball to
  // notice. The budget was fixed anyway, because marching the whole way is
  // correct and costs nothing, but this test would not have caught it.
  const { parseKn5Buffer, meshesUsingTexture } = await import('../src/engine/kn5.mjs');
  const { findIslands } = await import('../src/engine/islands.mjs');
  const { computeCockpitVisibility } = await import('../src/engine/visibility.mjs');

  // Body vertices sit at z <= 1, the wall at 1.2, the eye at 1.5, so every
  // line of sight has to cross the wall.
  const m = parseKn5Buffer(buildKn5({ extraMeshes: [panelMesh('WALL', 1.2, 1)] }));
  // Select the body mesh by name. The synthetic wall shares its material, so
  // asking by texture would return both islands and the wall — being the
  // frontmost thing — is trivially visible.
  const islands = findIslands(m, m.meshes.filter((x) => x.name === 'body_mesh'), { minVertices: 1 });
  assert.equal(islands.length, 1, 'expected exactly the body island');

  computeCockpitVisibility(m, islands, { eye: { x: 0, y: 0.1, z: 1.5 }, cellSize: 0.02 });
  assert.equal(islands[0].cockpitFraction, 0, 'a wall between panel and eye must occlude');

  // Same scene without the wall: the panel is plainly visible, which proves the
  // assertion above is measuring occlusion and not something incidental.
  const clear = parseKn5Buffer(buildKn5());
  const open = findIslands(clear, clear.meshes.filter((x) => x.name === 'body_mesh'), { minVertices: 1 });
  computeCockpitVisibility(clear, open, { eye: { x: 0, y: 0.1, z: 1.5 }, cellSize: 0.02 });
  assert.ok(open[0].cockpitFraction > 0, 'with nothing in the way it should be visible');
});

test('a rotation that is not a number fails loudly', () => {
  // NaN degrees poisons every coordinate downstream and the SVG renders as
  // nothing — silently. rotate: '90deg' is the obvious way to get here.
  const p = { id: 't', textures: { body: { file: 'b.dds', width: 256, height: 256 } },
    panels: { body: { all: { rect: [0, 0, 1, 1] } } } };
  const draw = (rotate) => renderTexture({
    profile: p, role: 'body', regions: [{ treatment: 'fill', panel: 'all', color: 'white', rotate }],
    treatments: resolveTreatments(['core']), palette: {}, rng: Math.random,
    font: 'sans-serif', tokens: {},
  });
  for (const bad of ['90deg', Infinity, NaN, null]) {
    assert.throws(() => draw(bad), /finite number of degrees/, `rotate: ${JSON.stringify(bad)}`);
  }
  assert.doesNotThrow(() => draw(90));
  assert.doesNotThrow(() => draw(undefined));
  assert.ok(!String(draw(45).base).includes('NaN'), 'no NaN reaches the SVG');
});

test('rotate turns a treatment without moving the rect it was asked for', async () => {
  // Motifs have a grain — traces run in horizontal lanes — and a panel's grain
  // is whatever the unwrapper chose. Seatbelt straps run DOWN their texture, so
  // unrotated lanes cross them like rungs. The author writes the FINAL rect;
  // rotation must not shift it.
  const { renderTexture } = await import('../src/render.mjs');
  const { resolveTreatments } = await import('../src/registry.mjs');
  const p = { id: 't', textures: { body: { file: 'b.dds', width: 100, height: 100 } },
    panels: { body: { strip: { rect: [0.2, 0.1, 0.2, 0.8] } } } };
  const common = { profile: p, role: 'body', treatments: resolveTreatments(['core']),
    palette: { c: '#0ff' }, rng: Math.random, font: 'sans-serif', tokens: {} };

  const plain = renderTexture({ ...common, regions: [{ treatment: 'fill', panel: 'strip', color: 'c' }] });
  const spun = renderTexture({ ...common, regions: [{ treatment: 'fill', panel: 'strip', color: 'c', rotate: 90 }] });

  // Unrotated: the rect as written — 20x80 at (20,10).
  assert.match(plain.base, /x="20" y="10" width="20" height="80"/);
  // Rotated: drawn 80x20 about the same centre, then spun a quarter turn, which
  // lands it back on 20x80 at (20,10).
  assert.match(spun.base, /rotate\(90,30,50\)/);
  assert.match(spun.base, /x="-10" y="40" width="80" height="20"/);
});

test('an island collapsed to a line in UV space is dropped, not emitted as a panel', async () => {
  // Street cars are full of these: trim strips and badges whose unwrap pins them
  // to a single row of texels. The rect comes out [0, 0.4, 1, 0] — no area, so
  // nothing can be drawn on it. Emitting them buried a quarter of one profile's
  // panels in placeholders that no livery could ever address.
  const { parseKn5Buffer } = await import('../src/engine/kn5.mjs');
  const { findIslands } = await import('../src/engine/islands.mjs');

  const flat = panelMesh('Trim_Strip', 0.4, 1);
  for (const v of flat.verts) v[7] = -0.4;                    // every vertex on one V line
  const m = parseKn5Buffer(buildKn5({ extraMeshes: [flat, panelMesh('Real_Panel', 0.6, 1)] }));

  const named = (n) => m.meshes.filter((x) => x.name === n);
  assert.equal(findIslands(m, named('Trim_Strip')).length, 0, 'zero-height island should be dropped');

  const good = findIslands(m, named('Real_Panel'));
  assert.equal(good.length, 1, 'a panel with real area still comes through');
  assert.ok(good[0].rect[3] > 0.5, `and keeps its height, got ${good[0].rect[3]}`);
});

// --- the classifier ---------------------------------------------------------

const feat = (o) => ({
  role: o.role ?? 'r', file: o.file ?? 'f.dds', area: 0, straddles: true,
  skinFraction: 0, shaders: [], box: null, ...o,
});

test('a big invisible surface loses to a smaller visible one', async () => {
  // This is the failure mode that took the classifier from 90% to 98%. Engine
  // bays, undertrays and interior occlusion maps are large, symmetric and
  // completely unseen; without visibility they outrank the paint on 17 of 175
  // fleet cars. Measured: engine bays came in at 0.14-0.19 visible, interior
  // occlusion at 0.02, real bodywork at 0.55-0.89.
  const { rank } = await import('../src/engine/classify.mjs');
  const ranked = rank([
    feat({ role: 'engineBay', area: 0.30, visible: 0.15 }),
    feat({ role: 'paint', area: 0.12, visible: 0.80 }),
  ]);
  assert.equal(ranked[0].role, 'paint', 'visibility must outweigh raw size');
});

test('a one-sided part is demoted but not excluded', async () => {
  // Bodywork crosses the centreline and a corner part does not, but some real
  // bodywork IS one-sided — an asymmetric endurance panel — so this has to be a
  // penalty rather than a filter.
  const { rank } = await import('../src/engine/classify.mjs');
  const both = rank([feat({ role: 'sided', area: 0.5, straddles: false })]);
  assert.equal(both.length, 1, 'a one-sided candidate still ranks');
  const pair = rank([
    feat({ role: 'sided', area: 0.30, straddles: false }),
    feat({ role: 'central', area: 0.20, straddles: true }),
  ]);
  assert.equal(pair[0].role, 'central');
});

test('confidence reports the margin, and a flat field says so', async () => {
  const { rank } = await import('../src/engine/classify.mjs');
  const clear = rank([feat({ role: 'a', area: 0.9 }), feat({ role: 'b', area: 0.1 })]);
  const tied = rank([feat({ role: 'a', area: 0.5 }), feat({ role: 'b', area: 0.49 })]);
  assert.ok(clear[0].confidence > 0.8, `clear winner, got ${clear[0].confidence}`);
  assert.ok(tied[0].confidence < 0.1, `near tie, got ${tied[0].confidence}`);
  assert.equal(rank([feat({ role: 'only', area: 0.4 })])[0].confidence, 1);
});

test('the classifier ranks and explains, but never decides silently', async () => {
  const { explain, propose } = await import('../src/engine/classify.mjs');
  const fs = [feat({ role: 'a', area: 0.5 }), feat({ role: 'b', area: 0.49 })];
  const text = explain(fs);
  assert.match(text, /Look at the car/, 'a near-tie has to say so out loud');
  assert.match(text, /Visibility was not computed/, 'missing visibility has to be reported');
  assert.equal(propose(fs).source, 'auto', 'proposals are marked as unconfirmed');
});

test('an unknown vocabulary term fails loudly and lists the real ones', async () => {
  const { rank } = await import('../src/engine/classify.mjs');
  assert.throws(() => rank([feat({})], 'bonnet'), /Unknown vocabulary term "bonnet".*body/s);

  // Inherited properties are not vocabulary terms. VOCABULARY['toString'] is a
  // function from Object.prototype and a truthiness test would let it through,
  // which would quietly reopen the closed vocabulary.
  for (const inherited of ['toString', 'constructor', 'hasOwnProperty']) {
    assert.throws(() => rank([feat({})], inherited), /Unknown vocabulary term/, inherited);
  }
});

test('a texture bound to no mesh scores zero, however promising its name', async () => {
  // 1133 of the fleet's 8569 paintable-looking textures are bound to nothing.
  // metal_detail.dds ships in nearly every road-car skin and on several of those
  // cars paints not one pixel. A classifier that ranked it would be repeating
  // the exact mistake this project started with.
  const { parseKn5Buffer } = await import('../src/engine/kn5.mjs');
  const { textureFeatures, rank } = await import('../src/engine/classify.mjs');
  const m = parseKn5Buffer(buildKn5({ extraMeshes: [panelMesh('Flank', 0.4, 1)] }));

  const fs = textureFeatures(m, { roles: { ghost: { file: 'not_in_this_model.dds' } } });
  assert.equal(fs[0].area, 0);
  assert.equal(fs[0].straddles, false);
  assert.equal(fs[0].box, null);
  assert.equal(rank(fs).length, 0, 'an unbound texture must not be proposed at all');
});

test('override counting works on one skin folder as well as a skins/ directory', async () => {
  // scanSkins accepts either, and --skins is documented as accepting either.
  // Returning zero for a single folder does not read downstream as "no data" —
  // it reads as "no stock skin overrides anything", which costs the classifier a
  // whole signal without saying so.
  const { countSkinOverrides } = await import('../src/engine/scan.mjs');
  const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const root = await mkdtemp(join(tmpdir(), 'lk-skins-'));
  for (const skin of ['red', 'blue']) {
    await mkdir(join(root, skin), { recursive: true });
    await writeFile(join(root, skin, 'body.dds'), '');
    await writeFile(join(root, skin, 'ui_skin.json'), '{}');
  }
  await writeFile(join(root, 'blue', 'extra.dds'), '');

  const all = await countSkinOverrides(root);
  assert.equal(all.skinCount, 2);
  assert.equal(all.counts.get('body.dds'), 2);
  assert.equal(all.counts.get('extra.dds'), 1);
  assert.equal(all.counts.has('ui_skin.json'), false, 'only textures are counted');

  const one = await countSkinOverrides(join(root, 'blue'));
  assert.equal(one.skinCount, 1, 'a single skin folder counts as one skin, not zero');
  assert.equal(one.counts.get('body.dds'), 1);

  assert.deepEqual(await countSkinOverrides(join(root, 'nope')),
    { skinCount: 0, counts: new Map() }, 'a missing directory is not an error');
});

// --- bindings ---------------------------------------------------------------

const withBind = (bind) => ({
  id: 'x', textures: { body: { file: 'b.dds', width: 64, height: 64 } }, bind,
});

test('a human-confirmed binding survives regeneration; an auto one does not', async () => {
  // The whole reason to confirm a binding is that the confirmation sticks. A
  // profile is regenerated every time the model or the classifier changes, and
  // losing hand-checked work each time would make confirming it pointless.
  const { mergeBindings } = await import('../src/profile.mjs');
  const merged = mergeBindings(
    { body: { roles: ['chassis'], source: 'human' }, tyres: { roles: ['old'], source: 'auto' } },
    { body: { roles: ['guess'], source: 'auto' }, tyres: { roles: ['new'], source: 'auto' } },
  );
  assert.deepEqual(merged.body, { roles: ['chassis'], source: 'human' });
  assert.deepEqual(merged.tyres, { roles: ['new'], source: 'auto' });
});

test('absent and unbound are different answers', async () => {
  // "This car has no wing" is a claim someone made. "Nobody has said" is not.
  // Collapsing the two would let a silent omission pass for a decision.
  const { binding } = await import('../src/profile.mjs');
  const p = withBind({ wing: { roles: [], source: 'human' } });
  assert.equal(binding(p, 'wing').status, 'absent');
  assert.equal(binding(p, 'floor').status, 'unbound');
  assert.equal(binding(withBind({ body: { roles: ['body'], source: 'auto' } }), 'body').status, 'bound');
});

test('a binding may map one term to several roles', async () => {
  // The RSS4 carries its bodywork across two chassis textures, 25% and 17% of
  // the car's surface. A one-role binding would silently paint half the car.
  const { validateProfile, binding } = await import('../src/profile.mjs');
  const p = validateProfile({
    id: 'x',
    textures: { body: { file: 'a.dds', width: 64, height: 64 }, bodyRear: { file: 'b.dds', width: 64, height: 64 } },
    bind: { body: { roles: ['body', 'bodyRear'], source: 'human' } },
  });
  assert.deepEqual(binding(p, 'body').roles, ['body', 'bodyRear']);
});

test('a binding to a role the profile does not define is rejected', async () => {
  const { validateProfile } = await import('../src/profile.mjs');
  assert.throws(
    () => validateProfile(withBind({ body: { roles: ['nope'], source: 'auto' } })),
    /points at texture role "nope"/,
  );
});

test('the vocabulary is fixed, so a livery can rely on it', async () => {
  const { validateProfile } = await import('../src/profile.mjs');
  assert.throws(
    () => validateProfile(withBind({ bonnet: { roles: ['body'], source: 'human' } })),
    /unknown term "bonnet"/,
  );
  assert.throws(
    () => validateProfile(withBind({ body: { roles: ['body'], source: 'probably' } })),
    /must be "auto".*"human"/s,
  );
  assert.throws(
    () => validateProfile(withBind({ body: null })),
    /must be an object.*empty roles array/s,
  );
});

test('the shipped profile binds the vocabulary to real roles', async () => {
  const { loadProfile, binding } = await import('../src/profile.mjs');
  const p = await loadProfile(new URL('../cars/rss_formula_rss_4.json', import.meta.url));
  assert.deepEqual(binding(p, 'body').roles, ['body', 'bodyRear'], 'both chassis textures');
  assert.equal(binding(p, 'body').source, 'human');
  // A formula car has no numberplate. Recorded as a decision, not an omission.
  assert.equal(binding(p, 'numberPlate').status, 'absent');
  assert.equal(binding(p, 'rims').roles[0], 'rimFace', 'not the motion-blur variant');
});

test('an inherited property name is not a vocabulary term', async () => {
  // VOCABULARY['toString'] inherits a function from Object.prototype, so a
  // truthiness test would let bind."toString" through validation and reopen the
  // closed vocabulary through the back door.
  const { validateProfile } = await import('../src/profile.mjs');
  for (const inherited of ['toString', 'constructor', 'hasOwnProperty']) {
    assert.throws(
      () => validateProfile(withBind({ [inherited]: { roles: ['body'], source: 'human' } })),
      /unknown term/,
      inherited,
    );
  }
});

test('binding() really never throws, including on a profile nobody validated', async () => {
  // It is exported, and a caller may hand over a hand-written fixture or a file
  // read straight from disk. "Never throws" has to be true of the function, not
  // only of the happy path.
  const { binding } = await import('../src/profile.mjs');
  const malformed = [
    {},
    { bind: {} },
    { bind: { body: null } },
    { bind: { body: {} } },
    { bind: { body: { roles: null, source: 'human' } } },
    { bind: { body: { roles: 'chassis', source: 'human' } } },
  ];
  for (const p of malformed) {
    const b = binding(p, 'body');
    assert.equal(b.status, 'unbound', JSON.stringify(p));
    assert.deepEqual(b.roles, [], 'callers iterate roles, so it must always be an array');
  }
  assert.equal(binding({ bind: {} }, 'toString').status, 'unbound', 'inherited names too');
});

// --- the resolver -----------------------------------------------------------

const carWith = (bind) => ({
  id: 'car',
  textures: {
    chassis: { file: 'c.dds', width: 64, height: 64 },
    rear: { file: 'r.dds', width: 64, height: 64 },
    wheel: { file: 'w.dds', width: 64, height: 64 },
  },
  bind,
});
const spec = { background: 'black', regions: [] };

test('a surface resolves through bind to whatever this car calls it', async () => {
  const { resolveTargets } = await import('../src/profile.mjs');
  const { targets } = resolveTargets(
    carWith({ body: { roles: ['chassis', 'rear'], source: 'human' } }),
    { name: 'L', surfaces: { body: spec } },
  );
  assert.deepEqual(targets.map((t) => t.role), ['chassis', 'rear'],
    'one term, both of the roles it names');
});

test('asking for a surface the car lacks is a reported no-op, not a failure', async () => {
  // A design asking for a wing on a van should still build. The report is the
  // safety mechanism: painting nothing looks exactly like painting something.
  const { resolveTargets } = await import('../src/profile.mjs');
  const { targets, notes } = resolveTargets(
    carWith({ body: { roles: ['chassis'], source: 'human' }, wing: { roles: [], source: 'human' } }),
    { name: 'L', surfaces: { body: spec, wing: spec, floor: spec } },
  );
  assert.deepEqual(targets.map((t) => t.role), ['chassis']);
  assert.deepEqual(notes.map((n) => n.status).sort(), ['absent', 'unbound']);
  assert.match(notes.find((n) => n.term === 'floor').text, /not bound on this car/);
});

test('an unconfirmed binding is used, and said out loud', async () => {
  const { resolveTargets } = await import('../src/profile.mjs');
  const { targets, notes } = resolveTargets(
    carWith({ body: { roles: ['chassis'], confidence: 0.4, source: 'auto' } }),
    { name: 'L', surfaces: { body: spec } },
  );
  assert.equal(targets.length, 1, 'a proposal is still usable');
  assert.equal(notes[0].status, 'unconfirmed');
  assert.match(notes[0].text, /confidence 0\.4/);
});

test('painting the same texture twice is refused, not silently resolved', async () => {
  // Both writes go to the same file and the second wins. Before bindings this
  // was impossible; a term that expands to several roles makes it reachable.
  const { resolveTargets } = await import('../src/profile.mjs');
  assert.throws(
    () => resolveTargets(
      carWith({ body: { roles: ['chassis'], source: 'human' } }),
      { name: 'L', paint: { chassis: spec }, surfaces: { body: spec } },
    ),
    /paints texture role "chassis" twice.*paint\.chassis.*surfaces\.body/s,
  );
});

test('a livery may not invent a surface name either', async () => {
  const { resolveTargets } = await import('../src/profile.mjs');
  assert.throws(
    () => resolveTargets(carWith({}), { name: 'L', surfaces: { spoiler: spec } }),
    /not in the vocabulary/,
  );
});

test('the example livery resolves against the shipped car', async () => {
  const { loadProfile, resolveTargets } = await import('../src/profile.mjs');
  const profile = await loadProfile(new URL('../cars/rss_formula_rss_4.json', import.meta.url));
  const livery = (await import('../liveries/neon-grid.mjs')).default;
  const { targets, notes } = resolveTargets(profile, livery);
  assert.equal(notes.length, 0, `everything it asks for exists: ${notes.map((n) => n.text)}`);
  // Driver kit lives in another kn5 and must NOT be flagged as suspicious.
  assert.equal(new Set(targets.map((t) => t.role)).size, targets.length, 'no role painted twice');
  assert.ok(targets.some((t) => t.from === 'surfaces.rims'), 'rims goes through the vocabulary');
});

test('a texture too odd a size to encode is skipped and reported, not fatal', async () => {
  // The Abarth's steering wheel is 68x64. Hitting that mid-build used to abort
  // after writing five perfectly good files. A surface this tool cannot encode
  // is effectively one the car does not have.
  const { resolveTargets } = await import('../src/profile.mjs');
  const p = {
    id: 'car',
    textures: {
      good: { file: 'g.dds', width: 512, height: 512 },
      odd: { file: 'o.dds', width: 68, height: 64 },
    },
    bind: {
      body: { roles: ['good'], source: 'human' },
      steeringWheel: { roles: ['odd'], source: 'human' },
    },
  };
  // resolveTargets itself does not know about DDS; the pre-flight in buildSkin
  // does. What matters here is that both resolve, so the build can choose.
  const { targets } = resolveTargets(p, { name: 'L', surfaces: { body: spec, steeringWheel: spec } });
  assert.deepEqual(targets.map((t) => t.role), ['good', 'odd']);
});

test('binding to a texture the model never references is flagged', async () => {
  // The driver and pit crew are separate kn5 files that a car skin overrides, so
  // this is expected for them — and it is also exactly how metal_detail.dds
  // looks, which on several cars is bound to no mesh anywhere and paints
  // nothing. The two are indistinguishable from one model, so say so.
  const { resolveTargets } = await import('../src/profile.mjs');
  const p = {
    id: 'car',
    textures: {
      crew: { file: 'ac_crew.dds', width: 512, height: 512, sizeFrom: 'skin' },
      trim: { file: 'metal_detail.dds', width: 32, height: 32, sizeFrom: 'skin' },
    },
    bind: {
      crew: { roles: ['crew'], source: 'human' },
      metalTrim: { roles: ['trim'], source: 'human' },
    },
  };
  const { targets, notes } = resolveTargets(p, { name: 'L', surfaces: { crew: spec, metalTrim: spec } });
  assert.equal(targets.length, 2, 'both still painted — they probably are real');
  assert.equal(notes.length, 1, 'the driver kit is expected to live elsewhere; trim is not');
  assert.equal(notes[0].term, 'metalTrim');
  assert.match(notes[0].text, /may paint nothing/);
});

test('the portable livery renders on two cars that share no texture names', async () => {
  // The point of the whole layer. One design file, a Formula car and a road car,
  // no name in common between them.
  const { loadProfile, resolveTargets } = await import('../src/profile.mjs');
  const livery = (await import('../liveries/neon-grid-any.mjs')).default;
  assert.equal(livery.car, undefined, 'a portable livery has no business naming a car');

  const rss = await loadProfile(new URL('../cars/rss_formula_rss_4.json', import.meta.url));
  const ab = await loadProfile(new URL('../cars/abarth500.json', import.meta.url));
  const a = resolveTargets(rss, livery);
  const b = resolveTargets(ab, livery);

  assert.ok(a.targets.length >= 10, `RSS4 painted ${a.targets.length}`);
  assert.ok(b.targets.length >= 5, `Abarth painted ${b.targets.length}`);
  const filesA = new Set(a.targets.map((t) => rss.textures[t.role].file));
  const filesB = new Set(b.targets.map((t) => ab.textures[t.role].file));
  assert.equal([...filesA].filter((f) => filesB.has(f)).length, 1,
    'only ac_crew.dds is common to both cars — everything else is named differently');
});

test('the build report separates what was not painted from what merely warrants a look', async () => {
  // Lumping them together makes the report a liar: an unconfirmed binding WAS
  // painted, and counting it as missing both inflates the number and buries the
  // signal that actually matters.
  const { isMissingNote } = await import('../src/build.mjs');
  const { resolveTargets } = await import('../src/profile.mjs');

  for (const status of ['absent', 'unbound', 'unencodable', 'no-match']) {
    assert.equal(isMissingNote({ status }), true, status);
  }
  // `fit-stale` is the one that reads like a failure and isn't: the override was
  // refused, so the region stayed where the livery put it — painted, with a note.
  for (const status of ['unconfirmed', 'unverified', 'fit-stale']) {
    assert.equal(isMissingNote({ status }), false, status);
  }

  // And the statuses resolveTargets actually emits land on the right side.
  const p = {
    id: 'c',
    textures: { chassis: { file: 'c.dds', width: 64, height: 64 } },
    bind: {
      body: { roles: ['chassis'], confidence: 0.4, source: 'auto' },
      wing: { roles: [], source: 'human' },
    },
  };
  const { targets, notes } = resolveTargets(p, {
    name: 'L', surfaces: { body: spec, wing: spec, floor: spec },
  });
  assert.equal(targets.length, 1, 'the auto-bound surface is painted');
  assert.deepEqual(notes.filter(isMissingNote).map((n) => n.term).sort(), ['floor', 'wing']);
  assert.deepEqual(notes.filter((n) => !isMissingNote(n)).map((n) => n.term), ['body']);
});

// --- panel tags -------------------------------------------------------------

const tagCar = (axes, panels) => ({
  id: 'c', calibration: { axes }, textures: { body: { file: 'b.dds', width: 64, height: 64 } },
  panels: { body: panels },
});

test('tags describe where a panel is in terms true of any car', async () => {
  const { computeTags } = await import('../src/engine/tags.mjs');
  const t = computeTags(tagCar({ left: '+X', front: '+Z' }, {
    nl: { rect: [0.0, 0, 0.3, 0.3], centroid3d: [1, 1, 4] },    // left, nose, upper
    tr: { rect: [0.3, 0, 0.3, 0.3], centroid3d: [-1, 0, 0] },   // right, tail, lower
    mc: { rect: [0.6, 0, 0.3, 0.3], centroid3d: [0, 0.5, 2] },  // centre, mid
  })).body;
  assert.deepEqual(t.nl, ['left', 'nose', 'upper']);
  assert.deepEqual(t.tr, ['right', 'tail', 'lower']);
  assert.equal(t.mc[0], 'centre');
  assert.equal(t.mc[1], 'mid');
});

test('tags follow the model\'s idea of forward, not ours', async () => {
  // Ninety of the 235 fleet cars have no mesh named in a way that reveals which
  // end is the front. On a model where +Z is rearward, ignoring that would tag
  // the tail as the nose on every panel.
  const { computeTags } = await import('../src/engine/tags.mjs');
  const panels = {
    a: { rect: [0, 0, 0.4, 0.4], centroid3d: [0, 0, 4] },
    b: { rect: [0.5, 0, 0.4, 0.4], centroid3d: [0, 0, 0] },
  };
  const fwd = computeTags(tagCar({ left: '+X', front: '+Z' }, panels)).body;
  const rev = computeTags(tagCar({ left: '+X', front: '-Z' }, panels)).body;
  assert.equal(fwd.a[1], 'nose');
  assert.equal(rev.a[1], 'tail', 'the same panel is at the other end of a reversed car');
  // Left and right swap with the axis too.
  const flipped = computeTags(tagCar({ left: '-X', front: '+Z' }, {
    p: { rect: [0, 0, 1, 1], centroid3d: [1, 0, 0] },
  })).body;
  assert.equal(flipped.p[0], 'right');
});

test('a panel with no measured centroid gets the tags that need no geometry', async () => {
  // Hand-written profiles and the old screenshot workflow have no centroid3d.
  // Better to give them what can be known than to skip them or invent a side.
  const { computeTags } = await import('../src/engine/tags.mjs');
  const t = computeTags(tagCar({ left: '+X', front: '+Z' }, {
    p: { rect: [0, 0, 1, 1], visible: 0.8, mirrorOf: 'q' },
  })).body;
  assert.deepEqual(t.p, ['visible', 'mirrored']);
});

test('selecting by tags is AND, and matching nothing is reported', async () => {
  const { panelsWithTags, expandRegions } = await import('../src/profile.mjs');
  const p = tagCar({ left: '+X', front: '+Z' }, {
    a: { rect: [0.0, 0, 0.3, 0.3], tags: ['left', 'mid', 'visible'] },
    b: { rect: [0.3, 0, 0.3, 0.3], tags: ['left', 'nose'] },
    c: { rect: [0.6, 0, 0.3, 0.3], tags: ['right', 'mid', 'visible'] },
  });
  assert.deepEqual(panelsWithTags(p, 'body', ['left']), ['a', 'b']);
  assert.deepEqual(panelsWithTags(p, 'body', ['left', 'visible']), ['a'],
    'both tags must be present, not either');

  const { regions, notes } = expandRegions(p, 'body', [
    { treatment: 'fill', tags: ['left'] },
    { treatment: 'fill', tags: ['left', 'tail'] },
  ]);
  assert.deepEqual(regions.map((r) => r.panel), ['a', 'b'], 'one region per matching panel');
  assert.equal(notes.length, 1);
  assert.match(notes[0].text, /no panel tagged \[left, tail\]/);
});

test('a region may select by name or by tag, not both', async () => {
  const { expandRegions } = await import('../src/profile.mjs');
  assert.throws(
    () => expandRegions(tagCar({}, { a: { rect: [0, 0, 1, 1], tags: ['left'] } }), 'body',
      [{ treatment: 'fill', panel: 'a', tags: ['left'] }]),
    /both "panel" and "tags"/,
  );
});

test('the portable livery expands onto two cars it was not written for', async () => {
  // Five authored regions become as many as the car has panels to put them on.
  const { loadProfile, expandRegions } = await import('../src/profile.mjs');
  const livery = (await import('../liveries/neon-grid-any.mjs')).default;
  const cases = [
    ['../cars/rss_formula_rss_4.json', 'body'],
    ['../cars/abarth500.json', 'skinbase_default'],
  ];
  for (const [file, role] of cases) {
    const p = await loadProfile(new URL(file, import.meta.url));
    const { regions, notes } = expandRegions(p, role, livery.surfaces.body.regions);

    assert.ok(regions.length > livery.surfaces.body.regions.length,
      `${file}: ${regions.length} regions from ${livery.surfaces.body.regions.length} authored`);
    assert.ok(regions.some((r) => r.panel), 'tag-selected regions carry a concrete panel');

    // A skipped region is allowed, but only for a reason the CAR supplies. Any
    // selector other than `shared` going unmatched would mean the design is
    // asking for something no car provides, which is a bug in the design.
    for (const n of notes) {
      assert.match(n.text, /\[shared, visible\]/,
        `${file}: unexpected unmatched selector — ${n.text}`);
    }
  }

  // The two cars genuinely differ here, which is the whole reason the design has
  // to name `shared` separately rather than relying on left and right.
  const { panelsWithTags } = await import('../src/profile.mjs');
  const rss = await loadProfile(new URL('../cars/rss_formula_rss_4.json', import.meta.url));
  const ab = await loadProfile(new URL('../cars/abarth500.json', import.meta.url));
  assert.equal(panelsWithTags(rss, 'body', ['shared', 'visible']).length, 0,
    'an open-wheeler unwraps each flank separately, for asymmetric aero');
  assert.ok(panelsWithTags(ab, 'skinbase_default', ['shared', 'visible']).length > 0,
    'a road car mirrors its sides to halve the texture');
});

// --- encrypted models -------------------------------------------------------

test('an encrypted model is read, not rejected — and never decrypted', async () => {
  // Some mod authors ship a kn5 whose geometry is intact but whose textures are
  // 1x1 placeholders, with the real ones in a Custom Shaders Patch blob appended
  // to the file. Three cars in a 235-car fleet were built this way, and the
  // exact-length check refused all three as corrupt.
  //
  // The geometry is what this tool actually needs, and it is all there. The
  // encryption is the author protecting their artwork; nothing here tries to
  // undo that, and nothing should.
  const { parseKn5Buffer } = await import('../src/engine/kn5.mjs');

  const plain = parseKn5Buffer(buildKn5());
  assert.equal(plain.encrypted, null, 'an ordinary model is not flagged');

  const enc = parseKn5Buffer(buildKn5({ encrypted: true }));
  assert.equal(enc.encrypted.scheme, 'csp-kn5enc-v1');
  assert.ok(enc.encrypted.bytes > 4000, `protected region measured ${enc.encrypted.bytes} bytes`);
  assert.equal(enc.meshes.length, plain.meshes.length, 'the geometry reads identically');
  assert.deepEqual(enc.materials, plain.materials);
});

test('a genuinely truncated file is still refused', async () => {
  // The encryption check must not become a way for any short parse to pass. It
  // only excuses trailing bytes that carry the marker.
  const { parseKn5Buffer } = await import('../src/engine/kn5.mjs');
  const buf = Buffer.concat([buildKn5(), Buffer.alloc(4096, 0xab)]);
  assert.throws(() => parseKn5Buffer(buf), /parser finished at byte/);
});

test('placeholder texture sizes are refused rather than believed', async () => {
  // A 1x1 embedded texture is not a small texture, it is an absent one. Writing
  // its size into a profile would produce a livery rendered at one pixel.
  const { profileFromKn5 } = await import('../src/engine/profilegen.mjs');
  const { writeFile, mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = await mkdtemp(join(tmpdir(), 'lk-enc-'));
  const file = join(dir, 'car.kn5');
  await writeFile(file, buildKn5({ placeholderTexture: true, encrypted: true }));

  const bare = await profileFromKn5(file, { id: 'c', visibility: false });
  assert.equal(Object.keys(bare.textures).length, 0, 'nothing is paintable without a real size');
  assert.match(bare.doNotPaint[0].reason, /encrypted.*1x1 placeholder/);

  // --assume-size turns it into a choice the user has made, labelled as one.
  const assumed = await profileFromKn5(file, { id: 'c', visibility: false, assumeSize: 1024 });
  const tex = Object.values(assumed.textures)[0];
  assert.equal(tex.width, 1024);
  assert.equal(tex.sizeFrom, 'assumed');
  assert.match(tex.notes, /assumed, not measured/);

  await assert.rejects(
    () => profileFromKn5(file, { id: 'c', visibility: false, assumeSize: 1000 }),
    /power of two/,
  );
});

// --- parts versus panels ----------------------------------------------------

test('panels drawn from the same texels do not claim contradictory sides', async () => {
  // A PART is a thing on the car; a PANEL is a region of a texture, and they are
  // not one to one. Across eight cars, 42.8% of panels shared a rectangle with
  // another. The Abarth's wheel face was tagged `left` on one instance and
  // `right` on another for the same pixels, so a livery asking for the left side
  // would paint all four wheels and look like it had worked.
  const { computeTags } = await import('../src/engine/tags.mjs');
  const rect = [0.1, 0.1, 0.2, 0.2];
  const t = computeTags({
    calibration: { axes: { left: '+X', front: '+Z' } },
    panels: {
      rims: {
        lf: { rect, centroid3d: [1, 0, 2], visible: 0.9 },
        rf: { rect, centroid3d: [-1, 0, 2], visible: 0.9 },
        lr: { rect, centroid3d: [1, 0, -2], visible: 0.9 },
        rr: { rect, centroid3d: [-1, 0, -2], visible: 0.9 },
        solo: { rect: [0.5, 0.5, 0.1, 0.1], centroid3d: [1, 0, 2], visible: 0.9 },
      },
    },
  }).rims;

  for (const w of ['lf', 'rf', 'lr', 'rr']) {
    assert.ok(!t[w].includes('left') && !t[w].includes('right'),
      `${w} must not claim a side its twin contradicts: ${t[w]}`);
    assert.ok(t[w].includes('shared'), `${w} should be marked shared`);
    assert.ok(t[w].includes('visible'), 'tags all four agree on survive');
  }
  assert.ok(t.solo.includes('left'), 'a panel with its own rectangle keeps its side');
  assert.ok(!t.solo.includes('shared'));
});

test('a shared region is painted once, not once per part', async () => {
  // Four passes of a 0.3 halftone is a 0.76 halftone. Selecting by name still
  // reaches an individual panel; only tag selection dedupes, because only it can
  // have matched several instances of one thing without meaning to.
  const { panelsWithTags, expandRegions } = await import('../src/profile.mjs');
  const rect = [0.1, 0.1, 0.2, 0.2];
  const p = {
    id: 'c',
    textures: { rims: { file: 'r.dds', width: 64, height: 64 } },
    panels: {
      rims: {
        lf: { rect, tags: ['shared', 'visible'] },
        rf: { rect, tags: ['shared', 'visible'] },
        hub: { rect: [0.5, 0.5, 0.1, 0.1], tags: ['visible'] },
      },
    },
  };
  assert.deepEqual(panelsWithTags(p, 'rims', ['visible']), ['lf', 'hub'],
    'one name per distinct rectangle, keeping the first as the profile lists it');

  const { regions } = expandRegions(p, 'rims', [{ treatment: 'fill', tags: ['visible'] }]);
  assert.equal(regions.length, 2, 'two rectangles, two draws');
});

test('the shipped profiles record where parts share texels', async () => {
  const { loadProfile } = await import('../src/profile.mjs');
  const ab = await loadProfile(new URL('../cars/abarth500.json', import.meta.url));
  const wheel = Object.values(ab.panels.rims).find((p) => p.instances === 4);
  assert.ok(wheel, 'the Abarth draws all four wheels from one rim texture');
  assert.equal(wheel.sharesRectWith.length, 3);
  assert.ok(!wheel.tags.includes('left') && !wheel.tags.includes('right'));
});

// --- which way is the car facing --------------------------------------------

function wheelCar({ lf = [0.8, 0.3, 1.3], rf = [-0.8, 0.3, 1.3], lr = [0.8, 0.3, -1.0], rr = [-0.8, 0.3, -1.0] } = {}) {
  // Only the dummies matter here; axesFromWheels reads the node translations.
  const d = (name, [x, y, z]) => {
    const w = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
    return { name, path: name, depth: 1, world: w };
  };
  return {
    meshes: [],
    dummies: [d('WHEEL_LF', lf), d('WHEEL_RF', rf), d('WHEEL_LR', lr), d('WHEEL_RR', rr)],
  };
}

test('the wheels say which way is left and which is forward', async () => {
  // Assetto Corsa's physics requires WHEEL_LF/RF/LR/RR on every car — a car
  // without them does not run — so this is a measurement rather than a guess.
  // Across 238 fleet cars it resolved every one, agreed with the old name
  // heuristic on all 145 the heuristic was sure about, and corrected two.
  const { axesFromWheels } = await import('../src/engine/kn5.mjs');

  const normal = axesFromWheels(wheelCar());
  assert.equal(normal.left, 1, '+X is the left of a car whose LF sits at positive X');
  assert.equal(normal.front, 1);
  assert.ok(normal.confident);
  assert.ok(Math.abs(normal.wheelbase - 2.3) < 1e-6, `wheelbase ${normal.wheelbase}`);
  assert.ok(Math.abs(normal.trackWidth - 1.6) < 1e-6, `track ${normal.trackWidth}`);

  // A mirrored or reversed model has to come out mirrored or reversed, not
  // defaulted to the common case.
  const mirrored = axesFromWheels(wheelCar({ lf: [-0.8, 0.3, 1.3], rf: [0.8, 0.3, 1.3], lr: [-0.8, 0.3, -1], rr: [0.8, 0.3, -1] }));
  assert.equal(mirrored.left, -1);
  const reversed = axesFromWheels(wheelCar({ lf: [0.8, 0.3, -1.3], rf: [-0.8, 0.3, -1.3], lr: [0.8, 0.3, 1], rr: [-0.8, 0.3, 1] }));
  assert.equal(reversed.front, -1);
});

test('wheels stacked at the origin give no answer rather than a wrong one', async () => {
  // A confident wrong answer is worse than none: everything downstream that
  // asks which way is forward would be silently mirrored.
  const { axesFromWheels } = await import('../src/engine/kn5.mjs');
  const flat = wheelCar({ lf: [0, 0, 0], rf: [0, 0, 0], lr: [0, 0, 0], rr: [0, 0, 0] });
  assert.equal(axesFromWheels(flat), null);
  assert.equal(axesFromWheels({ meshes: [], dummies: [] }), null, 'no wheels, no answer');

  // A model missing a collection entirely should mean "no wheels found", which
  // this function already has an answer for, rather than a TypeError from deep
  // inside it. It is exported and gets called with hand-built models.
  assert.equal(axesFromWheels({}), null, 'no dummies and no meshes');
  assert.equal(axesFromWheels({ meshes: [] }), null, 'meshes but no dummies');
  assert.equal(axesFromWheels({ dummies: [] }), null, 'dummies but no meshes');
});

test('the shipped profiles record axes measured from the wheels', async () => {
  const { loadProfile } = await import('../src/profile.mjs');
  for (const [file, wb] of [['../cars/rss_formula_rss_4.json', 2.74], ['../cars/abarth500.json', 2.30]]) {
    const p = await loadProfile(new URL(file, import.meta.url));
    const a = p.calibration.axes;
    assert.equal(a.from, 'wheels');
    assert.equal(a.left, '+X');
    assert.equal(a.front, '+Z');
    // A figure a person can check against a spec sheet is the point of storing it.
    assert.ok(Math.abs(a.wheelbase - wb) < 0.02, `${file}: wheelbase ${a.wheelbase}, expected ~${wb}`);
  }
});

test('re-tagging clears shared-rect metadata that no longer applies', async () => {
  // Tagging runs again on every regeneration. A panel that used to share its
  // rectangle may not any more, and a stale `instances: 4` is worse than no
  // field at all because it still reads as something that was measured.
  const { tagProfile } = await import('../src/engine/tags.mjs');
  const profile = {
    calibration: { axes: { left: '+X', front: '+Z' } },
    panels: {
      rims: {
        lf: { rect: [0.1, 0.1, 0.2, 0.2], centroid3d: [1, 0, 2] },
        rf: { rect: [0.1, 0.1, 0.2, 0.2], centroid3d: [-1, 0, 2] },
      },
    },
  };
  const first = tagProfile(profile);
  assert.equal(first.shared, 2);
  assert.equal(profile.panels.rims.lf.instances, 2);
  assert.deepEqual(profile.panels.rims.lf.sharesRectWith, ['rf']);

  // Now they no longer overlap — as if a rect had been corrected by hand.
  profile.panels.rims.rf.rect = [0.5, 0.5, 0.2, 0.2];
  const second = tagProfile(profile);
  assert.equal(second.shared, 0);
  for (const name of ['lf', 'rf']) {
    assert.equal(profile.panels.rims[name].instances, undefined, name);
    assert.equal(profile.panels.rims[name].sharesRectWith, undefined, name);
  }
  assert.ok(profile.panels.rims.lf.tags.includes('left'), 'and the side tag comes back');
});

test('an empty or malformed tag selector is refused, not silently everything', async () => {
  // `every` on an empty list is vacuously true, so tags: [] would have matched
  // every panel and painted the whole texture — the loudest possible version of
  // this project's quietest bug.
  const { expandRegions } = await import('../src/profile.mjs');
  const p = tagCar({}, {
    a: { rect: [0, 0, 0.3, 0.3], tags: ['left'] },
    b: { rect: [0.5, 0, 0.3, 0.3], tags: ['right'] },
  });
  for (const bad of [[], 'left', {}, null]) {
    assert.throws(
      () => expandRegions(p, 'body', [{ treatment: 'fill', tags: bad }]),
      /non-empty array of tag names/,
      JSON.stringify(bad),
    );
  }
  // A region with no tags at all is untouched — that is the ordinary case.
  const { regions } = expandRegions(p, 'body', [{ treatment: 'fill', panel: 'a' }]);
  assert.equal(regions.length, 1);
});

test('limit takes the largest matching panels, for text that wants one', async () => {
  // A pattern wants every panel it matches; a number wants exactly one, and
  // wants the one with room for it. Without this, [left, visible] put the car
  // number on seven panels of the Abarth at seven different sizes.
  const { panelsWithTags } = await import('../src/profile.mjs');
  const p = tagCar({}, {
    small: { rect: [0.0, 0, 0.10, 0.10], tags: ['left', 'visible'] },
    big: { rect: [0.2, 0, 0.50, 0.50], tags: ['left', 'visible'] },
    mid: { rect: [0.8, 0, 0.20, 0.20], tags: ['left', 'visible'] },
  });
  assert.equal(panelsWithTags(p, 'body', ['left', 'visible']).length, 3, 'unlimited matches all');
  assert.deepEqual(panelsWithTags(p, 'body', ['left', 'visible'], { limit: 1 }), ['big']);
  assert.deepEqual(panelsWithTags(p, 'body', ['left', 'visible'], { limit: 2 }), ['big', 'mid'],
    'largest first, not profile order');

  const { expandRegions } = await import('../src/profile.mjs');
  assert.throws(
    () => expandRegions(p, 'body', [{ treatment: 'text', tags: ['left'], limit: 0 }]),
    /whole number of panels, 1 or more/,
  );
});

test('a `once` region lands on the primary texture only', async () => {
  // `body` on the RSS4 binds to two chassis textures. A pattern belongs on both;
  // a car number belongs on the car once, not once per texture.
  const { resolveTargets } = await import('../src/profile.mjs');
  const p = {
    id: 'c',
    textures: {
      front: { file: 'f.dds', width: 64, height: 64 },
      rear: { file: 'r.dds', width: 64, height: 64 },
    },
    bind: { body: { roles: ['front', 'rear'], source: 'human' } },
  };
  const { targets } = resolveTargets(p, { name: 'L', surfaces: { body: spec } });
  assert.deepEqual(targets.map((t) => [t.role, t.primary]), [['front', true], ['rear', false]]);

  // And a `paint` entry is always its own primary — there is nothing to share with.
  const direct = resolveTargets(p, { name: 'L', paint: { rear: spec } });
  assert.equal(direct.targets[0].primary, true);
});

// --- fits -------------------------------------------------------------------

const fitLivery = () => ({
  name: 'L',
  surfaces: {
    body: {
      background: 'ink',
      regions: [
        { treatment: 'grid' },
        { id: 'num', treatment: 'text', tags: ['left', 'visible'], limit: 1, at: [0.2, 0.2, 0.6, 0.6], text: '{number}' },
        { id: 'team', treatment: 'text', tags: ['left'], at: [0, 0.8, 1, 0.1], text: '{team}' },
      ],
    },
  },
});
const fitCar = () => ({
  id: 'c',
  textures: { body: { file: 'b.dds', width: 64, height: 64 } },
  panels: {
    body: {
      quarter: { rect: [0.0, 0, 0.5, 0.5], tags: ['left', 'visible'] },
      door: { rect: [0.5, 0, 0.3, 0.3], tags: ['left', 'visible'] },
    },
  },
});

test('a fit moves a region without touching the design', async () => {
  const { applyFit } = await import('../src/fit.mjs');
  const { expandRegions } = await import('../src/profile.mjs');
  const livery = fitLivery();
  const profile = fitCar();

  const before = expandRegions(profile, 'body', livery.surfaces.body.regions).regions;
  assert.equal(before.find((r) => r.id === 'num').panel, 'quarter', 'largest panel by default');

  const fit = { livery: 'L', car: 'c', regions: { num: { panel: 'door', at: [0.1, 0.1, 0.8, 0.8] } } };
  const { regions } = applyFit(livery.surfaces.body.regions, fit, { profile, role: 'body' });
  const after = expandRegions(profile, 'body', regions).regions;
  const num = after.find((r) => r.id === 'num');
  assert.equal(num.panel, 'door', 'an explicit panel beats the tag selection');
  assert.deepEqual(num.at, [0.1, 0.1, 0.8, 0.8]);
  assert.equal(num.tags, undefined, 'tags are cleared, or panel and tags would conflict');
  // The design is untouched — a fit adjusts a copy.
  assert.deepEqual(livery.surfaces.body.regions[1].at, [0.2, 0.2, 0.6, 0.6]);
});

test('a fit can drop a region a car has nowhere to put', async () => {
  const { applyFit } = await import('../src/fit.mjs');
  const fit = { livery: 'L', car: 'c', regions: { team: { drop: true } } };
  const { regions } = applyFit(fitLivery().surfaces.body.regions, fit, { profile: fitCar(), role: 'body' });
  assert.deepEqual(regions.map((r) => r.id), [undefined, 'num']);
});

test('a stale fit is reported and ignored, never silently obeyed', async () => {
  // A design gets edited, a profile regenerated, a panel renamed. A fit that
  // quietly does nothing would be this project's oldest bug one level up.
  const { applyFit, unusedFitIds } = await import('../src/fit.mjs');
  const notes = [];
  const used = new Set();
  const fit = {
    livery: 'L', car: 'c',
    regions: { num: { panel: 'nonexistent' }, 'no-such-region': { drop: true } },
  };
  const { regions } = applyFit(fitLivery().surfaces.body.regions, fit, { profile: fitCar(), role: 'body', used, notes });

  const num = regions.find((r) => r.id === 'num');
  assert.equal(num.panel, undefined, 'the bad override is ignored');
  assert.deepEqual(num.tags, ['left', 'visible'], 'and the region keeps what the livery gave it');
  assert.equal(notes[0].status, 'fit-stale');
  assert.match(notes[0].text, /does not have/);
  assert.deepEqual(unusedFitIds(fit, used), ['no-such-region']);
});

test('a fit may adjust placement, and nothing else', async () => {
  // Left open, this becomes a second livery language. Colours and treatments
  // belong to the design; a fit says where things go on one car.
  const { validateFit } = await import('../src/fit.mjs');
  assert.throws(() => validateFit({ livery: 'L', car: 'c', regions: { a: { color: 'red' } } }),
    /may not override "color"/);
  assert.throws(() => validateFit({ livery: 'L', car: 'c', regions: { a: { treatment: 'fill' } } }),
    /may not override "treatment"/);
  assert.throws(() => validateFit({ car: 'c' }), /missing "livery"/);
  assert.doesNotThrow(() => validateFit({
    livery: 'L', car: 'c', notes: ['free text is fine'],
    regions: { a: { panel: 'p', at: [0, 0, 1, 1], rotate: 90, drop: false } },
  }));
});

test('region ids must be unique across a livery', async () => {
  // Ids are how a fit addresses a region. Two the same makes an override
  // ambiguous, which silently adjusts one of them and not the other.
  const { regionIds } = await import('../src/fit.mjs');
  const dup = fitLivery();
  dup.surfaces.body.regions[2].id = 'num';
  assert.throws(() => regionIds(dup), /uses the region id "num" twice/);
  assert.deepEqual([...regionIds(fitLivery()).keys()], ['num', 'team']);
});

test('the shipped fits apply cleanly to the cars they name', async () => {
  const { loadFit, applyFit, regionIds, unusedFitIds } = await import('../src/fit.mjs');
  const { loadProfile, expandRegions, binding } = await import('../src/profile.mjs');
  const livery = (await import('../liveries/neon-grid-any.mjs')).default;
  const ids = regionIds(livery);

  for (const car of ['abarth500', 'rss_formula_rss_4']) {
    const fit = await loadFit(new URL(`../fits/neon-grid-any@${car}.json`, import.meta.url));
    assert.equal(fit.car, car);
    assert.equal(fit.livery, 'neon-grid-any');
    for (const id of Object.keys(fit.regions)) {
      assert.ok(ids.has(id), `${car}: fit names "${id}", which the livery does not declare`);
    }

    const profile = await loadProfile(new URL(`../cars/${car}.json`, import.meta.url));
    const role = binding(profile, 'body').roles[0];
    const used = new Set();
    const notes = [];
    const { regions } = applyFit(livery.surfaces.body.regions, fit, { profile, role, used, notes });
    expandRegions(profile, role, regions);
    assert.deepEqual(notes, [], `${car}: ${notes.map((n) => n.text)}`);
    assert.deepEqual(unusedFitIds(fit, used), [], `${car}: fit ids that matched nothing`);
  }
});

// --- the fitting editor -----------------------------------------------------

test('panel-relative and absolute coordinates round-trip exactly', async () => {
  // The editor works in absolute texture fractions because that is what a mouse
  // gives you, and converts once on the way into the fit. `at` never acquires a
  // second meaning depending on where it was written.
  const { toAbsolute, toPanelRelative } = await import('../src/fit.mjs');
  const panel = [0.2, 0.1, 0.4, 0.5];
  for (const at of [[0, 0, 1, 1], [0.5, 0, 0.5, 1], [0.25, 0.3, 0.4, 0.2]]) {
    assert.deepEqual(toPanelRelative(panel, toAbsolute(panel, at)), at, JSON.stringify(at));
  }
  assert.deepEqual(toAbsolute([0.2, 0.1, 0.4, 0.5], [0.5, 0, 0.5, 1]), [0.4, 0.1, 0.2, 0.5]);
  // A degenerate panel cannot express anything relative to itself, and must not
  // divide by zero on the way to saying so.
  assert.deepEqual(toPanelRelative([0, 0, 0, 0], [0, 0, 1, 1]), [0, 0, 1, 1]);
});

test('the editor reports where regions actually landed, not where it thinks they did', async () => {
  // The overlay draws the rectangle the RENDERER resolved, so if the two ever
  // disagree you can see it rather than dragging a box that has quietly stopped
  // corresponding to the artwork.
  const { renderSurface, editorState } = await import('../src/ui/server.mjs');
  const { loadProfile, binding } = await import('../src/profile.mjs');
  const { loadFit } = await import('../src/fit.mjs');

  const livery = (await import('../liveries/neon-grid-any.mjs')).default;
  const profile = await loadProfile(new URL('../cars/abarth500.json', import.meta.url));
  const fit = await loadFit(new URL('../fits/neon-grid-any@abarth500.json', import.meta.url));
  const role = binding(profile, 'body').roles[0];

  const state = editorState({ livery, profile, fit, liveryId: 'neon-grid-any' });
  assert.ok(state.surfaces.length > 3, 'editable surfaces');
  // The name a FIT knows this design by is the module basename, not the skin
  // folder the game installs. The browser writes it into any fit it creates, so
  // the two must not be confused.
  assert.equal(state.livery.id, 'neon-grid-any');
  assert.equal(state.livery.folder, 'neon_grid_any');
  assert.ok(state.surfaces.every((s) => s.panels.length >= 0 && s.file));
  assert.ok(Object.keys(state.regionIds).includes('number-left'));

  const out = renderSurface({ livery, profile, fit, role });
  assert.match(out.svg, /^<svg /, 'a self-contained document the browser can render');
  assert.deepEqual(out.notes, [], `unexpected notes: ${out.notes.map((n) => n.text)}`);

  // The fit moves the number onto the door; the reported placement must agree.
  const num = out.placed.find((p) => p.id === 'number-left');
  assert.equal(num.panel, 'left_mid');
  const door = profile.panels[role].left_mid.rect;
  assert.ok(num.abs[0] >= door[0] && num.abs[0] + num.abs[2] <= door[0] + door[2] + 1e-9,
    `placement ${num.abs} should sit inside the panel ${door}`);

  // And a region the fit drops should not be reported as placed at all.
  assert.equal(out.placed.find((p) => p.id === 'driver-left'), undefined);
});

test('the editor is told the profile\'s panel name, not the livery\'s', async () => {
  // A design may say `flankLeft` where the profile calls the island `left_mid`,
  // and both are right — that is what an alias block is for. But only `left_mid`
  // is a key in profile.panels, which is what the panel list and every lookup in
  // the browser are keyed by. Reporting the livery's spelling made those lookups
  // find nothing, and a drag then fell back to ABSOLUTE coordinates and wrote
  // them into `at`, which means panel-relative. The artwork moved somewhere
  // nobody asked for, from a fit that reads perfectly well.
  const { renderSurface, editorState } = await import('../src/ui/server.mjs');

  const profile = {
    id: 'c', name: 'C',
    textures: { body: { file: 'b.dds', width: 64, height: 64 } },
    bind: { body: { roles: ['body'], source: 'human' } },
    panels: { body: { left_mid: { rect: [0.1, 0.2, 0.4, 0.4], tags: ['left'] } } },
    aliases: { body: { flankLeft: 'left_mid' } },
  };
  const livery = {
    name: 'L', folder: 'l', car: 'c', palette: { ink: '#101014', accent: '#00f0ff' },
    surfaces: { body: { background: 'ink', regions: [
      { id: 'badge', panel: 'flankLeft', at: [0.5, 0, 0.5, 1], treatment: 'fill', color: 'accent' },
    ] } },
  };

  const state = editorState({ livery, profile, fit: null, liveryId: 'l' });
  const names = state.surfaces[0].panels.map((p) => p.name);
  assert.deepEqual(names, ['left_mid'], 'the panel list is keyed by the profile');

  const placed = renderSurface({ livery, profile, fit: null, role: 'body' }).placed
    .find((p) => p.id === 'badge');
  assert.equal(placed.panel, 'left_mid', 'the placement names the panel the list contains');
  assert.ok(names.includes(placed.panel), 'so the browser can find it');

  // And the DECLARED panel resolves the same way, or "is this still where the
  // design put it?" compares two spellings of one island and always says no.
  assert.equal(state.surfaces[0].regions[0].panel, 'left_mid');

  // The rectangle is still measured against that panel: `at` is the right half
  // of a panel starting at x=0.1 and 0.4 wide.
  assert.deepEqual(placed.abs, [0.3, 0.2, 0.2, 0.4]);
});

test('the editor and the build agree on what a region without an id is called', async () => {
  // A region the design gave no id is addressed by POSITION, and the key is made
  // from the surface it sits on. The editor passed the surface and the build did
  // not, so the editor wrote `body#0` into a fit and the build looked for `#0`.
  // Every adjustment made to an unnamed region — which is 95 of the 95 regions
  // in the bundled neon-grid — did nothing, and said so only as a stale-id note
  // buried at the end of the build.
  const { applyFit } = await import('../src/fit.mjs');
  const { buildSkin } = await import('../src/build.mjs');

  const profile = {
    id: 'c', name: 'C',
    textures: { body: { file: 'b.dds', width: 64, height: 64 } },
    bind: { body: { roles: ['body'], source: 'human' } },
    panels: { body: { L: { rect: [0, 0, 0.5, 1] }, R: { rect: [0.5, 0, 0.5, 1] } } },
  };
  const livery = {
    name: 'L', folder: 'l', car: 'c', palette: { ink: '#101014', accent: '#00f0ff' },
    surfaces: { body: { background: 'ink', regions: [
      { panel: 'L', at: [0, 0, 1, 1], treatment: 'fill', color: 'accent' },
    ] } },
  };
  const fit = { livery: 'l', car: 'c', regions: { 'body#0': { panel: 'R' } } };

  // What the editor calls it.
  const key = applyFit(livery.surfaces.body.regions, null,
    { profile, role: 'body', surfaceKey: 'body' }).regions[0].__key;
  assert.equal(key, 'body#0');

  // And the build has to reach the same region by that name. buildSkin needs an
  // encoder, so this checks the one thing that decides it: whether the fit was
  // used up, or left over and reported stale.
  const used = new Set();
  const notes = [];
  const out = applyFit(livery.surfaces.body.regions, fit,
    { profile, role: 'body', surfaceKey: 'body', used, notes }).regions;
  assert.equal(out[0].panel, 'R', 'the override applied');
  assert.ok(used.has('body#0'), 'and the fit id was consumed rather than left dangling');
  assert.equal(typeof buildSkin, 'function');

  // The source of truth for what the build passes: it must name the surface.
  const src = await readFile(new URL('../src/build.mjs', import.meta.url), 'utf8');
  assert.match(src, /surfaceKey:\s*from/,
    'buildSkin must pass the surface key, or unnamed regions are addressed differently here');
});

test('a car model is looked for where a person would actually have one', async () => {
  // This project ships no .kn5 and never will — a model belongs to whoever made
  // the car. So the editor's 3D views depend entirely on the person supplying
  // one, and "the 3D view is broken" and "you have not said where your game is"
  // look identical unless the tool goes looking in the right places and lists
  // what it tried. The default used to be a single path inside the checkout,
  // which works only if you unpack a car into the repo.
  const { carModelCandidates } = await import('../src/profile.mjs');
  const profile = { id: 'abarth500', calibration: { source: 'abarth500.kn5' } };

  const env = { AC_ROOT: '/games/ac', ASSETTOCORSA: '/other/ac' };
  assert.deepEqual(carModelCandidates(profile, { root: '/repo', env }), [
    '/games/ac/content/cars/abarth500/abarth500.kn5',
    '/other/ac/content/cars/abarth500/abarth500.kn5',
    '/repo/content/cars/abarth500/abarth500.kn5',
    '/repo/cars/abarth500/abarth500.kn5',
  ], 'the game install is asked first, then the checkout, in both layouts');

  // No environment: the checkout still works, which is the arrangement for
  // anyone unpacking a car they do not want to keep.
  assert.deepEqual(carModelCandidates(profile, { root: '/repo' }), [
    '/repo/content/cars/abarth500/abarth500.kn5',
    '/repo/cars/abarth500/abarth500.kn5',
  ]);

  // A profile that does not record what it was built from cannot be guessed at,
  // and saying so beats offering a path with `undefined` in it.
  assert.deepEqual(carModelCandidates({ id: 'x' }, { root: '/repo' }), []);
});

test('a stale fit reaches the editor as a note rather than a crash', async () => {
  const { renderSurface } = await import('../src/ui/server.mjs');
  const { loadProfile, binding } = await import('../src/profile.mjs');
  const livery = (await import('../liveries/neon-grid-any.mjs')).default;
  const profile = await loadProfile(new URL('../cars/abarth500.json', import.meta.url));
  const role = binding(profile, 'body').roles[0];

  const out = renderSurface({
    livery, profile, role,
    fit: { livery: 'x', car: 'abarth500', regions: { 'no-such-region': { drop: true } } },
  });
  assert.equal(out.notes.length, 1);
  assert.match(out.notes[0].text, /matches no region/);
  assert.ok(out.placed.length > 0, 'and everything else still renders');
});

test('rotate: auto follows the panel the unwrapper actually made', async () => {
  // An unwrapper is free to lay a panel sideways to pack the sheet, and a road
  // car routinely does. Text placed without compensating reads vertically, which
  // looks like a bug and is really the texture being honest about its layout.
  const p = {
    id: 't',
    textures: { body: { file: 'b.dds', width: 512, height: 512 } },
    panels: {
      body: {
        upright: { rect: [0, 0, 0.4, 0.4], textRotation: 0 },
        sideways: { rect: [0.5, 0, 0.4, 0.4], textRotation: 270 },
        flat: { rect: [0, 0.5, 0.4, 0.4] },              // roof: no measurement
      },
    },
  };
  const draw = (panel) => renderTexture({
    profile: p, role: 'body',
    regions: [{ treatment: 'text', panel, rotate: 'auto', text: 'X', color: 'white' }],
    treatments: resolveTreatments(['core']), palette: {}, rng: Math.random,
    font: 'sans-serif', tokens: {},
  }).base;

  assert.doesNotMatch(draw('upright'), /rotate\(/, 'an upright panel needs no correction');
  assert.match(draw('sideways'), /rotate\(270/, 'a sideways panel is turned back level');
  // A near-horizontal panel has no meaningful "up", so the honest answer is to
  // leave it alone rather than rotate by a number derived from rounding error.
  assert.doesNotMatch(draw('flat'), /rotate\(/, 'no measurement means no rotation');
});

test('the shipped profiles carry a measured orientation per panel', async () => {
  // The measurement that explains what a car looks like: the Abarth's doors are
  // laid sideways in its texture, the formula car's flanks are not.
  const { loadProfile } = await import('../src/profile.mjs');
  const ab = await loadProfile(new URL('../cars/abarth500.json', import.meta.url));
  const rss = await loadProfile(new URL('../cars/rss_formula_rss_4.json', import.meta.url));

  assert.equal(ab.panels.skinbase_default.left_mid.textRotation, 270);
  assert.equal(ab.panels.skinbase_default.right_mid.textRotation, 90);
  assert.equal(rss.panels.body.left_mid.textRotation, 0);
  assert.equal(rss.panels.body.right_mid.textRotation, 0);
});

test('a surface with no regions builds instead of crashing', async () => {
  // `regions` is optional everywhere else in this codebase. A surface that only
  // sets a background is a legitimate way to flat-colour a part.
  const { resolveTargets } = await import('../src/profile.mjs');
  const { applyFit } = await import('../src/fit.mjs');
  const profile = {
    id: 'c',
    textures: { body: { file: 'b.dds', width: 64, height: 64 } },
    bind: { body: { roles: ['body'], source: 'human' } },
  };
  const { targets } = resolveTargets(profile, { name: 'L', surfaces: { body: { background: 'ink' } } });
  assert.equal(targets.length, 1);
  // The build filters regions before applying a fit; both halves must tolerate
  // the field being absent.
  assert.doesNotThrow(() => (targets[0].spec.regions ?? []).filter(() => true));
  assert.deepEqual(applyFit(targets[0].spec.regions ?? [], null, { profile, role: 'body' }).regions, []);
});

test('the editor refuses to start on a fit it cannot honour', async () => {
  // A missing fit is normal — most cars have never been tuned. A fit that exists
  // and is wrong is not, and starting anyway gives an editor that looks fine and
  // fails only when you press Save, by which point the work has been done twice.
  const { startUi } = await import('../src/ui/server.mjs');
  const { loadProfile } = await import('../src/profile.mjs');
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const livery = (await import('../liveries/neon-grid-any.mjs')).default;
  const profile = await loadProfile(new URL('../cars/abarth500.json', import.meta.url));
  const dir = await mkdtemp(join(tmpdir(), 'lk-ui-'));

  const ui = (fitPath, port) =>
    startUi({ livery, profile, fitPath, liveryId: 'neon-grid-any', port, log: () => {} });

  const bad = join(dir, 'bad.json');
  await writeFile(bad, JSON.stringify({ car: 'abarth500', regions: {} }));   // no "livery"
  await assert.rejects(() => ui(bad, 7395), /Could not load .*missing "livery"/s);

  // A fit that simply is not there must still start.
  const { server } = await ui(join(dir, 'absent.json'), 7396);
  server.close();
});

test('the editor refuses a fit that is for some other design or car', async () => {
  // `--fit` takes any path and the conventional one outlives the profile it was
  // written for, so a file being open is no evidence it belongs here. Unchecked,
  // the editor resolves one design's ids against another car's panels and then
  // overwrites the original on Save — silently, because each step is valid.
  const { startUi } = await import('../src/ui/server.mjs');
  const { loadProfile } = await import('../src/profile.mjs');
  const { mkdtemp, writeFile, readFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const livery = (await import('../liveries/neon-grid-any.mjs')).default;
  const profile = await loadProfile(new URL('../cars/abarth500.json', import.meta.url));
  const dir = await mkdtemp(join(tmpdir(), 'lk-ui-'));

  for (const [name, fit, expected] of [
    ['othercar.json', { livery: 'neon-grid-any', car: 'rss_formula_rss_4' }, /"car" is "rss_formula_rss_4"/],
    ['otherdesign.json', { livery: 'something-else', car: 'abarth500' }, /"livery" is "something-else"/],
  ]) {
    const path = join(dir, name);
    await writeFile(path, JSON.stringify({ ...fit, regions: {} }));
    await assert.rejects(
      () => startUi({ livery, profile, fitPath: path, liveryId: 'neon-grid-any', port: 7398, log: () => {} }),
      expected, name);
  }

  // And Save is a whole-file overwrite, so the same check has to hold there: a
  // client that has drifted must not be able to replace this pair's fit with
  // another pair's.
  const path = join(dir, 'mine.json');
  await writeFile(path, JSON.stringify({ livery: 'neon-grid-any', car: 'abarth500', regions: {} }));
  const { server, url } = await startUi({
    livery, profile, fitPath: path, liveryId: 'neon-grid-any', port: 7399, log: () => {},
  });
  try {
    const res = await fetch(`${url}api/fit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ livery: 'neon-grid-any', car: 'rss_formula_rss_4', regions: { x: { drop: true } } }),
    });
    assert.equal(res.status, 409, 'the server is fine; the submission is for something else');
    assert.match((await res.json()).error, /"car" is "rss_formula_rss_4"/);
    const onDisk = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(onDisk.car, 'abarth500', 'and the file on disk is untouched');
    assert.deepEqual(onDisk.regions, {});
  } finally {
    server.close();
  }
});

test('a fit knows a design by its module name, not its skin folder', async () => {
  // fits/<livery>@<car>.json, and the file repeats the pair inside itself. Derive
  // the two halves differently and the contents disagree with the filename.
  const { fitLiveryId } = await import('../src/fit.mjs');
  assert.equal(fitLiveryId('/a/b/liveries/neon-grid-any.mjs'), 'neon-grid-any');
  assert.equal(fitLiveryId('neon-grid.mjs'), 'neon-grid');
  const livery = (await import('../liveries/neon-grid-any.mjs')).default;
  assert.notEqual(livery.folder, 'neon-grid-any', 'the skin folder is the underscored name, and is not this');
});

test('a bad ?role on /api/model is a client error, not a crash', async () => {
  // texture() throws on an unknown role, which through the generic handler comes
  // back as a 500: a stack trace in the log and "the server crashed" in the
  // browser, for what is a typo in a query string.
  const { startUi } = await import('../src/ui/server.mjs');
  const { loadProfile } = await import('../src/profile.mjs');
  const profile = await loadProfile(new URL('../cars/abarth500.json', import.meta.url));
  const livery = (await import('../liveries/neon-grid-any.mjs')).default;
  const { server } = await startUi({
    livery, profile, fitPath: '/nonexistent/fit.json', liveryId: 'neon-grid-any',
    port: 0, log: () => {},
  });
  try {
    const at = `http://127.0.0.1:${server.address().port}`;
    const missing = await fetch(`${at}/api/model`);
    assert.equal(missing.status, 400, 'no role at all');
    assert.match((await missing.json()).error, /needs a \?role/);

    const unknown = await fetch(`${at}/api/model?role=no_such_role`);
    assert.equal(unknown.status, 404, 'a role this car does not have');
    assert.match((await unknown.json()).error, /Known roles:/);
  } finally {
    server.close();
  }
});

test('the editor caps how much it will read from a request', async () => {
  // Loopback or not, an unbounded read grows the process until it dies. A fit is
  // a few kilobytes of JSON.
  const { startUi } = await import('../src/ui/server.mjs');
  const { loadProfile } = await import('../src/profile.mjs');
  const livery = (await import('../liveries/neon-grid-any.mjs')).default;
  const profile = await loadProfile(new URL('../cars/abarth500.json', import.meta.url));
  const { server, url } = await startUi({
    livery, profile, fitPath: '/nonexistent/fit.json', liveryId: 'neon-grid-any', port: 7397, log: () => {},
  });
  try {
    const res = await fetch(`${url}api/fit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ livery: 'L', car: 'c', pad: 'x'.repeat(3 * 1024 * 1024) }),
    });
    assert.equal(res.status, 500);
    assert.match((await res.json()).error, /body over/);
  } finally {
    server.close();
  }
});

test('the vendor route serves two named files and cannot be walked out of', async () => {
  // The editor needs colord in the browser, and gets it from `node_modules` as
  // the package's own ESM rather than as a vendored copy — which means the
  // fitting server now has a route whose job is to read out of `node_modules`.
  // That is worth a test rather than a comment: the whole file is built around
  // never joining a request path with a directory, and this is the one place
  // somebody would be tempted to.
  const { startUi } = await import('../src/ui/server.mjs');
  const { loadProfile } = await import('../src/profile.mjs');
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const livery = (await import('../liveries/neon-grid-any.mjs')).default;
  const profile = await loadProfile(new URL('../cars/abarth500.json', import.meta.url));
  const dir = await mkdtemp(join(tmpdir(), 'lk-vendor-'));
  const { server } = await startUi({
    livery, profile, fitPath: join(dir, 'absent.json'),
    liveryId: 'neon-grid-any', port: 0, log: () => {},
  });
  const at = (p) => `http://127.0.0.1:${server.address().port}${p}`;

  try {
    const ok = await fetch(at('/vendor/colord/index.mjs'));
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'text/javascript');
    const body = await ok.text();
    assert.match(body, /export/, 'and it is a module, not a 404 page with a 200 on it');

    const names = await fetch(at('/vendor/colord/plugins/names.mjs'));
    assert.equal(names.status, 200);

    // Everything else under the prefix, including the things a path-joining
    // server would hand over. `fetch` normalises `..` before it sends, so the
    // last two arrive already resolved — which is the point: there is no
    // spelling of a traversal that reaches the allowlist, because the allowlist
    // is compared whole rather than joined.
    for (const p of [
      '/vendor/colord/package.json',
      '/vendor/colord/index.js',
      '/vendor/sharp/package.json',
      '/vendor/colord/../../package.json',
      '/vendor/colord/index.mjs/../../../package.json',
      '/vendor/',
    ]) {
      const res = await fetch(at(p));
      assert.equal(res.status, 404, `${p} should not be served`);
    }
  } finally {
    server.close();
  }
});

test('a panel records how big it is on the car, not only how stretched', async () => {
  // `anisotropy` says a panel is 3.9 times wider than tall in UV terms, which is
  // what the renderer needs to un-stretch a glyph. It cannot say whether that
  // glyph lands 40 mm tall or 400: a wheel hub and a bonnet both report 1.0.
  // The magnitudes were already being computed to form that ratio and thrown
  // away, so `metresPerUv` keeps them.
  //
  // The fixture states its own dimensions, so this asserts rather than
  // estimates. The left flank is a flat quad 3.7 m along z by 1.5 m up y,
  // unwrapped into a UV rect 0.29 by 0.46 — and a flat quad is the one case
  // where the arithmetic can be done by hand and checked.
  const { profileFromKn5 } = await import('../src/engine/profilegen.mjs');
  const { carKn5, CAR } = await import('./fixtures/kn5.mjs');
  const { metresAcross } = await import('../src/profile.mjs');
  const { writeFile, mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = await mkdtemp(join(tmpdir(), 'lk-scale-'));
  const file = join(dir, 'car.kn5');
  await writeFile(file, carKn5());
  const profile = await profileFromKn5(file, { id: 'c', visibility: false });
  const role = Object.keys(profile.panels)[0];
  const flank = profile.panels[role].left_mid;

  const [, , uvW, uvH] = CAR.faces.left;
  const alongCar = CAR.length / uvW;      // 3.7 m over 0.29 of the sheet
  const upTheSide = CAR.height / uvH;     // 1.5 m over 0.46

  assert.ok(Math.abs(flank.metresPerUv[0] - alongCar) < 0.01,
    `along u: ${flank.metresPerUv[0]} should be about ${alongCar.toFixed(2)}`);
  assert.ok(Math.abs(flank.metresPerUv[1] - upTheSide) < 0.01,
    `along v: ${flank.metresPerUv[1]} should be about ${upTheSide.toFixed(2)}`);

  // And it agrees with the ratio that was already there, which is the check
  // that catches the two being computed off different axes — an error that
  // leaves both numbers looking perfectly reasonable on their own.
  assert.ok(Math.abs(flank.metresPerUv[0] / flank.metresPerUv[1] - flank.anisotropy) < 0.02,
    'the magnitudes must divide to the anisotropy already recorded');

  // The payoff: a region covering a third of that panel's width is now a
  // number of metres rather than a fraction of an image nobody can picture.
  const third = resolveRect(profile, role, { panel: 'left_mid', at: [0, 0, 1 / 3, 0.5] });
  const m = metresAcross(third);
  assert.ok(Math.abs(m.w - CAR.length / 3) < 0.02, `${m.w} m across, expected ${(CAR.length / 3).toFixed(2)}`);
  assert.ok(Math.abs(m.h - CAR.height / 2) < 0.02, `${m.h} m tall, expected ${(CAR.height / 2).toFixed(2)}`);

  // A profile generated before this measurement existed, or a region placed
  // absolutely with no panel under it, gets NO answer rather than a plausible
  // wrong one. Half the shipped profiles are in the first case until somebody
  // regenerates them, and a made-up size would be believed.
  assert.equal(metresAcross(resolveRect(profile, role, { at: [0, 0, 1, 1] })), null,
    'no panel, no measurement');
  const older = structuredClone(profile);
  delete older.panels[role].left_mid.metresPerUv;
  assert.equal(metresAcross(resolveRect(older, role, { panel: 'left_mid' })), null,
    'a profile predating the measurement says nothing rather than guessing');
});
