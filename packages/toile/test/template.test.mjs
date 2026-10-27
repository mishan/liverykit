// Islands from a livery template, for a game that publishes templates and not
// its models.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

import { readTemplate, sheetIslands } from '../src/template.mjs';
import { inPoly } from '../src/engine/poly.mjs';
import { SHEET, ISLANDS, wireframe, silhouette, psd } from './fixtures/template.mjs';

const { width: W, height: H } = SHEET;
const frac = ([x, y, w, h]) => [x / W, y / H, w / W, h / H];

/** Island rects by what they are, matched to the fixture's own. */
function named(islands) {
  return Object.fromEntries(Object.entries(ISLANDS).map(([name, { rect }]) => {
    const [cx, cy] = [(rect[0] + rect[2] / 2) / W, (rect[1] + rect[3] / 2) / H];
    return [name, islands.find(({ rect: [x, y, w, h] }) => cx > x && cx < x + w && cy > y && cy < y + h)];
  }));
}

for (const [what, drawn] of [['drawn as a mesh, every cell edge', wireframe()], ['drawn as a silhouette', silhouette()]]) {
  test(`a template's islands are found exactly, ${what}`, () => {
    const { islands, notes } = sheetIslands(drawn, W, H);
    assert.equal(islands.length, 4);
    const found = named(islands);
    for (const [name, { rect, notch }] of Object.entries(ISLANDS)) {
      assert.deepEqual(found[name].rect, frac(rect), name);
      const area = rect[2] * rect[3] - (notch ? notch[2] * notch[3] : 0);
      assert.equal(found[name].uvArea, area / (W * H), name);
    }
    assert.deepEqual(islands.map((i) => i.uvArea), islands.map((i) => i.uvArea).sort((a, b) => b - a));
    assert.equal(notes.some((n) => /silhouette/.test(n)), /silhouette/.test(what));
  });
}

test('a speck is left out, and the notes say so', () => {
  const { islands, notes } = sheetIslands(wireframe(), W, H);
  assert.ok(!islands.some((i) => i.rect[2] * W <= 2));
  assert.match(notes.join('\n'), /1 speck\(s\) under 0\.01% of the sheet are left out/);
  assert.equal(sheetIslands(wireframe(), W, H, { minArea: 0 }).islands.length, 5);
});

test("an island's outline follows its edge, notch and all", () => {
  const { left, right } = named(sheetIslands(wireframe(), W, H).islands);
  for (const [isl, { rect, notch }] of [[left, ISLANDS.left], [right, ISLANDS.right]]) {
    const at = (x, y) => [x / W, y / H];
    assert.ok(inPoly(isl.outline, at(rect[0] + rect[2] / 2, rect[1] + rect[3] * 0.75)), 'the body of the flank');
    assert.ok(!inPoly(isl.outline, at(notch[0] + notch[2] / 2, notch[1] + notch[3] / 2)), 'the notch');
    assert.ok(isl.outline.length >= 6 && isl.outline.length <= 32);
  }
});

test('a PSD template is read from its wireframe layer, whichever that is', async () => {
  const lines = wireframe(), solid = new Uint8Array(W * H).fill(1);
  const want = sheetIslands(lines, W, H).islands;
  const cases = [
    ['named UV, under a fill', [{ name: 'UV', alpha: lines }, { name: 'Color Fill 1', alpha: solid }], {}, 'UV'],
    ['the only sparse layer, hidden, named in Portuguese', [{ name: 'Logos', alpha: null }, { name: 'Camada 1', alpha: lines, visible: false }, { name: 'BASE', alpha: solid }], {}, 'Camada 1'],
    ['stored run-length encoded, and cropped', [{ name: 'uv', alpha: lines, compression: 1, bbox: [5, 30, 195, 290] }], {}, 'uv'],
    ['named by the caller', [{ name: 'Layer 3', alpha: lines }, { name: 'Layer 2', alpha: lines }], { layer: 'Layer 2' }, 'Layer 2'],
    ['passing over a group named UV', [{ name: 'UV', group: true }, { name: 'Ébauche', alpha: lines }], {}, 'Ébauche'],
  ];
  for (const [what, layers, opts, layer] of cases) {
    const t = await readTemplate(psd(layers), opts);
    assert.equal(t.layer, layer, what);
    assert.deepEqual([t.width, t.height], [W, H], what);
    assert.deepEqual(sheetIslands(t.drawn, W, H).islands, want, what);
  }
});

test('a PSD that cannot be read as a template says why', async () => {
  const lines = wireframe();
  const cases = [
    ['two layers look like wireframes', psd([{ name: 'Layer 3', alpha: lines }, { name: 'Layer 2', alpha: lines }]), {}, /"Layer 3" and "Layer 2" all look like a wireframe; name the one that is/],
    ['none does', psd([{ name: 'BASE', alpha: new Uint8Array(W * H).fill(1) }]), {}, /none of its layers looks like a wireframe/],
    ['the named layer is not there', psd([{ name: 'UV', alpha: lines }]), { layer: 'uv lines' }, /has no layer "uv lines"; its layers are "UV"/],
    ['ZIP compressed', psd([{ name: 'UV', alpha: lines, compression: 2 }]), {}, /is ZIP compressed/],
    ['16 bits', psd([], { depth: 16 }), {}, /16 bits per channel/],
    ['a PSB', psd([], { version: 2 }), {}, /large-document file/],
  ];
  for (const [what, data, opts, message] of cases) await assert.rejects(readTemplate(data, opts), message, what);
});

test('a PNG template is read with or without transparency', async () => {
  const lines = wireframe();
  const want = sheetIslands(lines, W, H).islands;
  const clear = Buffer.alloc(W * H * 4), flat = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H; i++) {
    clear.writeUInt32BE(lines[i] ? 0x000000ff : 0, 4 * i);
    flat.set(lines[i] ? [240, 240, 240] : [16, 96, 208], 3 * i);
  }
  for (const [what, raw, channels] of [['exported with transparency', clear, 4], ['flattened onto a color', flat, 3]]) {
    const png = await sharp(raw, { raw: { width: W, height: H, channels } }).png().toBuffer();
    const t = await readTemplate(png);
    assert.equal(t.layer, null);
    assert.deepEqual(sheetIslands(t.drawn, W, H).islands, want, what);
  }
  await assert.rejects(readTemplate(await sharp(flat, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer(), { layer: 'UV' }), /not a PSD/);
});
