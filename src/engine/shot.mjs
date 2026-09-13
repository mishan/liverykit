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
// It is NOT a substitute for the editor. It has one light rig, no normal maps
// and no reflections, so a windscreen or a mirror never looks like glass here the
// way it does in the game. It DOES wear the car's own stock textures on the
// parts a design does not paint — sheetKey and carSheets, below, are the two
// halves of that — and a caller that supplies none of them gets bare grey
// there rather than something invented. What this can answer is the
// question I kept getting wrong: does the artwork land where I said it
// would, and does the car still look like a car.
// ---------------------------------------------------------------------------

import sharp from 'sharp';

import { decodeDds } from './pipeline.mjs';

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
  // From above and ahead, the way a person first looks at a car. The low
  // front-left misses the bonnet and roof, and that is where a stripe or a
  // roundel cut by a shut line shows.
  'three-quarter': { yaw: Math.PI / 4, pitch: 0.55 },
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
 * Every texture of the CAR'S OWN that a render of these groups wants: the
 * diffuse of a part the design does not paint, and both halves of a two-layer
 * material — the per-part occlusion bake underneath and the small tiling
 * material over it.
 *
 * Both halves of a two-layer material, because half of one is not a surface:
 * the bake underneath is a greyscale photograph of the part's own shadows and
 * the tiling layer over it is what carries the carbon weave or the nap on the
 * alcantara. Only a group the design leaves unpainted ever carries the pair —
 * `wholeModelGeometry` reads the material for a detail layer only where it has
 * no trustworthy diffuse to paint — so this walk is over the car's own parts
 * throughout, and a painted role wears the design on every layer it has.
 */
export function carTextureFiles(groups) {
  const wanted = new Set();
  for (const g of groups) {
    if (g.role === null && g.file) wanted.add(g.file);
    if (g.detail?.diffuse) wanted.add(g.detail.diffuse);
    if (g.detail?.detail) wanted.add(g.detail.detail);
  }
  return wanted;
}

/**
 * Those textures, decoded into sheets `rasterise` can sample.
 *
 * This lived in the build, which was the only caller that had it, and `shoot`
 * was the caller that needed it: an MCP screenshot built `sheets` out of the
 * painted surfaces alone, so glass, wheels and the whole interior came out
 * BARE grey in the one renderer an agent working without a browser can see,
 * while the editor beside it drew the real materials. Two renderers
 * disagreeing about what the car looks like is how a change gets verified
 * against the wrong picture, and it has happened.
 *
 * `load(file)` hands back the bytes the kn5 holds for one texture, or null: a
 * lookup over a model parsed with `keepTextureData` in the build, the editor's
 * single-flight stock loader in the server. Decoding happens here, so the two
 * agree about what counts as a texture and about what to say when one does not
 * arrive.
 *
 * `cache` is a Map the caller keeps between calls, holding a decoded sheet or
 * the sentence saying why there is none. The car's own artwork does not change
 * while a process is up, and decoding is an ImageMagick run per texture —
 * thirty-odd of them for one shot of a GT3 car, and all of them again for the
 * next angle somebody asks for.
 */
export async function carSheets(groups, load, { cache = null } = {}) {
  const sheets = new Map();
  // SAID OUT LOUD. A texture that does not arrive costs nothing visible — the
  // part just draws grey — which is how an entire cockpit rendered flat for
  // weeks while the editor showed it properly. An encrypted kn5 legitimately
  // has none of these, so it is a note rather than a failure.
  const absent = [];
  for (const file of carTextureFiles(groups)) {
    // Cached by the LOWERCASED name and returned under the spelling this group
    // uses, since nothing in the format stops two materials spelling one
    // texture differently and `sheets` is read back by sheetKey.
    const key = String(file).toLowerCase();
    if (cache?.has(key)) {
      const hit = cache.get(key);
      if (typeof hit === 'string') absent.push(hit); else sheets.set(file, hit);
      continue;
    }
    let data = null;
    let sheet = null;
    let why = null;
    // A loader that THROWS is a fact about the model rather than about this
    // texture — the editor's stock loader rejects once for a kn5 it could not
    // read at all, and rejects the same way for every file after it. So each
    // file it was asked for is absent and each says why, which is what keeps
    // the count the caller reports equal to the number of parts drawing grey.
    // Not cached: the loader is entitled to recover, and a cached throw would
    // make one bad moment permanent.
    try {
      data = await load(file);
    } catch (e) {
      absent.push(`${file} (${e.message})`);
      continue;
    }
    // A 1x1-ish blob is not a small texture, it is an absent one: an encrypted
    // kn5 substitutes placeholders and keeps the real artwork somewhere this
    // project does not decrypt. Same threshold the editor's stockTexture uses,
    // so the two never disagree about what counts as real.
    if (!data || data.length <= 256) why = String(file);
    else {
      sheet = await decodeDds(Buffer.from(data));
      if (!sheet) why = `${file} (undecodable)`;
    }
    if (sheet) sheets.set(file, sheet); else absent.push(why);
    cache?.set(key, sheet ?? why);
  }
  return { sheets, absent };
}

