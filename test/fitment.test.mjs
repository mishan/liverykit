// ---------------------------------------------------------------------------
// What is wrong with this design on this car.
//
// The motivating mistake is in the first test, because it is the one that
// justifies the module: asked to improve a fit, I moved a team name out of a
// collision with a race number and into a part of the same panel that cannot be
// seen. Every number available said the move was fine.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import '../src/index.mjs';
import { fitment } from '../src/fitment.mjs';
import { occupancyFor, rectVisibility } from '../src/engine/visibility.mjs';

const probe = (model, rect) =>
  rectVisibility(model, occupancyFor(model), model.meshes, rect);

const profile = {
  id: 'fixture', name: 'Fixture',
  textures: { body: { file: 'b.dds', width: 2048, height: 2048 } },
  bind: { body: { roles: ['body'], source: 'human' } },
  panels: {
    body: {
      L: { rect: [0, 0, 0.4, 0.4], anisotropy: 1, metresPerUv: [4, 4], visible: 0.88, tags: ['left', 'visible'] },
      R: { rect: [0.5, 0, 0.4, 0.4], anisotropy: 1, metresPerUv: [4, 4], visible: 0.9, tags: ['right', 'visible'] },
    },
  },
};

const design = (regions) => ({
  name: 'F', packs: ['core'], palette: { ink: '#101014' }, identity: { team: 'T', number: '7' },
  surfaces: { body: { regions } },
});

test('text landing on text is reported, and layered artwork is not', () => {
  // Layering is how a livery is built: a fill under a halftone under scanlines,
  // every one covering the whole sheet and every pair overlapping completely.
  // The first version of this check produced thirty findings on a real design,
  // twenty-eight of which were "the artwork is on top of the artwork". A
  // checker that has to be ignored teaches you to ignore it.
  const r = fitment(design([
    { id: 'wash', treatment: 'fill', panel: 'L', at: [0, 0, 1, 1], color: 'ink' },
    { id: 'dots', treatment: 'halftone', panel: 'L', at: [0, 0, 1, 1], color: 'ink' },
    { id: 'number', treatment: 'text', panel: 'L', at: [0.2, 0.5, 0.6, 0.3], text: '{number}' },
    { id: 'team', treatment: 'text', panel: 'L', at: [0.4, 0.7, 0.5, 0.2], text: '{team}' },
  ]), profile);

  const high = r.findings.filter((f) => f.severity === 'high');
  assert.equal(high.length, 1, `one real collision: ${r.findings.map((f) => f.why).join(' | ')}`);
  assert.equal(high[0].kind, 'overlap');
  assert.deepEqual(high[0].ids.sort(), ['number', 'team']);
  assert.match(high[0].why, /both are text/);

  // The two full-sheet treatments cover each other completely and say nothing.
  assert.ok(!r.findings.some((f) => f.ids.includes('wash') && f.ids.includes('dots')),
    'artwork over artwork is the design working');
});

test('a check that did not run is named, not counted as passed', () => {
  // The distinction the whole module turns on. Region visibility needs the
  // car's model, which most runs will not have — and "no findings" from a
  // checker that skipped the only check that mattered is exactly the reassuring
  // silence this project exists to refuse.
  const r = fitment(design([
    { id: 'a', treatment: 'text', panel: 'L', at: [0.1, 0.1, 0.3, 0.2], text: 'X' },
  ]), profile);

  assert.deepEqual(r.notChecked, ['unseen', 'off-mesh', 'unpainted-twin'],
    'it says which checks it could not make');
  assert.ok(!r.checked.includes('unseen'));
  assert.ok(r.checked.includes('overlap'), 'and which it did');
});

test('text too small to read on the car is measured, not guessed', () => {
  // `metresPerUv` makes this answerable: the panel is 0.4 of a sheet at 4 m per
  // UV unit, so it is 1.6 m across. A region 1% of that is 16 mm — a smudge.
  const r = fitment(design([
    { id: 'tiny', treatment: 'text', panel: 'L', at: [0.4, 0.4, 0.01, 0.01], text: '{team}' },
    { id: 'fine', treatment: 'text', panel: 'L', at: [0, 0, 0.5, 0.5], text: '{number}' },
  ]), profile);

  const small = r.findings.filter((f) => f.kind === 'unreadable');
  assert.equal(small.length, 1, 'only the one that is actually small');
  assert.equal(small[0].ids[0], 'tiny');
  assert.equal(small[0].mm, 16);

  // A profile with no measurement says nothing rather than guessing.
  const older = structuredClone(profile);
  delete older.panels.body.L.metresPerUv;
  const quiet = fitment(design([
    { id: 'tiny', treatment: 'text', panel: 'L', at: [0.4, 0.4, 0.01, 0.01], text: '{team}' },
  ]), older);
  assert.equal(quiet.findings.filter((f) => f.kind === 'unreadable').length, 0);
});

test('artwork outside the readable part of a panel is reported', () => {
  // `safe` is the UV bounds of the vertices that passed the visibility cast
  // when the profile was made, so straying outside it is landing on geometry
  // already measured and found wanting. `safe: false` means it on purpose — a
  // background fill should reach the island's edge — and is honoured.
  const withSafe = structuredClone(profile);
  withSafe.panels.body.L.safe = [0.05, 0.05, 0.3, 0.3];

  const r = fitment(design([
    { id: 'edge', treatment: 'text', panel: 'L', at: [0.8, 0.8, 0.2, 0.2], text: 'X' },
    { id: 'bg', treatment: 'fill', panel: 'L', at: [0, 0, 1, 1], safe: false, color: 'ink' },
  ]), withSafe);

  const out = r.findings.filter((f) => f.kind === 'outside-safe');
  assert.deepEqual(out.map((f) => f.ids[0]), ['edge'], 'and not the one that said safe: false');
  assert.equal(out[0].severity, 'high');
});

test('a band that cannot span is a finding, not an exception', () => {
  // A spanning region on a profile with no seam maps is clipped to its home
  // panel and reported — see spanPlacements. It used to throw from inside
  // `placements`, which this module turned into one `fatal` finding saying the
  // surface could not be placed at all: true, unhelpful, and it hid everything
  // else on that surface behind it.
  const seamless = structuredClone(profile);
  const r = fitment(design([
    { id: 'band', treatment: 'stripe', panel: 'L', span: true, at: [0.5, 0, 1.4, 0.4], color: 'ink' },
    { id: 'name', treatment: 'text', panel: 'L', span: true, at: [0.5, 0.5, 1.4, 0.3], text: 'T' },
  ]), seamless);

  assert.deepEqual(r.findings.filter((f) => f.severity === 'fatal'), [],
    'the surface is placed, and everything else about it is still checked');
  const clipped = r.findings.filter((f) => f.kind === 'clipped');
  assert.deepEqual(clipped.map((f) => f.ids[0]).sort(), ['band', 'name']);
  assert.deepEqual(clipped.map((f) => f.severity).sort(), ['high', 'low'],
    'words stop being words when half of them is missing; a stripe stops short');
  assert.match(clipped[0].why, /no seam maps/);
  assert.ok(r.checked.includes('clipped'), 'and it is named as having run');
});

