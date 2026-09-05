// ---------------------------------------------------------------------------
// Synthetic kn5 models.
//
// Game assets cannot be committed — a car's kn5 is somebody else's artwork, and
// several of them are deliberately encrypted by their authors — so every test
// that needs a model builds one here. That constraint turns out to be a feature:
// a fixture states its own dimensions and UV layout in source, so a test can
// assert exact numbers instead of ranges guessed from a real car.
//
// The format is reverse-engineered, and this layout was verified byte-exact
// against a real 50 MB car before that car was put out of reach of the test
// suite. The exact-length assertion in the parser tests is what keeps it honest.
//
// Vertices are 11 floats: position, normal, UV, then three more the parser skips.
// V IS STORED NEGATIVE — AC's convention, where image y is 1 + v — so `uv()`
// below takes the image coordinate you actually mean and does the flip for you.
// Writing -0.75 by hand and meaning 0.25 is how this went wrong the first time.
// ---------------------------------------------------------------------------

const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const f32 = (n) => { const b = Buffer.alloc(4); b.writeFloatLE(n); return b; };
const str = (s) => Buffer.concat([u32(Buffer.byteLength(s)), Buffer.from(s, 'utf8')]);

/** A vertex, taking the UV you mean rather than the one the file stores. */
export const vert = (x, y, z, u, v, n = [0, 1, 0]) =>
  [x, y, z, n[0], n[1], n[2], u, v - 1, 0, 0, 0];

/** A 4x4 translation, column-major, as the file stores node transforms. */
const translation = (x, y, z) => Buffer.concat(
  [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1].map(f32));

const IDENTITY = translation(0, 0, 0);

export function buildKn5({
  version = 6, extraMeshes = [], dummies = [],
  placeholderTexture = false, encrypted = false, bodyMesh = null,
  // Meshes under a NAMED PARENT NODE, for the rules that read a mesh's path
  // rather than its name — which cockpit LOD selection does, since both
  // cockpits contain meshes called the same thing and only the node above
  // them says which is which. `[{ name, meshes: [...] }]`.
  wrapped = [],
  // The one material this fixture emits, for tests about MATERIALS rather than
  // about geometry: `{ shader, props: { detailUVMultiplier: 377 }, slots: {
  // txDetail: 'carbon.dds' } }`. txDiffuse defaults to the texture above and
  // can be overridden — deliberately, since the spelling of a slot need not
  // match the spelling of the texture entry, and code that compares the two
  // with `===` has been wrong about that.
  material = {},
  // What the one texture is CALLED. Several rules read a texture's name — the
  // bake seed is one — so a test about those needs to choose it.
  textureName = 'body.dds',
} = {}) {
  const parts = [];

  parts.push(Buffer.from('sc6969', 'ascii'), u32(version));
  if (version > 5) parts.push(u32(0));

  // textures: one null slot (type 0, no further fields) then one real DDS
  const dds = Buffer.alloc(128); dds.write('DDS ', 0, 'ascii');
  // An encrypted model substitutes a 1x1 image for every texture; the real one
  // lives in the protected blob appended after the node tree.
  dds.writeUInt32LE(placeholderTexture ? 1 : 64, 12);          // height
  dds.writeUInt32LE(placeholderTexture ? 1 : 32, 16);          // width
  parts.push(u32(2), u32(0), u32(1), str(textureName), u32(dds.length), dds);

  // one material binding that texture as a diffuse
  const slots = { txDiffuse: textureName, ...(material.slots ?? {}) };
  const props = material.props ?? {};
  parts.push(
    u32(1), str(material.name ?? 'BodyMat'), str(material.shader ?? 'ksPerPixel'),
    Buffer.from([0, 0]), u32(0),
    // Each property is its key, then valueA, then 36 bytes of the vec2/3/4
    // behind it that the parser skips as one.
    u32(Object.keys(props).length),
    ...Object.entries(props).map(([k, v]) => Buffer.concat([str(k), f32(v), Buffer.alloc(36)])),
    u32(Object.keys(slots).length),
    ...Object.entries(slots).map(([k, v]) => Buffer.concat([str(k), u32(0), str(v)])),
  );

  // root dummy -> one mesh child, plus whatever the caller added
  const children = 1 + extraMeshes.length + dummies.length + wrapped.length;
  parts.push(u32(1), str('root'), u32(children), Buffer.from([1]), IDENTITY);

  const body = bodyMesh ?? {
    name: 'body_mesh',
    verts: [
      vert(0, 0, 0, 0.25, 0.25),
      vert(1, 0, 0, 0.75, 0.25),
      vert(0, 0, 1, 0.25, 0.75),
    ],
    indices: [0, 1, 2],
  };
  parts.push(mesh(body));

  // Extra meshes, for tests that need geometry the analysis will look for by
  // name (a steering wheel) or trip over (an occluder).
  for (const em of extraMeshes) parts.push(mesh(em));

  // A dummy with children, which is how a kn5 states COCKPIT_HR and everything
  // under it. The parser builds each mesh's `path` from this.
  for (const w of wrapped) {
    parts.push(u32(1), str(w.name), u32(w.meshes.length), Buffer.from([1]), IDENTITY);
    for (const m of w.meshes) parts.push(mesh(m));
  }

  // Dummies carry no geometry but do carry a transform, which is how AC states
  // where a wheel is — and therefore the only exact source for which way this
  // model calls forward.
  for (const d of dummies) {
    parts.push(u32(1), str(d.name), u32(0), Buffer.from([1]),
      translation(d.at[0], d.at[1], d.at[2]));
  }

  // Custom Shaders Patch appends the protected payload after the node tree and
  // ends the file with a length-prefixed marker.
  if (encrypted) {
    const marker = '__AC_SHADERS_PATCH_KN5ENC_v1__';
    parts.push(Buffer.alloc(4096, 0xab), u32(marker.length), Buffer.from(marker, 'ascii'),
      Buffer.from([0x44, 0x0a, 0x01]), u32(1));
  }
  return Buffer.concat(parts);
}

