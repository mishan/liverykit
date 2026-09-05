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
// It is NOT a substitute for the editor. It has one light rig and no
// reflections, so a windscreen or a mirror never looks like glass here the
// way it does in the game. A caller CAN hand it the car's own stock textures
// for the parts a design does not paint — sheetKey, below, is what makes
// that possible — but nothing requires it, and without them those parts
// draw bare grey rather than invent something. What this can answer is the
// question I kept getting wrong: does the artwork land where I said it
// would, and does the car still look like a car.
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
//
// Yaw places the eye: x = sin(yaw), z = cos(yaw), around the car. The car's
// left is +X — a profile takes that from WHEEL_LF, and a left-hand-drive car's
// steering wheel confirms it — so the `left` view puts the eye at +X and looks
// across at the left flank. It sat at -X until a stripe painted on left_mid
// alone appeared only in the `right` view: every "left" shot this renderer
// had produced was of the right-hand side, and a nearly symmetric livery had
// let it pass. The text-direction fix further down was tuned against those
// pictures and is unaffected, since it is about the image plane, not the
// side of the car.
export const VIEWS = {
  left: { yaw: Math.PI / 2, pitch: 0.12 },
  right: { yaw: -Math.PI / 2, pitch: 0.12 },
  front: { yaw: 0, pitch: 0.15 },
  rear: { yaw: Math.PI, pitch: 0.15 },
  'front-left': { yaw: Math.PI / 4, pitch: 0.22 },
  'rear-left': { yaw: 3 * Math.PI / 4, pitch: 0.22 },
  top: { yaw: Math.PI / 2, pitch: 1.35 },
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
function shade(rgb, n, v, { rim = 0 } = {}) {
  const key = norm([0.4, 0.85, 0.35]);
  const amb = (i, lo, hi) => lo + (hi - lo) * (n[1] * 0.5 + 0.5);
  const ambient = [amb(0, 0.20, 0.52), amb(1, 0.19, 0.60), amb(2, 0.18, 0.72)];
  const nl = Math.max(0, dot(n, key) * 0.75 + 0.25);
  const h = norm([key[0] + v[0], key[1] + v[1], key[2] + v[2]]);
  // `rim` is the caller's own fresnel term — see glassFresnel — rather than a
  // second one computed here, so a glass surface's highlight and its alpha
  // agree about which pixels are "edge-on": recomputed independently with a
  // different exponent, the two used to disagree right where it shows, along
  // the curve of a window.
  const spec = Math.pow(Math.max(0, dot(n, h)), 90) * 0.55
    + Math.pow(1 - Math.max(0, dot(n, v)), 5) * 0.10
    + rim * 0.7;

  const out = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const lit = (rgb[k] / 255) * (ambient[k] * 0.85 + [1.0, 0.97, 0.91][k] * nl * 0.95) + spec;
    out[k] = Math.round(255 * Math.min(1, lit / (1 + lit * 0.22)));
  }
  return out;
}

/**
 * How mirror-like a glass surface looks from here — 0 dead-on, toward 1 at a
 * grazing angle. Real automotive glass is closer to a Fresnel reflector than
 * to a translucent sheet: you see straight through the windscreen looking
 * square at it and see mostly sky and your own reflection looking along it.
 * `ksPerPixelReflection`/`ksWindscreen` are how AC gets that, with an actual
 * environment map this project has no way to sample — this is the cheap
 * stand-in, and it is what turns "invisible or a grey slab" into something
 * that reads as glass at all.
 */
const glassFresnel = (n, v) => Math.pow(1 - Math.max(0, dot(n, v)), 2.5);

/**
 * Which key a group's artwork is filed under in `sheets` — its role for a
 * painted surface, its file for a part the design leaves to the car's own
 * texture (`role` is null there; see wholeModelGeometry). A group with
 * neither draws bare grey, which is honest: it says "nobody supplied art for
 * this" rather than inventing something.
 */
const sheetKey = (g) => g.role ?? g.file;

/**
 * Render the model to raw RGBA.
 *
 * `sheets` maps a sheetKey to rasterised artwork — see above.
 */
