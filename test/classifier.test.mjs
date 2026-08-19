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
// taken from a 235-car fleet sweep.
//
// THE FIXTURE CONTAINS NO GAME ASSETS. It is areas, bounding boxes, shader
// names, filenames and skin-override counts: numbers about cars, of the same
// kind as the profiles already in cars/. Regenerate it with
//
//   node tools/survey.mjs <carsDir> --all --visibility --out fleet.json
//
// and the packing script in the commit that introduced it. Nobody without a game
// install can rebuild it, which is exactly why it is committed.
//
// The floor is deliberately a few points below the measured figure. Pinning the
// exact number would make every legitimate improvement a test failure; pinning
// nothing would let it rot.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { rank } from '../src/engine/classify.mjs';

const LOOKS_LIKE_BODY = /^(ext_)?(skin|body|livery|paint|carpaint)|(body|skin|livery|carpaint)(_|\d|\.dds$)|chassis.*_d\.dds$/i;
const DEFINITELY_NOT = /int_|interior|cockpit|_nm|_map|occlusion|_occ|glass|rim|tyre|tire|blur|damage|dirt|driver|crew|helmet|suit|glove|plate/i;

// Measured at 172/175 when the fixture was taken, of which two disagreements are
// the label being wrong rather than the classifier. See docs/naming.md.
const FLOOR = 0.95;

async function fleet() {
  const raw = gunzipSync(await readFile(new URL('./fixtures/fleet-features.json.gz', import.meta.url)));
  const doc = JSON.parse(raw.toString('utf8'));
  return doc.cars.map((car) => ({
    id: car.id,
    features: Object.entries(car.roles).map(([role, t]) => ({
      role, file: t.file, area: t.cover, straddles: t.straddles, box: t.box,
      skinFraction: car.skinCount ? t.skins / car.skinCount : 0,
      shaders: t.sh.map((i) => doc.shaders[i]),
      ...(typeof t.visible === 'number' ? { visible: t.visible } : {}),
    })),
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
