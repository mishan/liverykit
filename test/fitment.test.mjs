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

  assert.deepEqual(r.notChecked, ['unseen', 'unmeasured'],
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

test('a rectangle with too few vertices under it is declared, not passed', () => {
  // The failure this module was written to prevent, found inside the module.
  //
  // `unseen` casts rays from mesh vertices whose uv lands in the rectangle, so
  // its resolution is the vertex spacing of the car — and a region smaller than
  // that spacing simply has nothing to cast from. The check returned early and
  // said nothing, which reads exactly like a pass.
  //
  // Measured on the real Honda: seventeen regions of a shipping design were
  // being silently declined, against one genuine `unseen`. The quiet ones
  // outnumbered the answers seventeen to one.
  const model = plane({ rows: 24, cols: 24 });   // vertices every ~1/24 of uv
  const r = fitment(design([
    { id: 'broad', treatment: 'text', panel: 'L', at: [0.1, 0.1, 0.8, 0.8], text: '{team}' },
    { id: 'slim', treatment: 'text', panel: 'L', at: [0.5, 0.5, 0.02, 0.02], text: '{number}' },
  ]), profile, null, { model });

  const quiet = r.findings.filter((f) => f.kind === 'unmeasured');
  assert.deepEqual(quiet.map((f) => f.ids[0]), ['slim'],
    `only the region too small to sample: ${r.findings.map((f) => f.why).join(' | ')}`);
  assert.match(quiet[0].why, /too few to say/);
  assert.ok(quiet[0].samples < 20, 'and it says how few it had');

  // With a model present, both checks ran — nothing is owed to notChecked.
  assert.deepEqual(r.notChecked, []);
  assert.ok(r.checked.includes('unmeasured'));
});

/** A flat sheet of vertices facing +z, uv spread over the whole panel rect. */
function plane({ rows, cols }) {
  const stride = 32, n = rows * cols;
  const buf = Buffer.alloc(n * stride);
  for (let i = 0; i < n; i++) {
    const u = (i % cols) / (cols - 1), v = Math.floor(i / cols) / (rows - 1);
    const o = i * stride;
    buf.writeFloatLE(u * 1.6, o); buf.writeFloatLE(v * 1.6, o + 4); buf.writeFloatLE(0, o + 8);
    buf.writeFloatLE(0, o + 12); buf.writeFloatLE(0, o + 16); buf.writeFloatLE(1, o + 20);
    // Panel L is [0, 0, 0.4, 0.4] of the sheet; place the plane's uv inside it.
    buf.writeFloatLE(u * 0.4, o + 24);
    buf.writeFloatLE(v * 0.4 - 1, o + 28);   // stored negative; vertex() adds 1
  }
  const world = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
  return {
    buf,
    materials: [{ slots: { txDiffuse: 'b.dds' } }],
    meshes: [{ materialId: 0, vertexStart: 0, vertexCount: n, stride, world }],
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
