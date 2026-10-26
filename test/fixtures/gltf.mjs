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
  const finish = () => {
    const bin = Buffer.concat(parts);
    return { fields: { buffers: [{ byteLength: bin.length }], bufferViews: views, accessors }, bin };
  };
  return { add, finish };
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
