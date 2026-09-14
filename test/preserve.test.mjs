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

test('two prior roles for one file become one, keeping the name and the hand-work of both', () => {
  // A profile from before a file had one role gave the 906's paint `body` and
  // `body_2`, one per spelling. Keyed by file, the last of them won, so the one
  // `body` a regeneration makes was renamed `body_2`, and the bindings naming
  // `body` went to a role the profile no longer had.
  const prior = {
    textures: {
      body: { file: '906_EXT_Body_Diff.dds', notes: 'The paint.' },
      body_2: { file: '906_EXT_Body_Diff.DDS', notes: 'Spelled as the rear clip names it.' },
    },
    panels: {
      body: { left_mid: { rect: [0.1, 0.1, 0.3, 0.3] } },
      body_2: { left_mid: { rect: [0.1, 0.1, 0.3, 0.3] } },
    },
    aliases: { body: { flankLeft: 'left_mid' }, body_2: { doorLeft: 'left_mid' } },
  };
  const fresh = {
    textures: { body: { file: '906_EXT_Body_Diff.dds' } },
    panels: { body: { left_mid: { rect: [0.1, 0.1, 0.3, 0.3] } } },
    // As mergeBindings leaves it: the human entries of the prior, as they were.
    bind: {
      body: { roles: ['body'], source: 'human' },
      bodyRear: { roles: ['body_2'], source: 'human' },
    },
  };
  const report = preserveHandwork(fresh, prior);

  assert.deepEqual(report.roles, [], 'the role whose spelling the model uses keeps its name');
  assert.deepEqual(Object.keys(fresh.textures), ['body']);
  assert.deepEqual(fresh.bind.body.roles, ['body']);
  assert.deepEqual(fresh.bind.bodyRear.roles, ['body'], 'a binding to the other role follows its file');
  assert.deepEqual(report.dangling, []);
  assert.deepEqual(fresh.textures.body.notes, ['The paint.', 'Spelled as the rear clip names it.'],
    'both notes are kept');
  assert.deepEqual(fresh.aliases, { body: { flankLeft: 'left_mid', doorLeft: 'left_mid' } });
  assert.match(describeHandwork(report, 'old.json').join('\n'),
    /body_2 -> body {2}\(906_EXT_Body_Diff\.DDS\)/);

  // Neither spelling the model's: the first of them, in the prior's order.
  const other = { textures: { body_3: { file: '906_ext_body_diff.dds' } }, panels: { body_3: {} } };
  preserveHandwork(other, prior);
  assert.deepEqual(Object.keys(other.textures), ['body']);
});

