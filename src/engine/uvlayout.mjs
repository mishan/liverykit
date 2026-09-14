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
// The question is asked of each ISLAND, not of the sheet: how much of the
// texture's surface lies on islands no wider or taller than one sheet. An
// island that spans more than a sheet repeats the image across itself; one that
// fits maps it once, wherever it sits. Textures are sampled with wrap
// addressing, so where it sits does not matter, and exporters move sheets
// freely: whole copies down (the Avensis's body at v = -1, a 180SX's at -60) or
// part of one across a boundary.
//
// Two measures came before this one, and each was wrong on real bodies. "Inside
// [0, 1]" called 316 whole-copy shifts tiled. "On the one copy of the sheet
// holding most of it" fixed those and called the S14 Zenki's livery tiled
// instead — an ordinary unwrap straddling a sheet boundary, 41% of it on any
// one copy and all of it on islands that fit — so step 1 refused placement on
// the real livery of that car, and the classifier briefly refused it as a body.
//
// Measured per TEXTURE, over its triangles, before any island is filtered out,
// because on the cars that prompted this the islands mostly did not survive the
// panel filter.
// ---------------------------------------------------------------------------

import { triangles, vertex, SHEET_SPAN } from './kn5.mjs';

/**
 * Where the labels change, as the share of surface on islands that fit.
 *
 * Measured on the 4,026 textures in the fleet that carry at least 0.8% of their
 * car's geometry, the share is sharply bimodal: 3,455 at 0.9 or above, 468
 * below 0.5, and the quietest band between them 0.4 to 0.5, with 19. So
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
 * `inside` is the fraction of the meshes' SURFACE AREA on islands no wider or
 * taller than SHEET_SPAN (see kn5.mjs). Area rather than triangle count, because a livery
 * covers square metres. `tile` is the whole-number copy of the sheet holding
 * most of the surface, as the model stores it — `[0, 0]` for an unwrap where it
 * belongs — which is what a profile's `uvTile` records.
 */
export function uvLayout(model, meshes) {
  let area = 0;
  let onOneSheet = 0;
  const byTile = new Map();
  for (const mesh of meshes) {
    // On the UVs as the MODEL stores them. `vertex()` hands back each island on
    // the copy of the sheet in [0, 1] (see placeOnSheet in kn5.mjs), and `tile`
    // is here to say where the model itself put the sheet, so the shift is
    // taken back out. An island's span is the same either way.
    const s = mesh.uvShift;
    const stored = (i) => {
      const p = vertex(model, mesh, i);
      return s ? { ...p, u: p.u - s[2 * i], v: p.v - s[2 * i + 1] } : p;
    };

    // Islands as findIslands and placeOnSheet mean them: triangles joined
    // through shared vertex indices within one mesh.
    const n = mesh.vertexCount;
    const parent = new Int32Array(n);
    for (let i = 0; i < n; i++) parent[i] = i;
    const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };
    const tris = triangles(model, mesh);
    for (const [a, b, c] of tris) { union(a, b); union(b, c); }

    const box = new Map();
    const weight = new Map();
    for (const [a, b, c] of tris) {
      const p = [stored(a), stored(b), stored(c)];
      const e1 = [p[1].x - p[0].x, p[1].y - p[0].y, p[1].z - p[0].z];
      const e2 = [p[2].x - p[0].x, p[2].y - p[0].y, p[2].z - p[0].z];
      const w = Math.hypot(
        e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]) / 2;
      if (!w) continue;
      area += w;
      const key = `${Math.floor((p[0].u + p[1].u + p[2].u) / 3)},${Math.floor((p[0].v + p[1].v + p[2].v) / 3)}`;
      byTile.set(key, (byTile.get(key) ?? 0) + w);

      const r = find(a);
      weight.set(r, (weight.get(r) ?? 0) + w);
      const bx = box.get(r) ?? [Infinity, Infinity, -Infinity, -Infinity];
      for (const q of p) {
        if (q.u < bx[0]) bx[0] = q.u; if (q.v < bx[1]) bx[1] = q.v;
        if (q.u > bx[2]) bx[2] = q.u; if (q.v > bx[3]) bx[3] = q.v;
      }
      box.set(r, bx);
    }
    for (const [r, [u0, v0, u1, v1]] of box) {
      if (u1 - u0 <= SHEET_SPAN && v1 - v0 <= SHEET_SPAN) onOneSheet += weight.get(r) ?? 0;
    }
  }
  if (!area) return null;

  const [tu, tv] = [...byTile].sort((x, y) => y[1] - x[1])[0][0].split(',').map(Number);
  const share = onOneSheet / area;
  return {
    layout: share >= UNWRAPPED_AT ? 'unwrapped' : share < TILED_BELOW ? 'tiled' : 'mixed',
    inside: Math.round(share * 1000) / 1000,
    tile: [tu, tv],
  };
}
