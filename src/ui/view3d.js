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
// which is the one thing this view exists to show honestly. The faint edge
// darkening is depth cueing only, so the shape reads at all.
const FS = `
precision mediump float;
uniform sampler2D map;
varying vec2 vUv;
void main() {
  gl_FragColor = vec4(texture2D(map, vUv).rgb, 1.0);
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
  };

  const buffers = { position: gl.createBuffer(), uv: gl.createBuffer(), index: gl.createBuffer() };
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  // A single grey texel, so the shape is visible before the first render arrives.
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
    new Uint8Array([60, 66, 78, 255]));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  gl.enable(gl.DEPTH_TEST);
  // Both faces. Car meshes are not reliably wound one way, and a missing
  // half-shell reads as a hole in the car rather than as a culling choice.
  gl.disable(gl.CULL_FACE);
  gl.clearColor(0.02, 0.03, 0.04, 1);

  const cam = { yaw: -0.9, pitch: 0.35, dist: 6, target: [0, 0.7, 0] };
  let count = 0;
  let ext = null;

  function resize() {
    const w = canvas.clientWidth || 800;
    const h = canvas.clientHeight || 600;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    gl.viewport(0, 0, canvas.width, canvas.height);
  }

  function draw() {
    resize();
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!count) return;

    const eye = [
      cam.target[0] + cam.dist * Math.cos(cam.pitch) * Math.sin(cam.yaw),
      cam.target[1] + cam.dist * Math.sin(cam.pitch),
      cam.target[2] + cam.dist * Math.cos(cam.pitch) * Math.cos(cam.yaw),
    ];
    const mvp = mul(
      perspective(0.8, canvas.width / canvas.height, 0.05, 100),
      lookAt(eye, cam.target, [0, 1, 0]),
    );
    gl.uniformMatrix4fv(loc.mvp, false, new Float32Array(mvp));
    gl.uniform1i(loc.map, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.drawElements(gl.TRIANGLES, count, ext ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT, 0);
  }

  return {
    /** Upload geometry, and frame the camera on whatever it just received. */
    setGeometry({ positions, uvs, indices }) {
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
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        draw();
      } finally {
        URL.revokeObjectURL(url);
      }
    },

    /** Drag to orbit, wheel to zoom. */
    attach() {
      let dragging = null;
      canvas.onpointerdown = (e) => {
        dragging = { x: e.clientX, y: e.clientY, yaw: cam.yaw, pitch: cam.pitch };
        canvas.setPointerCapture(e.pointerId);
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