/**
 * Where the camera goes so the car fills the frame.
 *
 * The distance used to be `span * 1.15` — the longest side of the bounding box
 * and a fudge factor. For a car the longest side is its LENGTH, which from any
 * three-quarter view is the axis most foreshortened, so the distance was set by
 * an extent that barely appears. The car sat small in a frame with a lot of
 * empty sky, which against the previews a car ships with was the last obvious
 * tell that this is a render.
 *
 * Fitted to the VERTICES, not to the bounding box. A car's box is much bigger
 * than the car: from the front-left the far rear corner projects into a patch
 * of frame the bodywork never reaches, and fitting the box reserves room for
 * it — which is a smaller car sitting off to one side, and was the first thing
 * this got wrong.
 *
 * Iterated rather than solved. Projected size goes as roughly 1/distance, but
 * only roughly, since the vertices' own depths move as the camera does; each
 * pass measures, recentres, rescales, and re-measures. Two or three passes get
 * within a fraction of a percent and the rest cost nothing.
 */
export function frameCamera(positions, { yaw, pitch }, { width, height, focal, span, centre }) {
  // Room left under the car for its reflection, as a fraction of the car's own
  // projected height. Taken in SCREEN space rather than by extending the model
  // downward, because that is where the reflection actually is — and because
  // the amount wanted is a fraction of what you can see, not of the geometry.
  const REFLECTION = 0.45;
  const fitW = (width / 2) * 0.94;      // a little air on every side, as the
  const fitH = (height / 2) * 0.94;     // previews a car ships with leave
  const SETTLED = 0.002;

  // The camera must stay OUTSIDE the model, and nothing about fitting the frame
  // says so on its own: the fit constrains the two extents across the view and
  // says nothing about the one along it. A long model viewed down its length
  // lets the solver pull the camera in through the bodywork, at which point a
  // vertex a hair in front of the lens projects to thousands of pixels, `need`
  // explodes, and the next pass flings the camera far enough away that the one
  // after it comes back in — an oscillation that ends wherever the pass count
  // happens to stop it.
  //
  // Bounding SPHERE about the centre, so the floor holds whichever way the
  // camera is pointing. A car never reaches it — the width binds long before —
  // which is exactly why this had to be looked for rather than noticed.
  let radius = 0;
  for (let i = 0; i < positions.length; i += 3) {
    const dx = positions[i] - centre[0];
    const dy = positions[i + 1] - centre[1];
    const dz = positions[i + 2] - centre[2];
    const r2 = dx * dx + dy * dy + dz * dz;
    if (r2 > radius) radius = r2;
  }
  const minDist = Math.sqrt(radius) * 1.05 + 1e-3;

  let target = [...centre];
  let dist = Math.max(minDist, span * 1.15);
  let eye; let fwd; let right; let up;

  // A BRACKET, because `dist *= need` is not as safe as it looks. It assumes
  // projected size goes as 1/distance, which holds while the model is far
  // compared to its own depth and stops holding when it is not: a long thin
  // model seen down its length has vertices near the lens and vertices far
  // from it, the near ones dominate the measurement, and the step overshoots.
  // It then overshoots back, and the answer is wherever the pass count leaves
  // it. Once a distance is known too close and another known too far, the
  // answer is between them and bisection gets there instead of guessing again.
  let tooClose = 0;
  let tooFar = Infinity;

  for (let pass = 0; pass < 12; pass++) {
    eye = [
      target[0] + dist * Math.cos(pitch) * Math.sin(yaw),
      target[1] + dist * Math.sin(pitch),
      target[2] + dist * Math.cos(pitch) * Math.cos(yaw),
    ];
    // A camera basis rather than a composed matrix. Every time this project has
    // multiplied matrices by hand the result has been a camera inside the car.
    fwd = norm(sub(target, eye));
    // Negated against the obvious choice, and the picture is why. The other
    // sign gives a perfectly plausible car with every piece of text written
    // backwards — which no amount of staring at the cross products would have
    // told me.
    right = norm([-fwd[2], 0, fwd[0]]);
    // right x fwd. Paired with the sign above: get either one wrong on its own
    // and the car is upside down or mirrored, get both wrong and it is both.
    up = [
      right[1] * fwd[2] - right[2] * fwd[1],
      right[2] * fwd[0] - right[0] * fwd[2],
      right[0] * fwd[1] - right[1] * fwd[0],
    ];

    let minX = Infinity; let maxX = -Infinity;
    let minY = Infinity; let maxY = -Infinity;
    let seen = 0;
    for (let i = 0; i < positions.length; i += 3) {
      const dx = positions[i] - eye[0];
      const dy = positions[i + 1] - eye[1];
      const dz = positions[i + 2] - eye[2];
      const z = dx * fwd[0] + dy * fwd[1] + dz * fwd[2];
      // Behind the camera contributes nothing to a frame it cannot appear in.
      if (z <= 1e-4) continue;
      const sx = ((dx * right[0] + dy * right[1] + dz * right[2]) * focal) / z;
      const sy = ((dx * up[0] + dy * up[1] + dz * up[2]) * focal) / z;
      if (sx < minX) minX = sx;
      if (sx > maxX) maxX = sx;
      if (sy < minY) minY = sy;
      if (sy > maxY) maxY = sy;
      seen += 1;
    }
    // Nothing in front of the camera at all: it is inside the model, and no
    // amount of scaling from here can reason about that. Back off and retry.
    if (!seen) { dist *= 2; continue; }

    minY -= (maxY - minY) * REFLECTION;

    // Centred FIRST. The projected outline is not symmetric about the
    // projection of the model's centre, so measuring the fit before recentring
    // reserves room for an offset that is about to go away.
    //
    // BOTH the target and the eye, by the same vector. Translating the pair is
    // what leaves the view direction alone — fwd is norm(target - eye), and a
    // shared translation cancels out of the difference. Moving only the target
    // would have swung the camera, and, worse, the eye recomputed from it at
    // the top of the NEXT pass is a pass that may never run: on the iteration
    // where the distance settles, this loop breaks a few lines below, and the
    // recentring it just worked out would have been thrown away with it.
    const offX = (minX + maxX) / 2;
    const offY = (minY + maxY) / 2;
    const panX = offX * dist / focal;
    const panY = offY * dist / focal;
    const pan = [0, 1, 2].map((k) => right[k] * panX + up[k] * panY);
    target = [0, 1, 2].map((k) => target[k] + pan[k]);
    eye = [0, 1, 2].map((k) => eye[k] + pan[k]);

    const need = Math.max((maxX - minX) / 2 / fitW, (maxY - minY) / 2 / fitH);
    if (!Number.isFinite(need) || need <= 0) break;
    if (need > 1) tooClose = Math.max(tooClose, dist);
    else tooFar = Math.min(tooFar, dist);
    // Geometric, not arithmetic: distance acts on projected size multiplicatively,
    // so the midpoint that matters is the one in the ratio.
    const step = tooClose > 0 && tooFar < Infinity
      ? Math.sqrt(tooClose * tooFar)
      : dist * need;
    const next = Math.max(minDist, step);

    // BOTH have to have settled, and the distance counts as settled when it
    // has stopped moving for either reason — it is where it wants to be, or it
    // is against the floor that keeps the camera outside the model and cannot
    // go further.
    //
    // The pan matters just as much. It is a correction measured before it is
    // applied, and under perspective applying it moves the outline by not
    // quite the amount asked for, so stopping the moment the scale settles
    // returns a camera carrying whatever of the last pan did not land. One
    // more pass measures the remainder; that is the whole method, and leaving
    // the pan out of the test made the loop stop just before it did its job.
    const held = Math.abs(need - 1) < SETTLED || next === dist;
    if (held && Math.hypot(offX, offY) < 0.5) break;
    dist = next;
  }
  return { eye, fwd, right, up };
}

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
 * What a named view is looking at: its angles, the model's bounds, and the lens.
 *
 * One function for the picture and for the measurement of what a picture
 * shows (`piecesInView`), because the two are only worth comparing if they are
 * the same camera. Everything here scales with the frame, so a measurement
 * taken at one size describes a picture taken at another.
 */
