/**
 * Binary glTF (.glb), the format every modelling tool exports.
 *
 * A glTF says less about its surfaces than a kn5's shaders do, and what it
 * does not say is answered as the safe default rather than guessed: nothing
 * is glass, a damage overlay, a motion-blur stand-in or a second cockpit,
 * and the base color is the surface. What it does state — that a material
 * blends or cuts out, which image is its color and which its relief — is
 * read as stated.
 *
 * Read: triangle lists, float or normalized-integer attributes, embedded or
 * external images, and node transforms by matrix or by translation,
 * rotation and scale. Anything else is refused by name, because a model read
 * past a part this does not understand is a profile of the wrong surface.
 */
import { readFile } from 'node:fs/promises';
import { axesFromWheels as kn5Wheels } from './kn5.mjs';

export const name = 'glTF';

const GLTF = 0x46546c67;   // 'glTF'
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const COMPONENT = {
  5120: [1, 'getInt8', 127], 5121: [1, 'getUint8', 255], 5122: [2, 'getInt16', 32767],
  5123: [2, 'getUint16', 65535], 5125: [4, 'getUint32', 1], 5126: [4, 'getFloat32', 1],
};
const WIDTH = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

export const loadModel = async (path, opts = {}) => parseGlb(await readFile(path), { ...opts, path: String(path) });

export function parseGlb(buf, { keepTextureData = false, path = 'model' } = {}) {
  if (buf.length < 12 || buf.readUInt32LE(0) !== GLTF) throw new Error(`${path} is not a binary glTF (.glb)`);
  if (buf.readUInt32LE(4) !== 2) throw new Error(`${path} is glTF ${buf.readUInt32LE(4)}; only glTF 2 is read`);
  let json = null, bin = null;
  for (let o = 12; o + 8 <= buf.length;) {
    const length = buf.readUInt32LE(o), type = buf.readUInt32LE(o + 4);
    const data = buf.subarray(o + 8, o + 8 + length);
    if (type === JSON_CHUNK) json = JSON.parse(data.toString('utf8'));
    else if (type === BIN_CHUNK) bin = data;
    o += 8 + length;
  }
  if (!json) throw new Error(`${path} has no JSON chunk`);
  if (json.extensionsRequired?.length) {
    throw new Error(`${path} needs ${json.extensionsRequired.join(', ')}, which this does not read; export it without them`);
  }
  const view = bin ? new DataView(bin.buffer, bin.byteOffset, bin.byteLength) : null;

  const accessor = (i, what) => {
    const a = json.accessors?.[i];
    if (!a) throw new Error(`${path}: ${what} names accessor ${i}, which is not there`);
    if (a.sparse) throw new Error(`${path}: ${what} is a sparse accessor, which this does not read`);
    const bv = json.bufferViews?.[a.bufferView];
    if (!bv || bv.buffer !== 0 || !view) throw new Error(`${path}: ${what} is not in the file's own binary chunk`);
    const [size, get, max] = COMPONENT[a.componentType] ?? [];
    const width = WIDTH[a.type];
    if (!size || !width) throw new Error(`${path}: ${what} is ${a.type} of component ${a.componentType}, which this does not read`);
    const stride = bv.byteStride ?? size * width;
    const start = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const scale = a.normalized ? max : 1;
    return { count: a.count, width, at: (k, c) => view[get](start + k * stride + c * size, true) / scale };
  };

  const imageName = (texture) => {
    const t = texture === undefined ? null : json.textures?.[texture.index];
    const img = t?.source === undefined ? null : json.images?.[t.source];
    if (!img) return null;
    if (img.uri && !img.uri.startsWith('data:')) return decodeURIComponent(img.uri.split(/[\\/]/).pop());
    const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' }[img.mimeType] ?? '';
    return `${img.name ?? `image${t.source}`}${img.name && /\.\w+$/.test(img.name) ? '' : ext}`;
  };

  const materials = (json.materials ?? []).map((m, i) => ({
    name: m.name ?? `material${i}`,
    alphaMode: m.alphaMode ?? 'OPAQUE',
    alphaCutoff: m.alphaCutoff ?? 0.5,
    diffuse: imageName(m.pbrMetallicRoughness?.baseColorTexture),
    normal: imageName(m.normalTexture),
  }));

  const textures = (json.images ?? []).map((img, i) => {
    const name = imageName({ index: (json.textures ?? []).findIndex((t) => t.source === i) }) ?? img.name ?? `image${i}`;
    const bv = img.bufferView === undefined ? null : json.bufferViews[img.bufferView];
    const data = bv && bin ? bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength)
      : img.uri?.startsWith('data:') ? Buffer.from(img.uri.slice(img.uri.indexOf(',') + 1), 'base64') : null;
    return { name, size: data?.length ?? 0, data: keepTextureData ? data : null };
  });

  // World transforms, in the layout a kn5 stores them: a column-major glTF
  // matrix is the same sixteen numbers as a row-major one for row vectors,
  // with the translation at 12 to 14.
  const meshes = [];
  const dummies = [];
  const visit = (index, parent, parentPath, depth) => {
    const node = json.nodes[index];
    const world = multiply(parent, localMatrix(node));
    const name = node.name ?? `node${index}`;
    const nodePath = parentPath ? `${parentPath}/${name}` : name;
    dummies.push({ name, path: nodePath, depth, world });
    const mesh = node.mesh === undefined ? null : json.meshes[node.mesh];
    (mesh?.primitives ?? []).forEach((p, k) => {
      const what = `mesh "${mesh.name ?? node.mesh}" primitive ${k}`;
      if ((p.mode ?? 4) !== 4) throw new Error(`${path}: ${what} is not a list of triangles (mode ${p.mode}), which this does not read`);
      const position = accessor(p.attributes.POSITION, `${what}'s POSITION`);
      const at = (attr) => (p.attributes[attr] === undefined ? null : accessor(p.attributes[attr], `${what}'s ${attr}`));
      const indices = p.indices === undefined ? null : accessor(p.indices, `${what}'s indices`);
      meshes.push({
        name: mesh.primitives.length > 1 ? `${mesh.name ?? name}#${k}` : (mesh.name ?? name),
        path: nodePath, depth: depth + 1, materialId: p.material ?? -1, world,
        vertexCount: position.count, indexCount: indices?.count ?? position.count,
        attributes: { position, normal: at('NORMAL'), tangent: at('TANGENT'), uv: at('TEXCOORD_0'), indices },
      });
    });
    for (const child of node.children ?? []) visit(child, world, nodePath, depth + 1);
  };
  const scene = json.scenes?.[json.scene ?? 0];
  const roots = scene?.nodes ?? (json.nodes ?? []).map((_, i) => i);
  for (const r of roots) visit(r, IDENTITY, '', 0);

  return { format: FORMAT, path, meshes, materials, textures, dummies, encrypted: null };
}

