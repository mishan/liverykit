// ---------------------------------------------------------------------------
// UV islands.
//
// A mesh is the wrong unit of work. On a typical car one mesh carries the
// entire body and spans the whole texture, so "per-mesh UV bounds" tells you
// nothing you didn't already know. The useful unit is the UV ISLAND: a set of
// triangles connected in texture space, which is what an unwrapper produces and
// what a livery actually has to respect.
//
// Islands are found by union-find over shared vertex indices. Two triangles
// that share an index share a UV position, so they belong to the same island;
// a seam in the unwrap duplicates the vertex and breaks the connection. That is
// exactly the boundary artwork must not cross.
//
// Three things fall out that no amount of photographing a car can give you:
//
//   * exact panel rectangles, rather than rectangles read off a render
//   * true anisotropy per island, from the UV->3D Jacobian
//   * a 3D ADJACENCY GRAPH — which islands physically touch on the car even
//     though they sit far apart in the texture. This is what lets a stripe
//     continue from a sidepod onto the intake behind it, and it is invisible
//     from the texture alone.
// ---------------------------------------------------------------------------

import { vertex, triangles } from './kn5.mjs';

/**
 * Decompose the given meshes into UV islands.
 * `minVertices` drops slivers — bolt heads and tiny trim pieces that would
 * otherwise bury the panels worth naming.
 */
export function findIslands(model, meshes, { minVertices = 24 } = {}) {
  const islands = [];

  for (const mesh of meshes) {
    const parent = new Int32Array(mesh.vertexCount);
    for (let i = 0; i < mesh.vertexCount; i++) parent[i] = i;
    const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };

    const tris = triangles(model, mesh);
    for (const [a, b, c] of tris) { union(a, b); union(b, c); }

    // Group vertices, and group triangles by their island root.
    const members = new Map();
    for (let i = 0; i < mesh.vertexCount; i++) {
      const r = find(i);
      if (!members.has(r)) members.set(r, []);
      members.get(r).push(i);
    }
    const trisByRoot = new Map();
    for (const t of tris) {
      const r = find(t[0]);
      if (!trisByRoot.has(r)) trisByRoot.set(r, []);
      trisByRoot.get(r).push(t);
    }

    for (const [root, verts] of members) {
      if (verts.length < minVertices) continue;
      const isl = measure(model, mesh, verts, trisByRoot.get(root) ?? []);
      // An island collapsed to a line or a point in UV space has no area to
      // paint. Street cars produce a lot of these — trim strips and badges
      // pinned to a single texel — and they otherwise flood the profile with
      // panels whose rect is [0, 0, 0, 1].
      if (isl.rect[2] < 1e-5 || isl.rect[3] < 1e-5) continue;
      islands.push(isl);
    }
  }

  return islands.sort((a, b) => b.uvArea - a.uvArea);
}

