// A band: the texels between two heights on the object, found by clipping
// every triangle in 3D. The fixture's faces unwrap proportionally, so how much
// of a face a band covers on the car is exactly how much of its rectangle it
// covers on the sheet.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseKn5Buffer, meshesUsingTexture, vertex, triangles } from 'ac-kn5';
import { bandPolygons } from '../src/engine/band.mjs';
import { polyArea, inPoly } from '../src/engine/poly.mjs';
import { carKn5, vert, CAR } from './fixtures/kn5.mjs';

const AXES = { left: '+X', front: '+Z' };
const sheetArea = (name) => CAR.faces[name][2] * CAR.faces[name][3];
const area = (polys) => polys.reduce((a, p) => a + polyArea(p), 0);
// To single precision, which is what a kn5 stores positions and UVs in.
const close = (a, b, what) => assert.ok(Math.abs(a - b) < 1e-6, `${what}: ${a} against ${b}`);

/**
 * Points inside every triangle of the body mesh, each judged by `want` from
 * its position and normal, must be inside the band's polygons exactly when
 * `want` says so. Vertices would not do: each is a corner of a polygon. Points
 * within `edge` of the band's boundary are left out, being on it.
 */
function membership(model, polygons, want, edge) {
  const [mesh] = meshesUsingTexture(model, CAR.texture);
  let inside = 0;
  for (const t of triangles(model, mesh)) {
    const [a, b, c] = t.map((i) => vertex(model, mesh, i));
    for (const [wa, wb, wc] of [[1 / 3, 1 / 3, 1 / 3], [0.6, 0.2, 0.2], [0.2, 0.6, 0.2], [0.2, 0.2, 0.6]]) {
      const q = Object.fromEntries(['x', 'y', 'z', 'u', 'v'].map((k) => [k, wa * a[k] + wb * b[k] + wc * c[k]]));
      if (edge(q) < 1e-4) continue;
      const w = want(q, a);
      assert.equal(polygons.some((p) => inPoly(p, [q.u, q.v])), w, `(${q.x}, ${q.y}, ${q.z})`);
      inside += w;
    }
  }
  assert.ok(inside > 0, 'some point was inside the band');
}

test('a level band covers exactly its share of each side, and nothing above or below it', () => {
  const model = parseKn5Buffer(carKn5());
  const both = bandPolygons(model, { texture: CAR.texture, axes: AXES }, { height: [0.2, 0.55] });
  for (const [k, want] of Object.entries({ bottom: 0, top: CAR.height, front: CAR.length / 2, rear: -CAR.length / 2 })) close(both.frame[k], want, k);
  close(area(both.polygons), 0.35 * (sheetArea('left') + sheetArea('right')), 'both flanks');
  assert.deepEqual(both.notes, []);

  // The top edge falls between the fixture's grid lines, so a cut that did not
  // carry the second plane's distance through the first would show here.
  const left = bandPolygons(model, { texture: CAR.texture, axes: AXES }, { height: [0.2, 0.55], side: 'left' }).polygons;
  close(area(left), 0.35 * sheetArea('left'), 'the left flank alone');
  const [lo, hi] = [0.2 * CAR.height, 0.55 * CAR.height];
  membership(model, left, (q, a) => a.nx > 0.5 && q.y > lo && q.y < hi, (q) => Math.min(Math.abs(q.y - lo), Math.abs(q.y - hi)));
});

test('a band thinner than a row of triangles is cut by both planes in one triangle', () => {
  // A pinstripe: both of its edges cross the same triangles, so the second cut
  // runs along edges the first one made, and lands right only if the first
  // carried the second plane's distance with it.
  const model = parseKn5Buffer(carKn5());
  const { polygons } = bandPolygons(model, { texture: CAR.texture, axes: AXES }, { height: [0.36, 0.38], side: 'left' });
  close(area(polygons), 0.02 * sheetArea('left'), 'a pinstripe');
});

test('a band leaves out the cockpit the game draws instead, and the blurred wheels', () => {
  // Both wear the body's sheet here, and stand above the roof: counted, they
  // would move the top the heights are fractions of, and take paint.
  const raised = (name, u0) => ({ name, indices: [0, 1, 2, 0, 2, 3], verts: [
    vert(0.9, 3, -0.5, u0, 0.985, [1, 0, 0]), vert(0.9, 3, 0.5, u0 + 0.004, 0.985, [1, 0, 0]),
    vert(0.9, 3.5, 0.5, u0 + 0.004, 0.995, [1, 0, 0]), vert(0.9, 3.5, -0.5, u0, 0.995, [1, 0, 0])] });
  const model = parseKn5Buffer(carKn5({ extraMeshes: [raised('RIM_BLUR_LF', 0.7)], wrapped: [{ name: 'COCKPIT_HR', meshes: [raised('DASH', 0.75)] }] }));
  const { polygons, frame } = bandPolygons(model, { texture: CAR.texture, axes: AXES }, { height: [0, 1], side: 'left' });
  close(frame.top, CAR.height, 'the top');
  assert.ok(!polygons.some((p) => p.some(([, v]) => v > 0.98)), 'nothing on their part of the sheet');
});