/** One mesh node: header, vertices, indices, then the 33-byte trailer. */
function mesh({ name, verts, indices = [] }) {
  // Indices matter: the occupancy grid is built by SAMPLING TRIANGLES, so a
  // mesh with no index buffer occupies nothing and cannot occlude.
  const idxBuf = Buffer.alloc(indices.length * 2);
  indices.forEach((v, i) => idxBuf.writeUInt16LE(v, i * 2));
  return Buffer.concat([
    u32(2), str(name), u32(0), Buffer.from([1]), Buffer.from([1, 1, 0]),
    u32(verts.length), ...verts.map((v) => Buffer.concat(v.map(f32))),
    u32(indices.length), idxBuf,
    u32(0),                  // materialId — first of the 33-byte trailer
    Buffer.alloc(29),        // layer, lodIn, lodOut, bounding sphere, isRenderable
  ]);
}

// ---------------------------------------------------------------------------
// A whole small car.
// ---------------------------------------------------------------------------

/** Exactly the dimensions of the fixture, so tests assert rather than estimate. */
export const CAR = {
  width: 1.9,      // x, -0.95 .. 0.95
  height: 1.5,     // y, 0 .. 1.5
  length: 3.7,     // z, -1.85 .. 1.85
  wheelbase: 2.4,
  track: 1.6,
  texture: 'body.dds',
  /** Subdivisions per face edge. Exported so tests count rather than guess. */
  grid: 6,
  faceCount: 6,
  /**
   * Where each face lands on the sheet, in texture space. Six faces on a 3x2
   * grid of quarters, with a margin so no two islands touch — islands that
   * share an edge in UV would merge and the fixture would silently have five
   * panels instead of six.
   */
  faces: {
    left:  [0.02, 0.02, 0.29, 0.46],
    right: [0.35, 0.02, 0.29, 0.46],
    roof:  [0.68, 0.02, 0.29, 0.46],
    front: [0.02, 0.52, 0.29, 0.46],
    rear:  [0.35, 0.52, 0.29, 0.46],
    floor: [0.68, 0.52, 0.29, 0.46],
  },
};

/**
 * A car-shaped box with one island per face and four wheel nodes.
 *
 * Six separate quads rather than a shared-vertex cube, deliberately: a cube
 * with welded corners is ONE UV island, and the whole point of a fixture for
 * panel work is that it decomposes into panels you can name. Real unwraps split
 * at exactly these seams for exactly this reason.
 *
 * The wheels are what make it a car rather than a box. AC requires WHEEL_LF and
 * friends, the axes are derived from them, and a fixture without them exercises
 * only the fallback path.
 */
export function carKn5() {
  const x0 = -CAR.width / 2, x1 = CAR.width / 2;
  const y0 = 0, y1 = CAR.height;
  const z0 = -CAR.length / 2, z1 = CAR.length / 2;

  // Each face as four corners in 3D, paired with the UV rect it unwraps to.
  const faces = [
    ['left',  [[x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]], [1, 0, 0]],
    ['right', [[x0, y0, z1], [x0, y0, z0], [x0, y1, z0], [x0, y1, z1]], [-1, 0, 0]],
    ['roof',  [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], [0, 1, 0]],
    ['front', [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1]],
    ['rear',  [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], [0, 0, -1]],
    ['floor', [[x0, y0, z1], [x1, y0, z1], [x1, y0, z0], [x0, y0, z0]], [0, -1, 0]],
  ];

  // Each face is subdivided into an N x N grid rather than left as one quad.
  // Two reasons, both learned the hard way. Profile generation drops any island
  // under 40 vertices as a sliver, so a four-corner face decomposes into no
  // panels at all and a profile built from the fixture comes back empty. And a
  // single quad cannot show anything a per-fragment highlight does that a
  // per-triangle one does not, which is the behaviour worth a fixture for.
  const N = CAR.grid;
  const verts = [];
  const indices = [];
  for (const [name, corners, normal] of faces) {
    const [rx, ry, rw, rh] = CAR.faces[name];
    const [c0, c1, c2, c3] = corners;
    const base = verts.length;
    // Bilinear across the quad, in 3D and in UV together, so the unwrap stays
    // exactly proportional and a rectangle in texture space is a rectangle on
    // the car. A test can then predict where a highlight lands.
    for (let j = 0; j <= N; j++) {
      for (let i = 0; i <= N; i++) {
        const s = i / N, t = j / N;
        const p = [0, 1, 2].map((k) =>
          c0[k] * (1 - s) * (1 - t) + c1[k] * s * (1 - t) + c2[k] * s * t + c3[k] * (1 - s) * t);
        verts.push(vert(p[0], p[1], p[2], rx + s * rw, ry + t * rh, normal));
      }
    }
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const a = base + j * (N + 1) + i;
        indices.push(a, a + 1, a + N + 2, a, a + N + 2, a + N + 1);
      }
    }
  }

  const hx = CAR.track / 2, hz = CAR.wheelbase / 2;
  return buildKn5({
    bodyMesh: { name: 'BODY_SHELL', verts, indices },
    dummies: [
      // +X is the car's left and +Z its front, which is the common convention
      // and the one these coordinates describe.
      { name: 'WHEEL_LF', at: [hx, 0.3, hz] },
      { name: 'WHEEL_RF', at: [-hx, 0.3, hz] },
      { name: 'WHEEL_LR', at: [hx, 0.3, -hz] },
      { name: 'WHEEL_RR', at: [-hx, 0.3, -hz] },
    ],
  });
}