function viewFrame(positions, view, width, height) {
  // hasOwn rather than a lookup with a fallback: `VIEWS['constructor']` is
  // truthy and has no yaw, which yields NaN everywhere downstream and a picture
  // that looks like an empty stage rather than an error.
  //
  // RESOLVED ONCE and passed on. This was guarded here and then looked up
  // again, unguarded, on the way into frameCamera — so the fallback protected
  // the projection and the camera got the NaN anyway, which is the same empty
  // stage by a longer route. One name, used by both.
  const angles = Object.hasOwn(VIEWS, view) ? VIEWS[view] : VIEWS.left;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (positions[i + k] < lo[k]) lo[k] = positions[i + k];
      if (positions[i + k] > hi[k]) hi[k] = positions[i + k];
    }
  }
  return {
    angles, lo, hi,
    span: Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 4,
    focal: (height / 2) / Math.tan(0.32),
    centre: [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2),
  };
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
  // A camera to use verbatim rather than one derived from this model. The
  // mirrored pass needs it: its vertices are the car upside down, so framing
  // them would frame the reflection, and the two passes have to agree to the
  // pixel or the reflection slides out from under the car.
  camera = null,
} = {}) {
  // Everything below works in SAMPLE space and the result is boxed down at the
  // end, so the projection, the depth buffer and the triangle walk are the
  // ones they always were and only the two numbers changed.
  const ss = Math.max(1, Math.min(4, Math.round(samples) || 1));
  const width = outWidth * ss;
  const height = outHeight * ss;
  const { positions, uvs, normals, indices } = model;
  const frame = viewFrame(positions, view, width, height);
  const { lo, hi, span, focal } = frame;

  // Reused verbatim when the caller states one — see the mirrored pass, which
  // has to look through this pass's camera and cannot derive it, since its own
  // vertices are the car upside down.
  const cam = camera ?? frameCamera(positions, frame.angles,
    { width, height, focal, span, centre: frame.centre });
  const { eye, fwd, right, up } = cam;

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
      // THE PARENT'S BACKGROUND, with alpha zero. Alpha is what carries
      // coverage here, and the colour still has to match: a blended surface —
      // glass above all — composites against whatever is behind it, so a
      // mirror pass run against black reflects a differently-coloured
      // windscreen than the one standing above it.
      { width, height, view, samples: 1, floor: false, camera: cam,
        background: [background[0], background[1], background[2], 0] },
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

          let rgb = BARE;
          let alpha = 1;
          // Interpolated once for both layers, and only when one of them is
          // going to read it. The detail layer needs the same u and v as the
          // base and can be present on a group whose base sheet is missing, so
          // they cannot live inside the `art` branch — but a group that draws
          // BARE with no detail map reads neither, and this is the inner loop.
          if (art || layer) {
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
          }

          // A CUTOUT TEXEL IS NOT DRAWN AT ALL — see `alphaTest` in kn5.mjs. A
          // grille, a stitch line, the badge on this car's nose: the surface is
          // opaque where it is drawn and absent where it is not, and there is
          // no third state. Composited instead, the absent part is drawn as
          // whatever colour sits under it, which on a cutout sheet is black.
          if (g.alphaTest != null && alpha < g.alphaTest) continue;

          // Depth WRITE only for opaque groups, so two blended surfaces do not
          // occlude each other. Depth TEST still applies to both, so bodywork
          // hides what is behind it.
          //
          // AFTER the cutout, and that ordering is the point: this used to
          // write depth the moment a fragment passed the depth test, before it
          // had sampled anything. A thrown-away texel that had already written
          // depth occludes what is behind it, so a grille would be a hole in
          // the car rather than a grille.
          if (!g.blend) depth[at] = z;

          let n = norm([
            w0 * normals[ia * 3] + w1 * normals[ib * 3] + w2 * normals[ic * 3],
            w0 * normals[ia * 3 + 1] + w1 * normals[ib * 3 + 1] + w2 * normals[ic * 3 + 1],
            w0 * normals[ia * 3 + 2] + w1 * normals[ib * 3 + 2] + w2 * normals[ic * 3 + 2],
          ]);
          // Both faces are drawn, as in the viewer, so a normal can point away
          // from the camera on a perfectly visible surface.
          const toEye = [-fwd[0], -fwd[1], -fwd[2]];
          if (dot(n, toEye) < 0) n = [-n[0], -n[1], -n[2]];

          // Glass gets a FLOOR under its alpha rather than a replacement for
          // it. AC's glass shaders take most of their transparency from the
          // shader — a fresnel and a reflection map — and a windscreen drawn
          // from its diffuse alone read as a flat grey slab, which is why this
          // used to overwrite the texture's alpha outright.
          //
          // What that threw away is the one thing the sheet really does say:
          // the black frit printed around the edge of the glass. On this
          // Abarth it is the bottom 128 rows of INTERNAL_Glass.dds at alpha
          // 255 against 16 for the rest, and it is what fills the band between
          // the bonnet and the glass. Without it you look straight through the
          // base of the windscreen at the dashboard, and the car has a gap
          // where its cowl should be.
          //
          // `max`, so a bare glass surface — this repository has cars whose
          // glass texture nothing could decode — still gets the rim it always
          // had, and a sheet that really is clear is not made cloudy by one.
          let rim = 0;
          if (g.glass) {
            rim = glassFresnel(n, toEye);
            alpha = Math.max(art ? alpha : 0, Math.min(1, 0.15 + 0.75 * rim));
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

/** A texel's alpha, 0 to 1, nearest rather than filtered: this is a yes or no. */
function alphaAt(tex, u, v) {
  const x = Math.min(tex.w - 1, Math.max(0, Math.floor(u * tex.w)));
  const y = Math.min(tex.h - 1, Math.max(0, Math.floor(v * tex.h)));
  return tex.data[(y * tex.w + x) * 4 + 3] / 255;
}

/**
 * How much of each piece of artwork a view shows, counted rather than judged.
 *
 * The critic's worst mistake was calling a whole roundel "cut off": four of the
 * six eval cases that had one, and most of the wasted rounds and money. The
 * fitment check casts from forty-nine directions and says how visible a piece
 * is in general, which is not what was being argued about. Whether it is whole
 * in the LEFT VIEW is a question about pixels in a picture this project draws
 * itself, so it can be answered by counting.
 *
 * Two passes, neither of them a picture. The first draws the whole car and
 * keeps, for every pixel, the triangle nearest the camera and the texture
 * coordinate it shows there. The second, one per piece, draws only the
 * triangles whose texture reaches that piece, with nothing else in front. A
 * pixel of the piece in the second pass that the first pass also shows is seen;
 * one the first pass gives to something else is hidden, and what it was given
 * to is named. Shown over the second pass's count is how much of the piece
 * this view shows.
 *
 * No shading, one sample per pixel and nearest texel, because a blended or
 * filtered pixel belongs to two things at once and cannot be counted as either.
 *
 * `pieces` are shapes in a texture: `{ role, box: [u0, v0, u1, v1], contains(u,
 * v) }`. Only faces turned toward the camera count, so the far door does not
 * score through a gap in the near one; every face still hides what is behind
 * it, as it does in the picture.
 *
 * What covers is what the picture draws opaque. Glass is drawn and hides
 * nothing — the paint under a windscreen's frit is seen through it — and a glow
 * adds light rather than standing in front. A cutout or a decal covers where its
 * own alpha says it is there, which needs its sheet; a design's own surfaces are
 * not rasterised for this, and count as covering everywhere.
 */
export function piecesInView(model, groups, sheets, pieces, { view = 'left', width = 900, height = 540 } = {}) {
  const { positions, uvs, normals, indices } = model;
  const frame = viewFrame(positions, view, width, height);
  const { focal } = frame;
  const { eye, fwd, right, up } = frameCamera(positions, frame.angles,
    { width, height, focal, span: frame.span, centre: frame.centre });

  // Every vertex projected once. A triangle's corners are shared with its
  // neighbours, and projecting per triangle did that sum six times over.
  const nv = positions.length / 3;
  const sx = new Float32Array(nv);
  const sy = new Float32Array(nv);
  const sz = new Float32Array(nv);
  for (let i = 0; i < nv; i++) {
    const dx = positions[i * 3] - eye[0];
    const dy = positions[i * 3 + 1] - eye[1];
    const dz = positions[i * 3 + 2] - eye[2];
    const z = dx * fwd[0] + dy * fwd[1] + dz * fwd[2];
    sz[i] = z;
    if (z <= 0.01) continue;
    sx[i] = width / 2 + ((dx * right[0] + dy * right[1] + dz * right[2]) * focal) / z;
    sy[i] = height / 2 - ((dx * up[0] + dy * up[1] + dz * up[2]) * focal) / z;
  }

  // The same coverage rule as `rasterise` — pixel centres, barycentric weights
  // all non-negative — inside a window of the frame.
  const walk = (t, x0, y0, x1, y1, visit) => {
    const ia = indices[t], ib = indices[t + 1], ic = indices[t + 2];
    if (sz[ia] <= 0.01 || sz[ib] <= 0.01 || sz[ic] <= 0.01) return;
    const ax = sx[ia], ay = sy[ia], bx = sx[ib], by = sy[ib], cx = sx[ic], cy = sy[ic];
    const minX = Math.max(x0, Math.floor(Math.min(ax, bx, cx)));
    const maxX = Math.min(x1 - 1, Math.ceil(Math.max(ax, bx, cx)));
    const minY = Math.max(y0, Math.floor(Math.min(ay, by, cy)));
    const maxY = Math.min(y1 - 1, Math.ceil(Math.max(ay, by, cy)));
    if (maxX < minX || maxY < minY) return;
    const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if (Math.abs(area) < 1e-9) return;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5, py = y + 0.5;
        const w0 = ((bx - px) * (cy - py) - (cx - px) * (by - py)) / area;
        const w1 = ((cx - px) * (ay - py) - (ax - px) * (cy - py)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        visit(x, y, w0 * sz[ia] + w1 * sz[ib] + w2 * sz[ic], w0, w1, w2, ia, ib, ic);
      }
    }
  };
  const uvAt = (w0, w1, w2, ia, ib, ic, k) => w0 * uvs[ia * 2 + k] + w1 * uvs[ib * 2 + k] + w2 * uvs[ic * 2 + k];

  // Pass one: the whole car.
  const depth = new Float32Array(width * height).fill(Infinity);
  const who = new Int32Array(width * height).fill(-1);
  const hitU = new Float32Array(width * height);
  const hitV = new Float32Array(width * height);
  const groupOf = new Int32Array(indices.length / 3).fill(-1);
  for (const [gi, g] of groups.entries()) {
    for (let t = g.start; t < g.start + g.count; t += 3) groupOf[t / 3] = gi;
    if (g.lod === 'LR' || g.glass || g.add) continue;
    const art = sheets.get(sheetKey(g)) ?? null;
    if (g.blend && !art) continue;                  // not drawn in the picture either
    const cut = art ? (g.alphaTest ?? (g.blend ? 0.5 : null)) : null;
    for (let t = g.start; t < g.start + g.count; t += 3) {
      walk(t, 0, 0, width, height, (x, y, z, w0, w1, w2, ia, ib, ic) => {
        const at = y * width + x;
        if (z >= depth[at]) return;
        const u = uvAt(w0, w1, w2, ia, ib, ic, 0);
        const v = uvAt(w0, w1, w2, ia, ib, ic, 1);
        if (cut !== null && alphaAt(art, u, v) < cut) return;
        depth[at] = z; who[at] = t; hitU[at] = u; hitV[at] = v;
      });
    }
  }

  const facing = (t) => {
    const ia = indices[t], ib = indices[t + 1], ic = indices[t + 2];
    let d = 0;
    for (let k = 0; k < 3; k++) {
      const n = normals[ia * 3 + k] + normals[ib * 3 + k] + normals[ic * 3 + k];
      const c = (positions[ia * 3 + k] + positions[ib * 3 + k] + positions[ic * 3 + k]) / 3;
      d += n * (eye[k] - c);
    }
    return d > 0;
  };
  const partName = (g) => g.role ?? g.file ?? g.detail?.diffuse ?? 'an untextured part';
  // The mesh a triangle came from, by name, where the geometry records it — see
  // `parts` in wholeModelGeometry. In index order, so a binary search.
  const parts = model.parts ?? [];
  const meshOf = (t) => {
    let a = 0, b = parts.length - 1;
    while (a <= b) {
      const mid = (a + b) >> 1;
      if (t < parts[mid].start) b = mid - 1;
      else if (t >= parts[mid].start + parts[mid].count) a = mid + 1;
      else return parts[mid].name;
    }
    return null;
  };

  // Pass two: each piece with nothing in front of it.
  return pieces.map((piece) => {
    const [u0, v0, u1, v1] = piece.box;
    const mine = [];
    let bx0 = width, by0 = height, bx1 = 0, by1 = 0;
    for (const g of groups) {
      if (g.role !== piece.role || g.lod === 'LR') continue;
      for (let t = g.start; t < g.start + g.count; t += 3) {
        const ia = indices[t], ib = indices[t + 1], ic = indices[t + 2];
        const tu0 = Math.min(uvs[ia * 2], uvs[ib * 2], uvs[ic * 2]);
        const tu1 = Math.max(uvs[ia * 2], uvs[ib * 2], uvs[ic * 2]);
        const tv0 = Math.min(uvs[ia * 2 + 1], uvs[ib * 2 + 1], uvs[ic * 2 + 1]);
        const tv1 = Math.max(uvs[ia * 2 + 1], uvs[ib * 2 + 1], uvs[ic * 2 + 1]);
        if (tu1 < u0 || tu0 > u1 || tv1 < v0 || tv0 > v1) continue;
        if (sz[ia] <= 0.01 || sz[ib] <= 0.01 || sz[ic] <= 0.01) continue;
        mine.push(t);
        bx0 = Math.min(bx0, sx[ia], sx[ib], sx[ic]); bx1 = Math.max(bx1, sx[ia], sx[ib], sx[ic]);
        by0 = Math.min(by0, sy[ia], sy[ib], sy[ic]); by1 = Math.max(by1, sy[ia], sy[ib], sy[ic]);
      }
    }
    const x0 = Math.max(0, Math.floor(bx0)), y0 = Math.max(0, Math.floor(by0));
    const x1 = Math.min(width, Math.ceil(bx1) + 1), y1 = Math.min(height, Math.ceil(by1) + 1);
    const none = { whole: 0, shown: 0, blockers: [], box: null };
    if (!mine.length || x1 <= x0 || y1 <= y0) return none;

    const bw = x1 - x0, bh = y1 - y0;
    const d2 = new Float32Array(bw * bh).fill(Infinity);
    const w2 = new Int32Array(bw * bh).fill(-1);
    const u2 = new Float32Array(bw * bh);
    const v2 = new Float32Array(bw * bh);
    for (const t of mine) {
      walk(t, x0, y0, x1, y1, (x, y, z, a, b, c, ia, ib, ic) => {
        const at = (y - y0) * bw + (x - x0);
        if (z >= d2[at]) return;
        d2[at] = z; w2[at] = t;
        u2[at] = uvAt(a, b, c, ia, ib, ic, 0);
        v2[at] = uvAt(a, b, c, ia, ib, ic, 1);
      });
    }

    const faces = new Map();
    let whole = 0, shown = 0;
    let px0 = Infinity, py0 = Infinity, px1 = -Infinity, py1 = -Infinity;
    const blockers = new Map();
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y - y0) * bw + (x - x0);
        const t = w2[i];
        if (t < 0 || !piece.contains(u2[i], v2[i])) continue;
        if (!faces.has(t)) faces.set(t, facing(t));
        if (!faces.get(t)) continue;
        whole++;
        px0 = Math.min(px0, x); py0 = Math.min(py0, y); px1 = Math.max(px1, x + 1); py1 = Math.max(py1, y + 1);
        const at = y * width + x;
        const t1 = who[at];
        // Seen when the whole car gives this pixel to the same triangle, to a
        // surface at the same depth, or to another triangle painting the same
        // piece — mirrored bodywork shares its texels, and either side showing
        // the artwork is the artwork showing. Half a millimetre, because a
        // door handle stands a few millimetres proud and a tie is a tie.
        if (t1 === t || depth[at] >= d2[i] - 0.0005
          || (t1 >= 0 && groups[groupOf[t1 / 3]]?.role === piece.role && piece.contains(hitU[at], hitV[at]))) {
          shown++;
          continue;
        }
        const key = t1 >= 0 ? `${meshOf(t1) ?? ''}\u0000${partName(groups[groupOf[t1 / 3]])}` : '\u0000nothing';
        blockers.set(key, (blockers.get(key) ?? 0) + 1);
      }
    }
    if (!whole) return none;
    return {
      whole,
      shown,
      // What stands in front: the mesh where it has a name, and the texture
      // it wears, which says whether it is part of the same painted surface.
      blockers: [...blockers].sort((a, b) => b[1] - a[1]).map(([k, px]) => {
        const [mesh, sheet] = k.split('\u0000');
        return { mesh: mesh || null, sheet, px };
      }),
      // Where the piece sits in the frame and how much of it it takes, as
      // fractions of the frame, so the answer does not depend on its size.
      box: [px0 / width, py0 / height, (px1 - px0) / width, (py1 - py0) / height],
    };
  });
}

