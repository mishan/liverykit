// ---------------------------------------------------------------------------
// The classifier's accuracy, defended on every commit.
//
// src/engine/classify.mjs picks the bodywork by measurement. How well it does
// that is the number the whole binding layer rests on, and it is not something a
// unit test can express: a refactor that quietly costs five points would pass
// every other test in this repo.
//
// So this scores it against a HELD-OUT LABEL — the cars whose filename is
// unambiguous, which the classifier never sees — over a fixture of measurements
// taken from a survey of all 252 cars in the fleet.
//
// THE FIXTURE CONTAINS NO GAME ASSETS. It is areas, bounding boxes, shader
// names, filenames and skin-override counts: numbers about cars, of the same
// kind as the profiles already in cars/. Regenerate it with
//
//   node tools/survey.mjs <carsDir> --all --visibility --out fleet.json
//   node tools/pack-fleet.mjs fleet.json
//
// Nobody without a game install can rebuild it, which is exactly why it is
// committed.
//
// The floor is deliberately a few points below the measured figure. Pinning the
// exact number would make every legitimate improvement a test failure; pinning
// nothing would let it rot.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { rank, explain, propose, proposeAll, proposalNotes, featuresFromRecord, textureFeatures } from '../src/engine/classify.mjs';
import { parseKn5Buffer } from '../src/engine/kn5.mjs';
import { buildKn5, carKn5, vert } from './fixtures/kn5.mjs';

const LOOKS_LIKE_BODY = /^(ext_)?(skin|body|livery|paint|carpaint)|(body|skin|livery|carpaint)(_|\d|\.dds$)|chassis.*_d\.dds$/i;
const DEFINITELY_NOT = /int_|interior|cockpit|_nm|_map|occlusion|_occ|glass|rim|tyre|tire|blur|damage|dirt|driver|crew|helmet|suit|glove|plate/i;

// Measured at 192/195 when the fixture was last taken, on 2026-09-13, with the
// island count as an input. Two of the disagreements are the label being wrong
// rather than the classifier (the Evora GTE and its carbon variant; see
// docs/naming.md). The third is tando_buddies_180sx, whose label names a LOD
// texture with no islands while the pick is the paint nine skins override.
const FLOOR = 0.95;

async function fleet() {
  const raw = gunzipSync(await readFile(new URL('./fixtures/fleet-features.json.gz', import.meta.url)));
  const doc = JSON.parse(raw.toString('utf8'));
  return doc.cars.map((car) => ({
    id: car.id,
    features: featuresFromRecord(car, { shaderNames: doc.shaders }),
  }));
}

// Held-out labels for the two scorers measured in step 5, copied from
// tools/evaluate.mjs as the body's are. Right is the top pick landing on a
// labelled texture: a rim face and its blur twin are both rightly "the rims".
const PICK_LABELS = {
  rims: { looks: /rim|wheel|cerchi|felg/i, not: /_nm|normal|_map|glow|_ao|steer|logo|tyre|tire|bolt|nut|disc|brake|cal|lod|detail/i },
  interior: { looks: /interior|cockpit/i, not: /_nm|normal|_map|occ|_ao|glass|blur|belt|seat|steer|lod|decal|wind|net|pedal|stich|stitch|detail|gauge|display|screen|dash/i },
};

