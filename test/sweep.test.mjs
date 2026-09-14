// ---------------------------------------------------------------------------
// The portability sweep, on what CI has: the shipped profiles and no models.
//
// tools/sweep.mjs exists so the numbers in docs/backlog.md can be re-run
// rather than quoted. These tests hold the parts of it that decide what those
// numbers mean — which tag emptied a selection, when a rule counts as missed,
// and that the fixture's reader and packer agree with the survey — and run the
// whole thing over cars/, which needs no game content.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nearMiss } from '../src/profile.mjs';
import { featuresFromRecord } from '../src/engine/classify.mjs';
import { bestKn5, bestOf, everyNth, summarise } from '../tools/fleet.mjs';
import { buildKn5, carKn5 } from './fixtures/kn5.mjs';

const run = promisify(execFile);
const tool = (name) => fileURLToPath(new URL(`../tools/${name}`, import.meta.url));

async function inTmp(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'liverykit-sweep-'));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

const onBody = (panels) => ({ id: 't', panels: { body: panels } });
const at = (x) => [x, 0, 0.1, 0.1];

test('a near miss names the tag that emptied the selection', () => {
  // Left panels exist and visible ones exist; no panel is both. Dropping
  // `left` recovers three panels and dropping `visible` two, so `left` is the
  // requirement that cost the most.
  const p = onBody({
    a: { rect: at(0), tags: ['left'] },
    b: { rect: at(0.2), tags: ['left'] },
    c: { rect: at(0.4), tags: ['right', 'visible'] },
    d: { rect: at(0.6), tags: ['right', 'visible'] },
    e: { rect: at(0.8), tags: ['centre', 'visible'] },
  });
  assert.deepEqual(nearMiss(p, 'body', ['left', 'visible']), {
    each: { left: 2, visible: 3 },
    without: { left: 3, visible: 2 },
    blocking: 'left',
    tied: [],
    panels: 5,
  });
});

test('a near miss says so when no single tag is to blame', () => {
  const p = onBody({
    a: { rect: at(0), tags: ['left'] },
    b: { rect: at(0.2), tags: ['mid'] },
    c: { rect: at(0.4), tags: ['visible'] },
  });
  const near = nearMiss(p, 'body', ['left', 'mid', 'visible']);
  assert.equal(near.blocking, null);
  assert.deepEqual(near.tied, [], 'nothing recovers anything, so nothing is tied');
});

test('a near miss names every tag tied for the most, not the first in the list', () => {
  // Dropping `mid` and dropping `visible` each recover one panel. Keeping the
  // first in list order recorded this car as "blocked by mid", and the sweep's
  // conclusion — mid or visible — was read off exactly that field.
  const p = onBody({
    a: { rect: at(0), tags: ['left', 'mid', 'upper'] },
    b: { rect: at(0.2), tags: ['left', 'upper', 'visible'] },
  });
  const near = nearMiss(p, 'body', ['left', 'mid', 'upper', 'visible']);
  assert.deepEqual(near.without, { left: 0, mid: 1, upper: 0, visible: 1 });
  assert.equal(near.blocking, null, 'neither is to blame over the other');
  assert.deepEqual(near.tied, ['mid', 'visible']);
});

test('a near miss on a texture with no panels says there are none', () => {
  // Every count is zero there, which read as two tags emptying the selection
  // at once, when the selection never had anything to choose from.
  const near = nearMiss(onBody({}), 'body', ['left', 'visible']);
  assert.equal(near.panels, 0);
  assert.equal(near.blocking, null);
});

test('a near miss counts instances of one rectangle once, as the selection does', () => {
  const p = onBody({
    a: { rect: at(0), tags: ['shared', 'lower'] },
    b: { rect: at(0), tags: ['shared', 'lower'] },
  });
  assert.deepEqual(nearMiss(p, 'body', ['shared', 'visible']).each, { shared: 1, visible: 0 });
});

test('every nth car starts with the first, so the sample is stable', () => {
  assert.deepEqual(everyNth(['a', 'b', 'c', 'd', 'e'], 2), ['a', 'c', 'e']);
});

const sweep = (...args) => run(process.execPath, [tool('sweep.mjs'), ...args]);

