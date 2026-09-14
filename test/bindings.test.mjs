// ---------------------------------------------------------------------------
// Confirming bindings in one pass: `--explain --all`, and the editor's Confirm.
//
// Confirm is the one route by which liverykit writes `source: "human"`, so
// most of this file is about what it refuses. It writes a temporary copy of a
// shipped profile, never the one in cars/, and no test here reads game content:
// the model is the synthetic fixture car.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { startUi, confirmBinding, bindingsReport } from '../src/ui/server.mjs';
import { loadProfile, mergeBindings } from '../src/profile.mjs';
import { loadLivery } from '../src/livery.mjs';
import { profileFromKn5 } from '../src/engine/profilegen.mjs';
import { proposeAll, propose, featuresFromRecord, SCORABLE, VOCABULARY } from '../src/engine/classify.mjs';
import { dimmed } from '../src/ui/view3d.js';
import { carKn5 } from './fixtures/kn5.mjs';
import '../src/index.mjs';

const ROOT = new URL('..', import.meta.url).pathname;

/** An editor on a temporary copy of the Abarth's profile. */
async function editor({ withPath = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'lk-bind-'));
  const profilePath = join(dir, 'abarth500.json');
  const text = await readFile(join(ROOT, 'cars/abarth500.json'), 'utf8');
  await writeFile(profilePath, text);
  const profile = await loadProfile(profilePath);
  const livery = await loadLivery(join(ROOT, 'liveries/neon-grid-any.mjs'));
  const { server } = await startUi({
    livery, profile, profilePath: withPath ? profilePath : null,
    fitPath: join(dir, 'fit.json'), liveryId: 'neon-grid-any', port: 0, log: () => {},
  });
  const at = `http://127.0.0.1:${server.address().port}`;
  const confirm = (sent, origin = at) => fetch(`${at}/api/bindings/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
    body: JSON.stringify(sent),
  });
  const stop = () => new Promise((ok) => {
    server.closeAllConnections?.();
    server.close(ok);
  });
  return { dir, profilePath, text, at, confirm, stop };
}

test('the one-pass bind block is the block the generator writes', async () => {
  // One function behind both, so that pasting the block --all prints is the
  // same as regenerating. Checked on every car in the fleet fixture against the
  // per-term proposals it replaced.
  const doc = JSON.parse(gunzipSync(await readFile(join(ROOT, 'test/fixtures/fleet-features.json.gz'))).toString('utf8'));
  for (const car of doc.cars) {
    const features = featuresFromRecord(car, { shaderNames: doc.shaders });
    const want = {};
    for (const term of SCORABLE) {
      const p = propose(features, term);
      if (p) want[term] = { roles: p.roles, confidence: p.confidence, source: 'auto' };
    }
    assert.deepEqual(proposeAll(features), want, car.id);
  }

  // And through the command line, against the generator itself.
  const dir = await mkdtemp(join(tmpdir(), 'lk-all-'));
  const kn5 = join(dir, 'fixture-car.kn5');
  await writeFile(kn5, carKn5());
  const { code, stdout, stderr } = await new Promise((ok) => execFile(process.execPath,
    [join(ROOT, 'bin/liverykit.mjs'), '--explain', kn5, '--all', '--no-visibility'],
    (e, out, err) => ok({ code: e?.code ?? 0, stdout: out, stderr: err })));
  assert.equal(code, 0, stderr);
  for (const term of SCORABLE) assert.match(stdout, new RegExp(`^${term} — `, 'm'), `a ranking for ${term}`);
  const unscored = Object.keys(VOCABULARY).filter((t) => !SCORABLE.includes(t));
  assert.match(stdout, new RegExp(`bound by hand or not at all: ${unscored.join(', ')}\\.`));

  const block = JSON.parse(stdout.slice(stdout.indexOf('"bind": ') + 8, stdout.indexOf('\n\n  Nothing was written')));
  const generated = await profileFromKn5(kn5, { visibility: false, log: () => {} });
  assert.deepEqual(block, generated.bind);
  assert.ok(Object.keys(block).length, 'the fixture car has a body to propose');
  assert.ok(Object.values(block).every((b) => b.source === 'auto'), 'the tool never writes "human"');
});

test('the Bindings panel is told every term, bound or not', async () => {
  const e = await editor();
  try {
    const r = await (await fetch(`${e.at}/api/bindings`)).json();
    assert.equal(r.writable, true);
    assert.deepEqual(r.terms.map((t) => t.term), Object.keys(VOCABULARY));
    const brakes = r.terms.find((t) => t.term === 'brakes');
    assert.equal(brakes.source, 'auto');
    assert.deepEqual(brakes.roles, ['rims_3']);
    assert.ok(brakes.files.length, 'with the files the viewer lights up');
    assert.equal(r.terms.find((t) => t.term === 'helmet').status, 'unbound');
  } finally {
    await e.stop();
  }
});

test('a confirmation from anywhere but the editor\'s page is refused', async () => {
  const e = await editor();
  try {
    const sent = { term: 'brakes', roles: ['rims_3'] };
    // No Origin at all is what the MCP client and a script send.
    assert.equal((await e.confirm(sent, null)).status, 403);
    assert.equal((await e.confirm(sent, 'http://example.com')).status, 403);
    assert.equal(await readFile(e.profilePath, 'utf8'), e.text, 'and the file is untouched');
  } finally {
    await e.stop();
  }
});

test('Confirm writes "human" on that one term, and changes nothing else in the file', async () => {
  const e = await editor();
  try {
    const res = await e.confirm({ term: 'brakes', roles: ['rims_3'] });
    assert.equal(res.status, 200, (await res.clone().json()).error);
    assert.equal((await res.json()).terms.find((t) => t.term === 'brakes').source, 'human');

    const want = JSON.parse(e.text);
    want.bind.brakes.source = 'human';
    assert.equal(await readFile(e.profilePath, 'utf8'), JSON.stringify(want, null, 2) + '\n',
      'the file with one field changed, in the generator\'s own formatting');
    assert.deepEqual(await readdir(e.dir), ['abarth500.json'], 'no temporary file left beside it');

    const again = await (await fetch(`${e.at}/api/bindings`)).json();
    assert.equal(again.terms.find((t) => t.term === 'brakes').source, 'human', 'the editor sees it too');

    // The next regeneration proposes something else for brakes. The merge the
    // generator runs keeps what the person confirmed.
    const onDisk = await loadProfile(e.profilePath);
    const merged = mergeBindings(onDisk.bind, { brakes: { roles: ['interior'], confidence: 0.9, source: 'auto' } });
    assert.deepEqual(merged.brakes, { roles: ['rims_3'], confidence: 1, source: 'human' });
  } finally {
    await e.stop();
  }
});

test('Confirm refuses what the person did not see, and leaves the file alone', async () => {
  const e = await editor();
  try {
    const cases = [
      [{ term: 'brakes', roles: ['rims'] }, 409, /not the \[rims\] shown here/],
      [{ term: 'helmet', roles: [] }, 409, /does not bind "helmet"/],
      [{ term: 'toString', roles: [] }, 400, /not a vocabulary term/],
      [{ term: 'brakes' }, 400, /roles it saw/],
    ];
    for (const [sent, status, why] of cases) {
      const res = await e.confirm(sent);
      assert.equal(res.status, status, JSON.stringify(sent));
      assert.match((await res.json()).error, why);
    }
    assert.equal(await readFile(e.profilePath, 'utf8'), e.text);
  } finally {
    await e.stop();
  }

  const noFile = await editor({ withPath: false });
  try {
    assert.equal((await (await fetch(`${noFile.at}/api/bindings`)).json()).writable, false);
    assert.equal((await noFile.confirm({ term: 'brakes', roles: ['rims_3'] })).status, 409);
  } finally {
    await noFile.stop();
  }
});

test('a proposal saying "human" is still refused now that Confirm exists', async () => {
  // The refusal in applyProposalDiff is what keeps an agent's proposal from
  // doing what Confirm does. Confirm is a separate route so that this never
  // has to be relaxed.
  const e = await editor();
  try {
    const res = await fetch(`${e.at}/api/proposal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ why: 'confirm the brakes', fit: [{ op: 'set-override', id: 'brakes', source: 'human' }] }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /source: "human"/);
    assert.equal(await readFile(e.profilePath, 'utf8'), e.text);
  } finally {
    await e.stop();
  }
});

