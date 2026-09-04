// ---------------------------------------------------------------------------
// kn5 reader — Assetto Corsa's model format.
//
// This is the thing that makes a car profile a measurement rather than an
// estimate. A kn5 stores, per vertex, both a 3D position and a UV coordinate.
// That is exactly the mapping the screenshot calibration workflow spends an
// afternoon approximating, available exactly, for free, in one pass.
//
// THE FORMAT IS REVERSE-ENGINEERED, not documented. Every field below was
// verified against a real 50 MB car by parsing until the reader consumed the
// file to its final byte — an off-by-one anywhere desynchronises everything
// after it, so an exact-length parse is a strong check that the layout is
// right. `parseKn5` asserts it, and you should treat a failure as "the layout
// is wrong for this file" rather than something to paper over.
//
// Layout, all little-endian, strings as int32 length + UTF-8 bytes:
//
//   header    "sc6969", int32 version, and for version > 5 an extra int32
//
//   textures  int32 count, then per texture:
//               int32 type   — 0 means an empty slot with NO further fields
//               string name
//               int32 byteLength
//               byte[byteLength]   (a DDS or PNG blob)
//
//   materials int32 count, then per material:
//               string name, string shader
//               byte alphaBlendMode, byte alphaTested, int32 depthMode
//               int32 propCount, then per property:
//                 string name, float valueA, vec2 valueB, vec3 valueC, vec4 valueD
//                 (40 bytes of values)
//               int32 slotCount, then per slot:
//                 string sampleName, int32 slot, string textureName
//
//   nodes     a tree from a single root. Per node:
//               int32 type (1 dummy, 2 mesh, 3 skinned mesh)
//               string name, int32 childCount, byte active
//               type 1: 64 bytes of 4x4 transform
//               type 2: 3 flag bytes (castShadows, visible, transparent)
//                       int32 vertexCount, vertices at 44 bytes each
//                         (position vec3, normal vec3, uv vec2, tangent vec3)
//                       int32 indexCount, uint16 indices
//                       33-byte trailer: int32 materialId, int32 layer,
//                         float lodIn, float lodOut, 16 bytes bounding sphere,
//                         byte isRenderable
//               type 3: 3 flag bytes FIRST, then int32 boneCount and per bone
//                       a string plus 64 bytes; vertices are 76 bytes each
//                       (the extra 32 are bone weights/indices); 16-byte trailer
//             then childCount children.
//
// Two traps worth naming:
//
//   * V is negative. UVs come out in [-1, 0], and texture-space y is 1 + v.
//     Getting this wrong flips every panel vertically, which looks plausible
//     enough to ship.
//   * Type 3 puts its flag bytes BEFORE the bone list, unlike what you would
//     guess from type 2. Suspension parts are skinned, so a car with any
//     moving geometry desynchronises immediately if this is wrong.
// ---------------------------------------------------------------------------

import { readFile } from 'node:fs/promises';

const MAGIC = 'sc6969';

class Cursor {
  constructor(buf) { this.b = buf; this.o = 0; }
  u8()  { return this.b.readUInt8(this.o++); }
  u32() { const v = this.b.readUInt32LE(this.o); this.o += 4; return v; }
  f32() { const v = this.b.readFloatLE(this.o); this.o += 4; return v; }
  skip(n) { this.o += n; }
  str() {
    const n = this.u32();
    const s = this.b.toString('utf8', this.o, this.o + n);
    this.o += n;
    return s;
  }
}

export async function parseKn5(path, { keepTextureData = false } = {}) {
  return parseKn5Buffer(await readFile(path), { keepTextureData, path });
}