export function vertex(model, mesh, i) {
  const { position: p, normal: n, tangent: t, uv } = mesh.attributes;
  const m = mesh.world;
  const x = p.at(i, 0), y = p.at(i, 1), z = p.at(i, 2);
  const turn = (a) => (a ? [a.at(i, 0), a.at(i, 1), a.at(i, 2)] : [0, 0, 0]);
  // Directions take the rotation and not the translation, as a kn5's do.
  const dir = ([dx, dy, dz]) => [dx * m[0] + dy * m[4] + dz * m[8], dx * m[1] + dy * m[5] + dz * m[9], dx * m[2] + dy * m[6] + dz * m[10]];
  const [nx, ny, nz] = dir(turn(n));
  const [tx, ty, tz] = dir(turn(t));
  return {
    x: x * m[0] + y * m[4] + z * m[8] + m[12],
    y: x * m[1] + y * m[5] + z * m[9] + m[13],
    z: x * m[2] + y * m[6] + z * m[10] + m[14],
    nx, ny, nz, tx, ty, tz,
    // glTF's texture origin is the image's top left, which is texture space here.
    u: uv ? uv.at(i, 0) : 0,
    v: uv ? uv.at(i, 1) : 0,
  };
}

export function triangles(model, mesh) {
  const { indices } = mesh.attributes;
  const out = [];
  for (let k = 0; k + 2 < mesh.indexCount; k += 3) {
    const [a, b, c] = indices ? [indices.at(k, 0), indices.at(k + 1, 0), indices.at(k + 2, 0)] : [k, k + 1, k + 2];
    if (a < mesh.vertexCount && b < mesh.vertexCount && c < mesh.vertexCount) out.push([a, b, c]);
  }
  return out;
}

/**
 * From nodes named WHEEL_LF and the rest, as a kn5's. Only the nodes are
 * handed over: where there are none, ac-kn5 would look at the geometry under
 * them through a kn5's own vertex layout, which this is not.
 */
export const axesFromWheels = (model) => kn5Wheels({ dummies: model.dummies });

/** A glTF's names follow no convention to read a facing from. */
export const axisHints = () => ({ left: 1, front: 1, confident: false });

export const meshesWearing = (model, file) => {
  const want = String(file).toLowerCase();
  return model.meshes.filter((m) => model.materials[m.materialId]?.diffuse?.toLowerCase() === want);
};

export function materialTraits(model, materialId) {
  const mat = model.materials?.[materialId];
  return {
    glass: false,
    blends: mat?.alphaMode === 'BLEND',
    alphaTest: mat?.alphaMode === 'MASK' ? mat.alphaCutoff : null,
    discardsClear: mat?.alphaMode === 'MASK',
    damage: false,
    diffuse: mat?.diffuse ?? null,
    trustworthy: true,
    detail: null,
    normalMap: mat?.normal ?? null,
  };
}

export const placeTraits = () => ({ blur: false, lod: null });

/** What a model read here carries, so the model module asks this file about it. */
const FORMAT = { name, vertex, triangles, axesFromWheels, axisHints, meshesWearing, materialTraits, placeTraits };

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** A node's own transform, column-major, from its matrix or its TRS. */
function localMatrix(node) {
  if (node.matrix) return new Float32Array(node.matrix);
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [qx, qy, qz, qw] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  return new Float32Array([
    (1 - 2 * (qy * qy + qz * qz)) * sx, 2 * (qx * qy + qz * qw) * sx, 2 * (qx * qz - qy * qw) * sx, 0,
    2 * (qx * qy - qz * qw) * sy, (1 - 2 * (qx * qx + qz * qz)) * sy, 2 * (qy * qz + qx * qw) * sy, 0,
    2 * (qx * qz + qy * qw) * sz, 2 * (qy * qz - qx * qw) * sz, (1 - 2 * (qx * qx + qy * qy)) * sz, 0,
    tx, ty, tz, 1,
  ]);
}

/** a × b, both column-major: b applied first. */
function multiply(a, b) {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}
