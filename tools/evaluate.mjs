// ---------------------------------------------------------------------------
// How good is the classifier, really?
//
// src/engine/classify.mjs ranks textures by measurement alone. This scores it
// against a HELD-OUT LABEL taken from filenames — the one signal the classifier
// never sees — on every fleet car whose filename is unambiguous.
//
// The label is imperfect and that is fine, as long as it is independent. Where
// the two disagree, look at the case: on the Evora GTE the classifier picks
// Carpaint_D, which every stock skin overrides and which is 79% visible, over
// a labelled Skin_soft that no skin overrides and that is 0.1% visible. The
// classifier is right there and the label is wrong.
//
// It scores `tyres` and `brakes` the same way, and prints the body's
// CONFIDENCE TABLE: the proposals it was least sure of, and the highest
// confidence at which one was wrong. That table is where the portability
// plan's step 3 looked for a floor below which an automatic binding should not
// be painted, and found none — every body proposal under 0.2 was right — so it
// is printed here to be read again after any change, not taken on trust.
//
//   node tools/survey.mjs cars --all --visibility --out fleet.json
//   node tools/evaluate.mjs fleet.json
//
// Run this after ANY change to the weights in classify.mjs. The number is the
// thing to defend; a refactor that quietly costs five points is a regression
// that no unit test will catch.
// ---------------------------------------------------------------------------

import { readFile } from 'node:fs/promises';
import { rank, propose, featuresFromRecord } from '../src/engine/classify.mjs';

// Deliberately conservative: only cars where the filename is unambiguous get a
// label, so a wrong label is rare even though the rule is crude.
const LOOKS_LIKE_BODY = /^(ext_)?(skin|body|livery|paint|carpaint)|(body|skin|livery|carpaint)(_|\d|\.dds$)|chassis.*_d\.dds$/i;
const DEFINITELY_NOT = /int_|interior|cockpit|_nm|_map|occlusion|_occ|glass|rim|tyre|tire|blur|damage|dirt|driver|crew|helmet|suit|glove|plate/i;

// The terms a car's own shader names, labelled by names that plainly say what
// they are. These terms bind every texture only their shader draws, so a car
// may have several labelled textures, and the proposal is right when it binds
// every one of them. A caliper is not a disc.
const TERM_LABELS = {
  tyres: { looks: /tyre|tire|tread/i, not: /_nm|normal|_map|blur|glow|_ao|rim/i },
  brakes: { looks: /disc|disk|rotor/i, not: /_nm|normal|_map|blur|glow|cal/i },
};

// "Binds every labelled texture" cannot see a binding that holds too much:
// the Civic's tyres bind its brake disc, which the author drew with ksTyres,
// and still count as right. Nothing measured tells that disc from a tyre, so
// it is reported below rather than excluded. Only the body's and these terms'
// labels are read.
const labelledAs = (f) => [
  ...(LOOKS_LIKE_BODY.test(f.file) && !DEFINITELY_NOT.test(f.file) && f.area > 0.03 && f.straddles ? ['body'] : []),
  ...Object.entries(TERM_LABELS).filter(([, l]) => l.looks.test(f.file) && !l.not.test(f.file)).map(([t]) => t),
];

const path = process.argv[2] ?? 'fleet.json';
const fleet = JSON.parse(await readFile(path, 'utf8')).filter((r) => !r.error);

let hit = 0, miss = 0, unlabelled = 0, noVis = 0;
const wrong = [];
const table = [];

for (const car of fleet) {
  const labels = Object.values(car.roles).filter((t) =>
    LOOKS_LIKE_BODY.test(t.file) && !DEFINITELY_NOT.test(t.file) && t.cover > 0.03 && t.straddles);
  if (labels.length !== 1) { unlabelled++; continue; }

  const features = featuresFromRecord(car);
  if (!features.some((f) => typeof f.visible === 'number')) noVis++;

  const top = rank(features, 'body')[0];
  const right = top?.file === labels[0].file;
  if (right) hit++;
  else { miss++; wrong.push({ id: car.id, picked: top?.file ?? '(nothing)', label: labels[0].file }); }
  if (top) table.push({ id: car.id, confidence: top.confidence, right });
}

const total = hit + miss;
console.log(`${fleet.length} cars in ${path}, ${total} with an unambiguous label ` +
  `(${unlabelled} skipped as ambiguous)`);
if (noVis) console.log(`${noVis} of the labelled cars have no visibility data — ` +
  `re-run the survey with --visibility for the real figure`);
console.log(`\n  body: ${hit}/${total} = ${total ? (100 * hit / total).toFixed(1) : 0}%\n`);

for (const w of wrong) console.log(`  disagreement  ${w.id.padEnd(34)} picked ${w.picked.padEnd(26)} label ${w.label}`);
if (wrong.length) console.log('\n  Check each one by hand before assuming the classifier is at fault.');

// The confidence table. Confidence is the winner's margin over the runner-up,
// not a probability, so a close call that is right and a close call that is
// wrong look the same here until the label says which.
table.sort((a, b) => a.confidence - b.confidence);
console.log('\n  body proposals the classifier was least sure of:');
for (const r of table.slice(0, 8)) console.log(`    ${r.confidence.toFixed(2)}  ${r.id}${r.right ? '' : '   (disagrees with the label)'}`);
const wrongAt = table.filter((r) => !r.right).map((r) => r.confidence);
console.log(`  highest confidence at which the label disagreed: ${wrongAt.length ? Math.max(...wrongAt) : 'none'}`);
for (const floor of [0.05, 0.1, 0.2]) {
  const under = table.filter((r) => r.confidence < floor);
  console.log(`  a floor at ${floor} would refuse ${under.length}: ${under.filter((r) => r.right).length} the label agrees with, ` +
    `${under.filter((r) => !r.right).length} it does not`);
}

for (const [term, { looks, not }] of Object.entries(TERM_LABELS)) {
  let right = 0, n = 0;
  const misses = [];
  const over = [];
  for (const car of fleet) {
    const features = featuresFromRecord(car);
    const p = propose(features, term);
    const boundTo = (p?.roles ?? []).map((r) => features.find((f) => f.role === r));
    for (const f of boundTo) {
      const as = labelledAs(f);
      if (as.length && !as.includes(term)) over.push({ id: car.id, file: f.file, as: as.join(', ') });
    }
    const labels = features.filter((f) => f.area > 0 && looks.test(f.file) && !not.test(f.file)).map((f) => f.file);
    if (!labels.length) continue;
    n++;
    const bound = new Set(boundTo.map((f) => f.file));
    if (labels.every((l) => bound.has(l))) right++;
    else misses.push({ id: car.id, bound: [...bound].join(', ') || '(nothing)', label: labels.join(', ') });
  }
  console.log(`\n  ${term}: ${right}/${n} bind every labelled texture`);
  for (const m of misses.slice(0, 8)) console.log(`    ${m.id.padEnd(34)} bound ${m.bound.padEnd(40)} label ${m.label}`);
  if (misses.length > 8) console.log(`    and ${misses.length - 8} more`);
  console.log(`  ${term}: ${over.length} bound texture(s) labelled as another term, painted as ${term} ` +
    '(not counted against the figure above)');
  for (const o of over.slice(0, 8)) console.log(`    ${o.id.padEnd(34)} ${o.file}  (labelled ${o.as})`);
  if (over.length > 8) console.log(`    and ${over.length - 8} more`);
}