export function parseKn5Buffer(buf, { keepTextureData = false, path = '<buffer>' } = {}) {
  const c = new Cursor(buf);

  const magic = buf.toString('ascii', 0, 6);
  if (magic !== MAGIC) {
    throw new Error(`${path} is not a kn5 (expected magic "${MAGIC}", got "${magic}")`);
  }
  c.skip(6);
  const version = c.u32();
  if (version > 5) c.u32();

  // --- textures ---
  const textures = [];
  const texCount = c.u32();
  for (let i = 0; i < texCount; i++) {
    const type = c.u32();
    if (type === 0) continue;             // empty slot: no name, no blob
    const name = c.str();
    const size = c.u32();
    const start = c.o;
    c.skip(size);
    textures.push({ name, size, data: keepTextureData ? buf.subarray(start, start + size) : null });
  }

  // --- materials ---
  const materials = [];
  const matCount = c.u32();
  for (let i = 0; i < matCount; i++) {
    const name = c.str();
    const shader = c.str();
    c.skip(2);                            // alphaBlendMode, alphaTested
    c.u32();                              // depthMode
    // Read and dropped for a long time, which cost nothing while no shader
    // here sampled a second texture. `detailUVMultiplier` lives in here, and
    // without it a tiling detail map is drawn at 1:1 — a carbon weave at a
    // 20cm pitch instead of a 2mm one, which reads as abstract grey mush
    // rather than as carbon.
    //
    // Only valueA is kept. Every property this project has wanted is the
    // scalar, and the vec2/vec3/vec4 behind it are the remaining 36 bytes of
    // the fixed 40 — skipped as one, so the arithmetic stays in one place
    // instead of in four readers that have to agree.
    const props = {};
    const propCount = c.u32();
    for (let p = 0; p < propCount; p++) {
      const key = c.str();
      props[key] = c.f32();
      c.skip(36);
    }
    const slotCount = c.u32();
    const slots = {};
    for (let s = 0; s < slotCount; s++) {
      const sample = c.str();
      c.u32();                            // slot index
      slots[sample] = c.str();
    }
    materials.push({ name, shader, slots, props });
  }

  // --- node tree ---
  //
  // Dummy nodes carry a 4x4 transform and meshes inherit it, so vertex data is
  // in LOCAL space. Skipping the matrices leaves every suspension part sitting
  // at the origin — which looks fine until you try to reason about where
  // anything is on the car. Transforms are accumulated down the tree here.
  const meshes = [];
  // Dummy nodes are kept as well as meshes. A dummy carries a transform and
  // nothing else, which sounds skippable until you need the position of
  // something that is defined by its node rather than by its geometry — a wheel
  // centre, for instance, which AC places by the WHEEL_xx node's translation.
  const dummies = [];
  const readNode = (depth, parentPath, parentMatrix) => {
    const type = c.u32();
    const name = c.str();
    const childCount = c.u32();
    c.skip(1);                            // active
    const nodePath = parentPath ? `${parentPath}/${name}` : name;
    let world = parentMatrix;

    if (type === 1) {
      const m = new Float32Array(16);
      for (let i = 0; i < 16; i++) m[i] = c.f32();
      world = multiply(m, parentMatrix);
      dummies.push({ name, path: nodePath, depth, world });
    } else if (type === 2 || type === 3) {
      c.skip(3);                          // castShadows, visible, transparent
      let stride = 44;
      if (type === 3) {
        const boneCount = c.u32();
        for (let b = 0; b < boneCount; b++) { c.str(); c.skip(64); }
        stride = 76;                      // + bone weights and indices
      }
      const vertexCount = c.u32();
      const vertexStart = c.o;
      c.skip(vertexCount * stride);
      const indexCount = c.u32();
      const indexStart = c.o;
      c.skip(indexCount * 2);
      // The trailer is 33 bytes for a mesh and 16 for a skinned mesh, and the
      // materialId is the FIRST four of them — not an extra field in front.
      const materialId = c.u32();
      c.skip(type === 2 ? 29 : 12);
      meshes.push({
        name, path: nodePath, type, depth, materialId, world,
        vertexCount, vertexStart, stride, indexCount, indexStart,
      });
    } else {
      throw new Error(`${path}: unknown node type ${type} at byte ${c.o - 4}`);
    }

    for (let i = 0; i < childCount; i++) readNode(depth + 1, nodePath, world);
  };
  readNode(0, '', IDENTITY);

  // An exact-length parse is the whole validation strategy: any misread field
  // shifts every subsequent offset, so finishing precisely at EOF is very
  // unlikely to happen by accident.
  //
  // There is exactly one legitimate reason to finish early: an ENCRYPTED model,
  // where the readable part ends precisely where it should and a protected blob
  // follows it. That is a different situation from a corrupt or unknown layout
  // and deserves a different answer.
  const encrypted = trailingEncryption(buf, c.o);
  if (c.o !== buf.length && !encrypted) {
    throw new Error(
      `${path}: parser finished at byte ${c.o} but the file is ${buf.length} bytes ` +
      `(${buf.length - c.o > 0 ? 'short by' : 'over by'} ${Math.abs(buf.length - c.o)}).\n` +
      `  The node layout does not match this file — likely a kn5 version this ` +
      `reader hasn't seen. Nothing downstream should trust a partial parse.`
    );
  }

  return { version, textures, materials, meshes, dummies, buf, encrypted };
}