test('confirmBinding changes only the source, and checks what it writes', () => {
  const p = {
    id: 'x',
    textures: { a: { file: 'a.dds', width: 4, height: 4 } },
    bind: { body: { roles: ['a'], confidence: 0.4, source: 'auto' } },
  };
  const next = confirmBinding(p, { term: 'body', roles: ['a'] });
  assert.deepEqual(next.bind.body, { roles: ['a'], confidence: 0.4, source: 'human' });
  assert.equal(p.bind.body.source, 'auto', 'the profile it was handed is not changed');

  // A file already broken is not made worse by being written back.
  const broken = structuredClone(p);
  broken.bind.body.roles = ['gone'];
  assert.throws(() => confirmBinding(broken, { term: 'body', roles: ['gone'] }),
    (e) => e.status === 409 && /does not define/.test(e.message));
  assert.deepEqual(bindingsReport(p).find((t) => t.term === 'body').files, ['a.dds']);
});

test('the whole-car view darkens every part but the ones wearing the texture', () => {
  const focus = new Set(['car_body.dds']);
  assert.equal(dimmed({ file: 'Car_Body.dds' }, focus), false, 'by file, whatever the case');
  assert.equal(dimmed({ file: 'rims.dds' }, focus), true);
  assert.equal(dimmed({ file: 'rims.dds' }, null), false, 'and nothing, with nothing in focus');
});
