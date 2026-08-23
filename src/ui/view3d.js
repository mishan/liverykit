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
uniform mat4 mvp;
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = mvp * vec4(position, 1.0);
}`;

// No lighting on purpose. A shaded preview would misreport the artwork's colour,
// which is the one thing this view exists to show honestly.
//
// The highlight obeys the same rule, and that decides its whole design. Tinting
// the selected region would be the obvious way to show it and would break the
// one promise this view makes, precisely where the promise matters most — on
// the region you are working on. So the selection keeps its true colours and
// EVERYTHING ELSE is dimmed toward the background, with an accent border on the
// rectangle's edge so a dark region against dark bodywork still reads.
//
// The test is per-fragment against the region's UV rectangle rather than
// per-triangle. A region rarely lands on triangle boundaries, so a per-triangle
// highlight would spill over the edges of the very thing it is drawing your
// attention to, and the spill would be worst on coarse geometry where you can
// least afford to misjudge the fit.
//
// THREE zones, not two. Dimming everything outside the region told you where
// the artwork was but not where it was allowed to go, and `at` is
// panel-relative — the panel is the boundary every drag is clamped to, so
// working without seeing it means finding the edges by hitting them.
//
//   inside the region      true colour, accent border, a grab corner
//   rest of the host panel lightly dimmed, its own quiet border
//   the rest of the car    dimmed hard
//
// The grab corner is drawn at exactly the size the hit test uses, so what you
// can see is what you can grab. Resizing existed before this and was invisible,
// which is the same as not existing.
const FS = `
precision mediump float;
uniform sampler2D map;
uniform vec4 region;      // what you are working on; w = 0 means no selection
uniform vec4 panel;       // its host panel, the boundary it is clamped to
uniform vec4 twin;        // its opposite number, which moves with it
uniform vec4 twinPanel;   // and where that one lives
uniform float border;     // border thickness, in UV units
varying vec2 vUv;

bool within(vec4 r, vec2 p) {
  vec2 d = p - r.xy;
  return r.z > 0.0 && d.x >= 0.0 && d.y >= 0.0 && d.x <= r.z && d.y <= r.w;
}
float edgeDist(vec4 r, vec2 p) {
  vec2 d = p - r.xy;
  return min(min(d.x, r.z - d.x), min(d.y, r.w - d.y));
}

void main() {
  vec3 c = texture2D(map, vUv).rgb;
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
  gl_FragColor = vec4(c, 1.0);
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
  const indices = new Uint32Array(buffer, o, meta.indexCount);
  return { positions, uvs, indices, groups: meta.groups, bounds: meta.bounds };
}