/**
 * Custom Shaders Patch encrypted models.
 *
 * Some mod authors publish a kn5 whose geometry is intact but whose textures
 * have been replaced with 1x1 placeholders, with the real ones appended in an
 * encrypted blob that CSP decrypts at load. Every such file seen ends with a
 * length-prefixed `__AC_SHADERS_PATCH_KN5ENC_v1__` marker.
 *
 * THIS DOES NOT DECRYPT ANYTHING, AND SHOULD NOT.
 *
 * The encryption is there because the author does not want their artwork
 * extracted, and that is their call to make. It also does not need breaking:
 * everything this tool actually wants from a model — the node tree, materials,
 * UV islands, which texture binds to which slot — sits in the readable part.
 * The only casualty is texture DIMENSIONS, and those come from the car's skin
 * folders anyway, which is where the real sizes live even on unencrypted cars.
 *
 * Returns a description of the protected region, or null.
 */
const ENC_MARKER = '__AC_SHADERS_PATCH_KN5ENC_v1__';

export function trailingEncryption(buf, from) {
  if (from >= buf.length) return null;
  // The marker sits near the very end: 30 bytes of text, then a few bytes of
  // trailer. Search a small window rather than the whole file, so a texture that
  // happens to contain the string cannot produce a false positive.
  const window = buf.subarray(Math.max(from, buf.length - 128));
  const at = window.indexOf(ENC_MARKER, 0, 'latin1');
  if (at < 0) return null;
  return {
    scheme: 'csp-kn5enc-v1',
    start: from,
    bytes: buf.length - from,
  };
}

// Row-major, row-vector convention: p' = p * M, translation in elements 12-14.
// Verified against a suspension node whose translation matched its name and
// its position on the car.
const IDENTITY = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);

function multiply(a, b) {
  const out = new Float32Array(16);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[i * 4 + k] * b[k * 4 + j];
      out[i * 4 + j] = s;
    }
  }
  return out;
}

/**
 * Vertex accessor, in WORLD space. Kept lazy so a 50 MB model is never copied
 * into JS objects — a car has a quarter of a million vertices and almost all
 * analysis is a single pass.
 */
export function vertex(model, mesh, i) {
  const o = mesh.vertexStart + i * mesh.stride;
  const b = model.buf;
  const x = b.readFloatLE(o), y = b.readFloatLE(o + 4), z = b.readFloatLE(o + 8);
  const nx = b.readFloatLE(o + 12), ny = b.readFloatLE(o + 16), nz = b.readFloatLE(o + 20);
  const m = mesh.world;
  // Normals get the rotation but not the translation. Non-uniform scale would
  // want the inverse transpose; car node transforms are rigid in practice, and
  // the result is renormalised anyway.
  const rx = nx * m[0] + ny * m[4] + nz * m[8];
  const ry = nx * m[1] + ny * m[5] + nz * m[9];
  const rz = nx * m[2] + ny * m[6] + nz * m[10];
  const rl = Math.hypot(rx, ry, rz) || 1;
  // The TANGENT, which is what turns a normal map into a direction rather
  // than three numbers. It sits behind the UV, so it only exists on a mesh
  // packed wide enough to hold one — a narrower stride answers zero, and the
  // shader reads that as "no tangent frame here" instead of interpreting a
  // neighbouring vertex's position as a direction.
  let tx = 0;
  let ty = 0;
  let tz = 0;
  if (mesh.stride >= 44) {
    const ax = b.readFloatLE(o + 32), ay = b.readFloatLE(o + 36), az = b.readFloatLE(o + 40);
    const wx = ax * m[0] + ay * m[4] + az * m[8];
    const wy = ax * m[1] + ay * m[5] + az * m[9];
    const wz = ax * m[2] + ay * m[6] + az * m[10];
    const wl = Math.hypot(wx, wy, wz);
    if (wl > 1e-6) { tx = wx / wl; ty = wy / wl; tz = wz / wl; }
  }

  return {
    x: x * m[0] + y * m[4] + z * m[8] + m[12],
    y: x * m[1] + y * m[5] + z * m[9] + m[13],
    z: x * m[2] + y * m[6] + z * m[10] + m[14],
    nx: rx / rl, ny: ry / rl, nz: rz / rl,
    tx, ty, tz,
    u: b.readFloatLE(o + 24),
    // AC stores V negative; texture-space y is 1 + v. Get this wrong and every
    // panel is flipped vertically, which looks plausible enough to ship.
    v: 1 + b.readFloatLE(o + 28),
  };
}

