// ---------------------------------------------------------------------------
// Tiled materials and shifted sheets.
//
// What a profile says about how a texture's UVs use the image, and what the
// build does with artwork placed on a texture that tiles. The synthetic car
// gains a seat cushion wearing a second texture, so each case changes one
// thing — how many times the image repeats across the cushion, or which copy of
// the sheet it sits on — and every other number in the fixture stays put.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { carKn5, vert } from './fixtures/kn5.mjs';
import { profileFromKn5 } from '../src/engine/profilegen.mjs';
import { parseKn5Buffer, vertex } from '../src/engine/kn5.mjs';
import { safeWithin } from '../src/engine/visibility.mjs';
import { resolveTargets, expandRegions } from '../src/profile.mjs';
import { portability } from '../src/portability.mjs';
import { fitment } from '../src/fitment.mjs';
import { renderTexture } from '../src/render.mjs';
import { resolveTreatments } from '../src/registry.mjs';
import { isMissingNote } from '../src/build.mjs';
import '../src/index.mjs';   // registers the treatment packs

/**
 * A flat cushion inside the car, on its own texture. `repeat` is how many times
 * the image tiles across it; `shift` moves the whole unwrap by whole sheets.
 */
function cushion({ repeat = 1, shift = [0, 0], name = 'SEAT_CUSHION' }) {
  const N = 6;
  const verts = [];
  const indices = [];
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      const s = i / N, t = j / N;
      verts.push(vert(-0.3 + 0.6 * s, 0.5, -0.3 + 0.6 * t,
        shift[0] + 0.05 + 0.9 * s * repeat, shift[1] + 0.05 + 0.9 * t * repeat));
    }
  }
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const a = j * (N + 1) + i;
      indices.push(a, a + 1, a + N + 2, a, a + N + 2, a + N + 1);
    }
  }
  return { name, verts, indices, materialId: 1 };
}