function measure(model, mesh, verts, tris) {
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  let cx = 0, cy = 0, cz = 0;

  for (const i of verts) {
    const p = vertex(model, mesh, i);
    if (p.u < u0) u0 = p.u; if (p.u > u1) u1 = p.u;
    if (p.v < v0) v0 = p.v; if (p.v > v1) v1 = p.v;
    if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y;
    if (p.z < z0) z0 = p.z; if (p.z > z1) z1 = p.z;
    cx += p.x; cy += p.y; cz += p.z;
  }
  const n = verts.length;

  // Anisotropy from the UV->3D Jacobian, area-weighted across triangles.
  //
  // For a triangle, dP/du and dP/dv are the tangent and bitangent; the ratio of
  // their lengths is how much wider than tall a square of texture lands on the
  // bodywork. That is the number artwork has to pre-compensate for, and
  // eyeballing it off a render is exactly as unreliable as it sounds.
  //
  // The SAME tangents answer a second question the project hit later: which way
  // is up in this panel. An unwrapper is free to rotate an island, and a road car
  // routinely lays a door sideways to pack the sheet. Text placed on it then
  // reads vertically, which looks exactly like a bug and is in fact the texture
  // being honest about its own layout.
  //
  // dP/dv is the direction "down the image" travels in 3D. On an upright panel
  // that is world-down; on a sideways one it runs along the car. Averaging it,
  // area-weighted, and comparing against the panel's own plane gives the
  // rotation artwork has to undo.
  let aniso = 0, wsum = 0, uvArea = 0, area3d = 0;
  let bx = 0, by = 0, bz = 0, nx = 0, ny = 0, nz = 0;
  for (const [a, b, c] of tris) {
    const p0 = vertex(model, mesh, a), p1 = vertex(model, mesh, b), p2 = vertex(model, mesh, c);
    const du1 = p1.u - p0.u, dv1 = p1.v - p0.v;
    const du2 = p2.u - p0.u, dv2 = p2.v - p0.v;
    const det = du1 * dv2 - du2 * dv1;
    uvArea += Math.abs(det) / 2;

    const e1 = [p1.x - p0.x, p1.y - p0.y, p1.z - p0.z];
    const e2 = [p2.x - p0.x, p2.y - p0.y, p2.z - p0.z];
    area3d += len(cross(e1, e2)) / 2;
    if (Math.abs(det) < 1e-12) continue;

    const r = 1 / det;
    const T = [ (e1[0] * dv2 - e2[0] * dv1) * r, (e1[1] * dv2 - e2[1] * dv1) * r, (e1[2] * dv2 - e2[2] * dv1) * r ];
    const B = [ (e2[0] * du1 - e1[0] * du2) * r, (e2[1] * du1 - e1[1] * du2) * r, (e2[2] * du1 - e1[2] * du2) * r ];
    const lt = len(T), lb = len(B);
    if (lb < 1e-9) continue;
    const w = Math.abs(det);
    aniso += (lt / lb) * w;
    wsum += w;

    // Area-weighted so a few stray triangles at a panel's edge cannot outvote
    // the flat middle of it.
    bx += (B[0] / lb) * w; by += (B[1] / lb) * w; bz += (B[2] / lb) * w;
    const fn = cross(e1, e2), fl = len(fn) || 1;
    nx += (fn[0] / fl) * w; ny += (fn[1] / fl) * w; nz += (fn[2] / fl) * w;
  }

  // UVs are not confined to 0..1. A tiling texture — rubber, carbon weave,
  // fabric — deliberately runs past the edge so it repeats, and the raw bounds
  // then describe a region larger than the image. Panel-relative coordinates
  // don't mean much on such a panel, so it is clamped and flagged rather than
  // silently emitting a rectangle that starts at -0.006.
  const tiled = u0 < -0.001 || v0 < -0.001 || u1 > 1.001 || v1 > 1.001;
  const cu0 = clamp01(u0), cv0 = clamp01(v0), cu1 = clamp01(u1), cv1 = clamp01(v1);

  const upright = textRotation([bx, by, bz], [nx, ny, nz]);

  return {
    mesh: mesh.name,
    textRotation: upright,
    vertices: verts,
    vertexCount: n,
    tiled,
    uvBounds: tiled ? [round(u0), round(v0), round(u1 - u0), round(v1 - v0)] : undefined,
    rect: [round(cu0), round(cv0), round(cu1 - cu0), round(cv1 - cv0)],
    uv: { u0, u1, v0, v1 },
    box3d: { x0, x1, y0, y1, z0, z1 },
    centroid: { x: cx / n, y: cy / n, z: cz / n },
    anisotropy: wsum ? aniso / wsum : 1,
    uvArea,
    area3d,
    meshRef: mesh,
  };
}

/**
 * How far this island is rotated away from upright, in degrees, snapped to 90.
 *
 * `down` is dP/dv — the direction moving down the image travels across the car.
 * `normal` is the island's average face normal. Projecting world-up onto the
 * island's own plane gives its idea of up; the angle between that and `down`
 * is the rotation an unwrapper applied, and therefore the rotation artwork has
 * to undo to read level.
 *
 * Returns 0 for a panel that is already upright, and null when the answer is
 * meaningless — a horizontal panel like a roof or bonnet, where "up" projected
 * onto the surface is a vanishing vector and any rotation is as good as any
 * other. Null is the honest answer there, and callers should leave such a panel
 * alone rather than rotate it by a number derived from rounding error.
 */
