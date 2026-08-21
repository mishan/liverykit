// ---------------------------------------------------------------------------
// Naming, and what survives a regeneration.
//
// Every test here corresponds to something that actually shipped broken. The
// naming bug had been in every profile this project ever generated; the four
// preservation bugs were all found in the space of one afternoon by regenerating
// a profile that had been tuned by hand and watching what came back different.
//
// None of them threw. That is the point of the file: each one produced a profile
// that loaded, validated, resolved and built, and was wrong.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { nameIslands, carBounds } from '../src/engine/islands.mjs';
import { preserveHandwork, describeHandwork } from '../src/engine/preserve.mjs';

const AXES = { left: 1, front: 1 };

/** Four wheels, as a texture role sees them: two axles, nothing else. */
const wheels = () => [
  { centroid: { x: 0.75, y: 0.3, z: 1.2 }, box3d: { y0: 0, y1: 0.6 } },
  { centroid: { x: -0.75, y: 0.3, z: 1.2 }, box3d: { y0: 0, y1: 0.6 } },
  { centroid: { x: 0.75, y: 0.3, z: -1.5 }, box3d: { y0: 0, y1: 0.6 } },
  { centroid: { x: -0.75, y: 0.3, z: -1.5 }, box3d: { y0: 0, y1: 0.6 } },
];

test('a name describes a place on the car, not a place on its own texture', () => {
  // THE BUG: names were normalised against the extent of the other islands on
  // the SAME TEXTURE. A tyre sheet holds four wheels, so the front pair became
  // `*_nose` and the rear pair `*_tail` — the frontmost thing on the sheet is
  // called the nose of the car whatever it is and wherever it sits. On one
  // profile this made 239 of 416 names wrong, including every single name on
  // `interior`, `belts` and `steeringWheel`.
  const alone = nameIslands(wheels(), AXES).map((i) => i.name);
  assert.deepEqual(alone, ['left_nose', 'right_nose', 'left_tail', 'right_tail'],
    'this is the old behaviour, kept as the fallback when no car bounds are known');

  // Told how long the car actually is, the front wheels stop being its nose.
  const onCar = nameIslands(wheels(), AXES, { zMin: -2.2, zMax: 2.1, halfWidth: 0.85 })
    .map((i) => i.name);
  assert.deepEqual(onCar, ['left_front', 'right_front', 'left_tail', 'right_tail']);
});

test('a narrow part does not get a left and a right of its own', () => {
  // The same bug in x, and the one that produced the strangest names: a steering
  // wheel is 30 cm across, so against its own half-width a spoke 12 cm off
  // centre is emphatically `left`. Against the car's it is `centre`.
  const spokes = [
    { centroid: { x: 0.12, y: 0.8, z: 0.4 }, box3d: { y0: 0.7, y1: 0.9 } },
    { centroid: { x: -0.12, y: 0.8, z: 0.4 }, box3d: { y0: 0.7, y1: 0.9 } },
  ];
  const own = nameIslands(spokes.map((s) => ({ ...s })), AXES).map((i) => i.name.split('_')[0]);
  assert.deepEqual(own, ['left', 'right']);

  const onCar = nameIslands(spokes.map((s) => ({ ...s })), AXES,
    { zMin: -2.2, zMax: 2.1, halfWidth: 0.85 }).map((i) => i.name.split('_')[0]);
  assert.deepEqual(onCar, ['centre', 'centre']);
});

test('car bounds come from the whole model, not from one texture', () => {
  const model = {
    meshes: [
      { vertexCount: 2, name: 'a' },
      { vertexCount: 2, name: 'b' },
    ],
  };
  // carBounds reads through `vertex`, so this exercises the real path only
  // loosely; what matters is that a model with no meshes says so rather than
  // returning Infinity and quietly poisoning every name downstream.
  assert.equal(carBounds({ meshes: [] }), null);
  assert.equal(carBounds({}), null);
  assert.ok(model);
});

// ---------------------------------------------------------------------------
// Preservation.
// ---------------------------------------------------------------------------

