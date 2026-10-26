// Where two islands meet on the car, and how to continue artwork across.
//
// `adjacent` says two islands touch. It does not say WHERE in each island's
// texture the touching edge is, or which way round — and that is what a
// stripe running from the door onto the rear quarter needs to know. The
// seam map answers it from the vertices the two islands share: the same
// point on the car, two sets of texture coordinates.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseKn5Buffer, meshesUsingTexture } from 'ac-kn5';
import { findIslands, findAdjacency, findSeams, nameIslands, carBounds } from '../src/engine/islands.mjs';
import { axesFromWheels } from 'ac-kn5';
import { buildKn5, carKn5, vert, CAR } from './fixtures/kn5.mjs';

function fixture() {
  const m = parseKn5Buffer(carKn5());
  const islands = findIslands(m, meshesUsingTexture(m, 'body.dds'));
  nameIslands(islands, axesFromWheels(m), carBounds(m));
  const adj = findAdjacency(m, islands);
  const seams = findSeams(m, islands, adj);
  // By the rect the fixture states, not by the generated name: the namer
  // calls the left face `left_mid`, and that is its business.
  const face = (name) => {
    const [x, y] = CAR.faces[name];
    return islands.find((i) => Math.abs(i.rect[0] - x) < 0.01 && Math.abs(i.rect[1] - y) < 0.01);
  };
  return { m, islands, seams, face };
}

const apply = ([a, b, c, d, e, f], [x, y]) => [a * x + c * y + e, b * x + d * y + f];

test('a seam maps texture coordinates across the edge two islands share, in metres', () => {
  const { islands, seams, face } = fixture();
  // The fixture's left face is x = +0.95, its roof y = 1.5; they share the
  // edge along the top of the left face. In the left face's island, v runs
  // with height (the fixture writes v = ry + t*rh with t up the face), so the
  // top edge is the island's far v edge; on the roof, u runs right-to-left
  // across the car, so the same edge is the roof's far u edge.
  const left = face('left'), roof = face('roof');
  assert.ok(left && roof, `islands by rect: ${islands.map((i) => i.rect)}`);
  const seam = seams.get(left.name)?.get(roof.name);
  assert.ok(seam, 'left and roof touch, so there is a seam between them');
  assert.ok(seam.points >= 3, `shared vertices along the edge: ${seam.points}`);
  assert.ok(seam.rmsMm < 1, `a box unfolds exactly; residual ${seam.rmsMm} mm`);

  // A point 10 cm past the top of the left face, half way along it, is a point
  // 10 cm in from the roof's left edge, half way along the roof.
  const [lx, ly, lw, lh] = CAR.faces.left;
  const [rx, ry, rw, rh] = CAR.faces.roof;
  const over = 0.10 / CAR.height * lh;                  // 10 cm, in left-face v
  const mapped = apply(seam.matrix, [lx + lw / 2, ly + lh + over]);
  const expectU = rx + rw - 0.10 / CAR.width * rw;      // 10 cm in from the roof's far u edge
  assert.ok(Math.abs(mapped[0] - expectU) < 0.002, `u: got ${mapped[0]}, want ${expectU}`);
  assert.ok(Math.abs(mapped[1] - (ry + rh / 2)) < 0.002, `v: got ${mapped[1]}, want ${ry + rh / 2}`);

  // And the seam itself is a fixed line: a point ON the edge maps onto the
  // roof's edge, not past it.
  const onEdge = apply(seam.matrix, [lx + lw * 0.25, ly + lh]);
  assert.ok(Math.abs(onEdge[0] - (rx + rw)) < 0.002, `edge stays on the edge: ${onEdge[0]}`);
});

test('the map runs both ways and the two agree', () => {
  const { seams, face } = fixture();
  const left = face('left'), roof = face('roof');
  const there = seams.get(left.name).get(roof.name).matrix;
  const back = seams.get(roof.name).get(left.name).matrix;
  const p = [0.1, 0.3];
  const round = apply(back, apply(there, p));
  assert.ok(Math.hypot(round[0] - p[0], round[1] - p[1]) < 1e-4, `round trip ${round}`);
});

test('islands that do not touch have no seam', () => {
  const { seams, face } = fixture();
  const left = face('left'), right = face('right');
  assert.equal(seams.get(left.name)?.get(right.name), undefined);
});

