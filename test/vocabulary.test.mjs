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

test('liverykit puts Assetto Corsa\'s vocabulary in use', async () => {
  await import('../src/index.mjs');
  assert.ok(vocabulary()?.terms.body, 'body is a term');
  assert.ok(vocabulary().elsewhere.has('crew'), 'the pit crew is drawn by its own model');
});
