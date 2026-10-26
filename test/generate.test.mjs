// A profile from a model with nothing else to go on. The car must measure the
// same through either format, and an object that is not a car must measure
// at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseKn5Buffer, vertex, triangles } from 'ac-kn5';
import sharp from 'sharp';
import { profileFromModel } from '../packages/toile/src/generate.mjs';
import { imageHeader } from '../packages/toile/src/images.mjs';
import { validateProfile } from '../src/profile.mjs';
import { profileFromKn5 } from '../src/engine/profilegen.mjs';
import { carKn5, CAR } from './fixtures/kn5.mjs';
import { glbFrom, teapotGlb, TEAPOT, packer, writeGlb } from './fixtures/gltf.mjs';

async function inDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'lk-generate-'));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('the car profiles the same from its glTF as from its kn5', () => inDir(async (dir) => {
  const bytes = carKn5();
  const kn5 = parseKn5Buffer(bytes, { keepTextureData: true });
  await writeFile(join(dir, 'car.kn5'), bytes);
  await writeFile(join(dir, 'car.glb'), glbFrom(kn5, { vertex, triangles }));
  // Its paint beside it, as the kn5 embeds it.
  await writeFile(join(dir, CAR.texture), kn5.textures[0].data);
  const fromKn5 = await profileFromKn5(join(dir, 'car.kn5'), { log: () => {} });
  const fromGlb = await profileFromModel(join(dir, 'car.glb'));
  assert.deepEqual(Object.keys(fromGlb.textures), Object.keys(fromKn5.textures));
  for (const [role, t] of Object.entries(fromKn5.textures)) {
    assert.deepEqual([fromGlb.textures[role].width, fromGlb.textures[role].height], [t.width, t.height], role);
  }
  // A seam's `here` is a segment, and which end is listed first falls out of
  // a tie between coordinates the two formats store a float's last bit apart.
  const canonical = (panels) => JSON.parse(JSON.stringify(panels), (k, v) => (k === 'here' ? [...v].sort() : v));
  assert.deepEqual(canonical(fromGlb.panels), canonical(fromKn5.panels));
  assert.deepEqual(fromGlb.calibration.axes, fromKn5.calibration.axes);
  assert.equal(fromGlb.calibration.method, 'glTF');
}));

test('a teapot gets panels, seams and visibility', () => inDir(async (dir) => {
  await writeFile(join(dir, 'teapot.glb'), await teapotGlb());
  const p = await profileFromModel(join(dir, 'teapot.glb'));
  assert.doesNotThrow(() => validateProfile(p));
  assert.deepEqual(Object.values(p.textures).map((t) => [t.file, t.width, t.height]),
    [[TEAPOT.image, TEAPOT.size, TEAPOT.size]]);
  const panels = Object.values(p.panels.teapot);
  assert.equal(panels.length, 2, 'the body and the lid');
  const [pot, lid] = [panels.find((q) => q.source.mesh === 'pot'), panels.find((q) => q.source.mesh === 'lid')];
  assert.ok(pot && lid);
  const name = (q) => Object.keys(p.panels.teapot).find((n) => p.panels.teapot[n] === q);
  assert.deepEqual(pot.adjacent, [name(lid)], 'the lid sits on the body');
  assert.ok(pot.seams?.[name(lid)] && lid.seams?.[name(pot)], 'and artwork can cross from one to the other');
  for (const q of panels) {
    assert.ok(q.visible > 0 && q.visible <= 1, `${q.source.mesh} is seen from outside: ${q.visible}`);
    assert.ok(q.tags?.length, `${q.source.mesh} is tagged`);
  }
  assert.deepEqual(p.calibration.axes, { left: '+X', front: '+Z', confident: false, from: 'mesh names' },
    'nothing to say which way it faces, and it says so');
}));

