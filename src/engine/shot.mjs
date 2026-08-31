// ---------------------------------------------------------------------------
// A picture of the car, rendered in Node.
//
// This exists because of a pattern rather than a feature request. Three changes
// in a row went out unverified — a lighting model, a texture-resolution fix and
// an alpha pass — and every one came back as a screenshot from the person I was
// supposed to be helping. The last one made the car see-through and I had no
// way of knowing.
//
// The editor draws with WebGL in a browser, which an MCP tool cannot reach. So
// this is a small software rasteriser: project the triangles, keep a depth
// buffer, interpolate uv and normal, sample the design's own rendered artwork,
// and shade it the way the viewer does. Perhaps two hundred lines, no
// dependency that was not already here, and it turns "I cannot see it" into a
// PNG.
//
// It is NOT a substitute for the editor. It has no alpha handling, no stock car
// textures, and one light rig. What it can answer is the question I kept
// getting wrong: does the artwork land where I said it would, and does the car
// still look like a car.
// ---------------------------------------------------------------------------

import sharp from 'sharp';

/** Unpainted geometry. Grey, and obviously grey — never a plausible colour. */
const BARE = [0x4a, 0x4a, 0x52];

/**
 * Where the camera sits for a named view.
 *
 * Named rather than free angles because the useful question is nearly always
 * "how does the flank read", and because a named view is reproducible: two
 * shots of `left` are comparable, two shots of yaw 2.31 are a coincidence.
 */
export const VIEWS = {
  left: { yaw: -Math.PI / 2, pitch: 0.12 },
  right: { yaw: Math.PI / 2, pitch: 0.12 },
  front: { yaw: 0, pitch: 0.15 },
  rear: { yaw: Math.PI, pitch: 0.15 },
  'front-left': { yaw: -Math.PI / 4, pitch: 0.22 },
  'rear-left': { yaw: -3 * Math.PI / 4, pitch: 0.22 },
  top: { yaw: -Math.PI / 2, pitch: 1.35 },
};

/**
 * Rasterise one texture's SVG to raw RGBA.
 *
 * Kept small on purpose: the shot is a few hundred pixels across, so a 2048
 * sheet is far more detail than can survive, and rasterising them all at full
 * size costs seconds per call for nothing anybody can see.
 */
