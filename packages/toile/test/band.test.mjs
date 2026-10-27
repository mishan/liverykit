// A band: the texels between two heights on the object, found by clipping
// every triangle in 3D. The fixture's faces unwrap proportionally, so how much
// of a face a band covers on the car is exactly how much of its rectangle it
// covers on the sheet.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseKn5Buffer, meshesUsingTexture, vertex, triangles } from 'ac-kn5';
import { bandPolygons } from '../src/engine/band.mjs';
import { polyArea, inPoly } from '../src/engine/poly.mjs';
import { carKn5, CAR } from './fixtures/kn5.mjs';

const AXES = { left: '+X', front: '+Z' };
const sheetArea = (name) => CAR.faces[name][2] * CAR.faces[name][3];
const area = (polys) => polys.reduce((a, p) => a + polyArea(p), 0);
// To single precision, which is what a kn5 stores positions and UVs in.
const close = (a, b, what) => assert.ok(Math.abs(a - b) < 1e-6, `${what}: ${a} against ${b}`);

test('a level band covers exactly its share of each side, and nothing above or below it', () => {
  const model = parseKn5Buffer(carKn5());
  const both = bandPolygons(model, { texture: CAR.texture, axes: AXES }, { height: [0.2, 0.5] });
  for (const [k, want] of Object.entries({ bottom: 0, top: CAR.height, front: CAR.length / 2, rear: -CAR.length / 2 })) close(both.frame[k], want, k);
  close(area(both.polygons), 0.3 * (sheetArea('left') + sheetArea('right')), 'both flanks');

  const left = bandPolygons(model, { texture: CAR.texture, axes: AXES }, { height: [0.2, 0.5], side: 'left' }).polygons;
  close(area(left), 0.3 * sheetArea('left'), 'the left flank alone');

  // Points inside each triangle of the car, judged by their height and the
  // face they are on, are inside the band's polygons exactly when they are
  // inside the band. Vertices would not do: each is a corner of a polygon.
  const [lo, hi] = [0.2 * CAR.height, 0.5 * CAR.height];
  const [mesh] = meshesUsingTexture(model, CAR.texture);
  let inside = 0;
  for (const t of triangles(model, mesh)) {
    const [a, b, c] = t.map((i) => vertex(model, mesh, i));
    for (const [wa, wb, wc] of [[1 / 3, 1 / 3, 1 / 3], [0.6, 0.2, 0.2], [0.2, 0.6, 0.2], [0.2, 0.2, 0.6]]) {
      const at = (k) => wa * a[k] + wb * b[k] + wc * c[k];
      if (Math.abs(at('y') - lo) < 1e-4 || Math.abs(at('y') - hi) < 1e-4) continue;
      const want = a.nx > 0.5 && at('y') > lo && at('y') < hi;
      assert.equal(left.some((p) => inPoly(p, [at('u'), at('v')])), want, `(${at('x')}, ${at('y')}, ${at('z')})`);
      inside += want;
    }
  }
  assert.ok(inside > 0, 'some point was inside the band');
});

test('a band that follows the bodyline tilts between its front and rear heights', () => {
  // Level at the front, twice as tall at the rear: on average 0.45 of the
  // flank's height, over its whole length.
  const model = parseKn5Buffer(carKn5());
  const { polygons } = bandPolygons(model, { texture: CAR.texture, axes: AXES }, { height: [0.2, 0.5], rear: [0.2, 0.8], side: 'left' });
  close(area(polygons), 0.45 * sheetArea('left'), 'tilted');
  // Reversed, the front is the tall end: the same area, the other way round.
  const reversed = bandPolygons(model, { texture: CAR.texture, axes: { left: '+X', front: '-Z' } },
    { height: [0.2, 0.5], rear: [0.2, 0.8], side: 'left' });
  close(area(reversed.polygons), 0.45 * sheetArea('left'), 'facing the other way');
  assert.notDeepEqual(reversed.polygons, polygons);
});

test('a band on an object with no wheels is measured from its own lowest point', () => {
  const model = parseKn5Buffer(carKn5({ wheels: false }));
  const { polygons, frame } = bandPolygons(model, { texture: CAR.texture, axes: AXES }, { height: [0, 0.25], side: 'right' });
  assert.equal(frame.bottom, 0);
  close(area(polygons), 0.25 * sheetArea('right'), 'the lowest quarter of the right side');
});

test('a band says what it cannot measure, rather than painting nothing', () => {
  const model = parseKn5Buffer(carKn5());
  const ask = (texture, axes, band) => () => bandPolygons(model, { texture, axes }, band);
  assert.throws(ask(CAR.texture, {}, { height: [0, 1] }), /needs the object's axes/);
  assert.throws(ask(CAR.texture, AXES, { height: [0, 'top'] }), /heights are numbers/);
  assert.throws(ask(CAR.texture, AXES, { height: [0, 1], side: 'port' }), /left, right or both/);
  assert.deepEqual(bandPolygons(model, { texture: 'none.dds', axes: AXES }, { height: [0, 1] }).polygons, []);
});
