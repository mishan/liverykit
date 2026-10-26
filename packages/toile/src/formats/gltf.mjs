/**
 * Binary glTF (.glb), the format every modelling tool exports.
 *
 * A glTF says less about its surfaces than a kn5's shaders do, and what it
 * does not say is answered as the safe default rather than guessed: nothing
 * is glass, a damage overlay, a motion-blur stand-in or a second cockpit.
 * What it does state — that a material blends or cuts out, which image is
 * its color and which its relief, whether a factor tints that color — is
 * read as stated.
 *
 * Read: triangle lists, float or normalized-integer attributes, embedded
 * images and external ones beside the file, and node transforms by matrix or
 * by translation, rotation and scale. Anything else is refused by name,
 * because a model read past a part this does not understand is a profile of
 * the wrong surface.
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { axesFromWheels as kn5Wheels } from './kn5.mjs';
import { placeOnSheet } from './sheet.mjs';

export const name = 'glTF';

const GLTF = 0x46546c67;   // 'glTF'
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const COMPONENT = {
  5120: [1, 'getInt8', 127], 5121: [1, 'getUint8', 255], 5122: [2, 'getInt16', 32767],
  5123: [2, 'getUint16', 65535], 5125: [4, 'getUint32', 1], 5126: [4, 'getFloat32', 1],
};
const WIDTH = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

export async function loadModel(path, opts = {}) {
  const model = parseGlb(await readFile(path), { ...opts, path: String(path) });
  // An image beside the file is part of the model as much as one inside it,
  // and one anywhere else is not read: a model is somebody else's file, and
  // its URIs can point anywhere this process can read.
  const folder = resolve(dirname(String(path)));
  for (const t of model.textures) {
    if (!t.uri) continue;
    const at = resolve(folder, t.uri);
    if (!at.startsWith(folder + sep)) { t.size = 0; t.outside = true; continue; }
    const data = await readFile(at).catch(() => null);
    t.size = data?.length ?? 0;
    t.missing = !data;
    if (opts.keepTextureData) t.data = data;
  }
  return model;
}

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
  const named = (list, i, what) => {
    const x = json[list]?.[i];
    if (x === undefined) throw new Error(`${path}: ${what} names ${list} ${i}, which is not there`);
    return x;
  };

  const accessor = (i, what) => {
    const a = named('accessors', i, what);
    if (a.sparse) throw new Error(`${path}: ${what} is a sparse accessor, which this does not read`);
    const bv = json.bufferViews?.[a.bufferView];
    if (!bv || bv.buffer !== 0 || !view) throw new Error(`${path}: ${what} is not in the file's own binary chunk`);
    const [size, get, max] = COMPONENT[a.componentType] ?? [];
    const width = WIDTH[a.type];
    if (!size || !width) throw new Error(`${path}: ${what} is ${a.type} of component ${a.componentType}, which this does not read`);
    const stride = bv.byteStride ?? size * width;
    const start = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const scale = a.normalized ? max : 1;
    return { count: a.count, at: (k, c) => view[get](start + k * stride + c * size, true) / scale };
  };

  const imageOf = (texture, what) => {
    if (texture === undefined) return null;
    const t = named('textures', texture.index, what);
    return t.source === undefined ? null : named('images', t.source, `texture ${texture.index}`);
  };
  const nameOfImage = (img, i) => {
    // Decoded before it is cut, so an encoded slash is still a slash.
    if (img.uri && !img.uri.startsWith('data:')) return decodeURIComponent(img.uri).split(/[\\/]/).pop();
    const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' }[img.mimeType] ?? '';
    // A name and no more: one carrying a path would be written where it points.
    const own = img.name?.split(/[\\/]/).pop() || null;
    return own && /\.\w+$/.test(own) ? own : `${own ?? `image${i}`}${ext}`;
  };
  const images = (json.images ?? []).map((img, i) => nameOfImage(img, i));
  const imageName = (texture, what) => {
    const img = imageOf(texture, what);
    return img ? images[json.images.indexOf(img)] : null;
  };

  const materials = (json.materials ?? []).map((m, i) => {
    const pbr = m.pbrMetallicRoughness ?? {};
    const what = `material "${m.name ?? i}"`;
    return {
      name: m.name ?? `material${i}`,
      alphaMode: m.alphaMode ?? 'OPAQUE',
      alphaCutoff: m.alphaCutoff ?? 0.5,
      diffuse: imageName(pbr.baseColorTexture, `${what}'s base color`),
      // The image is the surface's color only where nothing multiplies it.
      tinted: Boolean(pbr.baseColorFactor?.slice(0, 3).some((c) => c !== 1)),
      normal: imageName(m.normalTexture, `${what}'s normal map`),
      // Every image the material uses, by what it uses it for.
      slots: Object.fromEntries([
        ['baseColor', pbr.baseColorTexture], ['metallicRoughness', pbr.metallicRoughnessTexture],
        ['normal', m.normalTexture], ['occlusion', m.occlusionTexture], ['emissive', m.emissiveTexture],
      ].filter(([, t]) => t).map(([slot, t]) => [slot, imageName(t, `${what}'s ${slot}`)]).filter(([, n]) => n)),
    };
  });

  const textures = (json.images ?? []).map((img, i) => {
    const bv = img.bufferView === undefined ? null : named('bufferViews', img.bufferView, `image ${i}`);
    const data = bv && bin ? bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength)
      : img.uri?.startsWith('data:') ? Buffer.from(img.uri.slice(img.uri.indexOf(',') + 1), 'base64') : null;
    const uri = img.uri && !img.uri.startsWith('data:') ? decodeURIComponent(img.uri) : null;
    return { name: images[i], size: data?.length ?? 0, data: keepTextureData ? data : null, ...(uri ? { uri } : {}) };
  });

  // World transforms, in the layout a kn5 stores them: a column-major glTF
  // matrix is the same sixteen numbers as a row-major one for row vectors,
  // with the translation at 12 to 14.
  const meshes = [];
  const dummies = [];
  const visit = (index, parent, parentPath, depth) => {
    const node = named('nodes', index, parentPath ? `node "${parentPath}"` : 'the scene');
    const world = multiply(parent, localMatrix(node));
    const nodeName = node.name ?? `node${index}`;
    const nodePath = parentPath ? `${parentPath}/${nodeName}` : nodeName;
    dummies.push({ name: nodeName, path: nodePath, depth, world });
    const mesh = node.mesh === undefined ? null : named('meshes', node.mesh, `node "${nodePath}"`);
    (mesh?.primitives ?? []).forEach((p, k) => {
      const what = `mesh "${mesh.name ?? node.mesh}" primitive ${k}`;
      if ((p.mode ?? 4) !== 4) throw new Error(`${path}: ${what} is not a list of triangles (mode ${p.mode}), which this does not read`);
      if (p.material !== undefined) named('materials', p.material, what);
      const position = accessor(p.attributes.POSITION, `${what}'s POSITION`);
      const at = (attr) => (p.attributes[attr] === undefined ? null : accessor(p.attributes[attr], `${what}'s ${attr}`));
      const indices = p.indices === undefined ? null : accessor(p.indices, `${what}'s indices`);
      const m = {
        name: mesh.primitives.length > 1 ? `${mesh.name ?? nodeName}#${k}` : (mesh.name ?? nodeName),
        path: nodePath, depth: depth + 1, materialId: p.material ?? -1, world,
        vertexCount: position.count, indexCount: indices?.count ?? position.count,
        attributes: { position, normal: at('NORMAL'), tangent: at('TANGENT'), uv: at('TEXCOORD_0'), indices },
        normalMatrix: normalMatrix(world),
      };
      const uv = m.attributes.uv;
      if (uv) {
        const { uvShift, straddlers } = placeOnSheet(m.vertexCount, triangles(null, m), (i) => [uv.at(i, 0), uv.at(i, 1)]);
        if (uvShift) m.uvShift = uvShift;
        if (straddlers.length) m.straddlers = straddlers;
      }
      meshes.push(m);
    });
    for (const child of node.children ?? []) visit(child, world, nodePath, depth + 1);
  };
  // The scene's roots; without a scene, every node that is nobody's child,
  // since a child visited as a root as well would be its geometry twice.
  const children = new Set((json.nodes ?? []).flatMap((n) => n.children ?? []));
  const scene = json.scenes?.[json.scene ?? 0];
  const roots = scene?.nodes ?? (json.nodes ?? []).map((_, i) => i).filter((i) => !children.has(i));
  for (const r of roots) visit(r, IDENTITY, '', 0);

  return { format: FORMAT, path, meshes, materials, textures, dummies, encrypted: null };
}

export function vertex(model, mesh, i) {
  const { position: p, uv } = mesh.attributes;
  const m = mesh.world;
  const x = p.at(i, 0), y = p.at(i, 1), z = p.at(i, 2);
  // A normal by the inverse transpose, which a scale that is not uniform
  // needs, and to unit length, as a kn5's; a primitive that states none gets
  // its faces' normals, averaged at each vertex.
  const n = mesh.attributes.normal ?? faceNormals(mesh);
  const k = mesh.normalMatrix;
  const lx = n.at(i, 0), ly = n.at(i, 1), lz = n.at(i, 2);
  let nx = lx * k[0] + ly * k[3] + lz * k[6], ny = lx * k[1] + ly * k[4] + lz * k[7], nz = lx * k[2] + ly * k[5] + lz * k[8];
  const nl = Math.hypot(nx, ny, nz) || 1;
  nx /= nl; ny /= nl; nz /= nl;
  // A tangent lies in the surface, so it turns with the surface; zero where
  // there is none, as a kn5's.
  let tx = 0, ty = 0, tz = 0;
  const t = mesh.attributes.tangent;
  if (t) {
    const ax = t.at(i, 0), ay = t.at(i, 1), az = t.at(i, 2);
    const wx = ax * m[0] + ay * m[4] + az * m[8], wy = ax * m[1] + ay * m[5] + az * m[9], wz = ax * m[2] + ay * m[6] + az * m[10];
    const wl = Math.hypot(wx, wy, wz);
    if (wl > 1e-6) { tx = wx / wl; ty = wy / wl; tz = wz / wl; }
  }
  const s = mesh.uvShift;
  return {
    x: x * m[0] + y * m[4] + z * m[8] + m[12],
    y: x * m[1] + y * m[5] + z * m[9] + m[13],
    z: x * m[2] + y * m[6] + z * m[10] + m[14],
    nx, ny, nz, tx, ty, tz,
    // glTF's texture origin is the image's top left, which is texture space
    // here; an island stored on another copy of the sheet is brought onto it.
    u: uv ? uv.at(i, 0) + (s ? s[2 * i] : 0) : 0,
    v: uv ? uv.at(i, 1) + (s ? s[2 * i + 1] : 0) : 0,
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
  const blends = mat?.alphaMode === 'BLEND';
  const alphaTest = mat?.alphaMode === 'MASK' ? mat.alphaCutoff : null;
  return {
    glass: false,
    blends,
    alphaTest,
    // As ac-kn5 says it of a kn5: a clear texel shows nothing where the
    // material blends or cuts out.
    discardsClear: blends || alphaTest !== null,
    damage: false,
    diffuse: mat?.diffuse ?? null,
    trustworthy: !mat?.tinted,
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

/** The inverse transpose of a world matrix's 3x3, column-major, up to scale. */
function normalMatrix(m) {
  const [a, b, c, d, e, f, g, h, i] = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
  // The cofactor matrix is the inverse transpose times the determinant; the
  // determinant's size does not matter once a normal is made unit length,
  // and its sign keeps a mirrored node's normals facing out.
  const det = a * (e * i - f * h) - d * (b * i - c * h) + g * (b * f - c * e);
  const s = Math.sign(det) || 1;
  return [
    s * (e * i - f * h), s * (g * f - d * i), s * (d * h - g * e),
    s * (h * c - b * i), s * (a * i - g * c), s * (g * b - a * h),
    s * (b * f - e * c), s * (d * c - a * f), s * (a * e - d * b),
  ];
}

/** Each vertex's faces' normals summed, for a primitive that states none; kept on the mesh. */
function faceNormals(mesh) {
  if (mesh.faceNormals) return mesh.faceNormals;
  const p = mesh.attributes.position;
  const sum = new Float64Array(3 * mesh.vertexCount);
  for (const [a, b, c] of triangles(null, mesh)) {
    const u = [0, 1, 2].map((k) => p.at(b, k) - p.at(a, k));
    const w = [0, 1, 2].map((k) => p.at(c, k) - p.at(a, k));
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    for (const v of [a, b, c]) for (let k = 0; k < 3; k++) sum[3 * v + k] += n[k];
  }
  mesh.faceNormals = { at: (i, k) => sum[3 * i + k] };
  return mesh.faceNormals;
}