async function sheet(svg, size = 512) {
  const { data, info } = await sharp(Buffer.from(svg))
    // ASPECT PRESERVED. `fit: 'fill'` at size x size squashed this car's
    // 2048x512 tyre sheet into a square and threw away three quarters of its
    // horizontal detail — the same bug the viewer had, reintroduced here in the
    // renderer built to catch bugs like it. `inside` bounds the long side and
    // leaves the ratio alone.
    .resize(size, size, { fit: 'inside', withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height };
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function norm(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/**
 * The same light rig the viewer uses, and deliberately the same.
 *
 * If this shaded differently from the editor then a shot would answer a
 * question about the shot rather than about what the person is looking at. A
 * hemisphere for sky and ground, one key light, and a white clearcoat lobe —
 * white because the highlight on a car is the sky in the lacquer, not the paint.
 */
function shade(rgb, n, v) {
  const key = norm([0.4, 0.85, 0.35]);
  const amb = (i, lo, hi) => lo + (hi - lo) * (n[1] * 0.5 + 0.5);
  const ambient = [amb(0, 0.20, 0.52), amb(1, 0.19, 0.60), amb(2, 0.18, 0.72)];
  const nl = Math.max(0, dot(n, key) * 0.75 + 0.25);
  const h = norm([key[0] + v[0], key[1] + v[1], key[2] + v[2]]);
  const spec = Math.pow(Math.max(0, dot(n, h)), 90) * 0.55
    + Math.pow(1 - Math.max(0, dot(n, v)), 5) * 0.10;

  const out = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const lit = (rgb[k] / 255) * (ambient[k] * 0.85 + [1.0, 0.97, 0.91][k] * nl * 0.95) + spec;
    out[k] = Math.round(255 * Math.min(1, lit / (1 + lit * 0.22)));
  }
  return out;
}

/**
 * Render the model to raw RGBA.
 *
 * `sheets` maps a group's role to rasterised artwork. A group with no entry is
 * drawn bare grey, which is honest: it says "your design does not paint this"
 * rather than inventing something.
 */
export function rasterise(model, groups, sheets, {
  width = 900, height = 560, view = 'left', background = [0x10, 0x10, 0x16],
} = {}) {
  // hasOwn rather than a lookup with a fallback: `VIEWS['constructor']` is
  // truthy and has no yaw, which yields NaN everywhere downstream and a picture
  // that looks like an empty stage rather than an error.
  const { yaw, pitch } = Object.hasOwn(VIEWS, view) ? VIEWS[view] : VIEWS.left;
  const { positions, uvs, normals, indices } = model;

  let lo = [Infinity, Infinity, Infinity];
  let hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (positions[i + k] < lo[k]) lo[k] = positions[i + k];
      if (positions[i + k] > hi[k]) hi[k] = positions[i + k];
    }
  }
  const target = [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2);
  const span = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 4;
  const dist = span * 1.15;
  const eye = [
    target[0] + dist * Math.cos(pitch) * Math.sin(yaw),
    target[1] + dist * Math.sin(pitch),
    target[2] + dist * Math.cos(pitch) * Math.cos(yaw),
  ];

  // A camera basis rather than a composed matrix. Every time this project has
  // multiplied matrices by hand the result has been a camera inside the car.
  const fwd = norm(sub(target, eye));
  // Negated against the obvious choice, and the picture is why. The other sign
  // gives a perfectly plausible car with every piece of text written backwards
  // — which no amount of staring at the cross products would have told me.
  const right = norm([-fwd[2], 0, fwd[0]]);
  // right x fwd. Paired with the sign above: get either one wrong on its own
  // and the car is upside down or mirrored, get both wrong and it is both.
  const up = [
    right[1] * fwd[2] - right[2] * fwd[1],
    right[2] * fwd[0] - right[0] * fwd[2],
    right[0] * fwd[1] - right[1] * fwd[0],
  ];
  const focal = (height / 2) / Math.tan(0.32);

  const px = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    px[i * 4] = background[0]; px[i * 4 + 1] = background[1];
    px[i * 4 + 2] = background[2]; px[i * 4 + 3] = 255;
  }
  const depth = new Float32Array(width * height).fill(Infinity);

  const project = (i) => {
    const p = [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
    const d = sub(p, eye);
    const z = dot(d, fwd);
    if (z <= 0.01) return null;                 // behind the camera
    return {
      x: width / 2 + (dot(d, right) * focal) / z,
      y: height / 2 - (dot(d, up) * focal) / z,
      z,
    };
  };

  for (const g of groups) {
    const art = sheets.get(g.role) ?? null;
    for (let t = g.start; t < g.start + g.count; t += 3) {
      const ia = indices[t], ib = indices[t + 1], ic = indices[t + 2];
      const A = project(ia), B = project(ib), C = project(ic);
      if (!A || !B || !C) continue;

      const minX = Math.max(0, Math.floor(Math.min(A.x, B.x, C.x)));
      const maxX = Math.min(width - 1, Math.ceil(Math.max(A.x, B.x, C.x)));
      const minY = Math.max(0, Math.floor(Math.min(A.y, B.y, C.y)));
      const maxY = Math.min(height - 1, Math.ceil(Math.max(A.y, B.y, C.y)));
      if (maxX < minX || maxY < minY) continue;

      const area = (B.x - A.x) * (C.y - A.y) - (C.x - A.x) * (B.y - A.y);
      if (Math.abs(area) < 1e-9) continue;

      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          const cx = x + 0.5, cy = y + 0.5;
          let w0 = ((B.x - cx) * (C.y - cy) - (C.x - cx) * (B.y - cy)) / area;
          let w1 = ((C.x - cx) * (A.y - cy) - (A.x - cx) * (C.y - cy)) / area;
          let w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;

          const z = w0 * A.z + w1 * B.z + w2 * C.z;
          const at = y * width + x;
          if (z >= depth[at]) continue;
          depth[at] = z;

          let rgb = BARE;
          if (art) {
            // Nearest, not bilinear. The shot is small, the artwork is large,
            // and a blurred sample would hide exactly the hard edge — a name
            // clipped by a panel seam — that this is for.
            const u = w0 * uvs[ia * 2] + w1 * uvs[ib * 2] + w2 * uvs[ic * 2];
            const v = w0 * uvs[ia * 2 + 1] + w1 * uvs[ib * 2 + 1] + w2 * uvs[ic * 2 + 1];
            const sx = Math.min(art.w - 1, Math.max(0, Math.floor(u * art.w)));
            const sy = Math.min(art.h - 1, Math.max(0, Math.floor(v * art.h)));
            const o = (sy * art.w + sx) * 4;
            rgb = [art.data[o], art.data[o + 1], art.data[o + 2]];
          }

          let n = norm([
            w0 * normals[ia * 3] + w1 * normals[ib * 3] + w2 * normals[ic * 3],
            w0 * normals[ia * 3 + 1] + w1 * normals[ib * 3 + 1] + w2 * normals[ic * 3 + 1],
            w0 * normals[ia * 3 + 2] + w1 * normals[ib * 3 + 2] + w2 * normals[ic * 3 + 2],
          ]);
          // Both faces are drawn, as in the viewer, so a normal can point away
          // from the camera on a perfectly visible surface.
          const toEye = [-fwd[0], -fwd[1], -fwd[2]];
          if (dot(n, toEye) < 0) n = [-n[0], -n[1], -n[2]];

          const c = shade(rgb, n, toEye);
          px[at * 4] = c[0]; px[at * 4 + 1] = c[1]; px[at * 4 + 2] = c[2];
        }
      }
    }
  }
  return { data: px, width, height };
}

/** Render and encode. `surfaces` is [{ role, svg }] as /api/preview returns. */
export async function shoot(model, groups, surfaces, opts = {}) {
  const sheets = new Map();
  for (const s of surfaces) {
    if (s.role && s.svg) sheets.set(s.role, await sheet(s.svg));
  }
  const { data, width, height } = rasterise(model, groups, sheets, opts);
  return sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
}