test('a kn5 paints only what an Assetto Corsa skin can carry', () => inDir(async (dir) => {
  // A skin is DDS or PNG. A JPEG a kn5 embeds would be written as DDS bytes
  // under a .jpg name, which loads and is wrong; it is not offered as paint.
  const jpeg = await sharp({ create: { width: 64, height: 32, channels: 3, background: '#888' } }).jpeg().toBuffer();
  await writeFile(join(dir, 'car.kn5'), carKn5({ textureName: 'body.jpg', textureData: jpeg }));
  const p = await profileFromKn5(join(dir, 'car.kn5'), { log: () => {} });
  assert.deepEqual(Object.values(p.textures).map((t) => t.file), []);
}));

test('a model that cannot be measured honestly says so', () => inDir(async (dir) => {
  // Encrypted: every image is a 1x1 stand-in, and only liverykit's generator
  // knows where the real sizes are.
  await writeFile(join(dir, 'locked.kn5'), carKn5({ encrypted: true, placeholderTexture: true }));
  await assert.rejects(profileFromModel(join(dir, 'locked.kn5')), /encrypted.*--from-kn5/s);
  // Two images a folder apart are one file in a skin.
  const pack = packer();
  const POSITION = pack.add(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 'VEC3');
  const TEXCOORD_0 = pack.add(new Float32Array([0, 0, 1, 0, 0, 1]), 'VEC2');
  const { fields, bin } = pack.finish();
  const prim = (material) => ({ attributes: { POSITION, TEXCOORD_0 }, material });
  await writeFile(join(dir, 'twins.glb'), writeGlb({
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0, 1] }],
    nodes: [{ mesh: 0 }, { mesh: 1 }], meshes: [{ primitives: [prim(0)] }, { primitives: [prim(1)] }],
    materials: [0, 1].map((i) => ({ pbrMetallicRoughness: { baseColorTexture: { index: i } } })),
    textures: [{ source: 0 }, { source: 1 }], images: [{ uri: 'body/paint.png' }, { uri: 'wheels/paint.png' }],
    ...fields,
  }, bin));
  const twins = await profileFromModel(join(dir, 'twins.glb'));
  assert.deepEqual(Object.keys(twins.textures), []);
  assert.match(twins.doNotPaint.map((d) => d.reason).join(), /2 images are named paint\.png/);
  // A color multiplied over the image: paintable, and said to be tinted.
  await writeFile(join(dir, 'red.glb'), await teapotGlb({ baseColorFactor: [1, 0, 0, 1] }));
  const red = await profileFromModel(join(dir, 'red.glb'));
  assert.match(red.textures.teapot.notes, /multiplies this image by a color/);
}));

test('an image\'s size is read from its own header', async () => {
  const raw = { create: { width: 37, height: 21, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 0.5 } } };
  const cases = {
    png: [(s) => s.png(), 'PNG', true],
    jpeg: [(s) => s.jpeg(), 'JPEG', false],
    webp: [(s) => s.webp(), 'WEBP', true],
    'lossless webp': [(s) => s.webp({ lossless: true }), 'WEBP', true],
  };
  for (const [what, [encode, fourCC, alpha]] of Object.entries(cases)) {
    const h = imageHeader(what, await encode(sharp(raw)).toBuffer());
    assert.deepEqual([h?.width, h?.height, h?.fourCC, h?.alpha], [37, 21, fourCC, alpha], what);
  }
  assert.equal(imageHeader('x', Buffer.from('not an image, but long enough to be read as one')), null);
  // A DDS cut short has no size to read, rather than a read past its end.
  const dds = Buffer.alloc(40); dds.write('DDS ', 0, 'ascii');
  assert.equal(imageHeader('short.dds', dds), null);
  // A JPEG may pad a marker with fill bytes.
  const plain = await sharp(raw).jpeg().toBuffer();
  const padded = Buffer.concat([plain.subarray(0, 2), Buffer.from([0xff]), plain.subarray(2)]);
  assert.deepEqual([imageHeader('padded', padded)?.width, imageHeader('padded', padded)?.height], [37, 21]);
});
