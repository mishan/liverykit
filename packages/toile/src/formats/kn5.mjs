/**
 * Assetto Corsa's kn5, read by ac-kn5. Every judgement here — what is glass,
 * which cockpit a mesh is in — is ac-kn5's, made from the car's shader names
 * and node paths.
 */
import {
  parseKn5, parseKn5Buffer, SHEET_SPAN, additive, motionBlurOnly,
  vertex, triangles, meshesUsingTexture, axesFromWheels, axisHints,
  blends, alphaTest, discardsClear, isGlass, damageOnly, trustworthyDiffuse,
  detailLayer, baseNormal, motionBlurMesh, cockpitLod, placeOnSheet,
} from 'ac-kn5';

export const name = 'kn5';
export { parseKn5 as loadModel, parseKn5Buffer, SHEET_SPAN, additive, motionBlurOnly, vertex, triangles, axesFromWheels, axisHints, placeOnSheet };
export const meshesWearing = meshesUsingTexture;

export function materialTraits(model, materialId) {
  const mat = model.materials?.[materialId];
  return {
    glass: isGlass(mat?.shader),
    blends: blends(mat),
    alphaTest: alphaTest(mat),
    discardsClear: discardsClear(mat),
    damage: damageOnly(mat?.shader),
    // The texture in the paint slot, and whether the shader draws it as the
    // surface's color rather than mixing it in.
    diffuse: mat?.slots?.txDiffuse ?? null,
    trustworthy: trustworthyDiffuse(mat?.shader),
    detail: detailLayer(mat),
    normalMap: baseNormal(mat),
  };
}

export const placeTraits = (mesh) => ({ blur: motionBlurMesh(mesh), lod: cockpitLod(mesh) });