function textRotation(down, normal) {
  const nl = len(normal);
  if (nl < 1e-9) return null;
  const n = [normal[0] / nl, normal[1] / nl, normal[2] / nl];

  // World up projected onto the island's plane. On a near-horizontal surface
  // this collapses, which is exactly when the question has no answer.
  const dot = n[1];
  const up = [-n[0] * dot, 1 - n[1] * dot, -n[2] * dot];
  const ul = len(up);
  if (ul < 0.25) return null;
  const u = [up[0] / ul, up[1] / ul, up[2] / ul];

  const dl = len(down);
  if (dl < 1e-9) return null;
  const d = [down[0] / dl, down[1] / dl, down[2] / dl];

  // Right-handed in-plane basis, so the angle has a consistent sign.
  const right = cross(u, n);
  const angle = Math.atan2(dot2(d, right), -dot2(d, u)) * 180 / Math.PI;
  return ((Math.round(angle / 90) * 90) % 360 + 360) % 360;
}

const dot2 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const round = (n) => Math.round(n * 10000) / 10000;
const clamp01 = (n) => Math.min(1, Math.max(0, n));

/**
 * The car's own extent, sampled from every mesh in the model.
 *
 * Needed because names like `nose` and `tail` are claims about a position on the
 * CAR, and the only way to make such a claim is to measure the car. Sampled with
 * a stride: bounds converge almost immediately, and a full pass over a few
 * hundred thousand vertices to move a bound by a millimetre is not worth it.
 */
export function carBounds(model) {
  let xMax = 0, zMin = Infinity, zMax = -Infinity;
  for (const mesh of model.meshes ?? []) {
    const step = Math.max(1, Math.floor(mesh.vertexCount / 400));
    for (let i = 0; i < mesh.vertexCount; i += step) {
      const v = vertex(model, mesh, i);
      xMax = Math.max(xMax, Math.abs(v.x));
      zMin = Math.min(zMin, v.z); zMax = Math.max(zMax, v.z);
    }
  }
  if (!Number.isFinite(zMin) || !Number.isFinite(zMax)) return null;
  return { zMin, zMax, halfWidth: xMax || 1 };
}

/**
 * Systematic geometric names: side_section_level.
 *
 * Deliberately NOT semantic. Calling something "sidepod" requires knowing what
 * kind of car this is; calling it `left_mid_lower` is true of any car and means
 * the same thing on all of them, which is what makes a livery portable. Rename
 * to taste in the profile — the geometry is the measurement, the name is a
 * convenience.
 *
 * `bounds` is the CAR's extent and matters far more than it looks. This
 * originally normalised each island's position against the extent of the other
 * islands ON THE SAME TEXTURE, which is only the car's extent when that texture
 * happens to cover the whole car. For anything smaller the five bands collapse
 * onto whatever that one sheet spans, and the frontmost thing on it is called
 * `nose` no matter where on the car it actually sits. A tyre sheet holds four
 * wheels, so the front pair were `*_nose` and the rear pair `*_tail`; a steering
 * wheel 30 cm across got a nose, a middle and a tail of its own. Measured over
 * two profiles, every single name on `interior`, `belts` and `steeringWheel` was
 * wrong in this way, and 239 of 416 panels on one car.
 *
 * Omitting `bounds` falls back to the islands' own extent, which is correct only
 * when the islands are the whole car. Callers that have a model should pass
 * `carBounds(model)`.
 */