/**
 * Axis conventions, established from this car's own mesh names rather than
 * assumed: a node called LEFT_REAR_SHOCK sits at +X and RIGHT_REAR_SHOCK at
 * -X; a node called SUSP_RR translates to negative Z.
 *
 *   +X = car's LEFT      +Y = up      +Z = FORWARD
 *
 * `axisHints` re-derives this per model where the names allow it, so a car that
 * disagrees is detected rather than silently mis-labelled.
 */
/**
 * Which way is left, and which way is forward, from the wheels.
 *
 * Assetto Corsa's physics REQUIRES a car to carry nodes named WHEEL_LF, WHEEL_RF,
 * WHEEL_LR and WHEEL_RR — suspension, tyre and drivetrain all attach to them. It
 * is not a naming convention an author may or may not follow; a car without them
 * does not run. All 235 cars in the fleet have all four, including all 91 whose
 * axes the name heuristic could not determine.
 *
 * So the axes are readable exactly rather than inferred. LF and RF differ only in
 * which side they sit on, and LF and LR only in which end, which makes each axis
 * a subtraction.
 *
 * The heuristic in `axisHints` remains as a cross-check for models that somehow
 * lack the wheels, but this is the measurement.
 */
/**
 * Is this mesh parented under the named node?
 *
 * Matching the node NAME rather than a substring of the whole path, because mesh
 * names are not disciplined: one car has a mesh called `A_Wheel_LF3` sitting
 * under `WHEEL_RF`, and a substring test counted it as part of the left front
 * wheel. That dragged the wheel centre toward the middle of the car and shortened
 * the measured wheelbase by 0.7 m. The SIGN survived it, which is exactly why it
 * would have gone unnoticed without checking the magnitudes against real cars.
 */
function under(mesh, nodeName) {
  const parts = mesh.path.toUpperCase().split('/');
  // Ancestors only — the last segment is the mesh's own name, and it is the one
  // that lies. A mesh that IS the node is still accepted, but only on an exact
  // match rather than on containing the string.
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i].startsWith(nodeName)) return true;
  }
  return parts[parts.length - 1] === nodeName;
}

export function axesFromWheels(model) {
  // Defaulted rather than assumed. This is exported and gets called with hand-
  // built models in tests and in tooling, and a missing collection should mean
  // "no wheels found" — which this function already has an answer for — rather
  // than a TypeError from deep inside it.
  const dummies = model.dummies ?? [];
  const meshes = model.meshes ?? [];

  const at = (which) => {
    const key = `WHEEL_${which}`;
    // The node's own translation IS the wheel centre — that is how AC positions
    // it. Averaging the geometry underneath instead gets close but not exact,
    // because a wheel node also holds motion-blur discs and brake parts that are
    // not centred on the axle. On one car that error was 0.46 m of wheelbase.
    const node = dummies.find((d) => d.name.toUpperCase() === key)
      ?? dummies.find((d) => d.name.toUpperCase().startsWith(key));
    if (node) return { x: node.world[12], y: node.world[13], z: node.world[14] };

    // No such node: fall back to the geometry parented under it.
    let x = 0, y = 0, z = 0, n = 0;
    for (const mesh of meshes) {
      if (!under(mesh, key)) continue;
      const step = Math.max(1, Math.floor(mesh.vertexCount / 200));
      for (let i = 0; i < mesh.vertexCount; i += step) {
        const v = vertex(model, mesh, i);
        x += v.x; y += v.y; z += v.z; n++;
      }
    }
    return n ? { x: x / n, y: y / n, z: z / n } : null;
  };

  const lf = at('LF'), rf = at('RF'), lr = at('LR'), rr = at('RR');
  if (!lf || !rf || !lr || !rr) return null;

  const track = (lf.x + lr.x) / 2 - (rf.x + rr.x) / 2;   // left minus right
  const wheelbase = (lf.z + rf.z) / 2 - (lr.z + rr.z) / 2; // front minus rear

  // Degenerate geometry — every wheel at the origin, or a model where the two
  // axes are indistinguishable — is worse than no answer, because it looks like
  // one. A real car's track and wheelbase are both comfortably over 10 cm.
  if (Math.abs(track) < 0.1 || Math.abs(wheelbase) < 0.1) return null;

  return {
    left: Math.sign(track),
    front: Math.sign(wheelbase),
    confident: true,
    from: 'wheels',
    // Reported so a person can sanity-check the result against a spec sheet.
    trackWidth: Math.abs(track),
    wheelbase: Math.abs(wheelbase),
  };
}

