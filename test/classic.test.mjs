// ---------------------------------------------------------------------------
// What the classic pack and `gradient` draw, measured on the pixels where the
// question is a picture's: which way a shape points, what color a fade ends
// in. Which options each one reads is packs.test.mjs's business, and what a
// livery can smuggle through them is injection.test.mjs's.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

import '../src/index.mjs';
import { resolveTreatments } from '../src/registry.mjs';
import { renderTexture } from '../src/render.mjs';
import { mulberry32 } from '../src/engine/rng.mjs';

const SIZE = 128;
const profile = (anisotropy = 1) => ({
  id: 'c',
  textures: { body: { file: 'b.dds', width: SIZE, height: SIZE } },
  panels: { body: { L: { rect: [0, 0, 1, 1], anisotropy } } },
});

function draw(region, { anisotropy = 1, background = '#fff' } = {}) {
  const regionNotes = [];
  const out = renderTexture({
    profile: profile(anisotropy), role: 'body', regions: [{ panel: 'L', ...region }], background,
    treatments: resolveTreatments(['core', 'classic']), palette: {}, rng: mulberry32(1),
    font: 'DejaVu Sans', tokens: {}, regionNotes,
  });
  return { svg: out.base, notes: regionNotes };
}

/** The rendered sheet as RGB rows, for reading single pixels. */
async function pixels(svg) {
  const { data } = await sharp(Buffer.from(svg)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return (x, y) => [...data.subarray((y * SIZE + x) * 3, (y * SIZE + x) * 3 + 3)];
}

const near = (got, want, tol = 24) => got.every((v, i) => Math.abs(v - want[i]) <= tol);

test('a gradient runs from one color to the other, and a fade runs to what is under it', async () => {
  const across = await pixels(draw({ treatment: 'gradient', from: '#ff0000', to: '#0000ff' }).svg);
  assert.ok(near(across(2, 64), [255, 0, 0]), `left edge ${across(2, 64)}`);
  assert.ok(near(across(125, 64), [0, 0, 255]), `right edge ${across(125, 64)}`);

  const down = await pixels(draw({ treatment: 'gradient', from: '#ff0000', to: '#0000ff', angle: 90 }).svg);
  assert.ok(near(down(64, 2), [255, 0, 0]) && near(down(64, 125), [0, 0, 255]), 'ninety degrees runs top to bottom');

  const fade = await pixels(draw({ treatment: 'gradient', from: '#ff0000', fade: true }).svg);
  assert.ok(near(fade(125, 64), [255, 255, 255]), `faded to the white under it: ${fade(125, 64)}`);
});

test('pointed the other way, chevrons and the hockey stick are their own mirror image', async () => {
  for (const [treatment, one, other] of [
    ['chevrons', { point: 'right' }, { point: 'left' }],
    ['hockeyStick', { rise: 'end' }, { rise: 'start' }],
  ]) {
    const a = await pixels(draw({ treatment, color: '#000000', ...one }).svg);
    const b = await pixels(draw({ treatment, color: '#000000', ...other }).svg);
    let differs = false;
    for (let y = 4; y < SIZE; y += 8) {
      for (let x = 4; x < SIZE; x += 8) {
        assert.ok(near(a(x, y), b(SIZE - 1 - x, y), 60), `${treatment} at ${x},${y}`);
        if (!near(a(x, y), b(x, y), 60)) differs = true;
      }
    }
    assert.ok(differs, `${treatment} is not symmetric, so the mirror means something`);
  }
});

test('checker squares are square on the car, not in the texture', () => {
  // A panel twice as wide on the car as in the sheet: a square of texture
  // lands 2:1, so the squares are drawn half as wide as they are tall.
  const { svg } = draw({ treatment: 'checkers', color: '#000000', rows: 2 }, { anisotropy: 2 });
  const cells = [...svg.matchAll(/<rect x="[\d.]+" y="[\d.]+" width="([\d.]+)" height="([\d.]+)" fill="#000000"/g)]
    .map((m) => [Number(m[1]), Number(m[2])]);
  assert.equal(cells.length, 4, "two rows of four, alternating");
  for (const [w, h] of cells) assert.deepEqual([w, h], [32, 64]);
});

test('a sponsor row draws a block per name, and says when it has none', () => {
  const { svg } = draw({ treatment: 'sponsorRow', text: 'ACME | NORTHWIND | KESTREL', background: '#000000' });
  assert.deepEqual([...svg.matchAll(/<text[^>]*>([^<]*)</g)].map((m) => m[1]), ['ACME', 'NORTHWIND', 'KESTREL']);
  assert.equal([...svg.matchAll(/fill="#000000"/g)].length, 3, 'a block behind each');

  const empty = draw({ treatment: 'sponsorRow', text: ' | ' });
  assert.match(empty.notes.map((n) => n.text).join(' '), /no names in its text/);
});
