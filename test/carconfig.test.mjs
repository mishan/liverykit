// The car's own CSP config, and what it hides. Four number plate sets on one
// door, all hidden by the car and un-hidden per skin, is the case this exists
// for: read from the model alone they were drawn, checked and shipped for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hidePatterns, hiddenMeshes } from '../src/engine/carconfig.mjs';
import { parseKn5Buffer } from '../src/engine/kn5.mjs';
import { profileFromKn5 } from '../src/engine/profilegen.mjs';
import { buildKn5, carKn5, vert } from './fixtures/kn5.mjs';

const NSX_STYLE = `
[MODEL_REPLACEMENT_...]
FILE = car.kn5, car_lod_b.kn5 ; the LODs share the plates
HIDE = IGT_NUMBERPLATE_LEFT, IGT_NUMBERPLATE_RIGHT, Blancpain_Silver2_Colour.dds

[MODEL_REPLACEMENT_...]
FILE = other_car.kn5
HIDE = NOT_THIS_ONE

[MODEL_REPLACEMENT_...]
HIDE = SPOTTER_*

[LIGHT_HEADLIGHTS_0]
HIDE = a_key_in_another_section
`;

test('HIDE patterns are taken from MODEL_REPLACEMENT sections that name this model', () => {
  const got = hidePatterns(NSX_STYLE, 'CAR.kn5');
  // The section for another car is skipped; one with no FILE applies to all;
  // HIDE outside MODEL_REPLACEMENT is some other feature's key.
  assert.deepEqual(got, ['IGT_NUMBERPLATE_LEFT', 'IGT_NUMBERPLATE_RIGHT', 'Blancpain_Silver2_Colour.dds', 'SPOTTER_*']);
  assert.deepEqual(hidePatterns(NSX_STYLE, 'other_car.kn5'), ['NOT_THIS_ONE', 'SPOTTER_*']);
  assert.deepEqual(hidePatterns('', 'car.kn5'), []);
});

test('patterns resolve to mesh names, by name or by the texture they wear, and say which', async () => {
  const model = parseKn5Buffer(buildKn5({ extraMeshes: [
    { name: 'IGT_NUMBERPLATE_LEFT', verts: [vert(0, 0, 0, 0, 0), vert(1, 0, 0, 1, 0), vert(0, 1, 0, 0, 1)], indices: [0, 1, 2] },
    { name: 'SPOTTER_L', verts: [vert(0, 0, 0, 0, 0), vert(1, 0, 0, 1, 0), vert(0, 1, 0, 0, 1)], indices: [0, 1, 2] },
  ] }));
  const { hidden, unmatched } = hiddenMeshes(model, ['igt_numberplate_left', 'SPOTTER_*', 'NOWHERE', 'body.dds']);
  assert.equal(hidden.get('IGT_NUMBERPLATE_LEFT')?.by, 'name');
  assert.equal(hidden.get('SPOTTER_L')?.by, 'name');
  // Every mesh in the fixture wears body.dds, so the texture pattern reaches
  // the body mesh too — and is labelled as a texture match, not a name match.
  assert.equal(hidden.get('body_mesh')?.by, 'texture');
  assert.deepEqual(unmatched, ['NOWHERE']);
});

test('a profile records what the car hides, and a texture worn only by hidden meshes says so', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lk-carcfg-'));
  const modelPath = join(dir, 'fixture.kn5');
  await writeFile(modelPath, carKn5());
  await mkdir(join(dir, 'extension'));
  await writeFile(join(dir, 'extension', 'ext_config.ini'),
    '[MODEL_REPLACEMENT_...]\nFILE=fixture.kn5\nHIDE=BODY_SHELL, GHOST\n');

  const profile = await profileFromKn5(modelPath, { id: 'fixture_car', log: () => {} });
  assert.deepEqual(profile.hiddenByCar, {
    source: join('extension', 'ext_config.ini'),
    meshes: { BODY_SHELL: { by: 'name', pattern: 'BODY_SHELL' } },
    unmatched: ['GHOST'],
  });
  // The only mesh wearing body.dds is hidden, so the texture is too.
  const body = Object.values(profile.textures).find((t) => t.file === 'body.dds');
  assert.equal(body.hiddenByCar, true);
  // The shader is a measurement the build needs to decide whether alpha can
  // hide the part; it travels with the texture.
  assert.deepEqual(body.shaders, ['ksPerPixel']);

  // No config: nothing claimed, nothing invented.
  const bare = await mkdtemp(join(tmpdir(), 'lk-nocfg-'));
  await writeFile(join(bare, 'fixture.kn5'), carKn5());
  const plain = await profileFromKn5(join(bare, 'fixture.kn5'), { id: 'fixture_car', log: () => {} });
  assert.equal(plain.hiddenByCar, undefined);
  assert.equal(Object.values(plain.textures)[0].hiddenByCar, undefined);
});
