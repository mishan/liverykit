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

/**
 * A sheet parallel to the left flank at `x`, over most of it, in small
 * triangles: occupancy samples a triangle at most twelve times along a side,
 * so one 2.4 m triangle is a sieve. A real plate or shell is small and dense.
 * `facing` is its normal's x: out from the car, or in. `uv` is where it lands
 * on the sheet: a speck by default, and big enough to be a panel of its own
 * where a test reads the sheet's own `visible`.
 */
function flankSheet(name, x, facing = 1, [u0, v0, du, dv] = [0.99, 0.99, 0.005, 0.005]) {
  const N = 40;
  const sheet = { name, verts: [], indices: [] };
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      sheet.verts.push(vert(x, 0.2 + 1.1 * (j / N), -1.2 + 2.4 * (i / N),
        u0 + du * (i / N), v0 + dv * (j / N), [facing, 0, 0]));
    }
  }
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const a = j * (N + 1) + i;
      sheet.indices.push(a, a + 1, a + N + 2, a, a + N + 2, a + N + 1);
    }
  }
  return sheet;
}

/** A flank's `visible`, from a profile generated off `kn5` (and a car config, if given). */
async function leftVisible(kn5, config, side = 'left') {
  const dir = await mkdtemp(join(tmpdir(), 'lk-occl-'));
  await writeFile(join(dir, 'fixture.kn5'), kn5);
  if (config) {
    await mkdir(join(dir, 'extension'));
    await writeFile(join(dir, 'extension', 'ext_config.ini'), config);
  }
  const p = await profileFromKn5(join(dir, 'fixture.kn5'), { id: 'fixture_car', log: () => {} });
  const panels = Object.values(p.panels).flatMap((ps) => Object.values(ps));
  const [u, v] = side === 'left' ? [0.02, 0.02] : [0.35, 0.02];
  return panels.find((q) => Math.abs(q.rect[0] - u) < 0.01 && Math.abs(q.rect[1] - v) < 0.01).visible;
}

test('a mesh the car hides stands in front of nothing when the profile measures visibility', async () => {
  // The NSX's sixteen door plates are hidden by its config and drawn by
  // nothing, and `fitment` already leaves them out of the cast. The profile
  // did not, and the plates took the doors from 88% visible to 56%, and every
  // tag and safe area that reads `visible` moved with them.
  const plate = flankSheet('PLATE_L', 0.95 + 0.03);          // a voxel out from the flank
  const bare = await leftVisible(carKn5());
  const plated = await leftVisible(carKn5({ extraMeshes: [plate] }));
  const hidden = await leftVisible(carKn5({ extraMeshes: [plate] }), '[MODEL_REPLACEMENT_...]\nHIDE=PLATE_L\n');
  assert.ok(plated < bare - 0.2, `a drawn plate covers the flank: ${plated} against ${bare}`);
  assert.ok(Math.abs(hidden - bare) < 0.02, `a hidden one covers nothing: ${hidden} against ${bare}`);
});

test('a mesh the car hides is seen by nobody, whatever its own rays say', async () => {
  // Taken out of the occluders, a hidden mesh's own island measured clear:
  // a plate the car's config hides came out visible and safe, a place to paint
  // that the game never draws.
  const x = 0.95 + 0.03, N = 40;
  const plate = { name: 'PLATE_L', verts: [], indices: [] };
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      // In the gap between the flanks on the sheet, big enough to be a panel.
      plate.verts.push(vert(x, 0.2 + 1.1 * (j / N), -1.2 + 2.4 * (i / N),
        0.315 + 0.03 * (i / N), 0.05 + 0.4 * (j / N), [1, 0, 0]));
    }
  }
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const a = j * (N + 1) + i;
      plate.indices.push(a, a + 1, a + N + 2, a, a + N + 2, a + N + 1);
    }
  }
  const dir = await mkdtemp(join(tmpdir(), 'lk-hidden-'));
  await writeFile(join(dir, 'fixture.kn5'), carKn5({ extraMeshes: [plate] }));
  await mkdir(join(dir, 'extension'));
  await writeFile(join(dir, 'extension', 'ext_config.ini'), '[MODEL_REPLACEMENT_...]\nHIDE=PLATE_L\n');
  const p = await profileFromKn5(join(dir, 'fixture.kn5'), { id: 'fixture_car', log: () => {} });
  const found = Object.values(p.panels).flatMap((ps) => Object.values(ps)).find((q) => q.source?.mesh === 'PLATE_L');
  assert.ok(found, 'the plate is a panel of the texture it wears');
  assert.equal(found.visible, 0);
  assert.equal(found.hidden, true);
});

