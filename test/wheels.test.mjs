// Tires. A sidewall is unwrapped as a strip (u round the circumference, v from
// rim to shoulder) on the NSX and the RSS4, and as an annulus — a disc image —
// on the Abarth. A design that draws rings is right on one and wrong on the
// other, and nothing in the profile said which was which.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { vert } from './fixtures/kn5.mjs';

/**
 * A sidewall: an annulus of quads in the plane x = X, centred on (X, cy, cz),
 * from rim radius r0 to shoulder radius r1. `uv` maps (angle, radial fraction)
 * to texture coordinates, so the same geometry can be unwrapped either way.
 */
function sidewall(name, { X, cy, cz, r0, r1, uv, segments = 36, rings = 4 }) {
  const verts = [], indices = [];
  for (let j = 0; j <= rings; j++) {
    const t = j / rings, r = r0 + (r1 - r0) * t;
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * 2 * Math.PI;
      const [u, v] = uv(i / segments, t);
      verts.push(vert(X, cy + r * Math.sin(a), cz + r * Math.cos(a), u, v, [Math.sign(X) || 1, 0, 0]));
    }
  }
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < segments; i++) {
      const a = j * (segments + 1) + i;
      indices.push(a, a + 1, a + segments + 2, a, a + segments + 2, a + segments + 1);
    }
  }
  return { name, verts, indices };
}

const wheels = [
  { name: 'WHEEL_LF', at: [0.8, 0.3, 1.2] }, { name: 'WHEEL_RF', at: [-0.8, 0.3, 1.2] },
  { name: 'WHEEL_LR', at: [0.8, 0.3, -1.2] }, { name: 'WHEEL_RR', at: [-0.8, 0.3, -1.2] },
];

test('band draws a stripe across a strip sidewall and a ring on a disc, where the profile says', async () => {
  await import('../src/index.mjs');
  const { renderTexture } = await import('../src/render.mjs');
  const { resolveTreatments } = await import('../src/registry.mjs');
  const profile = {
    id: 't', textures: { tyres: { file: 'tyre.dds', width: 2048, height: 512 } },
    panels: { tyres: {
      // The NSX's shape: a strip along the top, u round, rim at the top edge.
      strip: { rect: [0, 0, 1, 0.18], wheel: { part: 'sidewall', unwrap: 'strip', around: 'u', rim: 'v0', across: [0.005, 0.18], radiusM: [0.23, 0.31] } },
      // The Abarth's: a disc about the middle of a square-ish patch.
      disc: { rect: [0.2, 0.2, 0.6, 0.6], wheel: { part: 'sidewall', unwrap: 'annulus', hub: [0.5, 0.5], radiusUv: [0.1, 0.28], radiusM: [0.23, 0.31] } },
      // A profile from before the measurement existed.
      unknown: { rect: [0, 0.82, 1, 0.18] },
    } },
  };
  const draw = (panel) => renderTexture({
    profile, role: 'tyres', treatments: resolveTreatments(['core']), palette: {}, rng: Math.random, font: 'sans-serif', tokens: {},
    regions: [{ treatment: 'band', panel, along: 0.5, width: 0.1, color: '#0ff' }],
  }).base;

  // Strip: a full-width rect half way between rim and shoulder, in v.
  const strip = draw('strip').match(/<rect x="0" y="([\d.]+)" width="2048" height="([\d.]+)" fill="#0ff"/);
  assert.ok(strip, 'a stripe across the whole strip');
  const mid = ((0.005 + 0.18) / 2) * 512, thick = (0.18 - 0.005) * 0.1 * 512;
  assert.ok(Math.abs(+strip[1] - (mid - thick / 2)) < 0.6 && Math.abs(+strip[2] - thick) < 0.6, `at ${strip[1]} x ${strip[2]}`);

  // Disc: an ellipse about the hub, radius half way between rim and shoulder.
  const disc = draw('disc').match(/<ellipse cx="1024" cy="256" rx="([\d.]+)" ry="([\d.]+)"/);
  assert.ok(disc, 'a ring about the hub');
  assert.ok(Math.abs(+disc[1] - 0.19 * 2048) < 0.6, `radius ${disc[1]}`);

  // No measurement: the old ring, so nothing is silently lost.
  assert.match(draw('unknown'), /<circle /);
});

test('a band with no panel goes round every sidewall its sheet measures', async () => {
  // The Raiden and Grand Touring liveries both wrote their tyre band with no
  // panel, as a band round the tyre reads. With no panel there was no wheel
  // measurement to read, and it fell back to one ring across the whole
  // sheet: on the NSX a vermilion arc along the top of each tyre and nothing
  // else, in silence.
  await import('../src/index.mjs');
  const { renderTexture } = await import('../src/render.mjs');
  const { resolveTreatments } = await import('../src/registry.mjs');
  const sidewall = (rim, across) => ({ part: 'sidewall', unwrap: 'strip', around: 'u', rim, across, radiusM: [0.25, 0.33] });
  const profile = {
    id: 't', textures: { tyres: { file: 'tyre.dds', width: 2048, height: 512 } },
    panels: { tyres: {
      // The NSX's sheet: the outer sidewall along the top, the inner along the
      // bottom, rim at either edge, and four wheels' panels on each.
      left_front: { rect: [0, 0, 1, 0.18], wheel: sidewall('v0', [0.005, 0.18]) },
      right_front: { rect: [0, 0, 1, 0.18], wheel: sidewall('v0', [0.005, 0.18]) },
      left_front_lower: { rect: [0, 0.82, 1, 0.18], wheel: sidewall('v1', [0.995, 0.82]) },
    } },
  };
  const notes = [];
  const svg = renderTexture({
    profile, role: 'tyres', treatments: resolveTreatments(['core']), palette: {}, rng: Math.random, font: 'sans-serif', tokens: {},
    regions: [{ treatment: 'band', along: 0.5, width: 0.1, color: '#0ff' }], regionNotes: notes,
  }).base;
  const stripes = [...svg.matchAll(/<rect x="0" y="([\d.]+)" width="2048" height="[\d.]+" fill="#0ff"/g)].map((m) => +m[1]);
  assert.equal(stripes.length, 2, `one stripe per sidewall, not per wheel: ${svg}`);
  assert.ok(stripes.some((y) => y < 0.18 * 512) && stripes.some((y) => y > 0.82 * 512), JSON.stringify(stripes));
  assert.doesNotMatch(svg, /<circle /, 'and no ring across the sheet');

  // A sheet nobody has measured still gets the ring, and says why.
  const bare = { ...profile, panels: { tyres: { tread: { rect: [0, 0.2, 1, 0.6] } } } };
  const said = [];
  const ring = renderTexture({
    profile: bare, role: 'tyres', treatments: resolveTreatments(['core']), palette: {}, rng: Math.random, font: 'sans-serif', tokens: {},
    regions: [{ treatment: 'band', along: 0.5, width: 0.1, color: '#0ff' }], regionNotes: said,
  }).base;
  assert.match(ring, /<circle /);
  assert.ok(said.some((n) => /no sidewall/.test(n.text)), JSON.stringify(said));
});
