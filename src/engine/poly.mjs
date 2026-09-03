// ---------------------------------------------------------------------------
// Polygons in texture space.
//
// A rectangle in a livery is a rectangle in ONE island's sheet. The moment it
// crosses a seam it stops being one: the map to the neighbour is a rotation,
// so the piece that lands over there is a parallelogram, and clipped to the
// island it is some convex shape with five or six corners.
//
// Everything downstream then has a choice — measure the shape, or measure the
// box around it. The box is easy and it is wrong in a specific, expensive way:
// a band crossing a seam at 40 degrees fills about half of its own bounding
// box, so an overlap check reading boxes reports collisions that do not exist
// and a legibility check reading boxes calls a 12 mm stripe 30 mm tall. Both
// were happening, and both are the kind of finding that teaches people to stop
// reading the list.
//
// So: real polygon arithmetic, kept in one place because the routing in
// `profile.mjs` and the checks in `fitment.mjs` have to agree about what a
// placement IS. Points are `[u, v]` pairs in texture fractions.
//
// Everything here assumes the SUBJECT is convex — every placement is, being an
// affine image of a rectangle clipped to rectangles — while the clip may be any
// simple polygon, which is what an island outline is.
// ---------------------------------------------------------------------------

/** The area a closed polygon encloses, sign discarded. */
export function polyArea(poly) {
  if (!poly || poly.length < 3) return 0;
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
}

/** Signed area: positive counter-clockwise, in a y-down sheet, clockwise on screen. */
function signedArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** The bounding box of a polygon, as a rect. */
export function polyBox(poly) {
  const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
  const x0 = Math.min(...xs), y0 = Math.min(...ys);
  return { x: x0, y: y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0 };
}

/** A rect as a polygon, corners in order. */
export const rectPoly = ([x, y, w, h]) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];

/** Is a point inside a polygon? Ray casting, so holes and concavity are fine. */
export function inPoly(poly, [x, y]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** A convex polygon pushed outward by `d` from its centroid, roughly. */
export function grow(poly, d) {
  const cx = poly.reduce((s, p) => s + p[0], 0) / poly.length;
  const cy = poly.reduce((s, p) => s + p[1], 0) / poly.length;
  return poly.map(([x, y]) => {
    const l = Math.hypot(x - cx, y - cy) || 1;
    return [x + ((x - cx) / l) * d, y + ((y - cy) / l) * d];
  });
}

/**
 * A polygon clipped to a rectangle (Sutherland-Hodgman), or null if nothing
 * is left. Polygons rather than boxes throughout, because a band mapped
 * through a seam at -17 degrees is a parallelogram whose bounding box is
 * mostly not band — and tested as a box it crossed seams it never touched
 * and reached the roof from the door.
 */
export function clipPoly(poly, [bx, by, bw, bh]) {
  const edges = [
    (p) => p[0] >= bx, (p) => p[0] <= bx + bw, (p) => p[1] >= by, (p) => p[1] <= by + bh,
  ];
  const cross = [
    (a, b) => { const t = (bx - a[0]) / (b[0] - a[0]); return [bx, a[1] + t * (b[1] - a[1])]; },
    (a, b) => { const t = (bx + bw - a[0]) / (b[0] - a[0]); return [bx + bw, a[1] + t * (b[1] - a[1])]; },
    (a, b) => { const t = (by - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), by]; },
    (a, b) => { const t = (by + bh - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), by + bh]; },
  ];
  let out = poly;
  for (let e = 0; e < 4 && out.length; e++) {
    const inside = edges[e], at = cross[e];
    const next = [];
    for (let i = 0; i < out.length; i++) {
      const a = out[i], b = out[(i + 1) % out.length];
      const ia = inside(a), ib = inside(b);
      if (ia) next.push(a);
      if (ia !== ib) next.push(at(a, b));
    }
    out = next;
  }
  return out.length >= 3 ? out : null;
}

/**
 * A polygon clipped to a CONVEX one, or null. The same algorithm as above with
 * the clip's own edges standing in for the four sides of a box: each edge is a
 * half-plane, and the subject is cut by them in turn.
 *
 * The clip is taken counter-clockwise; a clockwise one is reversed first, so
 * callers need not care which way round their corners run.
 */
export function clipConvex(poly, clip) {
  if (!poly || poly.length < 3 || !clip || clip.length < 3) return null;
  const c = signedArea(clip) < 0 ? [...clip].reverse() : clip;
  let out = poly;
  for (let e = 0; e < c.length && out.length; e++) {
    const a0 = c[e], a1 = c[(e + 1) % c.length];
    const dx = a1[0] - a0[0], dy = a1[1] - a0[1];
    // Left of the edge, for a counter-clockwise clip, is inside it.
    const side = (p) => (p[0] - a0[0]) * dy - (p[1] - a0[1]) * dx;
    const at = (p, q) => {
      const sp = side(p), sq = side(q);
      const t = sp / (sp - sq);
      return [p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])];
    };
    const next = [];
    for (let i = 0; i < out.length; i++) {
      const p = out[i], q = out[(i + 1) % out.length];
      const ip = side(p) <= 0, iq = side(q) <= 0;
      if (ip) next.push(p);
      if (ip !== iq) next.push(at(p, q));
    }
    out = next;
  }
  return out.length >= 3 ? out : null;
}

/** How much area two polygons share, the first of which must be convex. */
export function sharedArea(convex, other) {
  return polyArea(clipConvex(other, convex));
}

/**
 * How much of a CONVEX polygon lies inside a simple one of any shape.
 *
 * An island outline is not convex — a door has a mirror cut out of one corner
 * and a wheel arch out of another — and Sutherland-Hodgman against a concave
 * clip quietly returns nonsense, which is worse here than returning nothing.
 *
 * So the outline is decomposed into a fan of triangles from its first vertex.
 * The fan covers the polygon's exterior as well as its interior, and the
 * SIGNS are what makes it exact: a triangle wound the other way subtracts the
 * area it wrongly added. Every triangle is convex, so each intersection is an
 * honest Sutherland-Hodgman clip, and the signed sum is the true shared area.
 * Twenty lines, no triangulator, exact for any simple polygon.
 */
export function areaInPoly(convex, poly) {
  if (!convex || convex.length < 3 || !poly || poly.length < 3) return 0;
  const o = poly[0];
  let total = 0;
  for (let i = 1; i + 1 < poly.length; i++) {
    const tri = [o, poly[i], poly[i + 1]];
    const s = signedArea(tri);
    if (!s) continue;
    const piece = clipConvex(convex, tri);
    if (piece) total += Math.sign(s) * polyArea(piece);
  }
  return Math.abs(total);
}

/**
 * The narrowest a convex polygon is, measured across it.
 *
 * For text this is the question, and the bounding box is not it: a word's box
 * is as tall as the diagonal of the sheared shape it actually occupies, so a
 * stripe of lettering crossing a seam measured comfortably readable while
 * being half that on the car. The minimum width of a convex polygon is over
 * one of its own edges (rotating calipers, minus the calipers), so every edge
 * is tried and the widest point away from it is what that edge's width is.
 *
 * `scale` turns the sheet into metres, one factor per axis, since a texture
 * is stretched differently across than along on almost every panel.
 */
export function minWidth(poly, [sx, sy] = [1, 1]) {
  if (!poly || poly.length < 3) return 0;
  const pts = poly.map(([x, y]) => [x * sx, y * sy]);
  let best = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-12) continue;
    let far = 0;
    for (const p of pts) {
      far = Math.max(far, Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / len);
    }
    best = Math.min(best, far);
  }
  return Number.isFinite(best) ? best : 0;
}
