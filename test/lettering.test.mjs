// The renderer tells decoration where the words are.
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('sparkles keep off lettering on the same sheet without being told', async () => {
  // The emissive layer composites above the base, so a sparkle that lands on
  // the driver's name is drawn over it. `avoid` exists for exactly this and
  // has to be written by hand, in texture fractions, for every name on every
  // car — and the NSX fit put one on "Misha" the first time nobody did. A
  // text region is a rectangle the renderer already knows; sparkles can be
  // told without anybody typing it.
  await import('../src/index.mjs');
  const { resolveTreatments } = await import('../src/registry.mjs');
  const { renderTexture } = await import('../src/render.mjs');
  const { mulberry32 } = await import('../src/engine/rng.mjs');

  const profile = { id: 't', textures: { body: { file: 'b.dds', width: 1000, height: 1000 } },
    panels: { body: { L: { rect: [0, 0, 1, 1] } } } };
  const render = (regions, seed) => renderTexture({
    profile, role: 'body', regions, treatments: resolveTreatments(['core', 'synthwave']),
    palette: {}, rng: mulberry32(seed), font: 'sans-serif', tokens: {},
  });
  // Sparkle centres, from the path each one starts at the top of.
  const centres = (svg) => [...svg.matchAll(/<path d="M([\d.]+) ([\d.]+)Q/g)].map(([, x, y]) => [+x, +y]);
  const name = { x: 100, y: 400, w: 800, h: 200 };
  const inside = ([x, y]) => x > name.x && x < name.x + name.w && y > name.y && y < name.y + name.h;

  // Many seeds, so this is a property of the placement and not luck with one.
  let landedAlone = 0, landedWithText = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const alone = render([{ treatment: 'sparkles', panel: 'L', n: 40, minR: 4, maxR: 8 }], seed);
    landedAlone += centres(alone.emissive).filter(inside).length;
    const withText = render([
      { treatment: 'text', panel: 'L', at: [0.1, 0.4, 0.8, 0.2], text: 'MISHA', color: '#fff' },
      { treatment: 'sparkles', panel: 'L', n: 40, minR: 4, maxR: 8 },
    ], seed);
    landedWithText += centres(withText.emissive).filter(inside).length;
  }
  assert.ok(landedAlone > 50, `the band is a fifth of the sheet; unguarded sparkles land there (${landedAlone})`);
  assert.equal(landedWithText, 0, 'and none do once a text region occupies it');
});

test('a region is not told to avoid itself', async () => {
  // `keepClear` is a design saying "nothing may be painted across this", and
  // it is honoured for any treatment — so a decorative region can declare it
  // too. Handed the whole list, that region was given its OWN rectangle to
  // avoid: rejection sampling then had nowhere to put a sparkle, and the
  // region rendered empty. Artwork silently absent is the failure this
  // project exists to refuse, and it arrived through the feature that exists
  // to protect artwork.
  await import('../src/index.mjs');
  const { resolveTreatments } = await import('../src/registry.mjs');
  const { renderTexture } = await import('../src/render.mjs');
  const { mulberry32 } = await import('../src/engine/rng.mjs');

  const profile = { id: 't', textures: { body: { file: 'b.dds', width: 1000, height: 1000 } },
    panels: { body: { L: { rect: [0, 0, 1, 1] } } } };
  const render = (regions) => renderTexture({
    profile, role: 'body', regions, treatments: resolveTreatments(['core', 'synthwave']),
    palette: {}, rng: mulberry32(7), font: 'sans-serif', tokens: {},
  });
  const centres = (svg) => [...svg.matchAll(/<path d="M([\d.]+) ([\d.]+)Q/g)].map(([, x, y]) => [+x, +y]);

  const sparkles = { treatment: 'sparkles', panel: 'L', n: 40, minR: 4, maxR: 8 };
  const alone = centres(render([sparkles]).emissive).length;
  assert.ok(alone > 0, 'sparkles without constraints land somewhere');
  assert.equal(centres(render([{ ...sparkles, constraints: { keepClear: true } }]).emissive).length,
    alone, 'and a region asking to be kept clear still draws itself');

  // Another region's keepClear is still binding, and only when it says so
  // with a boolean: `keepClear: 'yes'` is a design that failed to say what it
  // meant, and changing what gets drawn on the strength of a typo is how a
  // livery quietly renders differently than it reads.
  const band = { treatment: 'fill', panel: 'L', at: [0, 0.4, 1, 0.2], color: '#fff' };
  const inBand = ([, y]) => y > 400 && y < 600;
  const on = (regions) => centres(render(regions).emissive).filter(inBand).length;
  assert.ok(on([sparkles]) > 0, 'a fifth of the sheet catches sparkles when nothing guards it');
  assert.equal(on([{ ...band, constraints: { keepClear: true } }, sparkles]), 0,
    'a guarded band is left alone');
  assert.equal(on([{ ...band, constraints: { keepClear: 'yes' } }, sparkles]), on([sparkles]),
    'and a value that is not a boolean guards nothing');
});
