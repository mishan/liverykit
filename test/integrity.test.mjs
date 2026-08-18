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

function buildKn5({ version = 6, extraMeshes = [] } = {}) {
  const parts = [];
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const f32 = (n) => { const b = Buffer.alloc(4); b.writeFloatLE(n); return b; };
  const str = (s) => Buffer.concat([u32(Buffer.byteLength(s)), Buffer.from(s, 'utf8')]);

  parts.push(Buffer.from('sc6969', 'ascii'), u32(version));
  if (version > 5) parts.push(u32(0));

  // textures: one null slot (type 0, no further fields) then one real DDS
  const dds = Buffer.alloc(128); dds.write('DDS ', 0, 'ascii');
  dds.writeUInt32LE(64, 12); dds.writeUInt32LE(32, 16);       // height, width
  parts.push(u32(2), u32(0), u32(1), str('body.dds'), u32(dds.length), dds);

  // one material binding that texture as a diffuse
  parts.push(u32(1), str('BodyMat'), str('ksPerPixel'), Buffer.from([0, 0]), u32(0),
    u32(0), u32(1), str('txDiffuse'), u32(0), str('body.dds'));

  // root dummy -> one mesh child
  const ident = Buffer.concat([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1].map(f32));
  parts.push(u32(1), str('root'), u32(1 + extraMeshes.length), Buffer.from([1]), ident);

  const verts = [
    [0, 0, 0,  0, 1, 0,  0.25, -0.75,  0, 0, 0],
    [1, 0, 0,  0, 1, 0,  0.75, -0.75,  0, 0, 0],
    [0, 0, 1,  0, 1, 0,  0.25, -0.25,  0, 0, 0],
  ];
  parts.push(u32(2), str('body_mesh'), u32(0), Buffer.from([1]), Buffer.from([1, 1, 0]),
    u32(verts.length), ...verts.map((v) => Buffer.concat(v.map(f32))),
    u32(3), Buffer.from([0, 0, 1, 0, 2, 0]),
    u32(0),                    // materialId — first of the 33-byte trailer
    Buffer.alloc(29));         // layer, lodIn, lodOut, bounding sphere, isRenderable

  // Extra meshes, for tests that need geometry the analysis will look for by
  // name (a steering wheel) or trip over (an occluder).
  for (const em of extraMeshes) {
    // Indices matter: the occupancy grid is built by SAMPLING TRIANGLES, so a
    // mesh with no index buffer occupies nothing and cannot occlude.
    const idx = em.indices ?? [];
    const idxBuf = Buffer.alloc(idx.length * 2);
    idx.forEach((v, i) => idxBuf.writeUInt16LE(v, i * 2));
    parts.push(u32(2), str(em.name), u32(0), Buffer.from([1]), Buffer.from([1, 1, 0]),
      u32(em.verts.length), ...em.verts.map((v) => Buffer.concat(v.map(f32))),
      u32(idx.length), idxBuf, u32(0), Buffer.alloc(29));
  }
  return Buffer.concat(parts);
}

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