// ---------------------------------------------------------------------------
// From seams to placements.
// ---------------------------------------------------------------------------

test('an island outline is its boundary, simplified, in sheet fractions', async () => {
  const { islandOutline } = await import('../src/engine/islands.mjs');
  const { m, face } = fixture();
  const left = face('left');
  const outline = islandOutline(m, left);
  // A rectangular face: four corners, whatever the mesh subdivision.
  assert.equal(outline.length, 4, `corners: ${JSON.stringify(outline)}`);
  const [x, y, w, h] = CAR.faces.left;
  const has = (u, v) => outline.some(([a, b]) => Math.abs(a - u) < 0.002 && Math.abs(b - v) < 0.002);
  assert.ok(has(x, y) && has(x + w, y) && has(x, y + h) && has(x + w, y + h), JSON.stringify(outline));
});

test('a seam records where it sits in the sheet', () => {
  const { seams, face } = fixture();
  const seam = seams.get(face('left').name).get(face('roof').name);
  // The left face's top edge: a straight line, so two points, the full
  // width, at v = top.
  const [x, y, w, h] = CAR.faces.left;
  assert.equal(seam.here.length, 2, `a straight seam simplifies to its ends: ${JSON.stringify(seam.here)}`);
  const us = seam.here.map((p) => p[0]).sort((a, b) => a - b);
  assert.ok(Math.abs(us[0] - x) < 0.002 && Math.abs(us[1] - (x + w)) < 0.002, `along u: ${JSON.stringify(seam.here)}`);
  assert.ok(seam.here.every((p) => Math.abs(p[1] - (y + h)) < 0.002), `at the top: ${JSON.stringify(seam.here)}`);
});

// ---------------------------------------------------------------------------
// Drawing across a seam.
// ---------------------------------------------------------------------------

test('a shared vertex is found however the grid happens to fall between two cells', () => {
  // The spatial hash buckets vertices at the tolerance, and two points 0.2 mm
  // apart — well inside the 4 mm this is willing to call one vertex — land in
  // different buckets whenever a cell boundary runs between them.
  // `findAdjacency` probes the 27 cells around each point and calls them
  // adjacent; `findSeams` compared one bucket and found nothing, so the two
  // disagreed: islands that touch, with no map to cross between them, and a
  // band that stopped at the seam for no visible reason.
  const quad = (verts) => ({ verts, indices: [0, 1, 2, 1, 3, 2] });
  const cell = 0.004;
  const zA = cell * 1.475;                 // rounds into cell 1
  const zB = cell * 1.525;                 // rounds into cell 2, 0.2 mm away
  const a = quad([
    vert(0, 0, -1, 0.05, 0.05), vert(1, 0, -1, 0.45, 0.05),
    vert(0, 0, zA, 0.05, 0.45), vert(1, 0, zA, 0.45, 0.45),
  ]);
  const b = quad([
    vert(0, 0, zB, 0.55, 0.45), vert(1, 0, zB, 0.95, 0.45),
    vert(0, 0, 1, 0.55, 0.05), vert(1, 0, 1, 0.95, 0.05),
  ]);
  const m = parseKn5Buffer(buildKn5({
    bodyMesh: { name: 'panel_a', ...a },
    extraMeshes: [{ name: 'panel_b', ...b }],
  }));
  const islands = findIslands(m, meshesUsingTexture(m, 'body.dds'), { minVertices: 3 });
  assert.equal(islands.length, 2, 'two meshes, two islands');
  for (const isl of islands) isl.name = isl.rect[0] < 0.5 ? 'A' : 'B';

  const adj = findAdjacency(m, islands);
  assert.ok(adj.get('A').has('B'), 'they touch, to within the tolerance');
  const seams = findSeams(m, islands, adj);
  const seam = seams.get('A')?.get('B');
  assert.ok(seam, 'and touching islands have a map between them');
  assert.ok(seam.rmsMm < 1, `the two edges coincide; residual ${seam?.rmsMm} mm`);
});