test('the summary refuses a sweep it cannot find, rather than printing an empty table', () => inTmp(async (dir) => {
  // A mistyped --out printed nothing and exited 0, which reads as a sweep of
  // no cars rather than as no sweep at all.
  const missing = join(dir, 'swep.json');
  await assert.rejects(sweep('neon-grid-any', '--out', missing, '--summary'), /no sweep at .*swep\.json/);
  const empty = join(dir, 'empty.json');
  await writeFile(empty, '[]');
  await assert.rejects(sweep('neon-grid-any', '--out', empty, '--summary'), /holds no sweep records/);
  await writeFile(empty, '{}');
  await assert.rejects(sweep('neon-grid-any', '--out', empty, '--summary'), /not a sweep/);
  await assert.rejects(sweep('neon-grid-any', '--out', empty, '--summary', '--fresh'), /--summary.*--fresh/);
}));

test('the sweep refuses a --limit it cannot read, rather than sweeping a different number of cars', () => inTmp(async (dir) => {
  // `nope` became no limit at all, and -1 swept every car but the last.
  const out = join(dir, 'sweep.json');
  for (const bad of ['nope', '-1', '0', '1.5']) {
    await assert.rejects(sweep('neon-grid-any', '--out', out, '--limit', bad), /--limit wants a whole number, 1 or more/, bad);
  }
  // And a valued flag with nothing after it is not quietly its default.
  await assert.rejects(sweep('neon-grid-any', '--out', out, '--limit'), /--limit wants a value/);
  await assert.rejects(sweep('neon-grid-any', '--limit', '1', '--out'), /--out wants a value/);
  const { stdout } = await sweep('neon-grid-any', '--out', out, '--limit', '1');
  assert.match(stdout, /3 planned, 0 already done, 1 this pass/);
}));

const repoFile = (path) => readFile(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');

test('a resumed sweep retries what failed, and refuses records swept another way', () => inTmp(async (dir) => {
  const out = join(dir, 'sweep.json');
  const profiles = join(dir, 'profiles');
  await mkdir(profiles);
  const abarth = await repoFile('cars/abarth500.json');
  await writeFile(join(profiles, 'abarth500.json'), abarth);
  await writeFile(join(profiles, 'broken.json'), '{');
  const livery = join(dir, 'neon-grid-any.mjs');
  const design = await repoFile('liveries/neon-grid-any.mjs');
  await writeFile(livery, design);

  await sweep(livery, '--profiles', profiles, '--out', out);
  assert.ok(JSON.parse(await readFile(out, 'utf8')).find((r) => r.id === 'broken').error);

  // A car that failed counted as done, so it was never tried again short of
  // --fresh, which throws away every car that worked.
  await writeFile(join(profiles, 'broken.json'), JSON.stringify({ ...JSON.parse(abarth), id: 'broken' }));
  const { stdout } = await sweep(livery, '--profiles', profiles, '--out', out);
  assert.match(stdout, /2 planned, 1 already done, 1 this pass \(1 failed last time\)/);
  const records = JSON.parse(await readFile(out, 'utf8'));
  assert.deepEqual(records.map((r) => [r.id, r.error]), [['abarth500', undefined], ['broken', undefined]]);

  // The key is the car and the design's name, so other profiles, or the same
  // design edited, used to reuse these records without a word.
  await assert.rejects(sweep(livery, '--out', out), /2 of them with --profiles .*profiles.*--fresh/s);
  await writeFile(livery, design.replace('cell: 30', 'cell: 31'));
  await assert.rejects(sweep(livery, '--profiles', profiles, '--out', out), /a different version of the design.*--fresh/s);
  // Summarising reads what is there, but says when the design has moved on.
  const summary = await sweep(livery, '--out', out, '--summary');
  assert.match(summary.stdout, /2 record\(s\) were swept from a different version of the design/);

  // And the models' options: visibility changes every tag a profile carries.
  const cars = join(dir, 'cars');
  await mkdir(join(cars, 'boxcar'), { recursive: true });
  await writeFile(join(cars, 'boxcar', 'boxcar.kn5'), carKn5());
  const kn5Out = join(dir, 'kn5.json');
  await sweep(livery, '--cars', cars, '--no-profiles', '--no-visibility', '--out', kn5Out, 'boxcar');
  await assert.rejects(sweep(livery, '--cars', cars, '--no-profiles', '--out', kn5Out, 'boxcar'), /visibility off, not on.*--fresh/s);
}));

/** The shipped Abarth with its body bound to more than one texture. */
async function twoTextureBody(dir, change = () => {}) {
  const profiles = join(dir, 'profiles');
  await mkdir(profiles);
  const p = JSON.parse(await repoFile('cars/abarth500.json'));
  p.bind.body = { ...p.bind.body, roles: ['skin', 'skinbase_default'] };
  change(p);
  await writeFile(join(profiles, 'abarth500.json'), JSON.stringify(p));
  return { profiles, p };
}

test('the body counts the panels on every texture it binds, not only the first', () => inTmp(async (dir) => {
  const { profiles, p } = await twoTextureBody(dir);
  const out = join(dir, 'sweep.json');
  await sweep('neon-grid-any', '--profiles', profiles, '--out', out);
  const [record] = JSON.parse(await readFile(out, 'utf8'));
  const count = (role) => Object.keys(p.panels[role]).length;
  assert.equal(record.bindings.body.panels, count('skin') + count('skinbase_default'));
}));

/** A car folder holding these files, as an install lays them out. */
async function carFolder(parent, id, files) {
  const dir = join(parent, id);
  await mkdir(dir, { recursive: true });
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(dir, name), bytes);
  return dir;
}