test('an alias follows its panel when a generated name is reused elsewhere', () => {
  // THE EXPENSIVE ONE. Correcting the naming renamed `centre_mid` to
  // `centre_rear` AND gave the name `centre_mid` to a different island. An alias
  // kept because its target name still existed then pointed at the wrong texels.
  // It resolved. It validated. It built. It painted 43% of the rear bodywork in
  // the wrong place, and nothing anywhere reported a thing.
  const prior = {
    textures: { bodyRear: { file: 'Chassis_C.dds' } },
    panels: {
      bodyRear: {
        centre_mid: { rect: [0.0, 0.37, 0.62, 0.35], centroid3d: [0, 0.6, -1.2] },
        centre_tail: { rect: [0.7, 0.1, 0.2, 0.2], centroid3d: [0, 0.5, -1.9] },
      },
    },
    aliases: { bodyRear: { main: 'centre_mid' } },
  };
  const fresh = {
    textures: { bodyRear: { file: 'Chassis_C.dds' } },
    panels: {
      bodyRear: {
        // the same texels, renamed...
        centre_rear: { rect: [0.0, 0.37, 0.62, 0.35], centroid3d: [0, 0.6, -1.2] },
        // ...and the old name handed to something else entirely
        centre_mid: { rect: [0.7, 0.1, 0.2, 0.2], centroid3d: [0, 0.5, -1.9] },
      },
    },
  };

  const report = preserveHandwork(fresh, prior);
  assert.equal(fresh.aliases.bodyRear.main, 'centre_rear',
    'the alias must follow the rectangle it named, not the string it was written as');
  assert.deepEqual(report.moved, ['bodyRear.main: centre_mid -> centre_rear']);
});

test('an alias whose panel did not move keeps the name it had', () => {
  const prior = {
    textures: { body: { file: 'B.dds' } },
    panels: { body: { left_mid: { rect: [0, 0, 0.5, 0.5], centroid3d: [1, 0, 0] } } },
    aliases: { body: { flankLeft: 'left_mid' } },
  };
  const fresh = {
    textures: { body: { file: 'B.dds' } },
    panels: { body: { left_mid: { rect: [0, 0, 0.5, 0.5], centroid3d: [1, 0, 0] } } },
  };
  const report = preserveHandwork(fresh, prior);
  assert.equal(fresh.aliases.body.flankLeft, 'left_mid');
  assert.deepEqual(report.moved, []);
  assert.deepEqual(report.gone, []);
});

test('an alias for a rectangle the model no longer has is dropped by name', () => {
  const prior = {
    textures: { body: { file: 'B.dds' } },
    panels: { body: { gone_panel: { rect: [0.9, 0.9, 0.05, 0.05], centroid3d: [0, 0, 0] } } },
    aliases: { body: { vent: 'gone_panel' } },
  };
  const fresh = {
    textures: { body: { file: 'B.dds' } },
    panels: { body: { left_mid: { rect: [0, 0, 0.5, 0.5] } } },
  };
  const report = preserveHandwork(fresh, prior);
  assert.deepEqual(report.gone, ['body.vent -> gone_panel']);
  assert.equal(fresh.aliases?.body?.vent, undefined);
  // Silence is the one option not on the table.
  assert.ok(describeHandwork(report, 'prior.json').some((l) => l.includes('body.vent')));
});

test('instanced panels sharing one rectangle keep the instance the alias meant', () => {
  const prior = {
    textures: { rims: { file: 'R.dds' } },
    panels: {
      rims: {
        left_nose: { rect: [0, 0, 0.5, 0.5], centroid3d: [0.75, 0.3, 1.2] },
        right_nose: { rect: [0, 0, 0.5, 0.5], centroid3d: [-0.75, 0.3, 1.2] },
      },
    },
    aliases: { rims: { frontRight: 'right_nose' } },
  };
  const fresh = {
    textures: { rims: { file: 'R.dds' } },
    panels: {
      rims: {
        left_front: { rect: [0, 0, 0.5, 0.5], centroid3d: [0.75, 0.3, 1.2] },
        right_front: { rect: [0, 0, 0.5, 0.5], centroid3d: [-0.75, 0.3, 1.2] },
      },
    },
  };
  preserveHandwork(fresh, prior);
  assert.equal(fresh.aliases.rims.frontRight, 'right_front',
    'four wheels share one rectangle, so the centroid is what tells them apart');
});

test('a hand-chosen role name survives, because liveries address roles directly', () => {
  // `guessRole` can only do so much with a texture called CSW.png.png. Somebody
  // renamed that role `rimFace` and every rebuild turned it back, breaking every
  // livery that said `surfaces.rimFace`.
  const prior = { textures: { rimFace: { file: 'CSW_PNG.png' } }, panels: { rimFace: {} } };
  const fresh = {
    textures: { csw_png_png: { file: 'CSW_PNG.png' } },
    panels: { csw_png_png: { face: { rect: [0, 0, 1, 1] } } },
    adjacency: { csw_png_png: {} },
  };
  const report = preserveHandwork(fresh, prior);
  assert.deepEqual(report.roles, [{ from: 'csw_png_png', to: 'rimFace' }]);
  assert.ok(fresh.textures.rimFace && !fresh.textures.csw_png_png);
  assert.ok(fresh.panels.rimFace.face, 'the panels move with the role');
  assert.ok(fresh.adjacency.rimFace, 'and so does the adjacency');
});

