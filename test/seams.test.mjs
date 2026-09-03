// Where two islands meet on the car, and how to continue artwork across.
//
// `adjacent` says two islands touch. It does not say WHERE in each island's
// texture the touching edge is, or which way round — and that is what a
// stripe running from the door onto the rear quarter needs to know. The
// seam map answers it from the vertices the two islands share: the same
// point on the car, two sets of texture coordinates.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseKn5Buffer, meshesUsingTexture } from '../src/engine/kn5.mjs';
import { findIslands, findAdjacency, findSeams, nameIslands, carBounds } from '../src/engine/islands.mjs';
import { axesFromWheels } from '../src/engine/kn5.mjs';
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

test('a spanning region reaches the panels its rectangle runs onto, and no others', async () => {
  const { profileFromKn5 } = await import('../src/engine/profilegen.mjs');
  const { spanPlacements, resolveRect } = await import('../src/profile.mjs');
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'lk-span-'));
  await writeFile(join(dir, 'fixture.kn5'), carKn5());
  const profile = await profileFromKn5(join(dir, 'fixture.kn5'), { id: 'fixture_car', log: () => {} });
  const role = Object.keys(profile.panels)[0];
  const byRect = (name) => {
    const [x, y] = CAR.faces[name];
    return Object.entries(profile.panels[role]).find(([, p]) => Math.abs(p.rect[0] - x) < 0.01 && Math.abs(p.rect[1] - y) < 0.01)[0];
  };
  const left = byRect('left'), roof = byRect('roof'), front = byRect('front');
  assert.ok(profile.panels[role][left].seams?.[roof], 'the profile carries the seam');

  // A band across the top of the left face that runs 30% past its top edge
  // and 20% past its front edge. It should reach the roof and the front face,
  // not the floor or the right side.
  const band = { panel: left, span: true, at: [0.1, 0.6, 1.1, 0.7], treatment: 'stripe' };
  const home = resolveRect(profile, role, band);
  const placed = spanPlacements(profile, role, left, home);
  const names = placed.map((p) => p.panel).sort();
  assert.deepEqual(names, [front, left, roof].sort(), `reached: ${names}`);
  const onRoof = placed.find((p) => p.panel === roof);
  assert.equal(onRoof.hops, 1);
  // 30% of the left face's height is 45 cm, which on the roof is 45 cm in
  // from its edge: 45/190 of its u extent.
  const rw = profile.panels[role][roof].rect[2];
  assert.ok(Math.abs(onRoof.on.w - (0.45 / CAR.width) * rw) < 0.01, `roof strip width ${onRoof.on.w}`);

  // A rectangle that stays inside the panel reaches nothing else.
  const inside = resolveRect(profile, role, { panel: left, span: true, at: [0.1, 0.1, 0.8, 0.8] });
  assert.deepEqual(spanPlacements(profile, role, left, inside).map((p) => p.panel), [left]);
});

test('a region past its panel edge is refused unless it spans', async () => {
  const { resolveRect } = await import('../src/profile.mjs');
  const profile = { id: 'c', textures: { body: { file: 'b.dds', width: 64, height: 64 } },
    panels: { body: { L: { rect: [0, 0, 0.5, 1] } } } };
  assert.throws(() => resolveRect(profile, 'body', { panel: 'L', at: [0.5, 0, 0.8, 1] }), /past the texture edge/);
  assert.doesNotThrow(() => resolveRect(profile, 'body', { panel: 'L', span: true, at: [0.5, 0, 0.8, 1] }));
  assert.throws(() => resolveRect(profile, 'body', { span: true, at: [0, 0, 1, 1] }), /needs a panel/);
});

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

async function spanProfile() {
  const { profileFromKn5 } = await import('../src/engine/profilegen.mjs');
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'lk-span-'));
  await writeFile(join(dir, 'fixture.kn5'), carKn5());
  const profile = await profileFromKn5(join(dir, 'fixture.kn5'), { id: 'fixture_car', log: () => {} });
  const role = Object.keys(profile.panels)[0];
  const byRect = (name) => {
    const [x, y] = CAR.faces[name];
    return Object.entries(profile.panels[role]).find(([, p]) => Math.abs(p.rect[0] - x) < 0.01 && Math.abs(p.rect[1] - y) < 0.01)[0];
  };
  return { profile, role, left: byRect('left'), roof: byRect('roof'), front: byRect('front') };
}

