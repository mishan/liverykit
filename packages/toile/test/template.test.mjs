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

test('a line drawn at a slant closes an island, and a neck through the first pixel does not end its outline', () => {
  // A diamond outlined in steps one pixel diagonal from the next: the
  // outside must not leak in through those corners.
  const S = 40, diamond = new Uint8Array(S * S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) if (Math.abs(x - 20) + Math.abs(y - 20) === 12) diamond[y * S + x] = 1;
  let inside = 0;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) inside += Math.abs(x - 20) + Math.abs(y - 20) <= 12;
  const { islands } = sheetIslands(diamond, S, S);
  assert.equal(islands.length, 1);
  assert.equal(islands[0].uvArea, inside / (S * S));

  // Two blocks joined only by the one pixel above them, which is where
  // tracing starts and where it passes twice.
  const joined = new Uint8Array(S * S);
  for (let y = 11; y < 21; y++) for (let x = 10; x < 31; x++) if (x !== 20) joined[y * S + x] = 1;
  joined[10 * S + 20] = 1;
  const [both] = sheetIslands(joined, S, S).islands;
  for (const cx of [14.5, 25.5]) assert.ok(inPoly(both.outline, [cx / S, 16 / S]), `the block about x ${cx}`);
});

test('a sheet with nothing on it says so', () => {
  assert.match(sheetIslands(new Uint8Array(100), 10, 10).notes.join(), /no islands were found/);
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
    ['passing over a folder named UV', [{ name: 'UV', group: 1 }, { name: 'Ébauche', alpha: lines }], {}, 'Ébauche'],
    ['passing over the divider closing a folder', [{ name: 'UV', group: 3 }, { name: 'Layer 1', alpha: lines }], {}, 'Layer 1'],
    ['stored running off the sheet on every side, under a mask', [{ name: 'UV', alpha: lines, bbox: [-10, -7, W + 9, H + 4], mask: true, compression: 1 }], {}, 'UV'],
    ['beside a logo wholly off the sheet', [{ name: 'Layer 1', alpha: lines }, { name: 'logo', alpha: null, bbox: [W + 10, H - 5, W + 50, H + 20] }], {}, 'Layer 1'],
    ['counted negatively', [{ name: 'UV', alpha: lines }], { negativeCount: true }, 'UV'],
  ];
  for (const [what, layers, { negativeCount, ...opts }, layer] of cases) {
    const t = await readTemplate(psd(layers, { negativeCount }), opts);
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
  const whole = psd([{ name: 'UV', alpha: lines }]);
  const claiming = (w, h) => { const b = Buffer.from(whole); b.writeUInt32BE(h, 14); b.writeUInt32BE(w, 18); return b; };
  cases.push(
    ['cut short inside its wireframe', whole.subarray(0, Math.floor(whole.length * 0.4)), {}, /is cut short in its layers/],
    ['claiming more pixels than its bytes could hold', claiming(20000, 20000), {}, /is too short to hold the 20000x20000 image it claims/],
    ['claiming a size no PSD has', claiming(40000, 300), {}, /claims to be 40000x300, which a PSD cannot be/],
  );
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
  const nearlyOpaque = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) nearlyOpaque.writeUInt32BE(lines[i] ? 0xf0f0f0ff : 0x1060d0ff, 4 * i);
  nearlyOpaque[4 * (W * 150 + 100) + 3] = 254;
  for (const [what, raw, channels] of [['exported with transparency', clear, 4], ['flattened onto a color', flat, 3], ['flattened, with one translucent pixel', nearlyOpaque, 4]]) {
    const png = await sharp(raw, { raw: { width: W, height: H, channels } }).png().toBuffer();
    const t = await readTemplate(png);
    assert.equal(t.layer, null);
    assert.deepEqual(sheetIslands(t.drawn, W, H).islands, want, what);
  }
  await assert.rejects(readTemplate(await sharp(flat, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer(), { layer: 'UV' }), /not a PSD/);
});
