// ---------------------------------------------------------------------------
// Which parts of a UV island are actually VISIBLE on the car.
//
// This is the last thing the model didn't obviously answer. UV islands tell you
// where a panel lives in the texture; they say nothing about whether that piece
// of bodywork can be seen. An air duct's inner wall, the underside of a floor
// and the back of a bulkhead are all perfectly ordinary parts of an island, and
// all of them are places artwork goes to die.
//
// Method: mark the car's geometry into a coarse voxel grid, then from each
// vertex of the island cast rays outward through the grid across a spread of
// trackside viewing directions, and COUNT how many escape. The safe rect is the
// UV bounding box of the vertices visible from enough angles to be read.
//
// Rays rather than a plain normal test, because a normal test is wrong in both
// directions: an upward-facing surface at the bottom of a duct is invisible,
// and a slightly downward-facing shoulder on a sidepod is not.
//
// --- a correction this analysis produced -----------------------------------
//
// It was previously recorded — in this project's own docs — that the lower edge
// of the flank "curls under the floor and is not visible from trackside", after
// a driver name placed there came back hard to read. A hand-written safe rect
// was added on that basis.
//
// The model disagrees, and the model is right. That band is outward-facing
// bodywork 9-14 cm above the ground with surface normals almost entirely
// lateral, visible from 98% of sampled viewpoints. The name was hard to read
// because it sat very low on the car and partly behind a wheel from that
// camera angle — a legibility problem, not a geometry one.
//
// The bogus safe rect is gone. Worth remembering that "I saw it go wrong once"
// is a hypothesis, not a measurement.
//
// It is still a heuristic, and it is labelled as one in the profile it produces.
// ---------------------------------------------------------------------------

import { vertex, triangles } from './kn5.mjs';

/**
 * Viewing directions. Weighted towards the horizontal, because a livery is seen
 * from trackside and from replay cameras, plus a few from above for the top
 * surfaces. Deliberately nothing from below: nobody sees the floor of a car,
 * and treating the underside as paintable is how artwork gets wasted.
 */
function viewDirections(rings = 16) {
  const dirs = [];
  for (const elevation of [0.05, 0.35, 0.75]) {
    const r = Math.sqrt(Math.max(0, 1 - elevation * elevation));
    for (let i = 0; i < rings; i++) {
      const a = (i / rings) * Math.PI * 2;
      dirs.push([Math.cos(a) * r, elevation, Math.sin(a) * r]);
    }
  }
  dirs.push([0, 1, 0]);                      // straight down onto the car
  return dirs;
}

/** Coarse occupancy grid over every mesh in the model, so occluders count. */
function buildOccupancy(model, meshes, cellSize) {
  let x0 = Infinity, y0 = Infinity, z0 = Infinity;
  let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (const mesh of meshes) {
    for (let i = 0; i < mesh.vertexCount; i++) {
      const p = vertex(model, mesh, i);
      if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
      if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y;
      if (p.z < z0) z0 = p.z; if (p.z > z1) z1 = p.z;
    }
  }
  const pad = cellSize * 2;
  x0 -= pad; y0 -= pad; z0 -= pad; x1 += pad; y1 += pad; z1 += pad;

  const nx = Math.max(1, Math.ceil((x1 - x0) / cellSize));
  const ny = Math.max(1, Math.ceil((y1 - y0) / cellSize));
  const nz = Math.max(1, Math.ceil((z1 - z0) / cellSize));
  const grid = new Uint8Array(nx * ny * nz);
  const idx = (i, j, k) => (k * ny + j) * nx + i;

  const mark = (px, py, pz) => {
    const i = Math.floor((px - x0) / cellSize);
    const j = Math.floor((py - y0) / cellSize);
    const k = Math.floor((pz - z0) / cellSize);
    if (i >= 0 && j >= 0 && k >= 0 && i < nx && j < ny && k < nz) grid[idx(i, j, k)] = 1;
  };

  // Triangles are sampled rather than just their vertices: a large flat panel
  // has few vertices and would otherwise leave holes for rays to slip through,
  // which reports hidden surfaces as visible — the dangerous direction.
  for (const mesh of meshes) {
    for (const [a, b, c] of triangles(model, mesh)) {
      const p0 = vertex(model, mesh, a), p1 = vertex(model, mesh, b), p2 = vertex(model, mesh, c);
      const span = Math.max(
        Math.hypot(p1.x - p0.x, p1.y - p0.y, p1.z - p0.z),
        Math.hypot(p2.x - p0.x, p2.y - p0.y, p2.z - p0.z)
      );
      const n = Math.min(12, Math.max(1, Math.ceil(span / (cellSize * 0.6))));
      for (let s = 0; s <= n; s++) {
        for (let t = 0; t + s <= n; t++) {
          const u = s / n, v = t / n, w = 1 - u - v;
          mark(p0.x * w + p1.x * u + p2.x * v,
               p0.y * w + p1.y * u + p2.y * v,
               p0.z * w + p1.z * u + p2.z * v);
        }
      }
    }
  }
  return { grid, x0, y0, z0, nx, ny, nz, cellSize, idx };
}