test('two models of one size go by name, whatever order the folder lists them in', () => {
  // As jtc_honda_civic_eg_gra ships them. The choice went by readdir's order,
  // which is the filesystem's, so two machines could sweep two different
  // files. The main spelling sorts first.
  const tie = [{ name: 'tie_1.kn5', bytes: 10 }, { name: 'tie.kn5', bytes: 10 }];
  assert.equal(bestOf(tie), 'tie.kn5');
  assert.equal(bestOf([...tie].reverse()), 'tie.kn5');
});

test('the packer reads its input with or without --out, and refuses a survey without skin counts', () => inTmp(async (dir) => {
  const record = {
    id: 'x', skinCount: 4,
    roles: { body: { file: 'b.dds', panels: 12, cover: 0.4, box: [0, 1, 0, 1, 0, 1], straddles: true,
      wheelIslands: 0, sidewalls: 0, instances: 2, skins: 2, shaders: ['ksPerPixel'] } },
  };
  const survey = join(dir, 'fleet.json');
  const out = join(dir, 'fleet.json.gz');
  const pack = (...args) => run(process.execPath, [tool('pack-fleet.mjs'), ...args]);

  const noCount = structuredClone(record);
  delete noCount.skinCount;
  await writeFile(survey, JSON.stringify([noCount]));
  await assert.rejects(pack(survey, '--out', out), /x: no skin count/);
  const noSkins = structuredClone(record);
  delete noSkins.roles.body.skins;
  await writeFile(survey, JSON.stringify([noSkins]));
  await assert.rejects(pack(survey, '--out', out), /x: role "body" has no skin-override count/);

  await writeFile(survey, JSON.stringify([record]));
  await pack('--out', out, survey);
  assert.deepEqual(JSON.parse(gunzipSync(await readFile(out)).toString('utf8')).cars.map((c) => c.id), ['x']);

  // Without --out, index 0 was taken for --out's value and the input was
  // skipped; every test passed --out, so nothing noticed. Checked with a
  // survey the packer refuses before it writes, so the committed fixture is
  // never packed over: the refusal names the car only if the input was read.
  const fixture = fileURLToPath(new URL('./fixtures/fleet-features.json.gz', import.meta.url));
  const before = await readFile(fixture);
  const old = structuredClone(record);
  delete old.roles.body.panels;
  await writeFile(survey, JSON.stringify([old]));
  await assert.rejects(pack(survey), /x: role "body" has no island count/);
  assert.ok((await readFile(fixture)).equals(before), 'the committed fixture is untouched');
}));

test('the model a car is swept from is its biggest that is not a LOD or a collider', () => inTmp(async (dir) => {
  const best = async (id, files) => {
    const got = await bestKn5(await carFolder(dir, id, files));
    return got && got.slice(dir.length + 1);
  };
  const bytes = (n) => Buffer.alloc(n);
  // The full model under the other spelling, and nothing else: the plan's
  // pm3dm_bmw_320i_stw, which the hand sweep's "not a LOD" filter threw away.
  assert.equal(await best('lone', { 'lone_LODA.kn5': bytes(10) }), join('lone', 'lone_LODA.kn5'));
  // A decimated copy or a physics hull loses even when it is the bigger file:
  // its islands are not the ones a skin is authored against.
  assert.equal(await best('lods', { 'lods.kn5': bytes(10), 'lods_lod_b.kn5': bytes(20), 'collider.kn5': bytes(30) }),
    join('lods', 'lods.kn5'));
  assert.equal(await best('only-lods', { 'x_lod_b.kn5': bytes(10), 'collider.kn5': bytes(5) }), null);
  assert.equal(await best('empty', {}), null);
}));