// Measured on 2026-09-13: rims 225/246, interior 124/168. The floors sit a
// few points under, so a change that costs the fleet a handful of cars fails
// here rather than surfacing months later as unpainted wheels.
test('rims and interior land on a labelled texture on most of the fleet', async () => {
  const cars = await fleet();
  for (const [term, floor, least] of [['rims', 0.9, 230], ['interior', 0.7, 160]]) {
    const { looks, not } = PICK_LABELS[term];
    let n = 0, right = 0;
    for (const car of cars) {
      const labels = car.features.filter((f) => f.area > 0 && looks.test(f.file) && !not.test(f.file)).map((f) => f.file);
      if (!labels.length) continue;
      n++;
      const p = proposeAll(car.features)[term];
      if (p && p.roles.some((r) => labels.includes(car.features.find((f) => f.role === r).file))) right++;
    }
    assert.ok(n >= least, `${term}: only ${n} labelled cars; the fixture may have lost its wheel or cockpit evidence`);
    assert.ok(right / n >= floor, `${term}: ${right}/${n} = ${(right / n).toFixed(3)}, below ${floor}`);
  }

  // What the figure cannot see: a binding holding a texture a label calls
  // another term's. The interior held the body skin on three open-wheelers
  // before a role was left to one term; the one left is civic_body_in.dds,
  // the Civic's cabin sheet, which only the body label calls a body.
  const other = {
    body: (f) => LOOKS_LIKE_BODY.test(f.file) && !DEFINITELY_NOT.test(f.file) && f.area > 0.03 && f.straddles,
    tyres: (f) => /tyre|tire|tread/i.test(f.file) && !/_nm|normal|_map|blur|glow|_ao|rim/i.test(f.file),
    brakes: (f) => /disc|disk|rotor/i.test(f.file) && !/_nm|normal|_map|blur|glow|cal/i.test(f.file),
    ...Object.fromEntries(Object.entries(PICK_LABELS).map(([t, l]) => [t, (f) => l.looks.test(f.file) && !l.not.test(f.file)])),
  };
  const over = [];
  for (const car of cars) {
    for (const term of ['rims', 'interior']) {
      for (const r of proposeAll(car.features)[term]?.roles ?? []) {
        const f = car.features.find((x) => x.role === r);
        const as = Object.keys(other).filter((t) => other[t](f));
        if (as.length && !as.includes(term)) over.push(`${car.id}: ${term} bound ${f.file}, labelled ${as.join(', ')}`);
      }
    }
  }
  assert.deepEqual(over, ['btcc_honda_civic: interior bound civic_body_in.dds, labelled body']);
});

test('the rims and interior scorers leave out what their evidence rules out', () => {
  const f = (o) => ({ role: o.file, area: 0.05, box: null, straddles: true, skinFraction: 0, shaders: ['ksPerPixel'], islands: 8, wheelIslands: 0, sidewalls: 0, instances: 1, ...o });
  const rim = f({ file: 'rim.dds', wheelIslands: 8, instances: 4 });
  const tyre = f({ file: 'tyre.dds', wheelIslands: 8, instances: 4, shaders: ['ksTyres'], area: 0.2 });
  const bodyNearWheel = f({ file: 'body.dds', wheelIslands: 2, area: 0.4, visible: 0.8, cockpit: 0.1 });
  const cabin = f({ file: 'cabin.dds', area: 0.15, visible: 0.03, cockpit: 0.25 });
  assert.deepEqual(rank([rim, tyre, bodyNearWheel], 'rims').map((x) => x.file), ['rim.dds'],
    'a tyre has its own shader and a body is mostly not at a wheel');
  assert.equal(rank([cabin, bodyNearWheel], 'interior')[0].file, 'cabin.dds', 'seen from the seat, not the track');
  // No cockpit measurement, no interior: a zero is not "unseen from the seat".
  assert.deepEqual(rank([{ ...cabin, cockpit: undefined }], 'interior'), []);
  assert.match(explain([{ ...cabin, cockpit: undefined }], 'interior'), /Cockpit visibility was not measured/);
  assert.match(explain([rim], 'rims'), /whl  inst/);
});

test('the wheel and cockpit evidence is counted from the profile\'s panels', () => {
  // What the rims and interior scorers read. Four wheels drawn from one rim
  // face are four islands on one rectangle, so `instances` is the largest
  // group of panels sharing a rect, not a count of panels.
  const model = parseKn5Buffer(carKn5());
  const shared = [0.1, 0.1, 0.2, 0.2];
  const panels = {
    body: {
      a: { rect: shared, wheel: { part: 'sidewall' }, visibleFromCockpit: 0.4 },
      b: { rect: shared, wheel: { part: 'tread' }, visibleFromCockpit: 0.2 },
      c: { rect: shared, wheel: { part: 'sidewall' } },
      d: { rect: [0.6, 0.6, 0.1, 0.1] },
    },
  };
  const [f] = textureFeatures(model, { roles: { body: 'body.dds' }, panels });
  assert.deepEqual([f.islands, f.wheelIslands, f.sidewalls, f.instances], [4, 3, 2, 3]);
  assert.equal(f.cockpit, 0.3, 'the mean over the panels that measured it');

  // Nothing measured from the cockpit says nothing, rather than a zero that
  // would read as "unseen from the seat".
  const [bare] = textureFeatures(model, { roles: { body: 'body.dds' }, panels: { body: { d: { rect: [0, 0, 1, 1] } } } });
  assert.equal(bare.cockpit, undefined);
  assert.deepEqual([bare.wheelIslands, bare.instances], [0, 1]);
  // And without a profile, no island evidence at all, as before.
  const [none] = textureFeatures(model, { roles: { body: 'body.dds' } });
  assert.equal(none.wheelIslands, undefined);
});