export function axisHints(model) {
  const centroid = (mesh) => {
    let x = 0, z = 0;
    const n = Math.min(mesh.vertexCount, 500);
    const step = Math.max(1, Math.floor(mesh.vertexCount / n));
    let c = 0;
    for (let i = 0; i < mesh.vertexCount; i += step) {
      const v = vertex(model, mesh, i); x += v.x; z += v.z; c++;
    }
    return c ? { x: x / c, z: z / c } : null;
  };
  let leftSign = 0, frontSign = 0;
  for (const mesh of model.meshes) {
    const n = mesh.name.toUpperCase();
    const c = centroid(mesh);
    if (!c) continue;
    if (/\bLEFT|^L[FR]_|_LF\b|_LR\b/.test(n)) leftSign += Math.sign(c.x);
    if (/\bRIGHT|^R[FR]_|_RF\b|_RR\b/.test(n)) leftSign -= Math.sign(c.x);
    if (/NOSE|FRONT|^FW[-_]/.test(n)) frontSign += Math.sign(c.z);
    if (/REAR|^RW[-_]|DIFFUSER/.test(n)) frontSign -= Math.sign(c.z);
  }
  return {
    left: leftSign >= 0 ? 1 : -1,     // sign of X that means the car's left
    front: frontSign >= 0 ? 1 : -1,   // sign of Z that means the car's front
    confident: Math.abs(leftSign) > 2 && Math.abs(frontSign) > 2,
  };
}

export function triangles(model, mesh) {
  const out = [];
  const b = model.buf;
  for (let i = 0; i + 2 < mesh.indexCount; i += 3) {
    const o = mesh.indexStart + i * 2;
    const a = b.readUInt16LE(o), c2 = b.readUInt16LE(o + 2), d = b.readUInt16LE(o + 4);
    if (a < mesh.vertexCount && c2 < mesh.vertexCount && d < mesh.vertexCount) out.push([a, c2, d]);
  }
  return out;
}

/**
 * Shaders that BLEND, by name.
 *
 * The property I need is "does this material composite against what is behind
 * it", and it lives on the material, not on the texture. My first attempt used
 * the profile's `alpha` flag instead — which means "this DDS carries an alpha
 * channel", true of a DXT5 body texture that is entirely opaque. 62 of 75
 * textures on the Honda are flagged, so nearly every panel went transparent and
 * the car stopped being able to hide its own interior.
 *
 * This list is 48 of that car's 151 meshes and the bodywork is not among them.
 *
 * `ksPerPixelAT` and `ksPerPixelAT_NM` are deliberately absent: AT is alpha
 * TEST, a hard cutout that neither blends nor needs sorting, and treating it as
 * blended would put grilles and bolt heads into the sorted pass for nothing.
 */
const BLENDS = new Set([
  'ksPerPixelAlpha',        // number plates, decals, banners
  'ksPerPixelReflection',   // side glass, mirrors
  'ksWindscreen',
  'ksBrokenGlass',
]);

