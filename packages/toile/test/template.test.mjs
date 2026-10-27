// Islands from a livery template, for a game that publishes templates and not
// its models.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readTemplate, sheetIslands, profileFromTemplate } from '../src/template.mjs';
import { validateProfile } from '../src/profile.mjs';
import { applyFit, selfMirrorFlips } from '../src/fit.mjs';
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

async function fromTemplate({ alpha = wireframe(), size, ...opts }) {
  const dir = await mkdtemp(join(tmpdir(), 'toile-template-'));
  try {
    const path = join(dir, 'car_template.psd');
    await writeFile(path, psd([{ name: 'UV', alpha }], size));
    const said = [];
    const profile = await profileFromTemplate(path, { texture: 'body.dds', log: (m) => said.push(m), ...opts });
    return { profile, said: said.join('\n') };
  } finally {
    await rm(dir, { recursive: true });
  }
}

/** The fixture's islands by what they are, as the profile names them. */
function panelsOf(profile) {
  const panels = profile.panels.body;
  return Object.fromEntries(Object.entries(ISLANDS).map(([what, { rect }]) => [what,
    Object.keys(panels).find((n) => panels[n].rect.every((v, i) => Math.abs(v - frac(rect)[i]) < 1e-4))]));
}

test('a plan-view template places each island by where it is drawn, nose up or down', async () => {
  // The flanks start a twelfth of the car's length from the top of the sheet,
  // so they reach whichever end is drawn there, and stop a sixth short of the
  // foot, so they do not reach the other.
  for (const [nose, want, flank] of [
    ['top', { roof: 'centre_front', left: 'left_mid', right: 'right_mid', bumper: 'centre_tail' }, ['left', 'nose', 'front', 'mid', 'rear', 'visible', 'mirrored']],
    ['bottom', { roof: 'centre_rear', left: 'right_mid', right: 'left_mid', bumper: 'centre_nose' }, ['right', 'front', 'mid', 'rear', 'tail', 'visible', 'mirrored']],
  ]) {
    const { profile } = await fromTemplate({ nose });
    validateProfile(profile);
    const names = panelsOf(profile), panels = profile.panels.body;
    assert.deepEqual(names, want, nose);
    assert.equal(panels[names.left].mirrorOf, names.right, nose);
    assert.equal(panels[names.right].mirrorOf, names.left, nose);
    assert.equal(panels[names.roof].mirrorOf, undefined, nose);
    assert.deepEqual(panels[names.left].tags, flank, `${nose}: a flank reaches the sections it runs through, and has no level`);
    assert.deepEqual(profile.calibration.plan, { nose, from: 'stated' });
    assert.ok(Object.values(panels).every((p) => p.confidence === 'proposed' && p.outline.length >= 4));
  }
});

test('a template profile says where its panels came from, and what it could not say', async () => {
  const { profile, said } = await fromTemplate({});
  assert.deepEqual(Object.keys(profile.panels.body), ['island_1', 'island_2', 'island_3', 'island_4']);
  assert.ok(Object.values(profile.panels.body).every((p) => !p.plan && !p.mirrorOf && p.tags.join() === 'visible'));
  assert.match(said, /no nose was given, so the panels have no place on the car/);
  assert.match(said, /4 islands on layer "UV"/);
  assert.match(said, /1 speck\(s\)/);
  const { calibration, textures } = profile;
  assert.deepEqual([calibration.method, calibration.source, calibration.layer, calibration.plan], ['template', 'car_template.psd', 'UV', undefined]);
  assert.match(calibration.template.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(textures.body, { file: 'body.dds', width: W, height: H });
  await assert.rejects(fromTemplate({ texture: undefined }), /needs the texture file the game reads this sheet as/);
  await assert.rejects(fromTemplate({ nose: 'front' }), /nose is "top" or "bottom"/);
});

test('an island is proposed as seen by its size, and a speck is not', async () => {
  const { profile } = await fromTemplate({ nose: 'top', minArea: 0 });
  const panels = Object.values(profile.panels.body);
  assert.equal(panels.length, 5);
  assert.deepEqual(panels.map((p) => p.visibleBy ?? null), ['size', 'size', 'size', 'size', null]);
  assert.ok(!panels[4].tags.includes('visible'));
  const { profile: strict } = await fromTemplate({ nose: 'top', seenArea: 0.11 });
  assert.equal(Object.values(strict.panels.body).filter((p) => p.tags.includes('visible')).length, 1, 'only the roof is a ninth of the sheet');
});

test('a placement mirrored onto a template flank lands on the same edge of its twin', async () => {
  const { profile } = await fromTemplate({ nose: 'top' });
  const names = panelsOf(profile);
  const { regions } = applyFit([{ id: 'n', panel: names.left, at: [0, 0.5, 0.4, 0.2], mirror: true, treatment: 'fill' }], null, { profile, role: 'body' });
  const twin = regions.find((r) => r.panel === names.right);
  assert.deepEqual(twin.at, [0.6, 0.5, 0.4, 0.2], 'drawn across the sheet the other way, so the outer edge is at the far side of its rect');
  assert.deepEqual(selfMirrorFlips(profile.panels.body[names.roof]), { u: true, v: false }, 'a roof seen from above has the car\'s centerline down the sheet');
});

test('islands beyond the car, without a mirror, or with nothing big enough to be the car are placed and said', async () => {
  const alpha = wireframe();
  for (let y = 290; y < 294; y++) for (let x = 10; x < 16; x++) alpha[y * W + x] = 1;
  const { profile, said } = await fromTemplate({ alpha, nose: 'top' });
  assert.match(said, /1 island\(s\) lie beyond the car's span on the sheet and are placed at its edge/);
  assert.match(said, /1 island\(s\) off the middle found no mirror image across it/);
  assert.equal(Object.keys(profile.panels.body).length, 5);

  // Six parts of a thirtieth of a percent each: they are the car.
  const S = 400, parts = new Uint8Array(S * S);
  for (let k = 0; k < 6; k++) {
    const x0 = 20 + k * 60, y0 = 50 + k * 40;
    for (let y = y0; y < y0 + 30; y++) for (let x = x0; x < x0 + 30; x++) parts[y * S + x] = 1;
  }
  const { profile: small, said: told } = await fromTemplate({ alpha: parts, size: { width: S, height: S }, nose: 'top' });
  validateProfile(JSON.parse(JSON.stringify(small)));
  const sides = Object.values(small.panels.body).map((p) => p.tags[0]);
  assert.deepEqual(sides, ['left', 'left', 'left', 'right', 'right', 'right']);
  assert.doesNotMatch(told, /beyond/);
});

test('a plan out of range is refused when the profile is read', () => {
  const profile = (plan) => ({ id: 'x', textures: { body: { file: 'b.dds', width: 4, height: 4 } }, panels: { body: { p: { rect: [0, 0, 1, 1], plan } } } });
  validateProfile(profile({ across: [-1, 0.5], along: [0, 1] }));
  for (const plan of [{ across: [-1.5, 0], along: [0, 1] }, { across: [0, 0.5], along: [0.6, 0.2] }, { along: [0, 1] }]) {
    assert.throws(() => validateProfile(profile(plan)), /p\.plan must be \{ across/, JSON.stringify(plan));
  }
});
