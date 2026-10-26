// A second format. A glTF of the synthetic car must be the same car as the
// kn5 it was written from, vertex for vertex, so everything measured from one
// can be measured from the other.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseKn5Buffer, vertex as kn5Vertex, triangles as kn5Triangles } from 'ac-kn5';
import { parseGlb, loadModel, vertex, triangles, meshTraits, meshesWearing, axesFromWheels } from '../packages/toile/src/model.mjs';
import { carKn5, CAR } from './fixtures/kn5.mjs';
import { glbFrom, packer, writeGlb } from './fixtures/gltf.mjs';

test('the car read from glTF is the car its kn5 describes', () => {
  const kn5 = parseKn5Buffer(carKn5());
  const glb = parseGlb(glbFrom(kn5, { vertex: kn5Vertex, triangles: kn5Triangles }));
  assert.equal(glb.format.name, 'glTF');
  assert.deepEqual(glb.meshes.map((m) => [m.name, m.vertexCount]), kn5.meshes.map((m) => [m.name, m.vertexCount]));
  kn5.meshes.forEach((k, n) => {
    const g = glb.meshes[n];
    assert.deepEqual(triangles(glb, g), triangles(kn5, k), k.name);
    for (let i = 0; i < k.vertexCount; i++) {
      const a = vertex(kn5, k, i), b = vertex(glb, g, i);
      for (const f of ['x', 'y', 'z', 'nx', 'ny', 'nz', 'u', 'v']) {
        assert.ok(Math.abs(a[f] - b[f]) < 1e-6, `${k.name} vertex ${i} ${f}: ${a[f]} and ${b[f]}`);
      }
    }
    for (const t of ['blends', 'alphaTest', 'diffuse', 'glass', 'blur', 'lod']) {
      assert.deepEqual(meshTraits(glb, g)[t], meshTraits(kn5, k)[t], `${k.name} ${t}`);
    }
  });
  assert.deepEqual(meshesWearing(glb, CAR.texture.toUpperCase()).map((m) => m.name),
    meshesWearing(kn5, CAR.texture).map((m) => m.name), 'found by its paint, ignoring case');
  const [w, k] = [axesFromWheels(glb), axesFromWheels(kn5)];
  assert.deepEqual([w.left, w.front], [k.left, k.front], 'faces the way its wheels say');
  assert.ok(Math.abs(w.wheelbase - CAR.wheelbase) < 1e-6 && Math.abs(w.trackWidth - CAR.track) < 1e-6);
});

test('a node\'s translation, rotation and scale place the mesh under it', () => {
  // One triangle under a node turned a quarter about Y, doubled, and moved
  // 5 m along Z, under a parent moved 1 m up.
  const pack = packer();
  const POSITION = pack.add(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]), 'VEC3');
  const NORMAL = pack.add(new Float32Array([1, 0, 0, 1, 0, 0, 1, 0, 0]), 'VEC3');
  const { fields, bin } = pack.finish();
  const s = Math.SQRT1_2;
  const model = parseGlb(writeGlb({
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ name: 'up', translation: [0, 1, 0], children: [1] },
      { name: 'part', mesh: 0, translation: [0, 0, 5], rotation: [0, s, 0, s], scale: [2, 2, 2] }],
    meshes: [{ name: 'tri', primitives: [{ attributes: { POSITION, NORMAL } }] }],
    ...fields,
  }, bin));
  const [mesh] = model.meshes;
  assert.equal(mesh.path, 'up/part');
  const near = (v, want) => want.every((x, i) => Math.abs([v.x, v.y, v.z][i] - x) < 1e-6);
  // A quarter turn about +Y takes +X to -Z.
  assert.ok(near(vertex(model, mesh, 0), [0, 1, 3]), JSON.stringify(vertex(model, mesh, 0)));
  assert.ok(near(vertex(model, mesh, 1), [0, 3, 5]), JSON.stringify(vertex(model, mesh, 1)));
  assert.ok(near(vertex(model, mesh, 2), [2, 1, 5]), JSON.stringify(vertex(model, mesh, 2)));
  const n = vertex(model, mesh, 0);
  assert.ok(Math.abs(n.nz + 2) < 1e-6 && Math.abs(n.nx) < 1e-6, 'a normal turns with it, and is not moved');
  assert.deepEqual(triangles(model, mesh), [[0, 1, 2]], 'no indices: the vertices in order');
});

test('what this cannot read is refused by name, not read past', () => {
  const tri = () => {
    const pack = packer();
    const POSITION = pack.add(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 'VEC3');
    return { pack, POSITION };
  };
  assert.throws(() => parseGlb(Buffer.from('not a model at all')), /not a binary glTF/);
  assert.throws(() => parseGlb(writeGlb({ asset: { version: '2.0' }, extensionsRequired: ['KHR_draco_mesh_compression'] })),
    /KHR_draco_mesh_compression/);
  const { pack, POSITION } = tri();
  const { fields, bin } = pack.finish();
  assert.throws(() => parseGlb(writeGlb({
    asset: { version: '2.0' }, nodes: [{ mesh: 0 }],
    meshes: [{ name: 'wire', primitives: [{ attributes: { POSITION }, mode: 1 }] }], ...fields,
  }, bin)), /not a list of triangles/);
});

test('a model is read as its extension says', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lk-gltf-'));
  try {
    const kn5 = parseKn5Buffer(carKn5());
    await writeFile(join(dir, 'car.glb'), glbFrom(kn5, { vertex: kn5Vertex, triangles: kn5Triangles }));
    await writeFile(join(dir, 'car.kn5'), carKn5());
    assert.equal((await loadModel(join(dir, 'car.glb'))).format.name, 'glTF');
    assert.equal((await loadModel(join(dir, 'car.kn5'))).format, undefined, 'a kn5 as ac-kn5 reads it');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
