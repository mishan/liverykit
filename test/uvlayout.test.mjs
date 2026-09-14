// ---------------------------------------------------------------------------
// Tiled materials and shifted sheets.
//
// What a profile says about how a texture's UVs use the image, and what the
// build does with artwork placed on a texture that tiles. The synthetic car
// gains a seat cushion wearing a second texture, so each case changes one
// thing — how many times the image repeats across the cushion, or which copy of
// the sheet it sits on — and every other number in the fixture stays put.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { carKn5, vert } from './fixtures/kn5.mjs';
import { profileFromKn5 } from '../src/engine/profilegen.mjs';
import { resolveTargets } from '../src/profile.mjs';
import { portability } from '../src/portability.mjs';
import { renderTexture } from '../src/render.mjs';
import { resolveTreatments } from '../src/registry.mjs';
import { isMissingNote } from '../src/build.mjs';
import '../src/index.mjs';   // registers the treatment packs

/**
 * A flat cushion inside the car, on its own texture. `repeat` is how many times
 * the image tiles across it; `shift` moves the whole unwrap by whole sheets.
 */
function cushion({ repeat = 1, shift = [0, 0] }) {
  const N = 6;
  const verts = [];
  const indices = [];
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      const s = i / N, t = j / N;
      verts.push(vert(-0.3 + 0.6 * s, 0.5, -0.3 + 0.6 * t,
        shift[0] + 0.05 + 0.9 * s * repeat, shift[1] + 0.05 + 0.9 * t * repeat));
    }
  }
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const a = j * (N + 1) + i;
      indices.push(a, a + 1, a + N + 2, a, a + N + 2, a + N + 1);
    }
  }
  return { name: 'SEAT_CUSHION', verts, indices, materialId: 1 };
}

async function profileWith(seat) {
  const dir = await mkdtemp(join(tmpdir(), 'liverykit-uv-'));
  try {
    const file = join(dir, 'car.kn5');
    await writeFile(file, carKn5({
      extraMeshes: [cushion(seat)],
      materials: [{ name: 'BodyMat' }, { name: 'SeatMat', slots: { txDiffuse: 'seat.dds' } }],
      extraTextures: [{ name: 'seat.dds', width: 64, height: 64 }],
    }));
    const lines = [];
    const profile = await profileFromKn5(file, { id: 'c', visibility: false, log: (s) => lines.push(s) });
    const roleOf = (f) => Object.entries(profile.textures).find(([, t]) => t.file === f)?.[0];
    return { profile, log: lines.join('\n'), seat: roleOf('seat.dds'), body: roleOf('body.dds') };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('a texture that repeats across its surface is called tiled, and the profile says so', async () => {
  const { profile, log, seat, body } = await profileWith({ repeat: 40 });
  assert.ok(seat, 'the cushion texture is in the profile');
  assert.equal(profile.textures[seat].uvLayout, 'tiled');
  assert.ok(profile.textures[seat].uvInside < 0.5, `inside ${profile.textures[seat].uvInside}`);
  assert.equal(profile.textures[body].uvLayout, 'unwrapped');
  assert.equal(profile.textures[body].uvInside, 1);
  assert.equal(profile.textures[body].uvTile, undefined, 'an unwrap where it belongs carries no offset');
  assert.match(log, /1 of 2 paintable textures are tiled materials; nothing on them can be placed/);
  // The body is the largest texture spanning the car and it is unwrapped, so
  // the line saying the car cannot wear a placed design must not appear.
  assert.doesNotMatch(log, /largest texture spanning the car/);
});

test('an unwrap shifted by a whole sheet is an unwrap, and the profile says where it is', async () => {
  const { profile, log, seat } = await profileWith({ repeat: 1, shift: [0, -1] });
  assert.equal(profile.textures[seat].uvLayout, 'unwrapped',
    'wrap addressing draws a sheet at v = -1 exactly as one at v = 0');
  assert.deepEqual(profile.textures[seat].uvTile, [0, -1]);
  assert.match(log, /1 texture\(s\) are unwraps shifted off the sheet by whole copies of it \(seat\.dds at \[0, -1\]\)/);
  // The gap that log line exists to admit: findIslands clamps the island into
  // [0, 1], where it collapses and is dropped. When islands are measured on
  // their own copy of the sheet this becomes a panel, and this assertion is
  // the one to change.
  assert.equal(Object.keys(profile.panels[seat] ?? {}).length, 0);
});

test('placement on a tiled material is skipped and reported, and a fill still paints', async () => {
  const { profile, seat } = await profileWith({ repeat: 40 });
  const notes = [];
  const layers = renderTexture({
    profile,
    role: seat,
    regions: [
      { treatment: 'fill', color: 'accent' },
      { treatment: 'fill', at: [0, 0, 0.5, 0.5], color: 'hot' },
      { id: 'badge', treatment: 'text', tags: ['centre'], text: '7', color: 'hot' },
    ],
    background: 'base',
    treatments: resolveTreatments(['core']),
    palette: { base: '#112233', accent: '#00ff00', hot: '#ff0000' },
    rng: () => 0.5,
    font: 'DejaVu Sans',
    tokens: {},
    regionNotes: notes,
  });
  assert.match(layers.base, /#00ff00/i, 'the fill with no placement covers the sheet');
  assert.doesNotMatch(layers.base, /#ff0000/i, 'nothing placed was drawn');

  assert.equal(notes.length, 2);
  for (const n of notes) {
    assert.equal(n.status, 'unplaceable');
    assert.match(n.text, /seat\.dds is a tiled material/);
    assert.equal(isMissingNote(n), true, 'a skipped region was not painted, and the report must say so');
  }
  assert.match(notes.find((n) => n.id === 'badge').text, /tags \[centre\]/);
});

test('a surface bound to a tiled material is painted with a caveat, and the report names what cannot land', async () => {
  const { profile, seat } = await profileWith({ repeat: 40 });
  profile.bind = { ...profile.bind, interior: { roles: [seat], source: 'human' } };
  const design = {
    name: 'L',
    surfaces: {
      interior: {
        regions: [
          { treatment: 'halftone', color: 'accent' },
          { id: 'number', treatment: 'text', tags: ['centre'], text: '7' },
        ],
      },
    },
  };

  const { targets, notes } = resolveTargets(profile, design);
  assert.equal(targets.length, 1, 'the surface is still painted');
  const caveat = notes.find((n) => n.status === 'tiled');
  assert.ok(caveat, 'and the report says it is a tiled material');
  assert.equal(caveat.term, 'surfaces.interior');
  assert.equal(isMissingNote(caveat), false, 'painted, so not under "asked for and not painted"');

  // The editor's "On another car" panel reads this, before anyone builds.
  const report = portability(design, profile);
  const number = report.regions.find((r) => r.id === 'number');
  assert.equal(number.status, 'unplaceable');
  assert.match(number.why, /seat\.dds/);
  assert.notEqual(report.regions.find((r) => r.id !== 'number').status, 'unplaceable',
    'an even pattern is not placement');
});
