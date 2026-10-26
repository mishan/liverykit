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
import { glbFrom, teapotGlb, TEAPOT } from './fixtures/gltf.mjs';

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
});