export function nameIslands(islands, axes, bounds = null) {
  const xs = islands.map((i) => i.centroid.x);
  const zs = islands.map((i) => i.centroid.z);
  const zMin = bounds ? bounds.zMin : Math.min(...zs);
  const zMax = bounds ? bounds.zMax : Math.max(...zs);
  const halfWidth = (bounds ? bounds.halfWidth : Math.max(...xs.map(Math.abs))) || 1;

  const counts = new Map();
  for (const isl of islands) {
    const xr = (isl.centroid.x * axes.left) / halfWidth;     // +1 = car's left
    const side = Math.abs(xr) < 0.18 ? 'centre' : xr > 0 ? 'left' : 'right';

    // Longitudinal position as a 0..1 fraction from tail to nose.
    let zr = (isl.centroid.z - zMin) / (zMax - zMin || 1);
    if (axes.front < 0) zr = 1 - zr;
    const section = zr > 0.82 ? 'nose' : zr > 0.62 ? 'front' : zr > 0.38 ? 'mid' : zr > 0.18 ? 'rear' : 'tail';

    const level = isl.centroid.y > (isl.box3d.y0 + isl.box3d.y1) / 2 ? 'upper' : 'lower';

    let base = `${side}_${section}`;
    // Only disambiguate by height when something else already claimed the name.
    if (counts.has(base)) base = `${side}_${section}_${level}`;
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    isl.name = seen === 0 ? base : `${base}_${seen + 1}`;
  }
  return islands;
}

/**
 * Pair islands that are mirror images across the car's centreline.
 *
 * Useful because a mirrored pair almost always wants the same artwork, and
 * because a pair that is NOT mirrored in UV space (the common case) means the
 * two sides have independent texture area and can differ.
 */
export function findMirrorPairs(islands, axes, { tolerance = 0.06 } = {}) {
  const pairs = [];
  const used = new Set();
  for (const a of islands) {
    if (used.has(a.name) || Math.abs(a.centroid.x) < 0.05) continue;
    let best = null, bestD = Infinity;
    for (const b of islands) {
      if (b === a || used.has(b.name)) continue;
      if (Math.sign(b.centroid.x) === Math.sign(a.centroid.x)) continue;
      const d = Math.hypot(
        a.centroid.x + b.centroid.x,          // mirrored: x should cancel
        a.centroid.y - b.centroid.y,
        a.centroid.z - b.centroid.z
      );
      const sizeDiff = Math.abs(a.uvArea - b.uvArea) / Math.max(a.uvArea, b.uvArea);
      if (d < bestD && d < tolerance * 4 && sizeDiff < 0.25) { best = b; bestD = d; }
    }
    if (best) {
      used.add(a.name); used.add(best.name);
      a.mirrorOf = best.name; best.mirrorOf = a.name;
      pairs.push([a.name, best.name]);
    }
  }
  return pairs;
}

/**
 * Which islands physically touch on the car, regardless of where they sit in
 * the texture.
 *
 * This is the part that cannot be recovered from a screenshot or a flat
 * template. An unwrapper is free to place two adjacent panels at opposite
 * corners of the texture; to a livery they look unrelated, but on the car a
 * stripe crossing from one to the other has to line up. Knowing the graph is
 * what makes that possible.
 *
 * Implemented with a spatial hash at `tolerance` metres — vertices on a shared
 * seam are usually bit-identical, so the tolerance is generous by default.
 */
export function findAdjacency(model, islands, { tolerance = 0.004 } = {}) {
  const cell = tolerance;
  const grid = new Map();
  const key = (x, y, z) => `${Math.round(x / cell)},${Math.round(y / cell)},${Math.round(z / cell)}`;

  islands.forEach((isl, idx) => {
    for (const i of isl.vertices) {
      const p = vertex(model, isl.meshRef, i);
      // Insert into the 27 neighbouring cells so near-misses still meet.
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const k = key(p.x + dx * cell, p.y + dy * cell, p.z + dz * cell);
        let s = grid.get(k);
        if (!s) grid.set(k, (s = new Set()));
        s.add(idx);
      }
    }
  });

  const counts = new Map();
  for (const s of grid.values()) {
    if (s.size < 2) continue;
    const arr = [...s];
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const k = `${arr[i]}:${arr[j]}`;
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    }
  }

  const adjacency = new Map(islands.map((i) => [i.name, new Set()]));
  for (const [k, n] of counts) {
    if (n < 3) continue;                    // a single coincident point is noise
    const [i, j] = k.split(':').map(Number);
    adjacency.get(islands[i].name).add(islands[j].name);
    adjacency.get(islands[j].name).add(islands[i].name);
  }
  return adjacency;
}
