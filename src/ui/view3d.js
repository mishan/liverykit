// ---------------------------------------------------------------------------
// The car, in three dimensions, with the live texture on it.
//
// A UV view answers "where on the sheet", which is the question you can already
// see. It cannot answer the one that matters — is that spot flat, does it face
// anyone, does the number wrap over a wheel arch — and no amount of dragging
// rectangles will make it.
//
// Hand-written WebGL rather than a library. The whole project has no runtime
// dependencies and works offline; adding three.js would mean vendoring a
// megabyte to draw one textured mesh with an orbit camera, which is about two
// hundred lines done directly. The trade would be different if this needed
// lighting, shadows or materials. It does not: the texture IS the answer, and
// anything shaded on top of it would be lying about the colours.
// ---------------------------------------------------------------------------

const VS = `
attribute vec3 position;
attribute vec2 uv;
attribute vec3 normal;
attribute vec3 tangent;
uniform mat4 mvp;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vT;
varying vec3 vP;
void main() {
  vUv = uv;
  // Not normalised here. Interpolation across a triangle shortens it anyway,
  // and the fragment shader has to re-orthogonalise against the normal before
  // using it, which normalises as a side effect. A mesh packed without
  // tangents sends zeroes, and the length test there is what catches that.
  vT = tangent;
  // The vertices arrive in world space already — the kn5 node transforms were
  // baked in when the geometry was built — so there is no model matrix to undo
  // and the normal needs no inverse transpose.
  vN = normal;
  vP = position;
  gl_Position = mvp * vec4(position, 1.0);
}`;

// LIGHTING IS A MODE, and the reason it is a mode is worth keeping.
//
// This shader used to draw the raw texture and say so: "no lighting on purpose,
// a shaded preview would misreport the artwork's colour, which is the one thing
// this view exists to show honestly." That is still true, and it is why `lit`
// can be turned off and why the UV tab never had this problem at all.
//
// But it answered the wrong question for the whole-car view. That view exists
// to tell you whether the design works ON THE CAR, and an unlit slab cannot:
// you cannot see how a stripe crosses a curve, where a shoulder turns away from
// the light, or which panels the eye actually lands on. The car looked nothing
// like the car in the game, and "nothing like the game" is a real answer to
// "will this look right".
//
// So: shaded by default, honest colour one click away, and the highlight
// overlay drawn AFTER the shading so the thing you are dragging keeps its
// contrast in shadow.
//
// No environment map, no image-based lighting, nothing fetched. A hemisphere
// for the sky and the ground, one key light, one fill from behind, and a
// clearcoat lobe — which is most of what car paint does and costs nothing.
const FS = `
// HIGHP WHERE THE HARDWARE HAS IT, and the reason is the detail maps.
//
// mediump carries about ten bits of mantissa. A detail map is sampled at
// vUv * detailUVMultiplier, and this car's carbon tiles at 500 — so the
// coordinate reaches ~377, where the smallest representable step is
// 377 * 2^-10, about 0.37. The texture repeats every 1.0 in that space, which
// leaves roughly three distinguishable sample positions per repeat: the weave
// collapses into big quantised rectangles and the surface reads as a coarse
// mosaic drawn forty times too large. The alcantara at 50 gets ~28 steps and
// is merely blocky, which is why the seat looked bad and the dashboard looked
// broken.
//
// Guarded rather than assumed: highp is optional in a GLSL ES 1.0 fragment
// shader, and a device without it must still compile something.
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D map;
// A SECOND layer, for parts whose material says one texture is not the whole
// story. See detailLayer in kn5.mjs: an occlusion bake on its own is a
// greyscale photograph of a part's own shadows, and it is the small tiling
// material multiplied over it that carries the carbon weave, the brushed
// metal or the alcantara. detailMult is the material's OWN tiling factor —
// 500 on this car's carbon, 50 on its alcantara — and is never guessed.
// (No backticks anywhere in here: this is a template literal, and one closes
// the shader mid-comment for a syntax error forty lines from the cause.)
uniform sampler2D detail;
uniform float detailMult;
uniform float detailOnly;  // 1 = the diffuse is a bake, so the detail IS the surface
uniform sampler2D detailNormal;
uniform float hasDetailNormal;
uniform float detailNormalBlend;
uniform float hasDetail;  // 1 = multiply the tiling layer over the diffuse
// How this particular material answers light, already calibrated against car
// paint on the way in — see lightingFor. One shading model for a whole car
// means a matte textile gets a clearcoat highlight, and reads as a pale sheen.
uniform float matAmbient;
uniform float matDiffuse;
uniform float matSpecular;
uniform float matExponent;
uniform vec4 region;      // what you are working on; w = 0 means no selection
uniform vec4 panel;       // its host panel, the boundary it is clamped to
uniform vec4 twin;        // its opposite number, which moves with it
uniform vec4 twinPanel;   // and where that one lives
uniform float border;     // border thickness, in UV units
uniform float lit;        // 0 = true colour, 1 = shaded like a car
uniform float glass;      // 1 = this group is reflective glass
// 1 = take this group's transparency from the texture's alpha channel.
//
// NOT unconditional, and the canvas is why: it is created with an alpha
// channel, so an opaque pass that writes alpha below 1 lets the page show
// through the car. Only the alpha-blended pass asks for this, and only for
// groups that are not glass — glass builds its own from the fresnel below.
uniform float texAlpha;
uniform vec3 eye;         // camera position, for the specular lobes
varying vec2 vUv;
varying vec3 vN;
varying vec3 vT;
varying vec3 vP;

bool within(vec4 r, vec2 p) {
  vec2 d = p - r.xy;
  return r.z > 0.0 && d.x >= 0.0 && d.y >= 0.0 && d.x <= r.z && d.y <= r.w;
}
float edgeDist(vec4 r, vec2 p) {
  vec2 d = p - r.xy;
  return min(min(d.x, r.z - d.x), min(d.y, r.w - d.y));
}

/**
 * What the paint does with the light.
 *
 * Deliberately not a PBR pipeline. There is no roughness map, no metalness and
 * no environment probe to sample — inventing them would be guessing, and a
 * confident-looking guess about how a car reflects is exactly the kind of thing
 * that would make a livery look good here and wrong in the game.
 *
 * What IS defensible: bodywork is a dielectric with a clear lacquer over it, so
 * a broad diffuse term, a tight specular highlight that does not take the
 * paint's colour, and a Fresnel rim that brightens at grazing angles. Those
 * three are what make a car read as a curved metal object rather than a decal
 * sheet, and none of them needs an asset.
 */
vec3 shade(vec3 albedo, vec3 n, vec3 v, float glassRim) {
  vec3 key = normalize(vec3(0.4, 0.85, 0.35));
  vec3 rim = normalize(vec3(-0.6, 0.25, -0.7));

  // Sky above, ground bounce below. A car photographed outdoors gets most of
  // its light this way, and it is what stops the underside going pure black.
  vec3 sky = vec3(0.52, 0.60, 0.72);
  vec3 ground = vec3(0.20, 0.19, 0.18);
  vec3 ambient = mix(ground, sky, n.y * 0.5 + 0.5);

  // Wrapped, so the terminator is soft. A hard lambert edge on a car body
  // reads as a crease that is not there.
  float nl = max(0.0, dot(n, key) * 0.75 + 0.25);
  vec3 diffuse = albedo * (ambient * matAmbient + vec3(1.0, 0.97, 0.91) * nl * matDiffuse);
  diffuse += albedo * vec3(0.35, 0.42, 0.55) * max(0.0, dot(n, rim)) * 0.35;

  // Clearcoat. WHITE, not tinted by the paint: the highlight on a car is the
  // sky in the lacquer, and colouring it by the artwork underneath is the
  // single most common way a shaded preview lies about a livery.
  vec3 h = normalize(key + v);
  float spec = pow(max(0.0, dot(n, h)), matExponent) * matSpecular;
  float fres = pow(1.0 - max(0.0, dot(n, v)), 5.0);
  // glassRim is the caller's own fresnel term, the same one alpha is built
  // from in main() — computed once there rather than twice here, so a
  // window's highlight and its transparency agree about which pixels are
  // edge-on.
  spec += fres * 0.10 + glassRim * 0.7;

  vec3 c = diffuse + vec3(spec);
  // A gentle shoulder so the highlight rolls off instead of clipping to a flat
  // white patch. Not a tone mapper — the input is already display-referred.
  return c / (1.0 + c * 0.22);
}

void main() {
  vec4 texel = texture2D(map, vUv);
  vec3 c = texel.rgb;
  // Two ways to put the layers together, and which one is right depends
  // entirely on what the DIFFUSE underneath actually is.
  //
  // A real colour map takes the ordinary overlay: a detail sheet is authored
  // against mid-grey meaning "leave this alone", so 0.5 * 2 = 1 and nothing
  // changes where the detail is neutral. Skip the doubling and every part
  // wearing one comes out at half brightness, which reads as a lighting bug.
  //
  // A BAKE multiplies WITHOUT the doubling, because it is not an overlay: it
  // is shading, and the detail is the material it shades. Occlusion times
  // material is what those two layers actually mean.
  //
  // The doubling is what made this look broken before. A detail map averaging
  // near the 0.5 neutral point — metal_detail_2 is 0.559 — cancels against it
  // and leaves the raw bake on screen, and INT_HR_Occlusion is near-black
  // across its whole atlas except one bright island, which is the dashboard
  // cowl. So the dash rendered white and everything around it black.
  //
  // Dropping the bake entirely was the previous attempt at that, and it went
  // too far the other way: it threw away the baked shadows and left every
  // surface flat, with the pale parts pale for want of anything to shade them.
  // Multiplying at unit scale keeps both — the material's own colour, and the
  // occlusion that gives it depth — and cannot brighten anything, since the
  // bake is never above one.
  if (hasDetail > 0.5) {
    vec3 d = texture2D(detail, vUv * detailMult).rgb;
    c = mix(c * d * 2.0, c * d, detailOnly);
  }
  // The alpha-blended pass runs gl.blendFunc(SRC_ALPHA, ONE_MINUS_SRC_ALPHA),
  // and this used to hand it a hard 1.0 for everything that was not glass —
  // which composites as fully opaque and makes the whole pass a no-op for the
  // surfaces it exists for. A decal sheet or a mask carries its shape in the
  // alpha channel; ignoring it draws the transparent part as whatever colour
  // happens to sit under it. The detail layer above multiplies COLOUR only,
  // so it has nothing to say about coverage.
  float alpha = texAlpha > 0.5 ? texel.a : 1.0;

  // Both faces are drawn, because car meshes are not reliably wound, so a
  // normal can point away from the camera on a perfectly visible surface.
  // Flipping it is what stops the far side of a shell rendering black.
  // Computed unconditionally — glass needs it for alpha even in true-colour
  // mode, where lit never reaches shade() at all.
  vec3 v = normalize(eye - vP);
  vec3 n = normalize(vN);
  if (dot(n, v) < 0.0) n = -n;

  // THE GRAIN OF THE MATERIAL, which is most of what tells two matte surfaces
  // apart. A colour map says alcantara is dark grey; so is flat paint. What
  // says suede is a nap that catches the light at a thousand angles at once,
  // and that lives in the detail normal map — the one texture the material
  // points at that nothing here was reading.
  //
  // It is also the honest answer to "why does the seat look reflective". On a
  // perfectly smooth normal any specular arrives as one broad sheen, which
  // reads as plastic no matter how far the strength is wound down. Break the
  // normal up and the same highlight scatters into something that reads as
  // fabric — the material stops looking polished without losing its light.
  //
  // Re-orthogonalised against the normal rather than trusted as it arrives:
  // interpolating a tangent across a triangle leaves it neither unit length
  // nor square to the normal, and the cross product needs both. The length
  // test is what a mesh packed without tangents falls through — it sends
  // zeroes, and a zero tangent would otherwise normalise to garbage and tilt
  // every fragment the same wrong way.
  if (hasDetailNormal > 0.5) {
    vec3 t = vT - n * dot(n, vT);
    if (dot(t, t) > 1e-8) {
      t = normalize(t);
      vec3 bt = cross(n, t);
      vec3 nm = texture2D(detailNormal, vUv * detailMult).rgb * 2.0 - 1.0;
      // Only the sideways components are scaled. Scaling z as well would tilt
      // the whole surface rather than change how deep its grain reads.
      nm.xy *= detailNormalBlend;
      n = normalize(t * nm.x + bt * nm.y + n * nm.z);
    }
  }

  // Glass gets its transparency from THIS, not from the texture's alpha
  // channel — AC's glass shaders build it from a reflection map this project
  // has no way to sample, and the diffuse alpha they ship tends to be fully
  // opaque. Without it, glass painted the ordinary way is a flat, solid slab.
  float glassRim = 0.0;
  if (glass > 0.5) {
    glassRim = pow(1.0 - max(0.0, dot(n, v)), 2.5);
    alpha = min(1.0, 0.15 + 0.75 * glassRim);
  }

  if (lit > 0.5) c = shade(c, n, v, glassRim);

  // AFTER the shading, deliberately. The highlight is UI, not artwork: a
  // selection outline that dims when the panel turns away from the light is a
  // selection outline you lose exactly when you are dragging it out of view.
  if (region.z > 0.0) {
    vec3 dark = vec3(0.02, 0.03, 0.04);
    vec3 accent = vec3(0.0, 0.94, 1.0);
    vec3 amber = vec3(1.0, 0.71, 0.33);

    if (within(region, vUv)) {
      vec2 d = vUv - region.xy;
      // The far corner, the quarter that resizes. Solid, so it reads as a
      // handle rather than as part of the artwork.
      if (d.x > region.z * 0.75 && d.y > region.w * 0.75) c = mix(c, accent, 0.55);
      else if (edgeDist(region, vUv) < border) c = mix(c, accent, 0.9);
    } else if (within(twin, vUv)) {
      // The opposite number: same true colour, a quieter outline, and NO grab
      // corner. It moves when this one moves, but it is not what the pointer
      // is holding, and drawing it identically would invite grabbing the wrong
      // one on a car where both flanks are in view at once.
      if (edgeDist(twin, vUv) < border) c = mix(c, accent, 0.45);
    } else if (within(panel, vUv) || within(twinPanel, vUv)) {
      c = mix(c, dark, 0.42);
      float e = within(panel, vUv) ? edgeDist(panel, vUv) : edgeDist(twinPanel, vUv);
      if (e < border) c = mix(c, amber, 0.75);
    } else {
      c = mix(c, dark, 0.82);
    }
  }
  gl_FragColor = vec4(c, alpha);
}`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error(`shader: ${gl.getShaderInfoLog(sh)}`);
  }
  return sh;
}