/**
 * Render and encode. `surfaces` is [{ role, svg }] as /api/preview returns.
 *
 * `sheets` in the options is the CAR'S OWN artwork for what the design leaves
 * alone — see carSheets — and the design's own surfaces are laid over it. The
 * two cannot collide: those are keyed by file and these by role.
 */
/**
 * The views on a contact sheet, in reading order: three across, two down.
 *
 * `top` and `front` joined the first four because the bonnet, the roof and the
 * nose were where no view looked squarely. A Gulf centre stripe drawn ACROSS
 * the car instead of along it was ticked "present" by a critic that had only
 * glimpsed the bonnet from a three-quarter view, and nothing showed the nose.
 */
export const SHEET_VIEWS = ['three-quarter', 'left', 'right', 'top', 'front', 'rear-left'];

/**
 * Several views of the car in one picture, each labelled.
 *
 * For a caller that pays per look. A model reading a picture is charged
 * roughly by its area, so four half-size views cost about what four separate
 * pictures would — but every look is also a turn, and a turn re-reads the
 * whole conversation and thinks again. Measured on a real run, that was most
 * of the bill and the pictures were a tenth of it. One sheet is one turn.
 *
 * The design's textures are rasterised once and shared by the four cameras,
 * so here too it costs little more than one view.
 */
