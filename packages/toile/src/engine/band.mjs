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

import { meshesWearing, meshTraits, vertex, triangles } from '../model.mjs';
import { polyArea } from './poly.mjs';

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
 * Returns { polygons, frame, notes }. The frame is what the fractions were
 * taken against: the surface's lowest and highest points and its front and
 * rear ends, in the model's own coordinates. The notes say what was left out
 * and why, for whoever draws the band to pass on.
 */
export function bandPolygons(model, { texture, axes }, band) {
  const left = SIGN[axes?.left], front = SIGN[axes?.front];
  if (!left || !front) throw new Error(`a band needs the object's axes, and these say ${JSON.stringify(axes)}`);
  const side = band.side ?? 'both';
  if (!['left', 'right', 'both'].includes(side)) throw new Error(`a band's side is left, right or both, not ${JSON.stringify(band.side)}`);
  const ends = [band.height, band.rear ?? band.height];
  // Linear between the ends, so a band whose bottom is under its top at both
  // is so everywhere between, and one that crossed would vanish where it did.
  for (const e of ends) {
    if (!Array.isArray(e) || e.length !== 2 || !e.every((v) => typeof v === 'number' && v >= 0 && v <= 1) || e[0] >= e[1]) {
      throw new Error(`a band's heights are [bottom, top], fractions of the surface's height from 0 to 1 with the bottom under the top; ${JSON.stringify(band)} is not`);
    }
  }
  const [[lo0, hi0], [lo1, hi1]] = ends;

  // The surface as the game draws it outside: a cockpit's own copies and the
  // blurred meshes swapped in at speed would move its top and ends, and paint
  // where nobody looks for a stripe along the flank.
  const meshes = meshesWearing(model, texture).filter((m) => { const t = meshTraits(model, m); return !t.blur && !t.lod; });
  if (!meshes.length) throw new Error(`no mesh drawn outside the cockpit wears ${texture}, so there is nothing to put a band on`);
  const tris = [];
  let yMin = Infinity, yMax = -Infinity, zMin = Infinity, zMax = -Infinity;
  for (const mesh of meshes) {
    const at = new Map();
    const v = (i) => { let q = at.get(i); if (!q) { q = vertex(model, mesh, i); at.set(i, q); } return q; };
    for (const t of triangles(model, mesh)) tris.push(t.map(v));
    for (const q of at.values()) {
      yMin = Math.min(yMin, q.y); yMax = Math.max(yMax, q.y);
      zMin = Math.min(zMin, front * q.z); zMax = Math.max(zMax, front * q.z);
    }
  }
  const frame = { bottom: yMin, top: yMax, front: front * zMax, rear: front * zMin };

  const height = yMax - yMin, length = (zMax - zMin) || 1;
  // How far along from the front end, 0 there and 1 at the rear.
  const along = (q) => (zMax - front * q.z) / length;
  const at = (a, b) => (q) => yMin + height * (a + (b - a) * along(q));
  const below = at(lo0, lo1), above = at(hi0, hi1);

  const polygons = [];
  let unknown = 0, offSheet = 0;
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
    const said = p.reduce((a, q) => a + q.nx * nx + q.ny * ny + q.nz * nz, 0) / len;
    const lateral = left * nx / len;
    // Normals that cancel, or none, cannot say which way a sideways face
    // looks, and guessing from the winding is what the sign is there to
    // avoid. Counted, so the band says how much it could not judge.
    if (Math.abs(said) < 0.5) { if (Math.abs(lateral) >= SIDEWAYS) unknown++; continue; }
    const dir = Math.sign(said * lateral);
    if (!dir) continue;
    // Facing out from the half of the object it is on: the inside of the
    // far door faces this way too, and is not on this side.
    if (dir !== Math.sign(left * (p[0].x + p[1].x + p[2].x))) continue;
    if (side === 'left' ? dir < 0 : side === 'right' ? dir > 0 : false) continue;

    // Where the surface turns away past SIDEWAYS is a third plane, cut on the
    // vertex normals, which are smooth: judged a face at a time, the band
    // ended in steps round a bumper's corner, one triangle wide.
    const turn = (q) => {
      const n = Math.hypot(q.nx, q.ny, q.nz);
      return (n ? dir * left * q.nx / n : Math.abs(lateral)) - SIDEWAYS;
    };
    let poly = p.map((q) => ({ u: q.u, v: q.v, lo: q.y - below(q), hi: above(q) - q.y, side: turn(q) }));
    if (poly.every((q) => q.side < 0)) continue;
    poly = clip(poly, 'side');
    poly = clip(clip(poly, 'lo'), 'hi').map((q) => [q.u, q.v]);
    // A plane through a vertex or along an edge leaves a sliver with no area,
    // which a fill ignores and a stroke or a count would not.
    if (poly.length < 3 || polyArea(poly) < 1e-12) continue;
    if (poly.some(([u, v]) => u < 0 || u > 1 || v < 0 || v > 1)) offSheet++;
    polygons.push(poly);
  }

  const notes = [];
  if (unknown) notes.push(`${unknown} sideways face(s) of ${texture} have normals that do not say which way they look, and are left out of the band`);
  if (offSheet) notes.push(`${offSheet} piece(s) of the band lie on an island that straddles the sheet's edge, and are drawn where the sheet ends`);
  return { polygons, frame, notes };
}

/**
 * `bandPolygons`, remembered per model. The editor renders on every frame of
 * a drag, and a band is tens of milliseconds of clipping that gives the same
 * answer until the model or the band changes.
 */
const remembered = new WeakMap();
export function bandFor(model, { texture, axes }, band) {
  let mine = remembered.get(model);
  if (!mine) remembered.set(model, mine = new Map());
  const key = JSON.stringify([texture, axes?.left, axes?.front, band.height, band.rear, band.side]);
  if (!mine.has(key)) mine.set(key, bandPolygons(model, { texture, axes }, band));
  return mine.get(key);
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
      out.push({ u: mix('u'), v: mix('v'), lo: mix('lo'), hi: mix('hi'), side: mix('side') });
    }
  }
  return out;
}
