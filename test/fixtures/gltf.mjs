// ---------------------------------------------------------------------------
// Synthetic glTF models, built here for the reason the kn5 fixtures are: a
// test that opened a real model would pass only where that model is.
//
// `glbFrom` writes a model that has already been read — the synthetic kn5
// car — out again as a .glb, so the two formats can be held to describe the
// same car vertex for vertex rather than two cars someone believed alike.
// ---------------------------------------------------------------------------

/** A .glb from its JSON and its binary chunk, each padded to four bytes. */
export function writeGlb(json, bin = Buffer.alloc(0)) {
  const pad = (b, fill) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4, fill)]);
  const j = pad(Buffer.from(JSON.stringify(json)), 0x20);
  const b = pad(bin, 0);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + j.length + (b.length ? 8 + b.length : 0), 8);
  const chunk = (data, type) => { const h = Buffer.alloc(8); h.writeUInt32LE(data.length, 0); h.writeUInt32LE(type, 4); return Buffer.concat([h, data]); };
  return Buffer.concat([header, chunk(j, 0x4e4f534a), ...(b.length ? [chunk(b, 0x004e4942)] : [])]);
}

/**
 * Accessors appended to one binary chunk: `add(array, type)` returns the
 * accessor's index, `finish()` the JSON fields and the chunk.
 */
export function packer() {
  const parts = []; const views = []; const accessors = []; let offset = 0;
  const add = (array, type, { componentType = array instanceof Uint32Array ? 5125 : 5126, normalized } = {}) => {
    const bytes = Buffer.from(array.buffer, array.byteOffset, array.byteLength);
    views.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length });
    parts.push(bytes, Buffer.alloc((4 - (bytes.length % 4)) % 4));
    offset += bytes.length + ((4 - (bytes.length % 4)) % 4);
    const width = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[type];
    accessors.push({ bufferView: views.length - 1, componentType, count: array.length / width, type, ...(normalized ? { normalized } : {}) });
    return accessors.length - 1;
  };
  /** Raw bytes, such as an image, as a buffer view of their own. */
  const addBytes = (bytes) => {
    views.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length });
    parts.push(bytes, Buffer.alloc((4 - (bytes.length % 4)) % 4));
    offset += bytes.length + ((4 - (bytes.length % 4)) % 4);
    return views.length - 1;
  };
  const finish = () => {
    const bin = Buffer.concat(parts);
    return { fields: { buffers: [{ byteLength: bin.length }], bufferViews: views, accessors }, bin };
  };
  return { add, addBytes, finish };
}

/**
 * A model already read, written out as a .glb: every mesh in world space
 * under a node of its own, every node at its world transform, and each
 * material's paint as an image named as the model names it. UVs are written
 * as the model stored them, before any island was brought onto the sheet,
 * so the glTF's reader has to bring them there itself.
 */
export function glbFrom(model, { vertex, triangles }) {
  const pack = packer();
  const images = [...new Set(model.materials.map((m) => m.slots?.txDiffuse).filter(Boolean))];
  const meshes = model.meshes.map((mesh) => {
    const pos = [], nrm = [], uv = [];
    for (let i = 0; i < mesh.vertexCount; i++) {
      const v = vertex(model, mesh, i);
      const s = mesh.uvShift;
      pos.push(v.x, v.y, v.z); nrm.push(v.nx, v.ny, v.nz); uv.push(v.u - (s?.[2 * i] ?? 0), v.v - (s?.[2 * i + 1] ?? 0));
    }
    return {
      name: mesh.name,
      primitives: [{
        attributes: {
          POSITION: pack.add(new Float32Array(pos), 'VEC3'),
          NORMAL: pack.add(new Float32Array(nrm), 'VEC3'),
          TEXCOORD_0: pack.add(new Float32Array(uv), 'VEC2'),
        },
        indices: pack.add(new Uint32Array(triangles(model, mesh).flat()), 'SCALAR'),
        material: mesh.materialId,
      }],
    };
  });
  const { fields, bin } = pack.finish();
  return writeGlb({
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [...meshes.keys(), ...model.dummies.map((_, i) => meshes.length + i)] }],
    nodes: [
      ...meshes.map((m, i) => ({ name: m.name, mesh: i })),
      ...model.dummies.map((d) => ({ name: d.name, matrix: [...d.world] })),
    ],
    meshes,
    materials: model.materials.map((m) => ({
      name: m.name,
      ...(m.alphaBlendMode === 1 ? { alphaMode: 'BLEND' } : {}),
      ...(m.slots?.txDiffuse ? { pbrMetallicRoughness: { baseColorTexture: { index: images.indexOf(m.slots.txDiffuse) } } } : {}),
    })),
    textures: images.map((_, i) => ({ source: i })),
    images: images.map((uri) => ({ uri })),
    ...fields,
  }, bin);
}