test('a mesh behind the paint stands in front of nothing either, and one flush in front still does', async () => {
  // A door's inner shell, a bonnet's carbon liner: a few millimetres behind
  // the skin, in the same voxels, and a shared voxel stopped every ray that
  // left it. The NSX's doors went from 88% visible to 64% and its bonnet from
  // 95% to 61%, and nothing on the car had moved.
  //
  // Where the cells fall is pinned, because it decides everything here. The
  // grid starts two cells below the car's lowest x, and every face of this
  // fixture lies on a multiple of 2.5 cm, so each flank sits exactly on a
  // cell boundary and a shell behind it lands in the next cell over: no test
  // on this fixture could see the problem. A speck 3 mm outside the right
  // flank, far behind the car, makes the grid start so that the left flank
  // is 3 mm into its cell, sharing it with anything just behind or in front.
  const speck = { name: 'SPECK', indices: [0, 1, 2],
    verts: [vert(-0.953, 0, -3, 0.999, 0.999), vert(-0.953, 0.01, -3, 0.999, 0.999), vert(-0.953, 0, -3.01, 0.999, 0.999)] };
  const left = (...extra) => leftVisible(carKn5({ extraMeshes: [speck, ...extra] }));
  const bare = await left();
  const shell = await left(flankSheet('DOOR_L_INT', 0.95 - 0.002, -1));
  assert.ok(Math.abs(shell - bare) < 0.02, `a shell 2 mm behind the flank hides nothing: ${shell} against ${bare}`);
  // What ownership was introduced to catch, and must go on catching: a plate
  // a few millimetres proud, in the very voxels the flank stands in, which
  // only the exact test along the normal can now tell from the shell.
  const flush = await left(flankSheet('PLATE_L', 0.95 + 0.004));
  assert.ok(flush < bare - 0.2, `a plate 4 mm proud covers the flank: ${flush} against ${bare}`);
});

test('a motion-blur rim is measured as the rim it stands in for, not as something behind it', async () => {
  // AC swaps WHEEL_xx/RIM_xx for WHEEL_xx/RIM_BLUR_xx by wheel speed, so the
  // two are never drawn together. The NSX's rim sheet is also worn by its
  // static blur rim, 1.2 mm behind the drawn one, and 39 panels measured on
  // that copy fell from 0.87 visible to under 0.1 once the exact test along
  // the normal found the drawn rim standing in front of it.
  const drawnAt = [0.315, 0.05, 0.03, 0.2], blurAt = [0.315, 0.26, 0.03, 0.2];
  const rims = async (behind) => {
    const dir = await mkdtemp(join(tmpdir(), 'lk-blur-'));
    await writeFile(join(dir, 'fixture.kn5'), carKn5({ wrapped: [
      { name: 'RIM_LF', meshes: [flankSheet('EXT_RIM_LF', 0.98, 1, drawnAt)] },
      { name: behind.node, meshes: [flankSheet(behind.mesh, 0.98 - 0.0012, 1, blurAt)] },
    ] }));
    const p = await profileFromKn5(join(dir, 'fixture.kn5'), { id: 'fixture_car', log: () => {} });
    const all = Object.values(p.panels).flatMap((ps) => Object.values(ps));
    return [all.find((q) => q.source?.mesh === 'EXT_RIM_LF'), all.find((q) => q.source?.mesh === behind.mesh)];
  };

  const [drawn, blur] = await rims({ node: 'RIM_BLUR_LF', mesh: 'EXT_RIM_BLUR_STATIC_LF' });
  assert.ok(drawn && blur, 'both rims are panels of the sheet they wear');
  assert.ok(drawn.visible > 0.5, `the drawn rim is in plain view: ${drawn.visible}`);
  assert.ok(Math.abs(blur.visible - drawn.visible) < 0.05,
    `the blur rim is as visible as the rim it replaces: ${blur.visible} against ${drawn.visible}`);

  // The same sheet 1.2 mm behind, drawn at rest: that one IS behind the rim.
  const [, inner] = await rims({ node: 'RIM_INNER_LF', mesh: 'EXT_RIM_INNER_LF' });
  assert.ok(inner.visible < 0.1, `a drawn mesh behind the rim is covered by it: ${inner.visible}`);
});

