// Tyres. A sidewall is unwrapped as a strip (u round the circumference, v from
// rim to shoulder) on the NSX and the RSS4, and as an annulus — a disc image —
// on the Abarth. A design that draws rings is right on one and wrong on the
// other, and nothing in the profile said which was which.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseKn5Buffer, meshesUsingTexture } from '../src/engine/kn5.mjs';
import { findIslands } from '../src/engine/islands.mjs';
import { measureWheels } from '../src/engine/wheels.mjs';
import { buildKn5, vert } from './fixtures/kn5.mjs';

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

test('a sidewall unwrapped as a strip is told from one unwrapped as a disc, and which edge is the rim', () => {
  // Strip: u round the circumference, v from SHOULDER (top of the sheet) to
  // rim — the way round that is not the obvious one, so the answer cannot be
  // a default. Occupies the top fifth of the sheet.
  const strip = sidewall('TYRE_LF', { X: 0.95, cy: 0.3, cz: 1.2, r0: 0.23, r1: 0.31,
    uv: (a, t) => [a, 0.2 - 0.2 * t] });
  // Disc: polar about (0.5, 0.5), rim at radius 0.2 of the sheet, shoulder at 0.45.
  const disc = sidewall('TYRE_RF', { X: -0.95, cy: 0.3, cz: 1.2, r0: 0.23, r1: 0.31,
    uv: (a, t) => { const r = 0.2 + 0.25 * t; return [0.5 + r * Math.cos(a * 2 * Math.PI), 0.5 + r * Math.sin(a * 2 * Math.PI)]; } });
  const m = parseKn5Buffer(buildKn5({ extraMeshes: [strip, disc], dummies: wheels }));
  const islands = findIslands(m, meshesUsingTexture(m, 'body.dds'), { minVertices: 40 });
  const measured = measureWheels(m, islands);

  const s = measured.get(islands.find((i) => i.mesh === 'TYRE_LF'));
  assert.ok(s, 'the strip sidewall is near a wheel and is measured');
  assert.equal(s.part, 'sidewall');
  assert.equal(s.unwrap, 'strip');
  assert.equal(s.around, 'u');
  // Rim is at the LOW-radius end. The mesh put the rim (t = 0) at v = 0.2,
  // the panel's far v edge, and the shoulder at v = 0 — so the rim is v1,
  // and a reader that assumed "rim at the top of the strip" would be wrong.
  assert.equal(s.rim, 'v1');
  assert.ok(Math.abs(s.across[0] - 0.2) < 0.01 && Math.abs(s.across[1] - 0) < 0.01, JSON.stringify(s.across));
  assert.ok(Math.abs(s.radiusM[0] - 0.23) < 0.01 && Math.abs(s.radiusM[1] - 0.31) < 0.01, JSON.stringify(s.radiusM));

  const d = measured.get(islands.find((i) => i.mesh === 'TYRE_RF'));
  assert.equal(d.part, 'sidewall');
  assert.equal(d.unwrap, 'annulus');
  assert.ok(Math.abs(d.hub[0] - 0.5) < 0.01 && Math.abs(d.hub[1] - 0.5) < 0.01, JSON.stringify(d.hub));
  assert.ok(Math.abs(d.radiusUv[0] - 0.2) < 0.01 && Math.abs(d.radiusUv[1] - 0.45) < 0.01, JSON.stringify(d.radiusUv));

  // The body mesh is nowhere near a wheel and is not a wheel part.
  assert.equal(measured.get(islands.find((i) => i.mesh === 'body_mesh')), undefined);
});

test('a tread is a tread', () => {
  // A cylinder band round the wheel: normals radial, not axial.
  const verts = [], indices = [], segments = 36;
  for (let j = 0; j <= 1; j++) {
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * 2 * Math.PI, X = 0.8 + (j ? 0.15 : -0.15);
      verts.push(vert(X, 0.3 + 0.32 * Math.sin(a), 1.2 + 0.32 * Math.cos(a), i / segments, 0.3 + 0.3 * j, [0, Math.sin(a), Math.cos(a)]));
    }
  }
  for (let i = 0; i < segments; i++) indices.push(i, i + 1, i + segments + 2, i, i + segments + 2, i + segments + 1);
  const m = parseKn5Buffer(buildKn5({ extraMeshes: [{ name: 'TREAD_LF', verts, indices }], dummies: wheels }));
  const islands = findIslands(m, meshesUsingTexture(m, 'body.dds'), { minVertices: 40 });
  const t = measureWheels(m, islands).get(islands.find((i) => i.mesh === 'TREAD_LF'));
  assert.equal(t?.part, 'tread');
  assert.equal(t?.unwrap, 'strip');
});

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
