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
      islands.push(measure(model, mesh, verts, trisByRoot.get(root) ?? []));
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
  let aniso = 0, wsum = 0, uvArea = 0, area3d = 0;
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
  }

  return {
    mesh: mesh.name,
    vertices: verts,
    vertexCount: n,
    rect: [round(u0), round(v0), round(u1 - u0), round(v1 - v0)],
    uv: { u0, u1, v0, v1 },
    box3d: { x0, x1, y0, y1, z0, z1 },
    centroid: { x: cx / n, y: cy / n, z: cz / n },
    anisotropy: wsum ? aniso / wsum : 1,
    uvArea,
    area3d,
    meshRef: mesh,
  };
}

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const round = (n) => Math.round(n * 10000) / 10000;

/**
 * Systematic geometric names: side_section_level.
 *
 * Deliberately NOT semantic. Calling something "sidepod" requires knowing what
 * kind of car this is; calling it `left_mid_lower` is true of any car and means
 * the same thing on all of them, which is what makes a livery portable. Rename
 * to taste in the profile — the geometry is the measurement, the name is a
 * convenience.
 */
export function nameIslands(islands, axes) {
  const xs = islands.map((i) => i.centroid.x);
  const zs = islands.map((i) => i.centroid.z);
  const zMin = Math.min(...zs), zMax = Math.max(...zs);
  const halfWidth = Math.max(...xs.map(Math.abs)) || 1;

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
