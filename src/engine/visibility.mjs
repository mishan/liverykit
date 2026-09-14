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

import { vertex, triangles, damageOnly, motionBlurOnly } from './kn5.mjs';
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

/**
 * For each motion-blur mesh, the indices of the drawn meshes it is swapped
 * with, so that neither stands in front of the other.
 *
 * The blur meshes are already out of the occluders, so they cover nothing.
 * The other way round was left: the NSX's rim sheet is worn by its static
 * blur rim too, 1.2 mm behind the drawn one, and 39 panels measured on that
 * copy fell from 0.87 visible to under 0.1 once the exact test along the
 * normal found the drawn rim in front of it. The two are never on screen
 * together, so a blur mesh is measured as the rim it stands in for.
 *
 * By NODE, which is where AC makes the swap: WHEEL_xx carries RIM_xx and
 * RIM_BLUR_xx, and hides one or the other. Mesh names do not pair — the
 * RSS 4's drawn rim is RIM_RF_Mesh_SUB0 and its blur copy
 * RF_RIM_BLUR_Mesh_SUB0 — while the node above each does, on all three cars
 * here. So the first node on the blur mesh's path that is named for blur,
 * with the word taken out, names the sibling to look under.
 */
export function blurTwins(model) {
  const paths = model.meshes.map((m) => String(m.path ?? m.name ?? '').split('/'));
  const out = new Map();
  model.meshes.forEach((m, i) => {
    if (!motionBlurOnly(m.name)) return;
    const at = paths[i].findIndex((s) => motionBlurOnly(s));
    if (at < 0) return;
    const drawn = paths[i][at].replace(/(^|_)blur(_static)?(?=_|$)/i, '').replace(/^_/, '').toLowerCase();
    const twins = new Set();
    model.meshes.forEach((o, j) => {
      const p = paths[j];
      if (motionBlurOnly(o.name) || p.length <= at || p[at].toLowerCase() !== drawn) return;
      for (let k = 0; k < at; k++) if (p[k] !== paths[i][k]) return;
      twins.add(j);
    });
    if (twins.size) out.set(i, twins);
  });
  return out;
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
  //
  // Nor can the voxel. A shared cell used to stop every ray, as a plate in
  // front of the paint, and a mesh a few millimetres BEHIND the paint shares
  // the cell just the same: the NSX's inner door shell, cockpit tub and carbon
  // bonnet liner took its doors from 88% visible to 64% and its bonnet from
  // 95% to 61%. So `shared` keeps who marked each shared cell, a ray steps over
  // one its own surface is part of where it starts (see `escapes`), and what
  // stands close in FRONT is found by `covered`, exactly, along the normal.
  const grid = new Int32Array(nx * ny * nz);
  const idx = (i, j, k) => (k * ny + j) * nx + i;
  const shared = new Map();                     // cell -> Set of owner marks, for cells at -1

  let owner = 0;                                // set per mesh in the loop below
  const mark = (px, py, pz) => {
    const i = Math.floor((px - x0) / cellSize);
    const j = Math.floor((py - y0) / cellSize);
    const k = Math.floor((pz - z0) / cellSize);
    if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return;
    const c = idx(i, j, k);
    const was = grid[c];
    if (was === 0) grid[c] = owner;
    else if (was > 0 && was !== owner) {
      grid[c] = -1;
      shared.set(c, new Set([was, owner]));
    } else if (was === -1) shared.get(c).add(owner);
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
  return { grid, shared, x0, y0, z0, nx, ny, nz, cellSize, idx, twins: blurTwins(model) };
}

/**
 * March a ray through the grid; true if it escapes without hitting geometry.
 *
 * `own` is the mesh index the ray starts on, and cells that mesh marked are
 * stepped over, alone or, near the start, shared: a surface does not occlude
 * itself, a curved one marks the cells just outside itself, and what shares a
 * cell with it may be behind it as easily as in front. Every other occupied
 * cell stops the ray.
 * A voxel cannot tell a plate 5 mm proud of the paint from a shell 5 mm behind
 * it, so the plate is `covered`'s to find, not this.
 *
 * Default -1 means "not standing on anything", under which every occupied cell
 * blocks, which is what every caller wanted before ownership existed.
 *
 * A motion-blur mesh stands on the drawn mesh it is swapped with as much as
 * on itself: see `blurTwins`.
 *
 * A SHARED cell is stepped over only in the first `SHARED_STEPS` steps, the
 * cell or two the ray starts in. It used to be stepped over anywhere, so any
 * place on the car where another mesh comes within a voxel of the caster's
 * own surface — a mirror foot, a wing mount, a wheel-arch lip against the
 * body — let the caster's rays through it, and reported hidden as visible.
 * The shell behind the paint that the step-over is for is only ever where
 * the ray begins.
 */
const SHARED_STEPS = 3;               // 0.7, 1.4 and 2.1 cells out
function escapes(occ, px, py, pz, dx, dy, dz, maxSteps, own = -1) {
  const step = occ.cellSize * 0.7;
  const twins = own >= 0 ? occ.twins?.get(own) : undefined;
  const mine = (marks) => {
    if (marks.has(own + 1)) return true;
    if (twins !== undefined) for (const t of twins) if (marks.has(t + 1)) return true;
    return false;
  };
  let x = px, y = py, z = pz;
  for (let s = 0; s < maxSteps; s++) {
    x += dx * step; y += dy * step; z += dz * step;
    const i = Math.floor((x - occ.x0) / occ.cellSize);
    const j = Math.floor((y - occ.y0) / occ.cellSize);
    const k = Math.floor((z - occ.z0) / occ.cellSize);
    if (i < 0 || j < 0 || k < 0 || i >= occ.nx || j >= occ.ny || k >= occ.nz) return true;
    const at = occ.idx(i, j, k);
    const c = occ.grid[at];
    if (c === 0 || c === own + 1) continue;
    if (c > 0 && twins !== undefined && twins.has(c - 1)) continue;
    if (c === -1 && own >= 0 && s < SHARED_STEPS && mine(occ.shared.get(at))) continue;
    return false;
  }
  return true;
}

/**
 * Whether something stands directly on top of a point of paint: the ray
 * straight out along its normal meets another mesh within `reach`.
 *
 * The voxel grid cannot see this at any affordable setting. Its cells are
 * 2.5 cm and a ray's first test is 1.75 cm out, and on the Honda NSX the door
 * handle is a chrome strip 2-10 mm proud of the door. A team name laid across
 * it measured 100% seen — 99% even at five times the angles — while in the
 * render the strip ran through its last letter. So the near field is asked
 * exactly, ray against triangle, and a point covered there is not seen however
 * many oblique rays slip round the ends of the strip: looked at straight on,
 * which is how a flank is seen from trackside, it is behind the handle.
 *
 * `floor` passes over what lies ON the surface rather than in front of it. On
 * the same door an interior shell sharing the top edge meets the ray at
 * 0.2-0.6 mm, which is two meshes modelled along one line; the nearest real
 * fixture, a number plate, is 2.2 mm out.
 */
const NEAR_CELL = 0.05;
const nearKey = (i, j, k) => ((i + 512) * 1024 + (j + 512)) * 1024 + (k + 512);

function buildNear(model, meshes) {
  const cells = new Map();
  const twins = blurTwins(model);
  const cell = (v) => Math.floor(v / NEAR_CELL);
  for (const mesh of meshes) {
    // Not drawn until the car is damaged, or only when a wheel is spinning:
    // nothing that covers paint in any view a livery is judged in.
    if (damageOnly(model.materials?.[mesh.materialId]?.shader) || motionBlurOnly(mesh.name)) continue;
    const own = model.meshes.indexOf(mesh);
    for (const [a, b, c] of triangles(model, mesh)) {
      const A = vertex(model, mesh, a), B = vertex(model, mesh, b), C = vertex(model, mesh, c);
      const i0 = cell(Math.min(A.x, B.x, C.x)), i1 = cell(Math.max(A.x, B.x, C.x));
      const j0 = cell(Math.min(A.y, B.y, C.y)), j1 = cell(Math.max(A.y, B.y, C.y));
      const k0 = cell(Math.min(A.z, B.z, C.z)), k1 = cell(Math.max(A.z, B.z, C.z));
      // A triangle half a metre across in every direction is a floor or a
      // shell, not a fitting; the voxels have it, and filing it into a
      // thousand cells would buy nothing.
      if ((i1 - i0 + 1) * (j1 - j0 + 1) * (k1 - k0 + 1) > 1000) continue;
      const t = {
        ax: A.x, ay: A.y, az: A.z,
        e1x: B.x - A.x, e1y: B.y - A.y, e1z: B.z - A.z,
        e2x: C.x - A.x, e2y: C.y - A.y, e2z: C.z - A.z,
        own,
      };
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          for (let k = k0; k <= k1; k++) {
            const key = nearKey(i, j, k);
            const list = cells.get(key);
            if (list) list.push(t); else cells.set(key, [t]);
          }
        }
      }
    }
  }
  return { cells, twins };
}

