/**
 * The model, as the rest of liverykit sees it.
 *
 * Everything outside this file and the profile generator reaches a 3D model
 * through here, so that what a mesh IS — glass, a damage overlay, a cockpit
 * LOD, see-through — is a fact read off `meshTraits` rather than a judgement
 * each caller makes from Assetto Corsa's shader names and node paths. The
 * answers are ac-kn5's, unchanged; what moved is where the question is asked,
 * so a second format answers it once, here, instead of at every call site.
 */
import {
  parseKn5, parseKn5Buffer, vertex, triangles, meshesUsingTexture, SHEET_SPAN,
  axesFromWheels, axisHints, additive, motionBlurOnly,
  blends, alphaTest, isGlass, damageOnly, trustworthyDiffuse,
  detailLayer, baseNormal, motionBlurMesh, cockpitLod,
} from 'ac-kn5';

export { parseKn5 as loadModel, parseKn5Buffer, vertex, triangles, SHEET_SPAN, axesFromWheels, axisHints };

/**
 * Whether a texture ADDS light. Read from its file name, because that is all
 * a kn5 says: a plate and its glowing twin share a shader.
 */
export { additive };

/** Whether one segment of a node path names a motion-blur stand-in. */
export { motionBlurOnly };

/** Meshes whose paint is `file`, ignoring case. */
export const meshesWearing = meshesUsingTexture;

const byMaterial = new WeakMap();
const byMesh = new WeakMap();
const NO_MATERIAL = {};

/** What a material says about the surfaces drawn with it. */
export function materialTraits(model, materialId) {
  const mat = model.materials?.[materialId];
  const key = mat ?? NO_MATERIAL;
  let r = byMaterial.get(key);
  if (!r) {
    r = {
      glass: isGlass(mat?.shader),
      blends: blends(mat),
      alphaTest: alphaTest(mat),
      damage: damageOnly(mat?.shader),
      // The texture in the paint slot, and whether the shader draws it as the
      // surface's color rather than mixing it in.
      diffuse: mat?.slots?.txDiffuse ?? null,
      trustworthy: trustworthyDiffuse(mat?.shader),
      detail: detailLayer(mat),
      normalMap: baseNormal(mat),
    };
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
    r = Object.freeze({
      ...materialTraits(model, mesh.materialId),
      blur: motionBlurMesh(mesh),
      lod: cockpitLod(mesh),
    });
    byMesh.set(mesh, r);
  }
  return r;
}
