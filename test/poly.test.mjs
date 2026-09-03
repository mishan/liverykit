// ---------------------------------------------------------------------------
// The shapes a placement can be.
//
// A rectangle stops being a rectangle the moment it crosses a seam: the map to
// the neighbouring island is a rotation, so the piece that lands over there is
// a parallelogram, and its bounding box is roughly twice its area. Everything
// that measured the box — overlap, safe area, legibility, coverage — was
// answering about a shape the design does not paint.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { clipConvex, sharedArea, areaInPoly, minWidth, polyArea, rectPoly, inPoly } from '../src/engine/poly.mjs';

const close = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

test('a convex clip is exact, whichever way round the corners run', () => {
  const unit = rectPoly([0, 0, 1, 1]);
  const half = rectPoly([0.5, 0, 1, 1]);
  assert.ok(close(polyArea(clipConvex(unit, half)), 0.5));
  // The same clip written clockwise is the same clip.
  assert.ok(close(polyArea(clipConvex(unit, [...half].reverse())), 0.5));
  // Boxes that miss share nothing at all, rather than a sliver.
  assert.equal(clipConvex(unit, rectPoly([2, 2, 1, 1])), null);
});

test('two diagonals that pass each other share nothing, whatever their boxes say', () => {
  // The finding this fixes. Two thin bands crossing a panel at opposite
  // angles have bounding boxes that overlap almost completely and artwork
  // that never meets — reported as a collision, on a design that is correct.
  const band = (from, to, w) => {
    const dx = to[0] - from[0], dy = to[1] - from[1];
    const l = Math.hypot(dx, dy);
    const nx = (-dy / l) * (w / 2), ny = (dx / l) * (w / 2);
    return [
      [from[0] + nx, from[1] + ny], [to[0] + nx, to[1] + ny],
      [to[0] - nx, to[1] - ny], [from[0] - nx, from[1] - ny],
    ];
  };
  const up = band([0, 0], [1, 1], 0.05);
  const down = band([0, 0.6], [1, 1.6], 0.05);
  // Their boxes overlap by most of themselves.
  const box = (p) => ({ x: Math.min(...p.map((q) => q[0])), y: Math.min(...p.map((q) => q[1])) });
  assert.ok(box(up).x === box(down).x);
  assert.equal(sharedArea(up, down), 0, 'parallel bands 60% of a sheet apart never meet');

  // And one that does cross is measured, not guessed at.
  const across = band([0, 1], [1, 0], 0.05);
  assert.ok(sharedArea(up, across) > 0);
  assert.ok(sharedArea(up, across) < 0.01, `a crossing is small: ${sharedArea(up, across)}`);
});

test('a concave outline is measured exactly, not clipped as if it were convex', () => {
  // An island outline is not convex — a door has a mirror cut out of one
  // corner and a wheel arch out of another. Sutherland-Hodgman against a
  // concave clip returns nonsense quietly, which is worse here than nothing,
  // so the outline is decomposed into a signed fan of triangles instead.
  const L = [[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2]];
  assert.ok(close(polyArea(L), 3));

  // A square over the inside corner: a quarter of it is in the notch.
  const square = rectPoly([0.5, 0.5, 1, 1]);
  assert.ok(close(areaInPoly(square, L), 0.75, 1e-9), areaInPoly(square, L));
  // Wholly inside, and wholly outside.
  assert.ok(close(areaInPoly(rectPoly([0.1, 0.1, 0.5, 0.5]), L), 0.25));
  assert.equal(areaInPoly(rectPoly([1.2, 1.2, 0.5, 0.5]), L), 0);
  // The same answer whichever way the outline is wound.
  assert.ok(close(areaInPoly(square, [...L].reverse()), 0.75, 1e-9));
});

test('how narrow a shape is, is measured across the shape', () => {
  // The short side of a box around a sheared rectangle can be twice the
  // width of the rectangle: a name measured 40 mm tall and was 18 mm of
  // lettering on a slant.
  const tilted = [[0, 0], [1, 1], [1.05, 0.95], [0.05, -0.05]];
  const boxShort = 1.05 - 0;               // what the bounding box would say
  const w = minWidth(tilted);
  assert.ok(w < 0.08 && w > 0.06, `across the band: ${w}`);
  assert.ok(boxShort > 10 * w, 'and the box is an order of magnitude out');

  // Scaled per axis, because a texture is stretched differently across than
  // along on nearly every panel.
  const tri = [[0, 0], [1, 0], [0, 1]];
  assert.ok(close(minWidth(tri), Math.SQRT1_2, 1e-12));
  assert.ok(close(minWidth(tri, [2, 1]), 2 / Math.sqrt(5), 1e-12));
});

test('a point is inside a shape or it is not, holes and corners included', () => {
  const L = [[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2]];
  assert.equal(inPoly(L, [0.5, 1.5]), true);
  assert.equal(inPoly(L, [1.5, 1.5]), false);
  assert.equal(inPoly(L, [1.5, 0.5]), true);
});