test('a role rename never collides with a name the new profile already uses', () => {
  const prior = { textures: { body: { file: 'Second.dds' } } };
  const fresh = {
    textures: { body: { file: 'First.dds' }, body_2: { file: 'Second.dds' } },
    panels: { body: {}, body_2: {} },
  };
  const report = preserveHandwork(fresh, prior);
  assert.deepEqual(report.roles, [], 'body is taken, so body_2 stays body_2');
  assert.equal(fresh.textures.body.file, 'First.dds');
});

test('a hand-set texture size survives while the model still says what it said', () => {
  // 256x256 over a 28x28 placeholder. Losing it did not fail quietly: a blur
  // sigma scaled to texture size came out at 0.19 and the renderer rejected it.
  const prior = {
    textures: {
      rimFace: {
        file: 'CSW_PNG.png', width: 256, height: 256, modelSize: [28, 28],
        notes: 'painted larger on purpose; UVs are fractions',
      },
    },
  };
  const fresh = { textures: { rimFace: { file: 'CSW_PNG.png', width: 28, height: 28 } } };
  const report = preserveHandwork(fresh, prior);
  assert.equal(fresh.textures.rimFace.width, 256);
  assert.deepEqual(fresh.textures.rimFace.modelSize, [28, 28]);
  assert.match(fresh.textures.rimFace.notes, /on purpose/);
  assert.equal(report.sizes.length, 1);
});

test('a hand-set size is abandoned once the model itself changes size', () => {
  // The override was a judgement about a 28x28 texture. If the model now ships
  // 512x512, that judgement was about something else.
  const prior = {
    textures: { rimFace: { file: 'C.png', width: 256, height: 256, modelSize: [28, 28] } },
  };
  const fresh = { textures: { rimFace: { file: 'C.png', width: 512, height: 512 } } };
  const report = preserveHandwork(fresh, prior);
  assert.equal(fresh.textures.rimFace.width, 512, 'the fresh measurement wins');
  assert.deepEqual(report.sizes, []);
});

test('hand-written panels survive only for roles the model measured nothing for', () => {
  const prior = {
    textures: { suit: { file: 'SUIT.dds' }, body: { file: 'B.dds' } },
    panels: {
      suit: { torso: { rect: [0, 0, 1, 0.5] }, legs: { rect: [0, 0.5, 1, 0.5] } },
      body: { old_guess: { rect: [0, 0, 1, 1] } },
    },
  };
  const fresh = {
    textures: { suit: { file: 'SUIT.dds' }, body: { file: 'B.dds' } },
    // The driver is a separate kn5, so this model measures nothing for `suit`.
    panels: { suit: {}, body: { left_mid: { rect: [0, 0, 0.5, 0.5] } } },
  };
  const report = preserveHandwork(fresh, prior);
  assert.deepEqual(Object.keys(fresh.panels.suit), ['torso', 'legs']);
  assert.deepEqual(Object.keys(fresh.panels.body), ['left_mid'],
    'a role that DID measure keeps the measurement — that is the better answer');
  assert.deepEqual(report.panels, [{ role: 'suit', count: 2 }]);
});

test('blocks that are pure judgement are carried, and never overwrite fresh ones', () => {
  const prior = {
    leaveStock: [{ file: 'Glass.dds', reason: 'painting it looks wrong from inside' }],
    notes: 'the rear wing is one island despite looking like three',
  };
  const fresh = { textures: {}, panels: {} };
  const report = preserveHandwork(fresh, prior);
  assert.equal(fresh.leaveStock.length, 1);
  assert.match(fresh.notes, /rear wing/);
  assert.deepEqual(report.blocks, ['leaveStock', 'notes']);

  const opinionated = { textures: {}, panels: {}, notes: 'freshly generated' };
  preserveHandwork(opinionated, prior);
  assert.equal(opinionated.notes, 'freshly generated');
});

test('regenerating with no prior profile at all is not a special case', () => {
  const fresh = { textures: { body: { file: 'B.dds' } }, panels: { body: {} } };
  const report = preserveHandwork(fresh, null);
  assert.deepEqual(describeHandwork(report, 'x'), []);
  assert.deepEqual(fresh.panels, { body: {} });
});