test('a region that names no panel is checked, not skipped', () => {
  // Placements with no panel were filtered out before any check ran, so a
  // design written in whole-sheet coordinates — which is what a design does on
  // a role whose panels the profile never mapped — went through this module
  // untouched and came back clean. Not "clean" as in checked: clean as in a
  // list of findings about the other surfaces.
  //
  // Nothing about them needs a panel. `resolveRect` gives the sheet rectangle
  // straight back, and each check below already gates itself on the fields it
  // needs — the safe area, the metres, the mirrored twin — so the ones that
  // cannot answer stay quiet on their own.
  const r = fitment(design([
    { id: 'ground', treatment: 'fill', at: [0, 0, 1, 1], color: 'ink' },
    { id: 'team', treatment: 'text', at: [0.2, 0.2, 0.4, 0.1], text: 'T' },
  ]), profile);

  const over = r.findings.filter((f) => f.kind === 'overlap');
  assert.deepEqual(over.map((f) => f.ids), [['ground', 'team']],
    'a name under a full-sheet fill is the same finding it would be on a panel');

  // And the checks that need a panel say nothing rather than guessing: there
  // is no safe area to be outside of, and no metres to be too small in.
  assert.deepEqual(r.findings.filter((f) => ['outside-safe', 'unreadable'].includes(f.kind)), []);
});

test('artwork on the face of a sheet the world cannot see is reported', () => {
  // The windscreen banner on the NSX: EXT_Banner and INT_Banner share one
  // texture, the outward face in its top half and the underside plus the
  // interior mesh in its bottom. A team name placed in sheet coordinates
  // landed in the bottom half, read perfectly from the driver's seat, and
  // appeared nowhere from outside. Nothing said so — it took somebody noticing
  // it from the wrong seat, weeks later.
  const twoFaced = structuredClone(profile);
  twoFaced.panels.body = {
    outside: { rect: [0.1, 0.02, 0.8, 0.47], anisotropy: 1, metresPerUv: [4, 4], visible: 0.59 },
    inside: { rect: [0.1, 0.49, 0.8, 0.48], anisotropy: 1, metresPerUv: [4, 4], visible: 0, visibleFromCockpit: 0.13 },
  };
  twoFaced.aliases = { body: { banner: 'outside' } };

  const r = fitment(design([
    // The sheet's background. It covers both faces because that is what a
    // background does, and reporting it would teach anybody reading this
    // panel to stop reading it.
    { id: 'ground', treatment: 'fill', at: [0, 0, 1, 1], color: 'ink' },
    // Placed by sheet coordinates, straddling the seam, mostly below it.
    { id: 'team', treatment: 'text', at: [0.14, 0.37, 0.72, 0.55], text: 'T' },
    // And the same artwork where it belongs.
    { id: 'stripe', treatment: 'stripe', at: [0.1, 0.08, 0.8, 0.06], color: 'ink' },
  ]), twoFaced);

  const hidden = r.findings.filter((f) => f.kind === 'hidden-face');
  assert.deepEqual(hidden.map((f) => f.ids[0]), ['team'],
    'the background covers both faces by definition, and the stripe is on the right one');
  assert.equal(hidden[0].severity, 'high', 'a name the world cannot read is not a footnote');
  assert.equal(hidden[0].onto, 'inside');
  assert.equal(hidden[0].instead, 'outside');
  // The report has to say where to put it instead, by the name a design would
  // write — which is the alias when the profile carries one.
  assert.match(hidden[0].why, /banner \(outside\)/);
  assert.match(hidden[0].why, /driver/, 'and that this one is not invisible, it is inward-facing');
  assert.ok(r.checked.includes('hidden-face'), 'and the check is named as having run');

  // Silent on a sheet the world sees none of. An interior, a tub, the
  // underside of a floor — painting those is the point, not a mistake.
  const allInside = structuredClone(twoFaced);
  allInside.panels.body.outside.visible = 0;
  const quiet = fitment(design([
    { id: 'team', treatment: 'text', at: [0.14, 0.37, 0.72, 0.55], text: 'T' },
  ]), allInside);
  assert.deepEqual(quiet.findings.filter((f) => f.kind === 'hidden-face'), []);

  // And silent where the profile has never been measured for visibility, like
  // one written from screenshots: no number, no claim.
  const unmeasured = structuredClone(twoFaced);
  for (const q of Object.values(unmeasured.panels.body)) delete q.visible;
  const nothingToSay = fitment(design([
    { id: 'team', treatment: 'text', at: [0.14, 0.37, 0.72, 0.55], text: 'T' },
  ]), unmeasured);
  assert.deepEqual(nothingToSay.findings.filter((f) => f.kind === 'hidden-face'), []);
});

test('artwork wholly on the hidden face is the worst case, not a crash', () => {
  // The case this check exists for, and the one it could not survive. A
  // placement entirely on the inward face overlaps NO outward panel, so
  // "the outward panel it overlaps most" is nothing at all — and the finding
  // went looking for that panel's visibility. A region straddling the seam
  // has one and does not, which is why the first test of this passed.
  //
  // Where to put it instead cannot come from where the artwork wrongly is. It
  // is the sheet's most visible face, which exists whether or not the
  // placement ever reached it.
  const twoFaced = structuredClone(profile);
  twoFaced.panels.body = {
    outside: { rect: [0.1, 0.02, 0.8, 0.44], anisotropy: 1, metresPerUv: [4, 4], visible: 0.59 },
    lip: { rect: [0.1, 0.46, 0.8, 0.02], anisotropy: 1, metresPerUv: [4, 4], visible: 0.2 },
    inside: { rect: [0.1, 0.5, 0.8, 0.47], anisotropy: 1, metresPerUv: [4, 4], visible: 0 },
  };

  const r = fitment(design([
    { id: 'team', treatment: 'text', at: [0.2, 0.6, 0.5, 0.2], text: 'T' },
  ]), twoFaced);

  const hidden = r.findings.filter((f) => f.kind === 'hidden-face');
  assert.equal(hidden.length, 1);
  assert.equal(hidden[0].severity, 'high');
  assert.equal(hidden[0].onto, 'inside');
  assert.equal(hidden[0].instead, 'outside', 'the most visible face, not the least');
  assert.match(hidden[0].why, /none of this reaches it/);
  assert.match(hidden[0].why, /100% of team is on inside/);
});

test('a placement mostly off the model is reported before its visibility is', () => {
  // The mistake that started all of this, finally caught.
  //
  // A uv rectangle is a rectangle in the TEXTURE, and a texture is mostly not
  // the car — islands are irregular and the gaps between them belong to no
  // triangle. Artwork placed in a gap renders perfectly, looks right in the uv
  // view, and does not exist on the bodywork.
  //
  // Measured on the real Honda: the team name where I moved it scored 86%
  // VISIBLE, from the 11% of its area that was on the model. Visibility was
  // answering honestly about a sliver. Nothing was asking about the rest, so
  // the number that reached me was a true sentence about the wrong thing.
  // The sheet occupies the LEFT HALF of panel L's uv rect. The right half of
  // the panel is texture belonging to no triangle.
  const model = plane({ rows: 8, cols: 8, uv: [0, 0, 0.2, 0.4] });
  const r = fitment(design([
    { id: 'onto-car', treatment: 'text', panel: 'L', at: [0.05, 0.1, 0.4, 0.3], text: '{team}' },
    { id: 'into-space', treatment: 'text', panel: 'L', at: [0.7, 0.6, 0.25, 0.3], text: '{number}' },
  ]), profile, null, { model });

  const off = r.findings.filter((f) => f.kind === 'off-mesh');
  assert.deepEqual(off.map((f) => f.ids[0]), ['into-space'],
    `only the one painted nowhere: ${r.findings.map((f) => f.why).join(' | ')}`);
  assert.equal(off[0].severity, 'high');
  assert.match(off[0].why, /no geometry at all|on the car/);

  // And it is said INSTEAD of a visibility verdict, not alongside one: a
  // fraction computed from a sliver is the sentence that misled me.
  assert.ok(!r.findings.some((f) => f.kind === 'unseen' && f.ids.includes('into-space')),
    'a region that is not on the car has no visibility to report');

  assert.deepEqual(r.notChecked, []);
  assert.ok(r.checked.includes('off-mesh'));
});