test('the sweep profiles each car from its model, and records a car without one', () => inTmp(async (dir) => {
  const cars = join(dir, 'content', 'cars');
  await carFolder(cars, 'alpha', { 'alpha_LODA.kn5': carKn5() });
  // The LOD is made the bigger file, so size alone would have taken it.
  await carFolder(cars, 'beta', { 'beta.kn5': carKn5(), 'beta_lod_b.kn5': buildKn5({ textureBytes: 1 << 20 }) });
  await carFolder(cars, 'gamma', { 'readme.txt': 'no model here' });
  const out = join(dir, 'sweep.json');
  await sweep('neon-grid-any', '--cars', cars, '--all', '--no-profiles', '--no-visibility', '--out', out);
  const records = JSON.parse(await readFile(out, 'utf8'));
  assert.deepEqual(records.map((r) => [r.id, r.from, r.source ?? r.error]),
    [['alpha', 'kn5', 'alpha_LODA.kn5'], ['beta', 'kn5', 'beta.kn5'], ['gamma', 'kn5', 'no kn5']]);
  for (const r of records.slice(0, 2)) {
    assert.equal(r.visibility, false);
    assert.equal(r.panels, 6, `${r.id}: the synthetic car's six faces`);
  }
}));

test('the summary counts a rule as missed only where it landed nowhere', () => {
  const car = (id, body, regions) => ({
    id, from: 'kn5', textures: 30, panels: 40,
    bindings: { body }, surfaces: [{ from: 'surfaces.body', status: 'present' }], regions,
  });
  const rule = (role, status, nearMiss) => ({
    from: 'surfaces.body', role, kind: 'tags', tags: ['left', 'visible'], status,
    ...(status === 'missing' ? { nearMiss } : {}),
  });
  const lines = summarise([
    car('a', { roles: ['body'], source: 'auto', confidence: 0.9, panels: 20 }, [rule('body', 'matched')]),
    // Missed on one of its two textures and matched on the other: it landed.
    car('b', { roles: ['body', 'rear'], source: 'auto', confidence: 0.5, panels: 20 },
      [rule('body', 'missing', { blocking: 'visible', tied: [], panels: 20 }), rule('rear', 'matched')]),
    car('c', { roles: ['black'], source: 'auto', confidence: 0.11, panels: 0 },
      [rule('black', 'missing', { blocking: null, tied: [], panels: 0 })]),
  ]).join('\n');
  assert.match(lines, /1 confident \(>= 0\.7\), 1 shaky, 1 a guess \(< 0\.2\): c 0\.11/);
  assert.match(lines, /texture with no panels: 1 \(c\)/);
  // Not "two or more tags": with no panels there was nothing for any tag to
  // select, and blaming the tags sends somebody to the wrong fix.
  assert.match(lines, /\[left, visible\] matched nothing on 1 of 3 — blocked by a texture with no panels 1/);
});

test('the summary names a tie as a tie, not as the first tag', () => {
  const car = (id, nearMiss) => ({
    id, from: 'kn5', textures: 30, panels: 40,
    bindings: { body: { roles: ['b'], source: 'auto', confidence: 0.9, panels: 20 } },
    surfaces: [{ from: 'surfaces.body', status: 'present' }],
    regions: [{ from: 'surfaces.body', role: 'b', kind: 'tags', tags: ['left', 'mid', 'upper', 'visible'],
      status: 'missing', nearMiss }],
  });
  const lines = summarise([
    car('a', { blocking: 'mid', tied: [], panels: 9 }),
    car('b', { blocking: null, tied: ['mid', 'visible'], panels: 9 }),
    // A record swept before ties were reported still reads as it did.
    car('c', { blocking: 'mid' }),
  ]).join('\n');
  assert.match(lines, /matched nothing on 3 of 3 — blocked by mid 2, mid or visible \(tied\) 1/);
});