/** Distance along the ray to triangle `t`, either face, or Infinity. */
function rayTriangle(ox, oy, oz, dx, dy, dz, t) {
  const px = dy * t.e2z - dz * t.e2y, py = dz * t.e2x - dx * t.e2z, pz = dx * t.e2y - dy * t.e2x;
  const det = t.e1x * px + t.e1y * py + t.e1z * pz;
  if (Math.abs(det) < 1e-12) return Infinity;
  const inv = 1 / det;
  const sx = ox - t.ax, sy = oy - t.ay, sz = oz - t.az;
  const u = (sx * px + sy * py + sz * pz) * inv;
  if (u < 0 || u > 1) return Infinity;
  const qx = sy * t.e1z - sz * t.e1y, qy = sz * t.e1x - sx * t.e1z, qz = sx * t.e1y - sy * t.e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < 0 || u + v > 1) return Infinity;
  return (t.e2x * qx + t.e2y * qy + t.e2z * qz) * inv;
}

function covered(near, p, reach = 0.05, floor = 0.001) {
  const cell = (v) => Math.floor(v / NEAR_CELL);
  const ex = p.x + p.nx * reach, ey = p.y + p.ny * reach, ez = p.z + p.nz * reach;
  const tested = new Set();
  // A blur rim is not covered by the rim it replaces; see `blurTwins`.
  const twins = near.twins.get(p.mesh);
  // Every cell the segment's box touches, so a ray clipping a corner is not
  // missed: at 5 cm cells and 5 cm of reach that is at most 27 of them.
  for (let i = cell(Math.min(p.x, ex)); i <= cell(Math.max(p.x, ex)); i++) {
    for (let j = cell(Math.min(p.y, ey)); j <= cell(Math.max(p.y, ey)); j++) {
      for (let k = cell(Math.min(p.z, ez)); k <= cell(Math.max(p.z, ez)); k++) {
        for (const t of near.cells.get(nearKey(i, j, k)) ?? []) {
          if (t.own === p.mesh || tested.has(t) || twins?.has(t.own)) continue;
          tested.add(t);
          const d = rayTriangle(p.x, p.y, p.z, p.nx, p.ny, p.nz, t);
          if (d >= floor && d <= reach) return t.own;   // which mesh: the thing to move away from
        }
      }
    }
  }
  return -1;
}