async function profileWith(seat) {
  const dir = await mkdtemp(join(tmpdir(), 'liverykit-uv-'));
  try {
    const file = join(dir, 'car.kn5');
    await writeFile(file, carKn5({
      extraMeshes: [cushion(seat)],
      materials: [{ name: 'BodyMat' }, { name: 'SeatMat', slots: { txDiffuse: 'seat.dds' } }],
      extraTextures: [{ name: 'seat.dds', width: 64, height: 64 }],
    }));
    const lines = [];
    const profile = await profileFromKn5(file, { id: 'c', visibility: false, log: (s) => lines.push(s) });
    const roleOf = (f) => Object.entries(profile.textures).find(([, t]) => t.file === f)?.[0];
    return { profile, log: lines.join('\n'), seat: roleOf('seat.dds'), body: roleOf('body.dds') };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('a texture that repeats across its surface is called tiled, and the profile says so', async () => {
  const { profile, log, seat, body } = await profileWith({ repeat: 40 });
  assert.ok(seat, 'the cushion texture is in the profile');
  assert.equal(profile.textures[seat].uvLayout, 'tiled');
  assert.ok(profile.textures[seat].uvInside < 0.5, `inside ${profile.textures[seat].uvInside}`);
  assert.equal(profile.textures[body].uvLayout, 'unwrapped');
  assert.equal(profile.textures[body].uvInside, 1);
  assert.equal(profile.textures[body].uvTile, undefined, 'an unwrap where it belongs carries no offset');
  assert.match(log, /1 of 2 paintable textures are tiled materials; nothing on them can be placed/);
  // The body is the largest texture spanning the car and it is unwrapped, so
  // the line saying the car cannot wear a placed design must not appear.
  assert.doesNotMatch(log, /largest texture spanning the car/);
});

test('a texture partly unwrapped and partly repeating is mixed, and artwork is placed on it', async () => {
  // Three cushions mapped once and one repeating 40 times, all wearing the
  // seat texture, so three quarters of its surface is mapped once. `mixed`
  // lies between the two thresholds and, unlike `tiled`, refuses nothing; no
  // case landed in it before, so the thresholds could move and nothing fail.
  const dir = await mkdtemp(join(tmpdir(), 'liverykit-uv-'));
  try {
    const file = join(dir, 'car.kn5');
    await writeFile(file, carKn5({
      extraMeshes: [
        { ...cushion({ repeat: 1 }), name: 'SEAT_A' },
        { ...cushion({ repeat: 1 }), name: 'SEAT_B' },
        { ...cushion({ repeat: 1 }), name: 'SEAT_C' },
        { ...cushion({ repeat: 40 }), name: 'SEAT_TILED' },
      ],
      materials: [{ name: 'BodyMat' }, { name: 'SeatMat', slots: { txDiffuse: 'seat.dds' } }],
      extraTextures: [{ name: 'seat.dds', width: 64, height: 64 }],
    }));
    const profile = await profileFromKn5(file, { id: 'c', visibility: false, log: () => {} });
    const seat = Object.entries(profile.textures).find(([, t]) => t.file === 'seat.dds')?.[0];
    assert.equal(profile.textures[seat].uvLayout, 'mixed');
    const inside = profile.textures[seat].uvInside;
    assert.ok(inside >= 0.5 && inside < 0.9, `inside ${inside}`);
    const { regions, notes } = expandRegions(profile, seat, [{ treatment: 'fill', at: [0.1, 0.1, 0.3, 0.3] }]);
    assert.equal(regions.length, 1, 'a rectangle on a mixed texture is placed');
    assert.equal(notes.filter((n) => n.status === 'unplaceable').length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an unwrap shifted by a whole sheet is an unwrap, measured where a livery paints it', async () => {
  const { profile, log, seat } = await profileWith({ repeat: 1, shift: [0, -1] });
  assert.equal(profile.textures[seat].uvLayout, 'unwrapped',
    'wrap addressing draws a sheet at v = -1 exactly as one at v = 0');
  assert.deepEqual(profile.textures[seat].uvTile, [0, -1], 'the model\'s own offset is still recorded');
  assert.match(log, /1 texture\(s\) sit on other copies of the sheet \(seat\.dds at \[0, -1\]\); their islands are measured on the copy they sit on/);
  // This used to be zero: findIslands clamped the island into [0, 1], where it
  // collapsed and was dropped, and so did 13 cars' bodies.
  const panels = Object.values(profile.panels[seat] ?? {});
  assert.equal(panels.length, 1);
  panels[0].rect.forEach((x, k) => assert.ok(Math.abs(x - [0.05, 0.05, 0.9, 0.9][k]) < 1e-3,
    `rect ${JSON.stringify(panels[0].rect)} should be the cushion's own [0.05, 0.05, 0.9, 0.9]`));
});

test('an unwrap straddling a sheet boundary is an unwrap, not a tiled material', async () => {
  // Half of it above v = 0 and half below, as the S14 Zenki's livery is laid
  // out. Every island fits within a sheet, so the image is mapped once, and a
  // measure that asked how much sat on one copy of the sheet called it tiled
  // and refused placement on the car's real livery.
  const { profile, seat } = await profileWith({ repeat: 1, shift: [0, -0.5] });
  assert.equal(profile.textures[seat].uvLayout, 'unwrapped');
  assert.equal(profile.textures[seat].uvInside, 1);
});

test('an island is moved back onto the sheet only when it fits wholly on another copy', () => {
  const model = parseKn5Buffer(carKn5({
    extraMeshes: [
      cushion({ name: 'SHIFTED', shift: [0, -1] }),
      // Overhangs [0, 1] by 0.006, which an ordinary unwrap does; stays put.
      cushion({ name: 'OVERHANG', shift: [-0.056, 0] }),
      // A sliver hugging the sheet's right edge, u = 0.992 to 0.9965: on the
      // sheet, and stays there. The first version of the rule sent islands
      // like this one sheet the wrong way, where they collapsed.
      cushion({ name: 'RIGHT_EDGE', repeat: 0.005, shift: [0.942, 0] }),
      // Spans 36 sheets: a tiling material, with no one copy to move to.
      cushion({ name: 'TILING', repeat: 40 }),
      // Straddles v = 0, which the game wraps across the image's edge.
      cushion({ name: 'STRADDLE', shift: [0, -0.5] }),
    ],
    materials: [{ name: 'BodyMat' }, { name: 'SeatMat', slots: { txDiffuse: 'seat.dds' } }],
    extraTextures: [{ name: 'seat.dds' }],
  }));
  const first = (name) => vertex(model, model.meshes.find((m) => m.name === name), 0);
  const near = (a, b) => Math.abs(a - b) < 1e-6;

  assert.ok(near(first('SHIFTED').u, 0.05) && near(first('SHIFTED').v, 0.05),
    `moved from v = -0.95 to the sheet: ${JSON.stringify(first('SHIFTED'))}`);
  assert.ok(near(first('OVERHANG').u, -0.006), 'an overhang by a hair is not a shift');
  assert.ok(near(first('RIGHT_EDGE').u, 0.992) && model.meshes.find((m) => m.name === 'RIGHT_EDGE').uvShift === undefined,
    `an island at the sheet's far edge is on the sheet: ${JSON.stringify(first('RIGHT_EDGE'))}`);
  assert.ok(near(first('TILING').v, 0.05) && model.meshes.find((m) => m.name === 'TILING').uvShift === undefined);
  assert.ok(near(first('STRADDLE').v, -0.45), 'a straddler cannot move whole, so it does not move');
  assert.equal(model.meshes.find((m) => m.name === 'BODY_SHELL').uvShift, undefined,
    'a mesh with nothing to move reads exactly as stored');
});

test('an island that repeats across many sheets does not crowd the real panels out', async () => {
  // A strip on the body's own texture whose UVs run a thousand sheets wide, as
  // one does on the mp412c's chassis. Its UV area counted every repeat, and the
  // car's six face panels fell under the minimum share of the sheet beside it.
  const dir = await mkdtemp(join(tmpdir(), 'liverykit-uv-'));
  try {
    const file = join(dir, 'car.kn5');
    await writeFile(file, carKn5({ extraMeshes: [{ ...cushion({ name: 'STRIP', repeat: 1000 }), materialId: 0 }] }));
    const profile = await profileFromKn5(file, { id: 'c', visibility: false });
    const names = Object.keys(profile.panels.body ?? Object.values(profile.panels)[0]);
    for (const face of ['left_mid', 'right_mid']) assert.ok(names.includes(face), `${face} is kept: ${names}`);
    assert.ok(names.length >= 6, `the six faces are all still panels: ${names}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a readable area never reaches off its panel', () => {
  // The two real cases: the 458 GT2's rear glass overhangs the sheet at the
  // top, and the MX-5 Cup's belts left a degenerate area off it entirely. Both
  // profiles were refused by validateProfile.
  assert.deepEqual(safeWithin([0.6278, -0.0133, 0.2922, 0.239], [0.6278, 0, 0.2997, 0.2289]),
    [0.6278, 0, 0.2922, 0.2257]);
  assert.equal(safeWithin([-0.6216, 0.9981, 0, 0], [0, 0.7615, 1, 0.2366]), null);
  // And the Morgan's steering wheel, 0.0003 off the sheet: inside the rounding
  // slack of its panel, and still refused until it is clamped onto the sheet.
  assert.deepEqual(safeWithin([-0.0003, 0.0005, 0.999, 0.9689], [0, 0.0005, 0.9987, 0.999]),
    [0, 0.0005, 0.9987, 0.9689]);
  // And an area already on its panel is returned as it came, so no profile
  // whose islands sit on the sheet changes by a digit.
  const inside = [0.1, 0.2, 0.3, 0.4];
  assert.equal(safeWithin(inside, [0.1, 0.2, 0.30004, 0.4]), inside);
  // Including one that only rounding puts past its panel's edge, which the
  // Abarth's rims have: 0.3895 tall against a panel ending 0.0001 short of it.
  const rounded = [0.1, 0.2, 0.3002, 0.4];
  assert.equal(safeWithin(rounded, [0.1, 0.2, 0.3, 0.4]), rounded);
});

test('a panel with nothing readable on it is hidden, not readable all over', async () => {
  // A missing `safe` means the whole panel may be painted, so a safe area that
  // came back empty and was skipped said the opposite of what was measured.
  // Empty is empty whether it lies off the panel or on it.
  assert.equal(safeWithin([0.2, 0.5, 0, 0.1], [0, 0, 1, 1]), null, 'no width, on the panel');

  // A lip beside the car, unwrapped across u = 0. The part on the sheet is
  // folded under, facing the ground that no view comes from, so what can be
  // seen of the lip is the part on top, and all of that lies left of u = 0:
  // off the panel, which is the part of the island on the sheet. The MX-5
  // Cup's belts, in miniature.
  const N = 6;
  const verts = [];
  const indices = [];
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      verts.push(vert(1.2 + i / N, 0.75, -0.3 + 0.6 * j / N, 0.4 - 0.9 * i / N, 0.2 + 0.4 * j / N,
        i < N / 2 ? [0, -1, 0] : [0, 1, 0]));
    }
  }
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const a = j * (N + 1) + i;
      indices.push(a, a + 1, a + N + 2, a, a + N + 2, a + N + 1);
    }
  }
  const dir = await mkdtemp(join(tmpdir(), 'liverykit-uv-'));
  try {
    const file = join(dir, 'car.kn5');
    await writeFile(file, carKn5({
      extraMeshes: [{ name: 'PLATE', verts, indices, materialId: 1 }],
      materials: [{ name: 'BodyMat' }, { name: 'PlateMat', slots: { txDiffuse: 'plate.dds' } }],
      extraTextures: [{ name: 'plate.dds' }],
    }));
    const lines = [];
    const profile = await profileFromKn5(file, { id: 'c', visibility: true, log: (s) => lines.push(s) });
    const role = Object.entries(profile.textures).find(([, t]) => t.file === 'plate.dds')[0];
    const [[name, plate]] = Object.entries(profile.panels[role]);
    assert.equal(plate.safe, undefined);
    assert.equal(plate.hidden, true, `nothing readable is on it: ${JSON.stringify(plate)}`);
    assert.equal(plate.visible, 0, 'and it is not tagged as a place to read');
    assert.ok(!plate.tags?.includes('visible'), `tags ${plate.tags}`);
    assert.match(lines.join('\n'), new RegExp(`- ${name}: .*no readable area of that lies on its panel — treated as hidden`));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a car unwrapped one sheet down profiles exactly like the same car unshifted', async () => {
  // Every consumer of UVs — islands, seams, outlines, safe areas, wheels, the
  // renderers — reads them through vertex(), so the whole profile is the check
  // that none of them still sees the island somewhere else.
  const dir = await mkdtemp(join(tmpdir(), 'liverykit-uv-'));
  try {
    const profileOf = async (uvShift) => {
      const file = join(dir, `car${uvShift[1]}.kn5`);
      await writeFile(file, carKn5({ uvShift }));
      return profileFromKn5(file, { id: 'c', visibility: true });
    };
    const [home, away] = [await profileOf([0, 0]), await profileOf([0, -1])];
    assert.ok(Object.keys(home.panels.body ?? Object.values(home.panels)[0]).length >= 6);
    // One allowance. A seam's `here` is a polyline started from its point
    // farthest from the middle, and on a straight seam both ends tie, so which
    // comes first is float noise — the shifted car stores v - 2, which rounds
    // differently in float32. Its only reader walks the segments, which are the
    // same either way round, so the ends are put in a fixed order before
    // comparing. Everything else must match exactly.
    const settle = (panels) => JSON.parse(JSON.stringify(panels), (k, v) =>
      k === 'here' && Array.isArray(v) && JSON.stringify(v[0]) > JSON.stringify(v[v.length - 1])
        ? [...v].reverse() : v);
    assert.deepEqual(settle(away.panels), settle(home.panels));
    assert.deepEqual(away.bind, home.bind);
    const { uvTile, ...rest } = Object.values(away.textures)[0];
    assert.deepEqual(uvTile, [0, -1]);
    assert.deepEqual(rest, Object.values(home.textures)[0]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an island just past an edge of the sheet is moved onto it, and a shifted body keeps its flange', () => {
  // Slivers lying wholly in the slack past an edge used to count as on the
  // sheet, because the sheet was asked first; findIslands then clamped them to
  // nothing and dropped them. And a body one sheet down whose flange strip is
  // an island of its own, along v = -0.006 to 0, was split: the body moved onto
  // the sheet and the strip stayed where it was, a whole sheet away from it.
  const sliver = 0.005 / 0.9;
  const model = parseKn5Buffer(carKn5({
    extraMeshes: [
      cushion({ name: 'PAST_RIGHT', repeat: sliver, shift: [0.953, 0] }),     // u = 1.003 to 1.008
      cushion({ name: 'PAST_LEFT', repeat: sliver, shift: [-0.058, 0] }),     // u = -0.008 to -0.003
      cushion({ name: 'BODY', repeat: 0.944 / 0.9, shift: [0, -1] }),         // v = -0.95 to -0.006
      cushion({ name: 'FLANGE', repeat: 0.006 / 0.9, shift: [0.2, -0.056] }), // v = -0.006 to 0
    ],
    materials: [{ name: 'BodyMat' }, { name: 'SeatMat', slots: { txDiffuse: 'seat.dds' } }],
    extraTextures: [{ name: 'seat.dds' }],
  }));
  const first = (name) => vertex(model, model.meshes.find((m) => m.name === name), 0);
  const near = (a, b) => Math.abs(a - b) < 1e-5;

  assert.ok(near(first('PAST_RIGHT').u, 0.003), `past the right edge: ${JSON.stringify(first('PAST_RIGHT'))}`);
  assert.ok(near(first('PAST_LEFT').u, 0.992), `past the left edge: ${JSON.stringify(first('PAST_LEFT'))}`);
  assert.ok(near(first('BODY').v, 0.05), `the body is on the sheet: ${JSON.stringify(first('BODY'))}`);
  assert.ok(near(first('FLANGE').v, 0.994), `and its flange beside it: ${JSON.stringify(first('FLANGE'))}`);
});

test('every island straddling a sheet boundary is counted, including one no panel is left of', async () => {
  // The count was taken over the panels. An island straddling a boundary on
  // another copy of the sheet — the 180SX's, 60 sheets down — clamps to
  // nothing in findIslands and never becomes one, so the log said nothing of
  // exactly the islands that were lost.
  const dir = await mkdtemp(join(tmpdir(), 'liverykit-uv-'));
  try {
    const file = join(dir, 'car.kn5');
    await writeFile(file, carKn5({
      extraMeshes: [
        cushion({ name: 'ON_SHEET', shift: [0, -0.5] }),     // v = -0.45 to 0.45
        cushion({ name: 'OFF_SHEET', shift: [0, -1.5] }),    // v = -1.45 to -0.55
        // A bolt head across v = 0, too few vertices to be measured as an
        // island anywhere, so not one to count: a brushed-metal sheet on the
        // S14 Zenki has 1,728 of them, and they buried the islands that matter.
        {
          name: 'BOLT', materialId: 1, indices: [0, 1, 2, 0, 2, 3],
          verts: [vert(0, 0.5, 0, 0.3, -0.05), vert(0.1, 0.5, 0, 0.4, -0.05), vert(0.1, 0.5, 0.1, 0.4, 0.05), vert(0, 0.5, 0.1, 0.3, 0.05)],
        },
      ],
      materials: [{ name: 'BodyMat' }, { name: 'SeatMat', slots: { txDiffuse: 'seat.dds' } }],
      extraTextures: [{ name: 'seat.dds', width: 64, height: 64 }],
    }));
    const lines = [];
    await profileFromKn5(file, { id: 'c', visibility: false, log: (s) => lines.push(s) });
    assert.match(lines.join('\n'), /! 2 island\(s\) straddle a sheet boundary \(2 on seat\.dds\)/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('placement on a tiled material is skipped and reported, and a fill still paints', async () => {
  const { profile, seat } = await profileWith({ repeat: 40 });
  const notes = [];
  const layers = renderTexture({
    profile,
    role: seat,
    regions: [
      { treatment: 'fill', color: 'accent' },
      { treatment: 'fill', at: [0, 0, 0.5, 0.5], color: 'hot' },
      { id: 'badge', treatment: 'text', tags: ['centre'], text: '7', color: 'hot' },
    ],
    background: 'base',
    treatments: resolveTreatments(['core']),
    palette: { base: '#112233', accent: '#00ff00', hot: '#ff0000' },
    rng: () => 0.5,
    font: 'DejaVu Sans',
    tokens: {},
    regionNotes: notes,
  });
  assert.match(layers.base, /#00ff00/i, 'the fill with no placement covers the sheet');
  assert.doesNotMatch(layers.base, /#ff0000/i, 'nothing placed was drawn');

  assert.equal(notes.length, 2);
  for (const n of notes) {
    assert.equal(n.status, 'unplaceable');
    assert.match(n.text, /seat\.dds is a tiled material/);
    assert.equal(isMissingNote(n), true, 'a skipped region was not painted, and the report must say so');
  }
  assert.match(notes.find((n) => n.id === 'badge').text, /tags \[centre\]/);
});

test('a surface bound to a tiled material is painted with a caveat, and the report names what cannot land', async () => {
  const { profile, seat } = await profileWith({ repeat: 40 });
  profile.bind = { ...profile.bind, interior: { roles: [seat], source: 'human' } };
  const design = {
    name: 'L',
    surfaces: {
      interior: {
        regions: [
          { treatment: 'halftone', color: 'accent' },
          { id: 'number', treatment: 'text', tags: ['centre'], text: '7' },
        ],
      },
    },
  };

  const { targets, notes } = resolveTargets(profile, design);
  assert.equal(targets.length, 1, 'the surface is still painted');
  const caveat = notes.find((n) => n.status === 'tiled');
  assert.ok(caveat, 'and the report says it is a tiled material');
  assert.equal(caveat.term, 'surfaces.interior');
  assert.equal(isMissingNote(caveat), false, 'painted, so not under "asked for and not painted"');

  // The editor's "On another car" panel reads this, before anyone builds.
  const report = portability(design, profile);
  const number = report.regions.find((r) => r.id === 'number');
  assert.equal(number.status, 'unplaceable');
  assert.match(number.why, /seat\.dds/);
  assert.notEqual(report.regions.find((r) => r.id !== 'number').status, 'unplaceable',
    'an even pattern is not placement');
});

test('a malformed region is refused on a tiled material exactly as on any other', () => {
  // The tiled refusal ran first, so `tags: []` and its kind came back as
  // skipped artwork on a tiled car and threw on every other: the same design
  // was `unplaceable` in one portability report and `invalid` in the next.
  const car = (uvLayout) => ({
    id: 't', textures: { body: { file: 'b.dds', width: 64, height: 64, ...(uvLayout ? { uvLayout } : {}) } },
    panels: { body: { a: { rect: [0, 0, 0.5, 0.5], tags: ['left'] } } },
    bind: { body: { roles: ['body'], source: 'human' } },
  });
  const bad = [
    [{ tags: [] }, /non-empty array of tag names/],
    [{ tags: 'left' }, /non-empty array of tag names/],
    [{ panel: 'a', tags: ['left'] }, /both "panel" and "tags"/],
    [{ tags: ['left'], limit: 0 }, /whole number of panels/],
  ];
  for (const [fields, why] of bad) {
    for (const layout of [null, 'tiled']) {
      const regions = [{ id: 'x', treatment: 'fill', ...fields }];
      assert.throws(() => expandRegions(car(layout), 'body', regions), why, `${JSON.stringify(fields)} on ${layout ?? 'an unwrap'}`);
      const surface = portability({ name: 'd', surfaces: { body: { regions } } }, car(layout)).surfaces
        .find((s) => s.from === 'surfaces.body');
      assert.equal(surface.status, 'invalid', `${JSON.stringify(fields)} on ${layout ?? 'an unwrap'}`);
    }
  }
  // A well-formed placement is still refused, and only then.
  const { notes } = expandRegions(car('tiled'), 'body', [{ id: 'x', treatment: 'fill', tags: ['left'] }]);
  assert.deepEqual(notes.map((n) => n.status), ['unplaceable']);
});

test('placed artwork a tiled material refuses is a fitment finding, like a selection that missed', async () => {
  // The build skips it and says so, and the portability report lists it; the
  // placement check dropped the note and called the design clean, which is
  // what /api/fitment and check_fitment then told whoever asked.
  const { profile, seat } = await profileWith({ repeat: 40 });
  profile.bind = { ...profile.bind, interior: { roles: [seat], source: 'human' } };
  const design = {
    name: 'L', packs: ['core'],
    surfaces: {
      interior: {
        regions: [
          { treatment: 'halftone', color: 'accent' },
          { id: 'number', treatment: 'text', tags: ['centre'], text: '7' },
        ],
      },
    },
  };
  const un = fitment(design, profile).findings.filter((f) => f.kind === 'unmatched');
  assert.deepEqual(un.map((f) => [f.ids[0], f.severity]), [['number', 'high']], JSON.stringify(un));
  assert.match(un[0].why, /seat\.dds is a tiled material/);
});
