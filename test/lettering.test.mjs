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
