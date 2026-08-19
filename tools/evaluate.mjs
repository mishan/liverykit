// ---------------------------------------------------------------------------
// How good is the classifier, really?
//
// src/engine/classify.mjs ranks textures by measurement alone. This scores it
// against a HELD-OUT LABEL taken from filenames — the one signal the classifier
// never sees — on every fleet car whose filename is unambiguous.
//
// The label is imperfect and that is fine, as long as it is independent. Where
// the two disagree, look at the case: on the Evora GTE the classifier picks
// Carpaint_D, which all seven stock skins override and which is 80% visible,
// over a labelled Skin_soft that no skin overrides and that is 0.2% visible.
// The classifier is right there and the label is wrong.
//
//   node tools/survey.mjs cars --all --visibility --out fleet.json
//   node tools/evaluate.mjs fleet.json
//
// Run this after ANY change to the weights in classify.mjs. The number is the
// thing to defend; a refactor that quietly costs five points is a regression
// that no unit test will catch.
// ---------------------------------------------------------------------------

import { readFile } from 'node:fs/promises';
import { rank } from '../src/engine/classify.mjs';

// Deliberately conservative: only cars where the filename is unambiguous get a
// label, so a wrong label is rare even though the rule is crude.
const LOOKS_LIKE_BODY = /^(ext_)?(skin|body|livery|paint|carpaint)|(body|skin|livery|carpaint)(_|\d|\.dds$)|chassis.*_d\.dds$/i;
const DEFINITELY_NOT = /int_|interior|cockpit|_nm|_map|occlusion|_occ|glass|rim|tyre|tire|blur|damage|dirt|driver|crew|helmet|suit|glove|plate/i;

const path = process.argv[2] ?? 'fleet.json';
const fleet = JSON.parse(await readFile(path, 'utf8')).filter((r) => !r.error);

let hit = 0, miss = 0, unlabelled = 0, noVis = 0;
const wrong = [];

for (const car of fleet) {
  const labels = Object.values(car.roles).filter((t) =>
    LOOKS_LIKE_BODY.test(t.file) && !DEFINITELY_NOT.test(t.file) && t.cover > 0.03 && t.straddles);
  if (labels.length !== 1) { unlabelled++; continue; }

  const features = Object.entries(car.roles).map(([role, t]) => ({
    role, file: t.file, area: t.cover, straddles: t.straddles, box: t.box,
    skinFraction: car.skinCount ? t.skins / car.skinCount : 0,
    shaders: t.shaders,
    ...(typeof t.visible === 'number' ? { visible: t.visible } : {}),
  }));
  if (!features.some((f) => typeof f.visible === 'number')) noVis++;

  const top = rank(features, 'body')[0];
  if (top?.file === labels[0].file) hit++;
  else { miss++; wrong.push({ id: car.id, picked: top?.file ?? '(nothing)', label: labels[0].file }); }
}

const total = hit + miss;
console.log(`${fleet.length} cars in ${path}, ${total} with an unambiguous label ` +
  `(${unlabelled} skipped as ambiguous)`);
if (noVis) console.log(`${noVis} of the labelled cars have no visibility data — ` +
  `re-run the survey with --visibility for the real figure`);
console.log(`\n  body: ${hit}/${total} = ${total ? (100 * hit / total).toFixed(1) : 0}%\n`);

for (const w of wrong) console.log(`  disagreement  ${w.id.padEnd(34)} picked ${w.picked.padEnd(26)} label ${w.label}`);
if (wrong.length) console.log('\n  Check each one by hand before assuming the classifier is at fault.');