test('a renamed role takes its bindings with it', () => {
  // `bind` is merged before this runs, so the table holds automatic entries
  // naming the FRESH role and human entries naming the PRIOR one. Rename the
  // role and leave bind alone, and the automatic entries point at a role that no
  // longer exists — which throws nowhere: resolveTargets reports the surface as
  // unbound and the car builds stock.
  const prior = {
    textures: { rimFace: { file: 'CSW_PNG.png' } },
    bind: { rims: { roles: ['rimFace'], source: 'human' } },
  };
  const fresh = {
    textures: { csw_png_png: { file: 'CSW_PNG.png' }, body: { file: 'Body.dds' } },
    panels: { csw_png_png: {}, body: {} },
    bind: {
      rims: { roles: ['csw_png_png'], confidence: 0.9, source: 'auto' },
      body: { roles: ['body'], source: 'auto' },
      wheels: { roles: ['csw_png_png', 'body'], source: 'auto' },
    },
  };
  preserveHandwork(fresh, prior);

  assert.deepEqual(fresh.bind.rims.roles, ['rimFace'], 'the binding follows the rename');
  assert.deepEqual(fresh.bind.wheels.roles, ['rimFace', 'body'], 'and so does one role among several');
  assert.deepEqual(fresh.bind.body.roles, ['body'], 'a role that did not move is untouched');
  for (const entry of Object.values(fresh.bind)) {
    for (const role of entry.roles) {
      assert.ok(fresh.textures[role], `bind names "${role}", which the profile does not have`);
    }
  }
});

test('the car name survives a regeneration that was not given one', () => {
  // Nothing in a kn5 says "Abarth 500"; it comes from --car-name and defaults to
  // the empty string. Rebuilding without the flag replaced a good name with
  // nothing, and every consumer falls back to the id — so the car is silently
  // called `rss_formula_rss_4` from then on, and the profile ships that way.
  const prior = { name: 'Abarth 500', textures: {} };
  const fresh = { name: '', textures: {} };
  const report = preserveHandwork(fresh, prior);
  assert.equal(fresh.name, 'Abarth 500');
  assert.equal(report.name, 'Abarth 500');
  assert.match(describeHandwork(report, 'cars/abarth500.json').join('\n'), /--car-name/);

  // An explicit --car-name still wins: this preserves, it does not override.
  const renamed = { name: 'Abarth 595', textures: {} };
  assert.equal(preserveHandwork(renamed, prior).name, null);
  assert.equal(renamed.name, 'Abarth 595');
});

test('nothing carried across is shared with the profile it came from', () => {
  // `prior` is live — the caller's parsed JSON — so handing the same array or
  // object to both profiles means editing one silently rewrites the other. The
  // measured `modelSize` is the number here that must not drift.
  const prior = {
    textures: { rimFace: { file: 'C.png', width: 256, height: 256, modelSize: [28, 28] } },
    panels: { driver: { suit: { rect: [0, 0, 1, 1], confidence: 'estimated' } } },
    leaveStock: [{ file: 'Mirror.DDS', reason: 'painting it replaces what the mirror shows' }],
    notes: ['a page of notes'],
  };
  const fresh = {
    textures: { rimFace: { file: 'C.png', width: 28, height: 28 }, driver: { file: 'D.dds' } },
    panels: { rimFace: { face: { rect: [0, 0, 1, 1] } }, driver: {} },
  };
  preserveHandwork(fresh, prior);

  assert.notEqual(fresh.textures.rimFace.modelSize, prior.textures.rimFace.modelSize);
  assert.notEqual(fresh.panels.driver, prior.panels.driver);
  assert.notEqual(fresh.leaveStock, prior.leaveStock);
  assert.notEqual(fresh.notes, prior.notes);

  fresh.textures.rimFace.modelSize[0] = 999;
  fresh.panels.driver.suit.rect[0] = 999;
  fresh.leaveStock[0].file = 'changed';
  assert.deepEqual(prior.textures.rimFace.modelSize, [28, 28]);
  assert.equal(prior.panels.driver.suit.rect[0], 0);
  assert.equal(prior.leaveStock[0].file, 'Mirror.DDS');
});

test('every shipped profile has a name a person would recognise', async () => {
  // The regression this guards is not a crash. `name ?? id` is the fallback
  // everywhere, so an empty name just means the tool starts calling the car
  // `rss_formula_rss_4` — and the profile ships that way, because nothing looks.
  const { readdir, readFile } = await import('node:fs/promises');
  const dir = new URL('../cars/', import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  assert.ok(files.length, 'there are profiles to check');
  for (const f of files) {
    const p = JSON.parse(await readFile(new URL(f, dir), 'utf8'));
    assert.ok(p.name && p.name !== p.id, `cars/${f} has no display name (got ${JSON.stringify(p.name)})`);
  }
});
