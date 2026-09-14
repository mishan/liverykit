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
import { request } from 'node:http';
import { mkdtemp, readFile, writeFile, readdir, mkdir, rename, symlink, chmod, stat, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { startUi, confirmBinding, bindingsReport } from '../src/ui/server.mjs';
import { loadProfile, mergeBindings, validateProfile, resolveTargets } from '../src/profile.mjs';
import { loadLivery } from '../src/livery.mjs';
import { portability } from '../src/portability.mjs';
import { profileFromKn5 } from '../src/engine/profilegen.mjs';
import { proposeAll, propose, proposeDriverKit, featuresFromRecord, SCORABLE, VOCABULARY, DRIVER_KIT } from '../src/engine/classify.mjs';
import { summarise } from '../tools/fleet.mjs';
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
  const stop = async () => {
    await new Promise((ok) => {
      server.closeAllConnections?.();
      server.close(ok);
    });
    await rm(dir, { recursive: true, force: true });
  };
  return { dir, profilePath, text, at, confirm, stop };
}

/**
 * A request carrying headers fetch will not let a caller choose, Host among
 * them: what a page on a rebound name sends is exactly what needs testing.
 */
function raw(at, { method = 'GET', path, headers = {}, body = '' }) {
  const { port } = new URL(at);
  return new Promise((ok, no) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => ok({ status: res.statusCode, text }));
    });
    req.on('error', no);
    req.end(body);
  });
}