/** Unpack the server's blob: two counts, then positions, UVs and indices. */
export function unpack(buffer) {
  const head = new Uint32Array(buffer, 0, 2);
  const [vertexCount, indexCount] = head;
  let o = 8;
  const positions = new Float32Array(buffer, o, vertexCount * 3); o += vertexCount * 12;
  const uvs = new Float32Array(buffer, o, vertexCount * 2); o += vertexCount * 8;
  const indices = new Uint32Array(buffer, o, indexCount);
  return { positions, uvs, indices };
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

export function createViewer(canvas) {
  const gl = canvas.getContext('webgl', { antialias: true, preserveDrawingBuffer: false });
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
    mvp: gl.getUniformLocation(prog, 'mvp'),
    map: gl.getUniformLocation(prog, 'map'),
    region: gl.getUniformLocation(prog, 'region'),
    panel: gl.getUniformLocation(prog, 'panel'),
    twin: gl.getUniformLocation(prog, 'twin'),
    twinPanel: gl.getUniformLocation(prog, 'twinPanel'),
    border: gl.getUniformLocation(prog, 'border'),
  };

  const buffers = { position: gl.createBuffer(), uv: gl.createBuffer(), index: gl.createBuffer() };

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
  let groups = null;
  // Kept on the CPU as well as uploaded, because picking needs to intersect it.
  // A body is a megabyte of floats; holding it is cheaper than a round trip to
  // the server on every pointer event.
  let mesh = null;

  gl.enable(gl.DEPTH_TEST);
  // Both faces. Car meshes are not reliably wound one way, and a missing
  // half-shell reads as a hole in the car rather than as a culling choice.
  gl.disable(gl.CULL_FACE);
  gl.clearColor(0.02, 0.03, 0.04, 1);

  const cam = { yaw: -0.9, pitch: 0.35, dist: 6, target: [0, 0.7, 0] };
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

  function resize() {
    const w = canvas.clientWidth || 800;
    const h = canvas.clientHeight || 600;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    gl.viewport(0, 0, canvas.width, canvas.height);
  }

  /** Where the camera is, given the orbit angles. Used to draw and to pick. */
  function eyePosition() {
    return [
      cam.target[0] + cam.dist * Math.cos(cam.pitch) * Math.sin(cam.yaw),
      cam.target[1] + cam.dist * Math.sin(cam.pitch),
      cam.target[2] + cam.dist * Math.cos(cam.pitch) * Math.cos(cam.yaw),
    ];
  }

  function draw() {
    resize();
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!count) return;

    const eye = eyePosition();
    const mvp = mul(
      perspective(0.8, canvas.width / canvas.height, 0.05, 100),
      lookAt(eye, cam.target, [0, 1, 0]),
    );
    gl.uniformMatrix4fv(loc.mvp, false, new Float32Array(mvp));
    gl.uniform1i(loc.map, 0);
    gl.uniform1f(loc.border, border);
    gl.activeTexture(gl.TEXTURE0);
    const bytes = ext ? 4 : 2;
    const type = ext ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;

    if (!groups) {
      gl.uniform4fv(loc.region, region);
      gl.uniform4fv(loc.panel, panel);
      gl.uniform4fv(loc.twin, twin);
      gl.uniform4fv(loc.twinPanel, twinPanel);
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
    for (const g of groups) {
      // In order: the design's own render for a painted role, then the car's
      // own texture for a part the design skips, then grey.
      //
      // `unpainted`, never `texture`: a group with no role is a part of the car
      // this design does not paint, and falling back to the surface being
      // edited put the body artwork on the glass.
      gl.bindTexture(gl.TEXTURE_2D,
        byRole.get(g.role) ?? byFile.get(g.file) ?? unpainted);
      gl.drawElements(gl.TRIANGLES, g.count, type, g.start * bytes);
    }
  }

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
  function uploadDds(target, buffer) {
    const s3tc = gl.getExtension('WEBGL_compressed_texture_s3tc');
    // 128 is the header, and every field read below lives inside it. The block
    // data is checked separately once its size is known — guessing a floor here
    // rejected a legitimate single-block texture.
    if (!s3tc || !buffer || buffer.byteLength < 128) return false;
    const head = new DataView(buffer);
    if (head.getUint32(0, true) !== 0x20534444) return false;   // 'DDS '

    const height = head.getUint32(12, true);
    const width = head.getUint32(16, true);
    const fourCC = head.getUint32(84, true);
    const format = {
      0x31545844: [s3tc.COMPRESSED_RGB_S3TC_DXT1_EXT, 8],       // 'DXT1'
      0x33545844: [s3tc.COMPRESSED_RGBA_S3TC_DXT3_EXT, 16],     // 'DXT3'
      0x35545844: [s3tc.COMPRESSED_RGBA_S3TC_DXT5_EXT, 16],     // 'DXT5'
    }[fourCC];
    if (!format || !width || !height) return false;
    const [glFormat, blockBytes] = format;

    // The top mip only. The chain after it would be nice for minification and
    // costs a third more memory and a loop over sizes; at the distance this view
    // is used, on parts the design does not paint, it buys nothing.
    const blocks = Math.ceil(width / 4) * Math.ceil(height / 4) * blockBytes;
    if (buffer.byteLength < 128 + blocks) return false;

    // The header can read perfectly and the upload still fail: S3TC in WebGL 1
    // wants dimensions that are multiples of four, and a large texture can
    // simply run out of memory. Both THROW, and an exception here would escape
    // `setWholeCar` and take the whole view down over a wing mirror. This
    // function's contract is that every failure answers `false` and the caller
    // keeps the grey, so the contract has to cover the driver too.
    try {
      gl.bindTexture(gl.TEXTURE_2D, target);
      gl.compressedTexImage2D(gl.TEXTURE_2D, 0, glFormat, width, height, 0,
        new Uint8Array(buffer, 128, blocks));
    } catch {
      return false;
    }
    // No mip chain was uploaded, so LINEAR rather than a MIPMAP filter — asking
    // for mips that are not there renders the texture as nothing at all, black
    // and silent, which is a memorable afternoon.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return true;
  }

  /** Rasterise an SVG into a texture. The only way a browser will do it. */
  async function uploadSvg(target, svg, size) {
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    try {
      const img = new Image();
      img.width = size;
      img.height = size;
      await new Promise((ok, fail) => {
        img.onload = ok;
        img.onerror = () => fail(new Error('the browser could not rasterise the texture'));
        img.src = url;
      });
      const c = document.createElement('canvas');
      c.width = c.height = size;
      c.getContext('2d').drawImage(img, 0, 0, size, size);
      gl.bindTexture(gl.TEXTURE_2D, target);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  return {
    /** Upload geometry, and frame the camera on whatever it just received. */
    setGeometry({ positions, uvs, indices }) {
      groups = null;
      mesh = { positions, uvs, indices };
      gl.bindBuffer(gl.ARRAY_BUFFER, buffers.position);
      gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(loc.position);
      gl.vertexAttribPointer(loc.position, 3, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, buffers.uv);
      gl.bufferData(gl.ARRAY_BUFFER, uvs, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(loc.uv);
      gl.vertexAttribPointer(loc.uv, 2, gl.FLOAT, false, 0, 0);

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
    async setTexture(svg, size = 1024) {
      await uploadSvg(texture, svg, size);
      draw();
    },

    /**
     * The whole car: geometry grouped by surface, and one texture per group.
     *
     * Textures are rasterised at 512 rather than 1024. Thirty-seven surfaces at
     * full size is a hundred megabytes of GPU memory and several seconds of SVG
     * rasterisation to look at a car from four metres away, and at that distance
     * the difference is invisible. The per-surface view, where you are actually
     * judging placement, keeps the full size.
     */
    async setWholeCar(model, surfaces, size = 512) {
      // setGeometry clears the grouping, so the groups go on afterwards. The
      // order matters: a frame drawn with the new buffers and the old group
      // offsets would index past the end of them.
      this.setGeometry(model);
      for (const s of surfaces) {
        if (!byRole.has(s.role)) byRole.set(s.role, greyTexture());
        await uploadSvg(byRole.get(s.role), s.svg, size);
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
      for (const g of model.groups ?? []) {
        if (g.role !== null || !g.file || byFile.has(g.file)) continue;
        try {
          const res = await fetch(`/api/stock?file=${encodeURIComponent(g.file)}`);
          if (!res.ok) continue;
          const tex = greyTexture();
          if (uploadDds(tex, await res.arrayBuffer())) byFile.set(g.file, tex);
        } catch { /* the grey is a fine answer */ }
      }

      groups = model.groups ?? null;
      draw();
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
      const { orig, dir } = cameraRay(
        eyePosition(), cam.target, [0, 1, 0], 0.8, r.width / r.height, ndcX, ndcY);

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
