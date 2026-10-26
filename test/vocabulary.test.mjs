// The vocabulary a design paints by is a game's, not the build's. With none in
// use a design names texture roles directly; with Assetto Corsa's, it can say
// `body` and mean whatever each car calls its bodywork.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveTargets, validateProfile } from '../src/profile.mjs';
import { useVocabulary, vocabulary } from '../src/vocabulary.mjs';

const profile = {
  id: 'object',
  name: 'An object',
  textures: { shell: { file: 'shell.png', width: 64, height: 64 } },
  panels: { shell: { all: { rect: [0, 0, 1, 1] } } },
};

/** Run `fn` with no vocabulary in use, and put back whatever was. */
function withNone(fn) {
  const was = useVocabulary(null);
  try { return fn(); } finally { useVocabulary(was); }
}

test('with no vocabulary, a design paints texture roles by name', () => withNone(() => {
  const { targets, notes } = resolveTargets(profile, { name: 'D', paint: { shell: { regions: [] } } });
  assert.deepEqual(targets.map((t) => t.role), ['shell']);
  assert.deepEqual(notes, []);
}));

test('with no vocabulary, a term is refused, and so is a profile that binds one', () => withNone(() => {
  assert.throws(() => resolveTargets(profile, { name: 'D', surfaces: { body: { regions: [] } } }),
    /no vocabulary.*paint/s);
  assert.throws(() => validateProfile({ ...profile, bind: { body: { roles: ['shell'], source: 'human' } } }),
    /no vocabulary/);
}));

test('importing liverykit\'s profile module puts Assetto Corsa\'s vocabulary in use', () => {
  // Scripts import src/profile.mjs on its own and load shipped cars with it,
  // whose profiles bind Assetto Corsa's terms.
  assert.ok(vocabulary()?.terms.body, 'body is a term');
  assert.ok(vocabulary().elsewhere.has('crew'), 'the pit crew is drawn by its own model');
});

test('a vocabulary chosen first is kept when liverykit loads after it', async () => {
  // In a process of its own, since this one has loaded liverykit already.
  const { execFile } = await import('node:child_process');
  const src = new URL('../src/', import.meta.url).href;
  const script = `
    const { useVocabulary, vocabulary } = await import('${src}vocabulary.mjs');
    const ours = { terms: { hull: {} }, elsewhere: new Set(), unbound: String, unverified: String,
      named: String, nameFromFiles: () => ({}) };
    useVocabulary(ours);
    await import('${src}profile.mjs');
    console.log(vocabulary() === ours);`;
  const out = await new Promise((ok, no) => execFile(process.execPath, ['--input-type=module', '-e', script],
    (e, stdout, stderr) => (e ? no(new Error(stderr)) : ok(stdout.trim()))));
  assert.equal(out, 'true');
});

test('a vocabulary missing a piece is refused when it is put in use', () => {
  assert.throws(() => useVocabulary({ terms: {} }), /elsewhere.*unbound.*unverified.*named.*nameFromFiles/);
  assert.ok(vocabulary()?.terms.body, 'and the one in use stays');
});

test('an old path loads the vocabulary exactly when the module there needs one', async () => {
  // Scripts import these paths one at a time, and each must leave a process
  // in the state it always did: able to load a shipped car where the module
  // reads profiles, and with no vocabulary chosen for it where it does not.
  const { execFile } = await import('node:child_process');
  const root = new URL('../', import.meta.url).href;
  const inUse = (path) => new Promise((ok, no) => execFile(process.execPath, ['--input-type=module', '-e', `
    await import('${root}${path}');
    const { vocabulary } = await import('${root}packages/toile/src/vocabulary.mjs');
    console.log(Boolean(vocabulary()));`], (e, stdout, stderr) => (e ? no(new Error(stderr)) : ok(stdout.trim()))));
  const expected = {
    'src/profile.mjs': 'true', 'src/build.mjs': 'true', 'src/fitment.mjs': 'true',
    'src/engine/skin.mjs': 'true', 'src/inview.mjs': 'true', 'src/mcp/tools.mjs': 'true',
    'src/vocabulary.mjs': 'false', 'src/constraints.mjs': 'false', 'src/engine/rng.mjs': 'false',
  };
  const seen = {};
  for (const path of Object.keys(expected)) seen[path] = await inUse(path);
  assert.deepEqual(seen, expected);
});