test('a band that follows the bodyline tilts from its front height to its rear one', () => {
  // Low at the front, tall at the rear: on average 0.45 of the flank's height.
  const model = parseKn5Buffer(carKn5());
  const band = { height: [0.2, 0.5], rear: [0.2, 0.8], side: 'left' };
  const top = (front) => (q) => CAR.height * (0.5 + 0.3 * (CAR.length / 2 - front * q.z) / CAR.length);
  for (const [front, axes] of [[1, AXES], [-1, { left: '+X', front: '-Z' }]]) {
    const { polygons } = bandPolygons(model, { texture: CAR.texture, axes }, band);
    close(area(polygons), 0.45 * sheetArea('left'), `facing ${axes.front}`);
    // Which end is which, point by point: the tall end is the rear.
    const hi = top(front), lo = 0.2 * CAR.height;
    membership(model, polygons, (q, a) => a.nx > 0.5 && q.y > lo && q.y < hi(q),
      (q) => Math.min(Math.abs(q.y - lo), Math.abs(q.y - hi(q))));
  }
});

test('a side is the faces that look out from that half, within 75 degrees of sideways', () => {
  // On the left half, three faces looking left: one 30 degrees off flat, on
  // the side; one 10 degrees off, a bonnet; and one on the right half, the
  // inside of the far door. And one looking left with no normals at all.
  // Each a quad tilted `deg` off flat, on its own small rectangle of the sheet.
  const slope = (name, deg, x, u0, n) => {
    const s = Math.sin(deg * Math.PI / 180), c = Math.cos(deg * Math.PI / 180);
    const at = (a, z, u, v) => vert(x + a * c, 0.6 - a * s, z, u, v, n ?? [s, c, 0]);
    return { name, indices: [0, 1, 2, 0, 2, 3],
      verts: [at(0, -0.5, u0, 0.985), at(0, 0.5, u0 + 0.004, 0.985), at(0.3, 0.5, u0 + 0.004, 0.995), at(0.3, -0.5, u0, 0.995)] };
  };
  const model = parseKn5Buffer(carKn5({ extraMeshes: [
    slope('SIDE_30', 30, 0.4, 0.70), slope('BONNET_10', 10, 0.2, 0.75), slope('INNER', 30, -0.6, 0.80), slope('UNSAID', 30, 0.5, 0.85, [0, 0, 0]),
  ] }));
  const named = (name) => {
    const [mesh] = model.meshes.filter((m) => m.name === name);
    const tri = triangles(model, mesh)[0].map((i) => vertex(model, mesh, i));
    return [(tri[0].u + tri[1].u + tri[2].u) / 3, (tri[0].v + tri[1].v + tri[2].v) / 3];
  };
  const { polygons, notes } = bandPolygons(model, { texture: CAR.texture, axes: AXES }, { height: [0, 1], side: 'left' });
  const has = (name) => polygons.some((p) => inPoly(p, named(name)));
  assert.deepEqual([has('SIDE_30'), has('BONNET_10'), has('INNER'), has('UNSAID')], [true, false, false, false]);
  assert.match(notes.join('\n'), /2 sideways face\(s\) of body\.dds have normals that do not say which way they look/);
});