/**
 * Whether a surface ADDS light rather than covering what is behind it.
 *
 * An emissive sheet is a glow map: black where nothing glows. Assetto Corsa
 * draws these additively, so the black contributes nothing and you see the
 * plate underneath. Composited with SRC_ALPHA instead, an opaque black texture
 * is simply a black rectangle — which is what has been standing in front of
 * this car's number plates all along.
 *
 * Detected by NAME, which is weaker than reading a shader and is what the model
 * gives us: both the plate and its twin are ksPerPixelAlpha, and the only thing
 * distinguishing them is that one is called `_Emissive`. Worth saying plainly
 * rather than hiding behind the helper.
 */
export function additive(file) {
  return /emissive/i.test(String(file ?? ''));
}

/** Whether a material composites against what is behind it. */
export function blends(shader) {
  return BLENDS.has(String(shader ?? ''));
}

/**
 * Whether a material is reflective glass, specifically — a narrower question
 * than `blends`: `ksPerPixelAlpha` composites too (a decal, a number plate)
 * but is not glass and should not go mirror-like at a grazing angle.
 */
const GLASS = new Set(['ksPerPixelReflection', 'ksWindscreen', 'ksBrokenGlass']);
export function isGlass(shader) {
  return GLASS.has(String(shader ?? ''));
}

/**
 * Whether a shader is a damage-only overlay, with nothing to show until the
 * car is actually damaged.
 *
 * `ksBrokenGlass` is that shader by convention: a `DAMAGE_GLASS_*` mesh
 * sits exactly over the real glass it belongs to and is how CSP's damage
 * system draws a crack once a panel is hit — a grid of pre-cut fragment
 * quads, invisible at zero damage.
 *
 * This project has no notion of damage — a livery is not a crash — so there
 * is no value to condition on, and the only correct default is "not shown".
 * Grouping it with real glass and giving it the same fresnel alpha drew that
 * fragment grid on every showroom-fresh car: a faint rectangular lattice
 * across the windscreen that looked like a rendering bug and was actually
 * this mesh, finally visible now that blended surfaces are not forced
 * opaque. It is excluded from `drawn` entirely rather than just kept out of
 * `isGlass`, because there is no textured or bare-grey rendering of a crack
 * decal that would be correct either.
 */
export function damageOnly(shader) {
  return String(shader ?? '') === 'ksBrokenGlass';
}

/**
 * Whether a mesh is a motion-blur alternate — the wheel as it looks spinning,
 * with nothing to show while the car is standing still.
 *
 * Every corner of this car ships THREE rims: `EXT_RIM_LF` is the real one,
 * `EXT_RIM_BLUR_LF` is a 288-triangle disc wearing a radial streak texture,
 * and `EXT_RIM_BLUR_STATIC_LF` is the low-poly rim that sits behind that disc
 * while it spins. The game swaps between them by wheel speed. Drawing all
 * three at once — which is what this did — puts the streak disc over the
 * wheel as a turbine-looking fan, and lands the static rim exactly on top of
 * the real one, where the two z-fight and speckle the design's own rim paint.
 *
 * A livery preview is a car at rest, which is the one state where the answer
 * is unambiguous: the sharp rim, and neither alternate. Same reasoning as
 * `damageOnly` above — a condition this project has no value for, and only
 * one correct default.
 *
 * By NAME, because that is where the distinction lives: the static blur rim
 * shares both its material and its texture with the real rim, so nothing in
 * the material can tell them apart. AC's own convention is what makes the
 * name reliable, and it is the same convention `additive` and
 * `trustworthyDiffuse` already lean on.
 */
export function motionBlurOnly(name) {
  return /(^|_)blur(_|$)/i.test(String(name ?? ''));
}

/**
 * Whether this shader's diffuse texture is a plausible standalone image —
 * safe to show a part wearing, when the design does not paint it.
 *
 * Most shaders sample txDiffuse directly, so what the kn5 stores IS the
 * surface. The MultiMap family is not: Kunos packs several material
 * variants into one sheet — the NSX GT3's cockpit trim is four unrelated
 * teams' switch panels and decals in one atlas — and blends between them at
 * runtime with a mask this project does not read. Sampling it raw shows a
 * fragment of every variant stitched together, which reads as a broken
 * texture rather than as an honestly-unpainted part. `car-hides`-style
 * honesty says grey instead.
 *
 * Detected by NAME, the same way `additive` is: `ksPerPixelMultiMap_damage_dirt`
 * is also a body panel's shader (see docs/naming.md), so this only ever
 * gates whether the CAR'S OWN stock texture is trusted for an unpainted
 * part — a livery's own rendered artwork always overrides it regardless of
 * the shader underneath.
 */