test('visibility is measured across the rectangle, not at whatever vertices fall in it', () => {
  // Vertices are where the MODELLER put them, so counting the ones inside a
  // rectangle measures mesh density, not the rectangle. A door is a handful of
  // big triangles: a region the size of a team name held thirteen vertices on
  // the real car and returned a confident 100% from them. Sampling the
  // rectangle itself gives the same footing to a small region as a large one.
  const model = plane({ rows: 2, cols: 2 });   // four vertices in the whole sheet
  const tiny = [0.02, 0.02, 0.01, 0.01];       // contains none of them
  const r = fitment(design([
    { id: 'small', treatment: 'fill', panel: 'L', at: tiny, color: 'ink' },
  ]), profile, null, { model });

  // Nothing to say about it: it is on the mesh and it can be seen. The point is
  // that an answer exists at all — this used to be a silent `null`.
  assert.deepEqual(r.findings.filter((f) => f.ids?.includes('small')), []);

  const direct = probe(model, tiny);
  assert.ok(direct, 'a rectangle between vertices still gets an answer');
  assert.ok(direct.samples > 50, `sampled across, not at corners: ${direct.samples}`);
  assert.equal(direct.samples, direct.of, 'and the whole rectangle is on the mesh');
});

test('a placement that is not a rectangle is measured over the shape it is', () => {
  // A region continued across a seam lands as a parallelogram. Asked as the
  // box around it, half the samples fall on texture the design does not paint
  // — the answer comes back as a placement half off the car, which is a real
  // finding about an imaginary shape.
  const model = plane({ rows: 8, cols: 8 });
  const rect = [0.05, 0.05, 0.2, 0.2];
  const whole = probe(model, rect);
  assert.equal(whole.samples, whole.of, 'the box is entirely on the sheet');

  // The lower-left triangle of that box: half the area, so about half the
  // cells, and every one of them still on the mesh.
  const half = [[0.05, 0.05], [0.25, 0.05], [0.05, 0.25]];
  const shaped = rectVisibility(model, occupancyFor(model), model.meshes, rect, { poly: half });
  assert.ok(shaped.of < whole.of * 0.65 && shaped.of > whole.of * 0.35,
    `about half the cells: ${shaped.of} of ${whole.of}`);
  assert.equal(shaped.samples, shaped.of, 'and the shape is entirely on the sheet');
  assert.equal(shaped.fraction, 1);

  // A shape that lands nowhere near the sheet is still no answer at all,
  // rather than a confident zero.
  assert.equal(rectVisibility(model, occupancyFor(model), model.meshes, rect,
    { poly: [[0.9, 0.9], [0.95, 0.9], [0.9, 0.95]] }), null);
});

/**
 * A flat sheet facing +z, with real triangles — the visibility cast now walks
 * them rather than standing on vertices, so an index buffer is not optional.
 *
 * `uv` is the ABSOLUTE rectangle of the texture this sheet occupies. Making it
 * a parameter is the point of the fixture: the space outside it is texture
 * belonging to no triangle, which is where artwork goes to be painted nowhere.
 */
function plane({ rows, cols, uv = [0, 0, 0.4, 0.4] }) {
  const [ux, uy, uw, uh] = uv;
  const stride = 32, n = rows * cols;
  const quads = (rows - 1) * (cols - 1), indexCount = quads * 6;
  const buf = Buffer.alloc(n * stride + indexCount * 2);
  for (let i = 0; i < n; i++) {
    const su = (i % cols) / (cols - 1), sv = Math.floor(i / cols) / (rows - 1);
    const o = i * stride;
    buf.writeFloatLE(su * 1.6, o); buf.writeFloatLE(sv * 1.6, o + 4); buf.writeFloatLE(0, o + 8);
    buf.writeFloatLE(0, o + 12); buf.writeFloatLE(0, o + 16); buf.writeFloatLE(1, o + 20);
    buf.writeFloatLE(ux + su * uw, o + 24);
    buf.writeFloatLE(uy + sv * uh - 1, o + 28);      // stored negative; vertex() adds 1
  }
  let at = n * stride;
  for (let r = 0; r + 1 < rows; r++) {
    for (let c = 0; c + 1 < cols; c++) {
      const p0 = r * cols + c, p1 = p0 + 1, p2 = p0 + cols, p3 = p2 + 1;
      for (const v of [p0, p2, p1, p1, p2, p3]) { buf.writeUInt16LE(v, at); at += 2; }
    }
  }
  const world = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
  return {
    buf,
    materials: [{ slots: { txDiffuse: 'b.dds' } }],
    meshes: [{
      materialId: 0, vertexStart: 0, vertexCount: n, stride, world,
      indexStart: n * stride, indexCount,
    }],
  };
}

test('a surface that cannot be placed is a finding, not a short list', () => {
  // Both halves of the same mistake. `expandRegions` threw on an unresolvable
  // region and the catch returned `[]`, so a livery naming a tag this car has
  // never heard of produced zero findings — indistinguishable from a clean one,
  // and the more confident-looking of the two.
  const r = fitment(design([
    // `tags: []` matches every panel by vacuous truth, so `expandRegions`
    // refuses it outright rather than painting the whole texture.
    { id: 'ghost', treatment: 'text', tags: [], at: [0, 0, 1, 1], text: 'X' },
  ]), profile);

  const fatal = r.findings.filter((f) => f.severity === 'fatal');
  assert.equal(fatal.length, 1, `the failure is stated: ${JSON.stringify(r.findings)}`);
  assert.equal(fatal[0].kind, 'unresolvable');
  assert.match(fatal[0].why, /nothing about it/);
  assert.deepEqual(r.notPlaced, ['surfaces.body'], 'and the surface it cost us is named');
});

test('an unnamed region is addressed by the key a fit would write', () => {
  // `applyFit` builds positional keys as `${surfaceKey}#${index}`. Called
  // without one they came out `#0`, matching no key any fit has ever written —
  // so overrides on unnamed regions were dropped and this module checked where
  // the DESIGN put things while reporting on where the FIT did.
  const regions = [{ treatment: 'text', panel: 'L', at: [0, 0, 0.2, 0.1], text: '{team}' }];
  const moved = fitment(design(regions), profile,
    { livery: 'F', car: 'fixture', regions: { 'surfaces.body#0': { at: [0.4, 0.4, 0.01, 0.01] } } });

  const small = moved.findings.filter((f) => f.kind === 'unreadable');
  assert.equal(small.length, 1, 'the fit moved it, and the move is what got checked');
  assert.equal(small[0].ids[0], 'surfaces.body#0',
    'named as the fit names it, so it can be edited');

  // Unmoved, the design's own 20%-of-1.6m box is a legible 320 mm and silent.
  const asis = fitment(design(regions), profile);
  assert.deepEqual(asis.findings.filter((f) => f.kind === 'unreadable'), []);
});

test('regions expanded from one tag do not all answer to the same name', () => {
  // A tag selection becomes one placement per matching panel, but `__key` was
  // stamped by `applyFit` BEFORE the expansion, so every clone carried it. Two
  // findings would name the same region and one of them would be a lie about
  // where to look.
  const r = fitment(design([
    // One region, both panels — the clones are what share a key.
    { treatment: 'text', tags: ['visible'], at: [0.4, 0.4, 0.01, 0.01], text: '{team}' },
  ]), profile);

  const ids = r.findings.filter((f) => f.kind === 'unreadable').map((f) => f.ids[0]);
  assert.equal(ids.length, 2);
  assert.equal(new Set(ids).size, 2, `each names its own placement: ${ids.join(', ')}`);
  assert.deepEqual(ids.sort(), ['surfaces.body#0@L', 'surfaces.body#0@R']);
});

