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

import '../src/index.mjs';
import { resolveTreatments } from '../src/registry.mjs';
import { renderTexture } from '../src/render.mjs';
import { mulberry32 } from '../src/engine/rng.mjs';
import { eachRegion, paletteUses, tokenUses, danglingNames } from '../src/ui/uses.js';

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
