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
 * Bounded on purpose, but not as tightly as it was. 512 left every texel
 * several pixels wide once the frame grew and the sampling supersampled, which
 * reads as a staircase on lettering — not edge aliasing, and nothing
 * supersampling can touch.
 *
 * 1024 rather than the source's 2048 because of where the cost is: librsvg
 * takes ~167 ms at 512, ~270 ms at 1024 and ~3.0 s at 2048 for one of these
 * sheets, and seven of those is twenty seconds for a screenshot somebody is
 * waiting on. The build's own preview does not come through here — it holds
 * the rendered PNGs already and decodes them at full size for ~13 ms each.
 */
async function sheet(svg, size = 1024) {
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
 *
 * The third case is a two-layer material, where the base is the per-part
 * occlusion bake named in `detail.diffuse` and neither role nor file is set.
 * Those used to fall through to grey, so every carbon, alcantara and brushed
 * metal surface in the cockpit rendered flat — which is most of an interior.
 */
const sheetKey = (g) => g.role ?? g.file ?? g.detail?.diffuse ?? null;

/**
 * One bilinear sample, into `out` rather than a fresh array — this is the
 * innermost thing in the renderer and it runs a few tens of millions of times.
 *
 * `wrap` repeats rather than clamping, which is the difference between the two
 * layers of a MultiMap material: a bake is a per-part atlas whose UVs stay
 * inside [0,1] and whose neighbours are a different part, so reaching past the
 * edge must not fetch them; a detail map is a small square of carbon or suede
 * tiled hundreds of times across a panel, and clamping it would smear one row
 * of texels across everything past the first repeat.
 */
function sampleTexel(tex, u, v, wrap, out) {
  const w = tex.w; const h = tex.h; const d = tex.data;
  // Half a texel back, because texel CENTRES sit at (i + 0.5) / size. Without
  // it every sample is biased up and left and a 1:1 sheet comes out soft.
  const fx = u * w - 0.5;
  const fy = v * h - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  let xa; let xb; let ya; let yb;
  if (wrap) {
    xa = ((x0 % w) + w) % w; xb = (((x0 + 1) % w) + w) % w;
    ya = ((y0 % h) + h) % h; yb = (((y0 + 1) % h) + h) % h;
  } else {
    xa = x0 < 0 ? 0 : (x0 > w - 1 ? w - 1 : x0);
    xb = x0 + 1 < 0 ? 0 : (x0 + 1 > w - 1 ? w - 1 : x0 + 1);
    ya = y0 < 0 ? 0 : (y0 > h - 1 ? h - 1 : y0);
    yb = y0 + 1 < 0 ? 0 : (y0 + 1 > h - 1 ? h - 1 : y0 + 1);
  }
  const oa = (ya * w + xa) * 4; const ob = (ya * w + xb) * 4;
  const oc = (yb * w + xa) * 4; const od = (yb * w + xb) * 4;
  for (let k = 0; k < 4; k++) {
    const top = d[oa + k] + (d[ob + k] - d[oa + k]) * tx;
    const bot = d[oc + k] + (d[od + k] - d[oc + k]) * tx;
    out[k] = top + (bot - top) * ty;
  }
  return out;
}

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
  // The ground the car stands on. AC's own showroom previews put it on a dark
  // reflective floor, and without one a render floats in a void — which is the
  // difference between a picture of a car and a picture of a mesh.
  //
  // `false` for the mirrored pass below, which must not recurse, and for any
  // caller that wants the geometry and nothing else.
  floor = true,
  // The box to frame, when the caller already knows it. The mirrored pass needs
  // this: derived from its own positions it would frame the reflection rather
  // than the car, and the two passes have to share one camera exactly.
  bounds = null,
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

  let lo = bounds ? [...bounds.lo] : [Infinity, Infinity, Infinity];
  let hi = bounds ? [...bounds.hi] : [-Infinity, -Infinity, -Infinity];
  if (!bounds) {
    for (let i = 0; i < positions.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        if (positions[i + k] < lo[k]) lo[k] = positions[i + k];
        if (positions[i + k] > hi[k]) hi[k] = positions[i + k];
      }
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
    // Alpha is COVERAGE, not transparency: nothing below writes it except a
    // fragment landing, so a caller that starts it at zero can ask afterwards
    // which pixels the model actually reached. The mirrored pass does exactly
    // that; every ordinary caller starts at 255 and never notices.
    px[i * 4 + 2] = background[2]; px[i * 4 + 3] = background[3] ?? 255;
  }
  const depth = new Float32Array(width * height).fill(Infinity);

  // ---------------------------------------------------------------------
  // The ground, before the car, so the car simply draws over it.
  //
  // There is no floor SURFACE here and there does not need to be one. AC's
  // showroom previews are a black room: what tells you the car is standing on
  // something is the reflection under it and the dark that gathers where it
  // meets the floor. Both are composited onto the background over the pixels
  // whose ray reaches the ground plane, and nothing else changes.
  // ---------------------------------------------------------------------
  if (floor) {
    const groundY = lo[1];
    const cx = (lo[0] + hi[0]) / 2;
    const cz = (lo[2] + hi[2]) / 2;
    // A shade wider than the box, because a car's shadow is: the body
    // overhangs the wheels and the light is not a point.
    //
    // Floored against the model's overall SPAN rather than against epsilon. A
    // thing with no extent in one axis — a flat panel, a single quad — has a
    // degenerate footprint, and dividing by that put the whole shadow inside a
    // millimetre and the reflection nowhere, which looked exactly like the
    // floor not working at all.
    const rx = Math.max((hi[0] - lo[0]) / 2, span * 0.05) * 1.12;
    const rz = Math.max((hi[2] - lo[2]) / 2, span * 0.05) * 1.12;

    // The car again, upside down about the ground plane. Winding reverses and
    // it does not matter: this renderer draws both faces and turns the normal
    // to the camera, so a mirrored triangle shades like the one it came from.
    const flipped = new Float32Array(positions.length);
    for (let i = 0; i < positions.length; i += 3) {
      flipped[i] = positions[i];
      flipped[i + 1] = 2 * groundY - positions[i + 1];
      flipped[i + 2] = positions[i + 2];
    }
    const flipNormals = new Float32Array(normals.length);
    for (let i = 0; i < normals.length; i += 3) {
      flipNormals[i] = normals[i];
      flipNormals[i + 1] = -normals[i + 1];
      flipNormals[i + 2] = normals[i + 2];
    }
    // ALREADY IN SAMPLE SPACE: width and height here are the supersampled
    // pair, so asking for one sample of exactly this size reproduces this
    // pass's camera to the pixel, and the reflection gets its antialiasing
    // from the same box-down at the end that the car does.
    const mirror = rasterise(
      { positions: flipped, uvs, normals: flipNormals, indices },
      groups, sheets,
      { width, height, view, samples: 1, floor: false, bounds: { lo, hi },
        background: [0, 0, 0, 0] },
    );

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        // The ray this pixel looks along, in the basis the projection uses.
        const sx = x + 0.5 - width / 2;
        const sy = height / 2 - (y + 0.5);
        const dy = fwd[1] * focal + right[1] * sx + up[1] * sy;
        if (dy > -1e-9) continue;                   // level with or above the horizon
        const t = (groundY - eye[1]) / dy;
        if (t <= 0) continue;                       // the plane is behind the camera
        const hx = eye[0] + t * (fwd[0] * focal + right[0] * sx + up[0] * sy);
        const hz = eye[2] + t * (fwd[2] * focal + right[2] * sx + up[2] * sy);
        // Squared distance from the footprint, in units of the footprint, so
        // one falloff constant works for a hatchback and a prototype alike.
        const ex = (hx - cx) / rx;
        const ez = (hz - cz) / rz;
        const d2 = ex * ex + ez * ez;

        const at = (y * width + x) * 4;
        // Contact shadow. The falloff is in units of the footprint, and it
        // was tighter: at 2.4 the shadow is 8% dark by the edge of the
        // ellipse, which means all of it is under the car, where the car is
        // standing on it and nobody can see it. Reaching a little past the
        // silhouette is what makes the car look placed rather than pasted.
        //
        // There is not much room to work in either way. The floor is the
        // background, #101016, so the whole dynamic range of a shadow here is
        // twenty-odd levels down to black. AC's own previews have the same
        // problem and solve it the same way — what actually grounds the car in
        // those is the reflection, and this is the quieter half.
        const dark = Math.exp(-d2 * 1.3) * 0.85;
        for (let k = 0; k < 3; k++) px[at + k] = Math.round(px[at + k] * (1 - dark));

        // Reflection, wherever the mirrored car reached this pixel. Weaker
        // with distance — a real floor is not a mirror — and weaker again
        // inside the shadow, which is what stops the reflection from glowing
        // brightest exactly where the car occludes the light.
        if (mirror.data[at + 3]) {
          const w = Math.exp(-d2 * 0.55) * 0.34 * (1 - 0.5 * (dark / 0.9));
          for (let k = 0; k < 3; k++) {
            px[at + k] = Math.round(px[at + k] * (1 - w) + mirror.data[at + k] * w);
          }
        }
      }
    }
  }

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

  // Reused across every fragment rather than allocated per sample.
  const base = [0, 0, 0, 0];
  const grain = [0, 0, 0, 0];

  for (const g of order) {
    const art = sheets.get(sheetKey(g)) ?? null;
    // The tiling half of a two-layer material, and how many times it repeats.
    // `detail.bake` is the recorded fact about the layer UNDER it: a bake is
    // an occlusion map and multiplies straight through, and anything else is
    // a colour map, where the game's own x2 keeps the mid-grey of the detail
    // sheet from halving the surface. Same rule the editor's shader follows.
    const layer = g.detail ? (sheets.get(g.detail.detail) ?? null) : null;
    const layerMult = g.detail?.mult ?? 1;
    const layerGain = g.detail?.bake ? 1 : 2;
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
          // Hoisted out of the `art` branch: the detail layer needs them too,
          // and it can be present on a group whose base sheet is missing.
          const u = w0 * uvs[ia * 2] + w1 * uvs[ib * 2] + w2 * uvs[ic * 2];
          const v = w0 * uvs[ia * 2 + 1] + w1 * uvs[ib * 2 + 1] + w2 * uvs[ic * 2 + 1];
          if (art) {
            // Bilinear, and it was nearest.
            //
            // Nearest was argued for on the grounds that a blurred sample would
            // hide the hard edge this exists to show — a name clipped by a
            // panel seam. That holds when a texel is smaller than a pixel. Here
            // it is bigger: the sheets magnify, and nearest under magnification
            // does not preserve an edge, it invents a staircase along it and
            // squares off every letter.
            //
            // With a full-resolution sheet the ratio is near 1:1, where the two
            // filters agree anyway, and bilinear is the one that stays honest
            // as the sheet shrinks relative to the frame.
            // CLAMPED. An island's UVs can run a hair outside [0,1] and
            // wrapping there would fetch a neighbouring island's artwork onto
            // the edge of this one.
            sampleTexel(art, u, v, false, base);
            rgb = [base[0], base[1], base[2]];
            alpha = base[3] / 255;
          }

          // The second layer, over whatever the first one gave — including
          // over BARE, since a group can have a detail map and no base sheet
          // and grey times carbon still reads as carbon.
          if (layer) {
            sampleTexel(layer, u * layerMult, v * layerMult, true, grain);
            // A NEW array, never a write into `rgb`. With no base sheet `rgb`
            // is still BARE, which is a module constant shared by every group
            // in the render — multiplying into it would turn the car's grey
            // black from the first detail fragment onwards.
            const k = layerGain / 255;
            rgb = [
              Math.min(255, rgb[0] * grain[0] * k),
              Math.min(255, rgb[1] * grain[1] * k),
              Math.min(255, rgb[2] * grain[2] * k),
            ];
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
          px[at * 4 + 3] = 255;                     // covered — see the fill
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