function labelled(cars) {
  const out = [];
  for (const car of cars) {
    const hits = car.features.filter((f) =>
      LOOKS_LIKE_BODY.test(f.file) && !DEFINITELY_NOT.test(f.file) && f.area > 0.03 && f.straddles);
    if (hits.length === 1) out.push({ ...car, label: hits[0].file });
  }
  return out;
}

test('the classifier finds the bodywork on the fleet', async () => {
  const cars = labelled(await fleet());
  assert.ok(cars.length > 150, `only ${cars.length} labelled cars in the fixture`);

  const wrong = [];
  for (const car of cars) {
    const top = rank(car.features, 'body')[0];
    if (top?.file !== car.label) wrong.push(`${car.id}: picked ${top?.file} not ${car.label}`);
  }
  const accuracy = (cars.length - wrong.length) / cars.length;
  assert.ok(
    accuracy >= FLOOR,
    `body accuracy fell to ${(100 * accuracy).toFixed(1)}% over ${cars.length} cars ` +
    `(floor ${100 * FLOOR}%).\n  ${wrong.join('\n  ')}\n` +
    `  If this is an intended trade, re-measure with tools/evaluate.mjs and move the floor deliberately.`,
  );
});

test('visibility is worth what the design claims it is worth', async () => {
  // The argument for spending four seconds a car on ray casting is that it takes
  // the classifier from about 90% to about 98%. If that stops being true the
  // cost is no longer justified, and the docs are wrong.
  const cars = labelled(await fleet());
  const score = (withVis) => {
    let hit = 0;
    for (const car of cars) {
      const features = withVis
        ? car.features
        : car.features.map(({ visible, ...rest }) => rest);
      if (rank(features, 'body')[0]?.file === car.label) hit++;
    }
    return hit / cars.length;
  };
  const without = score(false);
  const with_ = score(true);
  assert.ok(without < with_ - 0.04,
    `visibility gained only ${((with_ - without) * 100).toFixed(1)} points ` +
    `(${(100 * without).toFixed(1)}% -> ${(100 * with_).toFixed(1)}%)`);
});

test('a texture with no islands is not a body candidate', () => {
  const base = { straddles: true, skinFraction: 0, shaders: ['ksPerPixel'], box: [0, 1, 0, 1, 0, 1], visible: 0.8 };
  const swatch = { ...base, role: 'black', file: 'black.dds', area: 0.5, islands: 0 };
  const paint = { ...base, role: 'skin', file: 'skin.dds', area: 0.3, islands: 40, uvLayout: 'unwrapped' };
  assert.deepEqual(rank([swatch, paint], 'body').map((f) => f.file), ['skin.dds'], 'excluded, not merely outranked');
  // Without the field — a caller with no profile — nothing is excluded on
  // their account, and the larger sheet wins as it always did.
  const { islands, ...bare } = swatch;
  assert.equal(rank([bare, paint], 'body')[0].file, 'black.dds');
  // A tiled layout is not a reason: the measure reads some real bodies as
  // tiled, the S14 Zenki's livery among them.
  const livery = { ...base, role: 'livery', file: 'livery.dds', area: 0.5, islands: 42, uvLayout: 'tiled' };
  assert.equal(rank([livery, paint], 'body')[0].file, 'livery.dds');
  // And --explain says so in words, beside the table it is missing from.
  assert.match(explain([swatch, paint], 'body'), /not a candidate: black\.dds — no islands/);
});