test('a band says what it cannot measure, rather than painting nothing', () => {
  const model = parseKn5Buffer(carKn5());
  const ask = (texture, axes, band) => () => bandPolygons(model, { texture, axes }, band);
  assert.throws(ask(CAR.texture, {}, { height: [0, 1] }), /needs the object's axes/);
  assert.throws(ask(CAR.texture, AXES, { height: [0, 1], side: 'port' }), /left, right or both/);
  for (const height of [[0, 'top'], [0.6, 0.3], [0.5, 1.5], [0.3]]) {
    assert.throws(ask(CAR.texture, AXES, { height }), /fractions of the surface's height from 0 to 1/, JSON.stringify(height));
  }
  assert.throws(ask(CAR.texture, AXES, { height: [0.2, 0.5], rear: [0.6, 0.4] }), /bottom under the top/, 'a tilt that crosses');
  assert.throws(ask('none.dds', AXES, { height: [0, 1] }), /no mesh drawn outside the cockpit wears none\.dds/);
});

// --- drawn --------------------------------------------------------------------

async function fixtureCar() {
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { profileFromModel } = await import('../src/generate.mjs');
  const { registerPack, getPack } = await import('../src/registry.mjs');
  try { getPack('core'); } catch { registerPack((await import('../src/packs/core.mjs')).default); }
  const dir = await mkdtemp(join(tmpdir(), 'toile-band-'));
  const path = join(dir, 'car.kn5');
  await writeFile(path, carKn5());
  const profile = await profileFromModel(path, { log: () => {}, visibility: false });
  const role = Object.keys(profile.textures).find((r) => profile.textures[r].file === CAR.texture);
  return { profile, role, model: parseKn5Buffer(carKn5()) };
}

const render = async ({ profile, role, model }, regions) => {
  const { renderTexture } = await import('../src/render.mjs');
  const { resolveTreatments } = await import('../src/registry.mjs');
  const notes = [];
  const layers = renderTexture({ profile, role, regions, background: '#000000', treatments: resolveTreatments(['core']),
    palette: {}, rng: () => 0.5, font: 'sans-serif', tokens: {}, regionNotes: notes, model });
  return { layers, notes };
};

test('a band is drawn on exactly its texels, as one path', async () => {
  const sharp = (await import('sharp')).default;
  const car = await fixtureCar();
  const { layers, notes } = await render(car, [{ id: 'sweep', treatment: 'fill', color: '#ff0000', band: { height: [0.2, 0.55], side: 'left' } }]);
  assert.deepEqual(notes, []);
  assert.equal((layers.base.match(/<clipPath id="lk-band-\d+"><path /g) ?? []).length, 1, 'one path, not a polygon a triangle');
  // The fixture's sheet is 32 by 64; drawn at that size its edges are all blur.
  const { data, info } = await sharp(Buffer.from(layers.base), { density: 72 * 8 }).raw().toBuffer({ resolveWithObject: true });
  const red = (u, v) => data[(Math.floor(v * info.height) * info.width + Math.floor(u * info.width)) * info.channels] > 200;
  const [x, y, w, h] = CAR.faces.left;
  // Across the left flank's rectangle, the band is the part between 0.2 and
  // 0.55 of its height; which way up the face is unwrapped is the fixture's,
  // so the share is counted rather than its position assumed.
  let inBand = 0, cells = 0;
  for (let i = 0.05; i < 1; i += 0.1) for (let j = 0.05; j < 1; j += 0.1) { cells++; inBand += red(x + w * i, y + h * j); }
  assert.ok(Math.abs(inBand / cells - 0.35) <= 0.1, `${inBand} of ${cells} cells`);
  assert.ok(!red(...CAR.faces.right.slice(0, 2).map((c, k) => c + CAR.faces.right[k + 2] / 2)), 'the right flank is not painted');
});

test('a band without the model is said not to be drawn, and one with a panel is refused', async () => {
  const car = await fixtureCar();
  const { layers, notes } = await render({ ...car, model: null }, [{ id: 'sweep', treatment: 'fill', color: '#ff0000', band: { height: [0.2, 0.5] } }]);
  assert.match(notes.map((n) => n.text).join('\n'), /sweep: is a band, placed by height on the car, and finding its texels needs the car's model; not drawn/);
  assert.doesNotMatch(layers.base, /ff0000/);
  await assert.rejects(render(car, [{ id: 'x', treatment: 'fill', panel: 'left_mid', band: { height: [0, 1] } }]), /cannot also be placed on a panel/);
  await assert.rejects(render(car, [{ id: 'x', treatment: 'text', text: 'A', band: { height: [0, 1] } }]), /need a panel to read on/);
});

test('the check knows a band, and says it does not measure one yet', async () => {
  const { fitment } = await import('../src/fitment.mjs');
  const car = await fixtureCar();
  // By role under `paint`: toile alone has no vocabulary to say what `body` is.
  const design = { name: 'd', packs: ['core'], paint: { [car.role]: { regions: [{ id: 'sweep', treatment: 'fill', color: 'red', band: { height: [0.2, 0.5] } }] } } };
  const report = fitment(design, car.profile, null, { model: null });
  assert.deepEqual(report.findings.filter((f) => f.ids?.includes('sweep')).map((f) => f.kind), []);
  assert.ok(report.notChecked.some((n) => /sweep: a band, placed by height on the car/.test(n)), report.notChecked.join('\n'));
});