// --- the smallest matrix maths that does the job ----------------------------

function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) / (near - far), -1,
    0, 0, (2 * far * near) / (near - far), 0];
}

function lookAt(eye, at, up) {
  const z = norm(sub(eye, at));
  const x = norm(cross(up, z));
  const y = cross(z, x);
  return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1];
}

/**
 * Column-major product, matching how these matrices are stored and how GLSL
 * reads them.
 *
 * `perspective` and `lookAt` above both build COLUMN-major arrays — that is the
 * convention `uniformMatrix4fv(..., transpose = false)` expects — and this was
 * originally written as a row-major multiply. The composed matrix then sent
 * points behind the camera: a vertex that should land at w = 4.7 came out at
 * w = -0.3, which is the far side of the eye. The result was a view from inside
 * the car, looking out through the shell with all the lettering mirrored.
 *
 * Element (row r, column c) lives at [c * 4 + r], so the sum runs down a's rows
 * and across b's columns in that layout.
 */
function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = sum;
    }
  }
  return o;
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function norm(v) { const l = Math.hypot(...v) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }

/**
 * Where a ray meets a triangle, and where that is in texture space.
 *
 * Möller–Trumbore, returning the barycentric coordinates as well as the
 * distance, because the barycentrics are the whole point: they interpolate the
 * triangle's UVs to the exact texel under the cursor. A hit position in 3D would
 * only have to be converted back into one.
 *
 * Culling is deliberately off. Car meshes are not reliably wound one way — the
 * renderer already draws both faces for that reason — and a back-facing triangle
 * you can plainly see should be pickable.
 */
export function rayTriangle(orig, dir, a, b, c) {
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const p = cross(dir, e2);
  const det = dot(e1, p);
  if (Math.abs(det) < 1e-12) return null;         // parallel
  const inv = 1 / det;
  const t = [orig[0] - a[0], orig[1] - a[1], orig[2] - a[2]];
  const u = dot(t, p) * inv;
  if (u < 0 || u > 1) return null;
  const q = cross(t, e1);
  const v = dot(dir, q) * inv;
  if (v < 0 || u + v > 1) return null;
  const dist = dot(e2, q) * inv;
  if (dist <= 0) return null;                      // behind the eye
  return { dist, u, v };
}

/**
 * The world-space ray through a point on the canvas.
 *
 * Built from the camera basis rather than by inverting the view-projection
 * matrix. Both work; this one has no matrix inverse to get wrong, and the last
 * time this file composed matrices by hand the result was a camera inside the
 * car. Exported so it can be checked without a GPU.
 */
export function cameraRay(eye, target, up, fovy, aspect, ndcX, ndcY) {
  const fwd = norm(sub(target, eye));
  const right = norm(cross(fwd, up));
  const trueUp = cross(right, fwd);
  const h = Math.tan(fovy / 2);
  const dir = [0, 1, 2].map((k) =>
    fwd[k] + right[k] * ndcX * h * aspect + trueUp[k] * ndcY * h);
  return { orig: eye.slice(), dir: norm(dir) };
}

/** Unpack the whole-car blob: a JSON header of known length, then the arrays. */
export function unpackModel(buffer) {
  const head = new DataView(buffer);
  const len = head.getUint32(0, true);
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, len)));
  let o = 4 + len;
  const positions = new Float32Array(buffer, o, meta.vertexCount * 3); o += meta.vertexCount * 12;
  const uvs = new Float32Array(buffer, o, meta.vertexCount * 2); o += meta.vertexCount * 8;
  const normals = new Float32Array(buffer, o, meta.vertexCount * 3); o += meta.vertexCount * 12;
  const tangents = new Float32Array(buffer, o, meta.vertexCount * 3); o += meta.vertexCount * 12;
  const indices = new Uint32Array(buffer, o, meta.indexCount);
  const model = {
    positions, uvs, normals, tangents, indices,
    groups: meta.groups, bounds: meta.bounds,
  };
  // PRESENCE, not value. `packModel` sends `cockpit: null` on purpose for a car
  // whose model has no recognisable steering wheel, and omits the key only when
  // the server predates the field — which in practice means a page that
  // hot-reloaded against a server still running the old module. Those are
  // different problems with different fixes, and `?? null` reported both as
  // "this car has no cockpit eye".
  if ('cockpit' in meta) model.cockpit = meta.cockpit;
  return model;
}

/** Unpack the server's blob: two counts, then positions, UVs, normals, indices. */
export function unpack(buffer) {
  const head = new Uint32Array(buffer, 0, 2);
  const [vertexCount, indexCount] = head;
  let o = 8;
  const positions = new Float32Array(buffer, o, vertexCount * 3); o += vertexCount * 12;
  const uvs = new Float32Array(buffer, o, vertexCount * 2); o += vertexCount * 8;
  const normals = new Float32Array(buffer, o, vertexCount * 3); o += vertexCount * 12;
  const indices = new Uint32Array(buffer, o, indexCount);
  return { positions, uvs, normals, indices };
}