export function rasterise(model, groups, sheets, {
  width: outWidth = 900, height: outHeight = 560, view = 'left',
  background = [0x10, 0x10, 0x16],
  // Rendered this many times over in each direction and averaged back down.
  //
  // One sample at the pixel centre makes a triangle's edge a step function, and
  // against AC's own showroom previews that is the single most obvious tell:
  // the jaggies climb a wing endplate and a wheel's spokes, and a fine repeated
  // pattern in the artwork — a row of dots along a bonnet — aliases into moire
  // that is not in the design. There is no cheap analytic fix in a scanline
  // rasteriser; there is just sampling more often.
  //
  // Two is the default because it removes most of it for four times the
  // fragments, and the fragments are the cost here. Three is visibly better
  // still on thin geometry and costs nine.
  samples = 2,
} = {}) {
  // Everything below works in SAMPLE space and the result is boxed down at the
  // end, so the projection, the depth buffer and the triangle walk are the
  // ones they always were and only the two numbers changed.
  const ss = Math.max(1, Math.min(4, Math.round(samples) || 1));
  const width = outWidth * ss;
  const height = outHeight * ss;
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

  // Opaque first, then blended back to front, because compositing reads what
  // is already there. `skipped` counts what could not be drawn rather than
  // drawing something plausible instead.
  let skipped = 0;
  const order = [...groups].filter((g) => {
    // A car that ships two cockpits tags them, and exactly one gets drawn:
    // both would z-fight the interior into a checkerboard seen through the
    // glass. The high-detail one, matching the editor — see the note beside
    // `paint` in view3d.js for why this is not the one the game would pick.
    if (g.lod === 'LR') return false;
    if (!g.blend) return true;
    // Glass is drawn even with no artwork — see glassFresnel. Its colour
    // barely comes from a texture in the game either; a bare surface shaded
    // with the fresnel rim is closer to a windscreen than skipping it is.
    if (g.glass) return true;
    // Any other blended group with no artwork is a decal or an emissive mask
    // this project has nothing to draw. A caller that has the car's own stock
    // texture for it keys the entry by FILE instead of role — see sheetKey —
    // and only when neither is on offer does this skip, rather than standing
    // grey in for it: grey is opaque, and the whole point of these surfaces
    // is that they are not. Skipping says "not shown" and leaves the
    // bodywork visible through the hole, which is nearer the truth than a
    // slab.
    if (!sheets.has(sheetKey(g))) { skipped++; return false; }
    return true;
  });

  // BACK TO FRONT among the blended ones, which the comment above claimed and
  // the code did not do: the sort only pushed blended after opaque, so two
  // overlapping transparent surfaces composited in whatever order the groups
  // happened to arrive. The viewer sorts by group centroid and this did not,
  // which is the two renderers drifting again.
  //
  // Per group, so triangles inside one are still unordered. Enough to stop an
  // emissive mask compositing before the plate it sits on.
  const centre = (g) => {
    let x = 0, y = 0, z = 0, n = 0;
    for (let i = g.start; i < g.start + g.count; i += 8) {
      const v = indices[i] * 3;
      x += positions[v]; y += positions[v + 1]; z += positions[v + 2]; n++;
    }
    return n ? [x / n, y / n, z / n] : [0, 0, 0];
  };
  const far = new Map(order.filter((g) => g.blend).map((g) => {
    const c = centre(g);
    return [g, (c[0] - eye[0]) ** 2 + (c[1] - eye[1]) ** 2 + (c[2] - eye[2]) ** 2];
  }));
  order.sort((a, b) => {
    if (!a.blend && !b.blend) return 0;
    if (a.blend !== b.blend) return a.blend ? 1 : -1;
    return far.get(b) - far.get(a);
  });

  for (const g of order) {
    const art = sheets.get(sheetKey(g)) ?? null;
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
          // Depth WRITE only for opaque groups, so two blended surfaces do not
          // occlude each other. Depth TEST still applies to both, so bodywork
          // hides what is behind it.
          if (!g.blend) depth[at] = z;

          let rgb = BARE;
          let alpha = 1;
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
            alpha = art.data[o + 3] / 255;
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

          // Glass overrides whatever the texture's alpha channel says. AC's
          // glass shaders get their transparency from the shader (fresnel and
          // a reflection map), not from the diffuse texture — its alpha tends
          // to be fully opaque, which is why glass drawn with the ordinary
          // rule read as a flat grey slab instead of a window.
          let rim = 0;
          if (g.glass) {
            rim = glassFresnel(n, toEye);
            alpha = Math.min(1, 0.15 + 0.75 * rim);
          }
          if (g.blend && alpha <= 0.01) continue;      // nothing to composite

          const c = shade(rgb, n, toEye, { rim });
          // ADDITIVE for emissive sheets, alpha for everything else — the same
          // rule the viewer follows, and for the same reason. An emissive
          // texture is a glow map, black where nothing glows; alpha-compositing
          // an opaque black one puts a black rectangle over whatever it was
          // meant to light. `add` was already on the group and this ignored it,
          // so the shot could still show the failure it was built to catch.
          if (g.add) {
            for (let k = 0; k < 3; k++) {
              px[at * 4 + k] = Math.min(255, px[at * 4 + k] + Math.round(c[k] * alpha));
            }
          } else {
            const a = g.blend ? alpha : 1;
            for (let k = 0; k < 3; k++) {
              px[at * 4 + k] = Math.round(c[k] * a + px[at * 4 + k] * (1 - a));
            }
          }
        }
      }
    }
  }
  if (ss === 1) return { data: px, width, height, skipped };

  // Box filter, which is what averaging a square block of samples is. Nothing
  // fancier earns its place: the samples are already a uniform grid inside the
  // pixel, and a weighted kernel over them would be reconstructing detail the
  // grid never had.
  const out = Buffer.alloc(outWidth * outHeight * 4);
  const n = ss * ss;
  for (let y = 0; y < outHeight; y++) {
    for (let x = 0; x < outWidth; x++) {
      let r = 0; let g = 0; let b = 0; let a = 0;
      for (let sy = 0; sy < ss; sy++) {
        const row = (y * ss + sy) * width + x * ss;
        for (let sx = 0; sx < ss; sx++) {
          const o = (row + sx) * 4;
          r += px[o]; g += px[o + 1]; b += px[o + 2]; a += px[o + 3];
        }
      }
      const o = (y * outWidth + x) * 4;
      out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n); out[o + 3] = Math.round(a / n);
    }
  }
  return { data: out, width: outWidth, height: outHeight, skipped };
}

/** Render and encode. `surfaces` is [{ role, svg }] as /api/preview returns. */
export async function shoot(model, groups, surfaces, opts = {}) {
  const sheets = new Map();
  for (const s of surfaces) {
    if (s.role && s.svg) sheets.set(s.role, await sheet(s.svg));
  }
  const { data, width, height, skipped } = rasterise(model, groups, sheets, opts);
  const png = await sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
  return { png, skipped };
}
