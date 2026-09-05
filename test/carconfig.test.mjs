// The car's own CSP config, and what it hides. Four number plate sets on one
// door, all hidden by the car and un-hidden per skin, is the case this exists
// for: read from the model alone they were drawn, checked and shipped for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hidePatterns, hiddenMeshes, carConfigBeside } from '../src/engine/carconfig.mjs';
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
HIDE = SPOTTER_?

[MODEL_REPLACEMENT_...]
ACTIVE = 0
HIDE = SWITCHED_OFF

[MODEL_REPLACEMENT_...]
SKINS = red?
HIDE = ONLY_FOR_SOME_SKINS

[LIGHT_HEADLIGHTS_0]
HIDE = a_key_in_another_section
`;

test('HIDE patterns are taken from MODEL_REPLACEMENT sections that apply to this model', () => {
  const got = hidePatterns(NSX_STYLE, 'CAR.kn5');
  // The section for another car is skipped; one with no FILE applies to all;
  // ACTIVE=0 is off; a SKINS filter means "some skins, not the car", and this
  // tool cannot know which skin will be worn, so it does not apply either;
  // HIDE outside MODEL_REPLACEMENT is some other feature's key.
  assert.deepEqual(got, ['IGT_NUMBERPLATE_LEFT', 'IGT_NUMBERPLATE_RIGHT', 'Blancpain_Silver2_Colour.dds', 'SPOTTER_?']);
  assert.deepEqual(hidePatterns(NSX_STYLE, 'other_car.kn5'), ['NOT_THIS_ONE', 'SPOTTER_?']);
  assert.deepEqual(hidePatterns('', 'car.kn5'), []);
});

test("patterns resolve the way CSP's filtering page says, and say how", () => {
  // CSP's wildcard is `?` and it means "any symbols in any quantity" — the
  // Windows `*`, kept as `?` for compatibility — and a HIDE entry names a mesh
  // OR a node, hiding everything beneath the node. Properties are matched
  // with a prefix: `texture:X.dds`, `material:M`, `shader:S`, `parent:N`. A
  // bare `Foo.dds` with no prefix is therefore a NAME, and on a car with no
  // mesh called that it hides nothing, whatever the config's author meant.
  const tri = [vert(0, 0, 0, 0, 0), vert(1, 0, 0, 1, 0), vert(0, 1, 0, 0, 1)];
  const model = parseKn5Buffer(buildKn5({ extraMeshes: [
    { name: 'IGT_NUMBERPLATE_LEFT', verts: tri, indices: [0, 1, 2] },
    { name: 'SPOTTER_L', verts: tri, indices: [0, 1, 2] },
    { name: 'SPOTTER_R', verts: tri, indices: [0, 1, 2] },
  ] }));
  const { hidden, unmatched } = hiddenMeshes(model, [
    'igt_numberplate_left', 'SPOTTER_?', 'NOWHERE', 'body.dds', 'texture:BODY.dds', 'shader:ksPerPixel',
  ]);
  assert.equal(hidden.get('IGT_NUMBERPLATE_LEFT')?.by, 'name');
  assert.equal(hidden.get('SPOTTER_L')?.by, 'name');
  assert.equal(hidden.get('SPOTTER_R')?.by, 'name');
  // First match wins the label: body_mesh is reached by texture: before shader:.
  assert.equal(hidden.get('body_mesh')?.by, 'texture');
  assert.equal(hidden.get('body_mesh')?.pattern, 'texture:BODY.dds');
  // A bare .dds is a name pattern and there is no such mesh.
  assert.deepEqual(unmatched, ['NOWHERE', 'body.dds']);
});

test('a node name hides every mesh beneath it', () => {
  // The fixture puts every mesh directly under `root`, so `root` is the node
  // and everything hides; `parent:root` says the same thing the property way.
  const model = parseKn5Buffer(buildKn5());
  assert.equal(hiddenMeshes(model, ['ROOT']).hidden.get('body_mesh')?.by, 'node');
  assert.equal(hiddenMeshes(model, ['parent:ro?']).hidden.get('body_mesh')?.by, 'parent');
  // An extended `{ ... }` filter is beyond this reader and is reported as
  // unmatched rather than half-understood.
  assert.deepEqual(hiddenMeshes(model, ['{ body_mesh & !shader:ksPerPixel }']).unmatched,
    ['{ body_mesh & !shader:ksPerPixel }']);
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
    skinOnly: [],
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

test('a config that exists and cannot be read stops the profile rather than being read as absent', async () => {
  // Absent is the common case and is not an error. Unreadable is a different
  // fact wearing the same clothes: the car has hide rules, they were not
  // applied, and the profile would say every plate is visible with nothing to
  // suggest otherwise — which is the exact silence this module was written to
  // end. A directory in place of the file is an EISDIR, which is any read
  // failure that is not "there is no such file".
  const dir = await mkdtemp(join(tmpdir(), 'lk-badcfg-'));
  await writeFile(join(dir, 'fixture.kn5'), carKn5());
  await mkdir(join(dir, 'extension', 'ext_config.ini'), { recursive: true });

  await assert.rejects(
    () => carConfigBeside(join(dir, 'fixture.kn5')),
    /could not be read/,
  );
  await assert.rejects(
    () => profileFromKn5(join(dir, 'fixture.kn5'), { id: 'fixture_car', log: () => {} }),
    /could not be read/,
  );
});

test('a bake is recorded from the name AND the structure, whatever the spelling', async () => {
  // `bake` decides how two renderers composite a two-layer material — a bake
  // multiplies straight through, a colour map is doubled first — so getting it
  // wrong is not subtle: the brightest island of a bake mistaken for colour
  // renders as a white panel, which on the reference car is the dashboard cowl.
  //
  // Both signals must agree. The NAME, because Kunos names a bake a bake; and
  // the STRUCTURE, because a bake is only ever the base layer of a material
  // with a detail layer over it. A texture called "occlusion" with nothing
  // multiplied over it is a texture with an unfortunate name.
  const { profileFromKn5 } = await import('../src/engine/profilegen.mjs');

  const bakeOf = async (label, { textureName, material }) => {
    const dir = await mkdtemp(join(tmpdir(), `lk-${label}-`));
    const at = join(dir, 'fixture.kn5');
    // buildKn5, not carKn5: this is a test about a MATERIAL, and the small
    // default body wears it as readily as the six-panel car does.
    await writeFile(at, buildKn5({ textureName, material }));
    const profile = await profileFromKn5(at, { id: 'fixture_car', log: () => {} });
    return Object.values(profile.textures).find((t) => t.file === textureName)?.bake;
  };
  const twoLayer = (txDiffuse) => ({
    shader: 'ksPerPixelMultiMap',
    props: { useDetail: 1, detailUVMultiplier: 377 },
    slots: { txDiffuse, txDetail: 'carbon.dds' },
  });

  const BAKE = 'INT_HR_Occlusion.dds';

  // Named like a bake AND the base layer of a two-layer material.
  assert.equal(await bakeOf('both', { textureName: BAKE, material: twoLayer(BAKE) }), true);

  // The structure without the name.
  assert.equal(await bakeOf('unnamed', { textureName: 'body.dds', material: twoLayer('body.dds') }),
    undefined, 'structure alone is not a bake');

  // The name without the structure — an ordinary single-layer material.
  assert.equal(await bakeOf('nolayer', { textureName: BAKE, material: { shader: 'ksPerPixel' } }),
    undefined, 'a name with nothing multiplied over it is an unfortunate name');

  // A material that asks for no detail, which is most of a MultiMap car.
  assert.equal(await bakeOf('nodetail', {
    textureName: BAKE,
    material: { shader: 'ksPerPixelMultiMap', slots: { txDetail: 'carbon.dds' } },
  }), undefined, 'useDetail is what says the second layer is real');

  // A texture whose material spells the slot in a different case is not merely
  // un-baked, it is ABSENT: profilegen keys `boundAs` by the slot's spelling
  // and looks it up by the texture entry's, so the texture is filed as "shipped
  // but never bound" and never reaches the loop this test is about. Asserted as
  // it behaves rather than as it should, because pretending otherwise here
  // would hide it — see docs/backlog.md.
  const dir = await mkdtemp(join(tmpdir(), 'lk-cased-'));
  const at = join(dir, 'fixture.kn5');
  await writeFile(at, buildKn5({ textureName: BAKE, material: twoLayer(BAKE.toLowerCase()) }));
  const cased = await profileFromKn5(at, { id: 'fixture_car', log: () => {} });
  assert.deepEqual(Object.values(cased.textures).map((t) => t.file), [],
    'a case-mismatched slot loses the texture entirely — which is the bug above this one');
});