/** March a ray through the grid; true if it escapes without hitting geometry. */
function escapes(occ, px, py, pz, dx, dy, dz, maxSteps) {
  const step = occ.cellSize * 0.7;
  let x = px, y = py, z = pz;
  for (let s = 0; s < maxSteps; s++) {
    x += dx * step; y += dy * step; z += dz * step;
    const i = Math.floor((x - occ.x0) / occ.cellSize);
    const j = Math.floor((y - occ.y0) / occ.cellSize);
    const k = Math.floor((z - occ.z0) / occ.cellSize);
    if (i < 0 || j < 0 || k < 0 || i >= occ.nx || j >= occ.ny || k >= occ.nz) return true;
    if (occ.grid[occ.idx(i, j, k)]) return false;
  }
  return true;
}

/**
 * Annotate islands with a `safe` UV rect covering only their visible part.
 *
 * `occluders` should be every mesh in the car, not just the painted ones — a
 * wheel or a wing hides bodywork just as well as bodywork does.
 */
export function computeSafeAreas(model, islands, {
  occluders = model.meshes,
  cellSize = 0.025,                 // 2.5 cm
  minDirections = 4,                // viewing angles needed to count as visible
  minVisibleFraction = 0.02,        // below this the panel is treated as hidden
  shrinkThreshold = 0.02,           // ignore trims smaller than this, as noise
  log = () => {},
} = {}) {
  const occ = buildOccupancy(model, occluders, cellSize);
  const dirs = viewDirections();
  const maxSteps = Math.ceil(Math.max(occ.nx, occ.ny, occ.nz) * 1.5);
  const lift = cellSize * 1.6;      // start outside the surface's own voxel

  for (const isl of islands) {
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    let visible = 0;

    for (const i of isl.vertices) {
      const p = vertex(model, isl.meshRef, i);
      const sx = p.x + p.nx * lift, sy = p.y + p.ny * lift, sz = p.z + p.nz * lift;
      // Count the directions, don't stop at the first. "Visible from at least
      // one angle out of forty-nine" is a much weaker claim than it sounds: the
      // lower edge of a sidepod, tucked under an overhang and half behind a
      // wheel, passes that test and is still no place to put a driver's name.
      // Requiring several viewing angles distinguishes a surface you can see
      // from one you can read.
      let clear = 0;
      for (const [dx, dy, dz] of dirs) {
        // A ray heading into the surface tells you nothing.
        if (dx * p.nx + dy * p.ny + dz * p.nz <= 0.05) continue;
        if (escapes(occ, sx, sy, sz, dx, dy, dz, maxSteps)) clear++;
      }
      if (clear < minDirections) continue;
      visible++;
      if (p.u < u0) u0 = p.u; if (p.u > u1) u1 = p.u;
      if (p.v < v0) v0 = p.v; if (p.v > v1) v1 = p.v;
    }

    const fraction = visible / isl.vertexCount;
    isl.visibleFraction = Math.round(fraction * 100) / 100;

    if (fraction < minVisibleFraction) {
      isl.hidden = true;
      log(`  - ${isl.name}: ${(fraction * 100).toFixed(0)}% visible — treated as hidden`);
      continue;
    }

    const safe = [round(u0), round(v0), round(u1 - u0), round(v1 - v0)];
    const shrankX = (isl.rect[2] - safe[2]) / (isl.rect[2] || 1);
    const shrankY = (isl.rect[3] - safe[3]) / (isl.rect[3] || 1);
    if (shrankX > shrinkThreshold || shrankY > shrinkThreshold) {
      isl.safe = safe;
      log(`  - ${isl.name}: safe area trims ${(shrankX * 100).toFixed(0)}% x ` +
          `${(shrankY * 100).toFixed(0)}% (${(fraction * 100).toFixed(0)}% of it is visible)`);
    }
  }
  return islands;
}

const round = (n) => Math.round(n * 10000) / 10000;
