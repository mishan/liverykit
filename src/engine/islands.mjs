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
import { polyArea } from './poly.mjs';

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
  // The tangents' LENGTHS, kept as well as their ratio.
  //
  // `anisotropy` says a panel is 3.9 times wider than it is tall in UV terms,
  // which is what the renderer needs to un-stretch a glyph. It cannot answer the
  // question a person actually asks about a placement — "how big will that be on
  // the car" — because a ratio has no size in it. Both panels of a 1:1 wheel hub
  // and a 1:1 bonnet report 1.
  //
  // The magnitudes are right here, computed for the ratio and then thrown away,
  // so keeping them costs two additions and closes that. Assetto Corsa models
  // are in metres — confirmed independently by the wheel-derived track width and
  // wheelbase matching a spec sheet, which the README already points at as the
  // two numbers in a profile you can check — so these are metres per unit of UV.
  let sumT = 0, sumB = 0;
  let bx = 0, by = 0, bz = 0, nx = 0, ny = 0, nz = 0;
  // The tangent's DIRECTION, not just its length. The length alone gives
  // anisotropy; the direction says which way along the car "rightwards on the
  // sheet" actually points, and that is the only thing that can tell you
  // whether a mirrored pair of panels was unwrapped the same way round.
  let tx = 0, ty = 0, tz = 0;
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
    sumT += lt * w;
    sumB += lb * w;
    wsum += w;

    // Area-weighted so a few stray triangles at a panel's edge cannot outvote
    // the flat middle of it.
    bx += (B[0] / lb) * w; by += (B[1] / lb) * w; bz += (B[2] / lb) * w;
    if (lt > 1e-9) { tx += (T[0] / lt) * w; ty += (T[1] / lt) * w; tz += (T[2] / lt) * w; }
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

  // Unit world directions for +u and +v on this island, rounded because three
  // decimals is far more than a sign comparison needs and a profile is read by
  // people.
  const unit = (v) => { const l = Math.hypot(...v); return l < 1e-9 ? null : v.map((n) => Math.round((n / l) * 1000) / 1000); };

  // Whether (u, v, outward) is a right-handed frame on this island. "Outward"
  // is the VERTEX normal, not the winding: normals exist to light the surface
  // and are therefore right, whereas winding is whatever the exporter did —
  // the test fixture winds two of its six faces inward, and a mod car may
  // well do the same. Two touching islands with opposite handedness were
  // unwrapped as mirror images of each other, and artwork continued from one
  // to the other has to be flipped. Kept on the island for findSeams; not
  // written to the profile, where the seam map already carries the answer.
  let vnx = 0, vny = 0, vnz = 0;
  for (const i of verts) { const p = vertex(model, mesh, i); vnx += p.nx; vny += p.ny; vnz += p.nz; }
  const uvu = unit([tx, ty, tz]), uvv = unit([bx, by, bz]);
  const handed = uvu && uvv
    ? Math.sign(dot2(cross(uvu, uvv), [vnx, vny, vnz])) || 1
    : 1;

  return {
    mesh: mesh.name,
    uAxis: uvu,
    vAxis: uvv,
    handed,
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
    // NOT redundant with `anisotropy`, though it looks it. That is the
    // area-weighted mean of each triangle's RATIO; this is the ratio of the two
    // area-weighted means, and on a curved panel they differ — a mean of
    // quotients is not the quotient of means. Both are honest answers to
    // different questions, so both are kept rather than one being derived from
    // the other and quietly disagreeing with the renderer.
    metresPerUv: wsum ? [sumT / wsum, sumB / wsum] : null,
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

/**
 * How to continue artwork from one island onto a neighbour: an affine map
 * from this island's texture coordinates to the neighbour's, for every pair
 * `findAdjacency` says touch.
 *
 * `adjacent` says the door and the rear quarter meet. It cannot say WHERE in
 * each sheet the meeting edge is, or which way round — the unwrapper was free
 * to put the quarter anywhere and rotate it — and that is exactly what a
 * stripe crossing from one to the other has to know. The answer is in the
 * geometry already: the two islands share vertices along the seam, and a
 * shared vertex is one point on the car with two sets of texture coordinates.
 *
 * Fitted in METRES, not texture fractions. Each island's `metresPerUv` turns
 * its sheet into a scale drawing of itself; between two scale drawings that
 * meet along an edge the relationship is rigid — a rotation and a shift, and
 * possibly a reflection where the unwrapper flipped one — so that is all
 * that is fitted. A general affine would have been tempting and wrong: a
 * seam is a line, and a line of points cannot pin down what happens away
 * from the line. Rigid is what "unfold the neighbour flat against this
 * panel" means, and it is determined by two points.
 *
 * The one thing a line genuinely cannot tell is which SIDE the neighbour
 * lies on: a rotation and a reflection across the seam fit collinear points
 * equally well. The islands' own interiors settle it — the neighbour's
 * middle must land on the far side of the seam from this island's middle,
 * or the map folds the neighbour back over this panel.
 *
 * Returns Map<name, Map<neighbour, { matrix, points, rmsMm }>>, where
 * `matrix` is [a, b, c, d, e, f] in SVG order: u' = a u + c v + e,
 * v' = b u + d v + f, from this island's fractions to the neighbour's.
 * `rmsMm` is how far the shared vertices miss under the fitted map — near
 * zero for a crease, larger where the seam curves and "unfold flat" is an
 * approximation worth knowing about.
 */
export function findSeams(model, islands, adjacency, { tolerance = 0.004 } = {}) {
  const byName = new Map(islands.map((i) => [i.name, i]));
  const cell = tolerance;
  const key = (x, y, z) => `${Math.round(x / cell)},${Math.round(y / cell)},${Math.round(z / cell)}`;

  // Every vertex, bucketed by position, so shared ones meet in a cell.
  const grid = new Map();
  const all = [];
  islands.forEach((isl) => {
    for (const i of isl.vertices) {
      const p = vertex(model, isl.meshRef, i);
      const pt = { isl, u: p.u, v: p.v, x: p.x, y: p.y, z: p.z };
      const k = key(p.x, p.y, p.z);
      let s = grid.get(k);
      if (!s) grid.set(k, (s = []));
      s.push(pt);
      all.push(pt);
    }
  });

  // Correspondences per ordered pair, deduplicated per position: a seam
  // vertex is usually present in both meshes several times over (per
  // triangle fan), and counting it five times would weight the fit oddly.
  //
  // Each point is compared against the 27 cells around it, not only its own.
  // The cell is the tolerance, so two points 3 mm apart — well inside the 4 mm
  // this is willing to call the same vertex — land in different cells whenever
  // the boundary happens to run between them, and a bucket-only comparison
  // found no correspondence at all for them. `findAdjacency` probes neighbours
  // for exactly this reason and would call such a pair adjacent, which left
  // the two disagreeing: islands that touch, with no map to cross between
  // them, and a spanning region that stopped at the seam for no visible cause.
  // The distance test below is what actually decides; the cells only narrow
  // the field.
  const pairs = new Map();          // "a|b" -> [{ a: [u,v], b: [u,v] }]
  const near = (p) => {
    const out = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const bucket = grid.get(key(p.x + dx * cell, p.y + dy * cell, p.z + dz * cell));
      if (bucket) out.push(bucket);
    }
    return out;
  };
  for (const p of all) {
    for (const bucket of near(p)) {
      for (const q of bucket) {
        if (p.isl === q.isl) continue;
        if (!adjacency.get(p.isl.name)?.has(q.isl.name)) continue;
        if (Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z) > tolerance) continue;
        const k = `${p.isl.name}|${q.isl.name}`;
        let list = pairs.get(k);
        if (!list) pairs.set(k, (list = []));
        if (!list.some((c) => Math.abs(c.a[0] - p.u) < 1e-6 && Math.abs(c.a[1] - p.v) < 1e-6)) {
          list.push({ a: [p.u, p.v], b: [q.u, q.v] });
        }
      }
    }
  }

  const seams = new Map(islands.map((i) => [i.name, new Map()]));
  for (const [k, list] of pairs) {
    if (list.length < 2) continue;                     // one point fixes nothing
    const [an, bn] = k.split('|');
    const A = byName.get(an), B = byName.get(bn);
    if (!A.metresPerUv || !B.metresPerUv) continue;    // no scale, no metres
    const fit = rigidSeam(A, B, list, model);
    if (fit) seams.get(an).set(bn, fit);
  }
  return seams;
}