/**
 * The uniforms a highlight rectangle turns into.
 *
 * Pulled out of the viewer because the viewer needs a GPU and this does not.
 * The shader itself can only be checked by rendering, but the arithmetic
 * deciding what it is told — what counts as no selection, how thick an edge a
 * given rectangle gets — is ordinary code and testable as such.
 */
export function highlightUniforms({ region, panel, twin, twinPanel } = {}) {
  const usable = (r) => Array.isArray(r) && r.length === 4
    && r.every(Number.isFinite) && r[2] > 0 && r[3] > 0;
  const rect = (r) => (usable(r) ? [r[0], r[1], r[2], r[3]] : [0, 0, 0, 0]);
  const none = { region: [0, 0, 0, 0], panel: [0, 0, 0, 0], twin: [0, 0, 0, 0], twinPanel: [0, 0, 0, 0], border: 0 };

  // Everything hangs off the selection. Without one there is nothing to dim
  // around, and a lone panel outline with no artwork in it would say a region
  // is there when none is.
  if (!usable(region)) return none;
  return {
    region: rect(region),
    // A panel is optional: a region placed by absolute coordinates has no host,
    // and claiming one would draw a boundary that does not constrain anything.
    panel: rect(panel),
    twin: rect(twin),
    twinPanel: rect(twinPanel),
    // A fixed thin border, except on a region small enough that a fixed one
    // would swallow it whole — then it shrinks to a fifth of the short side, so
    // a tiny region reads as outlined rather than as a solid accent blob.
    border: Math.min(0.0025, Math.min(region[2], region[3]) * 0.2),
  };
}

// Exported for tests: the camera maths is the half of this file that can be
// checked without a GPU, and it is the half that was wrong.
export const _internal = { perspective, lookAt, mul };

/**
 * Clamp to what this GPU will actually accept.
 *
 * MAX_TEXTURE_SIZE is 4096 on plenty of hardware and a car can ship a 4096
 * sheet, so asking for a texture's real size is not by itself safe. Halved
 * rather than clamped to the limit exactly, because a power of two is what the
 * mip chain needs and 4096 -> 4096 is a no-op while 5000 -> 4096 is not.
 */
export function capped(w, h, max = 4096) {
  // Halved TOGETHER so the aspect ratio survives, and the guard is on the
  // dimension being halved rather than on both. Stopping when EITHER reached 1
  // left the other above the limit: a 8192x2 sheet bottomed out at b = 1 with
  // a still 8192, which is the texImage2D error this exists to prevent.
  let a = Math.max(1, w), b = Math.max(1, h);
  while (a > max || b > max) {
    a = Math.max(1, Math.round(a / 2));
    b = Math.max(1, Math.round(b / 2));
  }
  return [a, b];
}

/**
 * What size to rasterise each painted surface at, for the whole-car view.
 *
 * Separated from the GPU so it can be checked without one, because the number
 * it produces is the whole of why the car looked fuzzy. It used to be a flat
 * 512 square for every surface, justified by "thirty-seven surfaces at full
 * size is a hundred megabytes" — but thirty-seven is how many textures the CAR
 * has, and seven is how many a design paints. The body sheet is 2048x2048, so
 * the livery was drawn at a quarter of its resolution, right beside the car's
 * own artwork uploaded from the kn5 at full size.
 *
 * The budget is shared ACROSS the surfaces rather than spent on each, and is
 * met by halving everything — which keeps every texture a power of two, which
 * is what `generateMipmap` requires.
 */
export function textureSizes(surfaces, { budget = 192 * 1024 * 1024, max = 4096 } = {}) {
  const want = surfaces.map((s) => {
    const w = s.width ?? 1024;
    return capped(w, s.height ?? w, max);
  });
  // Measured on the numbers actually RETURNED. The check used to divide
  // without rounding while the result rounded up, so a set could pass the
  // budget and then exceed it — a check on values nobody uses.
  const at = (s) => want.map(([w, h]) => ({
    w: Math.max(64, Math.round(w / s)),
    h: Math.max(64, Math.round(h / s)),
  }));
  const cost = (sizes) => sizes.reduce((n, s) => n + s.w * s.h * 4, 0);

  let shrink = 1;
  let sizes = at(shrink);
  while (cost(sizes) > budget && shrink < 16) {
    shrink *= 2;
    sizes = at(shrink);
  }
  return sizes;
}

/**
 * A material's lighting constants, calibrated against car paint.
 *
 * The shading in FS was tuned by eye and — as its own comment says — tuned on
 * bodywork: a dielectric under clear lacquer. Applied to the whole car that
 * gives a race seat the same clearcoat highlight as a wing, and this car's
 * alcantara dash and seat came out as a pale sheen because of it. AC records
 * what each material actually wants and the kn5 carries it; nothing was
 * reading it.
 *
 * CALIBRATED rather than adopted wholesale. Taking AC's numbers raw would
 * relight the entire car against a scale that was never this renderer's, and
 * throw away tuning that is already right for the surface most of a livery
 * lives on. So car paint is the reference point: a material with this car's
 * carpaint constants renders exactly as it did before any of this existed, and
 * every other material moves from there by as much as its own constants
 * differ from paint's. Alcantara asks for 0.30 diffuse against paint's 0.50
 * and 0.30 specular against 0.60 — so it lands at roughly three fifths the
 * diffuse and half the highlight, which is the difference between suede and
 * lacquer.
 *
 * The reference is the NSX's own carpaint. It is a constant here rather than
 * read from the car because it is a CALIBRATION, not a fact about a model: it
 * says what the tuned numbers meant, and moving it per car would make the same
 * material render differently on two cars for no reason anyone chose.
 */
const PAINT = { ambient: 0.45, diffuse: 0.50, specular: 0.60, exponent: 60 };
const TUNED = { ambient: 0.85, diffuse: 0.95, specular: 0.55, exponent: 90 };

function lightingFor(light) {
  // Finite, not truthy: a material stating zero specular means matte, and
  // falling back to the default there would put a highlight on velvet.
  const rel = (v, ref, tuned) => (Number.isFinite(v) ? (v / ref) * tuned : tuned);
  const exp = light?.exponent;
  return {
    ambient: rel(light?.ambient, PAINT.ambient, TUNED.ambient),
    diffuse: rel(light?.diffuse, PAINT.diffuse, TUNED.diffuse),
    specular: rel(light?.specular, PAINT.specular, TUNED.specular),
    // Zero is the exception the rule above cannot take: pow(x, 0) is 1
    // everywhere, so a material claiming no exponent would be lit as a mirror
    // rather than as a matte surface. Floored too, because below about 4 the
    // highlight covers the whole part and reads as fog.
    // Clamped at BOTH ends. Below about 4 the highlight covers the whole part
    // and reads as fog; above about 200 it is a pinpoint nobody will ever land
    // on, and this car has a material stating 550, which scales to 825 — a
    // number that is arithmetically faithful and visually meaningless.
    exponent: Number.isFinite(exp) && exp > 0
      ? Math.min(200, Math.max(4, (exp / PAINT.exponent) * TUNED.exponent))
      : TUNED.exponent,
  };
}