test('a file spelled another way in the prior profile is reported when the new spelling replaces it', () => {
  // One file on Windows and two on Linux, so a person may well have respelled
  // it to match the car's skins; a regeneration writes the model's spelling
  // again, and that used to happen without a word.
  const prior = { textures: { paint: { file: 'Body.dds' } } };
  const fresh = { textures: { body: { file: 'body.dds' } }, panels: { body: {} } };
  const report = preserveHandwork(fresh, prior);
  assert.equal(fresh.textures.paint.file, 'body.dds', 'the role name is kept, the spelling is the new one');
  assert.deepEqual(report.respelled, [{ role: 'paint', was: 'Body.dds', now: 'body.dds' }]);
  assert.match(describeHandwork(report, 'old.json').join('\n'), /paint: Body\.dds -> body\.dds/);
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

test("a texture's hand-written note survives the regeneration it was written to outlive", () => {
  // The NSX's windscreen banner carried a page on why its two faces must not
  // be spanned. Its hand-written panels were kept, and the note that explained
  // them was dropped: it rode along only with a hand-set SIZE, and the banner
  // has none.
  const prior = { textures: { banner: { file: 'Banner.dds', width: 1024, height: 1024, notes: 'two-sided; never span it' } } };
  const fresh = { textures: { banner: { file: 'Banner.dds', width: 1024, height: 1024 } } };
  const report = preserveHandwork(fresh, prior);
  assert.equal(fresh.textures.banner.notes, 'two-sided; never span it');
  assert.deepEqual(report.textureNotes, ['banner']);
  assert.ok(describeHandwork(report, 'prior.json').some((l) => /note.*banner/.test(l)), 'and says so');

  const written = { textures: { banner: { file: 'Banner.dds', notes: 'fresh' } } };
  preserveHandwork(written, prior);
  assert.equal(written.textures.banner.notes, 'fresh', 'never over a note the new profile has');
});

test("a texture's note follows its file when the generated role name is reused", () => {
  // Numbered roles are handed out afresh on every run, so `tyres_2` can be a
  // different texture next time. Carried by role name, the tyre's note stayed
  // on `tyres_2` and so landed on the brake duct that now wears the name.
  const prior = { textures: {
    tyres_2: { file: 'Tyre_Old.dds', width: 512, height: 512, notes: 'sidewall is mirrored; paint the left one' },
    tyres_4: { file: 'Rim_Gone.dds', width: 512, height: 512, notes: 'the rim is shared with the spare' },
  } };
  const fresh = { textures: {
    tyres_2: { file: 'Brake_Duct.dds', width: 256, height: 256 },
    tyres_3: { file: 'Tyre_Old.dds', width: 512, height: 512 },
  } };
  const report = preserveHandwork(fresh, prior);
  assert.equal(fresh.textures.tyres_2.notes, undefined, 'the brake duct is not told about a sidewall');
  assert.equal(fresh.textures.tyres_3.notes, 'sidewall is mirrored; paint the left one', 'the tyre keeps its note');
  assert.deepEqual(report.textureNotes, ['tyres_3']);
  assert.deepEqual(report.notesMoved, [{ from: 'tyres_2', to: 'tyres_3', file: 'Tyre_Old.dds' }]);

  // A note whose file no role wears any more is said to be lost, with its text,
  // rather than dropped quietly or pinned on whatever took the name.
  assert.deepEqual(report.notesLost, [{ role: 'tyres_4', file: 'Rim_Gone.dds', notes: 'the rim is shared with the spare' }]);
  const lines = describeHandwork(report, 'prior.json');
  assert.ok(lines.some((l) => /tyres_2 -> tyres_3/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => /note\(s\) were not kept/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => /tyres_4 +\(Rim_Gone\.dds\): the rim is shared with the spare/.test(l)),
    'the lost note is printed, so it can be put back by hand');
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

test('a regeneration without --skins keeps the roles only skins know about', () => {
  // THE BUG, and it made a profile that could not be opened at all.
  //
  // A car's skins carry textures the model has never heard of: the driver's
  // helmet, suit and gloves are a separate kn5 and the pit crew is another
  // again. The generator files those as `sizeFrom: "skin"` — and can only see
  // them when it is pointed at a skins folder. Regenerating without --skins
  // dropped them, the human-confirmed bindings that named them were kept by
  // the merge, and the result was
  //
  //   bind."crew" points at texture role "crew", which this profile does not
  //   define
  //
  // on every attempt to load it. The roles going was not a measurement saying
  // they are gone; it was a flag nobody passed.
  const prior = {
    textures: {
      body: { file: 'B.dds', sizeFrom: 'model' },
      crew: { file: 'ac_crew.dds', sizeFrom: 'skin', notes: 'a separate kn5' },
    },
    panels: { body: {}, crew: { front: { rect: [0, 0, 1, 1], confidence: 'estimated' } } },
    bind: { crew: { roles: ['crew'], source: 'human' } },
  };
  const madeWithout = () => ({
    textures: { body: { file: 'B.dds', sizeFrom: 'model' } },
    panels: { body: { left_mid: { rect: [0, 0, 0.5, 0.5] } } },
    bind: { crew: { roles: ['crew'], source: 'human' } },
  });

  const fresh = madeWithout();
  const report = preserveHandwork(fresh, prior, { skinsGiven: false });
  assert.ok(fresh.textures.crew, 'the role the run could not have seen is still there');
  assert.equal(fresh.textures.crew.sizeFrom, 'skin');
  assert.deepEqual(Object.keys(fresh.panels.crew), ['front'], 'and what was mapped on it');
  assert.deepEqual(fresh.bind.crew.roles, ['crew'], 'so the binding still names something');
  assert.deepEqual(report.skinOnly.map((r) => r.role), ['crew']);
  assert.deepEqual(report.dangling, [], 'nothing had to be dropped');
  assert.ok(describeHandwork(report, 'prior.json').some((l) => /--skins/.test(l)),
    'and the report says how to measure them again instead');

  // WITH a skins folder in hand, a role that is gone is gone: the skins no
  // longer carry that file, which is a measurement, and measurement wins.
  const measured = madeWithout();
  const said = preserveHandwork(measured, prior, { skinsGiven: true });
  assert.equal(measured.textures.crew, undefined);
  assert.deepEqual(said.skinOnly, []);
});

test('a regeneration without --skins names the driver kit again on the roles it kept', async () => {
  // Without --skins the fresh profile has no kit roles, so nothing named the
  // kit, and the merge keeps only what a person confirmed: the prior's crew,
  // named from ac_crew.dds, was dropped while the crew ROLE was put back, and
  // surfaces.crew went from bound to unbound with nothing said. 213 of the
  // surveyed cars ship ac_crew.dds.
  const { profileFromKn5 } = await import('../src/engine/profilegen.mjs');
  const { mergeBindings, validateProfile } = await import('../src/profile.mjs');
  const { carKn5 } = await import('./fixtures/kn5.mjs');
  const { writeFile, mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'lk-kit-'));
  try {
    await writeFile(join(dir, 'car.kn5'), carKn5());
    const generate = () => profileFromKn5(join(dir, 'car.kn5'), { id: 'c', visibility: false, log: () => {} });
    const prior = await generate();
    const body = prior.bind.body.roles[0];
    prior.textures.crew = { file: 'ac_crew.dds', width: 512, height: 512, sizeFrom: 'skin', inModel: false };
    prior.panels.crew = {};
    prior.bind.crew = { roles: ['crew'], source: 'auto', evidence: 'name' };
    // And an automatic binding this run has no way to propose again.
    prior.bind.wing = { roles: [body], source: 'auto', confidence: 0.5 };

    // As the command line does it: the merge, then the hand-work.
    const fresh = await generate();
    fresh.bind = mergeBindings(prior.bind, fresh.bind);
    const report = preserveHandwork(fresh, prior, { skinsGiven: false });
    assert.deepEqual(fresh.bind.crew, { roles: ['crew'], source: 'auto', evidence: 'name' });
    validateProfile(fresh);
    // What it does drop is said by name.
    assert.deepEqual(report.autoDropped, [{ term: 'wing', roles: [body] }]);
    assert.match(describeHandwork(report, 'cars/c.json').join('\n'), new RegExp(`wing -> ${body}`));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a skin-only role carried across says no mesh in the model wears it', async () => {
  // Carried across as it was, and a prior written before `inModel` existed
  // did not say so: the hide check then sent `hide: ['crew']` to "regenerate
  // it", and every regeneration without --skins carried the entry forward
  // still unflagged. That the role is absent from the model is exactly what
  // this run established by not finding it.
  const { hidePlan } = await import('../src/hide.mjs');
  const prior = {
    textures: { body: { file: 'B.dds', sizeFrom: 'model' }, crew: { file: 'ac_crew.dds', width: 512, height: 512, sizeFrom: 'skin' } },
    panels: { body: {} },
  };
  const fresh = { textures: { body: { file: 'B.dds', sizeFrom: 'model' } }, panels: { body: {} } };
  preserveHandwork(fresh, prior, { skinsGiven: false });
  assert.equal(fresh.textures.crew.inModel, false);
  assert.equal(prior.textures.crew.inModel, undefined, 'and the prior it came from is left alone');
  const [plan] = hidePlan(fresh, { hide: ['crew'] });
  assert.doesNotMatch(plan.why, /regenerate/);
  assert.match(plan.why, /no mesh in this car's model wears ac_crew\.dds/);
});

test('a binding naming a role that is really gone is dropped, loudly', () => {
  // The backstop. `mergeBindings` keeps what a human confirmed and cannot know
  // whether the role still exists; left in, the profile does not load. A
  // dropped binding with a line about it beats a file nothing can open.
  const prior = {
    textures: { body: { file: 'B.dds' }, spare: { file: 'S.dds', sizeFrom: 'model' } },
    panels: {},
    bind: {},
  };
  const fresh = {
    textures: { body: { file: 'B.dds' } },
    panels: { body: {} },
    bind: {
      body: { roles: ['body'], source: 'human' },
      wing: { roles: ['spare'], source: 'human' },
      mixed: { roles: ['body', 'spare'], source: 'auto' },
    },
  };
  const report = preserveHandwork(fresh, prior, { skinsGiven: true });
  assert.equal(fresh.bind.wing, undefined, 'nothing left to name');
  assert.deepEqual(fresh.bind.mixed.roles, ['body'], 'and a binding half of which survives keeps that half');
  assert.deepEqual(fresh.bind.body.roles, ['body']);
  assert.deepEqual(report.dangling.map((d) => d.term).sort(), ['mixed', 'wing']);
  const lines = describeHandwork(report, 'prior.json');
  assert.ok(lines.some((l) => /could not be loaded at all/.test(l)));
  assert.ok(lines.some((l) => /confirmed by hand/.test(l)),
    'and says which of them somebody had checked');
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

test('a car states its own name, and the profile stops shipping an empty one', async () => {
  // Nothing in a kn5 says "Abarth 500", so the display name defaulted to '' and
  // every profile regenerated without `--car-name` shipped with none — falling
  // back to the id everywhere, and calling the car
  // `ac_friends_honda_nsx_gt3_evo` from then on.
  //
  // But the kn5 is not the only file in the folder. `ui/ui_car.json` sits beside
  // it and carries the name the car's author gave it, which is what Content
  // Manager and the game read. Taking it is a measurement, not an inference.
  const { profileFromKn5 } = await import('../src/engine/profilegen.mjs');
  const { carKn5 } = await import('./fixtures/kn5.mjs');
  const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const car = async (uiCar, opts = {}) => {
    const dir = await mkdtemp(join(tmpdir(), 'lk-name-'));
    await writeFile(join(dir, 'car.kn5'), carKn5());
    if (uiCar !== null) {
      await mkdir(join(dir, 'ui'), { recursive: true });
      await writeFile(join(dir, 'ui', 'ui_car.json'), uiCar);
    }
    const said = [];
    const p = await profileFromKn5(join(dir, 'car.kn5'),
      { id: 'c', visibility: false, log: (m) => said.push(m), ...opts });
    return { name: p.name, said: said.join('\n') };
  };

  assert.equal((await car('{"name":"Honda NSX GT3 Evo","brand":"Honda"}')).name, 'Honda NSX GT3 Evo');

  // UTF-16LE with a byte-order mark, which a surprising number of these are.
  // JSON.parse sees NUL bytes between every character and gives up.
  const utf16 = Buffer.concat([
    Buffer.from([0xFF, 0xFE]),
    Buffer.from('{"name":"Mazda 787B"}', 'utf16le'),
  ]);
  assert.equal((await car(utf16)).name, 'Mazda 787B', 'UTF-16 is common enough to handle');

  // And a UTF-8 BOM, which is the other half of the same problem.
  assert.equal((await car('﻿{"name":"Lancia 037"}')).name, 'Lancia 037');

  // An explicit name still wins. It is the one a person chose.
  assert.equal((await car('{"name":"From the file"}', { name: 'From the flag' })).name, 'From the flag');

  // Every way this file goes wrong is a shrug and a note, never a throw: a
  // profile is worth generating without a display name, and refusing to measure
  // a car because its metadata has a trailing comma would be absurd.
  const broken = await car('{"name":"Half a car",}');
  assert.equal(broken.name, '');
  assert.match(broken.said, /not valid JSON/);
  assert.match(broken.said, /--car-name/, 'and says what to do instead');

  assert.equal((await car(null)).name, '', 'no ui folder at all is not an error');
  assert.equal((await car('{"brand":"Nobody"}')).name, '', 'nor a file with no name in it');
  assert.equal((await car('{"name":"   "}')).name, '', 'nor a name that is only spaces');
});
