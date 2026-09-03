// Pure geometry the packs draw with. These run without a profile, a browser or
// a car, so they are the cheapest place to pin down a shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { halftoneDissolve } from '../src/motifs.mjs';

/** Every dot as { cx, cy, r }, in the order drawn. */
function dots(svg) {
  return [...svg.matchAll(/cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/g)]
    .map(([, cx, cy, r]) => ({ cx: +cx, cy: +cy, r: +r }));
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);

test('a halftone dissolve thins along its angle, whichever way the angle points', () => {
  // Dots are largest at `start` and gone by `end`, measured along `angle`. That
  // held for 0 and 90 and silently failed for 180 and 270: the projection went
  // negative, the clamp pinned it to 0, and every dot came out full size. A
  // dissolve that was meant to run bottom-to-top rendered as a solid field, and
  // the only way to get one was to write `start` and `end` backwards.
  const size = { w: 400, h: 400, cell: 20 };
  const half = (svg, pick) => {
    const d = dots(svg);
    return { near: mean(d.filter((p) => pick(p) < 200).map((p) => p.r)),
             far: mean(d.filter((p) => pick(p) >= 200).map((p) => p.r)) };
  };

  const right = half(halftoneDissolve({ ...size, angle: 0 }), (p) => p.cx);
  assert.ok(right.near > right.far * 2, `angle 0 should be dense on the left: ${JSON.stringify(right)}`);

  const down = half(halftoneDissolve({ ...size, angle: 90 }), (p) => p.cy);
  assert.ok(down.near > down.far * 2, `angle 90 should be dense at the top: ${JSON.stringify(down)}`);

  const left = half(halftoneDissolve({ ...size, angle: 180 }), (p) => p.cx);
  assert.ok(left.far > left.near * 2, `angle 180 should be dense on the right: ${JSON.stringify(left)}`);

  const up = half(halftoneDissolve({ ...size, angle: 270 }), (p) => p.cy);
  assert.ok(up.far > up.near * 2, `angle 270 should be dense at the bottom: ${JSON.stringify(up)}`);
});

test('opposite angles are mirror images, not a ramp and a solid', () => {
  const a = dots(halftoneDissolve({ w: 300, h: 100, cell: 10, angle: 0 }));
  const b = dots(halftoneDissolve({ w: 300, h: 100, cell: 10, angle: 180 }));
  // Same number of dots survive in each direction.
  assert.equal(a.length, b.length);
  // And the radius profile reverses: the biggest dot of one is at the far end
  // of the other.
  const biggest = (d) => d.reduce((m, p) => (p.r > m.r ? p : m));
  assert.ok(biggest(a).cx < 150 && biggest(b).cx > 150);
});