export async function shootSheet(model, groups, surfaces, { sheets: stock = null, width = 1400, height = 840, views = SHEET_VIEWS } = {}) {
  const sheets = new Map(stock ?? []);
  for (const s of surfaces) {
    if (s.role && s.svg) sheets.set(s.role, await sheet(s.svg));
  }
  // Two across for up to four views, three for more. The size asked for,
  // exactly: what does not divide goes to the last column and the last row.
  const nc = views.length > 4 ? 3 : 2;
  const nr = Math.ceil(views.length / nc);
  const split = (total, n) => Array.from({ length: n }, (_, i) =>
    (i < n - 1 ? Math.floor(total / n) : total - Math.floor(total / n) * (n - 1)));
  const cols = split(width, nc);
  const rows = split(height, nr);
  const cells = [];
  let skipped = 0;
  for (const [i, view] of views.entries()) {
    const c = i % nc, r = Math.floor(i / nc);
    const img = rasterise(model, groups, sheets, { view, width: cols[c], height: rows[r] });
    skipped = Math.max(skipped, img.skipped);
    cells.push({ input: img.data, raw: { width: img.width, height: img.height, channels: 4 },
      left: c * cols[0], top: r * rows[0] });
  }
  // Named on the picture itself: a reader told "the rear three-quarter shows a
  // cut roundel" has to be able to find which view that is.
  const labels = views.map((v, i) => `<text x="${(i % nc) * cols[0] + 10}" y="${Math.floor(i / nc) * rows[0] + 22}" ` +
    `font-family="DejaVu Sans, sans-serif" font-size="16" fill="#d8dde3">${v}</text>`).join('');
  const overlay = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${labels}</svg>`);
  const png = await sharp({ create: { width, height, channels: 4, background: { r: 12, g: 13, b: 16, alpha: 1 } } })
    .composite([...cells, { input: overlay, left: 0, top: 0 }])
    .png()
    .toBuffer();
  return { png, skipped };
}

export async function shoot(model, groups, surfaces, { sheets: stock = null, ...opts } = {}) {
  const sheets = new Map(stock ?? []);
  for (const s of surfaces) {
    if (s.role && s.svg) sheets.set(s.role, await sheet(s.svg));
  }
  const { data, width, height, skipped } = rasterise(model, groups, sheets, opts);
  const png = await sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
  return { png, skipped };
}