export function createViewer(canvas) {
  // NO ALPHA CHANNEL IN THE DRAWING BUFFER, which is a statement about the
  // canvas rather than about the car: this view is opaque, and what is behind
  // it in the page is never meant to show through.
  //
  // Without it, every fragment alpha this shader writes is also an instruction
  // to the DOM compositor. The blended pass sets `texAlpha` for exactly the
  // groups whose transparency is real — glass, the plates' emissive twins —
  // and those fragments then punch a hole through the canvas to the stage
  // behind it. It is nearly invisible here, because #stage is #05070a and the
  // clear colour is (0.02, 0.03, 0.04): the hole shows the same near-black.
  // Guarding each uniform instead is what the per-surface pass already had to
  // do, and it only holds until the next pass forgets one.
  //
  // Blending is untouched. SRC_ALPHA / ONE_MINUS_SRC_ALPHA and the additive
  // ONE / ONE both take their factors from the fragment, and nothing here
  // reads destination alpha.
  const gl = canvas.getContext('webgl', { antialias: true, preserveDrawingBuffer: false, alpha: false });
  if (!gl) throw new Error('WebGL is unavailable in this browser');

  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(`link: ${gl.getProgramInfoLog(prog)}`);
  }
  gl.useProgram(prog);

  const loc = {
    position: gl.getAttribLocation(prog, 'position'),
    uv: gl.getAttribLocation(prog, 'uv'),
    normal: gl.getAttribLocation(prog, 'normal'),
    tangent: gl.getAttribLocation(prog, 'tangent'),
    mvp: gl.getUniformLocation(prog, 'mvp'),
    map: gl.getUniformLocation(prog, 'map'),
    detail: gl.getUniformLocation(prog, 'detail'),
    detailMult: gl.getUniformLocation(prog, 'detailMult'),
    detailOnly: gl.getUniformLocation(prog, 'detailOnly'),
    detailNormal: gl.getUniformLocation(prog, 'detailNormal'),
    hasDetailNormal: gl.getUniformLocation(prog, 'hasDetailNormal'),
    detailNormalBlend: gl.getUniformLocation(prog, 'detailNormalBlend'),
    hasDetail: gl.getUniformLocation(prog, 'hasDetail'),
    matAmbient: gl.getUniformLocation(prog, 'matAmbient'),
    matDiffuse: gl.getUniformLocation(prog, 'matDiffuse'),
    matSpecular: gl.getUniformLocation(prog, 'matSpecular'),
    matExponent: gl.getUniformLocation(prog, 'matExponent'),
    region: gl.getUniformLocation(prog, 'region'),
    panel: gl.getUniformLocation(prog, 'panel'),
    twin: gl.getUniformLocation(prog, 'twin'),
    twinPanel: gl.getUniformLocation(prog, 'twinPanel'),
    border: gl.getUniformLocation(prog, 'border'),
    lit: gl.getUniformLocation(prog, 'lit'),
    glass: gl.getUniformLocation(prog, 'glass'),
    texAlpha: gl.getUniformLocation(prog, 'texAlpha'),
    eye: gl.getUniformLocation(prog, 'eye'),
  };

  const buffers = {
    position: gl.createBuffer(), uv: gl.createBuffer(),
    normal: gl.createBuffer(), tangent: gl.createBuffer(), index: gl.createBuffer(),
  };

  /** A single flat texel — the shape before any render arrives, and unpainted parts. */
  function greyTexture() {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([60, 66, 78, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  const texture = greyTexture();
  // A SECOND grey, for the unpainted parts of the whole-car view, and deliberately
  // not the one above.
  //
  // `texture` starts grey and stops being grey the instant `setTexture` uploads
  // the surface you are editing into it. The whole-car draw fell back to it for
  // a group with no role, so every unpainted mesh on the car — glass, interior,
  // brake discs, anything the design does not touch — was drawn wearing the
  // BODY design. On a GT3 car that is windows filled in with sponsor artwork,
  // which reads as a fault in the livery rather than in the viewer, and sends
  // you off to look at the design.
  //
  // The editor opens on the car view, so `texture` has essentially never been
  // grey by the time anybody presses Whole car. That is why it looked
  // deliberate.
  const unpainted = greyTexture();
  // Whole-car mode: one texture per painted surface, and one draw call each.
  // `null` in a group means the design does not paint it — it then gets the
  // car's own texture from `byFile` if the model could supply one, and the grey
  // if not.
  const byRole = new Map();
  const byFile = new Map();
  // Tiling detail maps, kept SEPARATE from byFile rather than sharing it,
  // because the same file can be both: this car wears MAT_Carbon.dds flat on
  // its shift paddles and tiled five hundred times over on its door cards, and
  // one texture object cannot be CLAMP with no mips for the first and REPEAT
  // with a full chain for the second.
  const byDetail = new Map();
  let groups = null;
  // Kept on the CPU as well as uploaded, because picking needs to intersect it.
  // A body is a megabyte of floats; holding it is cheaper than a round trip to
  // the server on every pointer event.
  let mesh = null;
  // The typed arrays currently sitting in the GPU's buffers, held by IDENTITY
  // rather than by content — see setWholeCar.
  let uploaded = null;

  gl.enable(gl.DEPTH_TEST);
  // Both faces. Car meshes are not reliably wound one way, and a missing
  // half-shell reads as a hole in the car rather than as a culling choice.
  gl.disable(gl.CULL_FACE);
  gl.clearColor(0.02, 0.03, 0.04, 1);

  // `mode` is 'orbit' (the default: drag swings around `target` at `dist`)
  // or 'cockpit' (drag looks around from a fixed `eye`, set by setCockpit).
  // Kept on the same object as the angles because both modes share yaw and
  // pitch — dragging means the same thing to the user in either one, only
  // what it orbits around changes.
  const cam = { yaw: -0.9, pitch: 0.35, dist: 6, target: [0, 0.7, 0], mode: 'orbit', eye: [0, 0, 0] };
  let count = 0;
  let ext = null;
  // Zero width means nothing is selected, which is also the state a fresh
  // uniform is already in — so a viewer that never calls setHighlight behaves
  // exactly as it did before this existed.
  let region = [0, 0, 0, 0];
  let panel = [0, 0, 0, 0];
  let twin = [0, 0, 0, 0];
  let twinPanel = [0, 0, 0, 0];
  let border = 0.0015;
  // Shaded by default. Honest colour is one call away and the UV tab, where you
  // read colours off the sheet, is untouched by any of this.
  let lit = true;

  function resize() {
    const w = canvas.clientWidth || 800;
    const h = canvas.clientHeight || 600;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    gl.viewport(0, 0, canvas.width, canvas.height);
  }

  /**
   * Where the camera is, given the orbit angles. Used to draw and to pick.
   *
   * In cockpit mode the eye does not move — it is wherever setCockpit put it,
   * a driver's head does not orbit the car — and yaw/pitch instead steer what
   * lookTarget looks at, below.
   */
  function eyePosition() {
    if (cam.mode === 'cockpit') return cam.eye;
    return [
      cam.target[0] + cam.dist * Math.cos(cam.pitch) * Math.sin(cam.yaw),
      cam.target[1] + cam.dist * Math.sin(cam.pitch),
      cam.target[2] + cam.dist * Math.cos(cam.pitch) * Math.cos(cam.yaw),
    ];
  }

  /**
   * Where the camera is looking. In orbit mode this is the fixed point the
   * eye swings around; in cockpit mode the eye is what is fixed, and this is
   * the point yaw/pitch are currently steering it toward — one unit ahead in
   * the same spherical direction the orbit math already uses, so yaw 0 faces
   * the same way `front` does in the shot renderer (both read the model's own
   * +Z as the nose) and dragging feels like the same gesture in either mode.
   */
  function lookTarget(eye) {
    if (cam.mode !== 'cockpit') return cam.target;
    return [
      eye[0] + Math.cos(cam.pitch) * Math.sin(cam.yaw),
      eye[1] + Math.sin(cam.pitch),
      eye[2] + Math.cos(cam.pitch) * Math.cos(cam.yaw),
    ];
  }

  function draw() {
    resize();
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!count) return;

    const eye = eyePosition();
    const mvp = mul(
      perspective(0.8, canvas.width / canvas.height, 0.05, 100),
      lookAt(eye, lookTarget(eye), [0, 1, 0]),
    );
    gl.uniformMatrix4fv(loc.mvp, false, new Float32Array(mvp));
    gl.uniform1i(loc.map, 0);
    gl.uniform1i(loc.detail, 1);
    gl.uniform1i(loc.detailNormal, 2);
    gl.uniform1f(loc.border, border);
    gl.uniform1f(loc.lit, lit ? 1 : 0);
    gl.uniform3fv(loc.eye, new Float32Array(eye));
    gl.activeTexture(gl.TEXTURE0);
    const bytes = ext ? 4 : 2;
    const type = ext ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;

    if (!groups) {
      gl.uniform4fv(loc.region, region);
      gl.uniform4fv(loc.panel, panel);
      gl.uniform4fv(loc.twin, twin);
      gl.uniform4fv(loc.twinPanel, twinPanel);
      // Explicit, not left over from a previous frame: uniforms persist across
      // draw calls, and the whole-car pass below sets both of these per group.
      // Without the reset, switching from whole-car to the per-surface view
      // straight off a glass group left THIS texture rendering through the
      // fresnel alpha it never asked for.
      //
      // `texAlpha` is the same trap and worse. The whole-car pass turns it on
      // for alpha-blended groups; left on here it makes this pass — which is
      // opaque and does not blend — write the texture's alpha into a canvas
      // that HAS an alpha channel, and the page shows through the car. Every
      // per-group uniform belongs in this list, and the next one added will
      // belong in it too.
      gl.uniform1f(loc.glass, 0);
      gl.uniform1f(loc.texAlpha, 0);
      // And the detail layer, for the same reason: a leftover 1 here would
      // multiply the sheet being edited by a carbon weave at five hundred
      // times tiling.
      gl.uniform1f(loc.hasDetail, 0);
      gl.uniform1f(loc.hasDetailNormal, 0);
      // The surface being edited has no material behind it — it is one sheet,
      // not a part — so it keeps the tuned defaults.
      const flat = lightingFor(null);
      gl.uniform1f(loc.matAmbient, flat.ambient);
      gl.uniform1f(loc.matDiffuse, flat.diffuse);
      gl.uniform1f(loc.matSpecular, flat.specular);
      gl.uniform1f(loc.matExponent, flat.exponent);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.drawElements(gl.TRIANGLES, count, type, 0);
      return;
    }

    // One draw call per painted surface. The highlight is deliberately NOT
    // applied here: a UV rectangle means something different on each texture, so
    // dimming the whole car around a rectangle read from one of them would dim
    // the others by an unrelated coincidence of coordinates.
    for (const u of [loc.region, loc.panel, loc.twin, loc.twinPanel]) {
      gl.uniform4fv(u, [0, 0, 0, 0]);
    }
    // TWO PASSES, keyed on the MATERIAL.
    //
    // A blended surface has to be drawn after everything behind it, because
    // compositing reads the framebuffer. Drawn first it blends against the
    // background and writes depth that stops the bodywork behind it appearing.
    //
    // `g.blend` comes from the kn5 shader — ksPerPixelAlpha and the glass
    // shaders — and NOT from the texture's alpha channel. An earlier attempt
    // used the profile's `alpha` flag, which means "this DDS has an alpha
    // channel" and is true of an entirely opaque DXT5 body texture. 62 of 75
    // textures were flagged, nearly every panel went into the blended pass with
    // depth write off, and the car stopped being able to hide its own interior.
    // By shader it is 20 groups of 54, and the bodywork is not among them.
    const paint = (g) => {
      // In order: the design's own render for a painted role, then the car's
      // own texture for a part the design skips, then grey.
      //
      // `unpainted`, never `texture`: a group with no role is a part of the car
      // this design does not paint, and falling back to the surface being
      // edited put the body artwork on the glass.
      const tex = byRole.get(g.role) ?? byFile.get(g.file)
        ?? (g.detail ? byFile.get(g.detail.diffuse) : undefined) ?? null;

      // A BLENDED group with no texture is not drawn at all — UNLESS it is
      // glass. Glass draws on `unpainted` grey plus the fresnel rim the
      // fragment shader adds when `glass` is set: real automotive glass gets
      // most of its look from reflection, not from its diffuse texture, so a
      // bare surface shaded that way is closer to a windscreen than an empty
      // hole is.
      //
      // For everything else, `unpainted` is opaque grey, and an opaque grey
      // slab standing where a transparent surface belongs is the whole bug
      // this pass exists to fix. The number plate's emissive twin is the
      // case: it has no role, so if its stock DDS fails to fetch or upload it
      // falls through to the grey — and being co-planar with the plate and
      // sorted against it, that grey lands in front of the number about half
      // the time. Not drawing it is the honest answer. The plate behind is
      // real; the grey never was.
      if (!tex && g.blend && !g.glass) return;

      // The tiling layer, and only when its bake actually arrived: half of a
      // two-layer material is not a surface. A carbon weave multiplied over
      // the fallback grey would be a plausible-looking part in a colour nobody
      // chose, which is the confident wrongness the grey exists to avoid.
      const det = tex && g.detail ? byDetail.get(g.detail.detail) : null;
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, det ?? unpainted);
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform1f(loc.hasDetail, det ? 1 : 0);
      gl.uniform1f(loc.detailMult, det ? g.detail.mult : 1);

      // The grain is independent of the colour: a material can state one
      // without the other, and a normal map that failed to upload should cost
      // its material its texture rather than its lighting.
      const grain = det && g.detail.normal ? byDetail.get(g.detail.normal) : null;
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, grain ?? unpainted);
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform1f(loc.hasDetailNormal, grain ? 1 : 0);
      gl.uniform1f(loc.detailNormalBlend, grain ? g.detail.normalBlend : 1);
      // Read off the sheet's NAME, which is weaker than reading its contents
      // and is what the rest of this project already does for shaders — see
      // additive and trustworthyDiffuse, which say the same thing about
      // themselves. Kunos names a bake a bake, and the two on this car
      // (INT_HR_Occlusion, INT_Bakes_2) both say so on the tin.
      gl.uniform1f(loc.detailOnly,
        det && /occlusion|bake/i.test(g.detail.diffuse) ? 1 : 0);

      // GLASS KEEPS THE TUNED DEFAULTS, and does not get its material's own
      // constants. It already has a treatment of its own — the fresnel rim
      // that main() builds its alpha and its highlight from — so handing it a
      // second specular from the material double-counts the same physics.
      //
      // This car says so loudly: INT_Windshield_Clean asks for specular 1.0 at
      // exponent 10, which calibrates to a near-full-strength highlight spread
      // across the entire pane. Applied on top of the fresnel it turned the
      // windscreen into a white haze, and everything behind it — the dash, the
      // seats — read as washed out. Which is exactly what it looked like: a
      // dash that would not go dark no matter what was done to the dash.
      const lightAs = lightingFor(g.glass ? null : g.light);
      gl.uniform1f(loc.matAmbient, lightAs.ambient);
      gl.uniform1f(loc.matDiffuse, lightAs.diffuse);
      gl.uniform1f(loc.matSpecular, lightAs.specular);
      gl.uniform1f(loc.matExponent, lightAs.exponent);

      gl.uniform1f(loc.glass, g.glass ? 1 : 0);
      // Only where it is both meaningful and safe: an alpha-blended group that
      // is not glass and not additive. The opaque pass must keep writing 1, or
      // the page shows through the car; glass overrides alpha with its fresnel;
      // additive uses blendFunc(ONE, ONE) and never reads it.
      gl.uniform1f(loc.texAlpha, g.blend && !g.glass && !g.add ? 1 : 0);
      gl.bindTexture(gl.TEXTURE_2D, tex ?? unpainted);
      gl.drawElements(gl.TRIANGLES, g.count, type, g.start * bytes);
    };

    for (const g of groups) if (!g.blend) paint(g);

    const blended = groups.filter((g) => g.blend);
    if (!blended.length) return;

    // Back to front, per GROUP. Coarse — triangles within a group are not
    // sorted against each other — but enough to stop an emissive mask being
    // drawn in front of the number plate it exists to light.
    blended.sort((a, b) => dist2(b.centre, eye) - dist2(a.centre, eye));

    gl.enable(gl.BLEND);
    // Depth TEST on so bodywork still occludes; depth WRITE off so two blended
    // surfaces do not occlude each other.
    gl.depthMask(false);
    for (const g of blended) {
      // ADDITIVE for emissive sheets, alpha for everything else.
      //
      // An emissive texture is a glow map — black where nothing glows — and the
      // game adds it, so the black contributes nothing. Alpha-blended instead,
      // an opaque black texture is just a black rectangle, and that is what has
      // been sitting in front of this car's number plates: the plate's emissive
      // twin, co-planar with it, drawn as a solid slab.
      if (g.add) gl.blendFunc(gl.ONE, gl.ONE);
      else gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      paint(g);
    }
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }

  const dist2 = (a, b) =>
    (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

/**
   * The car's own texture, straight from the kn5, with no decoding step.
   *
   * A DDS file is a 128-byte header and then S3TC blocks, which is exactly what
   * `compressedTexImage2D` wants — so the bytes go from the model to the GPU
   * untouched. Decoding them to RGBA in JavaScript would be slower, would use
   * four times the memory, and would be undone by the driver recompressing.
   *
   * Answers false rather than throwing for every reason this can fail: no
   * extension (S3TC is near-universal but not guaranteed), a format that is not
   * DXT1/3/5, a PNG rather than a DDS, a truncated blob. The caller keeps the
   * grey, which is the behaviour this replaced and a perfectly good fallback.
   */
  /** The DDS header fields both upload paths need. 128 bytes, all of it fixed. */
  function ddsHeader(buffer) {
    if (!buffer || buffer.byteLength < 128) return null;
    const head = new DataView(buffer);
    if (head.getUint32(0, true) !== 0x20534444) return null;    // 'DDS '
    const height = head.getUint32(12, true);
    const width = head.getUint32(16, true);
    if (!width || !height) return null;
    // A file with no chain writes 0 and a file with only its top level writes
    // 1. Both mean the same thing downstream, so they are made to say it.
    const levels = Math.max(1, head.getUint32(28, true));
    return { width, height, levels, fourCC: head.getUint32(84, true) };
  }

  /** How many levels a complete chain has, down to a single texel. */
  const chainLength = (w, h) => 1 + Math.floor(Math.log2(Math.max(w, h)));

  /**
   * Every mip level the file carries, uploaded as it stands.
   *
   * The archive very largely DOES carry a chain — twelve levels on this car's
   * body sheet, eleven on its interior bake, 83 of its 122 textures with a
   * full one. This used to upload level zero, stop, and set a LINEAR filter
   * over it, so every stock part on the car was minified straight from full
   * resolution. At whole-car distance that is a shimmer on a wing mirror; from
   * the cockpit seat, inches from parts the design never paints, it is the
   * whole view crawling whenever the camera moves. The comment that justified
   * stopping said the kn5 held one level and nothing to build a chain from,
   * and that was measured on a texture which happens to ship none.
   *
   * Returns HOW MANY levels went up rather than a flag, because WebGL 1 has no
   * TEXTURE_MAX_LEVEL: a mipmap filter over a partial chain renders solid
   * black, so the caller has to compare against a complete one before asking
   * for that filter. A short answer is not a failure — level zero on its own
   * still draws, just without mips.
   */
  function uploadBlocks(glFormat, blockBytes, buffer, { width, height, levels }) {
    let offset = 128;
    let w = width;
    let h = height;
    let done = 0;
    gl.getError();                        // so the check below is about US
    for (let level = 0; level < levels; level++) {
      // A block covers four texels square at every level, so the tail of any
      // chain is several levels that are all one block and all the same size.
      const bytes = Math.ceil(w / 4) * Math.ceil(h / 4) * blockBytes;
      if (offset + bytes > buffer.byteLength) break;         // truncated file
      try {
        gl.compressedTexImage2D(gl.TEXTURE_2D, level, glFormat, w, h, 0,
          new Uint8Array(buffer, offset, bytes));
      } catch {
        break;      // S3TC wants multiples of four, and memory can run out
      }
      // Thrown failures are not the only kind. A malformed size or a format
      // the driver quietly refuses sets an error flag and returns normally,
      // writing nothing — and every later sample of that level then reads
      // whatever was already sitting in the allocation.
      if (gl.getError() !== gl.NO_ERROR) break;
      done = level + 1;
      offset += bytes;
      w = Math.max(1, w >> 1);
      h = Math.max(1, h >> 1);
    }
    return done;
  }

  /**
   * The car's own artwork for one texture, handed to the GPU as the blocks it
   * already is.
   *
   * Answers false for anything it cannot honestly upload rather than throwing:
   * the caller's fallback is the honest grey, and an exception here would
   * escape setWholeCar and take the whole view down over a wing mirror.
   */
  function uploadDds(target, buffer) {
    const s3tc = gl.getExtension('WEBGL_compressed_texture_s3tc');
    const head = ddsHeader(buffer);
    if (!s3tc || !head) return false;
    const format = {
      0x31545844: [s3tc.COMPRESSED_RGB_S3TC_DXT1_EXT, 8],       // 'DXT1'
      0x33545844: [s3tc.COMPRESSED_RGBA_S3TC_DXT3_EXT, 16],     // 'DXT3'
      0x35545844: [s3tc.COMPRESSED_RGBA_S3TC_DXT5_EXT, 16],     // 'DXT5'
    }[head.fourCC];
    if (!format) return false;

    gl.bindTexture(gl.TEXTURE_2D, target);
    const done = uploadBlocks(format[0], format[1], buffer, head);
    if (!done) return false;

    const mipped = done === chainLength(head.width, head.height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER,
      mipped ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    if (mipped) {
      // Most of a car is seen at a glancing angle, which is the case
      // anisotropy exists for and the case mips alone over-blur.
      const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
      if (aniso) {
        gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT,
          Math.min(8, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
      }
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return true;
  }

  const isPot = (n) => n > 0 && (n & (n - 1)) === 0;

  /** The centre of a group, for sorting blended ones back to front. */
  function centreOf(g, positions, indices) {
    let x = 0, y = 0, z = 0, n = 0;
    for (let i = g.start; i < g.start + g.count; i += 8) {
      const v = indices[i] * 3;
      x += positions[v]; y += positions[v + 1]; z += positions[v + 2]; n++;
    }
    return n ? [x / n, y / n, z / n] : [0, 0, 0];
  }


  /**
   * A texture out of the archive, decoded to plain RGBA on the CPU — whatever
   * it was stored as.
   *
   * The GPU takes S3TC blocks untouched and this is the slower path, so it is
   * for the two cases where handing blocks over is not an option. The first is
   * format: a kn5 is not all DXT, and this car's carbon weave is plain 32-bit
   * BGRA while its brushed metal is 16-bit luminance — neither can go through
   * compressedTexImage2D at all. The second is mips on a file that shipped
   * none: WebGL refuses generateMipmap on a compressed texture (every S3TC
   * format, by the spec, on every driver), so a chainless DXT detail map can
   * only get a chain by being decoded first. Tiled a hundred to five hundred
   * times over, one screen pixel covers hundreds of texels and a door card
   * dissolves into crawling moire without one.
   *
   * Detail maps are what come through here, and they are small — 128 to 512
   * square — so the four times memory RGBA costs over DXT is nothing. The
   * car's 2048-square body sheets keep their blocks and their own embedded
   * chain instead; see uploadBlocks.
   */
  function decodeDds(buffer) {
    if (!buffer || buffer.byteLength < 128) return null;
    const head = new DataView(buffer);
    if (head.getUint32(0, true) !== 0x20534444) return null;      // 'DDS '
    const height = head.getUint32(12, true);
    const width = head.getUint32(16, true);
    const dxt = { 0x31545844: 1, 0x33545844: 3, 0x35545844: 5 }[head.getUint32(84, true)];
    if (!width || !height) return null;

    // NOT everything in a kn5 is block-compressed, and assuming it was is how
    // the two most valuable detail maps on this car came back as null and
    // stayed grey: MAT_Carbon.dds, which is the actual carbon weave, is plain
    // 32-bit BGRA, and metal_detail_2.dds is 16-bit luminance-plus-alpha.
    //
    // Read through the channel MASKS rather than assuming a byte order. The
    // masks are the only thing in the header that actually says where each
    // channel lives, they cost one loop to turn into a shift, and BGRA versus
    // RGBA is otherwise a bug that looks like an art decision — a blue car.
    if (!dxt) {
      const flags = head.getUint32(80, true);
      const bits = head.getUint32(88, true);
      const luminance = (flags & 0x20000) !== 0;
      if (!(luminance || (flags & 0x40)) || bits % 8 !== 0 || bits < 8 || bits > 32) return null;

      const channel = (mask) => {
        if (!mask) return null;
        let shift = 0;
        while (!((mask >>> shift) & 1)) shift++;
        const max = mask >>> shift;
        return max ? { shift, max } : null;
      };
      const rc = channel(head.getUint32(92, true));
      const gc = luminance ? rc : channel(head.getUint32(96, true));
      const bc = luminance ? rc : channel(head.getUint32(100, true));
      const ac = channel(head.getUint32(104, true));
      if (!rc) return null;

      const bpp = bits / 8;
      if (buffer.byteLength < 128 + (width * height * bpp)) return null;
      const src = new Uint8Array(buffer, 128, width * height * bpp);
      const out = new Uint8Array(width * height * 4);
      const take = (v, ch, fallback) => (ch ? Math.round((((v & (ch.max << ch.shift)) >>> ch.shift) * 255) / ch.max) : fallback);
      for (let i = 0, o = 0; i < width * height; i++, o += bpp) {
        let v = 0;
        for (let k = 0; k < bpp; k++) v |= src[o + k] << (k * 8);
        v >>>= 0;
        const d = i * 4;
        out[d] = take(v, rc, 0);
        out[d + 1] = take(v, gc, 0);
        out[d + 2] = take(v, bc, 0);
        out[d + 3] = take(v, ac, 255);
      }
      return { width, height, pixels: out };
    }

    const blockBytes = dxt === 1 ? 8 : 16;
    const bw = Math.ceil(width / 4);
    const bh = Math.ceil(height / 4);
    if (buffer.byteLength < 128 + (bw * bh * blockBytes)) return null;
    const src = new Uint8Array(buffer, 128, bw * bh * blockBytes);
    const out = new Uint8Array(width * height * 4);

    // Reused across every block rather than allocated per block: a 1024-square
    // texture is 65536 blocks, and four small arrays each time is how a decode
    // that should take milliseconds starts triggering garbage collection
    // pauses in the middle of a camera drag.
    const r = new Uint8Array(4);
    const g = new Uint8Array(4);
    const b = new Uint8Array(4);
    const a = new Uint8Array(8);

    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        let o = (by * bw + bx) * blockBytes;
        let alphaAt = -1;

        if (dxt === 5) {
          // Two endpoints and a three-bit index per texel, with the same
          // "which endpoint is larger" trick the colour block uses to pick
          // between two interpolation schemes.
          a[0] = src[o];
          a[1] = src[o + 1];
          if (a[0] > a[1]) {
            for (let i = 1; i < 7; i++) a[i + 1] = (((7 - i) * a[0]) + (i * a[1])) / 7;
          } else {
            for (let i = 1; i < 5; i++) a[i + 1] = (((5 - i) * a[0]) + (i * a[1])) / 5;
            a[6] = 0;
            a[7] = 255;
          }
          alphaAt = o + 2;
          o += 8;
        } else if (dxt === 3) {
          alphaAt = o;                      // four flat bits per texel
          o += 8;
        }

        const c0 = src[o] | (src[o + 1] << 8);
        const c1 = src[o + 2] | (src[o + 3] << 8);
        // 5:6:5 to 8:8:8 by replicating the high bits down into the low ones,
        // which is what keeps a saturated channel at 255 rather than at 248.
        const unpack = (i, v) => {
          const r5 = (v >> 11) & 31;
          const g6 = (v >> 5) & 63;
          const b5 = v & 31;
          r[i] = (r5 << 3) | (r5 >> 2);
          g[i] = (g6 << 2) | (g6 >> 4);
          b[i] = (b5 << 3) | (b5 >> 2);
        };
        unpack(0, c0);
        unpack(1, c1);
        // DXT1 hides one bit of alpha in the ORDER of its endpoints: c0 <= c1
        // means the fourth colour is transparent black instead of a second
        // interpolation step. Read it the other way and every cut-out texture
        // grows a black fringe.
        const punchThrough = dxt === 1 && c0 <= c1;
        if (punchThrough) {
          r[2] = (r[0] + r[1]) / 2; g[2] = (g[0] + g[1]) / 2; b[2] = (b[0] + b[1]) / 2;
          r[3] = 0; g[3] = 0; b[3] = 0;
        } else {
          r[2] = ((2 * r[0]) + r[1]) / 3; g[2] = ((2 * g[0]) + g[1]) / 3; b[2] = ((2 * b[0]) + b[1]) / 3;
          r[3] = (r[0] + (2 * r[1])) / 3; g[3] = (g[0] + (2 * g[1])) / 3; b[3] = (b[0] + (2 * b[1])) / 3;
        }

        const bits = o + 4;
        for (let py = 0; py < 4; py++) {
          const y = (by * 4) + py;
          if (y >= height) break;           // the last block row runs off a
          for (let px = 0; px < 4; px++) {  // texture whose size is not a
            const x = (bx * 4) + px;        // multiple of four
            if (x >= width) break;
            const i = (src[bits + py] >> (px * 2)) & 3;
            const n = (py * 4) + px;
            const d = ((y * width) + x) * 4;
            out[d] = r[i];
            out[d + 1] = g[i];
            out[d + 2] = b[i];
            if (dxt === 5) {
              // A three-bit field straddles a byte boundary five times in
              // every block, hence the second read rather than a lookup table.
              const at = n * 3;
              const byteAt = alphaAt + (at >> 3);
              const shift = at & 7;
              let v = src[byteAt] >> shift;
              if (shift > 5) v |= src[byteAt + 1] << (8 - shift);
              out[d + 3] = a[v & 7];
            } else if (dxt === 3) {
              out[d + 3] = ((src[alphaAt + (n >> 1)] >> ((n & 1) * 4)) & 15) * 17;
            } else {
              out[d + 3] = punchThrough && i === 3 ? 0 : 255;
            }
          }
        }
      }
    }
    return { width, height, pixels: out };
  }

  /**
   * A tiling detail map, uploaded so that it survives being tiled.
   *
   * REPEAT rather than CLAMP, because the whole point is UVs that run past 1 —
   * five hundred times past it on this car's carbon. Clamping would smear the
   * texture's last row across the entire part.
   *
   * REPEAT and the mip chain both want a power of two in WebGL 1. Detail maps
   * are authored small and square so this is very nearly always true; when it
   * is not, answering false and letting the caller keep its grey beats what a
   * non-power-of-two texture with a REPEAT wrap actually renders as, which is
   * solid black.
   */
  function uploadDetail(target, buffer) {
    const head = ddsHeader(buffer);
    // REPEAT and a mip chain both want a power of two in WebGL 1. Detail maps
    // are authored small and to a power of two, so this is very nearly always
    // true; when it is not, answering false and letting the caller keep its
    // grey beats what a non-power-of-two texture with a REPEAT wrap actually
    // renders as, which is solid black.
    if (!head || !isPot(head.width) || !isPot(head.height)) return false;

    gl.bindTexture(gl.TEXTURE_2D, target);
    let mipped = false;

    // The file's own chain first, when it has a complete one — alcnt.dds ships
    // ten levels — because handing over blocks beats decoding a megabyte.
    const s3tc = gl.getExtension('WEBGL_compressed_texture_s3tc');
    const format = s3tc ? {
      0x31545844: [s3tc.COMPRESSED_RGB_S3TC_DXT1_EXT, 8],
      0x33545844: [s3tc.COMPRESSED_RGBA_S3TC_DXT3_EXT, 16],
      0x35545844: [s3tc.COMPRESSED_RGBA_S3TC_DXT5_EXT, 16],
    }[head.fourCC] : null;
    if (format && head.levels > 1) {
      mipped = uploadBlocks(format[0], format[1], buffer, head)
        === chainLength(head.width, head.height);
    }

    // Otherwise decode and let the GPU build one. This is the path that
    // matters most in practice: the carbon weave is uncompressed BGRA and the
    // brushed metal is luminance with no chain at all, and both are tiled
    // hundreds of times over, which is exactly where a missing chain shows.
    if (!mipped) {
      const img = decodeDds(buffer);
      if (!img) return false;
      try {
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.getError();
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, img.width, img.height, 0,
          gl.RGBA, gl.UNSIGNED_BYTE, img.pixels);
        if (gl.getError() !== gl.NO_ERROR) return false;
        gl.generateMipmap(gl.TEXTURE_2D);
      } catch {
        return false;
      }
    }

    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    // REPEAT rather than CLAMP, because the whole point is UVs that run past 1
    // — five hundred times past it on this car's carbon. Clamping would smear
    // the texture's last row across the entire part.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    // The weave crosses most of a door card at a glancing angle, which is
    // exactly what anisotropy is for.
    const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
    if (aniso) {
      gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT,
        Math.min(8, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
    }
    return true;
  }

  /**
   * Rasterise an SVG into a texture. The only way a browser will do it.
   *
   * Takes a WIDTH and a HEIGHT rather than one `size`. Car textures are not all
   * square — this Honda's tyre sheet is 2048x512 — and forcing a square raster
   * threw away three quarters of the horizontal detail on every one of them.
   */
  async function uploadSvg(target, svg, w, h = w) {
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    try {
      const img = new Image();
      img.width = w;
      img.height = h;
      await new Promise((ok, fail) => {
        img.onload = ok;
        img.onerror = () => fail(new Error('the browser could not rasterise the texture'));
        img.src = url;
      });
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      gl.bindTexture(gl.TEXTURE_2D, target);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
      // WebGL 1 will only build a mip chain for a power-of-two texture, and
      // silently renders a non-power-of-two one BLACK if you ask for a mipmap
      // filter anyway. Car textures are almost always powers of two and
      // occasionally are not — this car ships a 68x64 sheet — so the awkward
      // case falls back to plain LINEAR rather than disappearing.
      if (isPot(w) && isPot(h)) {
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      } else {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      }
      // Sharpens a livery seen at a glancing angle, which on a car body is most
      // of it. Costs nothing where the extension is missing.
      const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
      if (aniso) {
        gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT,
          Math.min(8, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
      }
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  return {
    /** Upload geometry, and frame the camera on whatever it just received. */
    setGeometry({ positions, uvs, normals, tangents, indices }) {
      groups = null;
      mesh = { positions, uvs, indices };
      // What is actually in the GPU's buffers, by identity, so setWholeCar can
      // tell "the same car again" from "a different car" without comparing
      // thirty megabytes element by element.
      uploaded = { positions, uvs, normals, tangents, indices };
      gl.bindBuffer(gl.ARRAY_BUFFER, buffers.position);
      gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(loc.position);
      gl.vertexAttribPointer(loc.position, 3, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, buffers.uv);
      gl.bufferData(gl.ARRAY_BUFFER, uvs, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(loc.uv);
      gl.vertexAttribPointer(loc.uv, 2, gl.FLOAT, false, 0, 0);

      // A model saved before normals travelled, or a hand-built fixture, gets a
      // buffer of zeroes rather than a crash. `shade` normalises, and a zero
      // normal comes out as the sky term alone — flat, wrong, and visibly so,
      // which is better than a viewer that will not start.
      gl.bindBuffer(gl.ARRAY_BUFFER, buffers.normal);
      gl.bufferData(gl.ARRAY_BUFFER,
        normals ?? new Float32Array(positions.length), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(loc.normal);
      gl.vertexAttribPointer(loc.normal, 3, gl.FLOAT, false, 0, 0);

      // Zeroes when the payload carries none — the per-surface view packs no
      // tangents, and does not need any, because normal mapping only happens
      // on the whole-car pass. The shader reads a zero tangent as "no frame".
      //
      // Guarded on the attribute existing at all: a driver that decides the
      // tangent is unused strips it, getAttribLocation answers -1, and
      // enableVertexAttribArray(-1) is an INVALID_VALUE that would take the
      // whole viewer down over an optimisation.
      if (loc.tangent >= 0) {
        gl.bindBuffer(gl.ARRAY_BUFFER, buffers.tangent);
        gl.bufferData(gl.ARRAY_BUFFER,
          tangents ?? new Float32Array(positions.length), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(loc.tangent);
        gl.vertexAttribPointer(loc.tangent, 3, gl.FLOAT, false, 0, 0);
      }

      // WebGL1 needs an extension for 32-bit indices, and a car body exceeds
      // 65535 vertices often enough to matter. Narrowing is only safe when it
      // genuinely fits.
      ext = gl.getExtension('OES_element_index_uint');
      const idx = ext ? indices : new Uint16Array(indices);
      if (!ext && positions.length / 3 > 65535) {
        throw new Error('This model needs 32-bit indices and the browser will not give them.');
      }
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffers.index);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
      count = indices.length;

      let lo = [Infinity, Infinity, Infinity];
      let hi = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < positions.length; i += 3) {
        for (let k = 0; k < 3; k++) {
          if (positions[i + k] < lo[k]) lo[k] = positions[i + k];
          if (positions[i + k] > hi[k]) hi[k] = positions[i + k];
        }
      }
      cam.target = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
      cam.dist = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) * 1.6 || 6;
      // New geometry gets the orbit camera framed on it, every time. Cockpit
      // mode is opt-in per call — setCockpit, after this — so a tab switch
      // that only wants the whole car back is never left looking out of a
      // dashboard from the last time cockpit mode ran.
      cam.mode = 'orbit';
      draw();
    },

    /**
     * Put the current texture on the car.
     *
     * The SVG goes through an Image, which is the only way a browser will
     * rasterise one for WebGL. It is self-contained — no external references, no
     * fonts fetched over the wire — so the canvas does not become tainted and
     * the upload is allowed.
     */
    async setTexture(svg, w = 1024, h = w) {
      await uploadSvg(texture, svg, ...capped(w, h, gl.getParameter(gl.MAX_TEXTURE_SIZE)));
      draw();
    },

    /**
     * The whole car: geometry grouped by surface, and one texture per group.
     *
     * Each surface is rasterised at the size of the texture it REPLACES, which
     * the server sends down beside the svg. This used to be a flat 512 square,
     * justified by "thirty-seven surfaces at full size is a hundred megabytes"
     * — but thirty-seven is the number of textures on the CAR, and the number
     * a design paints is seven. The body sheet is 2048x2048, so the livery was
     * being shown at a quarter of its resolution, immediately beside the car's
     * own stock artwork uploaded from the kn5 at full size. That contrast is
     * what "fuzzy" looks like, and no amount of filtering would have fixed it
     * because the detail was gone before the GPU saw it.
     *
     * The budget is still real, just applied to what is actually there rather
     * than to what might have been.
     */
    /** True colour, or shaded like a car. The UV tab is unaffected either way. */
    setLit(on) { lit = !!on; draw(); },

    /**
     * Orbit the car, as opposed to sitting in it. Asked for by the whole-car
     * view rather than arriving as a side effect of handing over geometry —
     * setWholeCar only uploads when the buffers changed, so it is no longer in
     * a position to decide what camera you wanted.
     */
    setOrbit() { cam.mode = 'orbit'; draw(); },

    /**
     * Switch to the cockpit camera: eye fixed at `eye` (the point the profile
     * measured the steering wheel from), drag looks around instead of
     * orbiting. Call after setWholeCar, which frames the orbit camera on new
     * geometry and would otherwise fight this.
     *
     * Re-entering with the same eye keeps the current look direction — a
     * livery edit that reloads the whole car should not snap your view back
     * to dead ahead — but the first entry, or a different eye (a different
     * car), starts you looking forward, roughly level. That only works because
     * setWholeCar no longer forces orbit mode on its way past.
     */
    setCockpit(eye) {
      const moved = cam.mode !== 'cockpit'
        || eye.x !== cam.eye[0] || eye.y !== cam.eye[1] || eye.z !== cam.eye[2];
      if (moved) { cam.yaw = 0; cam.pitch = 0.03; }
      cam.mode = 'cockpit';
      cam.eye = [eye.x, eye.y, eye.z];
      draw();
    },

    async setWholeCar(model, surfaces, { budget = 192 * 1024 * 1024 } = {}) {
      // ONLY WHEN THE GEOMETRY ACTUALLY CHANGED.
      //
      // This runs on every re-render of the whole-car and cockpit views — every
      // livery edit, every tab switch — and app.js caches the unpacked model,
      // so the same typed arrays arrive here over and over. Re-uploading them
      // costs tens of megabytes of bufferData for nothing.
      //
      // It also reset the camera. setGeometry frames the orbit camera on the
      // geometry and puts the view back in orbit mode, which is right for NEW
      // geometry and wrong here: setCockpit, called straight after this by
      // loadCockpit, then saw a mode that was never 'cockpit' and snapped the
      // look direction back to dead ahead. The comment promising that
      // re-entering the cockpit keeps your view had never once been true.
      //
      // The mode belongs to the caller either way — see setOrbit below.
      const same = uploaded
        && uploaded.positions === model.positions
        && uploaded.uvs === model.uvs
        && uploaded.normals === model.normals
        && uploaded.tangents === model.tangents
        && uploaded.indices === model.indices;
      // setGeometry clears the grouping, so the groups go on afterwards. The
      // order matters: a frame drawn with the new buffers and the old group
      // offsets would index past the end of them. Unchanged buffers cannot
      // have that problem, so the existing groups stay and the intermediate
      // frames keep drawing the car instead of nothing.
      if (!same) this.setGeometry(model);

      // PER SURFACE, and reported.
      //
      // This loop used to be a bare `await` in sequence, so one surface whose
      // svg the browser would not rasterise threw, abandoned the remaining
      // uploads AND the stock-texture pass, and returned before `groups` was
      // ever assigned — leaving the previous frame's state on screen. From the
      // outside that is indistinguishable from "the new surface did not
      // render", and it puts nothing in the console, because the throw is
      // swallowed by whoever called this.
      //
      // A surface that fails now keeps its grey and says which one it was.
      const failed = [];
      const sizes = textureSizes(surfaces, { budget, max: gl.getParameter(gl.MAX_TEXTURE_SIZE) });
      for (const [i, s] of surfaces.entries()) {
        if (!byRole.has(s.role)) byRole.set(s.role, greyTexture());
        try {
          await uploadSvg(byRole.get(s.role), s.svg, sizes[i].w, sizes[i].h);
        } catch (e) {
          failed.push(`${s.role}: ${e.message}`);
        }
      }

      // The parts the design does NOT paint, wearing the car's own artwork.
      //
      // Each arrives as its own group with a `file` and no role. Fetching them
      // is what makes this view answer its actual question — does the design
      // work on this car — rather than showing a livery floating on a grey
      // mannequin. Anything that cannot be fetched or uploaded keeps the grey,
      // which is what all of them did before.
      //
      // Sequential rather than parallel: a GT3 car has tens of these, several of
      // them megabytes, and firing them all at a local server at once buys
      // nothing anybody can perceive while making the failure modes worse.
      byFile.clear();
      byDetail.clear();

      // ASKED FOR FIRST, fetched second, uploaded third.
      //
      // Gathering up front is what makes a file fetched once when six groups
      // share it — this car's carbon is wanted as a detail by four materials
      // and as a plain texture by the shift paddles. Keyed by map AND name,
      // because those two wants are different uploads of the same bytes: one
      // clamped with no chain, one repeating with a full one.
      const wanted = [];
      const asked = new Set();
      const want = (map, file, upload, kind) => {
        if (!file || asked.has(`${kind}:${file}`)) return;
        asked.add(`${kind}:${file}`);
        wanted.push({ map, file, upload });
      };
      for (const g of model.groups ?? []) {
        if (g.role !== null) continue;
        want(byFile, g.file, uploadDds, 'f');
        // A two-layer material needs both halves: the per-part bake, which is
        // an ordinary stock sheet and files with the rest, and the small
        // tiling material over it, which needs the other upload path.
        if (g.detail) {
          want(byFile, g.detail.diffuse, uploadDds, 'f');
          want(byDetail, g.detail.detail, uploadDetail, 'd');
          // The grain, uploaded exactly like the colour beside it: same
          // repeat wrap, same mip chain, same tiling in the shader.
          want(byDetail, g.detail.normal, uploadDetail, 'd');
        }
      }

      // A few lanes rather than one after another. These are tens of files and
      // several megabytes and the round trips do not depend on each other, so
      // waiting for each before starting the next spends the whole load in
      // series for no reason. Bounded rather than unbounded, which is what the
      // sequential version was really protecting: firing eighty requests at a
      // local server at once buys nothing anybody can perceive and makes the
      // failure modes worse.
      const LANES = 6;
      const bytes = new Array(wanted.length).fill(null);
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(LANES, wanted.length) }, async () => {
        while (next < wanted.length) {
          const i = next;
          next += 1;
          try {
            const res = await fetch(`/api/stock?file=${encodeURIComponent(wanted[i].file)}`);
            if (res.ok) bytes[i] = await res.arrayBuffer();
          } catch { /* the grey is a fine answer */ }
        }
      }));

      // Uploaded in the order they were ASKED for, not the order they arrived.
      // GL work is serial whatever this does, and a fixed order means a texture
      // that fails to upload fails the same way twice instead of depending on
      // which download won a race.
      for (let i = 0; i < wanted.length; i++) {
        const { map, file, upload } = wanted[i];
        if (!bytes[i] || map.has(file)) continue;
        const tex = greyTexture();
        try {
          if (upload(tex, bytes[i])) map.set(file, tex);
        } catch { /* the grey is a fine answer */ }
      }

      // Centres now, not per frame: the geometry does not move and the sort
      // runs on every draw.
      groups = (model.groups ?? []).map((g) => ({
        ...g, centre: centreOf(g, model.positions, model.indices),
      }));
      if (!groups.length) groups = null;
      draw();
      // Handed back rather than logged, so the caller can put it on screen. A
      // viewer that cannot draw part of the car should say so where the person
      // is looking, not in a console they have no reason to open.
      return {
        uploaded: surfaces.length - failed.length,
        failed,
        groups: groups?.length ?? 0,
        blended: (groups ?? []).filter((g) => g.blend).length,
        additive: (groups ?? []).filter((g) => g.add).length,
      };
    },

    /**
     * Show where the selected region lands on the car.
     *
     * `rect` is [x, y, w, h] in texture space — the same absolute fractions the
     * UV overlay draws, so the two views cannot disagree about where a region
     * is. Pass null to clear.
     *
     * A rectangle can highlight in several places at once, and that is a
     * feature rather than a bug to be suppressed. Four wheels drawn from one rim
     * texture ARE the same texels: selecting a region on that sheet lights all
     * four, which is the clearest possible statement of a fact the UV view can
     * only make in a footnote.
     */
    setHighlight(rects) {
      ({ region, panel, twin, twinPanel, border } = highlightUniforms(rects));
      draw();
    },

    /**
     * What texel is under this point on the canvas.
     *
     * Brute force over every triangle, nearest hit wins. A body is around forty
     * thousand triangles and this comes in near a millisecond, which is far
     * inside a frame — an acceleration structure would be code to get wrong in
     * exchange for time nobody is short of. It would matter if this ran per
     * pixel; it runs per pointer event.
     *
     * Returns texture-space UV, the same coordinates a panel rectangle is in, so
     * the caller never has to know a ray was involved.
     */
    pickUV(clientX, clientY) {
      if (!mesh) return null;
      const r = canvas.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      const ndcX = ((clientX - r.left) / r.width) * 2 - 1;
      const ndcY = 1 - ((clientY - r.top) / r.height) * 2;
      const eye = eyePosition();
      const { orig, dir } = cameraRay(
        eye, lookTarget(eye), [0, 1, 0], 0.8, r.width / r.height, ndcX, ndcY);

      const { positions, uvs, indices } = mesh;
      let best = null;
      const at = (i) => [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
      for (let i = 0; i < indices.length; i += 3) {
        const [ia, ib, ic] = [indices[i], indices[i + 1], indices[i + 2]];
        const hit = rayTriangle(orig, dir, at(ia), at(ib), at(ic));
        // `i` as well: it is the offset into the index buffer, which is what the
        // groups are cut on, so it says WHICH SURFACE was hit. In the whole-car
        // view that is the only way to find out — the geometry is one buffer and
        // a UV coordinate means something different on every texture in it.
        if (hit && (!best || hit.dist < best.dist)) best = { ...hit, ia, ib, ic, i };
      }
      if (!best) return null;

      // Barycentric interpolation of the corners' UVs: w for the first vertex,
      // u for the second, v for the third, in Möller–Trumbore's naming.
      const w = 1 - best.u - best.v;
      const uv = (k) => uvs[best.ia * 2 + k] * w + uvs[best.ib * 2 + k] * best.u
        + uvs[best.ic * 2 + k] * best.v;
      const group = (groups ?? []).find((g) => best.i >= g.start && best.i < g.start + g.count);
      return { u: uv(0), v: uv(1), dist: best.dist, group: group ?? null };
    },

    /**
     * Drag to orbit, wheel to zoom — unless `claim` takes the gesture first.
     *
     * The camera cannot simply own every pointerdown once regions are draggable
     * on the car, and the decision needs the pick, which only the viewer can do.
     * So the viewer offers the hit to `claim` and orbits only if it declines.
     */
    attach({ claim = null } = {}) {
      let dragging = null;
      canvas.onpointerdown = (e) => {
        if (claim && claim(this.pickUV(e.clientX, e.clientY), e)) return;
        dragging = { x: e.clientX, y: e.clientY, yaw: cam.yaw, pitch: cam.pitch };
        // Capture is an optimisation — it keeps the orbit alive when the pointer
        // leaves the canvas — and it is allowed to fail. It throws
        // "Invalid pointer id" for a pointer the browser is not currently
        // tracking, and an exception here escapes the handler and abandons the
        // gesture entirely: the camera stops responding for no visible reason.
        try { canvas.setPointerCapture(e.pointerId); } catch { /* orbit anyway */ }
      };
      canvas.onpointermove = (e) => {
        if (!dragging) return;
        cam.yaw = dragging.yaw - (e.clientX - dragging.x) * 0.008;
        // Stop just short of the poles, where the up vector degenerates and the
        // view flips inside out.
        cam.pitch = Math.max(-1.5, Math.min(1.5, dragging.pitch + (e.clientY - dragging.y) * 0.008));
        draw();
      };
      canvas.onpointerup = () => { dragging = null; };
      canvas.onwheel = (e) => {
        e.preventDefault();
        cam.dist = Math.max(0.5, Math.min(40, cam.dist * (1 + Math.sign(e.deltaY) * 0.12)));
        draw();
      };
      window.addEventListener('resize', draw);
    },

    draw,
  };
}