test('a spanning region is drawn once and placed on every panel it reaches, clipped to each', async () => {
  await import('../src/index.mjs');
  const { renderTexture } = await import('../src/render.mjs');
  const { resolveTreatments } = await import('../src/registry.mjs');
  const { profile, role, left, roof } = await spanProfile();
  const out = renderTexture({
    profile, role, treatments: resolveTreatments(['core']), palette: {}, rng: Math.random, font: 'sans-serif', tokens: {},
    regions: [{ id: 'band', treatment: 'stripe', panel: left, span: true, at: [0.1, 0.6, 0.8, 0.7], color: '#fff' }],
  });
  // One <rect> of artwork per placement, each inside its own clipped,
  // transformed group; the home copy under the identity.
  const copies = [...out.base.matchAll(/<g clip-path="url\(#(lk-span-[^"]+)\)"><g transform="matrix\(([^)]+)\)">/g)];
  assert.ok(copies.length >= 2, `home and roof at least: ${copies.length}`);
  assert.ok(copies.some(([, , m]) => m === '1 0 0 1 0 0'), 'the home copy is untransformed');
  // Every clip referenced is defined, and defined as the island's outline.
  for (const [, id] of copies) {
    assert.match(out.base, new RegExp(`<clipPath id="${id}"><polygon points=`), `${id} clips to an outline`);
  }
  // The artwork itself appears once per copy and is byte-identical: the same
  // stripe, not a re-rolled one.
  const rects = [...out.base.matchAll(/<rect x="[\d.]+" y="[\d.]+" width="[\d.]+" height="[\d.]+" fill="#fff"\/>/g)].map((m) => m[0]);
  assert.equal(rects.length, copies.length);
  assert.equal(new Set(rects).size, 1, 'one drawing, repeated');
  // And the roof copy's matrix is the seam map, in texels.
  const seam = profile.panels[role][left].seams[roof].matrix;
  const { width, height } = profile.textures[role];
  const want = [seam[0], seam[1] * height / width, seam[2] * width / height, seam[3], seam[4] * width, seam[5] * height];
  const onRoof = copies.map(([, , m]) => m.split(' ').map(Number)).find((m) => Math.abs(m[0] - want[0]) < 0.01 && Math.abs(m[4] - want[4]) < 0.5);
  assert.ok(onRoof, `a copy carries the roof seam map ${want.map((n) => n.toFixed(2))}; got ${copies.map(([, , m]) => m)}`);
});

test('the fitment check sees a spanning region as one placement per panel', async () => {
  const { fitment } = await import('../src/fitment.mjs');
  const { profile, role, left, roof } = await spanProfile();
  const design = {
    name: 'S', paint: { [role]: { regions: [
      { id: 'band', treatment: 'stripe', panel: left, span: true, at: [0.1, 0.6, 0.8, 0.7], color: '#fff' },
      { id: 'name', treatment: 'text', panel: roof, at: [0.7, 0.4, 0.25, 0.2], text: 'HI' },
    ] } },
  };
  const r = fitment(design, profile);
  // The band's piece on the roof lies under the name: an overlap on the
  // ROOF, found only because the band was checked where it actually lands.
  // Several placements share the band's key, so the finding names the panel
  // — which is what somebody needs to go and look at the right sheet.
  const hit = r.findings.filter((f) => f.kind === 'overlap' && f.ids.includes(`band@${roof}`) && f.ids.includes('name'));
  assert.equal(hit.length, 1, JSON.stringify(r.findings.map((f) => [f.kind, f.ids])));
});

test('a spanning region may select its home by tags, so it travels', async () => {
  // The portable design cannot name a panel. `tags` picks the home panel on
  // whatever car this is, and the spill follows that car's seams.
  await import('../src/index.mjs');
  const { renderTexture } = await import('../src/render.mjs');
  const { resolveTreatments } = await import('../src/registry.mjs');
  const { profile, role, left } = await spanProfile();
  const tags = profile.panels[role][left].tags;
  const out = renderTexture({
    profile, role, treatments: resolveTreatments(['core']), palette: {}, rng: Math.random, font: 'sans-serif', tokens: {},
    regions: [{ id: 'band', treatment: 'stripe', tags, limit: 1, span: true, at: [0.1, 0.6, 0.8, 0.7], color: '#fff' }],
  });
  const copies = [...out.base.matchAll(/<g clip-path="url\(#lk-span-[^"]+\)"><g transform="matrix\(/g)];
  assert.ok(copies.length >= 2, `spilled from the tag-selected home: ${copies.length} copies`);
});

// ---------------------------------------------------------------------------
// The two places a seam or an outline can be quietly wrong.
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

test('a spanning region on a profile with no seam maps is refused, not silently clipped', async () => {
  const { spanPlacements, resolveRect } = await import('../src/profile.mjs');
  const profile = {
    id: 'c', textures: { body: { file: 'b.dds', width: 64, height: 64 } },
    panels: { body: { L: { rect: [0, 0, 0.5, 1] } } },
  };
  const over = resolveRect(profile, 'body', { panel: 'L', span: true, at: [0.5, 0, 0.8, 1] });
  assert.throws(() => spanPlacements(profile, 'body', 'L', over), /regenerate/,
    'the design asked for two panels and would have got one, quietly');

  // A spanning rectangle that stays inside its panel asks nothing of the
  // seams, and is as valid on this profile as on any other.
  const within = resolveRect(profile, 'body', { panel: 'L', span: true, at: [0.1, 0.1, 0.8, 0.8] });
  assert.deepEqual(spanPlacements(profile, 'body', 'L', within).map((p) => p.panel), ['L']);
});

