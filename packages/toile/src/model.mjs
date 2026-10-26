/**
 * The model, as the rest of toile sees it.
 *
 * Everything outside the formats and the profile generator reaches a 3D model
 * through here, so that what a mesh IS — glass, a damage overlay, a cockpit
 * LOD, see-through — is a fact read off `meshTraits` rather than a judgement
 * each caller makes from one format's shader names and node paths. Each
 * format answers for its own models: a model carries the format that read
 * it, and one that carries none is a kn5, as every model was before there
 * was a second format.
 */
import * as kn5 from './formats/kn5.mjs';
import * as gltf from './formats/gltf.mjs';

const formatOf = (model) => model.format ?? kn5;

/** Read a model, as its extension says: a binary glTF, or a kn5. */
export const loadModel = (path, opts) => (/\.glb$/i.test(String(path)) ? gltf : kn5).loadModel(path, opts);

export { parseKn5Buffer, SHEET_SPAN, additive, motionBlurOnly } from './formats/kn5.mjs';
export { parseGlb } from './formats/gltf.mjs';

/** One vertex in world space, with u and v in texture space (v down from the top). */
export const vertex = (model, mesh, i) => formatOf(model).vertex(model, mesh, i);

/** A mesh's triangles as vertex indices. */
export const triangles = (model, mesh) => formatOf(model).triangles(model, mesh);

/** Which way the wheels say the model faces, or null where it has none. */
export const axesFromWheels = (model) => formatOf(model).axesFromWheels(model);

/** Which way the mesh names say the model faces, and whether they say it confidently. */
export const axisHints = (model) => formatOf(model).axisHints(model);

/** Meshes whose paint is `file`, ignoring case. */
export const meshesWearing = (model, file) => formatOf(model).meshesWearing(model, file);

const byMaterial = new WeakMap();
const byMesh = new WeakMap();

/** What a material says about the surfaces drawn with it. */
export function materialTraits(model, materialId) {
  const format = formatOf(model);
  // A missing material is keyed by its format, so a kn5's lack of one and a
  // glTF's are not taken for the same answer.
  const key = model.materials?.[materialId] ?? format;
  let r = byMaterial.get(key);
  if (!r) {
    r = format.materialTraits(model, materialId);
    // Shared by every mesh on the material, so nobody may write on it.
    Object.freeze(r.detail);
    Object.freeze(r);
    byMaterial.set(key, r);
  }
  return r;
}

/** What a mesh is: its material's traits, and what its place in the model says. */
export function meshTraits(model, mesh) {
  let r = byMesh.get(mesh);
  if (!r) {
    r = Object.freeze({ ...materialTraits(model, mesh.materialId), ...formatOf(model).placeTraits(mesh) });
    byMesh.set(mesh, r);
  }
  return r;
}