test('something lying flush against a panel occludes it', () => {
  // The blind spot that made the whole instrument agreeable.
  //
  // Rays used to start 4 cm out along the normal, to get clear of the surface's
  // own voxel — so anything nearer than 4 cm was already behind the ray when it
  // set off. The Honda's number plates stand a few MILLIMETRES proud of the
  // front doors, which is the case this was built to catch and the one case it
  // could not see.
  //
  // Shrinking the lift does not fix it: at 2.5 cm cells the plate and the door
  // are in the SAME cell, so no starting distance separates them. What
  // separates them is that the cell carries two owners instead of one.
  const model = plane({ rows: 6, cols: 6 });
  const clear = probe(model, [0.02, 0.02, 0.06, 0.06]);
  assert.equal(clear.fraction, 1, 'bare bodywork is visible');

  const plated = probe(withPlate(model, 0.005), [0.02, 0.02, 0.06, 0.06]);
  assert.equal(plated.fraction, 0,
    `a plate 5 mm off the paint hides it, got ${plated.fraction}`);
  assert.equal(plated.samples, clear.samples,
    'and the paint is still on the car — hidden is not the same as absent');
});

/** The same sheet with a second mesh floating `gap` metres in front of it. */
function withPlate(model, gap) {
  const m = model.meshes[0];
  const plate = { ...m, materialId: 1, world: [...m.world] };
  plate.world[14] = gap;                       // translate along +z, toward the viewer
  return {
    ...model,
    materials: [...model.materials, { slots: { txDiffuse: 'plate.dds' } }],
    meshes: [m, plate],
  };
}

// ---------------------------------------------------------------------------
// What a region may declare about where it is allowed to end up.
//
// On the DESIGN rather than the fit, so it travels: "this is a team name, keep
// artwork off it" is true on every car, and restating it per car is how it goes
// stale on the third one.
// ---------------------------------------------------------------------------

test('a region can ask to be kept clear, and a stripe across it is reported', () => {
  // The case that prompted this. A cyan stripe running the length of the flank
  // is artwork by every measure the overlap check had — not text, so not worth
  // mentioning — and the team name underneath it is still lost. Measured on the
  // real fit, the name ran to y 0.9404 and the stripe began at 0.94.
  const guarded = fitment(design([
    { id: 'team', treatment: 'text', panel: 'L', at: [0.1, 0.5, 0.8, 0.3], text: '{team}',
      constraints: { keepClear: true } },
    { id: 'stripe', treatment: 'stripe', panel: 'L', at: [0, 0.55, 1, 0.1], color: 'ink' },
  ]), profile);

  const crossed = guarded.findings.filter((f) => f.kind === 'crossed');
  assert.equal(crossed.length, 1, JSON.stringify(guarded.findings));
  assert.equal(crossed[0].severity, 'high');
  assert.match(crossed[0].why, /stripe covers .* of team, which asked to be kept clear/);

  // And with NEITHER side text, which is the case the old check could not see
  // at all: a guarded badge under a stripe never reached the report, because
  // the pair was filtered out before anything looked at it.
  const neither = fitment(design([
    { id: 'badge', treatment: 'logo', panel: 'L', at: [0.1, 0.5, 0.8, 0.3],
      constraints: { keepClear: true } },
    { id: 'stripe', treatment: 'stripe', panel: 'L', at: [0, 0.55, 1, 0.1], color: 'ink' },
  ]), profile);
  const hit = neither.findings.filter((f) => f.kind === 'crossed');
  assert.equal(hit.length, 1, `a guarded non-text region still reports: ${
    JSON.stringify(neither.findings)}`);
  assert.deepEqual(hit[0].ids.sort(), ['badge', 'stripe']);

  // Without the constraint the same pair is a low-severity overlap at most,
  // because a stripe over artwork is a livery working.
  const bare = fitment(design([
    { id: 'team', treatment: 'text', panel: 'L', at: [0.1, 0.5, 0.8, 0.3], text: '{team}' },
    { id: 'stripe', treatment: 'stripe', panel: 'L', at: [0, 0.55, 1, 0.1], color: 'ink' },
  ]), profile);
  assert.deepEqual(bare.findings.filter((f) => f.kind === 'crossed'), []);
  assert.ok(!bare.findings.some((f) => f.severity === 'high'),
    'the constraint is what makes it serious, not the geometry');

  // Two unguarded non-text regions say nothing whatsoever. Layering is how a
  // livery is built, and a checker that has to be ignored teaches you to
  // ignore it.
  const layered = fitment(design([
    { id: 'badge', treatment: 'logo', panel: 'L', at: [0.1, 0.5, 0.8, 0.3] },
    { id: 'stripe', treatment: 'stripe', panel: 'L', at: [0, 0.55, 1, 0.1], color: 'ink' },
  ]), profile);
  assert.deepEqual(layered.findings, [], JSON.stringify(layered.findings));
});

test('a region can set its own legibility floor and its own footing', () => {
  // The panel is 0.4 of a 4 m-per-uv sheet, so 1.6 m across. A box 5% of that
  // is 80 mm — fine by the global 25 mm rule, and not fine for artwork that
  // said it needs 100.
  const r = fitment(design([
    { id: 'sponsor', treatment: 'logo', panel: 'L', at: [0.4, 0.4, 0.05, 0.05],
      constraints: { minMm: 100 } },
    { id: 'other', treatment: 'logo', panel: 'L', at: [0.1, 0.1, 0.05, 0.05] },
  ]), profile);

  const small = r.findings.filter((f) => f.kind === 'unreadable');
  assert.deepEqual(small.map((f) => f.ids[0]), ['sponsor'],
    'only the one that declared a floor — a logo is not text and has no default');
  assert.equal(small[0].severity, 'high', 'a broken promise is not a hint');
  assert.match(small[0].why, /asked for at least 100 mm/);
});

test('a misspelled constraint is refused, not quietly ignored', () => {
  // The worst thing this module could contain. `keepclear` reads as a rule
  // being enforced and behaves as no rule at all, which is precisely the silent
  // pass everything else here exists to refuse.
  const r = fitment(design([
    { id: 'team', treatment: 'text', panel: 'L', at: [0.1, 0.5, 0.8, 0.3], text: '{team}',
      constraints: { keepclear: true } },
    { id: 'stripe', treatment: 'stripe', panel: 'L', at: [0, 0.55, 1, 0.1], color: 'ink' },
  ]), profile);

  const bad = r.findings.filter((f) => f.kind === 'bad-constraint');
  assert.equal(bad.length, 1, JSON.stringify(r.findings));
  assert.equal(bad[0].severity, 'fatal');
  assert.match(bad[0].why, /"keepclear", which nothing enforces/);
  assert.match(bad[0].why, /keepClear, minMm, minOnCar/, 'and says what it could have meant');

  // And the rule it was trying to state is genuinely not in force.
  assert.deepEqual(r.findings.filter((f) => f.kind === 'crossed'), [],
    'nothing pretends the typo worked');
});