test('a mesh touching the caster far along the ray still blocks it', async () => {
  // A ray steps over a voxel it shares with another mesh, so that a shell a
  // few millimetres behind the paint does not stop it where it starts. It did
  // so along the whole ray: anywhere on the car where another mesh came within
  // a voxel of the caster's own surface — a mirror foot, a wing mount, a
  // wheel-arch lip against the body — let that mesh's rays through.
  //
  // A floor panel inside a box of its own mesh, which it sees straight
  // through (a surface does not occlude itself), and a separate wrap 2 mm
  // outside the box, in the box's own voxels 30 cm from the floor. A speck
  // far off pins the grid's origin so every face is well inside its cell.
  const { occupancyFor, rectVisibility } = await import('../src/engine/visibility.mjs');
  const h = 0.3133, N = 12;
  // One face as a dense grid: `at(s, t)` is the point, the rect its place on the sheet.
  const face = (mesh, at, [u0, v0, du, dv], n) => {
    const base = mesh.verts.length;
    for (let j = 0; j <= N; j++) {
      for (let i = 0; i <= N; i++) mesh.verts.push(vert(...at(i / N, j / N), u0 + du * (i / N), v0 + dv * (j / N), n));
    }
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const a = base + j * (N + 1) + i;
        mesh.indices.push(a, a + 1, a + N + 2, a, a + N + 2, a + N + 1);
      }
    }
  };
  const lerp = (s) => -1 + 2 * s;
  const sheet = [0.6, 0.6, 0.3, 0.3];
  const box = (mesh, r) => {
    face(mesh, (s, t) => [lerp(s) * r, r, lerp(t) * r], sheet, [0, 1, 0]);
    face(mesh, (s, t) => [r, t * r, lerp(s) * r], sheet, [1, 0, 0]);
    face(mesh, (s, t) => [-r, t * r, lerp(s) * r], sheet, [-1, 0, 0]);
    face(mesh, (s, t) => [lerp(s) * r, t * r, r], sheet, [0, 0, 1]);
    face(mesh, (s, t) => [lerp(s) * r, t * r, -r], sheet, [0, 0, -1]);
  };
  const tub = { name: 'TUB', verts: [], indices: [] };
  face(tub, (s, t) => [lerp(s) * 0.2, 0.0037, lerp(t) * 0.2], [0.1, 0.1, 0.3, 0.3], [0, 1, 0]);
  box(tub, h);
  const wrap = { name: 'WRAP', verts: [], indices: [] };
  box(wrap, h + 0.002);
  const speck = { name: 'SPECK', indices: [0, 1, 2],
    verts: [vert(-0.5, -0.5, -0.5, 0.99, 0.99), vert(-0.49, -0.5, -0.5, 0.99, 0.99), vert(-0.5, -0.49, -0.5, 0.99, 0.99)] };

  const seen = (...others) => {
    const model = parseKn5Buffer(buildKn5({ bodyMesh: tub, extraMeshes: [speck, ...others] }));
    return rectVisibility(model, occupancyFor(model), [model.meshes[0]], [0.15, 0.15, 0.2, 0.2]).fraction;
  };
  const bare = seen();
  assert.ok(bare > 0.9, `the floor sees out through its own box: ${bare}`);
  assert.equal(seen(wrap), 0, 'and not through another mesh wrapped round it');
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

  // A texture whose material spells the slot in a different case is the same
  // file on Windows, and is kept. It used to be ABSENT: profilegen keyed
  // `boundAs` by the slot's spelling and looked it up by the texture entry's,
  // so the texture was filed as "shipped but never bound" and never reached the
  // loop this test is about.
  const dir = await mkdtemp(join(tmpdir(), 'lk-cased-'));
  const at = join(dir, 'fixture.kn5');
  await writeFile(at, buildKn5({ textureName: BAKE, material: twoLayer(BAKE.toLowerCase()) }));
  const cased = await profileFromKn5(at, { id: 'fixture_car', log: () => {} });
  const kept = Object.values(cased.textures).filter((t) => t.file === BAKE);
  assert.equal(kept.length, 1, 'a case-mismatched slot keeps its texture');
  assert.equal(kept[0].bake, true, 'and it is still recognised as a bake');
});