/**
 * Something that is not a car: a pot whose body is unwrapped as one strip,
 * its two ends meeting round the back, and whose lid is a disc laid out on
 * its own, sharing the body's top rim. No wheels, nothing named for a side,
 * and its paint a 64x64 PNG inside the file.
 */
export const TEAPOT = { radius: 0.5, height: 0.6, segments: 24, image: 'teapot.png', size: 64 };

export async function teapotGlb({ baseColorFactor } = {}) {
  const { radius: R, height: H, segments: N } = TEAPOT;
  const sharp = (await import('sharp')).default;
  const png = await sharp({ create: { width: TEAPOT.size, height: TEAPOT.size, channels: 4, background: '#888' } }).png().toBuffer();
  const pack = packer();
  const mesh = (name, verts, indices) => ({
    name,
    primitives: [{
      attributes: {
        POSITION: pack.add(new Float32Array(verts.flatMap((v) => v.p)), 'VEC3'),
        NORMAL: pack.add(new Float32Array(verts.flatMap((v) => v.n)), 'VEC3'),
        TEXCOORD_0: pack.add(new Float32Array(verts.flatMap((v) => v.uv)), 'VEC2'),
      },
      indices: pack.add(new Uint32Array(indices), 'SCALAR'),
      material: 0,
    }],
  });
  // The body: a strip round the pot, in four bands up its side.
  const body = [], bodyIdx = [], BANDS = 4;
  for (let r = 0; r <= BANDS; r++) {
    for (let j = 0; j <= N; j++) {
      const a = (2 * Math.PI * j) / N;
      body.push({ p: [R * Math.cos(a), (H * r) / BANDS, R * Math.sin(a)], n: [Math.cos(a), 0, Math.sin(a)],
        uv: [0.05 + (0.9 * j) / N, 0.55 - (0.5 * r) / BANDS] });
    }
  }
  for (let r = 0; r < BANDS; r++) {
    for (let j = 0; j < N; j++) {
      const a = r * (N + 1) + j, b = a + N + 1;
      bodyIdx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  // The lid: a disc in three rings, its outer ring on the body's top rim.
  const lid = [{ p: [0, H, 0], n: [0, 1, 0], uv: [0.5, 0.78] }], lidIdx = [], RINGS = 3;
  for (let k = 1; k <= RINGS; k++) {
    for (let j = 0; j <= N; j++) {
      const a = (2 * Math.PI * j) / N, f = k / RINGS;
      lid.push({ p: [R * f * Math.cos(a), H, R * f * Math.sin(a)], n: [0, 1, 0],
        uv: [0.5 + 0.18 * f * Math.cos(a), 0.78 + 0.18 * f * Math.sin(a)] });
    }
  }
  for (let j = 0; j < N; j++) lidIdx.push(0, 2 + j, 1 + j);
  for (let k = 1; k < RINGS; k++) {
    for (let j = 0; j < N; j++) {
      const a = 1 + (k - 1) * (N + 1) + j, b = a + N + 1;
      lidIdx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const meshes = [mesh('pot', body, bodyIdx), mesh('lid', lid, lidIdx)];
  const image = pack.addBytes(png);
  const { fields, bin } = pack.finish();
  return writeGlb({
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0, 1] }],
    nodes: [{ name: 'pot', mesh: 0 }, { name: 'lid', mesh: 1 }],
    meshes,
    materials: [{ name: 'glaze', pbrMetallicRoughness: { baseColorTexture: { index: 0 }, ...(baseColorFactor ? { baseColorFactor } : {}) } }],
    textures: [{ source: 0 }],
    images: [{ name: TEAPOT.image, mimeType: 'image/png', bufferView: image }],
    ...fields,
  }, bin);
}
