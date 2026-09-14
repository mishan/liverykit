// ---------------------------------------------------------------------------
// Is this texture an unwrapped sheet, or a material that tiles?
//
// A livery is placed on a sheet: "this panel, this rectangle". That only means
// something when the UVs map the surface onto the image once. A seamless
// material — carbon weave, fabric, a flat black swatch — repeats the image
// across the surface instead, so a rectangle on the sheet lands everywhere the
// tile does, and a design placed on it looks like it worked and put the artwork
// somewhere nobody chose.
//
// "Inside [0, 1]" is the obvious test and the wrong one. Textures are sampled
// with wrap addressing, so an unwrap shifted by a whole sheet renders exactly
// like one that is not, and exporters shift them freely: across the 254-car
// fleet, 316 textures carrying real geometry are a perfectly ordinary unwrap
// sitting at v = -1, or -18, or -59. Measured against [0, 1] they read as tiled;
// measured against the one copy of the sheet that holds most of their surface,
// they are whole. That is the question asked here: how much of the surface lies
// on a single copy of the sheet.
//
// Measured per TEXTURE, over its triangles, before any island is found. The
// per-island `tiled` flag findIslands sets is no substitute: it trips on any
// overhang past 0.001, and on the shipped profiles a quarter of the panels
// carrying it overhang by less than 0.01, which is rounding on a perfectly
// ordinary unwrap.
// ---------------------------------------------------------------------------

import { triangles, vertex } from './kn5.mjs';

/** How far past a sheet's edge a vertex may sit and still count as on it. */
const EDGE = 0.01;

/**
 * Where the labels change, as a share of surface on one copy of the sheet.
 *
 * Measured on the 4,026 textures in the fleet that carry at least 0.8% of their
 * car's geometry, the share is sharply bimodal: 3,271 at 0.9 or above, 523
 * below 0.5, and the quietest band between them 0.4 to 0.5, with 26. So
 * `tiled` starts at that valley. The line between `mixed` and `unwrapped` has
 * no valley to sit in; it only labels, since placement is refused on `tiled`
 * alone and a mixed sheet still has parts mapped once.
 */
export const UNWRAPPED_AT = 0.9;
export const TILED_BELOW = 0.5;

/**
 * How a texture's meshes use it: `{ layout, inside, tile }`, or null for meshes
 * with no area.
 *
 * `inside` is the fraction of the meshes' SURFACE AREA whose triangles lie
 * wholly on the copy of the sheet holding the most of it, and `tile` is that
 * copy's integer offset — `[0, 0]` for an unwrap where it belongs. Area rather
 * than triangle count, because a livery covers square metres.
 */
export function uvLayout(model, meshes) {
  const tris = [];
  let area = 0;
  const byTile = new Map();
  for (const mesh of meshes) {
    // On the UVs as the MODEL stores them. `vertex()` hands back each island on
    // the copy of the sheet in [0, 1] (see placeOnSheet in kn5.mjs), and `tile`
    // is here to say where the model itself put the sheet, so the shift is
    // taken back out.
    const s = mesh.uvShift;
    const stored = (i) => {
      const p = vertex(model, mesh, i);
      return s ? { ...p, u: p.u - s[2 * i], v: p.v - s[2 * i + 1] } : p;
    };
    for (const [a, b, c] of triangles(model, mesh)) {
      const p = [stored(a), stored(b), stored(c)];
      const e1 = [p[1].x - p[0].x, p[1].y - p[0].y, p[1].z - p[0].z];
      const e2 = [p[2].x - p[0].x, p[2].y - p[0].y, p[2].z - p[0].z];
      const w = Math.hypot(
        e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]) / 2;
      if (!w) continue;
      area += w;
      tris.push([w, p]);
      const key = `${Math.floor((p[0].u + p[1].u + p[2].u) / 3)},${Math.floor((p[0].v + p[1].v + p[2].v) / 3)}`;
      byTile.set(key, (byTile.get(key) ?? 0) + w);
    }
  }
  if (!area) return null;

  const [tu, tv] = [...byTile].sort((x, y) => y[1] - x[1])[0][0].split(',').map(Number);
  const on = (q) => q.u >= tu - EDGE && q.u <= tu + 1 + EDGE && q.v >= tv - EDGE && q.v <= tv + 1 + EDGE;
  let inside = 0;
  for (const [w, p] of tris) if (p.every(on)) inside += w;

  const share = inside / area;
  return {
    layout: share >= UNWRAPPED_AT ? 'unwrapped' : share < TILED_BELOW ? 'tiled' : 'mixed',
    inside: Math.round(share * 1000) / 1000,
    tile: [tu, tv],
  };
}