/**
 * A safe area confined to its panel.
 *
 * The safe area is the bounds of the readable vertices, taken from their raw
 * UVs, while the panel's rect is clamped to the sheet. On an island that
 * overhangs [0, 1] the two disagree, and the safe area reaches off the sheet:
 * validateProfile refuses that, and two fleet cars, the 458 GT2 and the MX-5
 * Cup, wrote profiles that would not load for it. Returned unchanged when it
 * already lies on the panel, so every other profile is written exactly as
 * before; null when what is left has no area, whether it lies off the panel or
 * is a line on it, since neither is anywhere to read.
 *
 * `slack` is rounding, not tolerance. Both rects are rounded to four places,
 * so an edge made of a rounded origin plus a rounded width can land 2e-4 past
 * the same edge of the panel; a slack of 1e-4 shaved a digit off 50 safe areas
 * on the sweep's cars that had never left their panels. A real overhang is
 * far larger: the 458's is 0.0133.
 */
export function safeWithin(safe, rect, slack = 5e-4) {
  const [x, y, w, h] = safe;
  const [rx, ry, rw, rh] = rect;
  if (w < 1e-5 || h < 1e-5) return null;
  // The slack excuses rounding past the PANEL, never a value off the SHEET,
  // which is the one validateProfile refuses. The Morgan's steering wheel sat
  // 0.0003 left of u = 0 — inside the slack, and still a profile that would
  // not load — so an area kept as it came must also be one checkRect accepts.
  const onSheet = safe.every((n) => n >= 0 && n <= 1) && x + w <= 1.0001 && y + h <= 1.0001;
  if (onSheet && x >= rx - slack && y >= ry - slack && x + w <= rx + rw + slack && y + h <= ry + rh + slack) return safe;
  const x0 = Math.max(x, rx), y0 = Math.max(y, ry);
  const x1 = Math.min(x + w, rx + rw), y1 = Math.min(y + h, ry + rh);
  if (x1 - x0 < 1e-5 || y1 - y0 < 1e-5) return null;
  return [round(x0), round(y0), round(x1 - x0), round(y1 - y0)];
}

