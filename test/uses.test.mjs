// ---------------------------------------------------------------------------
// Who refers to what, inside a design.
//
// Both of the failures this file exists to make visible are silent, and both are
// demonstrated here against the real renderer rather than asserted — because
// "renaming this palette entry breaks three regions" is only worth saying if
// breaking them actually looks like nothing.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import '../src/index.mjs';
import { resolveTreatments } from '../src/registry.mjs';
import { renderTexture } from '../src/render.mjs';
import { mulberry32 } from '../src/engine/rng.mjs';
import { eachRegion, paletteUses, tokenUses, danglingNames, interpolates, isAColour } from '../src/ui/uses.js';

const core = () => resolveTreatments(['core']);

const design = () => ({
  name: 'L',
  palette: { ink: '#101014', accent: '#00F0FF' },
  identity: { driver: 'A. Driver' },
  surfaces: {
    body: {
      background: 'ink',
      regions: [
        { id: 'badge', treatment: 'fill', color: 'accent' },
        { treatment: 'stripe', color: '#123456' },
        { id: 'name', treatment: 'text', text: '{driver} #{number}', color: 'accent' },
      ],
    },
  },
});

test('a name that stops resolving fails silently, which is why it is counted', () => {
  // The two behaviours the whole file is built around, shown rather than
  // claimed. Neither produces an error anywhere.
  const profile = { id: 'c', textures: { body: { file: 'b.dds', width: 64, height: 64 } },
    panels: { body: { L: { rect: [0, 0, 1, 1] } } } };
  const draw = (regions, palette, tokens) => renderTexture({
    profile, role: 'body', regions, treatments: core(),
    palette, rng: mulberry32(1), font: 'sans', tokens }).base;

  // A colour the palette lacks is handed straight to the renderer.
  assert.match(draw([{ id: 'r', panel: 'L', treatment: 'fill', color: 'ghost' }], { ink: '#000' }, {}),
    /fill="ghost"/);

  // A token with no value leaves a hole in the text and nothing else.
  assert.match(draw([{ id: 'r', panel: 'L', treatment: 'text', text: '{driver} #{number}' }],
    { white: '#fff' }, { driver: 'A. Driver' }), />A\. Driver #<\/text>/);
});

test('every region is reachable by the key a fit would use', () => {
  const rows = eachRegion(design());
  assert.deepEqual(rows.map((r) => r.key), ['badge', 'surfaces.body#1', 'name']);
  assert.deepEqual(rows.map((r) => r.surface), ['surfaces.body', 'surfaces.body', 'surfaces.body']);
  assert.deepEqual(eachRegion(undefined), [], 'nothing is not an error');
});

test('a palette entry knows who is relying on it, including a background', () => {
  const uses = paletteUses(design(), core());
  assert.deepEqual(uses.get('accent'), ['badge', 'name']);
  // A background names a palette colour exactly as a region's `color` does, and
  // is the largest possible version of this mistake.
  assert.deepEqual(uses.get('ink'), ['surfaces.body background']);
  assert.deepEqual(uses.get('#123456'), ['surfaces.body#1'], 'literals are counted too, and shown as themselves');
});

test('colour fields come from the treatment description, not from a guess', () => {
  // `glitch` takes `colors`, plural, and no `color` at all. A hardcoded field
  // name would miss it; the description says so.
  const d = {
    palette: { violet: '#80f' },
    surfaces: { body: { regions: [{ id: 'g', treatment: 'glitch', colors: ['violet', 'accent'] }] } },
  };
  const uses = paletteUses(d, resolveTreatments(['core', 'synthwave']));
  assert.deepEqual(uses.get('violet'), ['g']);
  assert.deepEqual(uses.get('accent'), ['g']);

  // With no description at all, the conventional names are still found.
  assert.deepEqual(paletteUses(d, new Map()).get('violet'), ['g']);
});

test('only text is scanned for tokens, because only text is interpolated', () => {
  const uses = tokenUses(design());
  assert.deepEqual([...uses.keys()], ['driver', 'number']);
  assert.deepEqual(uses.get('driver'), ['name']);

  // A brace in any other option is a literal, and reporting it would be a lie.
  const d = { surfaces: { body: { regions: [{ id: 'r', treatment: 'fill', color: '{driver}' }] } } };
  assert.deepEqual([...tokenUses(d).keys()], []);
});

test('a use is counted once per thing that depends on it, not once per mention', () => {
  // `glitch` takes an array, and nothing stops the same palette entry appearing
  // in it twice — a two-tone glitch that happens to want one colour on both
  // sides is an ordinary thing to write. Counting the mentions would tell
  // somebody about to rename `violet` that three things depend on it.
  const d = {
    palette: { violet: '#80f' },
    surfaces: { body: { regions: [{ id: 'g', treatment: 'glitch', colors: ['violet', 'violet'] }] } },
  };
  assert.deepEqual(paletteUses(d, resolveTreatments(['core', 'synthwave'])).get('violet'), ['g']);

  // Two regions naming it are still two, which is the count that matters.
  d.surfaces.body.regions.push({ id: 'h', treatment: 'glitch', colors: ['violet'] });
  assert.deepEqual(paletteUses(d, resolveTreatments(['core', 'synthwave'])).get('violet'), ['g', 'h']);

  // And a name mentioned twice in one line of text is one region, the same way.
  const t = { surfaces: { body: { regions: [{ id: 'r', treatment: 'text', text: '{d} / {d}' }] } } };
  assert.deepEqual(tokenUses(t).get('d'), ['r']);
});

test('a token the renderer could never substitute is not a token', async () => {
  // The rule `interpolates` states lives in `src/render.mjs`, and `uses.js`
  // cannot import it — the browser loads that file directly, with no bundler. So
  // rather than trust a second copy of `\w`, take the renderer's own pattern out
  // of its source and check the two classify the same names the same way. If
  // somebody widens the renderer to accept `{driver-name}`, this fails.
  const source = await readFile(new URL('../src/render.mjs', import.meta.url), 'utf8');
  const found = source.match(/^export const TOKEN = (\/.+\/g);$/m);
  assert.ok(found, 'render.mjs no longer declares TOKEN as a findable regex literal');
  const pattern = new RegExp(found[1].slice(1, -2), 'g');

  for (const name of ['driver', 'number', 'car_no', 'n7', '_x',
    'driver-name', 'driver name', 'car.no', 'né', '', 'a+b']) {
    const substituted = `{${name}}`.replace(pattern, () => 'VALUE') === 'VALUE';
    assert.equal(interpolates(name), substituted,
      `${JSON.stringify(name)}: the editor and the renderer disagree about this name`);
  }
});

test('a colour is told from a name by parsing it, not by its first character', () => {
  // The cases the old regex got right, and would have gone on getting right.
  for (const v of ['#00F0FF', '#fff', 'rgb(1, 2, 3)', 'rgba(1,2,3,.5)', 'hsl(200, 50%, 40%)']) {
    assert.equal(isAColour(v), true, v);
  }

  // The ones it got WRONG, and the reason this dependency earns its 8 KB. Both
  // render perfectly well, and both were reported to the user as unresolved
  // names, because they do not begin with `#` or `rgb`.
  for (const v of ['red', 'rebeccapurple', 'darkslategrey']) {
    assert.equal(isAColour(v), true, `${v} is a colour and was being called a typo`);
  }

  // And the ones that matter most, which look exactly like those and are not:
  // a palette entry renamed out from under a region, and a misspelling.
  for (const v of ['ghost', 'gulf-blue', 'accent', 'rebecapurple', '', '   ']) {
    assert.equal(isAColour(v), false, `${JSON.stringify(v)} names nothing that can be painted`);
  }

  // SVG paint values rather than colours: colord rightly declines them, the
  // renderer accepts them, and this file has to agree with the renderer.
  for (const v of ['none', 'currentColor', 'inherit', 'var(--team)']) {
    assert.equal(isAColour(v), true, v);
  }
  assert.equal(isAColour(undefined), false, 'and nothing is not a colour');
});

test('names the design refers to and does not define are listed', () => {
  const d = design();
  const dangling = danglingNames(d, core());

  assert.deepEqual(dangling.tokens.map((t) => t.token), ['number'],
    'a token with no value renders as nothing at all');
  assert.deepEqual(dangling.tokens[0].by, ['name'], 'and says which region loses text');
  assert.deepEqual(dangling.colours, [], 'every colour here either resolves or is a literal');

  // A literal is nobody's business; a bare word is reported as what it is.
  d.surfaces.body.regions[0].color = 'gulf-blue';
  assert.deepEqual(danglingNames(d, core()).colours.map((c) => c.name), ['gulf-blue']);
  d.surfaces.body.regions[0].color = '#ff00ff';
  assert.deepEqual(danglingNames(d, core()).colours, []);

  // An empty identity value is as absent as a missing one: both interpolate to
  // nothing, and `country: ''` in the shipped designs is exactly that case.
  d.identity.number = '';
  assert.ok(danglingNames(d, core()).tokens.some((t) => t.token === 'number'));
  d.identity.number = '7';
  assert.deepEqual(danglingNames(d, core()).tokens, []);
});

test('the shipped designs refer to nothing they do not define', async () => {
  for (const name of ['neon-grid', 'neon-grid-any']) {
    const d = (await import(`../liveries/${name}.mjs`)).default;
    const dangling = danglingNames(d, resolveTreatments(d.packs ?? ['core']));
    assert.deepEqual(dangling.colours, [], `${name} colours`);
    assert.deepEqual(dangling.tokens, [], `${name} tokens`);
  }
});

// --- the emissive layer ------------------------------------------------------

test('the editor draws both layers, because some treatments only draw on one', async () => {
  // `traces` and `sparkles` return an empty base and draw entirely into the
  // emissive layer; `piping`, `ring`, `text` and `radialText` move there under
  // `glow: true`. The editor showed `base` alone, so all of that was painted
  // correctly by the build and invisible in every view of the tool for looking
  // at it — which is this project's oldest failure in a new costume.
  const { renderSurface } = await import('../src/ui/server.mjs');
  const { loadProfile } = await import('../src/profile.mjs');

  const emissiveOnly = new Set(['traces', 'sparkles']);
  const rect = { x: 10, y: 10, w: 200, h: 100, anisotropy: 1 };
  const treatments = resolveTreatments(['core', 'synthwave']);
  const ctx = (opts) => ({ palette: { cyan: '#0ff' }, color: (v) => v, rng: mulberry32(1),
    font: 'sans', opts, width: 1024, height: 1024, tokens: {} });

  // The premise, measured rather than assumed.
  for (const name of emissiveOnly) {
    const out = treatments.get(name).fn(rect, ctx({}));
    assert.equal(out.base, '', `${name} should draw nothing into the base`);
    assert.ok(out.emissive, `${name} should draw into the emissive layer`);
  }
  for (const name of ['piping', 'ring', 'text', 'radialText']) {
    const out = treatments.get(name).fn(rect, ctx({ text: 'HI', glow: true }));
    assert.equal(out.base, '', `${name} with glow should move entirely to emissive`);
    // Both halves, or the assertion above is satisfied by a treatment that has
    // stopped drawing anything at all — which is the very thing being guarded
    // against, arriving as a passing test.
    assert.ok(out.emissive, `${name} with glow should draw into the emissive layer`);
  }

  // So a design using them is a design the base alone cannot show. `traces` is
  // the round-capped stroke below, and nothing else in this livery draws one.
  const profile = await loadProfile(new URL('../cars/abarth500.json', import.meta.url));
  const livery = (await import('../liveries/neon-grid-any.mjs')).default;
  const role = Object.keys(profile.textures).find((r) => profile.panels[r]?.left_mid);
  // Named rather than assumed. Without this the fixture drifting would surface
  // as a throw from deep inside renderSurface about something else entirely.
  assert.ok(role, 'no texture in the abarth500 profile has a left_mid panel any more');
  const out = renderSurface({ livery, profile, fit: null, role });

  assert.match(out.svg, /stroke-linecap="round"/, 'what the editor draws has the traces in it');
  assert.match(out.svg, /lk-glow/, 'and glows them, as the build does');
  assert.equal((out.svg.match(/<svg/g) ?? []).length, 1, 'still one document');

  // Referred to three times and written once. The emissive layer of a glowing
  // design is most of the document, this goes back on every frame of a drag, and
  // three copies of it would also mean three copies of any `id` a treatment
  // emits — where every `url(#...)` silently resolves to the first.
  assert.equal((out.svg.match(/id="lk-emissive"/g) ?? []).length, 1);
  assert.equal((out.svg.match(/href="#lk-emissive"/g) ?? []).length, 3);

  // ONE document, and not the pieces beside it. This response goes back on every
  // frame of a drag, and each layer is about the size of the finished thing, so
  // sending them along for a reader that does not exist is three times the
  // payload for nothing. Asserted rather than left to good intentions, because
  // adding a field is the easiest way in the world to make a drag stutter.
  assert.deepEqual(Object.keys(out).sort(), ['notes', 'placed', 'svg']);
});

test('the preview glow follows the design and the texture size', async () => {
  const { previewSvg } = await import('../src/render.mjs');
  const layers = (hasEmissive, width) => ({
    base: `<svg width="${width}" height="${width}"><rect/></svg>`,
    emissive: '<svg><circle/></svg>',
    hasEmissive, width, height: width,
  });

  // Nothing emissive, nothing added: the base is returned untouched, so a design
  // without glow renders exactly what it did before.
  assert.equal(previewSvg(layers(false, 2048)), layers(false, 2048).base);

  // The build scales the blur with the texture, so that a 4K render glows the
  // same amount relative to the car rather than the same number of pixels.
  assert.match(previewSvg(layers(true, 2048), { glowSigma: 14 }), /stdDeviation="14"/);
  assert.match(previewSvg(layers(true, 4096), { glowSigma: 14 }), /stdDeviation="28"/);
  assert.match(previewSvg(layers(true, 2048), { glowSigma: 4 }), /stdDeviation="4"/);

  // Two screened passes then a crisp one, matching composeLayers — and the layer
  // itself written ONCE and referred to three times. Copying it out would mean
  // three times the markup on every frame of a drag, and three copies of any
  // `id` a treatment emits, where each `url(#...)` resolves to the first: the
  // crisp pass would silently take the blurred pass's paint.
  const svg = previewSvg(layers(true, 2048));
  assert.equal((svg.match(/<circle\/>/g) ?? []).length, 1, 'the layer is written once');
  assert.equal((svg.match(/href="#lk-emissive"/g) ?? []).length, 3, 'and drawn three times');
  assert.equal((svg.match(/mix-blend-mode:screen/g) ?? []).length, 2);
  assert.ok(svg.indexOf('id="lk-emissive"') < svg.indexOf('href="#lk-emissive"'),
    'defined before it is used');
});