test('a texture the model names twice is one role, and its profile loads', async () => {
  // The Porsche 906 lists its paint as 906_EXT_Body_Diff.DDS and .dds, and
  // three fleet cars list a texture under the SAME spelling twice. Either way
  // it became two roles measuring the same meshes: the body tied with itself at
  // confidence 0, and validateProfile refused the profile, because a profile
  // naming one file twice ships it twice to a filesystem that holds it once.
  const { validateProfile } = await import('../src/profile.mjs');
  // A second mesh on a second material, which names the texture its own way,
  // so both spellings are really bound — as they are on the 906.
  const N = 6;
  const verts = [];
  const indices = [];
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) verts.push(vert(-0.3 + 0.1 * i, 0.5, -0.3 + 0.1 * j, 0.1 + 0.1 * i, 0.1 + 0.1 * j));
  }
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const a = j * (N + 1) + i;
      indices.push(a, a + 1, a + N + 2, a, a + N + 2, a + N + 1);
    }
  }

  for (const [label, other] of [['two spellings', 'BODY.DDS'], ['one spelling twice', 'body.dds']]) {
    const dir = await mkdtemp(join(tmpdir(), 'lk-twice-'));
    const at = join(dir, 'fixture.kn5');
    await writeFile(at, carKn5({
      extraMeshes: [{ name: 'SECOND', verts, indices, materialId: 1 }],
      materials: [{ name: 'BodyMat' }, { name: 'OtherMat', slots: { txDiffuse: other } }],
      extraTextures: [{ name: other }],
    }));
    const lines = [];
    const profile = await profileFromKn5(at, { id: 'c', visibility: false, log: (s) => lines.push(s) });
    const roles = Object.values(profile.textures).filter((t) => t.file.toLowerCase() === 'body.dds');
    assert.equal(roles.length, 1, `${label}: one file, one role`);
    assert.doesNotThrow(() => validateProfile(profile, label), `${label}: the profile loads`);
    assert.ok(profile.bind.body.confidence > 0,
      `${label}: the body no longer ties with itself (confidence ${profile.bind.body.confidence})`);
    assert.match(lines.join('\n'), /1 texture\(s\) are named more than once in the model/, `${label}: and it is said`);
  }
});

test('a texture the model names twice is written as most of the car\'s skins spell it', async () => {
  // A build writes the one spelling the profile names. Dropped into a stock
  // skin folder on ext4, under Proton, that holds the other spelling, it made
  // two files, and the material asking for the other drew the stock one: half
  // the body stock, and no error anywhere.
  const N = 6;
  const verts = [];
  const indices = [];
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) verts.push(vert(-0.3 + 0.1 * i, 0.5, -0.3 + 0.1 * j, 0.1 + 0.1 * i, 0.1 + 0.1 * j));
  }
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const a = j * (N + 1) + i;
      indices.push(a, a + 1, a + N + 2, a, a + N + 2, a + N + 1);
    }
  }
  const dir = await mkdtemp(join(tmpdir(), 'lk-spelled-'));
  const at = join(dir, 'fixture.kn5');
  await writeFile(at, carKn5({
    extraMeshes: [{ name: 'SECOND', verts, indices, materialId: 1 }],
    materials: [{ name: 'BodyMat' }, { name: 'OtherMat', slots: { txDiffuse: 'BODY.DDS' } }],
    extraTextures: [{ name: 'BODY.DDS' }],
  }));
  const dds = Buffer.alloc(128);
  dds.write('DDS ', 0, 'ascii');
  dds.writeUInt32LE(64, 12);
  dds.writeUInt32LE(64, 16);
  for (const [skin, file] of [['red', 'BODY.DDS'], ['blue', 'BODY.DDS'], ['green', 'body.dds']]) {
    await mkdir(join(dir, 'skins', skin), { recursive: true });
    await writeFile(join(dir, 'skins', skin, file), dds);
  }
  const bodyFiles = (profile) => Object.values(profile.textures).map((t) => t.file).filter((f) => f.toLowerCase() === 'body.dds');

  const lines = [];
  const skinned = await profileFromKn5(at, { id: 'c', visibility: false, skinsDir: join(dir, 'skins'), log: (s) => lines.push(s) });
  assert.deepEqual(bodyFiles(skinned), ['BODY.DDS'], 'the spelling two of the three skins use');
  assert.match(lines.join('\n'), /BODY\.DDS is written: the spelling 2 of 3 skin\(s\) use/);

  // With no skins to ask, the model's first, and said so.
  lines.length = 0;
  const bare = await profileFromKn5(at, { id: 'c', visibility: false, log: (s) => lines.push(s) });
  assert.deepEqual(bodyFiles(bare), ['body.dds']);
  assert.match(lines.join('\n'), /body\.dds is written: the model's first; pass --skins/);
});