test('a placement carries the shape it is, not only the box around it', async () => {
  const { spanPlacements, resolveRect } = await import('../src/profile.mjs');
  const { polyArea } = await import('../src/engine/poly.mjs');
  const { profile, role, left } = await spanProfile();
  const band = { panel: left, span: true, at: [0.1, 0.6, 1.1, 0.7], treatment: 'stripe' };
  const placed = spanPlacements(profile, role, left, resolveRect(profile, role, band));
  for (const p of placed) {
    assert.ok(Array.isArray(p.poly) && p.poly.length >= 3, `${p.panel} has a shape`);
    const box = p.on.w * p.on.h;
    assert.ok(polyArea(p.poly) <= box + 1e-9, `${p.panel}: shape inside its box`);
    assert.ok(polyArea(p.poly) > 0);
  }
});

test('every spanning copy gets its own clip, including after one that drew nothing', async () => {
  // The ids were built from the two layers' lengths, and those only advance
  // when a treatment emits something. A spanning `radialText` with an empty
  // string defines its clip paths and draws nothing, so the region after it
  // started from the same numbers and reused the ids — and every copy of it
  // was clipped to the earlier region's panels. Silent, and visible only as
  // artwork missing from one panel and present on another.
  await import('../src/index.mjs');
  const { renderTexture } = await import('../src/render.mjs');
  const { resolveTreatments } = await import('../src/registry.mjs');
  const { profile, role, left } = await spanProfile();
  const out = renderTexture({
    profile, role, treatments: resolveTreatments(['core', 'synthwave']),
    palette: {}, rng: Math.random, font: 'sans-serif', tokens: {},
    regions: [
      { id: 'silent', treatment: 'radialText', panel: left, span: true, at: [0.1, 0.6, 0.8, 0.7], text: '' },
      { id: 'band', treatment: 'stripe', panel: left, span: true, at: [0.1, 0.6, 0.8, 0.7], color: '#fff' },
    ],
  });

  const defined = [...out.base.matchAll(/<clipPath id="(lk-span-[^"]+)"/g)].map(([, id]) => id);
  assert.ok(defined.length >= 4, `two spanning regions, several panels each: ${defined.length}`);
  assert.equal(new Set(defined).size, defined.length, `every clip id is its own: ${defined}`);

  // And the band's copies refer to clips defined for the band, not to the
  // silent region's.
  const used = [...out.base.matchAll(/<g clip-path="url\(#(lk-span-[^"]+)\)"/g)].map(([, id]) => id);
  assert.equal(new Set(used).size, used.length, `no copy borrows another's clip: ${used}`);
});

test('a region does not land in the empty texture inside a panel box, or travel through it', async () => {
  // A panel's rect is the box around an irregular island, and unwrappers pack
  // small islands into the concave corners of big ones. Routing on the box
  // alone, a region could "land" in that emptiness — no triangle wears those
  // texels, so nothing is painted there — and then continue THROUGH the
  // phantom piece to the seams beyond it, arriving on panels the artwork never
  // reached. The renderer clips the phantom copy away, so the only evidence
  // was a band on a panel two seams from home.
  const { spanPlacements } = await import('../src/profile.mjs');
  const box = ([x, y, w, h]) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  const A = [0, 0, 0.4, 1], B = [0.5, 0, 0.4, 1];
  const near = (outline) => ({
    id: 'c', textures: { body: { file: 'b.dds', width: 1024, height: 1024 } },
    panels: {
      body: {
        A: { rect: A, metresPerUv: [1, 1], outline: box(A),
          seams: { B: { matrix: [1, 0, 0, 1, 0.5, 0], here: [[0.4, 0], [0.4, 1]], rmsMm: 0 } } },
        B: { rect: B, metresPerUv: [1, 1], outline, seams: {} },
      },
    },
  });
  // A band along the top of A, running past its right edge onto B.
  const band = { x: 0.2, y: 0.6, w: 0.4, h: 0.3 };

  // B's island fills its box: the band reaches it.
  const whole = spanPlacements(near(box(B)), 'body', 'A', band);
  assert.deepEqual(whole.map((p) => p.panel).sort(), ['A', 'B']);

  // The same B, with the island occupying only the bottom of its box — the
  // band arrives over the empty half, and lands nowhere.
  const notched = spanPlacements(near(box([0.5, 0, 0.4, 0.4])), 'body', 'A', band);
  assert.deepEqual(notched.map((p) => p.panel), ['A'],
    'texture nothing wears is not a panel this region reached');
});