/**
 * Annotate islands with a `safe` UV rect covering only their visible part.
 *
 * `occluders` should be every mesh in the car, not just the painted ones — a
 * wheel or a wing hides bodywork just as well as bodywork does. `prepared`,
 * from `occupancyFor`, is the same grid built once for every texture of a car
 * instead of once per texture.
 */
export function computeSafeAreas(model, islands, {
  occluders = model.meshes,
  cellSize = 0.025,                 // 2.5 cm
  prepared = null,
  minDirections = 4,                // viewing angles needed to count as visible
  minVisibleFraction = 0.02,        // below this the panel is treated as hidden
  shrinkThreshold = 0.02,           // ignore trims smaller than this, as noise
  log = () => {},
} = {}) {
  const { occ, dirs, maxSteps, near } = prepared ?? occupancyFor(model, { occluders, cellSize });
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
      // A plate or a handle standing on the paint shares its voxels, which
      // `escapes` now steps over, so it is asked about exactly here.
      if (covered(near, { ...p, mesh: own }) >= 0) continue;
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

    const safe = safeWithin([round(u0), round(v0), round(u1 - u0), round(v1 - v0)], isl.rect);
    // Nothing readable on the panel: what can be seen of the island lies off
    // the sheet, as on the MX-5 Cup's belts, or is a line. Skipped, the island
    // had no `safe`, which says the whole panel may be painted — the opposite
    // of what was measured. So it is hidden, as one too little of which is
    // visible is, and `visible` goes to 0 with it, because that and not
    // `hidden` is what the tags and fitment read.
    if (!safe) {
      isl.visibleFraction = 0;
      isl.hidden = true;
      log(`  - ${isl.name}: ${(fraction * 100).toFixed(0)}% of it is visible, but no readable ` +
          'area of that lies on its panel — treated as hidden');
      continue;
    }
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
/**
 * The meshes that can stand in front of paint on this car: every one but
 * those the car itself hides.
 *
 * The Honda NSX ships four sets of door number plates, IGT, IMSA and two
 * 2018 classes, each with an emissive twin, and hides all sixteen; the
 * renderer draws none of them. Counted as occluders they covered a team name
 * that nothing covers on the car, and failed a layout a person had arranged
 * by hand and could see was clear.
 *
 * Nor the damage-only glass or the motion-blur rims, which the renderer and the
 * near-field test already leave out: the game swaps them in for a crash or a
 * wheel at speed, and neither stands in front of a livery on a car at rest.
 */
export function carOccluders(model, profile) {
  const hidden = new Set(Object.keys(profile?.hiddenByCar?.meshes ?? {}));
  return model.meshes.filter((m) => !hidden.has(m.name)
    && !damageOnly(model.materials?.[m.materialId]?.shader) && !motionBlurOnly(m.name));
}

/** The bare grid, for a caller keeping one across many casts at a cell size of its own: the cockpit's. */
export const occupancyGrid = (model, occluders, cellSize) => buildOccupancy(model, occluders, cellSize);

export function occupancyFor(model, { occluders = model.meshes, cellSize = 0.025 } = {}) {
  const occ = buildOccupancy(model, occluders, cellSize);
  let near = null;
  return {
    occ,
    cellSize,
    dirs: viewDirections(),
    maxSteps: Math.ceil(Math.max(occ.nx, occ.ny, occ.nz) * 1.5),
    // Built on first use: the index of every triangle is the dearer half, and
    // a caller asking nothing about paint never needs it.
    get near() { return (near ??= buildNear(model, occluders)); },
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
  minDirections = 4, across = 14, poly = null, grid = null,
} = {}) {
  const { occ, cellSize, dirs, maxSteps, near } = prepared;
  // `grid` is [columns, rows] for a rectangle that is not square on the car:
  // a team name is ten times wider than it is tall, and `across` cells each
  // way spend nine tenths of the samples on its height.
  const [nu, nv] = grid ?? [across, across];
  // Zero, and that is the point. `escapes` steps BEFORE it tests, so any lift
  // at all skips past the cell the surface stands in — which is precisely the
  // cell a flush occluder shares with it. Self-occlusion is handled by
  // ownership now, so the ray has no reason to start anywhere but the surface.
  const lift = 0;
  const { points, cells } = sampleRect(model, meshes, rect, nu, nv, poly);
  if (!points.length) return null;

  let seen = 0;
  const under = {};
  for (const p of points) {
    const over = near ? covered(near, p) : -1;
    if (over >= 0) {
      const n = model.meshes[over]?.name ?? `mesh ${over}`;
      under[n] = (under[n] ?? 0) + 1;
      continue;
    }
    const sx = p.x + p.nx * lift, sy = p.y + p.ny * lift, sz = p.z + p.nz * lift;
    let clear = 0;
    for (const [dx, dy, dz] of dirs) {
      if (dx * p.nx + dy * p.ny + dz * p.nz <= 0.05) continue;
      if (escapes(occ, sx, sy, sz, dx, dy, dz, maxSteps, p.mesh) && ++clear >= minDirections) break;
    }
    if (clear >= minDirections) seen++;
  }
  return {
    fraction: seen / points.length, samples: points.length, of: cells,
    ...(Object.keys(under).length ? { under } : {}),
  };
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
function sampleRect(model, meshes, rect, nu, nv, poly = null) {
  return sampleRects(model, meshes, [{ rect, nu, nv, poly }])[0];
}

/**
 * `sampleRect` for several rectangles, from one walk over the triangles (see
 * `scanGrids`). `list` is `[{ rect, nu, nv, poly, within }]`.
 *
 * `within` is a second shape every sample must also be inside: a panel's
 * outline, for a question about the paint on that panel alone. A rectangle
 * in a texture covers whatever else the unwrap put inside it, and a stripe on
 * the NSX's bonnet, sampled over its box, measured 1234 mm wide where it was
 * 500: the rest was the tops of both front wings, laid out in the same
 * stretch of the sheet.
 */
export function sampleRects(model, meshes, list) {
  const plans = list.map(({ rect: [rx, ry, rw, rh], nu, nv, poly = null, within = null }) => {
    if (!(rw > 0) || !(rh > 0)) return null;
    // Which cells are in play, decided once: the inner loop runs per triangle
    // per cell, and a point-in-polygon test in there would be asked the same
    // question thousands of times over.
    let asked = null;
    let cells = nu * nv;
    const shapes = [poly, within].filter((s) => Array.isArray(s) && s.length >= 3);
    if (shapes.length) {
      asked = new Array(nu * nv).fill(false);
      cells = 0;
      for (let j = 0; j < nv; j++) {
        for (let i = 0; i < nu; i++) {
          // Cell centres, not edges.
          const at = [rx + ((i + 0.5) / nu) * rw, ry + ((j + 0.5) / nv) * rh];
          const inside = shapes.every((s) => inPoly(s, at));
          asked[j * nu + i] = inside;
          if (inside) cells++;
        }
      }
    }
    return cells ? { rect: [rx, ry, rw, rh], nu, nv, asked, cells } : null;
  });
  const hits = scanGrids(model, meshes, plans.filter(Boolean));
  let k = 0;
  return plans.map((plan) => (plan
    ? { points: hits[k++].filter(Boolean), cells: plan.cells }
    : { points: [], cells: 0 }));
}

/**
 * One surface point per cell of an `nu` x `nv` grid over a uv rectangle, or
 * null where no triangle covers the cell's centre. Indexed `j * nu + i`.
 *
 * The walk is over EVERY triangle of the meshes, whatever the rectangle, so
 * it costs the same for a small rectangle as for a large one — which is why a
 * sweep asks it once for a whole panel rather than once per cell. Asked 609
 * times over one door, it took half a minute to do 609 times what it could
 * have done once.
 */
function scanGrid(model, meshes, rect, nu, nv, asked = null) {
  return scanGrids(model, meshes, [{ rect, nu, nv, asked }])[0];
}

/**
 * `scanGrid` for several rectangles at once, from one walk over the triangles.
 *
 * The walk is the cost and the rectangles are nearly free, so a question about
 * the pieces of a stripe — six panels of one sheet, every time a draft is
 * checked — is asked here once rather than six times over the same triangles.
 * `grids` is `[{ rect, nu, nv, asked }]`; the answer is one hit list per grid,
 * each exactly what `scanGrid` returns for it alone.
 */
export function scanGrids(model, meshes, grids) {
  const hits = grids.map(({ nu, nv }) => new Array(nu * nv).fill(null));
  for (const mesh of meshes) {
    const own = model.meshes.indexOf(mesh);
    for (const [ia, ib, ic] of triangles(model, mesh)) {
      const A = vertex(model, mesh, ia), B = vertex(model, mesh, ib), C = vertex(model, mesh, ic);
      const umin = Math.min(A.u, B.u, C.u), umax = Math.max(A.u, B.u, C.u);
      const vmin = Math.min(A.v, B.v, C.v), vmax = Math.max(A.v, B.v, C.v);

      // Barycentric coordinates in UV, which is where the question is asked.
      const d = (B.u - A.u) * (C.v - A.v) - (C.u - A.u) * (B.v - A.v);
      if (Math.abs(d) < 1e-12) continue;            // degenerate in uv: no area to sample

      grids.forEach(({ rect: [rx, ry, rw, rh], nu, nv, asked }, g) => {
        // Only the grid cells this triangle could possibly cover.
        const i0 = Math.max(0, Math.floor(((umin - rx) / rw) * nu));
        const i1 = Math.min(nu - 1, Math.ceil(((umax - rx) / rw) * nu));
        const j0 = Math.max(0, Math.floor(((vmin - ry) / rh) * nv));
        const j1 = Math.min(nv - 1, Math.ceil(((vmax - ry) / rh) * nv));
        if (i1 < i0 || j1 < j0) return;
        const hit = hits[g];

        for (let j = j0; j <= j1; j++) {
          for (let i = i0; i <= i1; i++) {
            const slot = j * nu + i;
            if (hit[slot] || (asked && !asked[slot])) continue;  // first triangle to cover it wins
            const u = rx + ((i + 0.5) / nu) * rw, v = ry + ((j + 0.5) / nv) * rh;
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
      });
    }
  }
  return hits;
}

/**
 * `rectVisibility` for every cell of a `cols` x `rows` grid over one
 * rectangle, from ONE walk over the triangles.
 *
 * The same sample points, cell for cell, as asking `rectVisibility` of each
 * cell with `across: per` — a cell's samples are the centres of a `per` x
 * `per` grid inside it either way — and the same rule for a point being seen:
 * clear of the car in at least `minDirections` of the directions it faces.
 */
export function gridVisibility(model, prepared, meshes, rect, cols, rows, { per = 5, minDirections = 4 } = {}) {
  const { occ, dirs, maxSteps, near } = prepared;
  const nu = cols * per, nv = rows * per;
  const hit = scanGrid(model, meshes, rect, nu, nv);
  const tally = Array.from({ length: rows }, () => Array.from({ length: cols }, () => ({ samples: 0, seen: 0 })));
  hit.forEach((p, slot) => {
    if (!p) return;
    const cell = tally[Math.floor(Math.floor(slot / nu) / per)][Math.floor((slot % nu) / per)];
    cell.samples++;
    if (near && covered(near, p) >= 0) return;     // on the car, and under something
    let clear = 0;
    for (const [dx, dy, dz] of dirs) {
      if (dx * p.nx + dy * p.ny + dz * p.nz <= 0.05) continue;
      if (escapes(occ, p.x, p.y, p.z, dx, dy, dz, maxSteps, p.mesh) && ++clear >= minDirections) break;
    }
    if (clear >= minDirections) cell.seen++;
  });
  return tally.map((row) => row.map((c) => ({
    samples: c.samples, of: per * per, fraction: c.samples ? c.seen / c.samples : 0,
  })));
}

export function cockpitEye(model, { back = 0.42, up = 0.18, front = 1 } = {}) {
  let best = null;
  for (const mesh of model.meshes) {
    // THE NODE IT HANGS FROM, not only what it is called. AC turns the wheel by
    // rotating a `STEER_HR` / `STEER_LR` node, so every car states this in its
    // tree whether or not the artist named the meshes under it — and the Abarth
    // 500 did not: its wheel is `Geometry81_SUB0` through `SUB7`, and the
    // editor told somebody looking straight at a rendered steering wheel that
    // this car has none.
    //
    // The WHOLE path, because the wheel can hang a node or two below the one
    // that turns it — this car's is STEER_HR / Geometry81 / Geometry81_SUB4 —
    // and because the names above it say nothing that matches: a cockpit is
    // COCKPIT_HR, and a suspension's steering arm is out by a road wheel where
    // the sideways test below throws it out. Names still vary by author and
    // language, an Italian mod calling it 'volante'.
    if (!/steer|sterzo|volante|wheel_chassis/i.test(`${mesh.name} ${mesh.path ?? ''}`)) continue;
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
  eye = null, occluders = model.meshes, cellSize = 0.02, near = null, grid = null, log = () => {},
} = {}) {
  const point = eye ?? cockpitEye(model);
  if (!point) {
    log('  - no steering wheel found; skipping cockpit visibility');
    return islands;
  }
  const occ = grid ?? buildOccupancy(model, occluders, cellSize);
  // What stands flush in front is `covered`'s to find; see `escapes`.
  const nearby = near ?? buildNear(model, occluders);
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
      if (covered(nearby, { ...p, nx: dx, ny: dy, nz: dz, mesh: own }, Math.min(0.05, d)) >= 0) continue;
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
