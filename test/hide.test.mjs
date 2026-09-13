// What a design's `hide` list does at build time.
//
// It used to do nothing there. The editor's whole-car view honoured it and the
// build wrote no file for a hidden role, so a plate hidden on screen still wore
// its stock artwork in the game — unless the car's own config happened to hide
// it, which on the one car this was built against it did, so nobody noticed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hidePlan } from '../src/build.mjs';
import { loadProfile } from '../src/profile.mjs';

const profile = {
  id: 'car',
  textures: {
    igt_plate:   { file: 'IGT_Plate.dds', width: 1024, height: 1024, alpha: false, shaders: ['ksPerPixelAlpha'], alphaHides: true, hiddenByCar: true },
    imsa_plate:  { file: 'IMSA_Plate.dds', width: 32, height: 32, alpha: false, shaders: ['ksPerPixelAlpha'], alphaHides: true },
    mirror:      { file: 'Mirror.dds', width: 512, height: 512, alpha: false, shaders: ['ksPerPixel'], alphaHides: false },
    mixed:       { file: 'Mixed.dds', width: 512, height: 512, alpha: false, shaders: ['ksPerPixel', 'ksPerPixelAlpha'], alphaHides: false },
    odd:         { file: 'Odd.dds', width: 68, height: 64, alpha: false, shaders: ['ksPerPixelAlpha'], alphaHides: true },
    body:        { file: 'Body.dds', width: 2048, height: 2048, alpha: false, shaders: ['ksPerPixel'], alphaHides: false },
    // Hidden by the car's config AND drawn opaque: nothing we ship can hide
    // it, and only the game (with CSP) will.
    lamp:        { file: 'Lamp.dds', width: 256, height: 256, alpha: false, shaders: ['ksPerPixel'], alphaHides: false, hiddenByCar: true },
    // A profile written before the blend modes were recorded. The shader names
    // are no substitute — `ksPerPixelReflection` reads as glass and an Abarth
    // wears it on its bumpers — so an unrecorded answer is not an answer.
    old:         { file: 'Old.dds', width: 256, height: 256, alpha: false, shaders: ['ksPerPixelAlpha'] },
  },
};

