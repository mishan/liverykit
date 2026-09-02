// ---------------------------------------------------------------------------
// What a tyre island is, and how it was unwrapped.
//
// A sidewall is a disc. An unwrapper can lay it out as a DISC — polar about a
// hub, the way a photograph of a wheel looks — or cut it once and roll it out
// as a STRIP, u round the circumference and v from rim to shoulder. Both are
// common: the Abarth's is a disc, the NSX's and the RSS4's are strips. A
// design that draws concentric rings is right on the first and draws one big
// circle across the second, which on the car comes out as a few arcs where the
// circle happens to cross the strip.
//
// Nothing in the texture says which it is. The model does: the wheel centres
// are known (AC requires WHEEL_xx nodes), so for every vertex near a wheel the
// angle round the axle and the distance from it are measured, and the question
// is which texture coordinate tracks the angle. If u or v does, it is a strip;
// if the polar angle about the island's own UV centre does, it is a disc.
// ---------------------------------------------------------------------------

import { vertex } from './kn5.mjs';

/** How near a wheel centre an island's middle has to be to count as part of it. */
const WHEEL_REACH = 0.6;

/**
 * Measure every island that belongs to a wheel.
 *
 * Returns Map<island, description>, with nothing for islands that are not
 * wheel parts. A description is:
 *
 *   part      'sidewall' (faces along the axle) or 'tread' (faces outward)
 *   unwrap    'strip' or 'annulus'
 *   radiusM   [rim, shoulder] distance from the axle, metres
 *   strip:    around 'u'|'v' — which coordinate runs round the circumference;
 *             rim 'u0'|'u1'|'v0'|'v1' — which edge of the panel is the rim;
 *             across [at rim, at shoulder] in that coordinate, sheet fractions
 *   annulus:  hub [u, v] in sheet fractions; radiusUv [at rim, at shoulder]
 *             in u fractions (the v radius is that times the sheet's aspect)
 *
 * `fit` is the correlation the verdict rests on. Below 0.85 nothing is
 * claimed: a wheel part whose unwrap this cannot read gets `part` and no
 * `unwrap`, which is a true statement and a smaller one.
 */
export function measureWheels(model, islands) {
  const centres = wheelCentres(model);
  const out = new Map();
  if (!centres.length) return out;

  for (const isl of islands) {
    const c = isl.centroid;
    const wheel = centres.find((w) => Math.hypot(c.x - w.x, c.y - w.y, c.z - w.z) < WHEEL_REACH);
    if (!wheel) continue;

    // Per vertex: angle round the axle (which runs along x), distance from
    // it, the texture coordinate, and how much the normal points along the
    // axle.
    const pts = [];
    let axial = 0;
    for (const i of isl.vertices) {
      const p = vertex(model, isl.meshRef, i);
      const dy = p.y - wheel.y, dz = p.z - wheel.z;
      pts.push({ th: Math.atan2(dy, dz), rho: Math.hypot(dy, dz), u: p.u, v: p.v });
      axial += Math.abs(p.nx);
    }
    axial /= pts.length;
    const part = axial > 0.5 ? 'sidewall' : 'tread';
    const rhos = pts.map((p) => p.rho).sort((a, b) => a - b);
    const radiusM = [rhos[Math.floor(rhos.length * 0.02)], rhos[Math.floor(rhos.length * 0.98)]].map(r3);

    // Strip: does u or v track the angle? The angle wraps at ±π and an island
    // covering the whole circle has its cut somewhere; unwrapping the angle
    // in coordinate order takes care of that, and the correlation with a
    // straight line is the score.
    const byU = corrWithAngle(pts, 'u');
    const byV = corrWithAngle(pts, 'v');
    // Annulus: does the polar angle about the UV centre track the angle, and
    // does the UV radius track the real one?
    const uc = mean(pts.map((p) => p.u)), vc = mean(pts.map((p) => p.v));
    const polar = pts.map((p) => ({ ...p, pth: Math.atan2(p.v - vc, p.u - uc), prho: Math.hypot(p.u - uc, p.v - vc) }));
    const discAngle = corrWithAngle(polar, 'pth');
    const discRadius = Math.abs(corr(polar.map((p) => p.prho), polar.map((p) => p.rho)));

    const best = Math.max(byU, byV, Math.min(discAngle, discRadius));
    const desc = { part, radiusM, fit: r3(best) };
    if (best < 0.85) { out.set(isl, desc); continue; }

    if (best === byU || best === byV) {
      const around = best === byU ? 'u' : 'v';
      const across = around === 'u' ? 'v' : 'u';
      // Which end of the across-coordinate is the rim: the end where the
      // radius is smallest.
      const lo = pts.filter((p) => p.rho < radiusM[0] + (radiusM[1] - radiusM[0]) * 0.15);
      const hi = pts.filter((p) => p.rho > radiusM[1] - (radiusM[1] - radiusM[0]) * 0.15);
      const atRim = mean(lo.map((p) => p[across])), atShoulder = mean(hi.map((p) => p[across]));
      Object.assign(desc, {
        unwrap: 'strip', around,
        rim: `${across}${atRim < atShoulder ? '0' : '1'}`,
        across: [r4(atRim), r4(atShoulder)],
      });
    } else {
      const lo = polar.filter((p) => p.rho < radiusM[0] + (radiusM[1] - radiusM[0]) * 0.15);
      const hi = polar.filter((p) => p.rho > radiusM[1] - (radiusM[1] - radiusM[0]) * 0.15);
      // Radius in u-fractions: the UV distance's u component scaled back up,
      // so a non-square sheet's ellipse is described by one number and the
      // sheet's aspect.
      Object.assign(desc, {
        unwrap: 'annulus', hub: [r4(uc), r4(vc)],
        radiusUv: [r4(mean(lo.map((p) => p.prho))), r4(mean(hi.map((p) => p.prho)))],
      });
    }
    out.set(isl, desc);
  }
  return out;
}

function wheelCentres(model) {
  const dummies = model.dummies ?? [];
  const out = [];
  for (const which of ['LF', 'RF', 'LR', 'RR']) {
    const key = `WHEEL_${which}`;
    const node = dummies.find((d) => d.name.toUpperCase() === key)
      ?? dummies.find((d) => d.name.toUpperCase().startsWith(key));
    if (node) out.push({ which, x: node.world[12], y: node.world[13], z: node.world[14] });
  }
  return out;
}

/**
 * How well a coordinate tracks the angle round the axle, as |correlation|
 * after unwrapping the angle so a full circle is a line rather than a
 * sawtooth. Sorted by the coordinate, each step in angle is taken the short
 * way round, which turns a 0..2π ramp with its cut anywhere into a ramp.
 */
function corrWithAngle(pts, key) {
  const s = [...pts].sort((a, b) => a[key] - b[key]);
  const th = [];
  let acc = s[0].th;
  th.push(acc);
  for (let i = 1; i < s.length; i++) {
    let d = s[i].th - s[i - 1].th;
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    acc += d;
    th.push(acc);
  }
  return Math.abs(corr(s.map((p) => p[key]), th));
}

function corr(xs, ys) {
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const r3 = (n) => Math.round(n * 1000) / 1000;
const r4 = (n) => Math.round(n * 10000) / 10000;