export function trustworthyDiffuse(shader) {
  return !/multimap/i.test(String(shader ?? ''));
}

/**
 * The tiling second texture a MultiMap material multiplies over its diffuse,
 * when it has one.
 *
 * `trustworthyDiffuse` is right that these materials' diffuse is not the
 * surface. It does not follow that the surface is unknowable — the NMDetail
 * family is simply TWO layers, and the kn5 carries both. The NSX GT3's door
 * cards and rollcage trim are `INT_HR_Occlusion.dds`, an ambient-occlusion
 * bake with no colour in it whatsoever, multiplied by `MAT_Carbon.dds`, which
 * is where the weave and the colour actually live; the instrument surround is
 * the same bake against `metal_detail_2.dds`. Given both, a viewer can show
 * what the game shows. Given only the bake it cannot, so this answers `null`
 * and the caller keeps its honest grey rather than rendering a part as a
 * greyscale photograph of its own shadows.
 *
 * Gated on the material's own `useDetail`, not on the presence of a filename.
 * `NULL.dds` is Kunos's written-out empty slot and a real entry in the
 * archive, so a filename test alone finds a texture, fetches it, and
 * multiplies a switch panel by whatever that placeholder happens to hold —
 * `INT_ELECTRONICS` is exactly that shape, and it is `useDetail: 0` that
 * says so plainly.
 *
 * The multiplier comes back as recorded and is NOT defaulted to something
 * plausible: it is 500 on this car's carbon and 100 on its instrument
 * surround, so a made-up 1 would draw a weave with a 20cm pitch and call it
 * carbon. A material claiming detail without a usable multiplier is a
 * material this cannot honestly draw, and answers `null` with the rest.
 */
export function detailLayer(material) {
  if (trustworthyDiffuse(material?.shader)) return null;
  if (!material?.props?.useDetail) return null;

  const named = (f) => (typeof f === 'string' && f && f.toLowerCase() !== 'null.dds' ? f : null);
  const diffuse = named(material?.slots?.txDiffuse);
  const detail = named(material?.slots?.txDetail);
  if (!diffuse || !detail) return null;

  const mult = Number(material.props.detailUVMultiplier);
  if (!Number.isFinite(mult) || mult <= 0) return null;

  // And the detail's NORMAL map, tiled the same way, which is the half that
  // makes a material read as itself. Alcantara's colour is a flat dark grey
  // whichever way you light it; what says "suede" is the nap catching light
  // at a thousand angles, and that lives entirely in alcnt_nm.dds. Without it
  // a matte fabric renders as one broad sheen on a perfectly smooth surface,
  // which is exactly the plastic look it is supposed to avoid.
  //
  // Optional, because the colour detail is useful on its own and a material
  // may state one without the other. `detailNormalBlend` is how hard the
  // material wants it — 0.3 for this car's alcantara and carbon, 1.5 for its
  // brushed metal — and a material that gives no usable strength gets 1
  // rather than being dropped, since the map itself is the unambiguous part.
  const normal = named(material?.slots?.txNormalDetail);
  const blend = Number(material.props.detailNormalBlend);
  return {
    diffuse,
    detail,
    mult,
    normal,
    // Clamped, because the stated value is not always a considered one: this
    // car's radiator says 1000, which would swing the sampled normal past
    // sideways and light an eight-triangle part as if it faced anywhere but
    // out. The real values sit between 0.2 and 1.5, so 4 is well clear of
    // anything deliberate while still catching a typo.
    normalBlend: Number.isFinite(blend) && blend > 0 ? Math.min(4, blend) : 1,
  };
}

/** Meshes whose material's txDiffuse is `textureName`. */
export function meshesUsingTexture(model, textureName) {
  const want = textureName.toLowerCase();
  return model.meshes.filter((m) => {
    const mat = model.materials[m.materialId];
    return mat && (mat.slots.txDiffuse ?? '').toLowerCase() === want;
  });
}