test('the mp412c finds its body once a sheet with no islands cannot be it', async () => {
  // It bound `black.dds`, a flat swatch with no islands that is also tiled,
  // over SKIN_00, on a car whose interior has 90 panels.
  const car = (await fleet()).find((c) => c.id === 'mclaren_mp412c_gt3');
  assert.equal(rank(car.features, 'body')[0].file, 'SKIN_00.dds');
  // The rule itself, and not only the pick: on today's fixture SKIN_00 would
  // outscore the swatch on visibility alone, so asserting the winner passed
  // with the exclusion removed.
  assert.ok(!rank(car.features, 'body').some((f) => f.file === 'black.dds'), 'excluded, not merely outranked');
  assert.match(explain(car.features, 'body'), /not a candidate: black\.dds — no islands/);
});

test('a large, visible sheet with no islands does not become the body', async () => {
  // A canopy over the synthetic car, twice the body's area, unwelded so that
  // no island reaches the panel threshold. On area alone it wins.
  const { profileFromKn5 } = await import('../src/engine/profilegen.mjs');
  const { carKn5, vert } = await import('./fixtures/kn5.mjs');
  const { writeFile, mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const N = 8, verts = [], indices = [];
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const [x0, x1, z0, z1] = [-4 + i, -3 + i, -4 + j, -3 + j];
      const [u0, u1, v0, v1] = [i / N, (i + 1) / N, j / N, (j + 1) / N];
      const at = verts.length;
      verts.push(vert(x0, 2, z0, u0, v0), vert(x1, 2, z0, u1, v0), vert(x1, 2, z1, u1, v1),
        vert(x0, 2, z0, u0, v0), vert(x1, 2, z1, u1, v1), vert(x0, 2, z1, u0, v1));
      indices.push(at, at + 1, at + 2, at + 3, at + 4, at + 5);
    }
  }
  const dir = await mkdtemp(join(tmpdir(), 'lk-canopy-'));
  try {
    const file = join(dir, 'car.kn5');
    await writeFile(file, carKn5({
      extraMeshes: [{ name: 'CANOPY', verts, indices, materialId: 1 }],
      materials: [{ name: 'BodyMat' }, { name: 'CanopyMat', slots: { txDiffuse: 'canopy.dds' } }],
      extraTextures: [{ name: 'canopy.dds' }],
    }));
    const profile = await profileFromKn5(file, { id: 'c', visibility: false });
    const canopy = Object.entries(profile.textures).find(([, t]) => t.file === 'canopy.dds')[0];
    assert.equal(Object.keys(profile.panels[canopy] ?? {}).length, 0, 'the canopy has no islands');
    assert.equal(profile.textures[profile.bind.body.roles[0]].file, 'body.dds');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('tyres bind every texture only the tyre shader draws, and leave a shared swatch out', () => {
  // A tread and a sidewall on their own tyre materials, and a white swatch the
  // tyre material shares with the body. Picking the biggest bound the tread
  // alone on 11 fleet cars, leaving the sidewall, where the lettering goes,
  // unpainted; and the Morgan's biggest was the shared swatch.
  const f = (role, area, shaders) => ({ role, file: `${role}.dds`, area, shaders, straddles: true, skinFraction: 0, box: null });
  const tread = f('tread', 0.03, ['ksTyres']);
  const side = f('side', 0.02, ['ksTyres']);
  const white = f('white', 0.04, ['ksTyres', 'ksPerPixel']);
  const p = propose([white, tread, side], 'tyres');
  assert.deepEqual(p.roles, ['tread', 'side']);
  assert.equal(p.confidence, 1, 'nothing the tyre shader alone draws is left out');
  assert.match(explain([white, tread, side], 'tyres'), /proposal: tread, side/);
  // With nothing but the shared swatch, it is still the tyres — as it was.
  assert.deepEqual(propose([white], 'tyres').roles, ['white']);
  // And the body is still one texture.
  assert.equal(propose([tread, side, { ...white, shaders: ['ksPerPixel'] }], 'body').roles.length, 1);
});

test('--explain names what the tyres bind, and the swatch it left out and why', () => {
  // A white both ksTyres and ksPerPixel draw, a little larger than a tread
  // only ksTyres draws. propose binds the tread at 1, and --explain printed
  // the white at its margin over the tread, then warned that the two were
  // close: a proposal nobody would get, and a warning about it.
  const f = (role, area, shaders) => ({ role, file: `${role}.dds`, area, shaders, straddles: true, skinFraction: 0, box: null });
  const white = f('white', 0.035, ['ksTyres', 'ksPerPixel']);
  const tread = f('tread', 0.03, ['ksTyres']);
  assert.deepEqual(propose([white, tread], 'tyres').roles, ['tread']);
  // With a body on the car, which would otherwise be the one to take the white.
  const text = explain([f('skin', 0.5, ['ksPerPixel']), white, tread], 'tyres');
  assert.match(text, /proposal: tread  \(confidence 1: every texture only ksTyres draws\)/);
  assert.doesNotMatch(text, /proposal: white/);
  assert.match(text, /left out: white \(white\.dds\) — ksPerPixel draws it too/);
  assert.doesNotMatch(text, /top two are close/);
  // Where the margin is what decided, the warning still stands.
  const plain = (x) => ({ ...x, shaders: ['ksPerPixel'] });
  assert.match(explain([plain(white), plain(tread)], 'body'), /proposal: white  \(confidence 0\.14, margin over runner-up\)[\s\S]*top two are close/);
});

test('a generated profile binds every texture the tyres proposal holds', async () => {
  // propose returning both is not the same as the profile keeping both: the
  // generator copies the proposal into `bind`, and writing only its first
  // role there passed every test, since none of them read a multi-role
  // proposal back out of a generated profile.
  const { profileFromKn5 } = await import('../src/engine/profilegen.mjs');
  const { carKn5, vert } = await import('./fixtures/kn5.mjs');
  const { writeFile, mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const quad = (name, x, materialId) => ({
    name, materialId, indices: [0, 1, 2, 0, 2, 3],
    verts: [vert(x, 0, 0, 0, 0), vert(x, 0, 0.6, 1, 0), vert(x, 0.6, 0.6, 1, 1), vert(x, 0.6, 0, 0, 1)],
  });
  const dir = await mkdtemp(join(tmpdir(), 'lk-tyres-'));
  try {
    const file = join(dir, 'car.kn5');
    await writeFile(file, carKn5({
      extraMeshes: [quad('TYRE_TREAD', 0.8, 1), quad('TYRE_SIDE', 0.85, 2)],
      materials: [
        { name: 'BodyMat' },
        { name: 'Tread', shader: 'ksTyres', slots: { txDiffuse: 'tread.dds' } },
        { name: 'Side', shader: 'ksTyres', slots: { txDiffuse: 'side.dds' } },
      ],
      extraTextures: [{ name: 'tread.dds' }, { name: 'side.dds' }],
    }));
    const profile = await profileFromKn5(file, { id: 'c', visibility: false, log: () => {} });
    const files = (profile.bind.tyres?.roles ?? []).map((r) => profile.textures[r].file).sort();
    assert.deepEqual(files, ['side.dds', 'tread.dds']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('tyres and brakes bind every texture their names say they are, across the fleet', async () => {
  // The same held-out label as the body's, for the terms a car's own shader
  // names: filenames that plainly say tyre or tread, disc or rotor. These terms
  // bind every texture only their shader draws, so a car may have several
  // labelled textures, and the binding is right when it holds all of them.
  // Measured at 182/184 for tyres and 193/202 for brakes; seven of the brake
  // misses are discs no ksBrakeDisc material draws, which no binding rule that
  // reads the shader can reach.
  const cars = await fleet();
  const score = (term, looks, not) => {
    let right = 0, n = 0;
    for (const car of cars) {
      const labels = car.features.filter((f) => f.area > 0 && looks.test(f.file) && !not.test(f.file)).map((f) => f.file);
      if (!labels.length) continue;
      n++;
      const bound = new Set((proposeAll(car.features)[term]?.roles ?? [])
        .map((r) => car.features.find((f) => f.role === r).file));
      if (labels.every((l) => bound.has(l))) right++;
    }
    return { right, n };
  };
  const tyres = score('tyres', /tyre|tire|tread/i, /_nm|normal|_map|blur|glow|_ao|rim/i);
  const brakes = score('brakes', /disc|disk|rotor/i, /_nm|normal|_map|blur|glow|cal/i);
  assert.ok(tyres.n > 150 && tyres.right / tyres.n >= 0.97, `tyres ${tyres.right}/${tyres.n}`);
  assert.ok(brakes.n > 150 && brakes.right / brakes.n >= 0.93, `brakes ${brakes.right}/${brakes.n}`);

  // What they bind that a label calls something else, which "binds every
  // labelled texture" cannot see. The Civic's author drew its disc with
  // ksTyres, and nothing measured tells that disc from a tyre, so it is
  // known and listed here; a new one is a change to look at.
  const is = {
    body: (f) => LOOKS_LIKE_BODY.test(f.file) && !DEFINITELY_NOT.test(f.file) && f.area > 0.03 && f.straddles,
    tyres: (f) => /tyre|tire|tread/i.test(f.file) && !/_nm|normal|_map|blur|glow|_ao|rim/i.test(f.file),
    brakes: (f) => /disc|disk|rotor/i.test(f.file) && !/_nm|normal|_map|blur|glow|cal/i.test(f.file),
  };
  const over = [];
  for (const car of cars) {
    for (const term of ['tyres', 'brakes']) {
      for (const r of proposeAll(car.features)[term]?.roles ?? []) {
        const f = car.features.find((x) => x.role === r);
        const as = Object.keys(is).filter((t) => is[t](f));
        if (as.length && !as.includes(term)) over.push(`${car.id}: ${term} bound ${f.file}, labelled ${as.join(', ')}`);
      }
    }
  }
  assert.deepEqual(over, ['jtc_honda_civic_eg_gra: tyres bound disk_d_1.dds, labelled brakes']);
});

test('a role one term binds is not a candidate for a later one', () => {
  // An open cockpit sees a lot of the body, and the body is large, so on
  // three open-wheelers the interior claimed the body's skin as well, and a
  // design painting both threw at build time: both would write one file. And
  // rt_bacmono's wheel sheet, drawn by its tyre and its disc materials, was
  // both its tyres and its brakes.
  const f = (o) => ({ role: o.file.replace('.dds', ''), area: 0.05, box: [0, 1, 0, 1, 0, 1], straddles: true, skinFraction: 0, shaders: ['ksPerPixel'], islands: 8, wheelIslands: 0, sidewalls: 0, instances: 1, ...o });
  const skin = f({ file: 'skin.dds', area: 0.5, visible: 0.7, cockpit: 0.3, shaders: ['ksPerPixelMultiMap_damage_dirt'] });
  const cabin = f({ file: 'cabin.dds', visible: 0.1, cockpit: 0.5 });
  const wheel = f({ file: 'wheel.dds', shaders: ['ksTyres', 'ksBrakeDisc'], islands: 0 });
  const disc = f({ file: 'disc.dds', area: 0.01, shaders: ['ksBrakeDisc', 'ksPerPixel'], islands: 0 });
  const all = [skin, cabin, wheel, disc];
  assert.equal(propose(all, 'interior').role, 'skin', 'on its own evidence the interior takes the skin');
  assert.equal(propose(all, 'brakes').role, 'wheel', 'and the brakes the wheel sheet');

  const bind = proposeAll(all);
  assert.deepEqual(Object.fromEntries(Object.entries(bind).map(([t, b]) => [t, b.roles])),
    { body: ['skin'], tyres: ['wheel'], brakes: ['disc'], interior: ['cabin'] });
  assert.equal(bind.interior.confidence, 1, 'the margin is over what is left, and nothing is');
  const text = explain(all, 'interior');
  assert.match(text, /taken: skin \(skin\.dds\) is bound to body/);
  assert.match(text, /proposal: cabin  /);
});

test('no role is bound to two terms anywhere in the fleet', async () => {
  for (const car of await fleet()) {
    const held = new Map();
    for (const [term, b] of Object.entries(proposeAll(car.features))) {
      for (const r of b.roles) {
        assert.ok(!held.has(r), `${car.id}: ${r} is bound to both ${held.get(r)} and ${term}`);
        held.set(r, term);
      }
    }
  }
});

test('rims say the wheels were not measured, rather than that the car has none', async () => {
  // A model with no WHEEL_xx node gets no island marked as a wheel part, and
  // counting those gave every texture zero wheel islands: the measurement
  // the rims are scored on, read as having been taken and found nothing.
  const panels = { rim: { a: { rect: [0.1, 0.1, 0.8, 0.8] } } };
  const [unmeasured] = textureFeatures(parseKn5Buffer(buildKn5()), { roles: { rim: 'body.dds' }, panels });
  assert.equal(unmeasured.wheelIslands, undefined, 'not a count of zero');
  const text = explain([unmeasured], 'rims');
  assert.match(text, /Wheel positions were not measured/);
  assert.doesNotMatch(text, /may genuinely lack/);
  // The synthetic car has its wheels, so there none at a wheel is a zero.
  const [measured] = textureFeatures(parseKn5Buffer(carKn5()), { roles: { rim: 'body.dds' }, panels });
  assert.equal(measured.wheelIslands, 0);
  assert.match(explain([measured], 'rims'), /may genuinely lack/);

  // And the generator says so as it proposes, not only --explain.
  const { profileFromKn5 } = await import('../src/engine/profilegen.mjs');
  const { writeFile, mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const N = 8, verts = [], indices = [];
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) verts.push(vert(i / N - 0.5, 0.5, j / N - 0.5, 0.05 + 0.9 * i / N, 0.05 + 0.9 * j / N));
  }
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const a = j * (N + 1) + i;
      indices.push(a, a + 1, a + N + 2, a, a + N + 2, a + N + 1);
    }
  }
  const dir = await mkdtemp(join(tmpdir(), 'lk-nowheels-'));
  try {
    await writeFile(join(dir, 'car.kn5'), buildKn5({ bodyMesh: { name: 'PANEL', verts, indices } }));
    const said = [];
    const profile = await profileFromKn5(join(dir, 'car.kn5'), { id: 'c', visibility: false, log: (l) => said.push(l) });
    assert.ok(Object.keys(Object.values(profile.panels)[0]).length, 'the panel is measured');
    assert.equal(profile.bind.rims, undefined);
    assert.ok(said.some((l) => /rims were not proposed/.test(l) && /wheel/i.test(l)), said.join('\n'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a texture the cockpit pass did not measure is left out of the interior by name', () => {
  // Excluded by a stated reason, and not by NaN: area times an undefined
  // cockpit is NaN, and a ranking that drops NaN would drop it just the same
  // with the rule gone, which is how the rule came to have no test.
  const f = (o) => ({ role: o.file, area: 0.05, box: null, straddles: true, skinFraction: 0, shaders: ['ksPerPixel'], islands: 8, wheelIslands: 0, sidewalls: 0, instances: 1, visible: 0.1, ...o });
  const cabin = f({ file: 'cabin.dds', cockpit: 0.3 });
  const tub = f({ file: 'tub.dds', area: 0.3 });
  assert.deepEqual(rank([cabin, tub], 'interior').map((x) => x.file), ['cabin.dds']);
  assert.match(explain([cabin, tub], 'interior'), /not a candidate: tub\.dds — cockpit visibility was not measured/);
});

test('a rim and the motion-blur rim it is swapped with are bound together', () => {
  // AC swaps each wheel's rim for a blurred copy at speed. Binding only the
  // top pick bound the blur rim alone on 33 fleet cars, the Abarth's
  // Rim500_BLUR.dds among them, so the wheel wore the stock rim standing
  // still and the livery only at speed.
  const f = (o) => ({ role: o.file.replace(/\.\w+$/, ''), area: 0.03, box: null, straddles: true, skinFraction: 0, shaders: ['ksPerPixel'], islands: 16, wheelIslands: 16, sidewalls: 8, instances: 4, blur: false, ...o });
  const rim = f({ file: 'rim.dds', area: 0.029 });
  const blur = f({ file: 'rim_blur.dds', blur: true, twins: ['RIM.dds'] });
  const ao = f({ file: 'rim_ao.dds', area: 0.01 });
  // A body for --explain, which proposes the terms before the rims first.
  const skin = f({ file: 'skin.dds', area: 0.5, wheelIslands: 0 });
  const p = propose([rim, blur, ao], 'rims');
  assert.deepEqual(p.roles, ['rim_blur', 'rim'], 'the pick, then the rim it is swapped with');
  assert.equal(p.confidence, 0.67, 'the margin is over the best left unbound, not over its own twin');
  assert.deepEqual(propose([{ ...rim, area: 0.04 }, blur, ao], 'rims').roles, ['rim', 'rim_blur']);
  assert.match(explain([skin, rim, blur, ao], 'rims'), /proposal: rim_blur, rim  \(a rim and the motion-blur rim it is swapped with/);
  // The model names the twin, so an overlay beside a blur rim is not taken for it.
  assert.deepEqual(propose([{ ...blur, twins: ['other.dds'] }, ao], 'rims').roles, ['rim_blur']);

  // A survey record has no mesh names, so the filename says which is the blur
  // rim, and it is paired with the best plain candidate.
  const [recorded] = featuresFromRecord({ skinCount: 0, roles: { rims_2: {
    file: 'Rim500_BLUR.dds', cover: 0.03, straddles: true, skins: 0, shaders: ['ksPerPixel'], box: null,
    panels: 16, wheelIslands: 16, sidewalls: 8, instances: 4,
  } } });
  assert.deepEqual([recorded.blur, recorded.twins], [true, undefined]);
  assert.deepEqual(propose([rim, { ...blur, twins: undefined }, ao], 'rims').roles, ['rim_blur', 'rim']);

  // A twin that cannot be bound is said, not dropped: the NSX's blur rim has
  // no islands.
  const bare = { ...blur, islands: 0, wheelIslands: 0, instances: 0 };
  const alone = propose([rim, bare, ao], 'rims');
  assert.deepEqual(alone.roles, ['rim']);
  const said = /rim_blur\.dds, the motion-blur twin of rim\.dds, is not bound: it has no islands/;
  assert.match(alone.notes.join('\n'), said);
  assert.match(explain([skin, rim, bare, ao], 'rims'), said);
});

test('the model says which rim a motion-blur rim is swapped with', () => {
  // By the node above each, as AC swaps them: see blurTwins.
  const tri = (name, materialId) => ({
    name, materialId, indices: [0, 1, 2],
    verts: [vert(0.8, 0.1, 1.2, 0.1, 0.1), vert(0.8, 0.5, 1.2, 0.9, 0.1), vert(0.8, 0.5, 1.6, 0.9, 0.9)],
  });
  const model = parseKn5Buffer(carKn5({
    wrapped: [
      { name: 'RIM_LF', meshes: [tri('EXT_RIM_LF', 1)] },
      { name: 'RIM_BLUR_LF', meshes: [tri('EXT_RIM_BLUR_LF', 2)] },
    ],
    materials: [{ name: 'BodyMat' }, { name: 'Rim', slots: { txDiffuse: 'rim.dds' } }, { name: 'RimBlur', slots: { txDiffuse: 'rim_blur.dds' } }],
    extraTextures: [{ name: 'rim.dds' }, { name: 'rim_blur.dds' }],
  }));
  const by = Object.fromEntries(textureFeatures(model, { roles: { body: 'body.dds', rim: 'rim.dds', rimBlur: 'rim_blur.dds' } })
    .map((x) => [x.role, x]));
  assert.equal(by.rim.blur, false);
  assert.equal(by.rimBlur.blur, true);
  assert.deepEqual(by.rimBlur.twins, ['rim.dds']);
});

test('no blur rim is bound without the rim it is swapped with, across the fleet', async () => {
  // Or, on the two cars where no plain rim is a candidate at all, without
  // the generator saying so by name.
  const unsaid = [];
  for (const car of await fleet()) {
    const bound = (proposeAll(car.features).rims?.roles ?? []).map((r) => car.features.find((f) => f.role === r));
    if (!bound.some((f) => f.blur) || bound.some((f) => !f.blur)) continue;
    const said = proposalNotes(car.features).some((n) => bound.some((f) => n.includes(f.file)));
    if (!said) unsaid.push(`${car.id}: ${bound.map((f) => f.file).join(', ')}`);
  }
  assert.deepEqual(unsaid, []);
});