test('a painted sheet with an unpainted twin on top of it is reported', () => {
  // The black slab. Asked where the race number should go, I measured every
  // candidate plate and recommended the one scoring 69% visible and 100% on the
  // mesh. Both true. Painting it put a black rectangle across the door, because
  // the car carries FOUR number plate sets at once and each has an emissive
  // duplicate at identical coordinates — paint the colour sheet and the
  // unpainted emissive one draws the car's own artwork over the top.
  //
  // Every other check here asks about a rectangle in a texture. This one cannot
  // be asked that way: the problem is not in the texture at all, it is that two
  // textures are painted onto geometry standing in the same place.
  const base = plane({ rows: 4, cols: 4 });
  const twinned = withPlate(base, 0.0005);      // same place, same facing
  const r = fitment(design([
    { id: 'art', treatment: 'fill', panel: 'L', at: [0, 0, 1, 1], color: 'ink' },
  ]), profile, null, { model: twinned });

  const hit = r.findings.filter((f) => f.kind === 'unpainted-twin');
  assert.equal(hit.length, 1, JSON.stringify(r.findings));
  assert.equal(hit[0].severity, 'high');
  assert.match(hit[0].why, /the same place/);
  assert.match(hit[0].why, /which this design does not paint/);
  assert.ok(r.checked.includes('unpainted-twin'));

  // And silent when the design paints BOTH sheets. Two surfaces in one place is
  // only a problem when one of them is the car's own artwork — if your livery
  // is on both, which one wins matters far less, and reporting it would be the
  // kind of noise that teaches you to skip the whole section.
  const bothPainted = fitment({
    ...design([{ id: 'art', treatment: 'fill', panel: 'L', at: [0, 0, 1, 1], color: 'ink' }]),
    paint: { plate: { regions: [{ treatment: 'fill', color: 'ink' }] } },
  }, {
    ...profile,
    textures: { ...profile.textures, plate: { file: 'plate.dds', width: 64, height: 64 } },
    bind: { ...profile.bind, plate: { roles: ['plate'], source: 'human' } },
    panels: { ...profile.panels, plate: { P: { rect: [0, 0, 1, 1], anisotropy: 1, visible: 1 } } },
  }, null, { model: twinned });
  assert.deepEqual(bothPainted.findings.filter((f) => f.kind === 'unpainted-twin'), [],
    'both sheets carry your artwork, so there is nothing to warn about');
});

test('a twin nobody draws is not a twin', () => {
  // The NSX's IGT emissive plate was reported as an unpainted twin while the
  // design hid it AND the car's own config hid its mesh: a high finding about
  // a part the game never shows. Two ways for a twin to be out of the picture,
  // and both have to silence the check, because each is what a person will
  // reasonably have done about it.
  const twinned = withPlate(plane({ rows: 4, cols: 4 }), 0.0005);
  const art = [{ id: 'art', treatment: 'fill', panel: 'L', at: [0, 0, 1, 1], color: 'ink' }];
  const withPlateRole = {
    ...profile,
    // Drawn by a material that composites alpha, as the model stated and the
    // profile recorded — which is what makes a clear sheet work, and the only
    // thing that makes hiding it silence this check.
    textures: {
      ...profile.textures,
      plate: { file: 'plate.dds', width: 64, height: 64, shaders: ['ksPerPixelAlpha'], alphaHides: true },
    },
  };

  // The design hides it, so the build ships it transparent.
  const hiddenByDesign = fitment({ ...design(art), hide: ['plate', 'not_a_role_here'] },
    withPlateRole, null, { model: twinned });
  assert.deepEqual(hiddenByDesign.findings.filter((f) => f.kind === 'unpainted-twin'), [],
    'a role the design hides ships transparent and draws over nothing');

  // The car hides it, as the profile recorded from the car's own config.
  const named = { ...twinned, meshes: [twinned.meshes[0], { ...twinned.meshes[1], name: 'PLATE_L' }] };
  const hiddenByCar = fitment(design(art), {
    ...withPlateRole,
    hiddenByCar: { source: 'extension/ext_config.ini', meshes: { PLATE_L: { by: 'name', pattern: 'PLATE_L' } }, unmatched: [] },
  }, null, { model: named });
  assert.deepEqual(hiddenByCar.findings.filter((f) => f.kind === 'unpainted-twin'), [],
    'a mesh the car hides is not in the game to draw over anything');

  // And the check is still live: the same model with neither says so.
  const bare = fitment(design(art), withPlateRole, null, { model: twinned });
  assert.equal(bare.findings.filter((f) => f.kind === 'unpainted-twin').length, 1);
});

test('a hide that cannot work silences nothing', () => {
  // Hiding a role is a request, and the build has five answers to it. An
  // opaque shader takes no clear sheet: the surface is drawn in the game
  // exactly as before, still unpainted, still putting the car's own artwork
  // over the design's. Reading the request rather than the answer, this check
  // went quiet about precisely the thing it exists to report — and the design
  // asking for the opposite is what silenced it.
  const twinned = withPlate(plane({ rows: 4, cols: 4 }), 0.0005);
  const art = [{ id: 'art', treatment: 'fill', panel: 'L', at: [0, 0, 1, 1], color: 'ink' }];
  const opaquePlate = {
    ...profile,
    textures: {
      ...profile.textures,
      plate: { file: 'plate.dds', width: 64, height: 64, shaders: ['ksPerPixel'], alphaHides: false },
    },
  };

  const asked = fitment({ ...design(art), hide: ['plate'] }, opaquePlate, null, { model: twinned });
  assert.equal(asked.findings.filter((f) => f.kind === 'unpainted-twin').length, 1,
    'the plate is still drawn, so the twin is still a finding');

  // A profile from before blend modes were recorded is treated the same way,
  // for the same reason the build refuses to claim it hid something: nobody
  // knows that it did.
  const unrecorded = {
    ...profile,
    textures: { ...profile.textures, plate: { file: 'plate.dds', width: 64, height: 64 } },
  };
  const old = fitment({ ...design(art), hide: ['plate'] }, unrecorded, null, { model: twinned });
  assert.equal(old.findings.filter((f) => f.kind === 'unpainted-twin').length, 1,
    'an unrecorded answer is not evidence that a clear sheet would work');
});

test('the back of a panel is not a twin', () => {
  // The two false positives that survived every other filter: DOOR_Left against
  // DOOR_Left_INT, and the hood's outer shell against its inner. Same bounding
  // box to within a percent, because they are the two sides of one panel — and
  // not a problem, since you cannot see both at once.
  //
  // A colour sheet and its emissive twin face the SAME way, being one surface
  // drawn twice. An inner shell faces the other way. Structural, not tuned.
  const base = plane({ rows: 4, cols: 4 });
  const m = base.meshes[0];
  // Negate the 3x3 and translate back, which flips every normal while leaving
  // the bounding box exactly where it was. `vertex` applies the world matrix to
  // normals, so this is the one place a flip can be expressed — the two meshes
  // share a vertex block, and editing it in the buffer flips both.
  const backed = {
    ...base,
    materials: [...base.materials, { slots: { txDiffuse: 'back.dds' } }],
    meshes: [m, { ...m, materialId: 1,
      world: [-1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 1.6, 1.6, 0.0005, 1] }],
  };
  const r = fitment(design([
    { id: 'art', treatment: 'fill', panel: 'L', at: [0, 0, 1, 1], color: 'ink' },
  ]), profile, null, { model: backed });

  assert.deepEqual(r.findings.filter((f) => f.kind === 'unpainted-twin'), [],
    'the back of a panel is how a car is modelled, not a mistake');
});