test('each hidden role gets one of five answers, and none of them is silence', () => {
  const plan = hidePlan(profile, {
    hide: ['igt_plate', 'imsa_plate', 'mirror', 'mixed', 'odd', 'lamp', 'old', 'no_such_role'],
    paint: {},
  });
  const by = Object.fromEntries(plan.map((p) => [p.role, p]));

  // The car's config hides every mesh wearing it — in the game, under CSP.
  // The showroom applies no such config, and the NSX's plate was seen there
  // wearing an old build's number. A clear sheet works everywhere the mesh
  // is drawn, so where one can be shipped, it is, and the config is a note.
  assert.equal(by.igt_plate.action, 'ship-transparent');
  assert.match(by.igt_plate.why, /car's own config/);
  // Alpha-blended material, encodable size: a transparent texture hides it.
  assert.equal(by.imsa_plate.action, 'ship-transparent');
  assert.equal(by.imsa_plate.file, 'IMSA_Plate.dds');
  assert.doesNotMatch(by.imsa_plate.why, /car's own config/);
  // Nothing shippable would work, but the car's config covers it in the game:
  // reported as that, not as a failure.
  assert.equal(by.lamp.action, 'car-hides');
  assert.match(by.lamp.why, /ksPerPixel/);
  assert.match(by.lamp.why, /car's own config/);
  // Opaque shader: the alpha would be ignored, so say so rather than ship a
  // file that looks like it worked.
  assert.equal(by.mirror.action, 'cannot');
  assert.match(by.mirror.why, /ksPerPixel/);
  // One opaque material among several is enough to leave the part showing.
  assert.equal(by.mixed.action, 'cannot');
  // An odd-sized original is no obstacle: the clear sheet is shipped at its
  // own tiny size, not the texture's.
  assert.equal(by.odd.action, 'ship-transparent');
  // Recorded by nothing: reported as a profile to regenerate, not as a hide
  // that will work.
  assert.equal(by.old.action, 'cannot');
  assert.match(by.old.why, /regenerate/);
  // A role this car does not have: designs travel, so it is not an error, but
  // it is still a line in the report.
  assert.equal(by.no_such_role.action, 'absent');
});

test('a role the design paints is never hidden, and that contradiction is reported', () => {
  const plan = hidePlan(profile, { hide: ['body'], paint: { body: { regions: [] } } });
  assert.equal(plan[0].action, 'painted');
});

test('painting through a surface term counts as painting it', () => {
  // A design names vocabulary terms, and the profile's bind table turns them
  // into roles. Reading `paint` alone, `surfaces.body` and `hide: ['body']`
  // looked like a hide with no paint anywhere near it — so the build rendered
  // the artwork and the hide loop wrote a clear sheet over the top of it.
  const bound = { ...profile, bind: { body: { roles: ['imsa_plate'], source: 'manual' } } };
  const design = { name: 'S', hide: ['imsa_plate'], surfaces: { body: { regions: [] } } };
  assert.equal(hidePlan(bound, design)[0].action, 'painted');

  // And the build's own list of what it painted wins over any of that: a
  // surface it could not encode was not painted, whatever the design asked.
  const asBuilt = hidePlan(bound, design, { paintedRoles: new Set() });
  assert.equal(asBuilt[0].action, 'ship-transparent');
});

test('a PNG is judged by its material like everything else', () => {
  // `.png` used to skip the question entirely, on the unspoken theory that a
  // PNG is what a car uses for things that composite. The format has nothing
  // to say about it: what composites is the material, and a clear sheet drawn
  // by a material that ignores alpha is a solid black part — reported as
  // hidden, which is the worst of the outcomes here.
  const png = {
    id: 'car',
    textures: {
      opaque: { file: 'Decal.png', width: 256, height: 256, shaders: ['ksPerPixel'], alphaHides: false },
      blended: { file: 'Sticker.png', width: 256, height: 256, shaders: ['ksPerPixelAlpha'], alphaHides: true },
      unrecorded: { file: 'Old.png', width: 256, height: 256 },
    },
  };
  const by = Object.fromEntries(
    hidePlan(png, { hide: ['opaque', 'blended', 'unrecorded'] }).map((p) => [p.role, p]));
  assert.equal(by.opaque.action, 'cannot');
  assert.match(by.opaque.why, /ksPerPixel/, 'and the shader names are still in the sentence');
  assert.equal(by.blended.action, 'ship-transparent');
  assert.equal(by.unrecorded.action, 'cannot', 'an unrecorded answer is treated as opaque');
  assert.match(by.unrecorded.why, /regenerate/);
});

test('a texture only the skins folder knows is not sent to a regeneration that cannot answer', () => {
  // The driver's suit, the crew, a part an extension model draws: no mesh in
  // the car's own model wears them, so no regeneration records alphaHides for
  // them, and every shipped profile has some. They were told "regenerate it".
  const [plan] = hidePlan({ id: 'car', textures: {
    suit: { file: 'Suit.dds', width: 1024, height: 1024, sizeFrom: 'skin', inModel: false } } }, { hide: ['suit'] });
  assert.equal(plan.action, 'cannot', 'treated as opaque, the cheaper way to be wrong');
  assert.match(plan.why, /no mesh in this car's model wears Suit\.dds/);
  assert.doesNotMatch(plan.why, /regenerate/);
  // An encrypted model's own textures take their size from a skin too, and
  // are worn: an old profile of one does need regenerating.
  const [worn] = hidePlan({ id: 'car', textures: {
    body: { file: 'Body.dds', width: 2048, height: 2048, sizeFrom: 'skin', shaders: ['ksPerPixel'] } } }, { hide: ['body'] });
  assert.match(worn.why, /regenerate it/);
});

test('every shipped profile records whether a transparent sheet hides each texture', async () => {
  // `alphaHides` was added after the three profiles in cars/ were last
  // generated, so every hide on every shipped car answered "regenerate it" —
  // and the NSX's `car-hides` counted as hidden, so fitment stopped reporting
  // a twin the showroom still drew. A profile that ships stale fails here.
  // From this file, not from the working directory: run from anywhere but the
  // repository root, `process.cwd()` found no cars/ and the test failed on a
  // missing directory instead of on a stale profile.
  const dir = fileURLToPath(new URL('../cars/', import.meta.url));
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 3, `expected the shipped profiles in ${dir}`);
  for (const f of files) {
    const car = await loadProfile(join(dir, f));
    const stale = hidePlan(car, { hide: Object.keys(car.textures ?? {}), paint: {} })
      .filter((p) => /regenerate it/.test(p.why)).map((p) => p.role);
    assert.deepEqual(stale, [], `${f} does not record alphaHides for these; regenerate it with --from-kn5`);
  }
});

test('an alpha-tested material hides a transparent sheet as surely as a blended one', async () => {
  // `alphaHides` asked only whether every wearer BLENDS, so a grille or a logo
  // on ksPerPixelAT_NM — the NSX's two grilles, the Abarth's grille — was
  // reported as "drawn by a material that ignores alpha". It does not ignore
  // it: an alpha-tested material discards every texel under its threshold,
  // and a fully transparent sheet is nothing but such texels. Alpha to
  // coverage keeps no sample of a texel at alpha 0 either.
  const { profileFromKn5 } = await import('../src/engine/profilegen.mjs');
  const { buildKn5, vert } = await import('./fixtures/kn5.mjs');
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const quad = (name, materialId) => ({ name, materialId, indices: [0, 1, 2, 0, 2, 3],
    verts: [vert(0, 0, 0, 0.1, 0.1), vert(1, 0, 0, 0.9, 0.1), vert(1, 0, 1, 0.9, 0.9), vert(0, 0, 1, 0.1, 0.9)] });
  const hides = async (...materials) => {
    const dir = await mkdtemp(join(tmpdir(), 'lk-alpha-'));
    await writeFile(join(dir, 'car.kn5'), buildKn5({
      materials: materials.map((m, i) => ({ name: `M${i}`, ...m })),
      extraMeshes: materials.slice(1).map((_, i) => quad(`PART_${i + 1}`, i + 1)),
    }));
    const p = await profileFromKn5(join(dir, 'car.kn5'), { visibility: false, log: () => {} });
    return Object.values(p.textures).find((t) => t.file === 'body.dds');
  };

  const grille = await hides({ shader: 'ksPerPixelAT_NM', alphaTested: 1 });
  assert.equal(grille.alphaHides, true, 'alpha test, at AC\'s default threshold');
  assert.equal((await hides({ shader: 'ksPerPixelAT', alphaTested: 1, props: { ksAlphaRef: 1 } })).alphaHides, true,
    'even a threshold of 1 throws away a texel at 0');
  assert.equal((await hides({ shader: 'ksPerPixel', alphaBlendMode: 2 })).alphaHides, true, 'alpha to coverage');
  assert.equal((await hides({ shader: 'ksPerPixelAlpha', alphaBlendMode: 1 })).alphaHides, true, 'alpha blend, as before');
  assert.equal((await hides({ shader: 'ksPerPixel' })).alphaHides, false, 'opaque');
  // The shader's name is not the answer: it is the flag the model states, and
  // an AT-named shader without it is drawn like any other.
  assert.equal((await hides({ shader: 'ksPerPixelAT' })).alphaHides, false);
  assert.equal((await hides({ shader: 'ksPerPixelAT_NM', alphaTested: 1 }, { shader: 'ksPerPixel' })).alphaHides, false,
    'one opaque wearer is still enough to leave the part showing');

  const [plan] = hidePlan({ id: 'car', textures: { grille } }, { hide: ['grille'] });
  assert.equal(plan.action, 'ship-transparent');
});

test('no hide list, no plan', () => {
  assert.deepEqual(hidePlan(profile, {}), []);
  assert.deepEqual(hidePlan(profile, { hide: 'igt_plate' }), []);   // a string is not a list
});
