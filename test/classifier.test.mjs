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
import { rank, explain, featuresFromRecord } from '../src/engine/classify.mjs';

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
});

test('a large, visible sheet with no islands does not become the body', async () => {
  // A canopy over the synthetic car, twice the body's area, unwelded so that
  // no island reaches the panel threshold. On area alone it wins.
  const { profileFromKn5 } = await import('../src/engine/profilegen.mjs');
  const { carKn5, vert } = await import('./fixtures/kn5.mjs');
  const { writeFile, mkdtemp } = await import('node:fs/promises');
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
});