test('a profile that disagrees with the model is fatal, not quietly skipped', () => {
  // Both geometry checks live in one function, so returning early when no mesh
  // used the surface's texture skipped them BOTH while `checked` still claimed
  // they had run.
  const model = plane({ rows: 4, cols: 4 });
  const wrong = structuredClone(profile);
  wrong.textures.body.file = 'a-file-no-mesh-uses.dds';

  const r = fitment(design([
    { id: 'art', treatment: 'fill', panel: 'L', at: [0, 0, 1, 1], color: 'ink' },
  ]), wrong, null, { model });

  const fatal = r.findings.filter((f) => f.severity === 'fatal');
  assert.equal(fatal.length, 1, JSON.stringify(r.findings));
  assert.match(fatal[0].why, /no mesh in this car's model uses/);
  assert.match(fatal[0].why, /disagree/);
  // And it is NOT reported as a run that found nothing.
  assert.ok(r.checked.includes('unseen'), 'the check was attempted');
  assert.ok(fatal[0].why.includes('a-file-no-mesh-uses.dds'), 'and names the file');
});

test('an occluder that is not one of the model meshes is refused', async () => {
  // `indexOf` returns -1 for a mesh that is merely a copy, which made `owner`
  // 0 — the value meaning "empty" — so the mesh marked no cells and occluded
  // nothing. The measurement still came back, confident and wrong.
  const { occupancyFor } = await import('../src/engine/visibility.mjs');
  const model = plane({ rows: 3, cols: 3 });
  const copy = { ...model.meshes[0] };          // same data, different identity

  assert.throws(() => occupancyFor(model, { occluders: [copy] }),
    /is not one of model\.meshes/);
  assert.doesNotThrow(() => occupancyFor(model, { occluders: model.meshes }));
});

test('a constraint with a bad value is refused, like a bad name', () => {
  // Checking the name alone was half a check. `keepClear: 'yes'` is truthy and
  // reads as a rule in force; `minMm: NaN` fails every comparison it is put in
  // and enforces nothing. Both are the same silent pass as a typo.
  const bad = (constraints) => fitment(design([
    { id: 'team', treatment: 'text', panel: 'L', at: [0.1, 0.5, 0.8, 0.3],
      text: '{team}', constraints },
  ]), profile).findings.filter((f) => f.kind === 'bad-constraint');

  assert.match(bad({ keepClear: 'yes' })[0].why, /must be true or false/);
  assert.match(bad({ minMm: NaN })[0].why, /must be a number/);
  assert.match(bad({ minMm: 'big' })[0].why, /must be a number/);
  assert.match(bad({ minOnCar: 90 })[0].why, /fraction between 0 and 1/);
  assert.match(bad({ minMm: -5 })[0].why, /above zero/);
  assert.equal(bad({ keepClear: true, minMm: 40, minOnCar: 0.9 }).length, 0,
    'and the good ones say nothing');

  // A refused constraint must not go on to be half-enforced by whatever reads
  // it next: a stripe over a region whose keepClear was rejected is not a
  // `crossed` finding, because that region never successfully asked.
  const r = fitment(design([
    { id: 'team', treatment: 'logo', panel: 'L', at: [0.1, 0.5, 0.8, 0.3],
      constraints: { keepClear: 'yes' } },
    { id: 'stripe', treatment: 'stripe', panel: 'L', at: [0, 0.55, 1, 0.1], color: 'ink' },
  ]), profile);
  assert.deepEqual(r.findings.filter((f) => f.kind === 'crossed'), [],
    'nothing pretends the bad value worked');
});

test('a region that lands on no panel is a finding, not a pass', () => {
  // Found by an agent. Every region it wrote selected `tags: ['left', 'body']`,
  // and no panel on the car is tagged `body`, so nothing was painted — and
  // this module returned no findings at all, three rounds running, over a car
  // still in bare primer. The tag selection's own note said what had happened
  // and was dropped before anything read it; a panel the car lacks was caught
  // and turned into silence the same way.
  const r = fitment(design([
    { id: 'number-left', treatment: 'text', tags: ['left', 'body'], at: [0.2, 0.2, 0.6, 0.3], text: '{number}' },
    { id: 'sponsor', treatment: 'text', panel: 'Q', at: [0.2, 0.2, 0.6, 0.3], text: '{team}' },
    { id: 'wash', treatment: 'fill', tags: ['left'], color: 'ink' },
  ]), profile);

  const un = r.findings.filter((f) => f.kind === 'unmatched');
  assert.deepEqual(un.map((f) => f.ids[0]).sort(), ['number-left', 'sponsor'],
    `both regions that paint nothing are named: ${JSON.stringify(r.findings)}`);
  assert.ok(un.every((f) => f.severity === 'high'), 'and they fail a gate, not just inform it');
  // Saying what to write instead: the reader was guessing at the vocabulary.
  assert.match(un.find((f) => f.ids[0] === 'number-left').why, /Tags on this texture: left, right, visible/);
  assert.ok(r.checked.includes('unmatched'));
  // The region that did land is untouched by any of this.
  assert.equal(r.findings.some((f) => f.ids.includes('wash@L') && f.kind === 'unmatched'), false);
});

test('an at that cannot be placed is not reported as a panel the car lacks', () => {
  // `at` is checked before the panel is looked up, and every error from either
  // was labelled "names a panel this car does not have" — so a region with an
  // `at` past its panel's edge, on a panel the car has, was sent looking for
  // a panel that was never missing.
  const r = fitment(design([
    { id: 'wide', treatment: 'text', panel: 'L', at: [0, 0, 2, 1], text: '{team}' },
    { id: 'lost', treatment: 'text', panel: 'Q', at: [0.2, 0.2, 0.6, 0.3], text: '{team}' },
  ]), profile);

  const un = r.findings.filter((f) => f.kind === 'unmatched');
  const wide = un.find((f) => f.ids[0] === 'wide');
  assert.ok(wide, JSON.stringify(r.findings));
  assert.equal(wide.severity, 'high');
  assert.doesNotMatch(wide.why, /panel this car does not have/);
  assert.match(wide.why, /"at"/);
  assert.match(un.find((f) => f.ids[0] === 'lost')?.why ?? '', /names a panel this car does not have/);
});

test('a field no treatment takes and nothing else reads is a finding, not a no-op', () => {
  // An agent spent four rounds making a number bigger with
  // `options: { scale: 1.5 }`. The renderer hands a treatment the whole region
  // and the treatment ignores what it does not know, so the number never
  // changed size and nothing said so.
  const r = fitment(design([
    { id: 'number', treatment: 'text', panel: 'L', at: [0.1, 0.1, 0.8, 0.5], text: '{number}',
      options: { scale: 1.5 }, minMm: 30 },
    // Every field here is read by somebody, so none of them is reported.
    { id: 'wash', treatment: 'fill', panel: 'L', at: [0, 0, 1, 1], color: 'ink',
      safe: false, rotate: 'auto', scale: 1, constraints: { minOnCar: 0.1 } },
  ]), profile);

  const unk = r.findings.filter((f) => f.kind === 'unknown-field');
  assert.deepEqual(unk.map((f) => f.field).sort(), ['minMm', 'options'], JSON.stringify(unk));
  assert.ok(unk.every((f) => f.severity === 'high' && f.ids[0] === 'number'));
  assert.match(unk.find((f) => f.field === 'options').why, /on the region itself/);
  assert.match(unk.find((f) => f.field === 'minMm').why, /"constraints": \{ "minMm": 30 \}/);
  assert.ok(r.checked.includes('unknown-field'));
});

test('drop on a design region is reported, because only a fit reads it', () => {
  // `drop` was let through as a placement field, and a fit is the only thing
  // that reads it. Written on the design it removed nothing and said nothing,
  // which is the do-nothing field this check exists to catch.
  const r = fitment(design([
    { id: 'number', treatment: 'text', panel: 'L', at: [0.1, 0.1, 0.8, 0.5], text: '{number}', drop: true },
  ]), profile);

  const unk = r.findings.filter((f) => f.kind === 'unknown-field');
  assert.deepEqual(unk.map((f) => f.field), ['drop'], JSON.stringify(r.findings));
  assert.equal(unk[0].severity, 'high');
  assert.match(unk[0].why, /drop belongs in a fit/);
});

test('a region can say how much of it must be seen, and a slice behind something is reported', () => {
  // A roundel measured 99% on the door, and the strip along its top 44%
  // visible — tucked under the window frame. It is on the car and it is cut
  // off, and the only visibility rule there was speaks up below 35%.
  const model = plane({ rows: 8, cols: 8 });
  const half = withPlate(model, 0.005);
  half.meshes[1].world[0] = 0.5;              // the plate now covers the left half of the sheet
  const seen = probe(half, [0, 0, 0.4, 0.4]).fraction;
  assert.ok(seen > 0.35 && seen < 0.8, `the region is about half hidden: ${seen}`);

  const roundel = (constraints) => design([
    { id: 'roundel', treatment: 'fill', panel: 'L', at: [0, 0, 1, 1], color: 'ink', ...(constraints ? { constraints } : {}) },
  ]);
  const unseen = (r) => r.findings.filter((f) => f.kind === 'unseen');

  assert.deepEqual(unseen(fitment(roundel(), profile, null, { model: half })), [],
    'with no floor declared, half seen passes, as it always did');

  const asked = unseen(fitment(roundel({ minVisible: 1 }), profile, null, { model: half }));
  assert.equal(asked.length, 1, 'a floor of 100% is not met by half');
  assert.equal(asked[0].severity, 'high');
  assert.match(asked[0].why, /asked for at least 100%/);

  assert.deepEqual(unseen(fitment(roundel({ minVisible: 1 }), profile, null, { model })), [],
    'bare bodywork meets a floor of 100%');

  const bad = fitment(roundel({ minVisible: 90 }), profile).findings.filter((f) => f.kind === 'bad-constraint');
  assert.match(bad[0]?.why ?? '', /fraction between 0 and 1/, 'and the value is checked like minOnCar');
});

test('a ring is measured by the circle it draws, not only by its box', () => {
  // Two agent mistakes that passed as boxes. A roundel of radius 0.5 and width
  // 0.5 painted a white band out to 0.75 of its box, past the rectangle its
  // 100%-on-car and 100%-visible constraints were measured on. And a thin
  // halo inside it ran straight through the race number, which the box check
  // reported as the same low overlap as a halo going round it.
  const ring = (id, radius, width, extra = {}) => ({
    id, treatment: 'ring', panel: 'L', at: [0.2, 0.2, 0.6, 0.6], color: 'ink', radius, width, ...extra });
  const number = { id: 'number', treatment: 'text', panel: 'L', at: [0.35, 0.35, 0.3, 0.3], text: '{number}' };
  const found = (regions, kind) => fitment(design(regions), profile).findings.filter((f) => f.kind === kind);

  assert.deepEqual(found([ring('disc', 0.25, 0.5), number], 'overflows'), [], 'a disc exactly fills its box');
  assert.deepEqual(found([ring('disc', 0.25, 0.5), number], 'overlap'), [], 'and a number on its roundel is the design working');

  const over = found([ring('roundel', 0.5, 0.5, { constraints: { minOnCar: 1 } })], 'overflows');
  assert.equal(over.length, 1);
  assert.equal(over[0].severity, 'high', 'its declared guarantees are about a box the paint left');
  assert.match(over[0].why, /out to 0\.75/);
  assert.equal(found([ring('roundel', 0.5, 0.5)], 'overflows')[0].severity, 'low', 'undeclared, it is bleed');

  const through = found([ring('halo', 0.2, 0.04), number], 'overlap');
  assert.equal(through.length, 1, JSON.stringify(through));
  assert.equal(through[0].severity, 'high');
  assert.match(through[0].why, /circle runs through .*number/);
  assert.deepEqual(found([ring('halo', 0.47, 0.04), number], 'overlap'), [], 'the same halo big enough to go round it');
});

test('a ring painted over text is reported by what it covers, whatever the boxes share', () => {
  // The circle check asked only whether an edge of the ring crossed the text,
  // and ignored which of the two was on top. A solid disc painted AFTER a
  // number has no edge inside it and hides every glyph, and it came back with
  // no finding at all — where the plain box check had at least said something.
  const disc = { id: 'disc', treatment: 'ring', panel: 'L', at: [0.2, 0.2, 0.6, 0.6], color: 'ink', radius: 0.25, width: 0.5 };
  const number = { id: 'number', treatment: 'text', panel: 'L', at: [0.35, 0.35, 0.3, 0.3], text: '{number}' };
  const found = (regions) => fitment(design(regions), profile).findings.filter((f) => f.kind === 'overlap');

  const buried = found([number, disc]);
  assert.equal(buried.length, 1, JSON.stringify(buried));
  assert.equal(buried[0].severity, 'high');
  assert.deepEqual(buried[0].ids, ['disc', 'number']);
  assert.match(buried[0].why, /disc.*paints over .*number/);
  assert.deepEqual(found([disc, number]), [], 'the number on top of its roundel is the design working');

  // And measured by the circle BEFORE the boxes are asked how much they share.
  // A ring's box can meet a name's box at one corner, 12.5% of the smaller,
  // while its stroke runs straight through the name — and the share threshold
  // that keeps layered boxes quiet turned that away before the circle was
  // looked at.
  const halo = { id: 'halo', treatment: 'ring', panel: 'L', at: [0.4, 0.4, 0.2, 0.2], color: 'ink', radius: 0.45, width: 0.1 };
  const team = { id: 'team', treatment: 'text', panel: 'L', at: [0, 0.45, 0.45, 0.1], text: '{team}' };
  const grazed = found([halo, team]);
  assert.equal(grazed.length, 1, JSON.stringify(grazed));
  assert.equal(grazed[0].share, 0.125, 'the boxes barely meet');
  assert.match(grazed[0].why, /circle runs through .*team/);
});

test('a region can ask for clean bodywork all round it, and find_space finds where there is some', async () => {
  // On the NSX the top quarter of the door's box is not door and the middle
  // of the box is under the window frame, so "the middle of the panel" put a
  // roundel's top edge where it could not be seen. Here, a plate hides the
  // left half of the sheet: 0.8 m of a 1.6 m panel.
  const { findSpace } = await import('../src/space.mjs');
  const model = plane({ rows: 8, cols: 8 });
  const half = withPlate(model, 0.005);
  half.meshes[1].world[0] = 0.5;

  // This box starts 0.896 m across, 96 mm clear of the plate.
  const box = (m) => design([{ id: 'roundel', treatment: 'fill', panel: 'L', at: [0.56, 0.3, 0.2, 0.2],
    color: 'ink', constraints: { minMargin: m } }]);
  const margin = (r) => r.findings.filter((f) => f.kind === 'margin');
  assert.deepEqual(margin(fitment(box(50), profile, null, { model: half })), [], '96 mm clear meets 50');
  const tight = margin(fitment(box(200), profile, null, { model: half }));
  assert.equal(tight.length, 1, 'and does not meet 200');
  assert.equal(tight[0].severity, 'high');
  assert.match(tight[0].why, /200 mm of clean bodywork/);
  assert.ok(fitment(box(50), profile).notChecked.includes('margin'), 'without the model it is said not to have run');

  const found = findSpace({ profile, model: half, prepared: occupancyFor(half), role: 'body', panel: 'L',
    widthMm: 300, marginMm: 50, cellMm: 100 });
  assert.ok(found.candidates.length > 0, JSON.stringify(found));
  for (const c of found.candidates) {
    assert.ok(c.at[0] * 1600 >= 850 - 1, `every spot is in the clean half, clear of the plate: ${JSON.stringify(c)}`);
    assert.ok(c.marginMm >= 50);
    assert.ok(c.onCar >= 0.98 && c.visible >= 0.98, JSON.stringify(c));
    // And the check that consumes the answer agrees with it. Clearance was a
    // diagonal distance while minMargin grows the box on every side, so a spot
    // offered with 50 mm could fail a 50 mm margin.
    const held = fitment(design([{ id: 'roundel', treatment: 'fill', panel: 'L', at: c.at, color: 'ink',
      constraints: { minMargin: 50, minVisible: 1 } }]), profile, null, { model: half });
    assert.deepEqual(held.findings.filter((f) => ['margin', 'unseen'].includes(f.kind)), [],
      `a spot find_space offers passes the margin it was asked for: ${JSON.stringify(c)}`);
  }
  assert.ok(found.map.every((row) => row.startsWith('.')), 'the hidden half is marked on the map');

  const none = findSpace({ profile, model: half, prepared: occupancyFor(half), role: 'body', panel: 'L',
    widthMm: 900, marginMm: 50, cellMm: 100 });
  assert.deepEqual(none.candidates, []);
  assert.match(none.note, /No spot on L fits 900 x 900 mm/);
});

test('a surface bound to two textures is asked about on the one that has the panel', async () => {
  // A formula car's body binds body AND bodyRear. Asked for a panel only the
  // second has, taking the first bound texture reported the panel absent.
  const { spaceRole } = await import('../src/space.mjs');
  const panel = { rect: [0, 0, 0.4, 0.4], metresPerUv: [4, 4], tags: [] };
  const two = {
    panels: { body: { L: panel, shared: panel }, bodyRear: { tail: panel, shared: panel } },
    bind: { body: { roles: ['body', 'bodyRear'], source: 'human' } },
  };
  assert.deepEqual(spaceRole(two, {}, 'surfaces.body', 'tail'), { role: 'bodyRear' });
  assert.deepEqual(spaceRole(two, {}, 'body', 'L'), { role: 'body' });
  assert.match(spaceRole(two, {}, 'surfaces.body', 'shared').error, /on body and bodyRear.*pass paint\.body or paint\.bodyRear/);
  assert.deepEqual(spaceRole(two, {}, 'paint.body', 'shared'), { role: 'body' }, 'a texture named outright is that texture');
  assert.deepEqual(spaceRole(two, {}, 'bodyRear', 'shared'), { role: 'bodyRear' });
  assert.match(spaceRole(two, {}, 'surfaces.body', 'nowhere').error, /none of them has a panel called "nowhere"/);
});

test('find_space asks the sweep once per panel, and a panel name is taken on the texture the design paints', async () => {
  const { findSpace, cleanGrid, spaceRole } = await import('../src/space.mjs');
  const { loadProfile } = await import('../src/profile.mjs');
  // The sweep is the slow half and depends only on the panel: an agent asked
  // six sizes of one door and paid for six sweeps, half a minute each.
  const model = plane({ rows: 8, cols: 8 });
  const half = withPlate(model, 0.005);
  half.meshes[1].world[0] = 0.5;
  const prepared = occupancyFor(half);
  const grid = cleanGrid({ profile, model: half, prepared, role: 'body', panel: 'L', cellMm: 100 });
  for (const widthMm of [300, 450]) {
    assert.deepEqual(
      findSpace({ grid, model: half, prepared, widthMm, marginMm: 50 }),
      findSpace({ profile, model: half, prepared, role: 'body', panel: 'L', widthMm, marginMm: 50, cellMm: 100 }),
      `a kept sweep answers ${widthMm} mm exactly as a fresh one does`);
  }

  // On the NSX, left_mid is a panel on nine textures. The design paints one.
  const nsx = await loadProfile(new URL('../cars/ac_friends_honda_nsx_gt3_evo.json', import.meta.url).pathname);
  const paintsBody = { name: 'd', packs: ['core'], surfaces: { body: { regions: [] } } };
  const taken = spaceRole(nsx, paintsBody, undefined, 'left_mid');
  assert.equal(taken.role, 'ext_skin_sponsors', JSON.stringify(taken));
  assert.match(taken.chosen, /only one this design paints/);
  assert.match(spaceRole(nsx, { name: 'd', packs: ['core'] }, undefined, 'left_mid').error ?? '',
    /pass role to say which/, 'a design that paints none of them is still asked which');
  assert.equal(spaceRole(nsx, paintsBody, 'glass', 'left_mid').role, 'glass', 'a role named outright wins');
  assert.equal(spaceRole(nsx, paintsBody, 'surfaces.body', 'left_mid').role, 'ext_skin_sponsors');
  assert.match(spaceRole(nsx, paintsBody, undefined, 'no_such_panel').error, /No panel called/);
});

test('a panel swept in one pass measures every cell exactly as asking cell by cell does', async () => {
  // The sweep behind find_space asked rectVisibility once per cell, and each
  // ask walks every triangle of the texture whatever the cell's size: 609
  // cells of the NSX door took half a minute. One walk gives the same samples.
  const { gridVisibility } = await import('../src/engine/visibility.mjs');
  const model = plane({ rows: 8, cols: 8 });
  const half = withPlate(model, 0.005);
  half.meshes[1].world[0] = 0.5;
  const prepared = occupancyFor(half);
  const meshes = [half.meshes[0]];
  const [px, py, pw, ph] = profile.panels.body.L.rect;
  const cols = 7, rows = 5;
  const grid = gridVisibility(half, prepared, meshes, [px, py, pw, ph], cols, rows, { per: 4 });
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const one = rectVisibility(half, prepared, meshes,
        [px + c * pw / cols, py + r * ph / rows, pw / cols, ph / rows], { across: 4 });
      assert.deepEqual(grid[r][c], one ? { samples: one.samples, of: one.of, fraction: one.fraction }
        : { samples: 0, of: 16, fraction: 0 }, `cell ${r},${c}`);
    }
  }
});