const surveyCar = {
  id: 'x', skinCount: 4,
  roles: {
    body: { file: 'b.dds', w: 2048, h: 2048, panels: 12, cover: 0.4, meshes: 3, box: [0, 1, 0, 1, 0, 1],
      straddles: true, visible: 0.7, skins: 2, shaders: ['ksPerPixelMultiMap_damage_dirt'] },
    trim: { file: 't.dds', w: 256, h: 256, panels: 0, cover: 0.01, meshes: 1, box: [0, 1, 0, 1, 0, 1],
      straddles: false, skins: 0, shaders: ['ksPerPixel'] },
  },
};

test('one reader turns survey and fixture records into the same features', () => {
  const packed = {
    id: 'x', skinCount: 4,
    roles: {
      body: { file: 'b.dds', cover: 0.4, straddles: true, skins: 2, sh: [1], box: [0, 1, 0, 1, 0, 1], visible: 0.7, panels: 12 },
      trim: { file: 't.dds', cover: 0.01, straddles: false, skins: 0, sh: [0], box: [0, 1, 0, 1, 0, 1], panels: 0 },
    },
  };
  const fromSurvey = featuresFromRecord(surveyCar);
  assert.deepEqual(featuresFromRecord(packed, { shaderNames: ['ksPerPixel', 'ksPerPixelMultiMap_damage_dirt'] }), fromSurvey);
  assert.equal(fromSurvey[0].islands, 12);
  assert.equal(fromSurvey[1].islands, 0);
  assert.equal(fromSurvey[0].skinFraction, 0.5);
});

test('the packer keeps what the classifier reads, and refuses a survey without island counts', () => inTmp(async (dir) => {
  const survey = join(dir, 'fleet.json');
  const out = join(dir, 'fleet.json.gz');
  await writeFile(survey, JSON.stringify([surveyCar, { id: 'gone', error: 'no kn5' }]));
  await run(process.execPath, [tool('pack-fleet.mjs'), survey, '--out', out]);
  const doc = JSON.parse(gunzipSync(await readFile(out)).toString('utf8'));
  assert.deepEqual(doc.cars.map((c) => c.id), ['x']);
  assert.deepEqual(featuresFromRecord(doc.cars[0], { shaderNames: doc.shaders }), featuresFromRecord(surveyCar));

  const old = structuredClone(surveyCar);
  delete old.roles.trim.panels;
  await writeFile(survey, JSON.stringify([old]));
  await assert.rejects(run(process.execPath, [tool('pack-fleet.mjs'), survey, '--out', out]), /no island count/);
}));

test('the sweep runs on the shipped profiles with no model on the machine', () => inTmp(async (dir) => {
  const out = join(dir, 'sweep.json');
  const { stdout } = await run(process.execPath, [tool('sweep.mjs'), 'neon-grid-any', '--out', out]);
  const records = JSON.parse(await readFile(out, 'utf8'));
  assert.deepEqual(records.map((r) => r.id).sort(), ['abarth500', 'ac_friends_honda_nsx_gt3_evo', 'rss_formula_rss_4']);
  for (const r of records) {
    assert.equal(r.error, undefined, `${r.id}: ${r.error}`);
    assert.equal(r.from, 'profile');
  }

  // A road car mirrors its flanks onto shared texels; the NSX does not, so
  // the design's `[shared, visible]` rule finds nothing there — and the near
  // miss has to say it was `shared`, not `visible`, that did it.
  const rule = (id, tags) => records.find((r) => r.id === id).regions
    .filter((g) => g.kind === 'tags' && String(g.tags) === String(tags));
  assert.ok(rule('abarth500', ['shared', 'visible']).some((g) => g.status === 'matched'));
  const nsx = rule('ac_friends_honda_nsx_gt3_evo', ['shared', 'visible']);
  assert.ok(nsx.length && nsx.every((g) => g.status === 'missing'));
  assert.equal(nsx[0].nearMiss.each.shared, 0);
  assert.equal(nsx[0].nearMiss.blocking, 'shared');

  assert.match(stdout, /shipped profiles, as they stand/);
  assert.match(stdout, /surfaces\.body \[shared, visible\] matched nothing on \d of 3 — blocked by shared/);

  // And the table can be read back without sweeping again.
  const table = (s) => s.slice(s.indexOf('neon-grid-any on')).trim();
  const again = await run(process.execPath, [tool('sweep.mjs'), 'neon-grid-any', '--out', out, '--summary']);
  assert.equal(table(again.stdout), table(stdout));
}));
