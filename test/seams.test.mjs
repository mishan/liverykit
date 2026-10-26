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
import { carKn5, CAR } from './fixtures/kn5.mjs';

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

test('a spanning region on a profile with no seam maps is refused, not silently clipped', async () => {
  const { spanPlacements, resolveRect } = await import('../src/profile.mjs');
  const profile = {
    id: 'c', textures: { body: { file: 'b.dds', width: 64, height: 64 } },
    panels: { body: { L: { rect: [0, 0, 0.5, 1] } } },
  };
  const over = resolveRect(profile, 'body', { panel: 'L', span: true, at: [0.5, 0, 0.8, 1] });
  assert.throws(() => spanPlacements(profile, 'body', 'L', over), /regenerate/,
    'the design asked for two panels and would have got one, quietly');

  // GIVEN SOMEWHERE TO SAY IT, it clips and says it instead.
  //
  // The throw is the right answer for a caller that cannot report and the
  // wrong one for the editor: it came out of here with nothing to catch it,
  // /api/preview answered 500, and the car did not draw at all — for every
  // profile made before seam maps existed, which was two of the three in this
  // repo. Nobody can fix a design they cannot see.
  const notes = [];
  const clipped = spanPlacements(profile, 'body', 'L', over, { notes });
  assert.deepEqual(clipped.map((p) => p.panel), ['L'], 'clipped to the panel it started on');
  assert.equal(notes.length, 1);
  assert.equal(notes[0].status, 'clipped');
  assert.match(notes[0].text, /stops at the edge/);
  assert.match(notes[0].text, /--from-kn5/, 'and says what would fix it');
  assert.ok(Array.isArray(clipped[0].poly) && clipped[0].poly.length >= 3,
    'and it is a placement like any other, shape and all');

  // A spanning rectangle that stays inside its panel asks nothing of the
  // seams, and is as valid on this profile as on any other.
  const within = resolveRect(profile, 'body', { panel: 'L', span: true, at: [0.1, 0.1, 0.8, 0.8] });
  assert.deepEqual(spanPlacements(profile, 'body', 'L', within).map((p) => p.panel), ['L']);
});

test('a seamless profile still renders, and the note travels with the artwork', async () => {
  // The editor's whole failure mode: renderTexture is what /api/render and the
  // build both go through, and an exception here is an editor that will not
  // open rather than a stripe that stops short.
  await import('../src/index.mjs');
  const { renderTexture } = await import('../src/render.mjs');
  const { resolveTreatments } = await import('../src/registry.mjs');
  const profile = {
    id: 'c', textures: { body: { file: 'b.dds', width: 64, height: 64 } },
    panels: { body: { L: { rect: [0, 0, 0.5, 1] } } },
  };
  const regionNotes = [];
  const out = renderTexture({
    profile, role: 'body', treatments: resolveTreatments(['core']), palette: {},
    rng: Math.random, font: 'sans-serif', tokens: {}, regionNotes,
    regions: [{ id: 'band', treatment: 'stripe', panel: 'L', span: true, at: [0.5, 0, 0.8, 1], color: '#fff' }],
  });
  assert.match(out.base, /<rect /, 'the artwork is drawn, clipped to the panel it has');
  const clipped = regionNotes.filter((n) => n.status === 'clipped');
  assert.equal(clipped.length, 1, 'said once, not once per pass over the regions');
  assert.match(clipped[0].text, /body\.L/);
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