test('a fitting standing a few millimetres proud of the paint covers what is under it', () => {
  // The NSX door handle is a chrome strip 2-10 mm off the door. A team name
  // whose last letter ran under it measured 100% seen twice over: the voxel
  // grid is 2.5 cm and cannot tell a strip that close from the door, and
  // fourteen samples across a 680 mm name never tested its last 24 mm. The
  // draft passed the gate and went to a person, who failed it on sight.
  const model = plane({ rows: 8, cols: 8 });
  const strip = withPlate(model, 0.005);
  const handle = strip.meshes[1];
  handle.name = 'DOOR_HANDLE';
  // 300 x 120 mm from x 1.10 m: over the last 20 mm of a name ending at 1.12.
  handle.world[0] = 0.3 / 1.6; handle.world[12] = 1.10;
  handle.world[5] = 0.12 / 1.6; handle.world[13] = 0.78;

  const name = (at) => design([{ id: 'team', treatment: 'text', panel: 'L', at, text: '{team}',
    constraints: { minVisible: 1 } }]);
  // Panel L is 1.6 m square, so this name runs x 0.16-1.12 m, y 0.80-0.88 m.
  const under = fitment(name([0.1, 0.5, 0.6, 0.05]), profile, null, { model: strip })
    .findings.filter((f) => f.kind === 'unseen');
  assert.equal(under.length, 1, JSON.stringify(under));
  assert.equal(under[0].severity, 'high');
  assert.match(under[0].why, /directly under DOOR_HANDLE/, 'and it says what is in the way');
  assert.doesNotMatch(under[0].why, /is 100% visible/, 'a shortfall is not rounded away');

  // Ending 60 mm short of the handle, it is clear.
  const clear = fitment(name([0.1, 0.5, 0.55, 0.05]), profile, null, { model: strip });
  assert.deepEqual(clear.findings.filter((f) => f.kind === 'unseen'), []);
});
