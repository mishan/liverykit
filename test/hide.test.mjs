// What a design's `hide` list does at build time.
//
// It used to do nothing there. The editor's whole-car view honoured it and the
// build wrote no file for a hidden role, so a plate hidden on screen still wore
// its stock artwork in the game — unless the car's own config happened to hide
// it, which on the one car this was built against it did, so nobody noticed.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hidePlan } from '../src/build.mjs';

const profile = {
  id: 'car',
  textures: {
    igt_plate:   { file: 'IGT_Plate.dds', width: 1024, height: 1024, alpha: false, shaders: ['ksPerPixelAlpha'], hiddenByCar: true },
    imsa_plate:  { file: 'IMSA_Plate.dds', width: 32, height: 32, alpha: false, shaders: ['ksPerPixelAlpha'] },
    mirror:      { file: 'Mirror.dds', width: 512, height: 512, alpha: false, shaders: ['ksPerPixel'] },
    mixed:       { file: 'Mixed.dds', width: 512, height: 512, alpha: false, shaders: ['ksPerPixel', 'ksPerPixelAlpha'] },
    odd:         { file: 'Odd.dds', width: 68, height: 64, alpha: false, shaders: ['ksPerPixelAlpha'] },
    body:        { file: 'Body.dds', width: 2048, height: 2048, alpha: false, shaders: ['ksPerPixel'] },
    // Hidden by the car's config AND drawn opaque: nothing we ship can hide
    // it, and only the game (with CSP) will.
    lamp:        { file: 'Lamp.dds', width: 256, height: 256, alpha: false, shaders: ['ksPerPixel'], hiddenByCar: true },
  },
};

test('each hidden role gets one of five answers, and none of them is silence', () => {
  const plan = hidePlan(profile, {
    hide: ['igt_plate', 'imsa_plate', 'mirror', 'mixed', 'odd', 'lamp', 'no_such_role'],
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

test('a PNG is judged by its shader like everything else', () => {
  // `.png` used to skip the question entirely, on the unspoken theory that a
  // PNG is what a car uses for things that composite. The format has nothing
  // to say about it: what composites is the material, and a clear sheet drawn
  // by a shader that ignores alpha is a solid black part — reported as hidden,
  // which is the worst of the outcomes here.
  const png = {
    id: 'car',
    textures: {
      opaque: { file: 'Decal.png', width: 256, height: 256, shaders: ['ksPerPixel'] },
      blended: { file: 'Sticker.png', width: 256, height: 256, shaders: ['ksPerPixelAlpha'] },
      unrecorded: { file: 'Old.png', width: 256, height: 256 },
    },
  };
  const by = Object.fromEntries(
    hidePlan(png, { hide: ['opaque', 'blended', 'unrecorded'] }).map((p) => [p.role, p]));
  assert.equal(by.opaque.action, 'cannot');
  assert.match(by.opaque.why, /ksPerPixel/);
  assert.equal(by.blended.action, 'ship-transparent');
  assert.equal(by.unrecorded.action, 'cannot', 'an unrecorded shader is treated as opaque');
});

test('no hide list, no plan', () => {
  assert.deepEqual(hidePlan(profile, {}), []);
  assert.deepEqual(hidePlan(profile, { hide: 'igt_plate' }), []);   // a string is not a list
});
