// ---------------------------------------------------------------------------
// A band: the texels of a surface that lie between two heights on the object.
//
// A stripe along a car's flank is one idea, and its sheet is not: the door,
// the quarters, a fender merged with the door on one side and its own island
// on the other, the corners of the nose. Placed panel by panel, Raiden's sweep
// on the MX5 took thirteen regions, each from a measurement, and a straight
// line across a curved panel still put its pinstripe 1.7 cm off the door's.
// Every texel has a position on the object, so the band is asked of that
// instead: each triangle of the surface is clipped in 3D between the band's
// two planes, and the piece that is left, carried into the sheet by the same
// interpolation the triangle's UVs use, is exactly the texels in the band.
//
// Heights are fractions of the surface's own height, from its lowest point to
// its highest, so a band means the same thing on a coupe and an open car, and
// on an object with no wheels and no ground under it.
// ---------------------------------------------------------------------------

import { meshesWearing, vertex, triangles } from '../model.mjs';

/**
 * How far a surface has to face sideways to be on a side: the sine of 15
 * degrees off upright or flat. A flank that tucks under or rolls over towards
 * the roof is still the flank, and the corners of a bumper turning forward are
 * where a stripe along the side goes on round; a bonnet, a roof and a floor
 * are not on either side.
 */
const SIDEWAYS = 0.26;

const SIGN = { '+X': 1, '-X': -1, '+Z': 1, '-Z': -1 };

/**
 * The band as polygons on the sheet, one per clipped triangle, in sheet
 * fractions.
 *
 *   texture   the sheet, as the model names it
 *   axes      { left, front }, as a profile records them: '+X', '-Z' and so on
 *   band      { height: [lo, hi], rear?: [lo, hi], side?: 'left'|'right'|'both' }
 *
 * `height` is at the surface's front end. `rear`, when given, is at its rear
 * end and the band tilts between the two, which is how a stripe follows a
 * bodyline; without it the band is level.
 *
 * Returns { polygons, frame }, where frame is what the fractions were taken
 * against: the surface's lowest and highest points and its front and rear
 * ends, in the model's own coordinates.
 */
export function bandPolygons(model, { texture, axes }, band) {
  const left = SIGN[axes?.left], front = SIGN[axes?.front];
  if (!left || !front) throw new Error(`a band needs the object's axes, and these say ${JSON.stringify(axes)}`);
  const side = band.side ?? 'both';
  if (!['left', 'right', 'both'].includes(side)) throw new Error(`a band's side is left, right or both, not ${JSON.stringify(band.side)}`);
  const [lo0, hi0] = band.height ?? [];
  const [lo1, hi1] = band.rear ?? band.height ?? [];
  for (const v of [lo0, hi0, lo1, hi1]) {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`a band's heights are numbers, and these are ${JSON.stringify(band)}`);
  }

  const tris = [];
  let yMin = Infinity, yMax = -Infinity, zMin = Infinity, zMax = -Infinity;
  for (const mesh of meshesWearing(model, texture)) {
    for (const t of triangles(model, mesh)) {
      const p = t.map((i) => vertex(model, mesh, i));
      tris.push(p);
      for (const q of p) {
        yMin = Math.min(yMin, q.y); yMax = Math.max(yMax, q.y);
        const z = front * q.z;
        zMin = Math.min(zMin, z); zMax = Math.max(zMax, z);
      }
    }
  }
  const frame = { bottom: yMin, top: yMax, front: front * zMax, rear: front * zMin };
  if (!tris.length) return { polygons: [], frame };

  const height = yMax - yMin, length = (zMax - zMin) || 1;
  // How far along from the front end, 0 there and 1 at the rear.
  const along = (q) => (zMax - front * q.z) / length;
  const at = (a, b) => (q) => yMin + height * (a + (b - a) * along(q));
  const below = at(lo0, lo1), above = at(hi0, hi1);

  const polygons = [];
  for (const p of tris) {
    // The face's own normal, from its corners, since vertex normals are
    // smoothed across creases and a sill would borrow the floor's. Its sign
    // comes from the vertex normals all the same: winding is the exporter's
    // choice, and the fixture's left flank is wound to face right.
    const ux = p[1].x - p[0].x, uy = p[1].y - p[0].y, uz = p[1].z - p[0].z;
    const vx = p[2].x - p[0].x, vy = p[2].y - p[0].y, vz = p[2].z - p[0].z;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (!len) continue;
    const said = p.reduce((a, q) => a + q.nx * nx + q.ny * ny + q.nz * nz, 0);
    const lateral = (said < 0 ? -1 : 1) * left * nx / len;
    if (side === 'left' ? lateral < SIDEWAYS : side === 'right' ? lateral > -SIDEWAYS : Math.abs(lateral) < SIDEWAYS) continue;

    let poly = p.map((q) => ({ y: q.y, z: q.z, u: q.u, v: q.v, lo: q.y - below(q), hi: above(q) - q.y }));
    poly = clip(clip(poly, 'lo'), 'hi');
    if (poly.length >= 3) polygons.push(poly.map((q) => [q.u, q.v]));
  }
  return { polygons, frame };
}

/**
 * Sutherland-Hodgman against one plane, given each corner's signed distance
 * to it under `key`. Distances are linear across a triangle, so they and the
 * UVs interpolate together and the cut lands where the plane crosses.
 */
function clip(poly, key) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    if (a[key] >= 0) out.push(a);
    if ((a[key] >= 0) !== (b[key] >= 0)) {
      const t = a[key] / (a[key] - b[key]);
      const mix = (k) => a[k] + (b[k] - a[k]) * t;
      out.push({ y: mix('y'), z: mix('z'), u: mix('u'), v: mix('v'), lo: mix('lo'), hi: mix('hi') });
    }
  }
  return out;
}