test('the one-pass bind block is the block the generator writes', async (t) => {
  // One function behind both, so that pasting the block --all prints is the
  // same as regenerating. Checked on every car in the fleet fixture against
  // per-term proposals, each made from the roles the terms before it left.
  const doc = JSON.parse(gunzipSync(await readFile(join(ROOT, 'test/fixtures/fleet-features.json.gz'))).toString('utf8'));
  for (const car of doc.cars) {
    const features = featuresFromRecord(car, { shaderNames: doc.shaders });
    const want = {};
    const taken = new Map();
    for (const term of SCORABLE) {
      const p = propose(features, term, { taken });
      if (!p) continue;
      want[term] = { roles: p.roles, confidence: p.confidence, source: 'auto' };
      for (const r of p.roles) taken.set(r, term);
    }
    assert.deepEqual(proposeAll(features), want, car.id);
  }

  // And through the command line, against the generator itself.
  const dir = await mkdtemp(join(tmpdir(), 'lk-all-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const kn5 = join(dir, 'fixture-car.kn5');
  await writeFile(kn5, carKn5());
  const { code, stdout, stderr } = await new Promise((ok) => execFile(process.execPath,
    [join(ROOT, 'bin/liverykit.mjs'), '--explain', kn5, '--all', '--no-visibility'],
    (e, out, err) => ok({ code: e?.code ?? 0, stdout: out, stderr: err })));
  assert.equal(code, 0, stderr);
  for (const term of SCORABLE) assert.match(stdout, new RegExp(`^${term} — `, 'm'), `a ranking for ${term}`);
  const kit = Object.keys(DRIVER_KIT);
  const unscored = Object.keys(VOCABULARY).filter((t) => !SCORABLE.includes(t) && !kit.includes(t));
  assert.match(stdout, new RegExp(`bound by hand or not at all: ${unscored.join(', ')}\\.`));
  assert.match(stdout, new RegExp(`not measured \\(needs --skins\\): ${kit.join(', ')}\\.`));
  // No profile for this car in cars/, so nothing to merge, and said.
  assert.match(stdout, /No \S*\/fixture-car\.json, so this block has no confirmed bindings merged in/);

  const block = JSON.parse(stdout.slice(stdout.indexOf('"bind": ') + 8, stdout.indexOf('\n\n  Nothing was written')));
  const generated = await profileFromKn5(kn5, { visibility: false, log: () => {} });
  assert.deepEqual(block, generated.bind);
  assert.ok(Object.keys(block).length, 'the fixture car has a body to propose');
  assert.ok(Object.values(block).every((b) => b.source === 'auto'), 'the tool never writes "human"');
});

/** The command line, run as a person would, answering with what it printed. */
const cli = (args, env = {}) => new Promise((ok) => execFile(process.execPath, [join(ROOT, 'bin/liverykit.mjs'), ...args],
  { env: { ...process.env, ...env } }, (e, out, err) => ok({ code: e?.code ?? 0, stdout: out, stderr: err })));

const printedBlock = (stdout) =>
  JSON.parse(stdout.slice(stdout.indexOf('"bind": ') + 8, stdout.indexOf('\n\n  Nothing was written')));

test('the --all block keeps what a person confirmed, as a regeneration does', async () => {
  // The generator merges the existing profile's human bindings in and --all
  // did not, so pasting its block over cars/<id>.json put every confirmation
  // back to "auto" and dropped the terms bound by hand. The prior is put in
  // a temporary directory, never in this checkout's cars/, where a stray one
  // would pass for a shipped car.
  const id = 'fixture_prior';
  const dir = await mkdtemp(join(tmpdir(), 'lk-prior-'));
  const env = { LIVERYKIT_PRIOR_DIR: dir };
  try {
    const kn5 = join(dir, 'fixture-car.kn5');
    await writeFile(kn5, carKn5());
    const prior = await profileFromKn5(kn5, { id, log: () => {} });
    prior.bind.body = { ...prior.bind.body, source: 'human' };
    prior.bind.wing = { roles: [...prior.bind.body.roles], source: 'human' };
    await writeFile(join(dir, `${id}.json`), JSON.stringify(prior, null, 2) + '\n');

    const explained = await cli(['--explain', kn5, '--all', '--car-id', id], env);
    assert.equal(explained.code, 0, explained.stderr);
    const generated = await cli(['--from-kn5', kn5, '--car-id', id, '--out', join(dir, 'out')], env);
    assert.equal(generated.code, 0, generated.stderr);
    const written = JSON.parse(await readFile(join(dir, 'out', `${id}.json`), 'utf8'));

    const block = printedBlock(explained.stdout);
    assert.deepEqual(block, written.bind, 'what a person pastes is what a regeneration writes');
    assert.equal(block.body.source, 'human', 'a confirmation stays confirmed');
    assert.deepEqual(block.wing, prior.bind.wing, 'and a term bound by hand stays bound');
    assert.match(explained.stdout, /kept 2 human-confirmed binding\(s\) from /);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('--explain takes --assume-size, as the generator does', async () => {
  // Without it, on an encrypted car the candidates and the block were not the
  // ones a generation with the flag produces. Proved by the check behind it:
  // a size that is not a power of two is refused, as --from-kn5 refuses it.
  const dir = await mkdtemp(join(tmpdir(), 'lk-assume-'));
  try {
    const kn5 = join(dir, 'fixture-car.kn5');
    await writeFile(kn5, carKn5({ encrypted: true }));
    const r = await cli(['--explain', kn5, '--all', '--no-visibility', '--assume-size', '1000']);
    assert.notEqual(r.code, 0, r.stdout);
    assert.match(r.stderr, /power of two/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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

test('a page on another name that resolves here is refused, on every route', async () => {
  // DNS rebinding. A page on evil.example whose name is re-pointed at
  // 127.0.0.1 sends its own name as Host and as Origin, and the two agreed,
  // which is all Confirm used to check. It could read the roles it needed
  // from /api/bindings first, and text/plain needs no preflight.
  const e = await editor();
  try {
    const { port } = new URL(e.at);
    const evil = `evil.example:${port}`;
    const read = await raw(e.at, { path: '/api/bindings', headers: { host: evil } });
    assert.equal(read.status, 403, read.text);
    assert.match(JSON.parse(read.text).error, /evil\.example/);
    for (const type of ['text/plain', 'application/json']) {
      const res = await raw(e.at, {
        method: 'POST', path: '/api/bindings/confirm',
        headers: { host: evil, origin: `http://${evil}`, 'content-type': type },
        body: JSON.stringify({ term: 'brakes', roles: ['rims_3'] }),
      });
      assert.equal(res.status, 403, `${type}: ${res.text}`);
    }
    assert.equal(await readFile(e.profilePath, 'utf8'), e.text, 'and the file is untouched');

    // Both of this server's own names are this server.
    const local = await raw(e.at, { path: '/api/bindings', headers: { host: `localhost:${port}` } });
    assert.equal(local.status, 200, local.text);
  } finally {
    await e.stop();
  }
});

test('a confirmation that is not sent as JSON is refused', async () => {
  // A cross-origin text/plain POST goes out with no preflight, so a route that
  // parses it anyway can be reached by a page that could never send JSON.
  const e = await editor();
  try {
    const res = await fetch(`${e.at}/api/bindings/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', origin: e.at },
      body: JSON.stringify({ term: 'brakes', roles: ['rims_3'] }),
    });
    assert.equal(res.status, 415);
    assert.match((await res.json()).error, /application\/json/);
    assert.equal(await readFile(e.profilePath, 'utf8'), e.text);
  } finally {
    await e.stop();
  }
});

test('a request body that is not JSON is the sender\'s mistake, not the server\'s', async () => {
  // It was a 500, which says the editor broke, and the file was never at risk.
  const e = await editor();
  try {
    const cut = '{"term": "brakes", "roles": [';
    const res = await fetch(`${e.at}/api/bindings/confirm`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: e.at }, body: cut,
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /not JSON/);
    assert.equal(await readFile(e.profilePath, 'utf8'), e.text);

    // One reader behind every route that takes a body, so one answer.
    const state = await fetch(`${e.at}/api/state`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: cut,
    });
    assert.equal(state.status, 400);
  } finally {
    await e.stop();
  }
});

test('the editor opened as localhost can confirm', async () => {
  const e = await editor();
  try {
    const { port } = new URL(e.at);
    const res = await raw(e.at, {
      method: 'POST', path: '/api/bindings/confirm',
      headers: { host: `localhost:${port}`, origin: `http://localhost:${port}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ term: 'brakes', roles: ['rims_3'] }),
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(JSON.parse(await readFile(e.profilePath, 'utf8')).bind.brakes.source, 'human');
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

test('the Bindings panel shows the profile file as it is now', async () => {
  // A regeneration in another terminal renamed a role. The panel kept the
  // startup copy's roles and files, so Confirm was refused with "reload the
  // page", and reloading asked the same server for the same stale copy.
  const e = await editor();
  try {
    const now = JSON.parse(e.text);
    const file = now.textures.rims_3.file;
    for (const block of ['textures', 'panels', 'adjacency', 'aliases']) {
      if (now[block]?.rims_3 === undefined) continue;
      now[block].brake_disc = now[block].rims_3;
      delete now[block].rims_3;
    }
    now.bind.brakes.roles = ['brake_disc'];
    await writeFile(e.profilePath, JSON.stringify(now, null, 2) + '\n');

    const shown = (await (await fetch(`${e.at}/api/bindings`)).json()).terms.find((t) => t.term === 'brakes');
    assert.deepEqual([shown.roles, shown.files], [['brake_disc'], [file]]);

    const res = await e.confirm({ term: 'brakes', roles: ['brake_disc'] });
    assert.equal(res.status, 200, (await res.clone().json()).error);
    const after = (await res.json()).terms.find((t) => t.term === 'brakes');
    assert.deepEqual([after.source, after.files], ['human', [file]]);
  } finally {
    await e.stop();
  }
});

test('Confirm writes through a symlinked profile to the file it names', async () => {
  // rename() replaces whatever sits at the path. A linked profile became a
  // detached copy holding the confirmation, and the real file still said
  // "auto" — to anyone reading it, the click had done nothing.
  const e = await editor();
  try {
    const elsewhere = join(e.dir, 'elsewhere');
    await mkdir(elsewhere);
    const real = join(elsewhere, 'abarth500.json');
    await rename(e.profilePath, real);
    await symlink(real, e.profilePath);

    const res = await e.confirm({ term: 'brakes', roles: ['rims_3'] });
    assert.equal(res.status, 200, (await res.clone().json()).error);
    assert.ok((await lstat(e.profilePath)).isSymbolicLink(), 'the link is still a link');
    assert.equal(JSON.parse(await readFile(real, 'utf8')).bind.brakes.source, 'human', 'and its target was confirmed');
    assert.deepEqual(await readdir(elsewhere), ['abarth500.json'], 'with no temporary file left beside it');
  } finally {
    await e.stop();
  }
});

test('Confirm keeps the profile\'s permissions', async () => {
  // A fresh file takes the umask, so a 0600 profile came back 0664.
  const e = await editor();
  try {
    await chmod(e.profilePath, 0o600);
    const res = await e.confirm({ term: 'brakes', roles: ['rims_3'] });
    assert.equal(res.status, 200, (await res.clone().json()).error);
    assert.equal(((await stat(e.profilePath)).mode & 0o777).toString(8), '600');
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

test('the driver kit is proposed from AC\'s exact filenames, and nothing looser', () => {
  // Every one of the four wrong ones is a real file on a real car, and each
  // would have been bound by a pattern: guessRole calls the NSX's
  // Lumirank_Driver_ID.dds a suit.
  const textures = {
    helmet: { file: 'HELMET_2012.dds' },
    visor: { file: 'Helmet_2012_Glass.dds' },
    crewHelmet: { file: 'crew_helmet_color.dds' },
    id: { file: 'Lumirank_Driver_ID.dds' },
    suit: { file: '2016_SUIT_DIFF.dds' },
    oldSuit: { file: 'driver_suit2.dds' },
    crew: { file: 'ac_crew.dds' },
  };
  assert.deepEqual(proposeDriverKit(textures), {
    helmet: { roles: ['helmet'], source: 'auto', evidence: 'name' },
    // Both suits: whichever driver model the car loads, its suit is painted.
    suit: { roles: ['suit', 'oldSuit'], source: 'auto', evidence: 'name' },
    crew: { roles: ['crew'], source: 'auto', evidence: 'name' },
  });
  assert.deepEqual(proposeDriverKit({}), {}, 'no skins scanned, nothing named');
});

test('on the RSS4 the named kit is what a person bound by hand', async () => {
  const p = await loadProfile(join(ROOT, 'cars/rss_formula_rss_4.json'));
  const proposed = proposeDriverKit(p.textures);
  for (const term of Object.keys(DRIVER_KIT)) {
    assert.equal(p.bind[term].source, 'human', `${term} was bound by hand`);
    assert.deepEqual(proposed[term]?.roles, p.bind[term].roles, term);
  }
});

test('a named binding is checked, said to be named, and kept out of the confidence means', () => {
  const p = {
    id: 'x',
    textures: {
      body: { file: 'b.dds', width: 4, height: 4 },
      helmet: { file: 'helmet_2012.dds', width: 4, height: 4, sizeFrom: 'skin', inModel: false },
    },
    bind: { helmet: { roles: ['helmet'], source: 'auto', evidence: 'name' } },
  };
  validateProfile(structuredClone(p));
  const typo = structuredClone(p);
  typo.bind.helmet.evidence = 'guess';
  assert.throws(() => validateProfile(typo), /evidence may only be "name"/);

  const { notes } = resolveTargets(p, { name: 't', surfaces: { helmet: {} } });
  const note = notes.find((n) => n.status === 'unconfirmed');
  assert.match(note.text, /by name; nothing was measured/);
  assert.doesNotMatch(note.text, /confidence/);

  const lines = summarise([{
    id: 'a', from: 'kn5', textures: 2, panels: 1, surfaces: [], regions: [],
    bindings: {
      body: { roles: ['body'], source: 'auto', confidence: 0.9, panels: 1 },
      helmet: { roles: ['helmet'], source: 'auto', evidence: 'name', panels: 0 },
    },
  }]).join('\n');
  assert.match(lines, /named helmet on 1 of 1, from AC's own filename/);
  assert.doesNotMatch(lines, /proposed helmet/, 'not averaged in as a confidence of zero');
});

test('the portability report tells a surface nobody bound from one the car lacks', () => {
  const p = {
    id: 'x', panels: {},
    textures: { body: { file: 'b.dds', width: 4, height: 4 } },
    bind: { body: { roles: ['body'], source: 'human' }, wing: { roles: [], source: 'human' } },
  };
  const r = portability({ name: 't', surfaces: { body: {}, wing: {}, rims: {} } }, p);
  const by = Object.fromEntries(r.surfaces.map((s) => [s.from, s]));
  assert.equal(by['surfaces.body'].status, 'present');
  assert.equal(by['surfaces.wing'].status, 'absent', 'a person said this car has none');
  assert.equal(by['surfaces.rims'].status, 'unbound', 'nobody has said anything');
  assert.match(by['surfaces.rims'].why, /nobody has bound "rims"/);
});

test('the whole-car view darkens every part but the ones wearing the texture', () => {
  const focus = new Set(['car_body.dds']);
  assert.equal(dimmed({ file: 'Car_Body.dds' }, focus), false, 'by file, whatever the case');
  assert.equal(dimmed({ file: 'rims.dds' }, focus), true);
  assert.equal(dimmed({ file: 'rims.dds' }, null), false, 'and nothing, with nothing in focus');
});
