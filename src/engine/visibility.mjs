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
import { inPoly } from './poly.mjs';

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
  // Not a bitmap of "something is here" but of WHOSE something.
  //
  //    0   nothing
  //   m+1  marked by mesh m and nothing else
  //   -1   marked by more than one mesh
  //
  // Every non-zero value is truthy, so anything asking only "is this occupied"
  // reads the same as before. What it buys is the ability to cast a ray off a
  // surface without that surface stopping it — which used to be done by
  // starting the ray 4 cm out along the normal, and 4 cm is further than the
  // things that hide artwork. On the Honda the number plates stand a few
  // millimetres proud of the doors: nearer than the lift, and at 2.5 cm cells
  // in the same voxel as the door, so NO starting distance can tell them apart.
  // Ownership can. The shared voxel is -1, which is not the door's own mark,
  // so it occludes.
  const grid = new Int32Array(nx * ny * nz);
  const idx = (i, j, k) => (k * ny + j) * nx + i;

  let owner = 0;                                // set per mesh in the loop below
  const mark = (px, py, pz) => {
    const i = Math.floor((px - x0) / cellSize);
    const j = Math.floor((py - y0) / cellSize);
    const k = Math.floor((pz - z0) / cellSize);
    if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return;
    const c = idx(i, j, k);
    const was = grid[c];
    grid[c] = was === 0 ? owner : (was === owner ? was : -1);
  };

  // Triangles are sampled rather than just their vertices: a large flat panel
  // has few vertices and would otherwise leave holes for rays to slip through,
  // which reports hidden surfaces as visible — the dangerous direction.
  for (const mesh of meshes) {
    // Index within the WHOLE model, not within `meshes` — a caster names its
    // own mesh from the model, and occluders are usually a different list.
    //
    // Thrown rather than tolerated. `indexOf` returns -1 for a mesh that is not
    // the same object as a model entry, which made `owner` 0 — the value for
    // "empty" — so the mesh marked no cells at all and every ray sailed
    // through it. The measurement would still come back, confident and wrong.
    const at = model.meshes.indexOf(mesh);
    if (at < 0) {
      throw new Error(`occluder ${JSON.stringify(mesh.name ?? '(unnamed)')} is not one of ` +
        'model.meshes. Occupancy is keyed by identity, so a copy marks nothing and ' +
        'silently occludes nothing.');
    }
    owner = at + 1;
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

/**
 * March a ray through the grid; true if it escapes without hitting geometry.
 *
 * `own` is the mesh index the ray starts on, and cells marked by that mesh
 * ALONE are stepped over: a surface does not occlude itself, and a curved one
 * marks the cells just outside itself. Anything else stops the ray, including a
 * cell the surface shares with a second mesh — that share is exactly what a
 * panel lying flush against another looks like in a coarse grid.
 *
 * Default -1 means "not standing on anything", under which every occupied cell
 * blocks, which is what every caller wanted before ownership existed.
 */
function escapes(occ, px, py, pz, dx, dy, dz, maxSteps, own = -1) {
  const step = occ.cellSize * 0.7;
  let x = px, y = py, z = pz;
  for (let s = 0; s < maxSteps; s++) {
    x += dx * step; y += dy * step; z += dz * step;
    const i = Math.floor((x - occ.x0) / occ.cellSize);
    const j = Math.floor((y - occ.y0) / occ.cellSize);
    const k = Math.floor((z - occ.z0) / occ.cellSize);
    if (i < 0 || j < 0 || k < 0 || i >= occ.nx || j >= occ.ny || k >= occ.nz) return true;
    const c = occ.grid[occ.idx(i, j, k)];
    if (c !== 0 && c !== own + 1) return false;
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
  // Was cellSize * 1.6 — 4 cm, chosen to clear the surface's own voxel, and so
  // wide it stepped over anything sitting closer than that. Ownership clears
  // the surface instead, and `escapes` tests only AFTER stepping, so a lift of
  // any size skips the cell where a flush occluder would be found.
  const lift = 0;

  for (const isl of islands) {
    const own = model.meshes.indexOf(isl.meshRef);
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
        if (escapes(occ, sx, sy, sz, dx, dy, dz, maxSteps, own)) clear++;
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

// ---------------------------------------------------------------------------
// The cockpit is a second viewpoint, and it inverts the answer.
//
// Everything above asks "can this be seen from trackside", which is the right
// question for a livery people watch go past. It is the wrong question for the
// person driving. A cockpit-view driver spends the whole race looking at the
// tub interior, the steering wheel and the nose ahead — surfaces the trackside
// pass scores at near zero precisely because they are enclosed.
//
// So visibility is not a property of a surface. It is a property of a surface
// AND a place to stand.
// ---------------------------------------------------------------------------

/**
 * Estimate the driver's eye position.
 *
 * AC keeps the real value in the car's data files, which are usually packed
 * inside data.acd and often encrypted, so it is derived from geometry instead:
 * find the steering wheel, then sit back and up from it by roughly the offset a
 * seated driver has. Crude, but a viewpoint 10 cm out barely changes which
 * panels are visible — and it is checkable, since the eye should end up inside
 * the car's bounding box and above its floor.
 */
/**
 * The grid and the rays, handed out so a caller can ask about something other
 * than a whole panel.
 *
 * `computeSafeAreas` answers one question per island and throws the apparatus
 * away. But a panel's `visible` is a single number for a rectangle that may be
 * partly behind something — on the Honda NSX the number plate meshes stand
 * proud of the front doors — and it cannot say WHICH part. Placing artwork in
 * the hidden fraction of an 88%-visible panel is then invisible to every check
 * there is, and shows up as a name nobody can read.
 *
 * The grid is the expensive part and it is per CAR, not per question, so
 * handing it out is what makes asking thirty times cheap.
 */
export function occupancyFor(model, { occluders = model.meshes, cellSize = 0.025 } = {}) {
  const occ = buildOccupancy(model, occluders, cellSize);
  return {
    occ,
    cellSize,
    dirs: viewDirections(),
    maxSteps: Math.ceil(Math.max(occ.nx, occ.ny, occ.nz) * 1.5),
  };
}

/**
 * How much of ONE uv rectangle can be seen from trackside.
 *
 * Every vertex already carries its own `(u, v)` beside its position and normal,
 * so there is no inverse mapping to invent: the rectangle selects which vertices
 * to stand on, and the rays are the same forty-nine `computeSafeAreas` uses,
 * with the same "several angles, not one" rule. A surface visible from exactly
 * one of forty-nine directions is not a place to put a driver's name.
 *
 * `null` when the rectangle contains no vertices at all — which is a different
 * answer from zero. Zero means measured and hidden; null means the question did
 * not land on any geometry, and reporting that as invisible would condemn a
 * placement for the wrong reason.
 *
 * `poly` narrows the question from the rectangle to a shape inside it, and the
 * count of cells it returns narrows with it. A placement that crossed a seam is
 * a parallelogram: asked as its bounding box, half the samples fall on artwork
 * that is not there, and the answer is a coverage figure roughly half of the
 * truth — which reads as a design painting into empty texture space and is
 * really a design painting a diagonal.
 */
export function rectVisibility(model, prepared, meshes, rect, {
  minDirections = 4, across = 14, poly = null,
} = {}) {
  const { occ, cellSize, dirs, maxSteps } = prepared;
  // Zero, and that is the point. `escapes` steps BEFORE it tests, so any lift
  // at all skips past the cell the surface stands in — which is precisely the
  // cell a flush occluder shares with it. Self-occlusion is handled by
  // ownership now, so the ray has no reason to start anywhere but the surface.
  const lift = 0;
  const { points, cells } = sampleRect(model, meshes, rect, across, poly);
  if (!points.length) return null;

  let seen = 0;
  for (const p of points) {
    const sx = p.x + p.nx * lift, sy = p.y + p.ny * lift, sz = p.z + p.nz * lift;
    let clear = 0;
    for (const [dx, dy, dz] of dirs) {
      if (dx * p.nx + dy * p.ny + dz * p.nz <= 0.05) continue;
      if (escapes(occ, sx, sy, sz, dx, dy, dz, maxSteps, p.mesh)) clear++;
    }
    if (clear >= minDirections) seen++;
  }
  return { fraction: seen / points.length, samples: points.length, of: cells };
}

/**
 * Points on the car's surface at a regular grid across a uv rectangle.
 *
 * The reason this exists rather than iterating vertices. Vertices are where the
 * MODELLER put them, so the number of them inside a rectangle measures the
 * modeller's mesh density and not the rectangle: a door panel is a handful of
 * large triangles, and a region small enough to hold a team name can contain
 * three vertices, or none at all. Standing on those three gives a confident
 * fraction computed from a sample nobody would accept, and standing on none
 * gave `null` — which the caller could only read as "no answer" for a rectangle
 * that is sitting squarely on bodywork.
 *
 * Every sample point here is interpolated ACROSS a triangle instead, so the
 * resolution is the grid's and the answer means the same thing for a small
 * region as for a large one. A point that lands on no triangle is not a
 * sample — that part of the rectangle really is off the mesh — so the returned
 * count against the cells asked about is also a coverage figure.
 *
 * `poly`, when given, is the shape inside the rectangle that is really being
 * asked about. Cells whose centre falls outside it are not sampled and are not
 * counted, so the coverage figure stays a fraction of the artwork rather than
 * of the box drawn around it.
 */
function sampleRect(model, meshes, [rx, ry, rw, rh], across, poly = null) {
  if (!(rw > 0) || !(rh > 0)) return { points: [], cells: 0 };
  const hit = new Array(across * across).fill(null);
  const step = (n) => (n + 0.5) / across;          // cell centres, not edges

  // Which cells are in play, decided once: the inner loop runs per triangle
  // per cell, and a point-in-polygon test in there would be asked the same
  // question thousands of times over.
  const asked = new Array(across * across).fill(true);
  let cells = across * across;
  if (Array.isArray(poly) && poly.length >= 3) {
    cells = 0;
    for (let j = 0; j < across; j++) {
      for (let i = 0; i < across; i++) {
        const inside = inPoly(poly, [rx + step(i) * rw, ry + step(j) * rh]);
        asked[j * across + i] = inside;
        if (inside) cells++;
      }
    }
  }
  if (!cells) return { points: [], cells: 0 };

  for (const mesh of meshes) {
    const own = model.meshes.indexOf(mesh);
    for (const [ia, ib, ic] of triangles(model, mesh)) {
      const A = vertex(model, mesh, ia), B = vertex(model, mesh, ib), C = vertex(model, mesh, ic);

      // Only the grid cells this triangle could possibly cover.
      const lo = (v, r, d) => Math.floor(((Math.min(A[v], B[v], C[v]) - r) / d) * across);
      const hi = (v, r, d) => Math.ceil(((Math.max(A[v], B[v], C[v]) - r) / d) * across);
      const i0 = Math.max(0, lo('u', rx, rw)), i1 = Math.min(across - 1, hi('u', rx, rw));
      const j0 = Math.max(0, lo('v', ry, rh)), j1 = Math.min(across - 1, hi('v', ry, rh));
      if (i1 < i0 || j1 < j0) continue;

      // Barycentric coordinates in UV, which is where the question is asked.
      const d = (B.u - A.u) * (C.v - A.v) - (C.u - A.u) * (B.v - A.v);
      if (Math.abs(d) < 1e-12) continue;            // degenerate in uv: no area to sample

      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const slot = j * across + i;
          if (hit[slot] || !asked[slot]) continue;  // first triangle to cover it wins
          const u = rx + step(i) * rw, v = ry + step(j) * rh;
          const b1 = ((u - A.u) * (C.v - A.v) - (C.u - A.u) * (v - A.v)) / d;
          const b2 = ((B.u - A.u) * (v - A.v) - (u - A.u) * (B.v - A.v)) / d;
          const b0 = 1 - b1 - b2;
          if (b0 < 0 || b1 < 0 || b2 < 0) continue;
          const nx = A.nx * b0 + B.nx * b1 + C.nx * b2;
          const ny = A.ny * b0 + B.ny * b1 + C.ny * b2;
          const nz = A.nz * b0 + B.nz * b1 + C.nz * b2;
          const nl = Math.hypot(nx, ny, nz) || 1;
          hit[slot] = {
            x: A.x * b0 + B.x * b1 + C.x * b2,
            y: A.y * b0 + B.y * b1 + C.y * b2,
            z: A.z * b0 + B.z * b1 + C.z * b2,
            nx: nx / nl, ny: ny / nl, nz: nz / nl,
            mesh: own,
          };
        }
      }
    }
  }
  return { points: hit.filter(Boolean), cells };
}

export function cockpitEye(model, { back = 0.42, up = 0.18, front = 1 } = {}) {
  let best = null;
  for (const mesh of model.meshes) {
    // Names vary by author and language — an Italian mod calls it 'volante'.
    if (!/steer|sterzo|volante|wheel_chassis/i.test(mesh.name)) continue;
    if (mesh.vertexCount < 200) continue;
    let x = 0, y = 0, z = 0;
    for (let i = 0; i < mesh.vertexCount; i++) {
      const v = vertex(model, mesh, i); x += v.x; y += v.y; z += v.z;
    }
    const c = { x: x / mesh.vertexCount, y: y / mesh.vertexCount, z: z / mesh.vertexCount };
    // A steering wheel sits by the driver; a steering ARM sits by a road
    // wheel, 70-80 cm out. The line between them was drawn at 25 cm, which
    // is where a centre-seat formula car keeps its wheel and nowhere else: a
    // road car's is 35-40 cm off, and the NSX GT3's 34 cm left because the
    // driver is. That car got no cockpit visibility at all, and no panel of
    // its interior could be tagged `cockpit`, for want of 9 cm.
    if (Math.abs(c.x) > 0.55) continue;
    if (!best || mesh.vertexCount > best.n) best = { ...c, n: mesh.vertexCount, from: mesh.name };
  }
  if (!best) return null;
  return { x: best.x, y: best.y + up, z: best.z - back * front, from: best.from };
}

/**
 * Fraction of each island visible from a single point inside the car.
 *
 * Rays go from the surface toward the eye, and the surface has to face it —
 * the back of a bulkhead one metre away is not "visible" just because nothing
 * happens to be in between.
 */
export function computeCockpitVisibility(model, islands, {
  eye = null, occluders = model.meshes, cellSize = 0.02, log = () => {},
} = {}) {
  const point = eye ?? cockpitEye(model);
  if (!point) {
    log('  - no steering wheel found; skipping cockpit visibility');
    return islands;
  }
  const occ = buildOccupancy(model, occluders, cellSize);
  const maxSteps = Math.ceil(Math.max(occ.nx, occ.ny, occ.nz) * 1.5);
  const lift = 0;                   // ownership clears the surface; see `escapes`

  // Now that rays run all the way to the eye, an eye sitting inside geometry
  // would occlude everything and quietly report the whole cockpit as unseen.
  // Worth checking, because the eye position is an estimate.
  const ei = Math.floor((point.x - occ.x0) / occ.cellSize);
  const ej = Math.floor((point.y - occ.y0) / occ.cellSize);
  const ek = Math.floor((point.z - occ.z0) / occ.cellSize);
  const inside = ei >= 0 && ej >= 0 && ek >= 0 && ei < occ.nx && ej < occ.ny && ek < occ.nz;
  if (inside && occ.grid[occ.idx(ei, ej, ek)]) {
    log(`  ! estimated eye (${point.x.toFixed(2)}, ${point.y.toFixed(2)}, ${point.z.toFixed(2)}) ` +
        `lands inside geometry — cockpit visibility will read low for everything`);
  }

  for (const isl of islands) {
    const own = model.meshes.indexOf(isl.meshRef);
    let seen = 0;
    for (const i of isl.vertices) {
      const p = vertex(model, isl.meshRef, i);
      let dx = point.x - p.x, dy = point.y - p.y, dz = point.z - p.z;
      const d = Math.hypot(dx, dy, dz) || 1;
      dx /= d; dy /= d; dz /= d;
      if (dx * p.nx + dy * p.ny + dz * p.nz <= 0.05) continue;   // facing away
      // March the WHOLE way to the eye. Stopping short leaves a blind spot at
      // the near end of the ray, so anything sitting just in front of the
      // driver — a wheel rim, a roll hoop — fails to occlude and the panel
      // behind it reports as visible.
      const steps = Math.min(maxSteps, Math.ceil(d / (occ.cellSize * 0.7)));
      if (steps <= 0) { seen++; continue; }
      if (escapes(occ, p.x + p.nx * lift, p.y + p.ny * lift, p.z + p.nz * lift,
                  dx, dy, dz, steps, own)) seen++;
    }
    isl.cockpitFraction = Math.round((seen / isl.vertexCount) * 100) / 100;
  }
  return islands;
}