test('the outer boundary is the biggest loop, not the one with the most corners', async () => {
  // A door is a few long straight edges around a densely tessellated window
  // cut-out. Picked by vertex count, the "outline" became the hole — and
  // artwork clipped to it was clipped to exactly the part of the panel it must
  // not touch, and to nothing else.
  const { islandOutline } = await import('../src/engine/islands.mjs');
  const corners = [[0.9, 0.9], [0.1, 0.9], [0.1, 0.1], [0.9, 0.1]];   // one per 90 degree sector
  const N = 16, R = 0.2;
  const hole = [...Array(N)].map((_, i) => {
    const a = ((i + 0.5) * 2 * Math.PI) / N;
    return [0.5 + R * Math.cos(a), 0.5 + R * Math.sin(a)];
  });
  const sector = (i) => Math.floor((i + 0.5) / (N / 4));
  const uv = [...hole, ...corners];
  const verts = uv.map(([u, v]) => vert(u * 2, 0, v * 2, u, v));
  const C = (s) => N + s;
  const indices = [];
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N, s = sector(i), t = sector(j);
    indices.push(C(s), i, j);
    if (s !== t) indices.push(C(s), j, C(t));
  }
  const m = parseKn5Buffer(buildKn5({ bodyMesh: { name: 'holed', verts, indices } }));
  const [isl] = findIslands(m, meshesUsingTexture(m, 'body.dds'), { minVertices: 3 });
  const outline = islandOutline(m, isl);

  assert.equal(outline.length, 4, `the square, not the sixteen-gon: ${JSON.stringify(outline)}`);
  const has = (u, v) => outline.some(([a, b]) => Math.abs(a - u) < 0.002 && Math.abs(b - v) < 0.002);
  assert.ok(corners.every(([u, v]) => has(u, v)), JSON.stringify(outline));
});

test('an outline is coarse enough not to redraw the unwrap, and still traces the island', async () => {
  // A published profile describes where an island is, not how its maker drew
  // it: a finely traced boundary is most of a livery template. A wavy-edged
  // disc of 400 boundary vertices comes back as a few dozen points that still
  // reach its rim.
  const { islandOutline, MAX_OUTLINE_POINTS } = await import('../src/engine/islands.mjs');
  const N = 400;
  const rim = [...Array(N)].map((_, i) => {
    const a = (i * 2 * Math.PI) / N, r = 0.4 + 0.02 * Math.sin(a * 37);
    return [0.5 + r * Math.cos(a), 0.5 + r * Math.sin(a)];
  });
  const uv = [[0.5, 0.5], ...rim];
  const verts = uv.map(([u, v]) => vert(u * 2, 0, v * 2, u, v));
  const indices = rim.flatMap((_, i) => [0, 1 + i, 1 + ((i + 1) % N)]);
  const m = parseKn5Buffer(buildKn5({ bodyMesh: { name: 'disc', verts, indices } }));
  const [isl] = findIslands(m, meshesUsingTexture(m, 'body.dds'), { minVertices: 3 });
  const outline = islandOutline(m, isl);

  assert.ok(outline.length <= MAX_OUTLINE_POINTS, `${outline.length} points`);
  assert.ok(outline.length >= 8, 'still a disc, not a triangle');
  const far = Math.max(...outline.map(([u, v]) => Math.hypot(u - 0.5, v - 0.5)));
  assert.ok(far > 0.38 && far < 0.43, `the outline reaches the rim: ${far}`);
});

test('a low-polygon island is kept when it is big on the car', async () => {
  // Islands under the vertex floor were dropped as slivers, bolt heads and trim,
  // which a flat surface modeled with a handful of triangles is not: the
  // Tatuus's wing planes went, and an eight-vertex island of 1.6 m² on the
  // Abarth's body sheet. Size on the car is what tells a wing from a bolt.
  const quad = (name, size, u0) => ({ name, verts: [
    vert(0, 0, 0, u0, 0), vert(size, 0, 0, u0 + 0.1, 0), vert(size, 0, size, u0 + 0.1, 0.1), vert(0, 0, size, u0, 0.1),
  ], indices: [0, 1, 2, 0, 2, 3] });
  const m = parseKn5Buffer(buildKn5({ bodyMesh: quad('wing', 1, 0), extraMeshes: [quad('bolt', 0.02, 0.5)] }));
  const kept = findIslands(m, meshesUsingTexture(m, 'body.dds'), { minVertices: 40 });
  assert.deepEqual(kept.map((i) => i.mesh), ['wing']);
});
