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
import { fitment, wholePieces } from '../src/fitment.mjs';
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

test('a number or a name is measured by its letters, not its box', () => {
  // The panels here are 1.6 m square on the car. Runs 17, 18 and 20 each lost a
  // round to a team name the critic called too small, a round after drafting it.
  const small = (regions, identity = { team: 'Neon Doll Racing', number: '85' }) =>
    fitment({ ...design(regions), identity }, profile).findings.filter((f) => f.kind === 'too-small');

  // 480 mm box, capitals 242 mm: fine. 160 mm box, capitals 81: not.
  assert.deepEqual(small([{ id: 'n', treatment: 'text', panel: 'L', at: [0.2, 0.5, 0.6, 0.3], text: '{number}' }]), []);
  const tiny = small([{ id: 'n', treatment: 'text', panel: 'L', at: [0.2, 0.5, 0.6, 0.1], text: '{number}' }]);
  assert.deepEqual(tiny.map((f) => [f.ids[0], f.severity, f.mm, f.floor]), [['n', 'high', 81, 140]]);
  assert.match(tiny[0].why, /Make its box taller \(it is 160 mm\)/);

  // A 320 mm box looks generous, and sixteen letters shrunk to fit 480 mm of
  // width are 31 mm tall. The box's height is not the answer; its width is.
  const narrow = small([{ id: 't', treatment: 'text', panel: 'L', at: [0.1, 0.1, 0.3, 0.2], text: '{team}' }]);
  assert.deepEqual(narrow.map((f) => f.mm), [31]);
  assert.match(narrow[0].why, /shrunk to fit the box's 480 mm width: widen the box, or split the name over two lines/);
  assert.deepEqual(small([{ id: 't', treatment: 'text', panel: 'L', at: [0, 0.1, 1, 0.2], text: '{team}' }]), []);

  // A name split into literal lines is still the name; a sponsor is not.
  assert.equal(small([{ id: 'a', treatment: 'text', panel: 'L', at: [0.1, 0.1, 0.2, 0.05], text: 'NEON DOLL' }]).length, 1);
  assert.deepEqual(small([{ id: 's', treatment: 'text', panel: 'L', at: [0.1, 0.1, 0.2, 0.05], text: 'ACME' }]), []);

  // And a declared minMm is a floor on the box, not a way round this one.
  assert.equal(small([{ id: 't', treatment: 'text', panel: 'L', at: [0.1, 0.1, 0.3, 0.2], text: '{team}',
    constraints: { minMm: 100 } }]).length, 1);
});

test('a name is held to the number only where the design says so', async () => {
  // A person marked run 18's team name, on the rear quarter, as nowhere a
  // spectator looks. But a brief may want a name on the roof, so this is a
  // rule the design states, never one the checker assumes.
  const text = (id, panel, extra = {}) => ({ id, treatment: 'text', panel, at: [0.1, 0.1, 0.8, 0.3],
    text: id === 'number' ? '{number}' : '{team}', ...extra });
  const found = (regions, fit = null, prof = profile) => fitment(design(regions), prof, fit).findings
    .filter((f) => f.kind === 'ungrouped' || f.kind === 'bad-constraint');
  const withNumber = { constraints: { groupWith: 'number' } };

  assert.deepEqual(found([text('number', 'L'), text('team', 'R')]), [], 'apart, and nobody asked');

  const apart = found([text('number', 'L'), text('team', 'R', withNumber)]);
  assert.deepEqual(apart.map((f) => [f.kind, f.severity, f.ids]), [['ungrouped', 'high', ['team', 'number']]]);
  assert.match(apart[0].why, /team asked to sit with number \(groupWith\), and is on R while number is on L/);

  // Together by an alias on one side and the panel's own name on the other.
  const aliased = { ...profile, aliases: { body: { doorLeft: 'L' } } };
  assert.deepEqual(found([text('number', 'L'), text('team', 'doorLeft', withNumber)], null, aliased), []);

  // A fit that moves the number onto the name's panel groups them on this car.
  assert.deepEqual(found([text('number', 'L'), text('team', 'R', withNumber)],
    { livery: 'F', car: 'fixture', regions: { number: { panel: 'R' } } }), []);

  // A misspelled id is refused, not read as a rule in force; so is naming itself.
  const typo = found([text('number', 'L'), text('team', 'L', { constraints: { groupWith: 'numbr' } })]);
  assert.deepEqual(typo.map((f) => [f.kind, f.severity]), [['bad-constraint', 'fatal']]);
  assert.match(typo[0].why, /no region in this design is called that/);
  assert.equal(found([text('team', 'L', { constraints: { groupWith: 'team' } })])[0]?.kind, 'bad-constraint');

  // And the editor will not write one that is not another region's id.
  const { opSetConstraint } = await import('../src/ui/ops.js');
  const d = design([text('team', 'L')]);
  assert.throws(() => opSetConstraint(d, { id: 'team', key: 'groupWith', value: 3 }), /takes a string/);
  assert.throws(() => opSetConstraint(d, { id: 'team', key: 'groupWith', value: 'team' }), /another region's id/);
  opSetConstraint(d, { id: 'team', key: 'groupWith', value: 'number' });
  assert.equal(d.surfaces.body.regions[0].constraints.groupWith, 'number');
});

test('find_space refuses a margin or a count it cannot honour, before measuring anything', async () => {
  // A negative margin returned spots with less clearance than asked for, and a
  // count of NaN switched off both limits on a loop where every step walks the
  // whole mesh. Refused before the grid is touched, so an empty one will do.
  const { findSpace, largestSpace } = await import('../src/space.mjs');
  const ask = (over) => () => findSpace({ grid: {}, widthMm: 100, ...over });
  assert.throws(ask({ marginMm: -5 }), /marginMm is clean bodywork all round in mm, zero or more; got -5/);
  assert.throws(ask({ marginMm: NaN }), /marginMm/);
  assert.throws(ask({ count: NaN }), /count is how many spots to return, a whole number from 1; got null/);
  assert.throws(ask({ count: 0 }), /count/);
  assert.throws(ask({ count: 2.5 }), /count/);
  assert.throws(() => largestSpace({ grid: {}, aspect: 1, marginMm: -1 }), /marginMm/);
});

test('the parts a crash or a spinning wheel swaps in stand in front of nothing', async () => {
  // The renderer and the near-field test already left them out; the voxel
  // occluders did not, so fitment could call artwork hidden by a mesh the car
  // at rest does not show.
  const { carOccluders } = await import('../src/engine/visibility.mjs');
  const model = {
    meshes: [{ name: 'BODY', materialId: 0 }, { name: 'EXT_RIM_BLUR_LF', materialId: 0 }, { name: 'GLASS_DAMAGE', materialId: 1 }],
    materials: [{ shader: 'ksPerPixel' }, { shader: 'ksBrokenGlass' }],
  };
  assert.deepEqual(carOccluders(model, {}).map((m) => m.name), ['BODY']);
  assert.deepEqual(carOccluders(model, { hiddenByCar: { meshes: { BODY: {} } } }).map((m) => m.name), []);
});

test('letters on a panel laid a quarter turn stand along u', () => {
  // A road car turns its doors sideways to pack the sheet, and the text is
  // turned back upright. Its letters then run along the texture's u, which on
  // this panel is eight times as many metres per unit as v.
  const turned = {
    ...profile,
    panels: { body: { S: { rect: [0, 0, 0.4, 0.4], anisotropy: 1, metresPerUv: [8, 1], textRotation: 90, visible: 1, tags: ['left'] } } },
  };
  const got = (rotate) => fitment(design([{ id: 'n', treatment: 'text', panel: 'S', at: [0.4, 0.1, 0.2, 0.8], text: '{number}', rotate }]), turned)
    .findings.filter((f) => f.kind === 'too-small').map((f) => f.mm);
  // Turned, the 0.08-wide box is the letters' height: 0.7 x 0.08 x 8 m x 0.72 = 323 mm.
  assert.deepEqual(got('auto'), []);
  // Upright, the letters stand along v and the 0.32-tall box shrinks one glyph
  // to its 0.08 width: 82 mm, and said.
  assert.deepEqual(got(0), [82]);

  // And a long name on it is fitted to the turned box's long side. Fitted to
  // the short one instead, sixteen letters come out 41 mm tall and fail.
  const name = fitment({ ...design([{ id: 't', treatment: 'text', panel: 'S', at: [0.4, 0.1, 0.2, 0.8],
    text: '{team}', rotate: 'auto' }]), identity: { team: 'Neon Doll Racing' } }, turned);
  assert.deepEqual(name.findings.filter((f) => f.kind === 'too-small'), []);
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

  // And the checks that need a panel do not guess: there is no safe area to be
  // outside of, and no metres to be too small in. Size says it went unmeasured,
  // low, rather than nothing: a name nobody measured read exactly like one
  // that passed.
  assert.deepEqual(r.findings.filter((f) => f.kind === 'outside-safe'), []);
  assert.deepEqual(r.findings.filter((f) => f.kind === 'unreadable').map((f) => [f.severity, f.measured]), [['low', false]]);
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
  // are in the SAME cell, so no starting distance separates them. Nor do the
  // cell's two owners, which a shell behind the door has too. What separates
  // them is asking exactly: the ray straight out meets the plate 5 mm away.
  const model = plane({ rows: 6, cols: 6 });
  const clear = probe(model, [0.02, 0.02, 0.06, 0.06]);
  assert.equal(clear.fraction, 1, 'bare bodywork is visible');

  const plated = probe(withPlate(model, 0.005), [0.02, 0.02, 0.06, 0.06]);
  assert.equal(plated.fraction, 0,
    `a plate 5 mm off the paint hides it, got ${plated.fraction}`);
  assert.equal(plated.samples, clear.samples,
    'and the paint is still on the car — hidden is not the same as absent');
});

test('something behind a panel does not stand in front of it', () => {
  // The other side of that ownership rule. A mesh a few millimetres BEHIND
  // the paint — a door's inner shell, a bonnet's carbon liner — shares its
  // voxels exactly as a plate in front of it does, and a shared voxel stopped
  // every ray leaving the surface. The NSX's doors measured 64% visible for
  // it, against 88% before ownership existed.
  const model = plane({ rows: 6, cols: 6 });
  const behind = probe(withPlate(model, -0.005), [0.02, 0.02, 0.06, 0.06]);
  assert.equal(behind.fraction, 1, `a shell 5 mm behind the paint hides nothing, got ${behind.fraction}`);
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
  // looked at. A name long enough to fill its box: the circle is measured
  // against the letters, and a one-letter name sits clear of the halo.
  const halo = { id: 'halo', treatment: 'ring', panel: 'L', at: [0.4, 0.4, 0.2, 0.2], color: 'ink', radius: 0.45, width: 0.1 };
  const team = { id: 'team', treatment: 'text', panel: 'L', at: [0, 0.45, 0.45, 0.1], text: 'NEON DOLL RACING' };
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
    // And so does the margin it REPORTS, which the planner is told to write
    // as minMargin. It came from the cells alone, and was held to nothing.
    const reported = fitment(design([{ id: 'roundel', treatment: 'fill', panel: 'L', at: c.at, color: 'ink',
      constraints: { minMargin: c.marginMm } }]), profile, null, { model: half });
    assert.deepEqual(margin(reported), [], `a spot's reported ${c.marginMm} mm holds as minMargin: ${JSON.stringify(c)}`);
  }
  assert.ok(found.map.every((row) => row.startsWith('.')), 'the hidden half is marked on the map');

  const none = findSpace({ profile, model: half, prepared: occupancyFor(half), role: 'body', panel: 'L',
    widthMm: 900, marginMm: 50, cellMm: 100 });
  assert.deepEqual(none.candidates, []);
  assert.match(none.note, /No spot on L fits 900 x 900 mm/);
});

test('find_space reports a clearance the fine grid holds, even where the coarse cells missed a fitting', async () => {
  // The coarse cells sample every 20 mm here, so a fitting narrower than
  // that can sit between samples and every cell still reads clean. The map
  // below says so outright, over a car with a 40 mm plate standing 5 mm off
  // the paint at 1.2 m across. The spots are 300 mm wide and nothing bounds
  // them but the panel's edges, so the cells alone gave them a clearance of
  // hundreds of millimetres, straight through the plate: returned as
  // marginMm, then written as minMargin, that failed. Held to the fine grid
  // instead, it fell back to the margin asked for, which was none, and a
  // spot with a good deal of room reported zero.
  const { findSpace, cleanGrid } = await import('../src/space.mjs');
  const model = withPlate(plane({ rows: 8, cols: 8 }), 0.005);
  model.meshes[1].world[0] = 40 / 1600;
  model.meshes[1].world[12] = 1.2;
  const prepared = occupancyFor(model);
  const swept = cleanGrid({ profile, model, prepared, role: 'body', panel: 'L', cellMm: 100 });
  const missed = { ...swept, clean: swept.clean.map((row) => row.map(() => true)) };

  const found = findSpace({ grid: missed, model, prepared, widthMm: 300, count: 5 });
  assert.ok(found.candidates.length > 0, JSON.stringify(found));
  for (const c of found.candidates) {
    assert.ok(c.marginMm > 0, `a spot with room beside it reports that room, not zero: ${JSON.stringify(c)}`);
    const reported = fitment(design([{ id: 'roundel', treatment: 'fill', panel: 'L', at: c.at, color: 'ink',
      constraints: { minMargin: c.marginMm } }]), profile, null, { model });
    assert.deepEqual(reported.findings.filter((f) => f.kind === 'margin'), [],
      `a spot's reported ${c.marginMm} mm holds as minMargin: ${JSON.stringify(c)}`);
  }
});

test('find_space can sweep sizes and say how big a shape of a given proportion can be', async () => {
  // An agent told "about 400 mm" put a 240 mm roundel on a door that held 400.
  // Asked for the limit, it gets the limit: the largest that fits, and the
  // next size up does not.
  const { findSpace, largestSpace, cleanGrid } = await import('../src/space.mjs');
  const half = withPlate(plane({ rows: 8, cols: 8 }), 0.005);
  half.meshes[1].world[0] = 0.5;                    // the plate hides the left 0.8 m of 1.6
  const prepared = occupancyFor(half);
  const grid = cleanGrid({ profile, model: half, prepared, role: 'body', panel: 'L', cellMm: 100 });

  const r = largestSpace({ grid, model: half, prepared, aspect: 1, marginMm: 50 });
  assert.ok(r.largest, JSON.stringify(r));
  // The clean half is 750 mm wide beside the plate's cell. find_space centres
  // a shape on whole 100 mm cells here, so a 50 mm margin can cost up to a cell
  // each side: 500 is the honest answer at this resolution, not a shortfall.
  assert.ok(r.largest.widthMm >= 450 && r.largest.widthMm <= 800, `about the clean half, less the margin: ${r.largest.widthMm}`);
  assert.equal(r.largest.heightMm, r.largest.widthMm, 'aspect 1 is square');
  assert.ok(r.largest.at[0] * 1600 >= 850 - 1, 'in the clean half');
  assert.ok(r.sizesTried <= 16);
  const over = findSpace({ grid, model: half, prepared, widthMm: r.largest.widthMm + 100, marginMm: 50, count: 1 });
  assert.deepEqual(over.candidates, [], 'and 100 mm more does not fit');

  // The clean half is narrow and tall, so the proportion decides what grows:
  // a tall shape gets the height a square cannot use.
  const tall = largestSpace({ grid, model: half, prepared, aspect: 2, marginMm: 50 });
  assert.ok(tall.largest.heightMm > r.largest.heightMm, `a taller shape can be taller: ${JSON.stringify(tall.largest)}`);
  const again = findSpace({ grid, model: half, prepared, widthMm: r.largest.widthMm, heightMm: r.largest.heightMm,
    marginMm: 50, count: 1 }).candidates[0];
  assert.deepEqual(again?.at, r.largest.at, 'the spot it reports is the one measured for the size it reports');
  assert.throws(() => largestSpace({ grid, model: half, prepared, aspect: 0 }), /aspect above zero/);
});

test('the sweep keeps looking past three spots that fail the fine check', async () => {
  // Two fittings 30 mm wide stand proud of a 1600 x 400 mm panel, between the
  // coarse samples, so every cell reads clean. Any 390 mm square that starts
  // left of 565 mm crosses one; the spots the sweep tries first all do, and
  // one further along does not. Given three fine checks a size, the sweep
  // judged 350 mm not to fit and reported 300 on a panel that holds 390.
  const { findSpace, largestSpace, cleanGrid } = await import('../src/space.mjs');
  const sheet = plane({ rows: 8, cols: 8 });
  sheet.meshes[0].world[5] = 0.25;                  // 1.6 m long, 0.4 m tall
  const bar = (x) => {
    const m = { ...sheet.meshes[0], materialId: 1, world: [...sheet.meshes[0].world] };
    m.world[0] = 0.03 / 1.6; m.world[12] = x; m.world[14] = 0.005;
    return m;
  };
  const model = { ...sheet, materials: [...sheet.materials, { slots: { txDiffuse: 'plate.dds' } }],
    meshes: [sheet.meshes[0], bar(0.335), bar(0.535)] };
  const long = { ...profile, panels: { body: { L: { ...profile.panels.body.L, metresPerUv: [4, 1] } } } };
  const prepared = occupancyFor(model);
  const grid = cleanGrid({ profile: long, model, prepared, role: 'body', panel: 'L', cellMm: 100, across: 2 });
  assert.ok(grid.clean.every((row) => row.every(Boolean)), 'the coarse sweep does not see the fittings');

  const r = largestSpace({ grid, model, prepared, aspect: 1 });
  assert.ok(r.largest?.widthMm >= 380, `the panel holds a 390 mm square: ${JSON.stringify(r)}`);
  assert.ok(r.largest.at[0] * 1600 >= 565 - 1, `beyond the fittings: ${JSON.stringify(r.largest)}`);
  // Other callers keep their budget: five spots, three tries each.
  assert.deepEqual(findSpace({ grid, model, prepared, widthMm: 390, count: 1 }).candidates, [],
    'find_space asked for one spot still stops after three');
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

  // And a fitting the car itself hides covers nothing. The NSX hides sixteen
  // door number plates the renderer never draws; counted, they failed a team
  // name a person had placed by hand and could see was clear.
  const hides = { ...profile, hiddenByCar: { meshes: { DOOR_HANDLE: { by: 'name', pattern: 'DOOR_HANDLE' } } } };
  const hidden = fitment(name([0.1, 0.5, 0.6, 0.05]), hides, null, { model: strip });
  assert.deepEqual(hidden.findings.filter((f) => f.kind === 'unseen'), [], 'a hidden mesh is not in front of anything');
});

test('a groupWith with space around the id is refused, not stored as a name nothing answers to', async () => {
  const { opSetConstraint } = await import('../src/ui/ops.js');
  assert.throws(() => opSetConstraint(design([{ id: 'team' }, { id: 'number' }]), { id: 'team', key: 'groupWith', value: 'number ' }),
    /"groupWith" names another region's id, exactly/);
});

test('a number in a roundel is judged by where its letters are, not by its box', () => {
  // A person laid out a door by hand: a 405 mm roundel, the number's box 309 x
  // 291 mm inside it. The box's corners reach past the disc; the "85" does not.
  // Tested against the box, that was a high finding on both doors of a layout
  // anyone could see was right.
  const roundel = { id: 'roundel', treatment: 'ring', panel: 'L', at: [0.3, 0.3, 0.4, 0.4], color: 'ink',
    radius: 0.25, width: 0.5 };
  const through = (at, extra = {}) => fitment(design([roundel,
    { id: 'number', treatment: 'text', panel: 'L', at, text: '{number}', ...extra }]),
  profile).findings.filter((f) => f.kind === 'overlap');
  // A disc of radius 0.2 of the panel about (0.5, 0.5); this box's corners are
  // 0.26 from the centre, and its single "7" about 0.15.
  assert.deepEqual(through([0.31, 0.32, 0.38, 0.36]), [], 'letters inside the disc are a roundel doing its job');
  // "auto" is the turn the panel needs, none here: that hand-made door said
  // rotate "auto", and was still measured by its box.
  assert.deepEqual(through([0.31, 0.32, 0.38, 0.36], { rotate: 'auto' }), [], 'rotate auto on an upright panel is upright');
  const edge = through([0.55, 0.4, 0.3, 0.2]);
  assert.equal(edge.length, 1, 'letters across the disc\'s edge are still found');
  assert.equal(edge[0].severity, 'high');
  assert.match(edge[0].why, /circle runs through/);
});

test('a disc dipping into the top of a name is found, however little their boxes share', () => {
  // A name band under a roundel shares an eighth of its box with the disc's
  // at most, and pairs sharing under a quarter were passed over before the
  // circle was ever measured, so letters with the disc's rim through them
  // passed every round.
  const disc = { id: 'roundel', treatment: 'ring', panel: 'L', at: [0.3, 0.1, 0.4, 0.4], color: 'ink',
    radius: 0.25, width: 0.5 };
  const team = (y) => ({ id: 'team', treatment: 'text', panel: 'L', at: [0.1, y, 0.8, 0.12], text: 'DOLL', scale: 1 });
  const found = (y) => fitment(design([disc, team(y)]), profile).findings.filter((f) => f.kind === 'overlap');
  const under = found(0.48);
  assert.equal(under.length, 1, 'the disc reaches 0.5 and the letters start above it');
  assert.equal(under[0].severity, 'high');
  assert.match(under[0].why, /circle runs through/);
  assert.deepEqual(found(0.52), [], 'the same name clear of the disc');
});

test('lettering too close in colour to what is under it is measured, not left to the critic', () => {
  // Round one of three runs in a row failed on the team name for this alone:
  // white on Gulf blue, then thin orange on Gulf blue, each found a whole round
  // later by looking at a picture. The design knows both colours.
  const gulf = { blue: '#7BB3D9', orange: '#F26522', white: '#FFFFFF', navy: '#0E2233', pale: '#BFE3F5' };
  const low = (regions) => fitment({ ...design(regions), palette: gulf }, profile)
    .findings.filter((f) => f.kind === 'low-contrast');
  const base = { id: 'base', treatment: 'fill', color: 'blue' };
  const name = (color) => ({ id: 'team', treatment: 'text', panel: 'L', at: [0.2, 0.6, 0.6, 0.1], text: '{team}', color });

  const white = low([base, name('white')]);
  assert.equal(white.length, 1, 'white on Gulf blue');
  assert.equal(white[0].severity, 'high');
  assert.match(white[0].why, /white on blue \(base\): a contrast of 2\.\d:1/);
  assert.equal(low([base, name('orange')]).length, 1, 'orange on Gulf blue');
  assert.deepEqual(low([base, name('navy')]), [], 'navy on the blue reads');
  assert.deepEqual(low([base, { id: 'band', treatment: 'fill', panel: 'L', at: [0.15, 0.55, 0.7, 0.2], color: 'orange' },
    name('white')]), [], 'white on an orange band behind it reads');
  // A fill that names no colour wears the core treatment's own pink.
  const onDefault = low([{ id: 'plain', treatment: 'fill' }, name('white')]);
  assert.equal(onDefault.length, 1, 'white on the pink a fill wears by default');
  assert.match(onDefault[0].why, /white on pink/);

  // Inside a solid disc, the disc is what is under the number.
  const disc = { id: 'roundel', treatment: 'ring', panel: 'L', at: [0.3, 0.3, 0.4, 0.4], color: 'white', radius: 0.25, width: 0.5 };
  const number = (color) => ({ id: 'number', treatment: 'text', panel: 'L', at: [0.4, 0.42, 0.2, 0.16], text: '{number}', color });
  assert.deepEqual(low([base, disc, number('navy')]), [], 'navy in a white disc');
  assert.equal(low([base, disc, number('pale')]).length, 1, 'pale blue in a white disc');
});
test('a number on a panel laid a quarter turn is judged by its letters too', () => {
  // The Abarth's doors measure 90 and 270. `inkBox` gave up on a quarter turn
  // and answered with the whole box, so a number in a roundel there got the
  // high overlap the letters-not-box rule was written to remove, and the
  // in-view count took the box's empty corners for the number.
  const roundel = { id: 'roundel', treatment: 'ring', panel: 'L', at: [0.3, 0.3, 0.4, 0.4], color: 'ink',
    radius: 0.25, width: 0.5 };
  const number = (at) => ({ id: 'number', treatment: 'text', panel: 'L', at, text: '{number}', rotate: 'auto' });
  const at = [0.31, 0.32, 0.38, 0.36];
  const box = [0.4 * at[0], 0.4 * at[1], 0.4 * (at[0] + at[2]), 0.4 * (at[1] + at[3])];
  for (const textRotation of [90, 270]) {
    const turned = structuredClone(profile);
    turned.panels.body.L.textRotation = textRotation;
    const overlaps = (d) => fitment(d, turned).findings.filter((f) => f.kind === 'overlap');
    assert.deepEqual(overlaps(design([roundel, number(at)])), [], `letters inside the disc, turned ${textRotation}`);

    const [x0, y0, x1, y1] = wholePieces(design([roundel, number(at)]), turned).find((p) => p.id === 'number').box;
    assert.ok(x1 - x0 < 0.7 * (box[2] - box[0]) && y1 - y0 < 0.7 * (box[3] - box[1]),
      `the letters, not the box, turned ${textRotation}: ${[x0, y0, x1, y1]} in ${box}`);
    assert.ok(x0 >= box[0] && x1 <= box[2] && y0 >= box[1] && y1 <= box[3], 'and inside it');

    const edge = overlaps(design([roundel, number([0.55, 0.4, 0.3, 0.2])]));
    assert.equal(edge.length, 1, `letters across the disc's edge are still found, turned ${textRotation}`);
    assert.equal(edge[0].severity, 'high');
  }
});

test('a size that could not be measured is named, not passed', () => {
  // `unreadable` and `too-small` returned early without a word on a panel with
  // no metresPerUv, and stayed in `checked`; `too-small` did the same for a
  // name that spans panels or is set at an angle. Each read as a pass.
  const team = { id: 'team', treatment: 'text', panel: 'L', at: [0.1, 0.1, 0.8, 0.2], text: '{team}' };
  const unscaled = structuredClone(profile);
  delete unscaled.panels.body.L.metresPerUv;

  const r = fitment(design([team]), unscaled);
  assert.ok(r.notChecked.some((s) => /^unreadable for .*team: its panel L has no measured scale/.test(s)), r.notChecked.join('\n'));
  assert.ok(r.notChecked.some((s) => /^too-small for .*team: its panel L has no measured scale/.test(s)), r.notChecked.join('\n'));
  const asked = fitment(design([{ ...team, constraints: { minMm: 40 } }]), unscaled).findings
    .filter((f) => f.kind === 'unreadable');
  assert.equal(asked[0]?.severity, 'high', 'a declared floor that cannot be measured is high, as a margin is');
  assert.match(asked[0].why, /asks for at least 40 mm, and its panel L has no measured scale/);

  const tilted = fitment(design([{ ...team, rotate: 30 }]), profile).findings.filter((f) => f.kind === 'too-small');
  assert.equal(tilted.length, 1, 'a name at an angle is said to be unmeasured');
  assert.equal(tilted[0].severity, 'low');
  assert.equal(tilted[0].measured, false);
  assert.match(tilted[0].why, /could not be measured, because it is turned to 30/);

  assert.deepEqual(fitment(design([team]), profile).notChecked.filter((s) => /unreadable|too-small/.test(s)), [],
    'and a panel with a scale leaves nothing unmeasured');
});

test('a size the profile cannot measure is marked as the profile\'s, and text with no panel as the design\'s', () => {
  // RSS4's helmet, suit, gloves, crew and belts have no metresPerUv, so a
  // driver name on the helmet was two notChecked entries, and the loop fails a
  // round on any of them: no draft could pass, whatever the planner did. The
  // entries stay, and say they are the profile's, so a gate can tell them from
  // a check the draft itself prevented.
  const driver = { id: 'driver', treatment: 'text', panel: 'L', at: [0.1, 0.1, 0.8, 0.2], text: '{team}' };
  const unscaled = structuredClone(profile);
  delete unscaled.panels.body.L.metresPerUv;

  const r = fitment(design([driver]), unscaled);
  const skipped = r.notChecked.filter((s) => /^(unreadable|too-small) /.test(s));
  assert.equal(skipped.length, 2, r.notChecked.join('\n'));
  assert.deepEqual(r.unsupported.map((u) => u.notChecked).sort(), skipped.sort(), 'each is marked as the profile\'s');
  assert.deepEqual(r.unsupported.map((u) => u.check).sort(), ['too-small', 'unreadable']);
  for (const u of r.unsupported) {
    assert.deepEqual(u.ids, ['driver']);
    assert.match(u.why, /its panel L has no measured scale/);
  }

  // A floor the design declared is still the design's promise, and still high.
  const asked = fitment(design([{ ...driver, constraints: { minMm: 40 } }]), unscaled);
  assert.equal(asked.findings.find((f) => f.kind === 'unreadable')?.severity, 'high');
  assert.ok(!asked.unsupported.some((u) => u.check === 'unreadable'), 'and is not excused as the profile\'s');

  // Text placed on no panel has no size because of where the design put it,
  // as a span or an angle does: said as low and unmeasured, not left out.
  const loose = fitment(design([{ id: 'driver', treatment: 'text', at: [0.1, 0.1, 0.3, 0.1], text: '{team}' }]), profile);
  assert.deepEqual(loose.notChecked.filter((s) => /^(unreadable|too-small) /.test(s)), [], loose.notChecked.join('\n'));
  assert.deepEqual(loose.unsupported, []);
  const said = loose.findings.filter((f) => f.kind === 'unreadable' || f.kind === 'too-small');
  assert.deepEqual(said.map((f) => [f.kind, f.severity, f.measured]).sort(),
    [['too-small', 'low', false], ['unreadable', 'low', false]], JSON.stringify(said));
  for (const f of said) assert.match(f.why, /names no panel/);

  assert.deepEqual(fitment(design([driver]), profile).unsupported, [], 'and a panel with a scale leaves nothing to excuse');
});

test('contrast is measured whatever the palette calls a colour, and on the background the renderer paints', () => {
  // Only `#rrggbb` was read, so `#fff` or `steelblue` switched the check off
  // without a word; and a surface with no background was skipped, while the
  // renderer paints black there.
  const low = (palette, regions) => fitment({ ...design(regions), palette }, profile)
    .findings.filter((f) => f.kind === 'low-contrast');
  const name = (color) => ({ id: 'team', treatment: 'text', panel: 'L', at: [0.2, 0.6, 0.6, 0.1], text: '{team}', color });
  const base = { id: 'base', treatment: 'fill', color: 'blue' };

  const navy = low({ navy: '#0E2233' }, [name('navy')]);
  assert.equal(navy.length, 1, 'navy on the black the renderer paints');
  assert.match(navy[0].why, /navy on black/);
  assert.equal(low({ blue: '#7BB3D9', white: '#fff' }, [base, name('white')]).length, 1, '#fff on Gulf blue');
  assert.equal(low({ blue: 'lightsteelblue' }, [base, name('white')]).length, 1, 'white on a colour named in CSS');
  assert.deepEqual(low({ blue: '#7BB3D9', navy: 'navy' }, [base, name('navy')]), [], 'and a pair that reads still passes');
});