/** Mean texture coordinate of an island, the point its 3D centroid stands for. */
function centroidUv(model, isl) {
  let u = 0, v = 0;
  for (const i of isl.vertices) { const p = vertex(model, isl.meshRef, i); u += p.u; v += p.v; }
  return [u / isl.vertices.length, v / isl.vertices.length];
}

function rigidSeam(A, B, list, model) {
  const [mua, mva] = A.metresPerUv, [mub, mvb] = B.metresPerUv;
  const am = list.map(({ a }) => [a[0] * mua, a[1] * mva]);
  const bm = list.map(({ b }) => [b[0] * mub, b[1] * mvb]);
  const mean = (ps) => ps.reduce((s, p) => [s[0] + p[0], s[1] + p[1]], [0, 0]).map((n) => n / ps.length);
  const ca = mean(am), cb = mean(bm);

  // Rotation about the centroids that best sends a onto b, with and without
  // a reflection of a first. Closed form in 2D: the angle of the summed
  // cross and dot products.
  const solve = (flip) => {
    let cross = 0, dot = 0;
    for (let i = 0; i < am.length; i++) {
      const ax = (am[i][0] - ca[0]) * (flip ? -1 : 1), ay = am[i][1] - ca[1];
      const bx = bm[i][0] - cb[0], by = bm[i][1] - cb[1];
      cross += ax * by - ay * bx;
      dot += ax * bx + ay * by;
    }
    const th = Math.atan2(cross, dot);
    const cs = Math.cos(th), sn = Math.sin(th);
    // metres_B = R * F * (metres_A - ca) + cb, F = diag(flip ? -1 : 1, 1)
    const fx = flip ? -1 : 1;
    const map = ([x, y]) => {
      const dx = (x - ca[0]) * fx, dy = y - ca[1];
      return [cs * dx - sn * dy + cb[0], sn * dx + cs * dy + cb[1]];
    };
    let err = 0;
    for (let i = 0; i < am.length; i++) {
      const m = map(am[i]);
      err += (m[0] - bm[i][0]) ** 2 + (m[1] - bm[i][1]) ** 2;
    }
    return { flip, cs, sn, fx, map, rms: Math.sqrt(err / am.length) };
  };
  const plain = solve(false), mirrored = solve(true);

  // Reflection or not is decided by the geometry, not by the residuals. A
  // seam is a line, and a line of points fits a rotation and a reflection
  // across itself equally well — so the residuals tie, or differ by noise,
  // and on a four-point seam the noise picked a reflection between the NSX's
  // rear quarter and its intake surround that the door's seams to both of
  // them flatly contradicted. The islands' own handedness settles it: two
  // frames wound the same way continue without a flip, whatever the fit
  // says. The residuals stay as a measurement of how flat the seam is.
  let best;
  if (A.handed !== undefined && B.handed !== undefined) {
    best = A.handed === B.handed ? plain : mirrored;
  } else if (Math.abs(plain.rms - mirrored.rms) > 1e-6) {
    best = plain.rms < mirrored.rms ? plain : mirrored;
  } else {
    const cua = centroidUv(model, A), cub = centroidUv(model, B);
    const midA = [cua[0] * mua, cua[1] * mva];
    const midB = [cub[0] * mub, cub[1] * mvb];
    // The seam's direction in B's frame: the spread of the shared points.
    let sxx = 0, sxy = 0, syy = 0;
    for (const p of bm) { const dx = p[0] - cb[0], dy = p[1] - cb[1]; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const dir = [Math.cos(ang), Math.sin(ang)];
    const side = (p) => Math.sign(dir[0] * (p[1] - cb[1]) - dir[1] * (p[0] - cb[0]));
    const want = -side(midB);
    best = side(plain.map(midA)) === want ? plain : mirrored;
  }

  // Compose into fractions -> fractions: uv_B = (R F (S_A uv_A - ca) + cb) / S_B.
  const a = (best.cs * best.fx * mua) / mub;
  const b = (best.sn * best.fx * mua) / mvb;
  const c = (-best.sn * mva) / mub;
  const d = (best.cs * mva) / mvb;
  const e = (-(best.cs * best.fx * ca[0]) + best.sn * ca[1] + cb[0]) / mub;
  const f = (-(best.sn * best.fx * ca[0]) - best.cs * ca[1] + cb[1]) / mvb;
  // Where the seam sits in THIS island's sheet, as a polyline through the
  // shared points. A spanning region reaches the neighbour only if it
  // crosses this, which is what stops a band on the door reaching the
  // bonnet through a seam it never touches. A polyline and not a box: the
  // front clip meets the roof along the windscreen base and down both
  // A-pillars, an L whose box is mostly sheet the seam is nowhere near,
  // and a band at the foot of one pillar "crossed" the whole of it.
  const r4 = (n) => Math.round(n * 1e4) / 1e4;
  const r5 = (n) => Math.round(n * 1e5) / 1e5;
  return {
    matrix: [a, b, c, d, e, f].map(r5),
    here: seamLine(list.map(({ a: uv }) => uv)).map(([u, v]) => [r4(u), r4(v)]),
    points: list.length,
    rmsMm: Math.round(best.rms * 1000 * 10) / 10,
  };
}

/**
 * Shared points, chained into a line and simplified. Nearest-neighbour from
 * the point farthest from the middle, which follows a straight seam and an
 * L alike; a seam that forks would come out as one branch, which is a limit
 * worth knowing and not one any car has shown yet.
 */
function seamLine(pts) {
  if (pts.length < 2) return pts;
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  let start = 0, far = -1;
  pts.forEach((p, i) => { const d = Math.hypot(p[0] - cx, p[1] - cy); if (d > far) { far = d; start = i; } });
  const left = new Set(pts.map((_, i) => i));
  const chain = [];
  let at = start;
  while (left.size) {
    left.delete(at);
    chain.push(pts[at]);
    let nextI = -1, nd = Infinity;
    for (const i of left) {
      const d = Math.hypot(pts[i][0] - pts[at][0], pts[i][1] - pts[at][1]);
      if (d < nd) { nd = d; nextI = i; }
    }
    at = nextI;
  }
  return simplifyOpen(chain, 0.002);
}

/** Douglas-Peucker on an open line. */
function simplifyOpen(list, tol) {
  if (list.length < 3) return list;
  const a = list[0], b = list[list.length - 1];
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1e-12;
  let farI = 0, farD = 0;
  for (let i = 1; i < list.length - 1; i++) {
    const p = list[i];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
    const d = Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
    if (d > farD) { farD = d; farI = i; }
  }
  if (farD <= tol) return [a, b];
  const l = simplifyOpen(list.slice(0, farI + 1), tol), r = simplifyOpen(list.slice(farI), tol);
  return [...l.slice(0, -1), ...r];
}

/**
 * The outline of an island in its sheet: the boundary of its triangles, as
 * a polygon in texture fractions.
 *
 * A panel's `rect` is a bounding box, and islands are not boxes. Unwrappers
 * pack a small island into the concave corner of a big one, so two rects
 * overlap while the islands themselves do not share a texel. Artwork
 * clipped to the box then paints texels that belong to the neighbour — a
 * piece of the door's band, in the door's frame, sitting on the intake
 * surround. The outline is what the box was standing in for.
 *
 * Boundary edges are the ones used by exactly one triangle. They chain into
 * loops; the longest loop is the outer boundary and the others are holes,
 * which are left in (a hole is a window or a wheel arch, and nothing should
 * be painted there either — but a polygon with holes is a job for another
 * day, and painting a window cut-out costs nothing on the car).
 *
 * Simplified to `tolerance` in fractions so a 2000-vertex door becomes a
 * few dozen points; the profile is read by people as well as code.
 */
export function islandOutline(model, isl, { tolerance = 0.0015 } = {}) {
  const mesh = isl.meshRef;
  const inIsland = new Set(isl.vertices);
  const uv = new Map();
  const at = (i) => { if (!uv.has(i)) { const p = vertex(model, mesh, i); uv.set(i, [p.u, p.v]); } return uv.get(i); };
  // Edges keyed by UV position rather than index: an unwrap seam duplicates a
  // vertex, but within one island two triangles meeting along an edge may
  // still carry different indices for the same texel, and counting those as
  // two boundary edges would draw a crack through the middle of the panel.
  const key = (i) => { const [u, v] = at(i); return `${Math.round(u * 1e5)},${Math.round(v * 1e5)}`; };
  const edges = new Map();
  for (const [a, b, c] of triangles(model, mesh)) {
    if (!inIsland.has(a) || !inIsland.has(b) || !inIsland.has(c)) continue;
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const kp = key(p), kq = key(q);
      const k = kp < kq ? `${kp}|${kq}` : `${kq}|${kp}`;
      const e = edges.get(k);
      if (e) e.n++; else edges.set(k, { n: 1, p: at(p), q: at(q), kp, kq });
    }
  }
  // Chain boundary edges into loops.
  const next = new Map();
  for (const e of edges.values()) {
    if (e.n !== 1) continue;
    if (!next.has(e.kp)) next.set(e.kp, []);
    if (!next.has(e.kq)) next.set(e.kq, []);
    next.get(e.kp).push([e.kq, e.q]);
    next.get(e.kq).push([e.kp, e.p]);
  }
  const point = new Map();
  for (const e of edges.values()) { point.set(e.kp, e.p); point.set(e.kq, e.q); }
  const used = new Set();
  let best = [], bestArea = -1;
  for (const start of next.keys()) {
    if (used.has(start)) continue;
    const loop = [];
    let here = start;
    while (here && !used.has(here)) {
      used.add(here);
      loop.push(point.get(here));
      const out = (next.get(here) ?? []).find(([k]) => !used.has(k));
      here = out?.[0];
    }
    // By AREA, not by how many points it took to draw. The outer boundary is
    // the biggest loop in the sheet; it is not always the longest list. A door
    // is a handful of long straight edges around a densely tessellated window
    // cut-out, and the window won on vertex count — so the "outline" became
    // the hole, and artwork clipped to it was clipped to exactly the part of
    // the panel it must not touch, and to nothing else.
    const a = polyArea(loop);
    if (a > bestArea) { best = loop; bestArea = a; }
  }
  if (best.length < 3) return null;
  return simplify(best, tolerance).map(([u, v]) => [Math.round(u * 1e4) / 1e4, Math.round(v * 1e4) / 1e4]);
}

/** Douglas-Peucker on a closed loop. */
function simplify(pts, tol) {
  const dist = (p, a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy || 1e-12;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
  };
  const dp = (list) => {
    if (list.length < 3) return list;
    let far = 0, at = 0;
    for (let i = 1; i < list.length - 1; i++) {
      const d = dist(list[i], list[0], list[list.length - 1]);
      if (d > far) { far = d; at = i; }
    }
    if (far <= tol) return [list[0], list[list.length - 1]];
    const l = dp(list.slice(0, at + 1)), r = dp(list.slice(at));
    return [...l.slice(0, -1), ...r];
  };
  // Split the loop at its two farthest-apart points so DP has open ends.
  let a = 0, b = 0, far = -1;
  for (let i = 0; i < pts.length; i += Math.max(1, Math.floor(pts.length / 200))) {
    for (let j = i + 1; j < pts.length; j += Math.max(1, Math.floor(pts.length / 200))) {
      const d = Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]);
      if (d > far) { far = d; a = i; b = j; }
    }
  }
  const first = pts.slice(a, b + 1), second = [...pts.slice(b), ...pts.slice(0, a + 1)];
  return [...dp(first).slice(0, -1), ...dp(second).slice(0, -1)];
}
